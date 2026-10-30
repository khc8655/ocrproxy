#!/usr/bin/env python3
"""tests/run_tests.py — Tiered Test Runner for OCRProxy

The suite is split into tiers so a normal iteration does not pay the full
browser-matrix cost, while a release still runs everything:

  T0  static gate   `npm run check:release`                         ~0.2s
  T1  logic         pure logic / API / security (no browser)        ~0.5s
  T2  contract      shared UI backend contract, VM vs EdgeOne       ~13s
                    (real servers + real Chromium: S1~S7 / U1~U3)
  T3  matrix        narrow-viewport overflow + full E2E matrix      ~18s
                    (real Chromium, VM + EdgeOne consoles)
  T1..T3            `--layer=all --parallel`                        ~18-20s

Usage:
  python3 tests/run_tests.py --layer=logic     # T1 only (fast, no browser)
  python3 tests/run_tests.py --layer=contract  # T2 only
  python3 tests/run_tests.py --layer=all --parallel   # release: every tier
  python3 tests/run_tests.py --layer=auto      # pick tiers from the changed files
  python3 tests/run_tests.py --list            # show tiers and commands

Backwards compatible aliases: core / api / ui / e2e / all.
  core = T1 units + CoW security (the historical Layer 1)
  api  = API layer + backend contract (historical Layer 2)
  ui   = security audit + narrow viewport matrix (historical Layer 3)
  e2e  = full E2E matrix (historical Layer 4)

`--layer=auto` inspects `git diff` (working tree + staged + `<base>...HEAD`) and maps
changed paths to the tiers they can actually break; docs-only changes require only
the T0 static gate. Use `--base=REF` to compare against another commit (default
origin/main, falling back to main / HEAD~1).
"""

import argparse
import os
import re
import subprocess
import sys
import tempfile
import time

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PYTHON_EXE = sys.executable

COLOR_GREEN = "\033[92m"
COLOR_RED = "\033[91m"
COLOR_YELLOW = "\033[93m"
COLOR_BOLD = "\033[1m"
COLOR_RESET = "\033[0m"

# ── individual checks ─────────────────────────────────────────────────────────
CHECKS = {
    "units": {
        "tier": "T1",
        "desc": "EdgeOne ESM Units & Preset Hub (199)",
        "cmd": ["node", "agent-edgeone/scripts/test-units.mjs"],
    },
    "security": {
        "tier": "T1",
        "desc": "Python CoW & Fail-Closed Token Isolation",
        "cmd": [PYTHON_EXE, "tests/test_phase1_security_and_cow.py"],
    },
    "agent_metrics": {
        "tier": "T1",
        "desc": "VM Agent Dashboard Summary (tokens / TTFT / failures)",
        "cmd": [PYTHON_EXE, "tests/test_agent_metrics.py"],
    },
    "runtime_profiles": {
        "tier": "T1",
        "desc": "Three-runtime default profiles (EdgeOne / VM-Agent / VM-KB) single source",
        "cmd": [PYTHON_EXE, "tests/test_runtime_profiles.py"],
    },
    "mode_scheduler": {
        "tier": "T1",
        "desc": "VM run_mode time-window auto switch (edge-triggered, idle-wait, keeps manual switch)",
        "cmd": [PYTHON_EXE, "tests/test_mode_scheduler.py"],
    },
    "param_simplify": {
        "tier": "T1",
        "desc": "Param simplify v2 (24h ban for 401/402/403 + persisted, KB single-provider keeps rotating, migration, per-mode schema)",
        "cmd": [PYTHON_EXE, "tests/test_param_simplify.py"],
    },
    "ui_standard": {
        "tier": "T1",
        "desc": "Console v2 UI foundation (single UI global, component classes, script order)",
        "cmd": [PYTHON_EXE, "tests/test_ui_standard.py"],
    },
    "html_structure": {
        "tier": "T1",
        "desc": "Admin HTML structure/nesting guard (dup attrs, unclosed tags, inline style ratchet)",
        "cmd": [PYTHON_EXE, "tests/test_html_structure.py"],
    },
    "cline_adapter": {
        "tier": "T1",
        "desc": "Cline adapter (non-stream data envelope unwrap + preset declaration)",
        "cmd": [PYTHON_EXE, "tests/test_cline_adapter.py"],
    },
    "oauth_credentials": {
        "tier": "T1",
        "desc": "OAuth credentials (MiniMax device flow, refresh, needs_relogin, local-only)",
        "cmd": [PYTHON_EXE, "tests/test_oauth_credentials.py"],
    },
    "failure_logging": {
        "tier": "T1",
        "desc": "Failure stats/error_logs consistency (manual 4xx/5xx, all-cooldown, gateway overload)",
        "cmd": [PYTHON_EXE, "tests/test_failure_logging_consistency.py"],
    },
    "settings_binding": {
        "tier": "T1",
        "desc": "Settings binding contract (schema/UI data-cap/runtime key, no removed configs)",
        "cmd": [PYTHON_EXE, "tests/test_settings_binding_contract.py"],
    },
    "settings_resolution": {
        "tier": "T1",
        "desc": "Runtime settings resolution (first-byte/OCR timeout, 403 cooldown, hub string keys)",
        "cmd": [PYTHON_EXE, "tests/test_settings_resolution.py"],
    },
    "api_layer": {
        "tier": "T1",
        "desc": "FastAPI API Auth, Cascade Deletion & Vault Pull Rules",
        "cmd": [PYTHON_EXE, "tests/test_api_layer.py"],
    },
    "static_sync": {
        "tier": "T1",
        "desc": "SSOT static mirror (shared/admin == vm-app/static)",
        "cmd": [PYTHON_EXE, "tests/test_vm_static_sync.py"],
    },
    "admin_static": {
        "tier": "T1",
        "desc": "Admin UI static DOM/JS contract (ids, handlers, host tokens, bundle)",
        "cmd": [PYTHON_EXE, "tests/test_admin_ui_static_contract.py"],
    },
    "key_capsules": {
        "tier": "T2",
        "desc": "Hub vs Local key capsule permission matrix (Chromium)",
        "cmd": ["node", "tests/test_key_capsules.cjs"],
    },
    "contract_api": {
        "tier": "T2",
        "desc": "Backend contract, API-only (S1~S7, no browser)",
        "cmd": [PYTHON_EXE, "tests/test_backend_contract.py"],
        "env": {"CONTRACT_NO_BROWSER": "1"},
    },
    "contract_ui": {
        "tier": "T2",
        "desc": "Backend contract incl. browser U1~U3 (VM vs EdgeOne)",
        "cmd": [PYTHON_EXE, "tests/test_backend_contract.py"],
    },
    "vault_ui": {
        "tier": "T2",
        "desc": "Vault on-demand provider pull via real provider modal (KB + Agent)",
        "cmd": [PYTHON_EXE, "tests/test_vm_vault_provider_ui.py"],
    },
    "overflow": {
        "tier": "T3",
        "desc": "Narrow Viewport No Horizontal Overflow (VM vs EdgeOne)",
        "cmd": [PYTHON_EXE, "tests/test_ui_no_horizontal_overflow.py"],
    },
    "e2e": {
        "tier": "T3",
        "desc": "VM Full Matrix E2E Browser & Backend Integration",
        "cmd": [PYTHON_EXE, "tests/test_vm_full_matrix_e2e.py"],
    },
}

# Named presets. "all" is the release set; it is safe to run in parallel because
# every check uses free ports and its own temp CONFIG_DIR.
LAYERS = {
    "core": ["units", "security"],
    "logic": ["units", "security", "agent_metrics", "runtime_profiles", "mode_scheduler", "param_simplify", "failure_logging", "oauth_credentials", "cline_adapter", "ui_standard", "html_structure", "settings_binding", "settings_resolution", "api_layer", "static_sync", "admin_static"],
    "api": ["api_layer", "contract_ui"],
    "contract_api": ["contract_api"],
    "contract": ["contract_ui", "key_capsules", "vault_ui"],
    "ui": ["security", "overflow"],
    "matrix": ["overflow", "e2e"],
    "e2e": ["e2e"],
    "all": ["units", "security", "agent_metrics", "runtime_profiles", "mode_scheduler", "param_simplify", "failure_logging", "oauth_credentials", "cline_adapter", "ui_standard", "html_structure", "settings_binding", "settings_resolution", "api_layer", "static_sync", "admin_static",
            "key_capsules", "contract_ui", "vault_ui", "overflow", "e2e"],
}

TIER_TITLES = {
    "T1": "T1 logic / API / security (no browser)",
    "T2": "T2 backend contract (real servers + Chromium)",
    "T3": "T3 browser matrix (narrow viewport + full E2E)",
}


def _header(title):
    print(f"\n{COLOR_BOLD}### {title}{COLOR_RESET}")


def _run_one(check_id, capture=False):
    spec = CHECKS[check_id]
    print(f"{COLOR_BOLD}▶ [{check_id}] {spec['desc']}{COLOR_RESET}")
    print(f"  Command: {' '.join(spec['cmd'])}")
    t0 = time.time()
    env = {**os.environ, **(spec.get("env") or {})}
    if capture:
        out = tempfile.TemporaryFile(mode="w+", encoding="utf-8", errors="replace")
        res = subprocess.run(spec["cmd"], cwd=REPO_ROOT, env=env, stdout=out, stderr=subprocess.STDOUT)
        elapsed = time.time() - t0
        out.seek(0)
        text = out.read()
        out.close()
        return check_id, res.returncode == 0, elapsed, text
    res = subprocess.run(spec["cmd"], cwd=REPO_ROOT, env=env)
    elapsed = time.time() - t0
    return check_id, res.returncode == 0, elapsed, ""


def _run_sequential(ids):
    failed = []
    for cid in ids:
        _header(f"{cid}")
        _, ok, elapsed, _ = _run_one(cid)
        if ok:
            print(f"{COLOR_GREEN}✓ PASSED: {cid} ({elapsed:.2f}s){COLOR_RESET}")
        else:
            failed.append(cid)
            print(f"{COLOR_RED}✗ FAILED: {cid} (exit != 0, {elapsed:.2f}s){COLOR_RESET}")
            break  # fail fast, same as before
    return failed


def _run_parallel(ids):
    """Run independent checks concurrently; each uses free ports / temp dirs."""
    procs = []
    for cid in ids:
        spec = CHECKS[cid]
        log = tempfile.NamedTemporaryFile(mode="w+", encoding="utf-8", errors="replace",
                                          prefix=f"ocrprox-{cid}-", suffix=".log", delete=False)
        t0 = time.time()
        env = {**os.environ, **(spec.get("env") or {})}
        p = subprocess.Popen(spec["cmd"], cwd=REPO_ROOT, env=env, stdout=log, stderr=subprocess.STDOUT)
        procs.append((cid, p, log, t0))
        print(f"  started [{cid}] {spec['desc']}")

    results = []
    for cid, p, log, t0 in procs:
        rc = p.wait()
        elapsed = time.time() - t0
        log.flush()
        log.seek(0)
        text = log.read()
        log.close()
        try:
            os.unlink(log.name)
        except OSError:
            pass
        results.append((cid, rc == 0, elapsed, text))
        status = f"{COLOR_GREEN}PASS{COLOR_RESET}" if rc == 0 else f"{COLOR_RED}FAIL{COLOR_RESET}"
        print(f"  {status} [{cid}] {elapsed:.2f}s")

    failed = [r[0] for r in results if not r[1]]
    for cid, ok, elapsed, text in results:
        if not ok:
            print(f"\n{COLOR_RED}───── output of failed check [{cid}] ─────{COLOR_RESET}")
            print(text[-8000:])
    return failed


def _git_changed_files(base):
    files = set()

    def git(*args):
        try:
            out = subprocess.run(["git", *args], cwd=REPO_ROOT, capture_output=True,
                                 text=True, timeout=20)
            return out.stdout if out.returncode == 0 else ""
        except Exception:
            return ""

    for line in git("status", "--porcelain").splitlines():
        if len(line) > 3:
            files.add(line[3:].strip())
    for line in git("diff", "--name-only", f"{base}...HEAD").splitlines():
        if line.strip():
            files.add(line.strip())
    return sorted(f for f in files if f)


def _pick_base(explicit):
    if explicit:
        return explicit
    for cand in ("origin/main", "main", "HEAD~1"):
        try:
            out = subprocess.run(["git", "rev-parse", "--verify", cand],
                                 cwd=REPO_ROOT, capture_output=True, text=True)
            if out.returncode == 0:
                return cand
        except Exception:
            pass
    return "HEAD"


# ── change-scope -> tiers ────────────────────────────────────────────────────
# The single-source compiler (shared/admin -> vm-app/static + EdgeOne bundle) removed
# the historical UI fragmentation, so a browser is only needed when the change can
# actually change *layout* or *runtime DOM behaviour*:
#
#   logic           T1 static: preselected for every non-doc change (includes the
#                   static admin DOM/JS contract: ids, handlers, host tokens, bundle)
#   contract_api    T2a: backend/protocol contract without a browser (S1~S7)
#   contract_ui     T2b: contract incl. real browser U1~U3 (login, host caps, dashboard)
#   overflow        T3a: layout/viewport matrix (CSS or structural HTML)
#   e2e             T3b: full click-through flows (login/settings/models/KB)
#
# Copy/formatting-only HTML edits do not launch a browser: the static contract + DOM
# smoke covers them. Any unknown file falls back to the full browser set.

LOGIC = "logic"
CONTRACT_API = "contract_api"
CONTRACT_UI = "contract_ui"
OVERFLOW = "overflow"
E2E = "e2e"
ALL = "all"

_RELEASE_META = ("version.json", "vm-app/version.json", "install.sh", "vm-app/install.sh",
                 "edgeone.json", "package.json", "agent-edgeone/package.json")
_BACKEND = ("vm-app/app/", "vm-app/run_server.py", "shared/contracts/",
            "agent-edgeone/edge-functions/api/", "edge-functions/api/", "agent-edgeone/lib/")
_PRESETS = ("shared/presets/", "agent-edgeone/edge-functions/lib/presets/",
            "edge-functions/lib/presets/")
# UI JS modules -> tiers. Rendered markup/DOM behaviour needs the browser U checks;
# settings/model flows are only exercised end-to-end by T3b.
_UI_JS_TIERS = {
    "shared/admin/js/host.js": [CONTRACT_UI],
    "shared/admin/js/app.js": [CONTRACT_UI, E2E],
    "shared/admin/js/core.js": [CONTRACT_UI],
    "shared/admin/js/providers.js": [CONTRACT_UI, "key_capsules", "vault_ui"],
    "shared/admin/js/vault.js": [CONTRACT_UI, "key_capsules", "vault_ui"],
    "shared/admin/js/agent-models-ui.js": [CONTRACT_UI, "key_capsules"],
    "shared/admin/js/settings.js": [E2E],
    "shared/admin/js/settings-form.js": [E2E],
    "shared/admin/js/models.js": [E2E],
}
_CONSOLE_HTML = ("shared/admin/admin.html", "vm-app/static/admin.html",
                 "agent-edgeone/admin.html", "edge-functions/admin.js",
                 "agent-edgeone/edge-functions/admin.js")

# Structure signature: tags and identity attributes (values included). Text nodes are
# deliberately NOT part of it, so a copy-only edit is not mistaken for a structural one.
_STRUCT_TOKENS = re.compile(
    r"<\/?[a-zA-Z][\w-]*"
    r"|(?:id|class|style|href|src|data-[\w-]+|on\w+|hidden)\s*=\s*(?:\"[^\"]*\"|'[^']*'|[^\s>]+)")
_DOM_API = re.compile(
    r"\b(?:getElementById|querySelector(?:All)?|innerHTML|outerHTML|classList|dataset|"
    r"addEventListener|insertAdjacentHTML|hidden\s*=|style\.[a-zA-Z]+)\b")


def _git(*args):
    try:
        out = subprocess.run(["git", *args], cwd=REPO_ROOT, capture_output=True,
                             text=True, timeout=30)
        return out.stdout if out.returncode == 0 else ""
    except Exception:
        return ""


def _git_changed_files(base):
    """Files that differ from base, including uncommitted and untracked work."""
    files = set()
    for line in _git("diff", "--name-only", base).splitlines():
        if line.strip():
            files.add(line.strip())
    for line in _git("status", "--porcelain").splitlines():
        if line.startswith("?? ") and len(line) > 3:
            files.add(line[3:].strip())
        elif len(line) > 3:
            files.add(line[3:].strip())
    return sorted(f for f in files if f)


def _file_diff_text(base, path):
    if path in {f for f in _git("status", "--porcelain") if f.startswith("?? ")}:
        try:
            return (REPO_ROOT / path).read_text(encoding="utf-8", errors="replace")
        except OSError:
            return ""
    return _git("diff", "-U0", base, "--", path)


def _diff_is_structural(text):
    """True when a diff changes tags/attributes/DOM wiring rather than just copy text.

    Both sides are reduced to a structure signature (tags + identity attributes with
    values, e.g. id/class/data-*/on*/href). A pure copy edit keeps the same signature
    on the `+` and `-` side, so it does not need a browser. DOM API changes are always
    structural.
    """
    if not text.strip():
        return True  # unreadable/new file: be conservative
    plus, minus = [], []
    for line in text.splitlines():
        if line.startswith(("+++", "---")) or not line:
            continue
        if line[0] not in ("+", "-"):
            continue
        body = line[1:]
        if _DOM_API.search(body):
            return True
        tokens = _STRUCT_TOKENS.findall(body)
        (plus if line[0] == "+" else minus).extend(tokens)
    return sorted(plus) != sorted(minus)


def _classify(files, base=None):
    """Map changed files to the tiers they can actually break (pure, testable).

    Returns (wanted_tiers, unknown_files).
    """
    wanted, unknown = set(), []
    fileset = set(files)
    for f in files:
        if f.endswith(".md") or f in ("README.md", "CHANGELOG.md"):
            continue  # docs-only: T0 static gate is enough
        if f in _RELEASE_META or f.startswith("agent-edgeone/scripts/") or f.startswith("tests/") \
                or f.startswith("shared/docs/"):
            wanted.add(LOGIC)
            continue
        if f.startswith(_PRESETS):
            wanted.add(LOGIC)
            continue
        if f.startswith(_BACKEND):
            wanted.update({LOGIC, CONTRACT_API})
            continue
        if f.endswith("admin.css") and (f.startswith("shared/admin/") or f.startswith("vm-app/static/")):
            wanted.update({LOGIC, OVERFLOW})  # layout always needs the viewport matrix
            continue
        if f == "shared/admin/admin.html":
            # The single source console. Text/copy-only edits are covered by the static
            # DOM contract + build smoke; only structural edits need a real browser.
            text = _file_diff_text(base, f) if base else ""
            if _diff_is_structural(text):
                wanted.update({LOGIC, CONTRACT_UI, OVERFLOW})
            else:
                wanted.add(LOGIC)
            continue
        if f in _CONSOLE_HTML:
            # Generated consoles/bundles: the shared source decides the tier; a
            # standalone artifact diff is covered by static_sync / admin_static / G2.
            wanted.add(LOGIC)
            continue
        if f in _UI_JS_TIERS:
            wanted.add(LOGIC)
            wanted.update(_UI_JS_TIERS[f])
            continue
        if f.startswith(("vm-app/static/", "edge-functions/", "agent-edgeone/edge-functions/")) \
                or f in ("agent-edgeone/admin.css", "agent-edgeone/admin.bundled.html"):
            # generated artifacts: covered by the source rule when the source changed
            wanted.add(LOGIC)
            continue
        unknown.append(f)
    return wanted, unknown


def _checks_for_tiers(wanted):
    if ALL in wanted:
        return list(LAYERS["all"])
    checks, seen = [], set()
    order = [LOGIC, CONTRACT_API, CONTRACT_UI, "key_capsules", OVERFLOW, E2E]
    for tier in order:
        if tier not in wanted:
            continue
        for cid in LAYERS.get(tier, [tier]):
            if cid not in seen:
                seen.add(cid)
                checks.append(cid)
    return checks


def _auto_layers(base):
    files = _git_changed_files(base)
    if not files:
        print(f"{COLOR_YELLOW}No changes detected against {base}: nothing to run "
              f"(T0 static gate only).{COLOR_RESET}")
        return [], files
    wanted, unknown = _classify(files, base)
    if unknown:
        print(f"{COLOR_YELLOW}Unclassified change(s) -> falling back to release set: "
              f"{', '.join(unknown[:6])}{COLOR_RESET}")
        wanted.add(ALL)
    checks = _checks_for_tiers(wanted)
    print(f"{COLOR_BOLD}Changed files ({len(files)}) -> tiers: "
          f"{', '.join(sorted(wanted)) or 'none (docs-only)'}{COLOR_RESET}")
    for f in files[:20]:
        print(f"  · {f}")
    if len(files) > 20:
        print(f"  … {len(files) - 20} more")
    return checks, files


def _resolve(ids):
    """Expand named preset ids into unique check ids (order stable)."""
    out, seen = [], set()
    for cid in ids:
        if cid in LAYERS:
            for c in LAYERS[cid]:
                if c not in seen:
                    seen.add(c)
                    out.append(c)
        elif cid in CHECKS:
            if cid not in seen:
                seen.add(cid)
                out.append(cid)
        else:
            print(f"Unknown layer/check: {cid}", file=sys.stderr)
            sys.exit(2)
    return out


def _list():
    print(f"{COLOR_BOLD}OCRProxy tiered test suite{COLOR_RESET}")
    print("\nT0. static release gate: npm run check:release (~0.2s, always run first)")
    for tier in ("T1", "T2", "T3"):
        print(f"\n{tier}. {TIER_TITLES[tier]}")
        for cid, spec in CHECKS.items():
            if spec["tier"] == tier:
                print(f"   - {cid:<14} {spec['desc']}")
    print("\nPresets:")
    for name, ids in LAYERS.items():
        print(f"   --layer={name:<9} -> {', '.join(ids)}")
    print("\nExamples:")
    print("   python3 tests/run_tests.py --layer=logic            # fast iteration")
    print("   python3 tests/run_tests.py --layer=all --parallel   # release (~20s)")
    print("   python3 tests/run_tests.py --layer=auto             # pick from git diff")


def main():
    parser = argparse.ArgumentParser(description="OCRProxy tiered test runner")
    parser.add_argument("--layer", default="all",
                        help="logic|contract|core|api|ui|e2e|all|auto (default: all)")
    parser.add_argument("--parallel", action="store_true",
                        help="run the selected checks concurrently (safe: free ports + temp dirs)")
    parser.add_argument("--base", default=None,
                        help="git ref used by --layer=auto (default: origin/main)")
    parser.add_argument("--list", action="store_true", help="list tiers, checks and presets")
    args = parser.parse_args()

    if args.list:
        _list()
        return 0

    print(f"{COLOR_BOLD}=== OCRProxy tiered test runner ==={COLOR_RESET}", flush=True)
    if args.layer == "auto":
        base = _pick_base(args.base)
        checks, changed = _auto_layers(base)
        if not checks:
            print(f"{COLOR_GREEN}✓ Docs-only/no-op change: static gate (npm run check:release) "
                  f"is enough. Nothing else to run.{COLOR_RESET}")
            return 0
        print(f"Auto-selected {len(checks)} check(s): {', '.join(checks)}", flush=True)
    else:
        checks = _resolve([args.layer])

    if not checks:
        print("Nothing selected.")
        return 0

    print(f"Mode: {'parallel' if args.parallel else 'sequential'} | "
          f"{len(checks)} check(s): {', '.join(checks)}", flush=True)

    total_t0 = time.time()
    if args.parallel and len(checks) > 1:
        failed = _run_parallel(checks)
    else:
        failed = _run_sequential(checks)
    elapsed = time.time() - total_t0

    if failed:
        print(f"\n{COLOR_RED}{COLOR_BOLD}❌ FAILED after {elapsed:.2f}s: "
              f"{', '.join(failed)}{COLOR_RESET}")
        return 1

    print(f"\n{COLOR_GREEN}{COLOR_BOLD}🎉 ALL SELECTED CHECKS PASSED "
          f"({elapsed:.2f}s){COLOR_RESET}")
    return 0


if __name__ == "__main__":
    sys.exit(main())

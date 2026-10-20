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
    "key_capsules": {
        "tier": "T2",
        "desc": "Hub vs Local key capsule permission matrix (Chromium)",
        "cmd": ["node", "tests/test_key_capsules.cjs"],
    },
    "contract": {
        "tier": "T2",
        "desc": "Shared UI Backend Contract (VM vs EdgeOne, S1~S7 / U1~U3)",
        "cmd": [PYTHON_EXE, "tests/test_backend_contract.py"],
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
    "logic": ["units", "security", "agent_metrics", "api_layer", "static_sync"],
    "api": ["api_layer", "contract"],
    "contract": ["contract", "key_capsules"],
    "ui": ["security", "overflow"],
    "matrix": ["overflow", "e2e"],
    "e2e": ["e2e"],
    "all": ["units", "security", "agent_metrics", "api_layer", "static_sync",
            "key_capsules", "contract", "overflow", "e2e"],
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
    if capture:
        out = tempfile.TemporaryFile(mode="w+", encoding="utf-8", errors="replace")
        res = subprocess.run(spec["cmd"], cwd=REPO_ROOT, stdout=out, stderr=subprocess.STDOUT)
        elapsed = time.time() - t0
        out.seek(0)
        text = out.read()
        out.close()
        return check_id, res.returncode == 0, elapsed, text
    res = subprocess.run(spec["cmd"], cwd=REPO_ROOT)
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
        p = subprocess.Popen(spec["cmd"], cwd=REPO_ROOT, stdout=log, stderr=subprocess.STDOUT)
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


# Path -> tiers that must run. First matching rule wins.
_AUTO_RULES = [
    # docs only: no code path can change behaviour, T0 static gate is enough
    (("README.md", "CHANGELOG.md", "docs/", "LOCAL_", "ARCHITECTURE_STANDARDS"), "docs"),
    # release metadata / installers / edge config: run the release set
    (("version.json", "vm-app/version.json", "install.sh", "vm-app/install.sh",
      "edgeone.json", "package.json", "agent-edgeone/package.json"), "all"),
    # UI single source or generated console: full browser matrix
    (("shared/admin/", "vm-app/static/", "agent-edgeone/admin.html",
      "agent-edgeone/edge-functions/admin.js", "edge-functions/admin.js",
      "agent-edgeone/scripts/build-admin.mjs", "agent-edgeone/scripts/test-ui-smoke.mjs"),
     "all"),
    # presets: units cover the catalog/adapters
    (("shared/presets/", "agent-edgeone/edge-functions/lib/presets/", "edge-functions/lib/presets/"),
     "logic"),
    # backend / protocol / contract changes: logic + cross-backend contract
    (("vm-app/app/", "vm-app/run_server.py", "shared/contracts/",
      "agent-edgeone/edge-functions/api/", "edge-functions/api/", "agent-edgeone/lib/"),
     "logic+contract"),
    # tests / dev scripts: logic tier is enough
    (("tests/", "agent-edgeone/scripts/", "shared/docs/"), "logic"),
]

_TIER_SETS = {
    "docs": [],
    "logic": ["logic"],
    "logic+contract": ["logic", "contract"],
    "all": ["all"],
}


def _classify(files):
    """Map changed paths to the tier presets they require (pure, unit-testable)."""
    wanted, unknown = set(), []
    for f in files:
        if f.endswith(".md") or f in ("README.md", "CHANGELOG.md"):
            wanted.update(_TIER_SETS["docs"])
            continue
        for prefixes, kind in _AUTO_RULES:
            if any(f == p or f.startswith(p) for p in prefixes):
                wanted.update(_TIER_SETS[kind])
                break
        else:
            unknown.append(f)
    return wanted, unknown


def _checks_for_tiers(wanted):
    if "all" in wanted:
        return list(LAYERS["all"])
    checks, seen = [], set()
    for layer in ("logic", "contract"):
        if layer in wanted:
            for cid in LAYERS[layer]:
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
    wanted, unknown = _classify(files)
    if unknown:
        print(f"{COLOR_YELLOW}Unclassified change(s) -> falling back to release set: "
              f"{', '.join(unknown[:6])}{COLOR_RESET}")
        wanted.update(_TIER_SETS["all"])
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

    print(f"{COLOR_BOLD}=== OCRProxy tiered test runner ==={COLOR_RESET}")
    if args.layer == "auto":
        base = _pick_base(args.base)
        checks, changed = _auto_layers(base)
        if not checks:
            print(f"{COLOR_GREEN}✓ Docs-only/no-op change: static gate (npm run check:release) "
                  f"is enough. Nothing else to run.{COLOR_RESET}")
            return 0
        print(f"Auto-selected {len(checks)} check(s): {', '.join(checks)}")
    else:
        checks = _resolve([args.layer])

    if not checks:
        print("Nothing selected.")
        return 0

    print(f"Mode: {'parallel' if args.parallel else 'sequential'} | "
          f"{len(checks)} check(s): {', '.join(checks)}")

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

#!/usr/bin/env python3
"""tests/test_admin_ui_static_contract.py — T1: DOM/HTML ↔ JS static contract.

Why this exists
---------------
The admin UI used to be maintained as two hand-written copies (VM + EdgeOne), so
every UI edit had to be verified in a real browser to catch the two consoles
drifting apart. That fragmentation was removed: `shared/admin/` is now the single
source that the build compiles into `vm-app/static/` and the EdgeOne inline bundle.

Most UI edits therefore do NOT need a browser. This test statically catches what a
browser used to be the only guard against:

  * a missing/renamed DOM id or panel that JS/tests rely on;
  * an inline handler (`onclick=...`) pointing at a function that no longer exists;
  * an unknown `data-arch` / `data-cap` token (host-conditional visibility drift);
  * the VM copy diverging from the single source (beyond version stamps);
  * the EdgeOne bundle losing its host identity markers or gaining external refs;
  * a deleted CSS layout invariant (arch hiding rule / responsive breakpoints).

Real-browser tiers remain for what cannot be checked statically: layout at
viewports (T3 overflow), login/host-conditional rendering and contract U1~U3
(T2 UI), and full click-through flows (T3 E2E).
"""

import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SHARED = ROOT / "shared" / "admin"
VM_STATIC = ROOT / "vm-app" / "static"
EO_DIR = ROOT / "agent-edgeone"
EO_BUNDLE = ROOT / "edge-functions" / "admin.js"

FAILS = []


def check(cond, msg):
    if cond:
        print(f"  ✓ {msg}")
    else:
        print(f"  ✗ {msg}")
        FAILS.append(msg)


# The UI contract the rest of the system depends on (JS ids, tests, docs).
REQUIRED_IDS = [
    # login + shell
    "loginOverlay", "loginKey", "loginErr", "app", "topNav",
    "topVersionBadge", "topModeBadge",
    # panels (nav targets)
    "panel-dashboard", "panel-providers", "panel-models", "panel-settings",
    # dashboard
    "agentStatsGrid", "agentStatsMode", "agentTopModelsStrip",
    # providers + key modal
    "providerModal", "keyModal", "k_vault_section", "k_vault_list", "k_vault_btn",
    "k_provider", "k_label", "k_value",
    # models / candidates
    "agentModelsBox", "candidateModal", "agentModal",
    # settings
    "cfg_vault_url", "cfg_vault_token", "btnSaveVaultConfig", "btnTestVault", "btnSyncVaultFromSettings", "p_proto_hint",
]

KNOWN_ARCH = {"vm", "edgeone"}
KNOWN_CAPS = {"runModes", "kb", "vaultClient", "vaultHub", "systemUpdate", "oauthLogin"}

# handler names that are JS keywords / DOM built-ins rather than our functions
HANDLER_IGNORES = {"if", "return", "this", "event", "window", "document"}


def read(p):
    return p.read_text(encoding="utf-8")


def normalize_version(text):
    text = re.sub(r"v\d{6,8}-\d{2}", "vVER", text)
    text = re.sub(r"\?v=[\w.\-]+", "?v=VER", text)
    return text


def main():
    html = read(SHARED / "admin.html")
    vm_html = read(VM_STATIC / "admin.html")
    eo_html = read(EO_DIR / "admin.html")
    bundle = read(EO_BUNDLE)
    css = read(SHARED / "admin.css")
    js_code = "\n".join(read(p) for p in sorted((SHARED / "js").glob("*.js")))

    print("[1] required DOM ids + unique ids")
    ids = re.findall(r'\bid="([^"]+)"', html)
    dupes = sorted({i for i in ids if ids.count(i) > 1})
    for want in REQUIRED_IDS:
        check(want in ids, f"id #{want} present in shared/admin/admin.html")
    check(not dupes, f"no duplicate ids in shared/admin/admin.html{f': {dupes[:5]}' if dupes else ''}")

    print("[2] nav tabs ↔ panels")
    nav = re.search(r'<nav id="topNav"[^>]*>(.*?)</nav>', html, re.S)
    check(bool(nav), "topNav exists")
    if nav:
        buttons = re.findall(r'<button[^>]*onclick="switchTab\(\'([\w-]+)\'\)"', nav.group(1))
        check(len(buttons) == 4, f"exactly 4 nav tabs, got {len(buttons)}: {buttons}")
        for tab in buttons:
            check(f"panel-{tab}" in ids, f"nav tab '{tab}' has a matching #panel-{tab}")

    print("[3] inline handlers resolve to a declared function")
    handlers = set(re.findall(r'\bon\w+="([A-Za-z_$][\w$]*)\s*\(', html))
    declared = set(re.findall(r'\bfunction\s+([A-Za-z_$][\w$]*)\s*\(', js_code))
    declared |= set(re.findall(
        r'\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:function|\()', js_code))
    missing = sorted(h for h in handlers - declared if h not in HANDLER_IGNORES)
    check(not missing, f"all {len(handlers)} inline handlers declared{f', missing: {missing}' if missing else ''}")

    print("[4] host-conditional tokens are known")
    archs = set(re.findall(r'data-arch="([^"]+)"', html))
    caps = set(re.findall(r'data-cap="([^"]+)"', html))
    check(archs <= KNOWN_ARCH, f"data-arch values {sorted(archs)} ⊆ {sorted(KNOWN_ARCH)}")
    bad_caps = sorted({c.lstrip("!").strip() for c in caps} - KNOWN_CAPS)
    check(not bad_caps, f"data-cap values {sorted(caps)} ⊆ {sorted(KNOWN_CAPS)}")
    check('data-cap="!kb"' in html or 'data-cap="runModes"' in html,
          "negated/runModes capability markers kept (host-conditional UI)")

    print("[5] single source of truth: VM static copy == shared source")
    check(normalize_version(html) == normalize_version(vm_html),
          "vm-app/static/admin.html matches shared/admin/admin.html (version stamps ignored)")
    for p in sorted((SHARED / "js").glob("*.js")):
        vm_p = VM_STATIC / "js" / p.name
        check(vm_p.exists() and read(vm_p) == read(p), f"vm-app/static/js/{p.name} matches shared source")
    check(read(SHARED / "admin.css") == read(VM_STATIC / "admin.css"),
          "vm-app/static/admin.css matches shared source")

    print("[6] EdgeOne console identity + no external refs")
    check("<title>OCRProxy EdgeOne 控制台</title>" in eo_html, "agent-edgeone/admin.html has EdgeOne title")
    check('id="topModeBadge">EdgeOne 边缘版</span>' in eo_html, "agent-edgeone/admin.html has EdgeOne badge")
    check("<title>OCRProxy EdgeOne 控制台</title>" in bundle, "edge-functions/admin.js bundle has EdgeOne title")
    check('id="topModeBadge">EdgeOne 边缘版</span>' in bundle, "bundle has EdgeOne badge")
    check("window.__HOST_KIND__ = 'edgeone'" in bundle, "bundle hard-injects window.__HOST_KIND__ = 'edgeone'")
    check('id="panel-providers"' in bundle, "bundle keeps the providers (Vault Hub) panel")
    check(not re.search(r'<script\b[^>]*\bsrc=', bundle), "bundle has no external <script src>")
    check(not re.search(r'<link\b[^>]*admin\.css', bundle), "bundle inlines admin.css (no <link> to it)")

    print("[7] CSS layout invariants")
    check('body.arch-edgeone [data-arch="vm"]' in css, "negative arch-hiding rule kept (no display:flex override)")
    check("@media" in css, "responsive @media rules kept")
    for cls in (".stat", ".settings-row", ".key-chip", ".table-wrap"):
        check(cls in css, f"layout class {cls} kept in admin.css")

    print("[8] version metadata is wired (details enforced by T0 G1)")
    vjson = json.loads(read(ROOT / "version.json"))
    ver = vjson["version"]
    check(f'id="topVersionBadge" title="系统发行版本">{ver}</span>' in html,
          f"shared/admin/admin.html badge shows {ver}")
    check(f"?v={ver.lstrip('v')}" in html, f"asset cache-busting stamp ?v={ver.lstrip('v')}")

    print()
    if FAILS:
        print(f"FAILED: {len(FAILS)} static admin UI contract assertion(s)")
        for f in FAILS:
            print(f"  - {f}")
        return 1
    print("PASS: static admin UI contract (ids/handlers/host tokens/SSOT/bundle/CSS)")
    return 0


if __name__ == "__main__":
    sys.exit(main())

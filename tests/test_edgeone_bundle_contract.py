#!/usr/bin/env python3
"""EdgeOne bundle contract: every shared admin script must be present in the bundle.

Regression for the missing ui.js incident: VM loaded ui.js, EdgeOne bundle omitted it,
so deleteKey()/UI.confirm() threw ReferenceError and the delete button appeared dead.
"""
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
HTML = ROOT / "shared/admin/admin.html"
BUILD = ROOT / "agent-edgeone/scripts/build-admin.mjs"
BUNDLE = ROOT / "agent-edgeone/admin.bundled.html"


def main():
    html = HTML.read_text(encoding="utf-8")
    build = BUILD.read_text(encoding="utf-8")
    bundle = BUNDLE.read_text(encoding="utf-8")

    scripts = re.findall(r'<script[^>]+src=["\'][^"\']*/js/([^"\'?]+)', html)
    module_block = re.search(r"const jsModuleOrder = \[(.*?)\];", build, re.S)
    assert module_block, "build-admin.mjs: jsModuleOrder not found"
    modules = re.findall(r"['\"]([^'\"]+\.js)['\"]", module_block.group(1))

    missing = [s for s in scripts if s not in modules]
    assert not missing, f"EdgeOne bundle module list misses: {missing}"
    assert "global.UI = {" in bundle, "EdgeOne bundle is missing the UI component layer"
    assert "deleteKey(prov,label)" in bundle, "EdgeOne bundle is missing deleteKey"

    # Every shared module must be inlined; stale bundles are a release blocker.
    for mod in scripts:
        assert f"Module: {mod}" in bundle, f"EdgeOne bundle did not inline {mod}"
    print("PASS EdgeOne bundle: ui.js/UI component layer present and module list complete")


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""tests/test_ui_standard.py — Console v2 组件层地基守卫（P0）。

棘轮基线：当前只强制“地基存在 + 单全局 + 闭集类 + 无外部依赖”；
后续页面迁移会把内联样式/硬编码色阈值逐步收紧（见 docs/UI_STANDARD_MIGRATION.md）。
"""
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
HTML = (ROOT / "shared/admin/admin.html").read_text(encoding="utf-8")
CSS = (ROOT / "shared/admin/admin.css").read_text(encoding="utf-8")
UI = (ROOT / "shared/admin/js/ui.js").read_text(encoding="utf-8")


def check_script_order():
    assert "js/host.js" in HTML and "js/ui.js" in HTML and "js/settings-form.js" in HTML
    assert HTML.index("js/host.js") < HTML.index("js/ui.js") < HTML.index("js/settings-form.js"), \
        "ui.js 必须在 host.js 之后、settings-form.js 之前加载"
    print("PASS script order: host -> ui -> settings-form")


def check_single_global():
    globals_ = set(re.findall(r"\bglobal\.([A-Za-z_$][\w$]*)\s*=(?!=)", UI))
    assert globals_ <= {"UI"}, f"ui.js must only export window.UI, got {globals_}"
    assert "global.UI =" in UI
    print("PASS single global: window.UI")


def check_components_and_classes():
    for name in ("esc", "button", "badge", "dot", "capsule", "card", "pageHeader", "field", "table", "empty", "toneOf"):
        assert re.search(rf"\b{name}\b", UI), f"UI.{name} missing"
    for cls in (".btn--primary", ".badge--success", ".capsule", ".page-header", ".field", ".empty"):
        assert cls in CSS, f"component class {cls} missing from admin.css"
    print("PASS component API/classes")


def check_no_external_dependency():
    assert not re.search(r"https?://", UI), "ui.js must not load external URL"
    assert "<script" not in UI.lower(), "ui.js must not inject scripts"
    print("PASS no external dependency")


if __name__ == "__main__":
    check_script_order()
    check_single_global()
    check_components_and_classes()
    check_no_external_dependency()
    print("ALL UI STANDARD FOUNDATION CHECKS PASSED")

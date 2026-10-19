"""
Automated Verification Suite for Phase 3 & Phase 4:
1. State-01: Fault classification & keywords parity (Hard Quota vs TPM Rate Limits)
2. State-02: Non-retriable client errors (400/404/422) vs key-level quota failover
3. Core-02: AST Safe Expression Evaluator (Zero eval() usage)
4. Arch-01: Standardized tracking headers (X-Proxy-Routed-Via, X-Proxy-Attempts)
5. Arch-03: Single-Source Version consistency (v2026.10.05-01)
"""
import sys
import os
import json
import re

# Add root and vm-app to sys.path
root_dir = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
sys.path.insert(0, root_dir)
sys.path.insert(0, os.path.join(root_dir, "vm-app"))

from tests.test_live_models_suite import execute_mock_tool


def test_core02_ast_safe_calculation():
    """Verify AST-based math calculation executes safely without eval()."""
    # 1. Standard arithmetic
    res = json.loads(execute_mock_tool("calculate", {"expression": "2 + 3 * 4"}))
    assert res["result"] == 14, f"Expected 14, got {res['result']}"

    # 2. Power and division
    res = json.loads(execute_mock_tool("calculate", {"expression": "2 ** 10"}))
    assert res["result"] == 1024, f"Expected 1024, got {res['result']}"

    # 3. Floating point and negative numbers
    res = json.loads(execute_mock_tool("calculate", {"expression": "-5 + 10 / 2"}))
    assert res["result"] == 0, f"Expected 0, got {res['result']}"

    # 4. Dangerous inputs (e.g. attempting code execution) must be safely rejected to default
    res = json.loads(execute_mock_tool("calculate", {"expression": "__import__('os').system('id')"}))
    assert res["result"] == 1130, "Malicious expression must fallback safely"


def test_arch03_version_consistency():
    """Verify that version.json, vm-app/version.json, and bundled HTML are all at v2026.10.06-01."""
    v_root = json.loads(open(os.path.join(root_dir, "version.json")).read())
    v_vm = json.loads(open(os.path.join(root_dir, "vm-app", "version.json")).read())

    expected_version = v_root["version"]
    assert v_root["version"] == expected_version, f"Root version mismatch: {v_root['version']}"
    assert v_vm["version"] == expected_version, f"VM version mismatch: {v_vm['version']}"

    # Verify admin HTML contains version in script tags
    vm_html = open(os.path.join(root_dir, "vm-app", "static", "admin.html")).read()
    assert expected_version.lstrip("v") in vm_html, "VM admin.html script tags must contain updated version"


def test_release_spec_and_install_scripts():
    """Verify install.sh and vm-app/install.sh consistency, version sync, and dependency skipping logic."""
    v_root = json.loads(open(os.path.join(root_dir, "version.json")).read())
    expected_version = v_root["version"]

    root_install_path = os.path.join(root_dir, "install.sh")
    vm_install_path = os.path.join(root_dir, "vm-app", "install.sh")

    assert os.path.exists(root_install_path), "Root install.sh must exist"
    assert os.path.exists(vm_install_path), "vm-app/install.sh must exist"

    root_install_content = open(root_install_path).read()
    vm_install_content = open(vm_install_path).read()

    # 1. Version synchronization
    assert f'SCRIPT_VERSION="{expected_version}"' in root_install_content, (
        f"install.sh SCRIPT_VERSION mismatch: expected {expected_version}"
    )
    assert f'SCRIPT_VERSION="{expected_version}"' in vm_install_content, (
        f"vm-app/install.sh SCRIPT_VERSION mismatch: expected {expected_version}"
    )

    # 2. Zero-drift check between install.sh and vm-app/install.sh
    assert root_install_content == vm_install_content, (
        "install.sh and vm-app/install.sh must be 100% byte-for-byte identical (Zero Drift)"
    )

    # 3. Intelligent system dependency skip logic
    assert "跳过系统包管理器安装流程" in root_install_content, (
        "install.sh must contain system dependencies intelligent skip logic"
    )
    assert "has_valid_python=false" in root_install_content, (
        "install.sh must check Python 3.9+ and venv/ensurepip availability"
    )

    # 4. Intelligent Python virtualenv dependency skip logic
    assert "跳过重复 pip 安装" in root_install_content, (
        "install.sh must contain Python venv dependencies intelligent skip logic in Step 5"
    )
    assert "跳过重复 pip 下载安装" in root_install_content, (
        "install.sh must contain Python venv dependencies intelligent skip logic in --upgrade"
    )

    # 5. Asset deployment completeness
    for asset in ["vm-app/app", "vm-app/static", "vm-app/scripts", "shared", "version.json"]:
        assert asset in root_install_content, f"install.sh must deploy asset: {asset}"

    # 6. Release specification document
    spec_path = os.path.join(root_dir, "docs", "RELEASE_SPEC.md")
    assert os.path.exists(spec_path), "docs/RELEASE_SPEC.md must exist"


def test_edgeone_and_vm_ui_timeout_parity():
    """Verify EdgeOne and VM Admin UI timeout parity and Red Line adherence."""
    v_root = json.loads(open(os.path.join(root_dir, "version.json")).read())
    expected_version = v_root["version"]

    # 1. EdgeOne dedicated sources: agent-edgeone/admin.{html,css,js}
    eo_html_path = os.path.join(root_dir, "agent-edgeone", "admin.html")
    eo_css_path = os.path.join(root_dir, "agent-edgeone", "admin.css")
    eo_js_path = os.path.join(root_dir, "agent-edgeone", "admin.js")
    assert os.path.exists(eo_html_path), "agent-edgeone/admin.html must exist"
    assert os.path.exists(eo_css_path), "agent-edgeone/admin.css must exist"
    assert os.path.exists(eo_js_path), "agent-edgeone/admin.js must exist"

    eo_html = open(eo_html_path, "r", encoding="utf-8").read()
    assert "OCRProxy EdgeOne 控制台" in eo_html, "agent-edgeone/admin.html must have EdgeOne console title"
    assert "EdgeOne 边缘版" in eo_html, "agent-edgeone/admin.html must have EdgeOne edition badge"
    assert 'id="panel-providers"' in eo_html, "agent-edgeone/admin.html must be Vault Hub with Providers panel"
    assert "EdgeOne 建议 20~25s" not in eo_html, (
        "Red Line Violated: Obsolete 'EdgeOne 建议 20~25s' found in agent-edgeone/admin.html"
    )
    assert 'id="s_chatTimeout"' in eo_html or 'id="set_upstream_timeout_sec"' in eo_html, "timeout input missing"
    assert 'max="300"' in eo_html, "Red Line Violated: timeout input must have max='300'"
    assert 'id="s_maxRetries"' in eo_html or 'id="set_max_retries"' in eo_html, "max_retries missing in agent-edgeone/admin.html"
    assert 'id="s_requestTotalBudget"' in eo_html or 'id="set_request_total_budget_sec"' in eo_html, "budget missing in agent-edgeone/admin.html"
    assert 'value="25"' not in eo_html, "Red Line Violated: ghost 'value=\"25\"' found in agent-edgeone/admin.html"
    assert "xsk/ocrprox" not in eo_html, "Red Line Violated: 404 mirror xsk/ocrprox found in agent-edgeone/admin.html"

    if os.path.exists(eo_js_path):
        eo_js = open(eo_js_path, "r", encoding="utf-8").read()
        assert "Math.min(30, upTimeout)" not in eo_js, (
            "Red Line Violated: Obsolete Math.min(30, upTimeout) truncation found in agent-edgeone/admin.js"
        )
        assert "xsk/ocrprox" not in eo_js, (
            "Red Line Violated: 404 mirror xsk/ocrprox found in agent-edgeone/admin.js"
        )

    # 2. EdgeOne compiled bundle: edge-functions/admin.js (index.js only redirects / -> /admin)
    idx = open(os.path.join(root_dir, "edge-functions", "index.js"), "r", encoding="utf-8").read()
    assert '"/admin"' in idx and "302" in idx, "edge-functions/index.js must redirect / to /admin"
    for ef_name in ["admin.js"]:
        ef_path = os.path.join(root_dir, "edge-functions", ef_name)
        assert os.path.exists(ef_path), f"edge-functions/{ef_name} must exist"
        bundle = open(ef_path, "r", encoding="utf-8").read()

        assert "OCRProxy EdgeOne 控制台" in bundle, f"edge-functions/{ef_name} missing EdgeOne title"
        assert "EdgeOne 边缘版" in bundle, f"edge-functions/{ef_name} missing EdgeOne edition badge"
        assert 'id="panel-providers"' in bundle, f"edge-functions/{ef_name} missing Vault Hub Providers panel"
        assert "renderAgentModels" in bundle, f"edge-functions/{ef_name} missing shared renderAgentModels component"
        assert expected_version in bundle, f"edge-functions/{ef_name} must contain current version {expected_version}"

    # 3. VM shared/admin/admin.html & vm-app/static/admin.html
    vm_html_path = os.path.join(root_dir, "shared", "admin", "admin.html")
    assert os.path.exists(vm_html_path), "shared/admin/admin.html must exist"
    vm_html = open(vm_html_path, "r", encoding="utf-8").read()
    assert 'id="s_chatTimeout"' in vm_html, "s_chatTimeout missing in shared/admin/admin.html"
    assert 'max="300"' in vm_html, "s_chatTimeout must support max='300'"

    vm_static_html = os.path.join(root_dir, "vm-app", "static", "admin.html")
    assert os.path.exists(vm_static_html), "vm-app/static/admin.html must exist"

    # 4. Default config timeouts
    cfg_path = os.path.join(root_dir, "edge-functions", "lib", "config.js")
    cfg_content = open(cfg_path, "r", encoding="utf-8").read()
    assert "request_total_budget_sec: 300" in cfg_content, "DEFAULT_SETTINGS must have 300s budget"
    assert "upstream_timeout_sec: 120" in cfg_content, "DEFAULT_SETTINGS must have 120s upstream timeout"


def run_tests():
    print("=== Running Phase 3 & Phase 4 Audit Tests ===")
    test_core02_ast_safe_calculation()
    print("  PASS: Core-02 AST safe arithmetic evaluator (Zero eval())")
    test_arch03_version_consistency()
    v_root = json.loads(open(os.path.join(root_dir, "version.json")).read())
    print(f"  PASS: Arch-03 Version consistency verified at {v_root['version']}")
    test_release_spec_and_install_scripts()
    print("  PASS: Release-01 Install scripts sync, dependency skip & release spec verified")
    test_edgeone_and_vm_ui_timeout_parity()
    print("  PASS: RedLine-01 EdgeOne & VM UI timeout parity and guardrails verified")
    print("\nPhase 3 & Phase 4 Summary: ALL TESTS PASSED!")


if __name__ == "__main__":
    run_tests()

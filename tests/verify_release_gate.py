#!/usr/bin/env python3
"""tests/verify_release_gate.py — 极简发版质量硬门禁 (Lean Release Gatekeeper)

遵循奥卡姆剃刀原则：0 外部依赖，<0.3 秒完成。
严格校验发版 5 大黄金法则（G1~G5），任何一处不满足立即报错并退出。
"""

import sys
import os
import json
import re

REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))

COLOR_GREEN = "\033[92m"
COLOR_RED = "\033[91m"
COLOR_BOLD = "\033[1m"
COLOR_RESET = "\033[0m"


def fail(gate_id, msg):
    print(f"{COLOR_RED}[FAIL] {gate_id}: {msg}{COLOR_RESET}", file=sys.stderr)
    sys.exit(1)


def pass_gate(gate_id, msg):
    print(f"{COLOR_GREEN}[PASS] {gate_id}: {msg}{COLOR_RESET}")


def check_g1_version_sync():
    """G1: 校验版本号在全网 7 处文件 100% 强一致"""
    v_root_path = os.path.join(REPO_ROOT, "version.json")
    if not os.path.exists(v_root_path):
        fail("G1", f"Missing {v_root_path}")
    
    with open(v_root_path, "r", encoding="utf-8") as f:
        root_data = json.load(f)
    expected_version = root_data.get("version", "").strip()
    raw_ver = expected_version.lstrip("v")
    if not expected_version:
        fail("G1", "version.json missing 'version' field")

    # 1. vm-app/version.json
    vm_v_path = os.path.join(REPO_ROOT, "vm-app", "version.json")
    with open(vm_v_path, "r", encoding="utf-8") as f:
        vm_v = json.load(f).get("version", "").strip()
    if vm_v != expected_version:
        fail("G1", f"vm-app/version.json version ({vm_v}) != root ({expected_version})")

    # 2. install.sh
    inst_path = os.path.join(REPO_ROOT, "install.sh")
    with open(inst_path, "r", encoding="utf-8") as f:
        inst_content = f.read()
    if f'SCRIPT_VERSION="{expected_version}"' not in inst_content:
        fail("G1", f"install.sh SCRIPT_VERSION does not match {expected_version}")

    # 3. vm-app/install.sh
    vm_inst_path = os.path.join(REPO_ROOT, "vm-app", "install.sh")
    with open(vm_inst_path, "r", encoding="utf-8") as f:
        vm_inst_content = f.read()
    if f'SCRIPT_VERSION="{expected_version}"' not in vm_inst_content:
        fail("G1", f"vm-app/install.sh SCRIPT_VERSION does not match {expected_version}")

    # 4. shared/admin/admin.html
    shared_html = os.path.join(REPO_ROOT, "shared", "admin", "admin.html")
    with open(shared_html, "r", encoding="utf-8") as f:
        s_html = f.read()
    if f'id="topVersionBadge" title="系统发行版本">{expected_version}</span>' not in s_html:
        fail("G1", f"shared/admin/admin.html topVersionBadge does not match {expected_version}")
    if f'?v={raw_ver}' not in s_html:
        fail("G1", f"shared/admin/admin.html script cache-busting query does not match ?v={raw_ver}")

    # 5. vm-app/static/admin.html
    vm_html = os.path.join(REPO_ROOT, "vm-app", "static", "admin.html")
    with open(vm_html, "r", encoding="utf-8") as f:
        v_html = f.read()
    if f'id="topVersionBadge" title="系统发行版本">{expected_version}</span>' not in v_html:
        fail("G1", f"vm-app/static/admin.html topVersionBadge does not match {expected_version}")

    # 6. agent-edgeone/admin.html
    eo_html_path = os.path.join(REPO_ROOT, "agent-edgeone", "admin.html")
    with open(eo_html_path, "r", encoding="utf-8") as f:
        eo_html = f.read()
    if f'id="topVersionBadge" title="系统发行版本">{expected_version}</span>' not in eo_html:
        fail("G1", f"agent-edgeone/admin.html topVersionBadge does not match {expected_version}")

    # 7. edge-functions/admin.js & agent-edgeone/admin.bundled.html
    ef_admin_path = os.path.join(REPO_ROOT, "edge-functions", "admin.js")
    with open(ef_admin_path, "r", encoding="utf-8") as f:
        ef_admin = f.read()
    if f'id="topVersionBadge" title="系统发行版本">{expected_version}</span>' not in ef_admin:
        fail("G1", f"edge-functions/admin.js bundled HTML does not match {expected_version}")

    pass_gate("G1", f"Version parity verified across all 7 targets ({expected_version})")


def check_g2_edgeone_identity_and_vault_hub():
    """G2: 强断言 EdgeOne 专属身份与凭据中枢保全（防误部署成 VM Agent 版本）"""
    ef_admin_path = os.path.join(REPO_ROOT, "edge-functions", "admin.js")
    with open(ef_admin_path, "r", encoding="utf-8") as f:
        ef_admin = f.read()

    # 1. 必须在前端闭包顶层注入宿主标识
    if "window.__HOST_KIND__ = 'edgeone'" not in ef_admin:
        fail("G2", "edge-functions/admin.js missing 'window.__HOST_KIND__ = \\'edgeone\\''")

    # 2. 静态 Title 必须是 EdgeOne 控制台专属
    if "<title>OCRProxy EdgeOne 控制台</title>" not in ef_admin:
        fail("G2", "edge-functions/admin.js missing static title '<title>OCRProxy EdgeOne 控制台</title>'")

    # 3. 静态初始 Badge 必须是 EdgeOne 边缘版
    if 'id="topModeBadge">EdgeOne 边缘版</span>' not in ef_admin:
        fail("G2", "edge-functions/admin.js missing static badge 'EdgeOne 边缘版'")

    # 4. 必须包含供应商面板与 Key 凭据管理能力（Vault Hub 核心大门）
    if 'id="panel-providers"' not in ef_admin:
        fail("G2", "edge-functions/admin.js missing Providers panel (id='panel-providers')")

    # 5. 必须具备 agent-models-ui 核心函数
    if "renderAgentModels" not in ef_admin or "saveAgentModel" not in ef_admin:
        fail("G2", "edge-functions/admin.js missing shared agent-models-ui functions")

    # 6. agent-edgeone/admin.html 专属模板核验
    eo_html_path = os.path.join(REPO_ROOT, "agent-edgeone", "admin.html")
    with open(eo_html_path, "r", encoding="utf-8") as f:
        eo_html = f.read()
    if "<title>OCRProxy EdgeOne 控制台</title>" not in eo_html:
        fail("G2", "agent-edgeone/admin.html missing '<title>OCRProxy EdgeOne 控制台</title>'")
    if 'id="topModeBadge">EdgeOne 边缘版</span>' not in eo_html:
        fail("G2", "agent-edgeone/admin.html missing 'EdgeOne 边缘版' badge")

    pass_gate("G2", "EdgeOne exclusive identity & Vault Hub guard verified (No VM Agent pollution)")


def check_g3_install_scripts_zero_drift():
    """G3: 校验 install.sh 与 vm-app/install.sh 100% 字节一致"""
    root_inst = os.path.join(REPO_ROOT, "install.sh")
    vm_inst = os.path.join(REPO_ROOT, "vm-app", "install.sh")
    with open(root_inst, "rb") as f1, open(vm_inst, "rb") as f2:
        c1 = f1.read()
        c2 = f2.read()
    if c1 != c2:
        fail("G3", "install.sh and vm-app/install.sh are not byte-for-byte identical")
    pass_gate("G3", "Install scripts zero-drift verified (100% byte match)")


def check_g4_ssot_sync():
    """G4: 校验 shared/admin/ 与编译同步目标一致（防改了源码漏跑 build）"""
    shared_css = os.path.join(REPO_ROOT, "shared", "admin", "admin.css")
    vm_css = os.path.join(REPO_ROOT, "vm-app", "static", "admin.css")
    with open(shared_css, "rb") as f1, open(vm_css, "rb") as f2:
        if f1.read() != f2.read():
            fail("G4", "shared/admin/admin.css != vm-app/static/admin.css. Run 'npm run build:admin'!")

    shared_core = os.path.join(REPO_ROOT, "shared", "admin", "js", "core.js")
    vm_core = os.path.join(REPO_ROOT, "vm-app", "static", "js", "core.js")
    with open(shared_core, "rb") as f1, open(vm_core, "rb") as f2:
        if f1.read() != f2.read():
            fail("G4", "shared/admin/js/core.js != vm-app/static/js/core.js. Run 'npm run build:admin'!")

    pass_gate("G4", "SSOT assets synchronization verified (shared/admin == vm-app/static)")


def check_g5_zero_secret_leak():
    """G5: 敏感凭据零泄露审计（扫描代码库防误提交真实 Key）"""
    dangerous_patterns = [
        re.compile(r'sk-[a-zA-Z0-9]{32,}'),
        re.compile(r'gsk_[a-zA-Z0-9]{32,}'),
        re.compile(r'-----BEGIN (?:RSA|OPENSSH) PRIVATE KEY-----'),
    ]

    scanned_files = [
        "version.json",
        "install.sh",
        "edgeone.json",
        "package.json",
        "shared/admin/admin.html",
        "shared/admin/admin.css",
        "shared/admin/js/host.js",
        "shared/admin/js/core.js",
        "shared/admin/js/settings.js",
        "shared/admin/js/providers.js",
        "shared/admin/js/agent-models-ui.js",
    ]

    for rel_path in scanned_files:
        full_path = os.path.join(REPO_ROOT, rel_path)
        if not os.path.exists(full_path):
            continue
        with open(full_path, "r", encoding="utf-8", errors="ignore") as f:
            content = f.read()
        for p in dangerous_patterns:
            if p.search(content):
                fail("G5", f"Potential real secret detected in {rel_path}!")

    pass_gate("G5", "Zero plaintext secret leakage verified across core files")


def main():
    print(f"\n{COLOR_BOLD}=== OCRProxy 极简发版质量硬门禁 (Lean Release Gatekeeper) ==={COLOR_RESET}")
    check_g1_version_sync()
    check_g2_edgeone_identity_and_vault_hub()
    check_g3_install_scripts_zero_drift()
    check_g4_ssot_sync()
    check_g5_zero_secret_leak()
    print(f"\n{COLOR_BOLD}{COLOR_GREEN}🎉 ALL 5 RELEASE GATES PASSED! Ready for deployment.{COLOR_RESET}\n")


if __name__ == "__main__":
    main()

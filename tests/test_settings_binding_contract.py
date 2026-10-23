#!/usr/bin/env python3
"""tests/test_settings_binding_contract.py — 设置项“UI 可见/可保存/后端真读”契约门禁。

回归 2026-10-23 的根因：
- `data-cap="kb"` 引用了 HOST.capabilities 中不存在的能力位，applyCapabilities()
  会把 KB 设置整行 hidden，用户看到“参数改不了/保存后消失”；
- EdgeOne UI 写 `agent_first_byte_timeout_sec`，但 runtime 读 `upstream_timeout_sec`，
  形成“UI 有、后端不认”的静默漂移；
- 文档仍保留已删除的 request_total_budget_sec/max_retries/max_attempts_per_provider。

本测试断言：
1. 所有 data-cap 必须来自 HOST.capabilities；data-arch 只能是 vm/edgeone；
2. 已删除的三个配置不得回到 schema/设置页/运行时；
3. Agent 单次超时键必须在 VM 与 EdgeOne runtime 都被读取；
4. schema 中 EdgeOne 适用的字段必须在 EdgeOne 代码中有引用（防止再出现 UI-only 字段）。
"""
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SCHEMA = json.loads((ROOT / "shared/config/settings.schema.json").read_text(encoding="utf-8"))
FIELDS = SCHEMA.get("settings") or SCHEMA.get("fields") or []
HTML = (ROOT / "shared/admin/admin.html").read_text(encoding="utf-8")
HOST_JS = (ROOT / "shared/admin/js/host.js").read_text(encoding="utf-8")
VM_SCHED = (ROOT / "vm-app/app/scheduler.py").read_text(encoding="utf-8")
EO_CHAT = (ROOT / "agent-edgeone/edge-functions/v1/chat/completions.js").read_text(encoding="utf-8")
EO_MSG = (ROOT / "agent-edgeone/edge-functions/v1/messages.js").read_text(encoding="utf-8")

REMOVED = {"request_total_budget_sec", "max_retries", "max_attempts_per_provider"}


def capabilities_keys():
    block = HOST_JS.split("capabilities: {", 1)[1].split("\n    },", 1)[0]
    return set(re.findall(r"^\s{6}([A-Za-z0-9_]+):", block, re.M))


def check_data_caps():
    caps = capabilities_keys()
    assert caps, "HOST.capabilities 解析失败"
    used = set(re.findall(r'data-cap="([^"]+)"', HTML))
    bad = sorted(used - caps)
    assert not bad, f"data-cap 引用了不存在的能力位: {bad}；合法值={sorted(caps)}"
    archs = set(re.findall(r'data-arch="([^"]+)"', HTML))
    assert archs <= {"vm", "edgeone"}, f"data-arch 非法: {sorted(archs - {'vm', 'edgeone'})}"
    print(f"PASS data-cap/data-arch: {sorted(used)} / {sorted(archs)}")


def check_removed_fields():
    schema_keys = {f.get("key") for f in FIELDS}
    leaked = sorted(REMOVED & schema_keys)
    assert not leaked, f"已删除配置重新出现在 schema: {leaked}"
    for legacy_id in ("s_budget", "s_maxRetries", "s_maxAttemptsPerProvider"):
        assert f'id="{legacy_id}"' not in HTML, f"设置页仍保留已删除字段 {legacy_id}"
    for src_name, src in (("scheduler.py", VM_SCHED), ("chat.js", EO_CHAT), ("messages.js", EO_MSG)):
        for key in REMOVED:
            # 注释中提及不算违规，只禁止作为读取/赋值标识出现
            live = re.search(rf"[.\[]\s*['\"]?{key}\b", src)
            assert not live, f"{src_name} 仍在运行时读取已删除配置 {key}"
    print("PASS removed config fields: schema/UI/runtime 均无残留")


def check_timeout_binding():
    by_key = {f.get("key"): f for f in FIELDS}
    f = by_key["agent_first_byte_timeout_sec"]
    assert "edgeone" in (f.get("hosts") or []), "agent_first_byte_timeout_sec 必须声明 edgeone host"
    assert "agent_first_byte_timeout_sec" in VM_SCHED, "VM scheduler 未读取 agent_first_byte_timeout_sec"
    assert "agent_first_byte_timeout_sec" in EO_CHAT, "EdgeOne chat 未读取 agent_first_byte_timeout_sec"
    assert "agent_first_byte_timeout_sec" in EO_MSG, "EdgeOne messages 未读取 agent_first_byte_timeout_sec"
    print("PASS timeout binding: VM + EdgeOne 都读取 agent_first_byte_timeout_sec")


def check_edgeone_fields_are_read():
    """schema 中 hosts 含 edgeone 的字段（非 hidden）必须在 EdgeOne 代码中至少出现一次。"""
    src = EO_CHAT + EO_MSG + (ROOT / "agent-edgeone/edge-functions/lib/config.js").read_text(encoding="utf-8")
    missing = []
    for f in FIELDS:
        key = f.get("key")
        if "edgeone" not in (f.get("hosts") or []):
            continue
        if f.get("hidden"):
            continue
        if key not in src:
            missing.append(key)
    assert not missing, f"schema 声明 EdgeOne 可用但 EdgeOne 代码未读取: {missing}"
    print("PASS edgeone field binding: schema 字段均有运行时读取点")


if __name__ == "__main__":
    check_data_caps()
    check_removed_fields()
    check_timeout_binding()
    check_edgeone_fields_are_read()
    print("ALL SETTINGS BINDING CONTRACT CHECKS PASSED")

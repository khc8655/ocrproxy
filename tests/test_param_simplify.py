#!/usr/bin/env python3
"""tests/test_param_simplify.py — 参数精简 v2 的行为回归。

1. 401/402/403 与欠费统一进「冷宫」（cooldown_quota_sec，默认 24h），Agent/KB 一致。
2. KB 熔断只用 circuit_cooldown_sec（不再与 circuit_escalation_sec 取最大值）。
3. KB 单供应商多 Key：一个 Key 5xx / 读超时，不再跳过同供应商的其余 Key。
4. 冷宫落盘：重启后恢复；clear_key_ban（手动测试成功）解除并更新文件。
5. 旧配置迁移：停在旧默认值的参数换成新默认值，自定义值不动，废弃字段删除。
6. schema：各模式/部署在设置页开放的参数集合。
"""
import asyncio
import json
import os
import sys
import tempfile
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "vm-app"))
os.environ.setdefault("CONFIG_DIR", tempfile.mkdtemp(prefix="param_v2_"))

import httpx  # noqa: E402
import app.scheduler as sched  # noqa: E402
from app.scheduler import evaluate_candidate_failure, schedule, reset_runtime_state  # noqa: E402


def _eval(status, category, **params):
    return evaluate_candidate_failure(status_code=status, is_quota=False, is_key_issue_400=False,
                                      category=category, consecutive_5xx_count=params.pop("cf", 0),
                                      config_params=params)


def test_ban_and_circuit_policy():
    for cat in ("agent", "kb"):
        assert _eval(401, cat).cooldown_sec == 86400, cat
        assert _eval(403, cat).cooldown_sec == 86400, cat
        assert _eval(401, cat, cooldown_quota_sec=7200).cooldown_sec == 7200, cat
    # KB circuit: exactly circuit_cooldown_sec, default 600 (old code returned max(.., 1800))
    assert _eval(503, "kb", cf=3).cooldown_sec == 600
    assert _eval(503, "kb", cf=3, circuit_cooldown_sec=120).cooldown_sec == 120
    assert _eval(503, "kb", cf=1).cooldown_sec == 30
    print("PASS ban policy: 401/403 -> cooldown_quota_sec; KB circuit uses one knob")


def _mock_client(behaviour):
    def resp(status, body=b'{"error":"x"}'):
        r = MagicMock()
        r.status_code = status
        r.content = body
        r.headers = {}
        r.aclose = AsyncMock()
        return r

    async def send(*args, **kwargs):
        target = str(args) + str(kwargs)
        for marker, action in behaviour.items():
            if marker in target:
                if isinstance(action, Exception):
                    raise action
                return resp(*action) if isinstance(action, tuple) else resp(action)
        return resp(200, b'{"data":[{"embedding":[0.1]}]}')

    c = MagicMock()
    c.request = AsyncMock(side_effect=send)
    c.send = AsyncMock(side_effect=send)
    c.build_request = MagicMock(side_effect=lambda method, url, **kw: MagicMock(url=MagicMock(__str__=lambda s: str(url))))
    return c


def _kb_config(n=3):
    return {
        "run_mode": "kb",
        "providers": {"nv": {"base_url": "https://nv.example.com", "keys": {f"k{i}": f"sk-{i}" for i in range(n)}}},
        "candidates": {"embedding": [{"provider": "nv", "key": f"k{i}", "model": "emb"} for i in range(n)]},
        "request_timeout_sec": 5.0,
        "kb_routing_strategy": "priority",  # falls back to round_robin
    }


def _build(cand, api_key, base_url):
    return "POST", f"{base_url}/{cand['key']}/embeddings", {}, {}


async def test_kb_single_provider_keeps_trying_keys():
    for failure in ((503,), httpx.ReadTimeout("slow")):
        reset_runtime_state()
        sched._rr_kb_indices.clear()
        client = _mock_client({"/k0/": failure if isinstance(failure, Exception) else failure[0],
                               "/k1/": failure if isinstance(failure, Exception) else failure[0]})
        with patch("app.scheduler.get_client", AsyncMock(return_value=client)):
            res = await schedule(_kb_config(), "embedding", _build, category="kb", request_model="embedding")
        assert res.routed_via == "nv/k2", (failure, res.routed_via)
    print("PASS KB: one provider, 5xx / read timeout on two keys -> third key still tried")


async def test_402_ban_persisted_and_cleared():
    reset_runtime_state()
    sched._rr_kb_indices.clear()
    client = _mock_client({"/k0/": (402, b'{"error":"payment required"}')})
    with patch("app.scheduler.get_client", AsyncMock(return_value=client)):
        res = await schedule(_kb_config(2), "embedding", _build, category="kb", request_model="embedding")
    assert res.routed_via == "nv/k1"
    assert sched.is_key_cooling("nv", "k0")
    remaining = sched._key_cooldown_until["nv:k0"] - __import__("time").time()
    assert remaining > 86000, remaining
    data = json.loads(Path(sched._bans_path()).read_text())
    assert "nv:k0" in data["keys"] and "nv:k0:emb" in data["quota"]

    # simulated restart
    sched._key_cooldown_until.clear()
    sched._cooldown_until.clear()
    sched._quota_exhausted_cands.clear()
    sched._bans_loaded = False
    sched._load_bans()
    assert sched.is_key_cooling("nv", "k0") and "nv:k0:emb" in sched._quota_exhausted_cands

    assert sched.clear_key_ban("nv", "k0", "emb")
    assert not sched.is_key_cooling("nv", "k0")
    data = json.loads(Path(sched._bans_path()).read_text())
    assert "nv:k0" not in data["keys"] and "nv:k0:emb" not in data["cands"]
    print("PASS 402: key banned 24h, survives restart, cleared by a successful manual test")


def test_config_migration():
    from app.config_store import _migrate_params_v2
    cfg = {"agent_first_byte_timeout_sec": 120, "kb_max_concurrency_per_key": 8, "upstream_timeout_sec": 15,
           "cooldown_403_sec": 600, "circuit_escalation_sec": 1800, "fast_failover_provider_down": False,
           "max_retries": 3, "upstream_timeout_chat": 15,
           "settings": {"cooldown_quota_sec": 1800, "circuit_cooldown_sec": 300}}
    assert _migrate_params_v2(cfg) is True
    assert cfg["agent_first_byte_timeout_sec"] == 90
    assert cfg["kb_max_concurrency_per_key"] == 8, "custom value must be kept"
    assert cfg["upstream_timeout_sec"] == 20
    assert cfg["settings"]["cooldown_quota_sec"] == 86400 and cfg["settings"]["circuit_cooldown_sec"] == 600
    for gone in ("cooldown_403_sec", "circuit_escalation_sec", "fast_failover_provider_down", "max_retries", "upstream_timeout_chat"):
        assert gone not in cfg, gone
    assert cfg["_params_rev"] == 2
    cfg["agent_first_byte_timeout_sec"] = 120  # user explicitly picks 120 after migration
    assert _migrate_params_v2(cfg) is False and cfg["agent_first_byte_timeout_sec"] == 120
    print("PASS migration: old defaults upgraded once, custom values and later choices kept")


def test_schema_visibility():
    schema = json.loads((ROOT / "shared/config/settings.schema.json").read_text(encoding="utf-8"))

    def visible(host, mode, strategy):
        out = set()
        for f in schema["fields"]:
            if f.get("hidden"):
                continue
            if f.get("hosts") and host not in f["hosts"]:
                continue
            if f.get("modes") and mode not in f["modes"]:
                continue
            if f.get("strategies") and strategy not in f["strategies"]:
                continue
            out.add(f["key"])
        return out

    base_vm = {"proxy_api_key", "mode_schedule_enabled", "mode_schedule_kb_start", "mode_schedule_kb_end"}
    assert visible("vm", "agent", "manual") == base_vm | {"agent_routing_strategy"}
    assert visible("vm", "agent", "sticky_failover") == base_vm | {
        "agent_routing_strategy", "agent_first_byte_timeout_sec", "agent_max_concurrency_per_key", "cooldown_quota_sec"}
    assert visible("edgeone", "agent", "sticky_failover") == {
        "proxy_api_key", "agent_routing_strategy", "agent_first_byte_timeout_sec", "cooldown_quota_sec"}
    assert visible("vm", "kb", "round_robin") == base_vm | {
        "kb_routing_strategy", "kb_chat_timeout_sec", "upstream_timeout_sec", "upstream_timeout_kb",
        "kb_max_concurrency_per_key", "kb_global_max_concurrency", "ocr_max_inflight", "ocr_queue_timeout_sec",
        "cooldown_429_sec", "cooldown_5xx_sec", "circuit_break_threshold", "circuit_cooldown_sec", "cooldown_quota_sec"}
    print("PASS schema: per-mode parameter sets")


async def main():
    test_ban_and_circuit_policy()
    await test_kb_single_provider_keeps_trying_keys()
    await test_402_ban_persisted_and_cleared()
    test_config_migration()
    test_schema_visibility()
    print("ALL PARAM SIMPLIFY TESTS PASSED")


if __name__ == "__main__":
    asyncio.run(main())

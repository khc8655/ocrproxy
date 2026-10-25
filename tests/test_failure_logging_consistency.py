#!/usr/bin/env python3
"""tests/test_failure_logging_consistency.py — 统计失败数必须有对应错误日志。

2026-10-25 事故：Agent 粘性(manual)模式上游 4xx/5xx 时，scheduler 在
stats.record() 之前就 raise，导致概览 failures 有数、最近错误日志为空。
本测试锁住 manual / 提前 abort / 全冷却三类路径。
"""
import asyncio
import os
import sys
import tempfile
from pathlib import Path
from unittest.mock import MagicMock, AsyncMock, patch

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "vm-app"))
os.environ.setdefault("CONFIG_DIR", tempfile.mkdtemp(prefix="failure_logging_"))

import app.scheduler as sched
from app import stats as vm_stats


def _config(strategy="manual"):
    return {
        "run_mode": "agent",
        "providers": {"p1": {"base_url": "https://p1.example.com", "keys": {"k1": "sk-1"}}},
        "agent_models": {
            "m1": {"active_key": "p1:k1", "keys": [{"provider": "p1", "key": "k1"}]}
        },
        "candidates": {"chat": [{"provider": "p1", "key": "k1", "model": "m1"}]},
        "agent_routing_strategy": strategy,
    }


def _client(status, body=b'{"error":{"message":"upstream boom"}}'):
    resp = MagicMock()
    resp.status_code = status
    resp.content = body
    resp.headers = {}
    resp.aclose = AsyncMock()
    client = MagicMock()
    client.send = AsyncMock(return_value=resp)
    client.request = AsyncMock(return_value=resp)
    client.build_request = MagicMock(side_effect=lambda method, url, **kw: MagicMock(url=MagicMock(__str__=lambda s: str(url))))
    return client


def _build(cand, api_key, base_url):
    return "POST", f"{base_url}/chat/completions", {}, {}


async def test_manual_upstream_failure_logged():
    for status in (401, 500):
        sched.reset_runtime_state()
        vm_stats.reset()
        with patch("app.scheduler.get_client", AsyncMock(return_value=_client(status))):
            try:
                await sched.schedule(_config("manual"), "chat", _build, category="agent", request_model="m1")
                raise AssertionError("manual upstream failure should raise")
            except sched.AllCandidatesFailedError:
                pass
        logs = vm_stats.get_stats()["error_logs"]
        assert logs, f"manual HTTP {status} failure counted but error_logs empty"
        assert logs[0]["status"] == status and logs[0]["provider"] == "p1", logs[0]
    print("PASS manual: upstream 401/500 均写入 error_logs")


async def test_all_cooldown_failure_logged():
    sched.reset_runtime_state()
    vm_stats.reset()
    cfg = _config("sticky_failover")
    sched._cooldown_until[sched.get_candidate_id(cfg["candidates"]["chat"][0])] = __import__("time").time() + 60
    with patch("app.scheduler.get_client", AsyncMock(return_value=_client(200))):
        try:
            await sched.schedule(cfg, "chat", _build, category="agent", request_model="m1")
            raise AssertionError("all-cooldown should raise")
        except sched.AllCandidatesFailedError as e:
            assert e.last_status_code == 429, e.last_status_code
    logs = vm_stats.get_stats()["error_logs"]
    assert logs, "all-cooldown failure counted but error_logs empty"
    print("PASS all-cooldown: 未发起请求也写入 error_logs")


def test_gateway_error_logged():
    vm_stats.reset()
    vm_stats.record_gateway_error("m1", 503, "upstream connection pool exhausted", "agent")
    logs = vm_stats.get_stats()["error_logs"]
    assert logs and logs[0]["provider"] == "gateway" and logs[0]["status"] == 503, logs
    print("PASS gateway: 连接池/队列类失败写入 error_logs")


if __name__ == "__main__":
    asyncio.run(test_manual_upstream_failure_logged())
    asyncio.run(test_all_cooldown_failure_logged())
    test_gateway_error_logged()
    print("ALL FAILURE LOGGING CONSISTENCY CHECKS PASSED")

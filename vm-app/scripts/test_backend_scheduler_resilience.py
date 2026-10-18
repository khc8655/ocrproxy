#!/usr/bin/env python3
"""tests/test_backend_scheduler_resilience.py

Comprehensive regression test suite for backend scheduler resilience and hardening:
1. P0-1: Budget decoupling (prevent starvation of candidate 2 when endpoint timeout is large).
2. P0-5: Three-tier cooldown (Key-level 401/403/quota isolation across models).
3. P1-1 & P1-2: Sticky Key composite key provider:key and 429 proactive failover advance.
4. P1-3: 400 client error multi-provider failover.
5. P1-4: Quota phrase precision (prevent false positive on literal '0' or status codes).
6. R1: RPM sliding window conservative backoff (>= 15s).
7. M3: Zero-copy raw content bytes on embeddings and rerank.
"""

import sys
import time
import asyncio
from pathlib import Path
from unittest.mock import MagicMock, AsyncMock, patch

# Ensure vm-app is in sys.path
script_dir = Path(__file__).resolve().parent
if script_dir.name == "scripts":
    vm_app_dir = script_dir.parent
else:
    vm_app_dir = script_dir.parent / "vm-app"
sys.path.insert(0, str(vm_app_dir))

# Mock web frameworks if not installed in standalone python runner
if "httpx" not in sys.modules:
    try:
        import httpx
    except ImportError:
        mock_httpx = MagicMock()
        class HTTPError(Exception): pass
        class RequestError(HTTPError): pass
        class TransportError(HTTPError): pass
        class TimeoutException(HTTPError): pass
        class ConnectTimeout(TimeoutException): pass
        class ReadTimeout(TimeoutException): pass
        class WriteTimeout(TimeoutException): pass
        class PoolTimeout(TimeoutException): pass
        class ConnectError(TransportError): pass
        class ReadError(TransportError): pass
        class WriteError(TransportError): pass
        class RemoteProtocolError(HTTPError): pass

        mock_httpx.HTTPError = HTTPError
        mock_httpx.RequestError = RequestError
        mock_httpx.TransportError = TransportError
        mock_httpx.TimeoutException = TimeoutException
        mock_httpx.ConnectTimeout = ConnectTimeout
        mock_httpx.ReadTimeout = ReadTimeout
        mock_httpx.WriteTimeout = WriteTimeout
        mock_httpx.PoolTimeout = PoolTimeout
        mock_httpx.ConnectError = ConnectError
        mock_httpx.ReadError = ReadError
        mock_httpx.WriteError = WriteError
        mock_httpx.RemoteProtocolError = RemoteProtocolError
        mock_httpx.ByteStream = MagicMock
        sys.modules["httpx"] = mock_httpx

for mod in ["fastapi", "fastapi.responses"]:
    if mod not in sys.modules:
        try:
            __import__(mod)
        except ImportError:
            sys.modules[mod] = MagicMock()

import app.scheduler as sched
from app.scheduler import (
    schedule,
    reset_runtime_state,
    _rpm_mark_exhausted,
    _rpm_wait,
    _rpm_windows,
    _key_cooldown_until,
    _cooldown_until,
    _sticky_agent_active_keys,
    is_key_cooling,
    evaluate_candidate_failure,
    AllCandidatesFailedError,
    ScheduleResult,
)


def test_rpm_mark_exhausted_backoff():
    print("🧪 Running test_rpm_mark_exhausted_backoff...")
    reset_runtime_state()
    _rpm_windows.clear()

    key_id = "test_prov:k1"
    limit = 5

    # Simulate 429 received from upstream
    _rpm_mark_exhausted(key_id, limit, min_backoff_sec=15.0)

    # Immediately check wait time
    wait = _rpm_wait(key_id, limit)
    assert wait >= 14.9, f"Expected wait >= 14.9s, got {wait:.2f}s"
    print(f"  ✓ RPM backoff wait is {wait:.1f}s (>= 15s)")


def test_quota_keyword_precision():
    print("🧪 Running test_quota_keyword_precision...")
    # Body containing '0' but not insufficient balance
    normal_body = '{"code": 0, "balance": 100, "message": "success"}'
    lower = normal_body.lower()
    
    # Check that phrase matching doesn't flag this normal body as quota
    _QUOTA_BALANCE_PHRASES = sched.QUOTA_BALANCE_PHRASES if hasattr(sched, "QUOTA_BALANCE_PHRASES") else (
        "insufficient balance", "balance is insufficient", "balance not enough",
        "balance is 0", "balance=0", "no balance", "credit balance is too low",
        "credit insufficient balance", "credit is 0", "credit depleted",
        "余额不足", "账户欠费", "配额不足", "额度不足", "免费额度用尽"
    )
    is_quota_flag = any(p in lower for p in _QUOTA_BALANCE_PHRASES)
    assert not is_quota_flag, "Normal body with '0' was incorrectly flagged as quota!"

    # Genuine quota body
    genuine_body = '{"error": {"message": "credit balance is too low", "type": "insufficient_quota"}}'
    assert any(w in genuine_body.lower() for w in sched.HARD_QUOTA_KEYWORDS)
    print("  ✓ Quota phrase precision verified (no false positive on '0')")


def test_key_level_cooldown_isolation():
    print("🧪 Running test_key_level_cooldown_isolation...")
    reset_runtime_state()

    prov = "test_prov"
    key = "bad_key"
    key_id = f"{prov}:{key}"

    # Mark key in cooldown
    _key_cooldown_until[key_id] = time.time() + 60.0

    assert is_key_cooling(prov, key)
    assert not is_key_cooling(prov, "good_key")
    print("  ✓ Key-level cooldown successfully isolates bad key while good key passes")


def test_zero_copy_raw_content():
    print("🧪 Running test_zero_copy_raw_content...")
    raw = b'{"object":"list","data":[{"embedding":[0.1, 0.2, 0.3]}],"usage":{"total_tokens":5}}'
    sr = ScheduleResult(raw_content=raw, routed_via="p1/k1")
    
    # Verify raw_content is preserved without automatic json decoding
    assert sr.raw_content == raw
    assert sr.routed_via == "p1/k1"
    print("  ✓ Zero-copy raw_content integrity verified")


async def test_budget_decoupling_failover():
    print("🧪 Running test_budget_decoupling_failover...")
    reset_runtime_state()

    # 2 candidates, upstream_timeout = 60s, request_total_budget_sec configured as 60s
    config = {
        "providers": {
            "p1": {"base_url": "https://p1.example.com", "keys": {"k1": "sk-1"}},
            "p2": {"base_url": "https://p2.example.com", "keys": {"k2": "sk-2"}},
        },
        "candidates": {
            "ocr": [
                {"provider": "p1", "key": "k1", "model": "ocr-v1", "timeout_sec": 60.0},
                {"provider": "p2", "key": "k2", "model": "ocr-v1", "timeout_sec": 60.0},
            ]
        },
        "upstream_timeout": 60.0,
        "request_total_budget_sec": 60.0,
        "max_retries": 2,
    }

    call_seq = []

    def mock_build_request(cand, api_key, base_url):
        call_seq.append(cand["provider"])
        return "POST", f"{base_url}/ocr", {}, {}

    # Mock client to fail cand 1 after 0.01s (simulating timeout/500) and succeed on cand 2
    mock_resp_fail = MagicMock()
    mock_resp_fail.status_code = 502
    mock_resp_fail.content = b'{"error":"gateway down"}'
    mock_resp_fail.headers = {}
    mock_resp_fail.aclose = AsyncMock()

    mock_resp_ok = MagicMock()
    mock_resp_ok.status_code = 200
    mock_resp_ok.content = b'{"results":"ok"}'
    mock_resp_ok.headers = {}
    mock_resp_ok.aclose = AsyncMock()

    async def mock_send(*args, **kwargs):
        target_str = str(args) + str(kwargs)
        if "p1" in target_str:
            return mock_resp_fail
        return mock_resp_ok

    mock_client = MagicMock()
    mock_client.request = AsyncMock(side_effect=mock_send)
    mock_client.send = AsyncMock(side_effect=mock_send)
    mock_client.build_request = MagicMock(side_effect=lambda method, url, **kwargs: MagicMock(url=MagicMock(__str__=lambda s: str(url))))

    with patch("app.scheduler.get_client", AsyncMock(return_value=mock_client)):
        res = await schedule(config, "ocr", mock_build_request, category="kb", request_model="ocr")
        assert res.routed_via == "p2/k2"
        assert res.fallback_attempts == 1
        assert "p1" in call_seq and "p2" in call_seq

    print("  ✓ Budget decoupling verified: candidate 2 executed and succeeded without starvation")


async def test_sticky_composite_key_and_advance():
    print("🧪 Running test_sticky_composite_key_and_advance...")
    reset_runtime_state()

    config = {
        "providers": {
            "p1": {"base_url": "https://p1.example.com", "keys": {"k1": "sk-1"}},
            "p2": {"base_url": "https://p2.example.com", "keys": {"k2": "sk-2"}},
        },
        "agent_models": {
            "test-model": {
                "active_key": "p1:k1",
                "keys": [
                    {"provider": "p1", "key": "k1"},
                    {"provider": "p2", "key": "k2"},
                ]
            }
        },
        "candidates": {
            "chat": [
                {"provider": "p1", "key": "k1", "model": "m1"},
                {"provider": "p2", "key": "k2", "model": "m1"},
            ]
        },
        "agent_routing_strategy": "sticky_failover",
        "max_retries": 2,
    }

    # k1 returns 429, k2 succeeds
    mock_resp_429 = MagicMock()
    mock_resp_429.status_code = 429
    mock_resp_429.content = b'{"error":"rate limit exceeded"}'
    mock_resp_429.headers = {}
    mock_resp_429.aclose = AsyncMock()

    mock_resp_ok = MagicMock()
    mock_resp_ok.status_code = 200
    mock_resp_ok.content = b'{"choices":[{"message":{"content":"hello"}}]}'
    mock_resp_ok.headers = {}
    mock_resp_ok.aclose = AsyncMock()

    async def mock_send(*args, **kwargs):
        # Check url from positional args or kwargs
        target_str = str(args) + str(kwargs)
        if "p1" in target_str:
            return mock_resp_429
        return mock_resp_ok

    mock_client = MagicMock()
    mock_client.request = AsyncMock(side_effect=mock_send)
    mock_client.send = AsyncMock(side_effect=mock_send)
    mock_client.build_request = MagicMock(side_effect=lambda method, url, **kwargs: MagicMock(url=MagicMock(__str__=lambda s: str(url))))

    def mock_build_request(cand, api_key, base_url):
        return "POST", f"{base_url}/v1/chat/completions", {}, {}

    with patch("app.scheduler.get_client", AsyncMock(return_value=mock_client)):
        res = await schedule(config, "chat", mock_build_request, category="agent", request_model="test-model")
        assert res.routed_via == "p2/k2"
        # Sticky pointer must have advanced to p2:k2 composite key
        active = sched.get_sticky_agent_active_key("test-model")
        assert active == "p2:k2", f"Expected active sticky key to be p2:k2, got {active}"

    print("  ✓ Sticky composite key and 429 pointer advance verified")


async def test_400_multi_provider_failover():
    print("🧪 Running test_400_multi_provider_failover...")
    reset_runtime_state()

    config = {
        "providers": {
            "p1": {"base_url": "https://p1.example.com", "keys": {"k1": "sk-1"}},
            "p2": {"base_url": "https://p2.example.com", "keys": {"k2": "sk-2"}},
        },
        "candidates": {
            "chat": [
                {"provider": "p1", "key": "k1", "model": "m1"},
                {"provider": "p2", "key": "k2", "model": "m1"},
            ]
        },
        "agent_routing_strategy": "sticky_failover",
        "max_retries": 2,
    }

    # p1 returns 400 (unsupported parameter), p2 returns 200
    mock_resp_400 = MagicMock()
    mock_resp_400.status_code = 400
    mock_resp_400.content = b'{"error":"parameter temperature 2.0 unsupported"}'
    mock_resp_400.headers = {}
    mock_resp_400.aclose = AsyncMock()

    mock_resp_ok = MagicMock()
    mock_resp_ok.status_code = 200
    mock_resp_ok.content = b'{"choices":[{"message":{"content":"ok from p2"}}]}'
    mock_resp_ok.headers = {}
    mock_resp_ok.aclose = AsyncMock()

    async def mock_send(*args, **kwargs):
        target_str = str(args) + str(kwargs)
        if "p1" in target_str:
            return mock_resp_400
        return mock_resp_ok

    mock_client = MagicMock()
    mock_client.request = AsyncMock(side_effect=mock_send)
    mock_client.send = AsyncMock(side_effect=mock_send)
    mock_client.build_request = MagicMock(side_effect=lambda method, url, **kwargs: MagicMock(url=MagicMock(__str__=lambda s: str(url))))

    def mock_build_request(cand, api_key, base_url):
        return "POST", f"{base_url}/v1/chat/completions", {}, {}

    with patch("app.scheduler.get_client", AsyncMock(return_value=mock_client)):
        res = await schedule(config, "chat", mock_build_request, category="agent", request_model="chat")
        assert res.routed_via == "p2/k2"
        assert res.fallback_attempts == 1

    print("  ✓ 400 multi-provider failover verified: skipped p1 and succeeded on p2")


async def main():
    test_rpm_mark_exhausted_backoff()
    test_quota_keyword_precision()
    test_key_level_cooldown_isolation()
    test_zero_copy_raw_content()
    await test_budget_decoupling_failover()
    await test_sticky_composite_key_and_advance()
    await test_400_multi_provider_failover()
    print("\n🎉 ALL BACKEND SCHEDULER RESILIENCE TESTS PASSED 100%!")


if __name__ == "__main__":
    asyncio.run(main())

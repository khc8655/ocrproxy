#!/usr/bin/env python3
import asyncio
import sys
import os
import json
from unittest.mock import MagicMock
from pathlib import Path

# Create lightweight mocks with proper Exception base classes for httpx exceptions
class MockHttpxException(Exception): pass
class MockReadTimeout(MockHttpxException): pass
class MockConnectTimeout(MockHttpxException): pass
class MockTimeoutException(MockHttpxException): pass

mock_httpx = MagicMock()
mock_httpx.ReadTimeout = MockReadTimeout
mock_httpx.ConnectTimeout = MockConnectTimeout
mock_httpx.TimeoutException = MockTimeoutException
mock_httpx.RequestError = MockHttpxException

sys.modules["httpx"] = mock_httpx

class RealMockJSONResponse:
    def __init__(self, status_code=200, content=None, headers=None):
        self.status_code = status_code
        self.content = content
        self.headers = headers or {}

mock_fastapi_responses = MagicMock()
mock_fastapi_responses.JSONResponse = RealMockJSONResponse
mock_fastapi_responses.StreamingResponse = MagicMock
sys.modules["fastapi.responses"] = mock_fastapi_responses

for mod in ["fastapi", "fastapi.routing", "cryptography", "cryptography.fernet"]:
    if mod not in sys.modules:
        sys.modules[mod] = MagicMock()

# Add vm-app to sys.path
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "vm-app"))

import app.scheduler as sched
from app.scheduler import schedule, AllCandidatesFailedError
from app.proxy_routes import _error_response

passed = 0
failed = 0

def check(name: str, cond: bool, detail: str = ""):
    global passed, failed
    if cond:
        passed += 1
        print(f"  PASS  {name}" + (f": {detail}" if detail else ""))
    else:
        failed += 1
        print(f"  FAIL  {name}" + (f": {detail}" if detail else ""))

class MockResponse:
    def __init__(self, status_code, json_data=None, text=""):
        self.status_code = status_code
        self._json_data = json_data or {}
        self.text = text or json.dumps(self._json_data)
    def json(self):
        return self._json_data
    async def aclose(self):
        pass
    async def aread(self):
        pass

class MockClient:
    def __init__(self):
        self.calls = []

    async def request(self, method, url, headers=None, json=None, timeout=None):
        auth = headers.get("Authorization", "")
        self.calls.append(auth)
        if "bad_key" in auth:
            return MockResponse(429, {"error": {"message": "Rate limit reached on bad_key", "type": "rate_limit_error"}})
        elif "good_key" in auth:
            return MockResponse(200, {"id": "cmpl-1", "choices": [{"message": {"role": "assistant", "content": "Hello from good key!"}}]})
        return MockResponse(500, {"error": "Server error"})

async def run_tests():
    global passed, failed
    print("\n== Testing Manual Mode & Active Key Pipeline ==")

    # Test 1: Manual mode with active_key = key1 (bad_key) -> must return 429 immediately, exactly 1 call
    mock_client = MockClient()
    sched._client = mock_client
    
    config_manual = {
        "providers": {
            "test_prov": {
                "base_url": "https://api.test",
                "keys": {
                    "key1": "bad_key",
                    "key2": "good_key"
                }
            }
        },
        "agent_routing_strategy": "manual",
        "agent_models": {
            "qwen3.8-flash": {
                "active_key": "key1",
                "keys": [
                    {"provider": "test_prov", "key": "key1"},
                    {"provider": "test_prov", "key": "key2"}
                ]
            }
        },
        "candidates": {}
    }

    # Simulate proxy_routes candidates resolution
    entry = config_manual["agent_models"]["qwen3.8-flash"]
    candidates = []
    for b in entry["keys"]:
        candidates.append({"provider": b["provider"], "key": b["key"], "model": "qwen3.8-flash"})
    
    active_key = entry.get("active_key")
    if config_manual["agent_routing_strategy"] == "manual":
        if active_key:
            candidates = [c for c in candidates if c["key"] == active_key] or candidates[:1]
        else:
            candidates = candidates[:1]

    config_manual["candidates"]["qwen3.8-flash"] = candidates

    def build_req(cand, api_key, base_url):
        return "POST", f"{base_url}/chat/completions", {"Authorization": f"Bearer {api_key}"}, {}

    try:
        await schedule(
            config_manual,
            "qwen3.8-flash",
            build_req,
            category="agent",
            request_model="qwen3.8-flash"
        )
        check("Manual mode 429 error raised", False, "Expected AllCandidatesFailedError")
    except AllCandidatesFailedError as e:
        check("Manual mode 429 error raised", True, f"Status={e.last_status_code}")
        check("Manual mode exactly 1 attempt made", len(mock_client.calls) == 1, f"Calls: {mock_client.calls}")
        err_resp = _error_response(e)
        check("Error response transparently returns HTTP 429", err_resp.status_code == 429, f"Got status {err_resp.status_code}")
        check("Error response contains upstream JSON body", err_resp.content.get("error", {}).get("message") == "Rate limit reached on bad_key")

    # Test 2: Manual mode with active_key = key2 (good_key) -> must return 200 OK
    mock_client = MockClient()
    sched._client = mock_client
    config_manual["agent_models"]["qwen3.8-flash"]["active_key"] = "key2"
    
    # Simulate candidates resolution
    active_key = config_manual["agent_models"]["qwen3.8-flash"]["active_key"]
    all_cands = [{"provider": b["provider"], "key": b["key"], "model": "qwen3.8-flash"} for b in entry["keys"]]
    candidates = [c for c in all_cands if c["key"] == active_key]
    config_manual["candidates"]["qwen3.8-flash"] = candidates
    
    res = await schedule(
        config_manual,
        "qwen3.8-flash",
        build_req,
        category="agent",
        request_model="qwen3.8-flash"
    )
    check("Manual mode 200 OK returned", res.data["choices"][0]["message"]["content"] == "Hello from good key!")
    check("Manual mode routed to active key2", res.routed_via == "test_prov/key2")
    check("Manual mode exactly 1 call made", len(mock_client.calls) == 1)

    # Test 3: Sticky Failover mode with key1 (bad_key) -> must failover to key2
    mock_client = MockClient()
    sched._client = mock_client
    config_sticky = dict(config_manual)
    config_sticky["agent_routing_strategy"] = "sticky_failover"
    config_sticky["candidates"]["qwen3.8-flash"] = all_cands

    res_sticky = await schedule(
        config_sticky,
        "qwen3.8-flash",
        build_req,
        category="agent",
        request_model="qwen3.8-flash"
    )
    check("Sticky failover successfully routed to key2", res_sticky.routed_via == "test_prov/key2")
    check("Sticky failover made 2 calls", len(mock_client.calls) == 2, f"Calls: {mock_client.calls}")
    check("Sticky failover record 1 fallback attempt", res_sticky.fallback_attempts == 1)

    print("\n----------------------------------------")
    print(f"PASS: {passed}")
    print(f"FAIL: {failed}")
    print("----------------------------------------\n")
    if failed > 0:
        sys.exit(1)

if __name__ == "__main__":
    asyncio.run(run_tests())

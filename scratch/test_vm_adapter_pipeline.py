import os
import sys
import copy
from unittest.mock import MagicMock
from pathlib import Path

class FakeFastAPI:
    def __init__(self, *args, **kwargs):
        self.docs_url = kwargs.get("docs_url")
        self.openapi_url = kwargs.get("openapi_url")
        self.redoc_url = kwargs.get("redoc_url")
    def middleware(self, *args, **kwargs):
        return lambda fn: fn
    def include_router(self, *args, **kwargs):
        pass
    def mount(self, *args, **kwargs):
        pass
    def get(self, *args, **kwargs):
        return lambda fn: fn

for mod in ["httpx", "fastapi.responses", "fastapi.routing", "fastapi.staticfiles", "cryptography", "cryptography.fernet"]:
    if mod not in sys.modules:
        m = MagicMock()
        m.__path__ = []
        sys.modules[mod] = m

if "fastapi" not in sys.modules:
    fastapi_mock = MagicMock()
    fastapi_mock.__path__ = []
    fastapi_mock.FastAPI = FakeFastAPI
    fastapi_mock.Request = MagicMock
    fastapi_mock.APIRouter = MagicMock
    sys.modules["fastapi"] = fastapi_mock

# Add vm-app to sys.path
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "vm-app"))

from app.upstream import join_upstream
from app.proxy_routes import (
    _normalise_for_provider,
    _disable_thinking_for_kb,
    _sanitize_gemini_schema,
)
from app.admin_routes import _merge_configs

passed = 0
failed = 0

def test(name, condition, msg=""):
    global passed, failed
    if condition:
        passed += 1
        print(f"  PASS  {name}")
    else:
        failed += 1
        print(f"  FAIL  {name}: {msg}")

print("\n== vm-app: join_upstream smart URL formatting ==")
test("join_upstream: stepfun bare path", join_upstream("https://api.stepfun.com/step_plan", "chat/completions") == "https://api.stepfun.com/step_plan/v1/chat/completions")
test("join_upstream: stepfun /v1 path", join_upstream("https://api.stepfun.com/step_plan/v1", "chat/completions") == "https://api.stepfun.com/step_plan/v1/chat/completions")
test("join_upstream: sensenova bare host", join_upstream("https://token.sensenova.cn", "chat/completions") == "https://token.sensenova.cn/v1/chat/completions")
test("join_upstream: tokenrhythm bare host", join_upstream("https://tokenrhythm.studio", "chat/completions") == "https://tokenrhythm.studio/v1/chat/completions")
test("join_upstream: google openai endpoint", join_upstream("https://generativelanguage.googleapis.com/v1beta/openai", "chat/completions") == "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions")
test("join_upstream: agnes /v1 endpoint", join_upstream("https://apihub.agnes-ai.com/v1", "chat/completions") == "https://apihub.agnes-ai.com/v1/chat/completions")

print("\n== vm-app: _normalise_for_provider declarative adaptation ==")
# 1. StepFun
b1 = {"model": "step-3.7-flash", "reasoning_effort": "none"}
_normalise_for_provider(b1, "stepfun")
test("normalize stepfun: none -> low", b1.get("reasoning_effort") == "low")
test("normalize stepfun: inject deepseek-style", b1.get("reasoning_format") == "deepseek-style")

# 2. TokenRhythm & SenseNova
b2 = {"model": "deepseek-v4-flash", "tool_choice": {"type": "function", "function": {"name": "calc"}}}
_normalise_for_provider(b2, "tokenrhythm")
test("normalize tokenrhythm: object tool_choice -> auto", b2.get("tool_choice") == "auto")

b3 = {"model": "sensenova-6.8-flash-lite", "tool_choice": {"type": "function", "function": {"name": "calc"}}}
_normalise_for_provider(b3, "sensenova")
test("normalize sensenova: object tool_choice -> auto", b3.get("tool_choice") == "auto")

# 3. Agnes AI
b4 = {"model": "agnes-2.5-flash", "reasoning_effort": "high"}
_normalise_for_provider(b4, "agnes")
test("normalize agnes: high -> enable_thinking: True", b4.get("chat_template_kwargs", {}).get("enable_thinking") is True)
test("normalize agnes: pop reasoning_effort", "reasoning_effort" not in b4)

b5 = {"model": "agnes-2.5-flash", "reasoning_effort": "none"}
_normalise_for_provider(b5, "agnes")
test("normalize agnes: none -> enable_thinking: False", b5.get("chat_template_kwargs", {}).get("enable_thinking") is False)

# 4. Google Gemini Thinking Matrix
bg1 = {"model": "gemini-3.5-flash", "reasoning_effort": "medium"}
_normalise_for_provider(bg1, "google")
test("normalize google: flash medium -> thinking_level medium", bg1.get("extra_body", {}).get("google", {}).get("thinking_config", {}).get("thinking_level") == "medium")

bg2 = {"model": "gemini-3.5-pro", "reasoning_effort": "medium"}
_normalise_for_provider(bg2, "google")
test("normalize google: pro medium -> thinking_level low", bg2.get("extra_body", {}).get("google", {}).get("thinking_config", {}).get("thinking_level") == "low")

bg3 = {"model": "gemini-3.5-flash", "reasoning_effort": "none"}
_normalise_for_provider(bg3, "google")
test("normalize google: none -> include_thoughts: False", bg3.get("extra_body", {}).get("google", {}).get("thinking_config", {}).get("include_thoughts") is False)

# 5. Google Schema Sanitization & Thinking Headroom
bg4 = {
    "model": "gemini-3.5-flash",
    "reasoning_effort": "high",
    "max_tokens": 2048,
    "tools": [{
        "type": "function",
        "function": {
            "name": "complex_tool",
            "parameters": {
                "$schema": "http://json-schema.org/draft-07/schema#",
                "additionalProperties": False,
                "$defs": {"MyDef": {"type": "string"}},
                "$ref": "#/$defs/MyDef",
                "type": "object",
                "required": ["q", "ghost"],
                "properties": {
                    "q": {
                        "type": "string",
                        "$schema": "...",
                        "additionalProperties": False,
                    }
                }
            }
        }
    }]
}
_normalise_for_provider(bg4, "google")
clean_params = bg4["tools"][0]["function"]["parameters"]
test("normalize google: strip $schema root", "$schema" not in clean_params)
test("normalize google: strip additionalProperties", "additionalProperties" not in clean_params)
test("normalize google: strip $defs & $ref", "$defs" not in clean_params and "$ref" not in clean_params)
test("normalize google: prune invalid required", clean_params.get("required") == ["q"])
test("normalize google: elevate max_tokens for thinking", bg4.get("max_tokens") == 65535)

bg5 = {"model": "gemma-2-27b-it", "reasoning_effort": "high"}
_normalise_for_provider(bg5, "google")
test("normalize google: skip thinking_config for gemma", "thinking_config" not in bg5.get("extra_body", {}).get("google", {}))

print("\n== vm-app: _disable_thinking_for_kb ==")
kb_sf = {"model": "step-3.7-flash"}
_disable_thinking_for_kb(kb_sf, "stepfun")
test("kb disable stepfun: reasoning_effort low", kb_sf.get("reasoning_effort") == "low")

kb_ag = {"model": "agnes-2.5-flash"}
_disable_thinking_for_kb(kb_ag, "agnes")
test("kb disable agnes: enable_thinking False", kb_ag.get("chat_template_kwargs", {}).get("enable_thinking") is False)

kb_gg = {"model": "gemini-3.5-flash"}
_disable_thinking_for_kb(kb_gg, "google")
test("kb disable google: include_thoughts False", kb_gg.get("extra_body", {}).get("google", {}).get("thinking_config", {}).get("include_thoughts") is False)

print("\n== vm-app: _merge_configs (Schema v2 Settings) ==")
existing_kb = {
    "providers": {"p1": {"base_url": "https://example.com", "keys": {"k1": "v1"}}},
    "candidates": {"chat": [{"provider": "p1", "key": "k1", "upstream_model": "m1"}]},
    "settings": {"request_total_budget_sec": 45}
}
incoming_agent = {
    "providers": {"p1": {"base_url": "https://example.com", "keys": {"k1": "v1"}}, "p2": {"base_url": "https://example2.com", "keys": {"k2": "v2"}}},
    "agent_models": {"m1": {"keys": [{"provider": "p1", "key": "k1"}]}},
    "settings": {"request_total_budget_sec": 25, "fast_failover_provider_down": True}
}

merged = _merge_configs(existing_kb, incoming_agent, "kb")
test("_merge_configs: preserves KB candidates in KB mode", "chat" in merged.get("candidates", {}))
test("_merge_configs: merges incoming providers", "p2" in merged.get("providers", {}))
test("_merge_configs: updates Schema v2 settings", merged.get("settings", {}).get("request_total_budget_sec") == 25)
test("_merge_configs: sets run_mode", merged.get("run_mode") == "kb")

print("\n== vm-app: Security by Default ==")
from app.main import app
from app.auth import verify_admin_auth, is_ip_blocked, record_admin_auth_result
from fastapi import Request

test("security: docs_url disabled by default", app.docs_url is None)
test("security: openapi_url disabled by default", app.openapi_url is None)

# Test brute-force rate limiter
class DummyRequest:
    def __init__(self, ip="192.168.1.100", auth=None):
        self.headers = {"Authorization": auth} if auth else {}
        self.client = type("Client", (), {"host": ip})()

os.environ["ADMIN_PASSWORD"] = "correct_secret_pass"

req_fail = DummyRequest(ip="10.0.0.99", auth="Bearer wrong_pass")
for _ in range(4):
    test_res = verify_admin_auth(req_fail)
    test("auth: fails on wrong password", test_res is False)

test("auth: not yet blocked after 4 fails", is_ip_blocked(req_fail) is False)

# 5th failed attempt triggers block
verify_admin_auth(req_fail)
test("auth: blocked after 5 fails", is_ip_blocked(req_fail) is True)

req_correct_but_blocked = DummyRequest(ip="10.0.0.99", auth="Bearer correct_secret_pass")
test("auth: correct password rejected when IP is blocked", verify_admin_auth(req_correct_but_blocked) is False)

req_other_ip = DummyRequest(ip="10.0.0.100", auth="Bearer correct_secret_pass")
test("auth: other IP with correct pass succeeds", verify_admin_auth(req_other_ip) is True)

print(f"\n----------------------------------------")
print(f"PASS: {passed}")
print(f"FAIL: {failed}")
print(f"----------------------------------------\n")
if failed > 0:
    sys.exit(1)

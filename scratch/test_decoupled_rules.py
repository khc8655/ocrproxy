import sys
from pathlib import Path
import json

root = Path(__file__).resolve().parent.parent
from unittest.mock import MagicMock
sys.modules["fastapi"] = MagicMock()
sys.modules["fastapi.responses"] = MagicMock()
sys.modules["httpx"] = MagicMock()
sys.path.insert(0, str(root / "vm-app"))

from app.proxy_routes import _apply_request_adapter_rules, _normalize_response_data
from app.admin_routes import _fetch_remote_json, _get_local_preset

# 1. Test AMD request adapter rule execution
amd_preset = _get_local_preset("amd")
assert amd_preset is not None, "Failed to load local AMD preset"
assert amd_preset["version"] == "1.1.0", f"AMD version mismatch: {amd_preset['version']}"

# Test 1: Empty reasoning_effort on AMD -> defaults to medium
req1 = {"model": "DeepSeek-V4-Flash", "messages": [{"role": "user", "content": "hi"}]}
_apply_request_adapter_rules(req1, amd_preset.get("adapter_rules", {}), is_agent_mode=True)
assert req1.get("reasoning_effort") == "medium", f"Expected reasoning_effort medium, got: {req1.get('reasoning_effort')}"

# Test 2: Qwen with reasoning_effort high -> downgraded to medium
req2 = {"model": "Qwen3.8-Flash-Next", "reasoning_effort": "high", "messages": [{"role": "user", "content": "hi"}]}
_apply_request_adapter_rules(req2, amd_preset.get("adapter_rules", {}), is_agent_mode=True)
assert req2.get("reasoning_effort") == "medium", f"Expected reasoning_effort downgraded to medium, got: {req2.get('reasoning_effort')}"

# Test 3: System message normalization (developer -> system, multiple systems merged to index 0)
req3 = {
    "model": "DeepSeek-V4-Flash",
    "messages": [
        {"role": "developer", "content": "dev rule"},
        {"role": "user", "content": "hello"},
        {"role": "system", "content": "sys rule"}
    ]
}
_apply_request_adapter_rules(req3, amd_preset.get("adapter_rules", {}), is_agent_mode=True)
assert len(req3["messages"]) == 2, f"Expected 2 messages, got {len(req3['messages'])}"
assert req3["messages"][0]["role"] == "system", f"First msg should be system"
assert "dev rule" in req3["messages"][0]["content"] and "sys rule" in req3["messages"][0]["content"]
assert req3["messages"][1]["role"] == "user"

# Test 4: MiniMax response normalization (reasoning_split -> reasoning_content)
minimax_preset = _get_local_preset("minimax")
assert minimax_preset is not None
resp_data = {
    "choices": [
        {
            "message": {
                "role": "assistant",
                "content": "Final answer",
                "reasoning_split": "Thinking steps..."
            }
        }
    ]
}
_normalize_response_data(resp_data, minimax_preset.get("adapter_rules", {}))
choice_msg = resp_data["choices"][0]["message"]
assert choice_msg.get("reasoning_content") == "Thinking steps...", f"Failed to map reasoning_split: {choice_msg}"

# Test 5: StepFun parameter injection
stepfun_preset = _get_local_preset("stepfun")
req5 = {"model": "step-3.7-flash", "messages": [{"role": "user", "content": "hi"}]}
_apply_request_adapter_rules(req5, stepfun_preset.get("adapter_rules", {}), is_agent_mode=True)
assert req5.get("reasoning_format") == "deepseek-style", f"Expected reasoning_format injected: {req5}"

print("ALL 5 DECOUPLED ADAPTER RULE TESTS PASSED!")

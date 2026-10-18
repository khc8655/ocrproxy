#!/usr/bin/env python3
"""
Test Suite for OCRProxy Adapter Optimization and Zero-Copy OpenAI Passthrough.
Verifies:
1. OpenAI Pure Passthrough & Zero-Copy fast-path.
2. Non-Gemini models preserve reasoning_effort and do NOT convert thinking.
3. Gemini correctly retains thinking_matrix and schema sanitization as the only exception.
4. Tool choice object is NOT overwritten to "auto".
5. ScheduleResult raw_content zero-copy and lazy data property.
"""
import sys
import os
import json
from pathlib import Path

# Add vm-app to sys.path
root_dir = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(root_dir / "vm-app"))

from app.proxy_routes import (
    _apply_request_adapter_rules,
    _get_preset_rules,
    _normalize_response_data,
)
from app.scheduler import ScheduleResult

passed = 0
failed = 0

def check(name: str, condition: bool, details: str = ""):
    global passed, failed
    if condition:
        passed += 1
        print(f"  PASS: {name}")
    else:
        failed += 1
        print(f"  FAIL: {name} | {details}")

print("=== 1. ScheduleResult Zero-Copy & Lazy Parsing ===")
raw_json = b'{"id":"chatcmpl-123","choices":[{"message":{"content":"Hello"}}],"usage":{"total_tokens":10}}'
sr = ScheduleResult(raw_content=raw_json, routed_via="openai/primary", fallback_attempts=0)
check("raw_content stored as bytes without immediate parsing", sr.raw_content == raw_json)
check("data property lazy-parses raw_content", sr.data.get("id") == "chatcmpl-123")
check("data choices extracted correctly", sr.data["choices"][0]["message"]["content"] == "Hello")

print("\n=== 2. OpenAI Pure Passthrough ===")
openai_rules = _get_preset_rules("openai")
check("OpenAI preset strategy is openai_passthrough", openai_rules.get("reasoning", {}).get("strategy") == "openai_passthrough")
check("OpenAI tool_choice not overwritten", openai_rules.get("tools", {}).get("normalize_choice_to_string") is False)
check("OpenAI rescue_from_text disabled", openai_rules.get("tools", {}).get("rescue_from_text") is False)

body_openai = {
    "model": "gpt-4o",
    "messages": [{"role": "user", "content": "hi"}],
    "reasoning_effort": "high",
    "tool_choice": {"type": "function", "function": {"name": "test_fn"}},
    "temperature": 0.7
}
body_copy = dict(body_openai)
_apply_request_adapter_rules(body_copy, openai_rules, is_agent_mode=True)
check("OpenAI body remains 100% byte-identical", body_copy == body_openai)

print("\n=== 3. Non-Gemini Thinking Passthrough (No Conversion) ===")
# MiniMax
minimax_rules = _get_preset_rules("minimax")
body_mm = {"model": "MiniMax-M3", "reasoning_effort": "high", "messages": [{"role": "user", "content": "hi"}]}
_apply_request_adapter_rules(body_mm, minimax_rules, is_agent_mode=True)
check("MiniMax does not convert reasoning_effort to adaptive thinking", body_mm.get("reasoning_effort") == "high")
check("MiniMax does not inject thinking object", "thinking" not in body_mm)
check("MiniMax does not inject reasoning_split", "reasoning_split" not in body_mm)

# StepFun
stepfun_rules = _get_preset_rules("stepfun")
body_sf = {"model": "step-3.7-flash", "reasoning_effort": "medium", "messages": [{"role": "user", "content": "hi"}]}
_apply_request_adapter_rules(body_sf, stepfun_rules, is_agent_mode=True)
check("StepFun preserves reasoning_effort='medium'", body_sf.get("reasoning_effort") == "medium")
check("StepFun does not inject reasoning_format", "reasoning_format" not in body_sf)

# AMD Radeon Cloud
amd_rules = _get_preset_rules("amd")
body_amd = {"model": "Qwen3.8-Flash-Next", "reasoning_effort": "high", "messages": [{"role": "user", "content": "hi"}]}
_apply_request_adapter_rules(body_amd, amd_rules, is_agent_mode=True)
check("AMD does not downgrade Qwen thinking to medium", body_amd.get("reasoning_effort") == "high")

# B.AI
bai_rules = _get_preset_rules("bai")
body_bai = {"model": "glm-5.3-flash", "reasoning_effort": "medium", "messages": [{"role": "user", "content": "hi"}]}
_apply_request_adapter_rules(body_bai, bai_rules, is_agent_mode=True)
check("B.AI does not force GLM medium to high", body_bai.get("reasoning_effort") == "medium")

# Agnes AI
agnes_rules = _get_preset_rules("agnes")
body_agnes = {"model": "agnes-3.0-flash", "reasoning_effort": "low", "messages": [{"role": "user", "content": "hi"}]}
_apply_request_adapter_rules(body_agnes, agnes_rules, is_agent_mode=True)
check("Agnes does not inject chat_template_kwargs.enable_thinking", "chat_template_kwargs" not in body_agnes)

print("\n=== 4. Gemini Retained Exception (Thinking Matrix & Schema Cleaning) ===")
google_rules = _get_preset_rules("google")
body_gemini = {
    "model": "gemini-3.5-flash",
    "reasoning_effort": "high",
    "messages": [{"role": "user", "content": "hi"}],
    "tools": [{
        "type": "function",
        "function": {
            "name": "lookup",
            "parameters": {
                "$schema": "http://json-schema.org/draft-07/schema#",
                "type": "object",
                "properties": {"query": {"type": "string"}},
                "additionalProperties": False,
                "required": ["query"]
            }
        }
    }]
}
_apply_request_adapter_rules(body_gemini, google_rules, is_agent_mode=True)
check("Gemini reasoning_effort converted to extra_body.google.thinking_config",
      body_gemini.get("extra_body", {}).get("google", {}).get("thinking_config", {}).get("thinking_level") == "high")
check("Gemini reasoning_effort field popped from root", "reasoning_effort" not in body_gemini)
fn_params = body_gemini["tools"][0]["function"]["parameters"]
check("Gemini strips $schema from tool function", "$schema" not in fn_params)
check("Gemini strips additionalProperties from tool function", "additionalProperties" not in fn_params)

print("\n=== 5. Tool Choice Object Preservation ===")
for p_id in ("deepseek", "siliconflow", "sensenova", "tokenrhythm", "cline"):
    p_rules = _get_preset_rules(p_id)
    b_tool = {
        "model": "test-model",
        "tool_choice": {"type": "function", "function": {"name": "target_fn"}},
        "messages": [{"role": "user", "content": "hi"}]
    }
    _apply_request_adapter_rules(b_tool, p_rules, is_agent_mode=True)
    check(f"{p_id} preserves structured tool_choice object", isinstance(b_tool.get("tool_choice"), dict))

print(f"\n----------------------------------------")
print(f"Summary: {passed} PASSED, {failed} FAILED")
print(f"----------------------------------------")
if failed > 0:
    sys.exit(1)

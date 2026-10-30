#!/usr/bin/env python3
"""Cline 适配厂商回归：非流式 {"data": {...}} 信封解包 + preset 声明。"""
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "vm-app"))

from app import presets, scheduler  # noqa: E402


def test_cline_preset_declares_unwrap():
    preset = presets.load_preset("cline")
    assert preset.get("id") == "cline"
    rules = preset.get("adapter_rules") or {}
    assert rules.get("response", {}).get("unwrap_root") == "data", rules
    print("PASS cline preset: response.unwrap_root=data")


def test_cline_nonstream_envelope_unwrapped():
    rules = presets.load_preset("cline").get("adapter_rules") or {}
    raw = json.dumps({
        "data": {
            "id": "chatcmpl-test",
            "object": "chat.completion",
            "choices": [{"index": 0, "message": {"role": "assistant", "content": "OK"}}],
        },
        "success": True,
    }).encode()
    out = scheduler._unwrap_response_payload(raw, rules)
    parsed = json.loads(out.decode())
    assert parsed.get("object") == "chat.completion"
    assert parsed["choices"][0]["message"]["content"] == "OK"
    assert "data" not in parsed
    print("PASS cline nonstream envelope unwrapped")


def test_standard_openai_payload_unchanged():
    rules = presets.load_preset("cline").get("adapter_rules") or {}
    raw = json.dumps({"choices": [{"message": {"content": "OK"}}]}).encode()
    assert scheduler._unwrap_response_payload(raw, rules) == raw
    print("PASS standard OpenAI payload unchanged")


if __name__ == "__main__":
    test_cline_preset_declares_unwrap()
    test_cline_nonstream_envelope_unwrapped()
    test_standard_openai_payload_unchanged()
    print("ALL CLINE ADAPTER CHECKS PASSED")

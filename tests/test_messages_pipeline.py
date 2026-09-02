#!/usr/bin/env python3
"""
Test Suite: Anthropic Messages API (/v1/messages) Pipeline & Normalisation
Tests:
  1. build_messages_upstream URL construction (B.AI, MiniMax domestic & overseas, custom anthropic_base_url)
  2. MiniMax parameter normalisation (_normalise_messages_for_provider & _normalise_for_provider)
  3. Thinking budget & output_config sanitization
  4. Model casing preservation (MiniMax-M3)
  5. Presets validation (minimax.json and bai.json)
"""

import sys
import json
from unittest.mock import MagicMock
from pathlib import Path

# Setup mocks for dependencies not installed globally
for mod in ["httpx", "fastapi.responses", "fastapi.routing", "fastapi.staticfiles", "cryptography", "cryptography.fernet"]:
    if mod not in sys.modules:
        m = MagicMock()
        m.__path__ = []
        sys.modules[mod] = m

if "fastapi" not in sys.modules:
    fastapi_mock = MagicMock()
    fastapi_mock.__path__ = []
    fastapi_mock.FastAPI = MagicMock
    fastapi_mock.Request = MagicMock
    fastapi_mock.APIRouter = MagicMock
    sys.modules["fastapi"] = fastapi_mock

# Add vm-app to sys.path
root_dir = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(root_dir / "vm-app"))

from app.upstream import join_upstream, build_messages_upstream
from app.proxy_routes import (
    _normalise_for_provider,
    _normalise_messages_for_provider,
)

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

print("\n== Upstream URL Construction: build_messages_upstream ==")
test(
    "B.AI standard /v1 messages URL",
    build_messages_upstream("https://api.b.ai/v1", provider="bai") == "https://api.b.ai/v1/messages"
)
test(
    "B.AI trailing slash /v1/ messages URL",
    build_messages_upstream("https://api.b.ai/v1/", provider="bai") == "https://api.b.ai/v1/messages"
)
test(
    "MiniMax domestic default (api.minimaxi.com) -> api.minimax.cn/anthropic/v1/messages",
    build_messages_upstream("https://api.minimaxi.com/v1", provider="minimax") == "https://api.minimax.cn/anthropic/v1/messages"
)
test(
    "MiniMax overseas (api.minimax.io) -> api.minimax.io/anthropic/v1/messages",
    build_messages_upstream("https://api.minimax.io/v1", provider="minimax") == "https://api.minimax.io/anthropic/v1/messages"
)
test(
    "MiniMax with explicit anthropic_base_url (https://api.minimax.cn/anthropic)",
    build_messages_upstream("https://api.minimaxi.com/v1", anthropic_base_url="https://api.minimax.cn/anthropic", provider="minimax") == "https://api.minimax.cn/anthropic/v1/messages"
)
test(
    "MiniMax with full messages URL in anthropic_base_url",
    build_messages_upstream("https://api.minimaxi.com/v1", anthropic_base_url="https://api.minimax.cn/anthropic/v1/messages", provider="minimax") == "https://api.minimax.cn/anthropic/v1/messages"
)

print("\n== MiniMax Messages Parameter Normalisation ==")
# 1. Claude 3.7 non-standard output_config stripping
body_output_cfg = {
    "model": "MiniMax-M3",
    "output_config": {"effort": "medium"},
    "messages": [{"role": "user", "content": "Hi"}]
}
_normalise_messages_for_provider(body_output_cfg, "minimax")
test(
    "MiniMax messages: strip Claude output_config",
    "output_config" not in body_output_cfg
)

# 2. Case sensitivity: lowercase minimax-m3 preserved as MiniMax-M3
body_case = {
    "model": "minimax-m3",
    "messages": [{"role": "user", "content": "Hi"}]
}
_normalise_messages_for_provider(body_case, "minimax")
test(
    "MiniMax messages: model casing minimax-m3 -> MiniMax-M3",
    body_case["model"] == "MiniMax-M3"
)

# 3. Thinking budget normalization
body_thinking = {
    "model": "MiniMax-M3",
    "thinking": {"budget_tokens": 4096},
    "messages": [{"role": "user", "content": "Hi"}]
}
_normalise_messages_for_provider(body_thinking, "minimax")
test(
    "MiniMax messages: thinking budget gets type='enabled'",
    body_thinking["thinking"].get("type") == "enabled" and body_thinking["thinking"].get("budget_tokens") == 4096
)

# 4. Adaptive thinking preserved
body_adaptive = {
    "model": "MiniMax-M3",
    "thinking": {"type": "adaptive"},
    "messages": [{"role": "user", "content": "Hi"}]
}
_normalise_messages_for_provider(body_adaptive, "minimax")
test(
    "MiniMax messages: adaptive thinking preserved",
    body_adaptive["thinking"].get("type") == "adaptive"
)

print("\n== MiniMax Chat Completions (OpenAI route) Parameter Normalisation ==")
body_openai = {
    "model": "minimax-m3",
    "output_config": {"effort": "low"},
    "messages": [{"role": "user", "content": "Hi"}]
}
_normalise_for_provider(body_openai, "minimax")
test(
    "MiniMax completions: model casing minimax-m3 -> MiniMax-M3",
    body_openai["model"] == "MiniMax-M3"
)
test(
    "MiniMax completions: strip output_config",
    "output_config" not in body_openai
)

print("\n== Presets Verification: minimax.json and bai.json ==")
minimax_preset_path = root_dir / "shared" / "presets" / "minimax.json"
test("minimax.json preset exists", minimax_preset_path.exists())
with open(minimax_preset_path, "r", encoding="utf-8") as f:
    mm_data = json.load(f)
test("minimax.json id is minimax", mm_data.get("id") == "minimax")
test("minimax.json has domestic base_url", mm_data.get("base_url") == "https://api.minimaxi.com/v1")
test("minimax.json has domestic anthropic_base_url", mm_data.get("anthropic_base_url") == "https://api.minimax.cn/anthropic")
test("minimax.json recommends MiniMax-M3", any(m.get("name") == "MiniMax-M3" for m in mm_data.get("recommended_models", [])))

bai_preset_path = root_dir / "shared" / "presets" / "bai.json"
test("bai.json preset exists", bai_preset_path.exists())
with open(bai_preset_path, "r", encoding="utf-8") as f:
    bai_data = json.load(f)
test("bai.json id is bai", bai_data.get("id") == "bai")
test("bai.json has base_url", bai_data.get("base_url") == "https://api.b.ai/v1")
test("bai.json has anthropic_base_url", bai_data.get("anthropic_base_url") == "https://api.b.ai/v1")

print("\n" + "-" * 40)
print(f"PASS: {passed}")
print(f"FAIL: {failed}")
print("-" * 40 + "\n")

if failed > 0:
    sys.exit(1)

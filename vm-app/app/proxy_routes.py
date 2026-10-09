"""
Proxy API routes: /v1/chat/completions, /v1/embeddings, /v1/rerank, /v1/ocr, /v1/models, /v1/reload

Two routing modes:
  1. KB ingestion mode (virtual alias): model="chat"/"embedding"/"reranker"/"ocr"
     - Uses all candidates of that type in configured order
     - Disables thinking/reasoning by default (chat)
     - Always fast: non-stream + short timeout (batch processing, hard-coded)

  2. Agent mode (real model name): model="<actual model name from config>"
     - Filters candidates to those matching the requested model name
     - Mostly transparent: passes through all request parameters untouched,
       with minimal provider-specific normalisation (see _normalise_for_provider)
     - Failover on 429/500 to other providers with the same model
     - Standard OpenAI-compatible interface

Chat relay optimisations:
  - Deep-copy request body to prevent cross-request mutation in concurrent scenarios.
  - Forward upstream error status + body to the client (instead of generic 503) so
    that agent frameworks receive meaningful error messages.
  - Near-full transparency: tools, tool_choice, reasoning_effort, reasoning_content,
    response_format, stream_options, and all other OpenAI-compatible fields are
    passed through.  Provider-specific normalisations are minimal and only applied
    when a field value would be **rejected** by the target upstream (e.g.
    reasoning_effort="none" → "low" for StepFun, tool_choice object → "auto" for
    TokenRhythm).  Streaming responses are forwarded as raw bytes so that
    provider-specific SSE fields (e.g. reasoning_content deltas from
    SenseNova / DeepSeek) reach the client verbatim.
"""
from typing import Optional, Callable, Any, Dict, List
import os
import re
import copy
import json
import asyncio
import logging
import urllib.parse
import secrets
import string
import time
from pathlib import Path
import httpx
from fastapi import APIRouter, Request
from fastapi.responses import StreamingResponse, JSONResponse, Response

from .config_store import get_config, clear_cache
from .scheduler import (
    schedule,
    AllCandidatesFailedError,
    GlobalOverloadError,
    reset_runtime_state,
    _reclaim_memory,
    StreamInterruptedError,
)

def _resolve_dynamic_placeholder(val: str) -> str:
    """Resolve dynamic placeholders in header values or strings (e.g. ${random_session_id}, ${timestamp}, ${uuid})."""
    if not isinstance(val, str) or "${" not in val:
        return val
    if "${random_session_id}" in val:
        hex_part = secrets.token_hex(6)
        b62_chars = string.ascii_letters + string.digits
        b62_part = "".join(secrets.choice(b62_chars) for _ in range(14))
        val = val.replace("${random_session_id}", f"ses_{hex_part}{b62_part}")
    if "${timestamp}" in val:
        val = val.replace("${timestamp}", str(int(time.time())))
    if "${uuid}" in val:
        import uuid
        val = val.replace("${uuid}", str(uuid.uuid4()))
    return val


def _aggregate_sse_to_chat_completion(sse_bytes: bytes, model_name: str = "") -> dict:
    """Aggregate raw SSE chunk bytes into a standard OpenAI ChatCompletion response dict."""
    text = sse_bytes.decode("utf-8", errors="replace")
    content_chunks = []
    reasoning_chunks = []
    finish_reason = "stop"
    response_id = ""
    created = int(time.time())
    model = model_name or "chat-completion"
    system_fingerprint = None
    usage = None

    for line in text.splitlines():
        line = line.strip()
        if not line or not line.startswith("data:"):
            continue
        payload = line[5:].strip()
        if payload == "[DONE]":
            break
        try:
            chunk = json.loads(payload)
            if not response_id and chunk.get("id"):
                response_id = chunk["id"]
            if chunk.get("model"):
                model = chunk["model"]
            if chunk.get("created"):
                created = chunk["created"]
            if chunk.get("system_fingerprint"):
                system_fingerprint = chunk["system_fingerprint"]
            if chunk.get("usage"):
                usage = chunk["usage"]

            choices = chunk.get("choices")
            if choices and isinstance(choices, list):
                c0 = choices[0]
                delta = c0.get("delta") or {}
                if delta.get("content"):
                    content_chunks.append(delta["content"])
                if delta.get("reasoning_content"):
                    reasoning_chunks.append(delta["reasoning_content"])
                elif delta.get("reasoning"):
                    reasoning_chunks.append(delta["reasoning"])
                if c0.get("finish_reason"):
                    finish_reason = c0["finish_reason"]
        except Exception:
            continue

    full_content = "".join(content_chunks)
    full_reasoning = "".join(reasoning_chunks)

    message = {
        "role": "assistant",
        "content": full_content,
    }
    if full_reasoning:
        message["reasoning_content"] = full_reasoning

    result = {
        "id": response_id or f"chatcmpl-free-{secrets.token_hex(8)}",
        "object": "chat.completion",
        "created": created,
        "model": model,
        "choices": [
            {
                "index": 0,
                "message": message,
                "finish_reason": finish_reason or "stop",
            }
        ],
    }
    if system_fingerprint:
        result["system_fingerprint"] = system_fingerprint
    if usage:
        result["usage"] = usage
    else:
        comp_tokens = max(1, len(full_content) // 3)
        result["usage"] = {
            "prompt_tokens": 0,
            "completion_tokens": comp_tokens,
            "total_tokens": comp_tokens,
        }
    return result
from .auth import verify_proxy_auth
from .upstream import join_upstream, build_messages_upstream

router = APIRouter(prefix="/v1")
logger = logging.getLogger("proxy_routes")

# Virtual model aliases used for KB ingestion mode.
# When a client sends one of these as the model name, the proxy uses ALL
# candidates of the corresponding type and applies KB-specific settings
# (e.g. disable thinking).  Any other model name triggers agent mode.
VIRTUAL_ALIASES = {"chat", "embedding", "reranker", "ocr"}

# ── Provider-specific parameter normalisation ────────────────────────
# Agent tools (OpenClaw, Hermes, etc.) send standard OpenAI-compatible
# parameters.  Some upstream providers reject certain values or formats.
# These helpers normalise **only** the values that would cause a 400 error
# — everything else passes through untouched so agent semantics are
# preserved across providers.
#
# Documented incompatibilities (from upstream API docs):
#
# 1. reasoning_effort:
#    - SenseNova / DeepSeek: accepts low/medium/high/none
#    - StepFun: accepts low/medium/high — "none" causes 400
#    - Agnes: does not use reasoning_effort (ignored, not rejected)
#    - TokenRhythm: OpenAI-compatible passthrough
#
# 2. tool_choice:
#    - Standard OpenAI: "auto"/"none"/"required" or {type:"function",...}
#    - TokenRhythm: explicitly rejects object form, only accepts
#      "none"/"auto"/"required"
#
# 3. reasoning_format (StepFun-specific):
#    - Default "general" returns reasoning in a `reasoning` field
#    - "deepseek-style" returns reasoning in `reasoning_content` (DeepSeek-compatible)
#    - Age# ── Declarative Provider Rule Engine ────────────────────────────────
_PRESET_CACHE: dict = {}


def _get_presets_dir() -> Path:
    """Resolve shared/presets directory in both prod (/opt/ocrproxy) and dev repo environments."""
    p = Path(__file__).resolve().parent.parent / "shared" / "presets"
    if p.exists():
        return p
    return Path(__file__).resolve().parent.parent.parent / "shared" / "presets"


def _get_preset(provider_id: str) -> dict:
    """Load provider preset definition from shared/presets/ directory."""
    pid = str(provider_id or "").lower().strip()
    if not pid:
        return {}
    if pid in _PRESET_CACHE:
        return _PRESET_CACHE[pid]
    try:
        presets_dir = _get_presets_dir()
        preset_file = presets_dir / f"{pid}.json"
        if preset_file.exists():
            data = json.loads(preset_file.read_text(encoding="utf-8"))
            _PRESET_CACHE[pid] = data
            return data
        # Fallback: try stripping dots, hyphens, and underscores (e.g. "b.ai" -> "bai")
        pid_clean = re.sub(r"[.\-_]", "", pid)
        if pid_clean and pid_clean != pid:
            clean_file = presets_dir / f"{pid_clean}.json"
            if clean_file.exists():
                data = json.loads(clean_file.read_text(encoding="utf-8"))
                _PRESET_CACHE[pid] = data
                return data
    except Exception as e:
        logger.warning("Failed to load preset %s: %s", pid, e)
    return {}


def _get_preset_rules(provider_id: str) -> dict:
    """Return adapter_rules dictionary for a given provider or preset ID."""
    return _get_preset(provider_id).get("adapter_rules", {})


def _sanitize_gemini_schema(schema):
    """Recursively strip $schema, additionalProperties, $defs, $ref and validate required properties."""
    if not isinstance(schema, dict):
        if isinstance(schema, list):
            return [_sanitize_gemini_schema(x) for x in schema]
        return schema
    clean = copy.deepcopy(schema)
    clean.pop("$schema", None)
    clean.pop("additionalProperties", None)
    clean.pop("$defs", None)
    clean.pop("$ref", None)

    if "properties" in clean and isinstance(clean["properties"], dict):
        clean["properties"] = {
            k: _sanitize_gemini_schema(v) for k, v in clean["properties"].items()
        }
        if "required" in clean and isinstance(clean["required"], list):
            clean["required"] = [r for r in clean["required"] if r in clean["properties"]]
            if not clean["required"]:
                clean.pop("required", None)
    elif "required" in clean and not ("properties" in clean and clean["properties"]):
        clean.pop("required", None)

    if "items" in clean:
        clean["items"] = _sanitize_gemini_schema(clean["items"])

    for union_key in ("anyOf", "allOf", "oneOf"):
        if union_key in clean and isinstance(clean[union_key], list):
            clean[union_key] = [_sanitize_gemini_schema(x) for x in clean[union_key]]

    return clean


def _clone_request_payload(body: dict) -> dict:
    """Isolate mutable payload fields across candidate failovers with targeted Copy-on-Write."""
    out = dict(body)
    if "messages" in body and isinstance(body["messages"], list):
        out["messages"] = copy.deepcopy(body["messages"])
    if "tools" in body and isinstance(body["tools"], list):
        out["tools"] = copy.deepcopy(body["tools"])
    if "extra_body" in body and isinstance(body["extra_body"], dict):
        out["extra_body"] = copy.deepcopy(body["extra_body"])
    return out


_EFFORT_ORDER = ["minimal", "low", "medium", "high"]
_GEMINI25_BUDGET = {"minimal": 1024, "low": 1024, "medium": 8192, "high": 24576}


def _deep_merge_params(out: dict, params: dict) -> None:
    """Merge injected params one level deep (dict values are merged, others replaced)."""
    for k, v in params.items():
        if isinstance(v, dict) and isinstance(out.get(k), dict):
            merged = dict(out[k])
            merged.update(v)
            out[k] = merged
        else:
            out[k] = copy.deepcopy(v) if isinstance(v, (dict, list)) else v


def _strip_param(out: dict, path: str) -> None:
    """Remove a top-level key, or a nested one with a dotted path ("output_config.format")."""
    if "." not in path:
        out.pop(path, None)
        return
    head, rest = path.split(".", 1)
    sub = out.get(head)
    if isinstance(sub, dict) and rest.split(".", 1)[0] in sub:
        sub = dict(sub)
        _strip_param(sub, rest)
        if sub:
            out[head] = sub
        else:
            out.pop(head, None)


def _strip_needed(body: dict, rules: dict) -> bool:
    for sp in (rules.get("sanitization", {}) or {}).get("strip_params", []) or []:
        cur = body
        for part in str(sp).split("."):
            if not isinstance(cur, dict) or part not in cur:
                break
            cur = cur[part]
        else:
            return True
    return False


def _effort_rewrite_needed(body: dict, rules: dict) -> bool:
    """True when the declarative effort rules would change this request body
    (used to keep the zero-copy fast-path for everything else)."""
    rr = rules.get("reasoning") if isinstance(rules, dict) else None
    if not isinstance(rr, dict):
        return False
    effort = body.get("reasoning_effort")
    if effort is None:
        return False
    e = str(effort).lower()
    emap = rr.get("effort_map") or {}
    if e in emap:
        return True
    return bool(rr.get("effort_to_params"))


def _apply_effort_rules(out: dict, rr: dict, is_agent_mode: bool) -> None:
    """OpenAI-compatible providers.

    Agent mode: reasoning_effort is passed through, except where the preset
      declares `effort_map` (value -> replacement, null = drop the field) or
      `effort_to_params` (value or "*" -> params to inject; the provider's own
      thinking switch, e.g. chat_template_kwargs.enable_thinking).
    KB mode: `kb_mode` "none" (default) sends reasoning_effort="none"; "omit"
      removes it (provider rejects "none" / cannot turn thinking off).
      `kb_params`, when present, are merged in as well (the provider's own
      thinking switch).
    """
    if not is_agent_mode:
        if rr.get("kb_mode", "none") == "omit":
            out.pop("reasoning_effort", None)
        else:
            out["reasoning_effort"] = "none"
        if isinstance(rr.get("kb_params"), dict):
            _deep_merge_params(out, rr["kb_params"])
        return

    effort = out.get("reasoning_effort")
    if effort is None:
        return
    e = str(effort).lower()
    emap = rr.get("effort_map") or {}
    if e in emap:
        repl = emap[e]
        if repl is None:
            out.pop("reasoning_effort", None)
        else:
            out["reasoning_effort"] = repl
            e = str(repl).lower()
    e2p = rr.get("effort_to_params") or {}
    if e2p:
        params = e2p.get(e, e2p.get("*"))
        if isinstance(params, dict):
            _deep_merge_params(out, params)
        if rr.get("drop_effort_after_params", True):
            out.pop("reasoning_effort", None)


def _apply_gemini_thinking(out: dict, rr: dict, m_name: str, is_agent_mode: bool) -> None:
    """Gemini (AI Studio / Vertex OpenAI-compatible endpoints).

    reasoning_effort -> extra_body.google.thinking_config (Google forbids sending
    both).  Gemini 3.x takes thinking_level from the preset's model_matrix;
    Gemini 2.5 takes thinking_budget (Google's documented 1K/8K/24K mapping).
    reasoning_effort="none" uses the lowest setting the model allows: 2.5
    Flash can turn thinking off (budget 0); 2.5 Pro and 3.x cannot, so they
    get the lowest budget/level and hide thoughts.

    Gemini is only used in Agent mode (KB mode never routes to Gemini), so
    there is no KB-specific branch: the client's reasoning_effort decides.
    """
    if m_name.startswith("gemma") or m_name.startswith("google/gemma"):
        return
    name = m_name.split("/", 1)[-1]
    is_25 = name.startswith("gemini-2.5-")
    is_pro = "pro" in name
    matrix = rr.get("model_matrix") or {}
    levels = [l for l in (matrix.get("pro") if is_pro else matrix.get("flash")) or [] if l in _EFFORT_ORDER]
    if not levels:
        levels = ["low", "high"] if is_pro else ["minimal", "low", "medium", "high"]
    levels.sort(key=_EFFORT_ORDER.index)

    effort = out.pop("reasoning_effort", None)
    if effort is None:
        cfg = (out.get("extra_body") or {}).get("google", {}).get("thinking_config", {})
        thinking_on = bool(cfg) and cfg.get("include_thoughts") is not False
        _gemini_headroom(out, rr, thinking_on)
        return

    e = str(effort).lower()
    if e in ("xhigh", "max"):
        e = "high"

    if e in ("none", "false", "off"):
        if is_25:
            tc = {"include_thoughts": False, "thinking_budget": 128 if is_pro else 0}
        else:
            tc = {"include_thoughts": False, "thinking_level": levels[0]}
        thinking_on = False
    else:
        if e not in _EFFORT_ORDER:
            e = "medium"
        if is_25:
            tc = {"include_thoughts": True, "thinking_budget": _GEMINI25_BUDGET[e]}
        else:
            req = _EFFORT_ORDER.index(e)
            lvl = levels[0]
            for l in levels:
                if _EFFORT_ORDER.index(l) <= req:
                    lvl = l
            tc = {"include_thoughts": True, "thinking_level": lvl}
        thinking_on = True

    extra = out.get("extra_body")
    extra = dict(extra) if isinstance(extra, dict) else {}
    google = dict(extra.get("google") or {})
    google["thinking_config"] = tc
    extra["google"] = google
    out["extra_body"] = extra
    _gemini_headroom(out, rr, thinking_on)


def _gemini_headroom(out: dict, rr: dict, thinking_on: bool) -> None:
    if thinking_on and rr.get("headroom_elevation", True):
        for f in ("max_tokens", "max_completion_tokens"):
            if isinstance(out.get(f), int) and out[f] < 16384:
                out[f] = 65535


def _apply_request_adapter_rules(out: dict, rules: dict, is_agent_mode: bool, is_anthropic: bool = False) -> None:
    """Pure declarative rule executor for all upstream providers.
    Mutates `out` in place according to provider adapter_rules schema.
    """
    if not rules or not isinstance(rules, dict):
        return

    # 1a. Model alias mapping (e.g. cline-free/... -> meta/..., gemini-3.8-flash -> google/gemini-3.8-flash)
    alias_map = rules.get("model_alias", {})
    if isinstance(alias_map, dict) and alias_map:
        raw_m = str(out.get("model", ""))
        if raw_m in alias_map:
            out["model"] = alias_map[raw_m]
        elif raw_m.lower() in alias_map:
            out["model"] = alias_map[raw_m.lower()]

    # 1b. Ensure Google Prefix (for Vertex AI)
    if rules.get("ensure_google_prefix") and out.get("model"):
        m_str = str(out["model"])
        if not m_str.startswith("google/"):
            out["model"] = f"google/{m_str}"

    m_name = str(out.get("model", "")).lower()

    # 1c. Model casing mapping
    casing_map = rules.get("case_sensitive_models", {})
    if isinstance(casing_map, dict):
        for k, v in casing_map.items():
            if m_name == k.lower():
                out["model"] = v
                break

    # 2. Sanitization (parameter blacklisting and clamping)
    strip_params = rules.get("sanitization", {}).get("strip_params", [])
    for sp in strip_params:
        _strip_param(out, sp)
    max_tokens_ceil = rules.get("sanitization", {}).get("max_tokens_ceiling")
    if isinstance(max_tokens_ceil, int) and max_tokens_ceil > 0:
        if isinstance(out.get("max_tokens"), int) and out["max_tokens"] > max_tokens_ceil:
            out["max_tokens"] = max_tokens_ceil
        if isinstance(out.get("max_completion_tokens"), int) and out["max_completion_tokens"] > max_tokens_ceil:
            out["max_completion_tokens"] = max_tokens_ceil

    # 3. Messages normalization
    msg_rules = rules.get("messages", {})
    if msg_rules and isinstance(msg_rules, dict):
        messages = out.get("messages")
        if isinstance(messages, list) and messages:
            deny_dev = bool(msg_rules.get("deny_developer_role"))
            sys_first = bool(msg_rules.get("system_first_only"))
            merge_sys = bool(msg_rules.get("merge_system"))
            strip_empty = bool(msg_rules.get("strip_empty"))

            if sys_first or merge_sys or deny_dev or strip_empty:
                system_parts = []
                other_messages = []
                for m in messages:
                    if not isinstance(m, dict):
                        continue
                    role = m.get("role")
                    if role == "developer" and deny_dev:
                        role = "system"

                    content = m.get("content")
                    if strip_empty and (content is None or content == "" or content == []):
                        continue

                    if role == "system" and (sys_first or merge_sys):
                        if isinstance(content, str) and content.strip():
                            system_parts.append(content.strip())
                        elif isinstance(content, list):
                            for part in content:
                                if isinstance(part, dict) and part.get("type") == "text":
                                    t = str(part.get("text", "")).strip()
                                    if t:
                                        system_parts.append(t)
                                elif isinstance(part, str) and part.strip():
                                    system_parts.append(part.strip())
                    else:
                        m_copy = dict(m)
                        if role != m.get("role"):
                            m_copy["role"] = role
                        other_messages.append(m_copy)

                if sys_first or merge_sys:
                    new_messages = []
                    if system_parts:
                        new_messages.append({
                            "role": "system",
                            "content": "\n\n".join(system_parts)
                        })
                    new_messages.extend(other_messages)
                    out["messages"] = new_messages

    # 3b. Thinking protocol & reasoning block filtering on messages
    # Supports "passback_required", "strict_signature", "strip"
    thinking_policy = rules.get("thinking_policy") or rules.get("reasoning", {}).get("thinking_policy")
    if not thinking_policy and is_anthropic:
        id_lower = m_name.lower()
        if any(id_lower.startswith(p) for p in ("claude-", "opus-", "sonnet-", "haiku-")):
            thinking_policy = "strict_signature"
        elif any(id_lower.startswith(p) for p in ("deepseek-", "kimi-", "moonshot-", "glm-", "minimax-")) or "-thinking" in id_lower or id_lower in ("k3", "k3-256k"):
            thinking_policy = "passback_required"

    if thinking_policy and "messages" in out and isinstance(out["messages"], list):
        new_msgs = []
        for m in out["messages"]:
            if not isinstance(m, dict) or m.get("role") != "assistant":
                new_msgs.append(m)
                continue
            m_copy = dict(m)
            content = m_copy.get("content")
            if isinstance(content, list):
                new_content = []
                for b in content:
                    if isinstance(b, dict) and b.get("type") == "thinking":
                        if thinking_policy == "strip":
                            continue
                        elif thinking_policy == "strict_signature" and not b.get("signature"):
                            continue
                    new_content.append(b)
                m_copy["content"] = new_content
            if thinking_policy == "strip":
                m_copy.pop("reasoning_content", None)
                m_copy.pop("reasoning", None)
            new_msgs.append(m_copy)
        out["messages"] = new_msgs

    # 4. Tools schema normalization
    tools_rules = rules.get("tools", {})
    if tools_rules and isinstance(tools_rules, dict):
        if tools_rules.get("normalize_choice_to_string"):
            tc = out.get("tool_choice")
            if isinstance(tc, dict):
                out["tool_choice"] = "auto"

        if tools_rules.get("deep_schema_sanitization"):
            tools = out.get("tools")
            if isinstance(tools, list):
                cleaned_tools = []
                for t in tools:
                    if isinstance(t, dict) and t.get("type") == "function" and "function" in t:
                        fn = copy.deepcopy(t["function"])
                        if "parameters" in fn:
                            fn["parameters"] = _sanitize_gemini_schema(fn["parameters"])
                        t_clean = copy.deepcopy(t)
                        t_clean["function"] = fn
                        cleaned_tools.append(t_clean)
                    else:
                        cleaned_tools.append(t)
                out["tools"] = cleaned_tools

    # 5. Parameter injection
    inject_params = rules.get("inject_params") or rules.get("reasoning", {}).get("inject_params", {})
    if isinstance(inject_params, dict):
        for ik, iv in inject_params.items():
            if ik not in out:
                out[ik] = iv

    # 6. Reasoning control (declarative, driven by preset `reasoning` rules)
    reasoning_rules = rules.get("reasoning", {})
    if reasoning_rules and isinstance(reasoning_rules, dict) and not is_anthropic:
        strat = reasoning_rules.get("strategy", "openai_passthrough")
        if strat == "gemini_thinking_matrix":
            _apply_gemini_thinking(out, reasoning_rules, m_name, is_agent_mode)
        else:
            _apply_effort_rules(out, reasoning_rules, is_agent_mode)

    # 7. Anthropic Messages endpoint specific rules
    if is_anthropic:
        mt = out.get("max_tokens")
        if not isinstance(mt, int) or mt <= 0:
            out["max_tokens"] = 4096

    # 8. Declarative Stream Enforcement (if upstream strictly requires streaming)
    if rules.get("stream_only"):
        out["stream"] = True



def _normalize_response_data(data: dict, rules: dict) -> None:
    """Normalize response JSON (non-streaming) based on declarative response rules."""
    if not isinstance(data, dict):
        return
    resp_rules = rules.get("response", {}) if isinstance(rules, dict) else {}
    if not resp_rules:
        return
    reasoning_fields = resp_rules.get("reasoning_fields")
    if not reasoning_fields or not isinstance(reasoning_fields, list):
        return

    choices = data.get("choices")
    if isinstance(choices, list):
        for ch in choices:
            if not isinstance(ch, dict):
                continue
            msg = ch.get("message")
            if isinstance(msg, dict):
                if not msg.get("reasoning_content"):
                    for rf in reasoning_fields:
                        if rf in msg and msg[rf]:
                            msg["reasoning_content"] = msg[rf]
                            break

    usage = data.get("usage")
    if isinstance(usage, dict):
        if "reasoning_tokens" not in usage:
            details = usage.get("completion_tokens_details")
            if isinstance(details, dict) and "reasoning_tokens" in details:
                usage["reasoning_tokens"] = details["reasoning_tokens"]


# ── Backwards-compatibility wrapper stubs ────────────────────────────
def _sanitize_amd_messages(out: dict) -> None:
    _apply_request_adapter_rules(out, {"messages": {"deny_developer_role": True, "system_first_only": True, "merge_system": True}}, is_agent_mode=True)


def _normalise_for_provider(out: dict, provider: str) -> None:
    rules = _get_preset_rules(provider)
    _apply_request_adapter_rules(out, rules, is_agent_mode=True, is_anthropic=False)


def _normalise_messages_for_provider(out: dict, provider: str) -> None:
    rules = _get_preset_rules(provider)
    _apply_request_adapter_rules(out, rules, is_agent_mode=True, is_anthropic=True)


def _disable_thinking_for_kb(out: dict, provider: str) -> None:
    rules = _get_preset_rules(provider)
    _apply_request_adapter_rules(out, rules, is_agent_mode=False, is_anthropic=False)


def _is_sse_done_chunk(b: Optional[bytes]) -> bool:
    if not b:
        return False
    return b"data: [DONE]" in b or b"data:[DONE]" in b


def _normalize_tool_calls(data: Any) -> Any:
    """Defensive schema sanitizer for OpenAI function calls: ensure arguments is JSON string."""
    if not isinstance(data, dict):
        return data
    try:
        choices = data.get("choices")
        if isinstance(choices, list):
            for ch in choices:
                if not isinstance(ch, dict):
                    continue
                msg = ch.get("message") or ch.get("delta")
                if isinstance(msg, dict):
                    tcs = msg.get("tool_calls")
                    if isinstance(tcs, list):
                        for tc in tcs:
                            if isinstance(tc, dict):
                                fn = tc.get("function")
                                if isinstance(fn, dict):
                                    raw_args = fn.get("arguments")
                                    if isinstance(raw_args, (dict, list)):
                                        fn["arguments"] = json.dumps(raw_args, ensure_ascii=False)
    except Exception:
        pass
    return data


def _sse_stream_error(message: str, error_format: str = "openai") -> bytes:
    msg = f"Upstream stream interrupted: {message}"[:500]
    if error_format == "anthropic":
        payload = {"type": "error", "error": {"type": "api_error", "message": msg}}
        return b"event: error\ndata: " + json.dumps(payload, ensure_ascii=False).encode() + b"\n\n"
    payload = {"error": {"message": msg, "type": "upstream_stream_interrupted", "code": "stream_interrupted"}}
    return b"data: " + json.dumps(payload, ensure_ascii=False).encode() + b"\n\n"


async def _stream_with_keepalive(
    first_chunk: bytes,
    remainder,
    filter_fn: Optional[Callable[[bytes], bytes]] = None,
    keepalive_sec: float = 15.0,
    error_format: str = "openai",
):
    """Yield chunks from a streaming response, emitting SSE keep-alive comments
    (': keep-alive\n\n') every `keepalive_sec` if upstream is idle (e.g. during deep thinking).
    Uses asyncio.wait on the pending task so timeouts do NOT cancel the generator.
    Actively terminates and releases upstream connection upon encountering 'data: [DONE]'.
    """
    if first_chunk:
        yield filter_fn(first_chunk) if filter_fn else first_chunk
        if _is_sse_done_chunk(first_chunk):
            return

    if remainder is None:
        return

    chunk_iter = remainder.__aiter__()
    pending_task = None
    try:
        while True:
            if pending_task is None:
                pending_task = asyncio.create_task(chunk_iter.__anext__())
            done, _ = await asyncio.wait([pending_task], timeout=keepalive_sec)
            if done:
                try:
                    chunk = pending_task.result()
                    pending_task = None
                    out = filter_fn(chunk) if filter_fn else chunk
                    yield out
                    if _is_sse_done_chunk(chunk):
                        break
                except StopAsyncIteration:
                    break
                except StreamInterruptedError as e:
                    # Upstream broke mid-stream: end with an explicit SSE error
                    # event instead of silently truncating the answer.
                    yield _sse_stream_error(str(e), error_format)
                    break
            else:
                # Timed out waiting for next chunk; keep pending_task alive!
                yield b": keep-alive\n\n"
    finally:
        if pending_task and not pending_task.done():
            pending_task.cancel()




# Maximum JSON body size for chat/embedding/rerank endpoints (10 MB).
# This is a backstop against malicious / accidental oversized payloads that
# would otherwise accumulate on the Python heap and risk OOM under concurrency.
# OCR has its own separate 20 MB guard (base64 images are inherently large).
_MAX_JSON_BODY_BYTES = 10 * 1024 * 1024
_MAX_OCR_BODY_BYTES = 20 * 1024 * 1024


def _error_response(exc: Exception) -> JSONResponse:
    """Build an error JSONResponse from an AllCandidatesFailedError or generic Exception."""
    if isinstance(exc, AllCandidatesFailedError):
        status = exc.last_status_code or 503
        if exc.last_response_body:
            try:
                body = json.loads(exc.last_response_body)
                if isinstance(body, dict) and "error" in body:
                    return JSONResponse(status_code=status, content=body)
                elif isinstance(body, dict):
                    msg = body.get("message") or body.get("detail") or "Upstream error"
                    return JSONResponse(
                        status_code=status,
                        content={"error": {"message": str(msg), "code": str(status)}},
                    )
            except (json.JSONDecodeError, TypeError):
                pass
        return JSONResponse(
            status_code=status,
            content={"error": {"message": str(exc), "code": "all_candidates_failed"}},
        )
    logger.error("Unhandled proxy error: %s", exc, exc_info=True)
    return JSONResponse(
        status_code=503,
        content={"error": {"message": "Service temporarily unavailable. Please retry later.", "code": "service_unavailable"}},
    )


def _overloaded_response(exc: GlobalOverloadError) -> JSONResponse:
    """503 + Retry-After for burst traffic that exceeds the global concurrency cap."""
    return JSONResponse(
        status_code=503,
        headers={"Retry-After": str(max(1, round(exc.retry_after)))},
        content={
            "error": {
                "message": str(exc),
                "type": "server_error",
                "code": "server_overloaded",
            }
        },
    )


def _model_not_found_response(model_name: str) -> JSONResponse:
    """Return an OpenAI-compatible model-not-found error."""
    return JSONResponse(
        status_code=404,
        content={
            "error": {
                "message": f"The model '{model_name}' does not exist or is not configured.",
                "type": "invalid_request_error",
                "param": "model",
                "code": "model_not_found",
            }
        },
    )


def _scale_budget(config: dict, timeout: float, candidate_count: int) -> float:
    """Scale the failover budget with candidate count, ensuring at least 3 attempts.

    Supports long-thinking / reasoning models (e.g. 120s timeout with failover retries).
    An explicitly configured schedule_total_budget wins."""
    try:
        explicit = float(config.get("schedule_total_budget", 0))
    except (ValueError, TypeError):
        explicit = 0.0
    if explicit > 0:
        return explicit
    return min(600.0, timeout * min(3, max(candidate_count, 1)))


async def _parse_json_body(request: Request, max_bytes: int = _MAX_JSON_BODY_BYTES, return_raw_bytes: bool = False):
    """Parse the request JSON body, returning (body, error_response) or (body, raw_bytes, error_response).

    Enforces max_bytes limit on both Content-Length header and chunked streams
    to prevent memory exhaustion / OOM under concurrent loads.
    """
    cl = request.headers.get("content-length")
    if cl:
        try:
            if int(cl) > max_bytes:
                err = JSONResponse(
                    status_code=413,
                    content={"error": {"message": f"Request body too large (max {max_bytes // (1024 * 1024)}MB)",
                                       "type": "invalid_request_error",
                                       "code": "payload_too_large"}},
                )
                return (None, None, err) if return_raw_bytes else (None, err)
        except (ValueError, TypeError):
            pass

    body_bytes = bytearray()
    try:
        async for chunk in request.stream():
            body_bytes.extend(chunk)
            if len(body_bytes) > max_bytes:
                err = JSONResponse(
                    status_code=413,
                    content={"error": {"message": f"Request body too large (max {max_bytes // (1024 * 1024)}MB)",
                                       "type": "invalid_request_error",
                                       "code": "payload_too_large"}},
                )
                return (None, None, err) if return_raw_bytes else (None, err)
        if not body_bytes:
            err = JSONResponse(
                status_code=400,
                content={"error": {"message": "Invalid JSON body or aborted upload",
                                   "type": "invalid_request_error"}},
            )
            return (None, None, err) if return_raw_bytes else (None, err)
        raw = bytes(body_bytes)
        parsed = json.loads(raw.decode("utf-8"))
        if return_raw_bytes:
            return parsed, raw, None
        return parsed, None
    except json.JSONDecodeError:
        err = JSONResponse(
            status_code=400,
            content={"error": {"message": "Invalid JSON body or aborted upload",
                               "type": "invalid_request_error"}},
        )
        return (None, None, err) if return_raw_bytes else (None, err)
    except Exception as e:
        logger.warning("Error reading request body: %s", e)
        err = JSONResponse(
            status_code=400,
            content={"error": {"message": "Invalid JSON body or aborted upload",
                               "type": "invalid_request_error"}},
        )
        return (None, None, err) if return_raw_bytes else (None, err)


def _get_active_run_mode(config: dict) -> str:
    """Return the active run mode: 'agent' or 'kb'."""
    mode = (config.get("run_mode") or os.environ.get("RUN_MODE") or "agent").lower().strip()
    return mode if mode in ("agent", "kb") else "agent"


@router.get("/models")
async def list_models(request: Request):
    """List all available models according to active RUN_MODE."""
    config = await get_config()
    if not verify_proxy_auth(request, config):
        return JSONResponse(status_code=401, content={"error": "Invalid or missing proxy API key"})

    run_mode = _get_active_run_mode(config)
    data = []

    # 1. Include real Agent models if in agent mode
    if run_mode == "agent":
        agent_models = config.get("agent_models") or {}
        if isinstance(agent_models, dict):
            real_models = set(agent_models.keys())
        else:
            real_models = {c.get("model") for c in agent_models if c.get("model")}
        for model_id in sorted(m for m in real_models if m):
            data.append({
                "id": model_id,
                "object": "model",
                "owned_by": "llm-proxy-agent",
            })

    # 2. Include 4 virtual aggregation models if in kb mode
    else:
        for alias in ("chat", "embedding", "reranker", "ocr"):
            data.append({
                "id": alias,
                "object": "model",
                "owned_by": "llm-proxy-kb",
            })

    return {"object": "list", "data": data}


@router.post("/reload")
async def reload_config(request: Request):
    """Force reload configuration from disk."""
    config = await get_config()
    if not verify_proxy_auth(request, config):
        return JSONResponse(status_code=401, content={"error": "Unauthorized"})

    clear_cache()
    # Also clear cooldowns / circuit breakers / latency history so the
    # reloaded config starts from a clean slate (e.g. after fixing a key).
    reset_runtime_state()
    try:
        config = await get_config()
        return {
            "status": "ok",
            "message": "Configuration reloaded successfully; runtime state (cooldowns/circuit breakers) cleared.",
            "providers": list(config.get("providers", {}).keys())
        }
    except Exception as e:
        return JSONResponse(status_code=500, content={"error": f"Failed to reload config: {e}"})


# ── Chat completions ────────────────────────────────────────────────

@router.post("/chat/completions")
async def chat_completions(request: Request):
    config = await get_config()
    if not verify_proxy_auth(request, config):
        return JSONResponse(status_code=401, content={"error": "Invalid or missing proxy API key"})

    body, raw_body_bytes, err = await _parse_json_body(request, return_raw_bytes=True)
    if err:
        return err
    model_name = body.get("model", "")
    is_stream = body.get("stream", False)
    kb_force_no_reasoning = False

    messages = body.get("messages")
    if not isinstance(messages, list) or len(messages) == 0:
        return JSONResponse(
            status_code=400,
            content={
                "error": {
                    "message": "Missing or invalid 'messages': must be a non-empty array of message objects.",
                    "type": "invalid_request_error",
                    "param": "messages",
                    "code": "missing_required_field" if messages is None or (isinstance(messages, list) and len(messages) == 0) else "invalid_type",
                }
            }
        )

    run_mode = _get_active_run_mode(config)

    if run_mode == "agent":
        if model_name in VIRTUAL_ALIASES:
            return JSONResponse(
                status_code=404,
                content={"error": {"message": f"Virtual model '{model_name}' is not available in Agent mode.", "type": "invalid_request_error"}}
            )
        req_category = "agent"
        req_model_name = model_name
        agent_models = config.get("agent_models") or {}
        entry = agent_models.get(model_name) if isinstance(agent_models, dict) else None
        if not entry:
            return _model_not_found_response(model_name)

        default_upstream = entry.get("upstream_model") or model_name
        strategy = config.get("agent_routing_strategy", "sticky_failover")
        active_key = entry.get("active_key")

        candidates_list = []
        providers_map = config.get("providers") or {}
        for b in entry.get("keys", []):
            if not isinstance(b, dict) or not b.get("provider") or not b.get("key"):
                continue
            p_id = b["provider"]
            p_info = providers_map.get(p_id) or {}
            preset_r = dict(_get_preset_rules(p_info.get("preset_id", p_id)))
            candidates_list.append({
                "provider": p_id,
                "key": b["key"],
                "model": b.get("upstream_model") or default_upstream,
                "adapter_rules": p_info.get("adapter_rules") or preset_r,
            })

        if not candidates_list:
            return _model_not_found_response(model_name)
        try:
            chat_timeout = max(1.0, float(config.get("upstream_timeout_chat") or config.get("upstream_timeout_sec") or 60.0))
        except (ValueError, TypeError):
            chat_timeout = 60.0
    else:
        # KB mode: only accepts model='chat'
        if model_name != "chat":
            return JSONResponse(
                status_code=404,
                content={"error": {"message": f"Model '{model_name}' not found. Current server is running in KB (Knowledge Base) mode which only accepts model='chat'.", "type": "invalid_request_error"}}
            )
        req_category = "kb"
        req_model_name = "chat"
        kb_force_no_reasoning = True
        if is_stream:
            body["stream"] = False
            is_stream = False
        try:
            chat_timeout = max(1.0, float(config.get("chat_fast_timeout", 30)))
        except (ValueError, TypeError):
            chat_timeout = 30.0
        candidates_list = config.get("candidates", {}).get("chat", [])

    if not candidates_list:
        return JSONResponse(
            status_code=503,
            content={"error": {"message": "No chat candidates configured", "type": "server_error"}},
        )

    # Lightweight runtime config without deepcopying the entire global config dict
    req_config = {
        **config,
        "upstream_timeout": chat_timeout,
        "schedule_total_budget": _scale_budget(config, chat_timeout, len(candidates_list)),
        "candidates": {"chat": candidates_list},
    }

    def build_request(cand, api_key, upstream_base_url):
        # Isolate top-level and nested mutable fields (messages, tools, extra_body) via copy-on-write
        out = _clone_request_payload(body)
        out["model"] = cand["model"]
        provider = cand.get("provider", "")
        rules = cand.get("adapter_rules") or _get_preset_rules(provider)
        _apply_request_adapter_rules(out, rules, is_agent_mode=not kb_force_no_reasoning, is_anthropic=False)
        url = join_upstream(upstream_base_url, "chat/completions")
        headers = {
            "Content-Type": "application/json",
        }
        # 1. Declarative Auth Header (Config-driven, defaults to Authorization: Bearer {key})
        auth_header = rules.get("auth_header") if isinstance(rules, dict) else None
        auth_format = (rules.get("auth_format") if isinstance(rules, dict) else None) or "Bearer {key}"
        if not auth_header:
            if "aiplatform.googleapis.com" in upstream_base_url.lower() or provider.lower() == "vertex":
                auth_header = "x-goog-api-key"
                auth_format = "{key}"
            else:
                auth_header = "Authorization"

        if api_key:
            headers[auth_header] = auth_format.format(key=api_key)

        # 2. Declarative Header Injection (Supports dynamic placeholders like ${random_session_id})
        inject_hdrs = rules.get("inject_headers") or rules.get("adapter_rules", {}).get("inject_headers")
        if isinstance(inject_hdrs, dict):
            for hk, hv in inject_hdrs.items():
                headers[str(hk)] = _resolve_dynamic_placeholder(str(hv))

        # Fast-Path: when target model is identical and provider/rules require zero mutation,
        # pass raw bytes directly to upstream without expensive re-serialization.
        is_passthrough = (
            cand["model"] == model_name
            and not kb_force_no_reasoning
            and (
                provider.lower() == "openai"
                or (
                    isinstance(rules, dict)
                    and rules.get("reasoning", {}).get("strategy") == "openai_passthrough"
                    and not rules.get("model_alias")
                    and not rules.get("messages")
                    and not _strip_needed(body, rules)
                    and not rules.get("tools", {}).get("deep_schema_sanitization")
                    and not rules.get("inject_headers")
                    and not _effort_rewrite_needed(body, rules)
                )
            )
        )
        if is_passthrough and raw_body_bytes:
            return "POST", url, headers, raw_body_bytes

        return "POST", url, headers, out

    if is_stream:
        async def handle_stream(resp: httpx.Response, first_chunk: bytes, remainder, lease: Optional[Any] = None):
            async def event_generator():
                try:
                    async for chunk in _stream_with_keepalive(first_chunk, remainder, filter_fn=None, keepalive_sec=15.0):
                        yield chunk
                finally:
                    try:
                        await resp.aclose()
                    finally:
                        if lease is not None:
                            lease.release()
            return StreamingResponse(
                event_generator(),
                media_type="text/event-stream",
                headers={"X-Accel-Buffering": "no"},
            )

        try:
            sr = await schedule(
                req_config, "chat", build_request,
                handle_stream=handle_stream,
                is_stream=True,
                category=req_category,
                request_model=req_model_name,
            )
            sr.stream_resp.headers["X-Routed-Via"] = urllib.parse.quote(sr.routed_via)
            sr.stream_resp.headers["X-Proxy-Routed-Via"] = urllib.parse.quote(sr.routed_via)
            sr.stream_resp.headers["X-Fallback-Attempts"] = str(sr.fallback_attempts)
            sr.stream_resp.headers["X-Proxy-Attempts"] = str(sr.fallback_attempts + 1)
            return sr.stream_resp
        except AllCandidatesFailedError as e:
            return _error_response(e)
        except GlobalOverloadError as e:
            return _overloaded_response(e)
        except Exception as e:
            return _error_response(e)

    try:
        sr = await schedule(
            req_config, "chat", build_request,
            category=req_category,
            request_model=req_model_name,
        )
        if sr.raw_content is not None:
            content_bytes = sr.raw_content
            # Auto-aggregate SSE streams to ChatCompletion JSON if upstream was forced to stream: true
            if content_bytes.lstrip().startswith(b"data:") or b"\ndata:" in content_bytes:
                aggregated = _aggregate_sse_to_chat_completion(content_bytes, model_name=req_model_name)
                resp = JSONResponse(content=_normalize_tool_calls(aggregated))
            else:
                if b'"tool_calls"' in content_bytes:
                    try:
                        parsed = json.loads(content_bytes.decode("utf-8"))
                        if isinstance(parsed, dict):
                            resp = JSONResponse(content=_normalize_tool_calls(parsed))
                        else:
                            resp = Response(content=content_bytes, media_type="application/json")
                    except Exception:
                        resp = Response(content=content_bytes, media_type="application/json")
                else:
                    resp = Response(content=content_bytes, media_type="application/json")
        else:
            resp_data = sr.data
            if isinstance(resp_data, dict):
                resp_data = _normalize_tool_calls(resp_data)
            resp = JSONResponse(content=resp_data)
        resp.headers["X-Routed-Via"] = urllib.parse.quote(sr.routed_via)
        resp.headers["X-Proxy-Routed-Via"] = urllib.parse.quote(sr.routed_via)
        resp.headers["X-Fallback-Attempts"] = str(sr.fallback_attempts)
        resp.headers["X-Proxy-Attempts"] = str(sr.fallback_attempts + 1)
        return resp
    except AllCandidatesFailedError as e:
        return _error_response(e)
    except GlobalOverloadError as e:
        return _overloaded_response(e)
    except Exception as e:
        return _error_response(e)


# ── Anthropic Messages ──────────────────────────────────────────────

def _anthropic_error(status_code: int, err_type: str, message: str) -> JSONResponse:
    return JSONResponse(
        status_code=status_code,
        content={
            "type": "error",
            "error": {
                "type": err_type,
                "message": message,
            }
        }
    )


@router.post("/messages")
async def anthropic_messages(request: Request):
    config = await get_config()
    if not verify_proxy_auth(request, config):
        return _anthropic_error(401, "authentication_error", "Invalid or missing proxy API key")

    body, err = await _parse_json_body(request)
    if err:
        return err

    model_name = body.get("model", "")
    if not model_name or not isinstance(model_name, str):
        return _anthropic_error(400, "invalid_request_error", "Field 'model' is required.")

    run_mode = _get_active_run_mode(config)
    if run_mode == "kb":
        return _anthropic_error(
            404, "not_found_error",
            f"Endpoint /v1/messages is not available in KB mode. Model '{model_name}' must be called via /v1/chat/completions with model='chat'."
        )

    is_stream = body.get("stream", False)
    req_category = "agent"
    req_model_name = model_name

    agent_models = config.get("agent_models") or {}
    entry = None
    if isinstance(agent_models, dict):
        entry = agent_models.get(model_name)
        if not entry:
            # Case-insensitive fallback lookup (e.g. minimax-m3 vs MiniMax-M3)
            for k, v in agent_models.items():
                if k.lower() == model_name.lower():
                    entry = v
                    break

    if not entry:
        return _anthropic_error(404, "not_found_error", f"The model '{model_name}' does not exist or is not configured.")

    default_upstream = entry.get("upstream_model") or model_name
    strategy = config.get("agent_routing_strategy", "sticky_failover")
    active_key = entry.get("active_key")
    providers_cfg = config.get("providers") or {}

    def _supports_messages(p_name: str) -> bool:
        p_cfg = providers_cfg.get(p_name) or {}
        if not isinstance(p_cfg, dict):
            return False
        protos = p_cfg.get("protocols")
        if isinstance(protos, list):
            return "messages" in protos
        if p_cfg.get("anthropic_messages"):
            return True
        p_clean = (p_name or "").lower().replace(".", "").replace("-", "").replace("_", "").strip()
        return p_clean in ("minimax", "bai") or bool(p_cfg.get("anthropic_base_url"))

    candidates_list = []
    for b in entry.get("keys", []):
        if not isinstance(b, dict) or not b.get("provider") or not b.get("key"):
            continue
        p_name = b["provider"]
        if not _supports_messages(p_name):
            continue
        p_cfg = (config.get("providers") or {}).get(p_name, {})
        candidates_list.append({
            "provider": p_name,
            "key": b["key"],
            "model": b.get("upstream_model") or default_upstream,
            "adapter_rules": p_cfg.get("adapter_rules") or _get_preset_rules(p_cfg.get("preset_id", p_name)),
        })

    if not candidates_list:
        return _anthropic_error(
            400, "invalid_request_error",
            f"Model '{model_name}' does not have any keys from providers supporting Anthropic Messages protocol."
        )

    try:
        chat_timeout = max(1.0, float(config.get("upstream_timeout_chat") or config.get("upstream_timeout_sec") or 60.0))
    except (ValueError, TypeError):
        chat_timeout = 60.0

    req_config = {
        **config,
        "upstream_timeout": chat_timeout,
        "schedule_total_budget": _scale_budget(config, chat_timeout, len(candidates_list)),
        "candidates": {"messages": candidates_list},
    }

    anthropic_version = request.headers.get("anthropic-version") or "2023-06-01"

    def build_request(cand, api_key, upstream_base_url):
        out = _clone_request_payload(body)
        out["model"] = cand["model"]
        provider = cand.get("provider", "")
        rules = cand.get("adapter_rules") or _get_preset_rules(provider)

        _apply_request_adapter_rules(out, rules, is_agent_mode=True, is_anthropic=True)

        prov_cfg = (config.get("providers") or {}).get(provider, {})
        anthropic_base = prov_cfg.get("anthropic_base_url")

        url = build_messages_upstream(upstream_base_url, anthropic_base_url=anthropic_base, provider=provider)
        headers = {
            "Authorization": f"Bearer {api_key}",
            "x-api-key": api_key,
            "anthropic-version": anthropic_version,
            "Content-Type": "application/json",
        }
        inject_hdrs = rules.get("inject_headers") or rules.get("adapter_rules", {}).get("inject_headers")
        if isinstance(inject_hdrs, dict):
            for hk, hv in inject_hdrs.items():
                headers[str(hk)] = str(hv)
        return "POST", url, headers, out

    if is_stream:
        async def handle_stream(resp: httpx.Response, first_chunk: bytes, remainder, lease: Optional[Any] = None):
            async def event_generator():
                try:
                    async for chunk in _stream_with_keepalive(first_chunk, remainder, keepalive_sec=15.0, error_format="anthropic"):
                        yield chunk
                finally:
                    try:
                        await resp.aclose()
                    finally:
                        if lease is not None:
                            lease.release()
            return StreamingResponse(
                event_generator(),
                media_type="text/event-stream",
                headers={"X-Accel-Buffering": "no"},
            )

        try:
            sr = await schedule(
                req_config, "messages", build_request,
                handle_stream=handle_stream,
                is_stream=True,
                category=req_category,
                request_model=req_model_name,
            )
            sr.stream_resp.headers["X-Routed-Via"] = urllib.parse.quote(sr.routed_via)
            sr.stream_resp.headers["X-Proxy-Routed-Via"] = urllib.parse.quote(sr.routed_via)
            sr.stream_resp.headers["X-Fallback-Attempts"] = str(sr.fallback_attempts)
            sr.stream_resp.headers["X-Proxy-Attempts"] = str(sr.fallback_attempts + 1)
            return sr.stream_resp
        except AllCandidatesFailedError as e:
            return _error_response(e)
        except GlobalOverloadError as e:
            return _overloaded_response(e)
        except Exception as e:
            return _error_response(e)

    try:
        sr = await schedule(
            req_config, "messages", build_request,
            category=req_category,
            request_model=req_model_name,
        )
        resp = JSONResponse(content=sr.data)
        resp.headers["X-Routed-Via"] = urllib.parse.quote(sr.routed_via)
        resp.headers["X-Proxy-Routed-Via"] = urllib.parse.quote(sr.routed_via)
        resp.headers["X-Fallback-Attempts"] = str(sr.fallback_attempts)
        resp.headers["X-Proxy-Attempts"] = str(sr.fallback_attempts + 1)
        return resp
    except AllCandidatesFailedError as e:
        return _error_response(e)
    except GlobalOverloadError as e:
        return _overloaded_response(e)
    except Exception as e:
        return _error_response(e)


# ── Embeddings ──────────────────────────────────────────────────────

@router.post("/embeddings")
async def embeddings(request: Request):
    config = await get_config()
    if not verify_proxy_auth(request, config):
        return JSONResponse(status_code=401, content={"error": "Invalid or missing proxy API key"})

    run_mode = _get_active_run_mode(config)
    if run_mode == "agent":
        return JSONResponse(
            status_code=404,
            content={"error": {"message": "Endpoint /v1/embeddings is disabled in Agent mode.", "type": "invalid_request_error"}}
        )

    body, err = await _parse_json_body(request)
    if err:
        return err
    model_name = body.get("model", "")

    all_emb_candidates = config.get("candidates", {}).get("embedding", [])

    if model_name == "embedding":
        # KB mode: use all embedding candidates
        candidates_list = all_emb_candidates
    elif model_name in VIRTUAL_ALIASES:
        return _model_not_found_response(model_name)
    else:
        # Filter by model name
        candidates_list = [c for c in all_emb_candidates if c.get("model") == model_name]
        if not candidates_list:
            return _model_not_found_response(model_name)

    if not candidates_list:
        return JSONResponse(
            status_code=503,
            content={"error": {"message": "No embedding candidates configured", "type": "server_error"}},
        )

    # Embeddings of large document batches routinely take longer than the
    # global default (12s) — one timeout would burn the whole failover
    # budget and the remaining keys would never be tried.
    try:
        emb_timeout = max(1.0, float(config.get("upstream_timeout_kb", config.get("upstream_timeout_embedding", 60))))
    except (ValueError, TypeError):
        emb_timeout = 60.0

    req_config = {
        **config,
        "upstream_timeout": emb_timeout,
        "schedule_total_budget": _scale_budget(config, emb_timeout, len(candidates_list)),
        "candidates": {"embedding": candidates_list},
    }

    def build_request(cand, api_key, upstream_base_url):
        out = dict(body)
        out["model"] = cand["model"]
        url = join_upstream(upstream_base_url, "embeddings")
        headers = {
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        }
        provider = cand.get("provider", "")
        rules = cand.get("adapter_rules") or _get_preset_rules(provider)
        inject_hdrs = rules.get("inject_headers") or rules.get("adapter_rules", {}).get("inject_headers")
        if isinstance(inject_hdrs, dict):
            for hk, hv in inject_hdrs.items():
                headers[str(hk)] = str(hv)
        return "POST", url, headers, out

    try:
        sr = await schedule(
            req_config, "embedding", build_request,
            category="kb", request_model="embedding"
        )
        resp = JSONResponse(content=sr.data)
        resp.headers["X-Routed-Via"] = urllib.parse.quote(sr.routed_via)
        resp.headers["X-Fallback-Attempts"] = str(sr.fallback_attempts)
        return resp
    except AllCandidatesFailedError as e:
        return _error_response(e)
    except GlobalOverloadError as e:
        return _overloaded_response(e)
    except Exception as e:
        return _error_response(e)


# ── Reranker ────────────────────────────────────────────────────────

@router.post("/rerank")
async def rerank(request: Request):
    config = await get_config()
    if not verify_proxy_auth(request, config):
        return JSONResponse(status_code=401, content={"error": "Invalid or missing proxy API key"})

    run_mode = _get_active_run_mode(config)
    if run_mode == "agent":
        return JSONResponse(
            status_code=404,
            content={"error": {"message": "Endpoint /v1/rerank is disabled in Agent mode.", "type": "invalid_request_error"}}
        )

    body, err = await _parse_json_body(request)
    if err:
        return err
    model_name = body.get("model", "")

    all_rerank_candidates = config.get("candidates", {}).get("reranker", [])

    if model_name == "reranker":
        # KB mode: use all reranker candidates
        candidates_list = all_rerank_candidates
    elif model_name in VIRTUAL_ALIASES:
        return _model_not_found_response(model_name)
    else:
        # Filter by model name
        candidates_list = [c for c in all_rerank_candidates if c.get("model") == model_name]
        if not candidates_list:
            return _model_not_found_response(model_name)

    if not candidates_list:
        return JSONResponse(
            status_code=503,
            content={"error": {"message": "No reranker candidates configured", "type": "server_error"}},
        )

    # Rerank requests can also be slow on long candidate lists — same
    # per-type timeout + budget treatment as embeddings.
    try:
        rerank_timeout = max(1.0, float(config.get("upstream_timeout_kb", config.get("upstream_timeout_rerank", 30))))
    except (ValueError, TypeError):
        rerank_timeout = 30.0

    req_config = {
        **config,
        "upstream_timeout": rerank_timeout,
        "schedule_total_budget": _scale_budget(config, rerank_timeout, len(candidates_list)),
        "candidates": {"reranker": candidates_list},
    }

    def build_request(cand, api_key, upstream_base_url):
        out = dict(body)
        out["model"] = cand["model"]
        url = join_upstream(upstream_base_url, "rerank")
        headers = {
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        }
        return "POST", url, headers, out

    try:
        sr = await schedule(
            req_config, "reranker", build_request,
            category="kb", request_model="reranker"
        )
        resp = JSONResponse(content=sr.data)
        resp.headers["X-Routed-Via"] = urllib.parse.quote(sr.routed_via)
        resp.headers["X-Fallback-Attempts"] = str(sr.fallback_attempts)
        return resp
    except AllCandidatesFailedError as e:
        return _error_response(e)
    except GlobalOverloadError as e:
        return _overloaded_response(e)
    except Exception as e:
        return _error_response(e)


# ── OCR (KB only — not a standard OpenAI endpoint) ──────────────────

@router.post("/ocr")
async def ocr(request: Request):
    config = await get_config()
    if not verify_proxy_auth(request, config):
        return JSONResponse(status_code=401, content={"error": "Invalid or missing proxy API key"})

    run_mode = _get_active_run_mode(config)
    if run_mode == "agent":
        return JSONResponse(
            status_code=404,
            content={"error": {"message": "Endpoint /v1/ocr is disabled in Agent mode.", "type": "invalid_request_error"}}
        )

    body, err = await _parse_json_body(request, max_bytes=_MAX_OCR_BODY_BYTES)
    if err:
        return err
    img_b64 = body.get("image_base64")
    img_url = body.get("image_url")
    if not img_b64 and not img_url:
        return JSONResponse(status_code=400, content={"error": {"message": "Must provide image_base64 or image_url", "code": "missing_image"}})

    prompt = body.get("prompt", "请识别图片中的所有文字内容，返回纯文本。")

    # Build the data-URL once and reuse the same string reference in every
    # failover attempt.  Python's string interning means all dict references
    # to `img` point to the same underlying buffer — no per-attempt copy.
    if img_url:
        img = img_url
    else:
        # Detect MIME from magic bytes in base64 prefix
        if img_b64.startswith("/9j/"):
            mime = "image/jpeg"
        elif img_b64.startswith("iVBORw0KGgo"):
            mime = "image/png"
        elif img_b64.startswith("UklGR"):
            mime = "image/webp"
        elif img_b64.startswith("R0lGOD"):
            mime = "image/gif"
        elif img_b64.startswith("Qk"):
            mime = "image/bmp"
        elif img_b64.startswith("SUkq") or img_b64.startswith("TU0A"):
            mime = "image/tiff"
        elif img_b64.startswith("AAAA") or "ftypheic" in img_b64[:40] or "ftypavif" in img_b64[:40]:
            mime = "image/heic"
        else:
            mime = "image/png"
        img = f"data:{mime};base64,{img_b64}"

    # Release the original body dict and the raw base64/url locals early so
    # only `img` and `prompt` keep the payload alive during failover attempts.
    del body
    del img_b64, img_url

    config = await get_config()

    def build_request(cand, api_key, upstream_base_url):
        chat_body = {
            "model": cand["model"],
            "messages": [{"role": "user", "content": [
                {"type": "text", "text": prompt},
                {"type": "image_url", "image_url": {"url": img}},
            ]}],
            "max_tokens": 4096,
            "stream": False,
        }
        provider_name = cand.get("provider")
        provider_cfg = (config.get("providers") or {}).get(provider_name, {})
        rules = cand.get("adapter_rules") or provider_cfg.get("adapter_rules") or _get_preset_rules(provider_name)
        _apply_request_adapter_rules(chat_body, rules, is_agent_mode=False, is_anthropic=False)
        url = join_upstream(upstream_base_url, "chat/completions")
        headers = {
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        }
        inject_hdrs = rules.get("inject_headers") or rules.get("adapter_rules", {}).get("inject_headers")
        if isinstance(inject_hdrs, dict):
            for hk, hv in inject_hdrs.items():
                headers[str(hk)] = str(hv)
        return "POST", url, headers, chat_body

    # OCR / vision models need a longer timeout than chat
    try:
        ocr_timeout = max(1.0, float(config.get("upstream_timeout_kb", config.get("upstream_timeout_ocr", 60))))
    except (ValueError, TypeError):
        ocr_timeout = 60.0

    ocr_candidates = len(config.get("candidates", {}).get("ocr", []))
    req_config = {
        **config,
        "upstream_timeout": ocr_timeout,
        "schedule_total_budget": _scale_budget(config, ocr_timeout, ocr_candidates),
    }

    try:
        sr = await schedule(
            req_config, "ocr", build_request,
            category="kb", request_model="ocr"
        )
        resp = JSONResponse(content=sr.data)
        resp.headers["X-Routed-Via"] = urllib.parse.quote(sr.routed_via)
        resp.headers["X-Fallback-Attempts"] = str(sr.fallback_attempts)
        return resp
    except AllCandidatesFailedError as e:
        return _error_response(e)
    except GlobalOverloadError as e:
        return _overloaded_response(e)
    except Exception as e:
        return _error_response(e)
    finally:
        del img
        del prompt
        del build_request
        asyncio.create_task(_reclaim_memory())

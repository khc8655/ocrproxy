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
from pathlib import Path
import httpx
from fastapi import APIRouter, Request
from fastapi.responses import StreamingResponse, JSONResponse

from .config_store import get_config, clear_cache
from .scheduler import (
    schedule,
    AllCandidatesFailedError,
    GlobalOverloadError,
    reset_runtime_state,
    _reclaim_memory,
)
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


def _apply_request_adapter_rules(out: dict, rules: dict, is_agent_mode: bool, is_anthropic: bool = False) -> None:
    """Pure declarative rule executor for all upstream providers.
    Mutates `out` in place according to provider adapter_rules schema.
    """
    if not rules or not isinstance(rules, dict):
        return

    m_name = str(out.get("model", "")).lower()

    # 1. Model casing mapping
    casing_map = rules.get("case_sensitive_models", {})
    if isinstance(casing_map, dict):
        for k, v in casing_map.items():
            if m_name == k.lower():
                out["model"] = v
                break

    # 2. Sanitization (parameter blacklisting and clamping)
    strip_params = rules.get("sanitization", {}).get("strip_params", [])
    for sp in strip_params:
        out.pop(sp, None)
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
        for m in out["messages"]:
            if not isinstance(m, dict) or m.get("role") != "assistant":
                continue
            content = m.get("content")
            if isinstance(content, list):
                new_content = []
                for b in content:
                    if isinstance(b, dict) and b.get("type") == "thinking":
                        if thinking_policy == "strip":
                            continue
                        elif thinking_policy == "strict_signature" and not b.get("signature"):
                            continue
                    new_content.append(b)
                m["content"] = new_content
            elif thinking_policy == "strip":
                m.pop("reasoning_content", None)
                m.pop("reasoning", None)

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

    # 6. Reasoning strategy execution
    reasoning_rules = rules.get("reasoning", {})
    if reasoning_rules and isinstance(reasoning_rules, dict):
        strat = reasoning_rules.get("strategy", "openai_passthrough")

        model_specific = {}
        for m_prefix, m_cfg in reasoning_rules.get("model_rules", {}).items():
            if m_prefix.lower() in m_name:
                model_specific = m_cfg
                break

        if not is_agent_mode:
            # KB mode: suppress thinking latency
            if strat == "gemini_thinking_matrix":
                out.pop("reasoning_effort", None)
                out.setdefault("extra_body", {}).setdefault("google", {})["thinking_config"] = {
                    "include_thoughts": False
                }
            elif strat == "minimax_adaptive":
                out.pop("reasoning_effort", None)
                out.pop("reasoning_split", None)
                out["thinking"] = {"type": "disabled"}
            elif strat == "chat_template_kwargs":
                out.pop("reasoning_effort", None)
                enable_key = reasoning_rules.get("enable_key", "enable_thinking")
                out.setdefault("chat_template_kwargs", {})[enable_key] = False
            elif strat == "effort_remapping":
                out.pop("thinking", None)
                none_fb = model_specific.get("none_fallback") or reasoning_rules.get("none_fallback")
                none_act = model_specific.get("none_action") or reasoning_rules.get("none_action")
                if none_act == "omit" and not none_fb:
                    out.pop("reasoning_effort", None)
                elif none_fb:
                    out["reasoning_effort"] = none_fb
                else:
                    out["reasoning_effort"] = "none"
            else:
                out["reasoning_effort"] = "none"
        else:
            # Agent mode
            if strat == "gemini_thinking_matrix":
                is_gemma = m_name.startswith("gemma")
                thinking_enabled = False
                if not is_gemma:
                    re = out.pop("reasoning_effort", None)
                    if re is not None:
                        effort = str(re).lower()
                        extra = out.setdefault("extra_body", {}).setdefault("google", {})
                        is_gemini_25 = m_name.startswith("gemini-2.5-")
                        is_pro = "pro" in m_name
                        if effort in ("none", "false"):
                            extra["thinking_config"] = {"include_thoughts": False}
                        elif is_gemini_25:
                            extra["thinking_config"] = {"include_thoughts": True}
                            thinking_enabled = True
                        else:
                            thinking_level = "low"
                            if effort in ("high", "xhigh", "max"):
                                thinking_level = "high"
                            elif effort == "medium" and not is_pro:
                                thinking_level = "medium"
                            extra["thinking_config"] = {
                                "include_thoughts": True,
                                "thinking_level": thinking_level,
                            }
                            thinking_enabled = True
                    else:
                        cfg = out.get("extra_body", {}).get("google", {}).get("thinking_config", {})
                        if cfg.get("include_thoughts") is not False and cfg.get("thinking_level"):
                            thinking_enabled = True

                if thinking_enabled and reasoning_rules.get("headroom_elevation", True):
                    if "max_tokens" in out and isinstance(out["max_tokens"], int) and out["max_tokens"] < 16384:
                        out["max_tokens"] = 65535
                    if "max_completion_tokens" in out and isinstance(out["max_completion_tokens"], int) and out["max_completion_tokens"] < 16384:
                        out["max_completion_tokens"] = 65535

            elif strat == "minimax_adaptive":
                re = out.pop("reasoning_effort", None)
                if re is not None and str(re).lower() in ("none", "false"):
                    out["thinking"] = {"type": "disabled"}
                    out.pop("reasoning_split", None)
                elif "thinking" in out and isinstance(out["thinking"], dict) and str(out["thinking"].get("type", "")).lower() == "disabled":
                    out["thinking"] = {"type": "disabled"}
                    out.pop("reasoning_split", None)
                else:
                    if reasoning_rules.get("enable_reasoning_split", True):
                        out["reasoning_split"] = True
                    if "thinking" not in out:
                        out["thinking"] = {"type": reasoning_rules.get("default_type", "adaptive")}

            elif strat == "chat_template_kwargs":
                re = out.pop("reasoning_effort", None)
                if re is not None:
                    effort = str(re).lower()
                    ctk = out.setdefault("chat_template_kwargs", {})
                    enable_key = reasoning_rules.get("enable_key", "enable_thinking")
                    if enable_key not in ctk:
                        ctk[enable_key] = effort not in ("none", "false")
                elif reasoning_rules.get("default_thinking", False):
                    ctk = out.setdefault("chat_template_kwargs", {})
                    enable_key = reasoning_rules.get("enable_key", "enable_thinking")
                    if enable_key not in ctk:
                        ctk[enable_key] = True

            elif strat == "effort_remapping":
                if reasoning_rules.get("strip_thinking"):
                    out.pop("thinking", None)
                re = out.get("reasoning_effort")
                if re is not None:
                    re_str = str(re).lower()
                    supported = model_specific.get("supported_levels") or reasoning_rules.get("supported_levels", ["low", "medium", "high"])
                    fallbacks = model_specific.get("level_fallback") or reasoning_rules.get("level_fallback", {})
                    none_fb = model_specific.get("none_fallback") or reasoning_rules.get("none_fallback")
                    none_act = model_specific.get("none_action") or reasoning_rules.get("none_action")

                    if re_str in ("none", "false"):
                        if "none" in supported and not none_fb and none_act != "omit":
                            out["reasoning_effort"] = "none"
                        elif none_fb:
                            out["reasoning_effort"] = none_fb
                        elif none_act == "omit":
                            out.pop("reasoning_effort", None)
                        else:
                            out["reasoning_effort"] = "low"
                    elif re_str in fallbacks:
                        out["reasoning_effort"] = fallbacks[re_str]
                    elif re_str not in supported:
                        out["reasoning_effort"] = fallbacks.get(re_str, reasoning_rules.get("default_effort", "medium"))
                else:
                    default_eff = model_specific.get("default_effort") or reasoning_rules.get("default_effort")
                    if default_eff:
                        out["reasoning_effort"] = default_eff

            elif strat == "openai_passthrough":
                supported = reasoning_rules.get("supported_levels", ["none", "low", "medium", "high"])
                re = out.get("reasoning_effort")
                if re == "none" and "none" not in supported:
                    out["reasoning_effort"] = reasoning_rules.get("none_fallback", "low")

    # 7. Anthropic Messages endpoint specific rules
    if is_anthropic:
        mt = out.get("max_tokens")
        if not isinstance(mt, int) or mt <= 0:
            out["max_tokens"] = 4096

        anthropic_rules = rules.get("anthropic", {})
        if anthropic_rules and isinstance(anthropic_rules, dict):
            if anthropic_rules.get("strip_thinking"):
                thinking = out.pop("thinking", None)
                if anthropic_rules.get("thinking_to_output_config"):
                    if thinking and isinstance(thinking, dict) and str(thinking.get("type", "")).lower() != "disabled":
                        out["output_config"] = {"effort": anthropic_rules.get("default_effort", "medium")}
                    elif "output_config" in out and isinstance(out["output_config"], dict):
                        eff = str(out["output_config"].get("effort", "")).lower()
                        model_rules = anthropic_rules.get("model_rules", {})
                        for mk, mc in model_rules.items():
                            if mk.lower() in m_name:
                                fb = mc.get("level_fallback", {})
                                if eff in fb:
                                    out["output_config"]["effort"] = fb[eff]
                                break
            elif anthropic_rules.get("thinking_to_adaptive"):
                thinking = out.get("thinking")
                if isinstance(thinking, dict):
                    t = str(thinking.get("type", "")).lower()
                    if t == "enabled" or (not t and "budget_tokens" in thinking):
                        thinking["type"] = "adaptive"


def _normalize_response_data(data: dict, rules: dict) -> None:
    """Normalize response JSON (non-streaming) based on declarative response rules."""
    if not isinstance(data, dict):
        return
    resp_rules = rules.get("response", {}) if isinstance(rules, dict) else {}
    reasoning_fields = resp_rules.get("reasoning_fields", ["reasoning_split", "reasoning_content", "reasoning"])

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


async def _stream_with_keepalive(
    first_chunk: bytes,
    remainder,
    filter_fn: Optional[Callable[[bytes], bytes]] = None,
    keepalive_sec: float = 15.0,
):
    """Yield chunks from a streaming response, emitting SSE keep-alive comments
    (': keep-alive\n\n') every `keepalive_sec` if upstream is idle (e.g. during deep thinking).
    Uses asyncio.wait on the pending task so timeouts do NOT cancel the generator.
    """
    if first_chunk:
        yield filter_fn(first_chunk) if filter_fn else first_chunk

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
                    yield filter_fn(chunk) if filter_fn else chunk
                except StopAsyncIteration:
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

    Hard cap at 180s: without it agent mode computes 120s × 3 = 360s, which
    exceeds typical client-side timeouts. An explicitly configured schedule_total_budget wins."""
    try:
        explicit = float(config.get("schedule_total_budget", 0))
    except (ValueError, TypeError):
        explicit = 0.0
    if explicit > 0:
        return explicit
    return min(180.0, timeout * min(3, max(candidate_count, 1)))


async def _parse_json_body(request: Request, max_bytes: int = _MAX_JSON_BODY_BYTES):
    """Parse the request JSON body, returning (body, error_response).

    Enforces max_bytes limit on both Content-Length header and chunked streams
    to prevent memory exhaustion / OOM under concurrent loads.
    """
    cl = request.headers.get("content-length")
    if cl:
        try:
            if int(cl) > max_bytes:
                return None, JSONResponse(
                    status_code=413,
                    content={"error": {"message": f"Request body too large (max {max_bytes // (1024 * 1024)}MB)",
                                       "type": "invalid_request_error",
                                       "code": "payload_too_large"}},
                )
        except (ValueError, TypeError):
            pass

    body_bytes = bytearray()
    try:
        async for chunk in request.stream():
            body_bytes.extend(chunk)
            if len(body_bytes) > max_bytes:
                return None, JSONResponse(
                    status_code=413,
                    content={"error": {"message": f"Request body too large (max {max_bytes // (1024 * 1024)}MB)",
                                       "type": "invalid_request_error",
                                       "code": "payload_too_large"}},
                )
        if not body_bytes:
            return None, JSONResponse(
                status_code=400,
                content={"error": {"message": "Invalid JSON body or aborted upload",
                                   "type": "invalid_request_error"}},
            )
        return json.loads(body_bytes.decode("utf-8")), None
    except json.JSONDecodeError:
        return None, JSONResponse(
            status_code=400,
            content={"error": {"message": "Invalid JSON body or aborted upload",
                               "type": "invalid_request_error"}},
        )
    except Exception as e:
        logger.warning("Error reading request body: %s", e)
        return None, JSONResponse(
            status_code=400,
            content={"error": {"message": "Invalid JSON body or aborted upload",
                               "type": "invalid_request_error"}},
        )


def _get_active_run_mode(config: dict) -> str:
    """Return the active run mode: 'agent', 'kb', or 'full'."""
    mode = (config.get("run_mode") or os.environ.get("RUN_MODE") or "full").lower().strip()
    return mode if mode in ("agent", "kb", "full") else "full"


@router.get("/models")
async def list_models(request: Request):
    """List all available models according to active RUN_MODE."""
    config = await get_config()
    if not verify_proxy_auth(request, config):
        return JSONResponse(status_code=401, content={"error": "Invalid or missing proxy API key"})

    run_mode = _get_active_run_mode(config)
    data = []

    # 1. Include real Agent models if in agent or full mode
    if run_mode in ("agent", "full"):
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

    # 2. Include 4 virtual aggregation models if in kb or full mode
    if run_mode in ("kb", "full"):
        for alias in ("chat", "embedding", "reranker", "ocr"):
            if not any(d["id"] == alias for d in data):
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

    body, err = await _parse_json_body(request)
    if err:
        return err
    model_name = body.get("model", "")
    is_stream = body.get("stream", False)
    kb_force_no_reasoning = False

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
            p_info = providers_map.get(p_id, {})
            candidates_list.append({
                "provider": p_id,
                "key": b["key"],
                "model": b.get("upstream_model") or default_upstream,
                "adapter_rules": p_info.get("adapter_rules") or _get_preset_rules(p_info.get("preset_id", p_id)),
            })

        if not candidates_list:
            return _model_not_found_response(model_name)
        try:
            chat_timeout = max(1.0, float(config.get("upstream_timeout_chat") or config.get("upstream_timeout_sec") or 60.0))
        except (ValueError, TypeError):
            chat_timeout = 60.0

    elif run_mode == "kb":
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

    else:
        # Full mode: support both
        if model_name == "chat":
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
        elif model_name in VIRTUAL_ALIASES:
            return _model_not_found_response(model_name)
        else:
            req_category = "agent"
            req_model_name = model_name
            agent_models = config.get("agent_models") or {}
            entry = agent_models.get(model_name) if isinstance(agent_models, dict) else None
            if not entry:
                return _model_not_found_response(model_name)
            default_upstream = entry.get("upstream_model") or model_name
            candidates_list = []
            providers_map = config.get("providers") or {}
            for b in entry.get("keys", []):
                if not isinstance(b, dict) or not b.get("provider") or not b.get("key"):
                    continue
                p_id = b["provider"]
                p_info = providers_map.get(p_id, {})
                candidates_list.append({
                    "provider": p_id,
                    "key": b["key"],
                    "model": b.get("upstream_model") or default_upstream,
                    "adapter_rules": p_info.get("adapter_rules") or _get_preset_rules(p_info.get("preset_id", p_id)),
                })
            if not candidates_list:
                return _model_not_found_response(model_name)
            try:
                chat_timeout = max(1.0, float(config.get("upstream_timeout_chat") or config.get("upstream_timeout_sec") or 60.0))
            except (ValueError, TypeError):
                chat_timeout = 60.0

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
        # Shallow-copy dict to isolate top-level mutations without expensive deep copies
        out = dict(body)
        out["model"] = cand["model"]
        provider = cand.get("provider", "")
        rules = cand.get("adapter_rules") or _get_preset_rules(provider)
        _apply_request_adapter_rules(out, rules, is_agent_mode=not kb_force_no_reasoning, is_anthropic=False)
        url = join_upstream(upstream_base_url, "chat/completions")
        headers = {
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        }
        inject_hdrs = rules.get("inject_headers") or rules.get("adapter_rules", {}).get("inject_headers")
        if isinstance(inject_hdrs, dict):
            for hk, hv in inject_hdrs.items():
                headers[str(hk)] = str(hv)
        return "POST", url, headers, out

    if is_stream:
        async def handle_stream(resp: httpx.Response, first_chunk: bytes, remainder):
            def _filter_chunk(b: bytes) -> bytes:
                if b and b'"reasoning":' in b:
                    return b.replace(b'"reasoning":', b'"reasoning_content":')
                return b

            async def event_generator():
                try:
                    async for chunk in _stream_with_keepalive(first_chunk, remainder, filter_fn=_filter_chunk, keepalive_sec=15.0):
                        yield chunk
                finally:
                    await resp.aclose()
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
            sr.stream_resp.headers["X-Fallback-Attempts"] = str(sr.fallback_attempts)
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
        resp_data = sr.data
        if isinstance(resp_data, dict):
            _normalize_response_data(resp_data, rules={})
        resp = JSONResponse(content=resp_data)
        resp.headers["X-Routed-Via"] = urllib.parse.quote(sr.routed_via)
        resp.headers["X-Fallback-Attempts"] = str(sr.fallback_attempts)
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
        out = dict(body)
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
        async def handle_stream(resp: httpx.Response, first_chunk: bytes, remainder):
            async def event_generator():
                try:
                    async for chunk in _stream_with_keepalive(first_chunk, remainder, keepalive_sec=15.0):
                        yield chunk
                finally:
                    await resp.aclose()
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
            sr.stream_resp.headers["X-Fallback-Attempts"] = str(sr.fallback_attempts)
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
        resp.headers["X-Fallback-Attempts"] = str(sr.fallback_attempts)
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

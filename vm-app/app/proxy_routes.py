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
import os
import copy
import json
import asyncio
import logging
import urllib.parse
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
from .upstream import join_upstream

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
#    - Agent tools expecting reasoning_content need "deepseek-style"

# Providers that do not accept reasoning_effort="none"
_PROVIDERS_NO_NONE_EFFORT = {"stepfun"}

# Providers that only accept string-form tool_choice (no object form)
_PROVIDERS_NO_OBJECT_TOOL_CHOICE = {"tokenrhythm", "sensenova", "deepseek"}

# Google Gemini / AI Studio providers
_GOOGLE_PROVIDERS = {"google", "gemini", "aistudio", "google-ai"}


def _sanitize_gemini_schema(schema):
    """Recursively strip $schema and non-standard fields that Gemini rejects."""
    if not isinstance(schema, dict):
        return schema
    clean = copy.deepcopy(schema)
    clean.pop("$schema", None)
    if "properties" in clean and isinstance(clean["properties"], dict):
        clean["properties"] = {
            k: _sanitize_gemini_schema(v) for k, v in clean["properties"].items()
        }
    if "items" in clean and isinstance(clean["items"], dict):
        clean["items"] = _sanitize_gemini_schema(clean["items"])
    return clean


def _normalise_for_provider(out: dict, provider: str) -> None:
    """Normalise request body fields that the target provider would reject.

    Mutates `out` in-place.  Only fields whose values would cause a 400 error
    are touched — all other parameters pass through untouched.
    """
    p = str(provider or "").lower()

    # 1. reasoning_effort: "none" → "low" for providers that don't accept "none"
    if p in _PROVIDERS_NO_NONE_EFFORT:
        re = out.get("reasoning_effort")
        if re == "none":
            out["reasoning_effort"] = "low"

    # 2. tool_choice: object form → "auto" for providers that reject objects
    if p in _PROVIDERS_NO_OBJECT_TOOL_CHOICE:
        tc = out.get("tool_choice")
        if isinstance(tc, dict):
            out["tool_choice"] = "auto"

    # 3. StepFun: set reasoning_format="deepseek-style" so agent tools
    #    receive reasoning_content (not the StepFun-native "reasoning" field).
    #    Only inject if the caller hasn't already set it explicitly.
    if p == "stepfun":
        if "reasoning_format" not in out:
            out["reasoning_format"] = "deepseek-style"

    # 4. Google AI Studio / Gemini Adaptation (Gemini 2.5 / 3 / 3.5+)
    is_google = p in _GOOGLE_PROVIDERS or str(out.get("model", "")).lower().startswith("gemini")
    if is_google:
        # Map reasoning_effort to extra_body.google.thinking_config
        re = out.pop("reasoning_effort", None)
        if re is not None:
            effort = str(re).lower()
            extra = out.setdefault("extra_body", {}).setdefault("google", {})
            model_name = str(out.get("model", "")).lower()
            is_gemini_25 = model_name.startswith("gemini-2.5-")
            is_pro = "pro" in model_name

            if effort in ("none", "false"):
                extra["thinking_config"] = {"include_thoughts": False}
            elif is_gemini_25:
                extra["thinking_config"] = {"include_thoughts": True}
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

        # Sanitize tool schemas
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

    # 5. Agnes AI: map reasoning_effort to chat_template_kwargs.enable_thinking
    if p == "agnes" or str(out.get("model", "")).lower().startswith("agnes"):
        re = out.pop("reasoning_effort", None)
        if re is not None:
            effort = str(re).lower()
            ctk = out.setdefault("chat_template_kwargs", {})
            if "enable_thinking" not in ctk:
                ctk["enable_thinking"] = effort not in ("none", "false")


def _disable_thinking_for_kb(out: dict, provider: str) -> None:
    """Inject provider-specific parameters to disable thinking/reasoning in KB mode.

    KB ingestion is batch processing — reasoning adds latency without value.
    Each provider has a different mechanism:
      - SenseNova / DeepSeek: reasoning_effort="none" (truly off)
      - StepFun: reasoning_effort="low" (lowest tier, "none" not accepted)
      - Agnes: chat_template_kwargs={"enable_thinking": False} (reasoning_effort ignored)
      - Google Gemini: extra_body.google.thinking_config={"include_thoughts": False}
      - TokenRhythm / others: reasoning_effort="none" (standard OpenAI-compatible)
    """
    p = str(provider or "").lower()
    if p == "stepfun":
        out["reasoning_effort"] = "low"
    elif p == "agnes":
        out.pop("reasoning_effort", None)
        out["chat_template_kwargs"] = {"enable_thinking": False}
    elif p in _GOOGLE_PROVIDERS:
        out.pop("reasoning_effort", None)
        out.setdefault("extra_body", {}).setdefault("google", {})["thinking_config"] = {
            "include_thoughts": False
        }
    else:
        out["reasoning_effort"] = "none"


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
    mode = (os.environ.get("RUN_MODE") or config.get("run_mode") or "full").lower().strip()
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
        for b in entry.get("keys", []):
            if not isinstance(b, dict) or not b.get("provider") or not b.get("key"):
                continue
            candidates_list.append({
                "provider": b["provider"],
                "key": b["key"],
                "model": b.get("upstream_model") or default_upstream,
            })

        if strategy == "manual":
            # In manual mode, filter to only the active key (or first key if active_key not found)
            if active_key:
                matched = [c for c in candidates_list if c["key"] == active_key]
                if matched:
                    candidates_list = matched
                else:
                    candidates_list = candidates_list[:1]
            else:
                candidates_list = candidates_list[:1]

        if not candidates_list:
            return _model_not_found_response(model_name)
        try:
            chat_timeout = max(1.0, float(config.get("upstream_timeout_chat", 120)))
        except (ValueError, TypeError):
            chat_timeout = 120.0

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
            for b in entry.get("keys", []):
                if not isinstance(b, dict) or not b.get("provider") or not b.get("key"):
                    continue
                candidates_list.append({
                    "provider": b["provider"],
                    "key": b["key"],
                    "model": b.get("upstream_model") or default_upstream,
                })
            if not candidates_list:
                return _model_not_found_response(model_name)
            try:
                chat_timeout = max(1.0, float(config.get("upstream_timeout_chat", 120)))
            except (ValueError, TypeError):
                chat_timeout = 120.0

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
        if kb_force_no_reasoning:
            # KB mode: disable thinking per provider's mechanism
            _disable_thinking_for_kb(out, provider)
        else:
            # Agent mode: minimal normalisation — only fix values that the
            # target provider would reject (causing a 400 error).  All other
            # parameters pass through untouched.
            _normalise_for_provider(out, provider)
        url = join_upstream(upstream_base_url, "chat/completions")
        headers = {
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        }
        return "POST", url, headers, out

    if is_stream:
        async def handle_stream(resp: httpx.Response, first_chunk: bytes, remainder):
            async def event_generator():
                try:
                    if first_chunk:
                        yield first_chunk
                    if remainder is not None:
                        async for chunk in remainder:
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
        emb_timeout = max(1.0, float(config.get("upstream_timeout_embedding", 60)))
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
        rerank_timeout = max(1.0, float(config.get("upstream_timeout_rerank", 30)))
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
        url = join_upstream(upstream_base_url, "chat/completions")
        headers = {
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        }
        return "POST", url, headers, chat_body

    # OCR / vision models need a longer timeout than chat
    try:
        ocr_timeout = max(1.0, float(config.get("upstream_timeout_ocr", 60)))
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

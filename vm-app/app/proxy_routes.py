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
import copy
import json
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
)
from .auth import verify_proxy_auth
from .upstream import join_upstream

router = APIRouter(prefix="/v1")

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
_PROVIDERS_NO_OBJECT_TOOL_CHOICE = {"tokenrhythm"}


def _normalise_for_provider(out: dict, provider: str) -> None:
    """Normalise request body fields that the target provider would reject.

    Mutates `out` in-place.  Only fields whose values would cause a 400 error
    are touched — all other parameters pass through untouched.
    """
    # 1. reasoning_effort: "none" → "low" for providers that don't accept "none"
    if provider in _PROVIDERS_NO_NONE_EFFORT:
        re = out.get("reasoning_effort")
        if re == "none":
            out["reasoning_effort"] = "low"

    # 2. tool_choice: object form → "auto" for providers that reject objects
    if provider in _PROVIDERS_NO_OBJECT_TOOL_CHOICE:
        tc = out.get("tool_choice")
        if isinstance(tc, dict):
            out["tool_choice"] = "auto"

    # 3. StepFun: set reasoning_format="deepseek-style" so agent tools
    #    receive reasoning_content (not the StepFun-native "reasoning" field).
    #    Only inject if the caller hasn't already set it explicitly.
    if provider == "stepfun":
        if "reasoning_format" not in out:
            out["reasoning_format"] = "deepseek-style"


def _disable_thinking_for_kb(out: dict, provider: str) -> None:
    """Inject provider-specific parameters to disable thinking/reasoning in KB mode.

    KB ingestion is batch processing — reasoning adds latency without value.
    Each provider has a different mechanism:
      - SenseNova / DeepSeek: reasoning_effort="none" (truly off)
      - StepFun: reasoning_effort="low" (lowest tier, "none" not accepted)
      - Agnes: chat_template_kwargs={"enable_thinking": False} (reasoning_effort ignored)
      - TokenRhythm / others: reasoning_effort="none" (standard OpenAI-compatible)
    """
    if provider == "stepfun":
        out["reasoning_effort"] = "low"
    elif provider == "agnes":
        # Agnes uses chat_template_kwargs to control thinking, not reasoning_effort.
        # Remove reasoning_effort if present (it's ignored by Agnes and could confuse other layers).
        out.pop("reasoning_effort", None)
        out["chat_template_kwargs"] = {"enable_thinking": False}
    else:
        # Default: sensenova, tokenrhythm, and any OpenAI-compatible provider
        out["reasoning_effort"] = "none"


# Maximum JSON body size for chat/embedding/rerank endpoints (10 MB).
# This is a backstop against malicious / accidental oversized payloads that
# would otherwise accumulate on the Python heap and risk OOM under concurrency.
# OCR has its own separate 20 MB guard (base64 images are inherently large).
_MAX_JSON_BODY_BYTES = 10 * 1024 * 1024


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


async def _parse_json_body(request: Request):
    """Parse the request JSON body, returning (body, error_response).

    Aborted uploads (e.g. Caddy rejecting an oversized body mid-stream) raise
    ClientDisconnect inside starlette — without this guard every such request
    dumps a full traceback into the journal.

    Also enforces a maximum body size (_MAX_JSON_BODY_BYTES) to prevent OOM
    under concurrent load — a malicious or buggy client can otherwise send a
    100 MB JSON payload that stays on the Python heap until GC reclaims it.
    """
    cl = request.headers.get("content-length")
    if cl:
        try:
            if int(cl) > _MAX_JSON_BODY_BYTES:
                return None, JSONResponse(
                    status_code=413,
                    content={"error": {"message": "Request body too large",
                                       "type": "invalid_request_error",
                                       "code": "payload_too_large"}},
                )
        except (ValueError, TypeError):
            pass
    try:
        return await request.json(), None
    except Exception:
        return None, JSONResponse(
            status_code=400,
            content={"error": {"message": "Invalid JSON body or aborted upload",
                               "type": "invalid_request_error"}},
        )


@router.get("/models")
async def list_models(request: Request):
    """List all available models.

    Returns both real model names (for agent mode) and virtual aliases
    (for KB ingestion mode).  Real models are collected from all candidate
    types — each unique model name appears once.
    """
    if not verify_proxy_auth(request):
        return JSONResponse(status_code=401, content={"error": "Invalid or missing proxy API key"})

    config = await get_config()

    # Only expose real Agent models from the dedicated agent_models map
    # (model-centric schema: {name: {keys: [...], upstream_model?}}).
    # KB ingestion virtual aliases (chat/embedding/reranker/ocr) are NOT
    # advertised here — ingestion tools configure them directly via examples.
    agent_models = config.get("agent_models") or {}
    if isinstance(agent_models, dict):
        real_models = set(agent_models.keys())
    else:  # defensive: un-migrated flat list
        real_models = {c.get("model") for c in agent_models if c.get("model")}

    data = []
    for model_id in sorted(m for m in real_models if m):
        data.append({
            "id": model_id,
            "object": "model",
            "owned_by": "llm-proxy",
        })

    return {"object": "list", "data": data}


@router.post("/reload")
async def reload_config(request: Request):
    """Force reload configuration from disk."""
    if not verify_proxy_auth(request):
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
    if not verify_proxy_auth(request):
        return JSONResponse(status_code=401, content={"error": "Invalid or missing proxy API key"})

    body, err = await _parse_json_body(request)
    if err:
        return err
    model_name = body.get("model", "")
    is_stream = body.get("stream", False)
    config = await get_config()
    kb_force_no_reasoning = False

    all_chat_candidates = config.get("candidates", {}).get("chat", [])

    if model_name == "chat":
        # ── KB ingestion mode ──────────────────────────────────────
        # Always disable thinking/reasoning for KB ingestion — this is
        # batch processing where reasoning adds latency without value.
        # Provider-specific injection is applied in build_request via
        # _disable_thinking_for_kb(): sensenova/tokenrhythm → reasoning_effort
        # "none" (thinking truly off), stepfun → "low" (lowest tier, "none"
        # not accepted), agnes → chat_template_kwargs (its own mechanism).
        kb_force_no_reasoning = True

        # KB ingestion is batch processing: always fast & non-streaming.
        # Answers are summary fragments consumed by the ingestion pipeline,
        # not interactive chat — streaming adds SSE parsing overhead and
        # thinking adds latency without value.  Hard-coded, no config switch.
        if is_stream:
            body["stream"] = False
            is_stream = False
        try:
            chat_timeout = max(1.0, float(config.get("chat_fast_timeout", 30)))
        except (ValueError, TypeError):
            chat_timeout = 30.0

        candidates_list = all_chat_candidates

    elif model_name in VIRTUAL_ALIASES:
        # Other virtual aliases are not valid for chat endpoint
        return _model_not_found_response(model_name)

    else:
        # ── Agent mode (real model name) ──────────────────────────
        # Model-centric routing: agent_models[model_name] is the entity, and
        # its ordered key bindings expand into the scheduler candidate list.
        # Each binding may carry its own upstream_model override; the
        # model-level value (defaulting to the public name) applies otherwise.
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

        # Agent mode: pass through the request body untouched except for
        # minimal provider-specific normalisation (applied in build_request
        # via _normalise_for_provider) that prevents 400 errors — e.g.
        # reasoning_effort="none" → "low" for StepFun, tool_choice object →
        # "auto" for TokenRhythm, and reasoning_format injection for StepFun.
        # Use the standard chat timeout.
        try:
            chat_timeout = max(1.0, float(config.get("upstream_timeout_chat", 120)))
        except (ValueError, TypeError):
            chat_timeout = 120.0

    if not candidates_list:
        return JSONResponse(
            status_code=503,
            content={"error": {"message": "No chat candidates configured", "type": "server_error"}},
        )

    # Build config copy with overridden settings
    config = copy.deepcopy(config)
    config["upstream_timeout"] = chat_timeout
    config["schedule_total_budget"] = _scale_budget(config, chat_timeout, len(candidates_list))
    config["candidates"] = {"chat": candidates_list}

    def build_request(cand, api_key, upstream_base_url):
        # Deep-copy to isolate nested objects (messages, tools, etc.) across
        # concurrent requests that may share the same cached body dict.
        out = copy.deepcopy(body)
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
            # first_chunk + remainder come from the scheduler, which pre-read
            # one chunk to verify the stream actually delivers data — replay
            # the chunk, then continue the SAME live iterator.
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
                config, "chat", build_request,
                handle_stream=handle_stream,
                is_stream=True,
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
        sr = await schedule(config, "chat", build_request)
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
    if not verify_proxy_auth(request):
        return JSONResponse(status_code=401, content={"error": "Invalid or missing proxy API key"})

    body, err = await _parse_json_body(request)
    if err:
        return err
    model_name = body.get("model", "")
    config = await get_config()

    all_emb_candidates = config.get("candidates", {}).get("embedding", [])

    if model_name == "embedding":
        # KB mode: use all embedding candidates
        candidates_list = all_emb_candidates
    elif model_name in VIRTUAL_ALIASES:
        return _model_not_found_response(model_name)
    else:
        # Agent mode: filter by model name
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

    config = copy.deepcopy(config)
    config["upstream_timeout"] = emb_timeout
    config["schedule_total_budget"] = _scale_budget(config, emb_timeout, len(candidates_list))
    config["candidates"] = {"embedding": candidates_list}

    def build_request(cand, api_key, upstream_base_url):
        out = copy.deepcopy(body)
        out["model"] = cand["model"]
        url = join_upstream(upstream_base_url, "embeddings")
        headers = {
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        }
        return "POST", url, headers, out

    try:
        sr = await schedule(config, "embedding", build_request)
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
    if not verify_proxy_auth(request):
        return JSONResponse(status_code=401, content={"error": "Invalid or missing proxy API key"})

    body, err = await _parse_json_body(request)
    if err:
        return err
    model_name = body.get("model", "")
    config = await get_config()

    all_rerank_candidates = config.get("candidates", {}).get("reranker", [])

    if model_name == "reranker":
        # KB mode: use all reranker candidates
        candidates_list = all_rerank_candidates
    elif model_name in VIRTUAL_ALIASES:
        return _model_not_found_response(model_name)
    else:
        # Agent mode: filter by model name
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

    config = copy.deepcopy(config)
    config["upstream_timeout"] = rerank_timeout
    config["schedule_total_budget"] = _scale_budget(config, rerank_timeout, len(candidates_list))
    config["candidates"] = {"reranker": candidates_list}

    def build_request(cand, api_key, upstream_base_url):
        out = copy.deepcopy(body)
        out["model"] = cand["model"]
        url = join_upstream(upstream_base_url, "rerank")
        headers = {
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        }
        return "POST", url, headers, out

    try:
        sr = await schedule(config, "reranker", build_request)
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
    if not verify_proxy_auth(request):
        return JSONResponse(status_code=401, content={"error": "Invalid or missing proxy API key"})

    body, err = await _parse_json_body(request)
    if err:
        return err
    img_b64 = body.get("image_base64")
    img_url = body.get("image_url")
    if not img_b64 and not img_url:
        return JSONResponse(status_code=400, content={"error": {"message": "Must provide image_base64 or image_url", "code": "missing_image"}})

    # Payload size guard: max 20MB base64 (approx 15MB binary)
    if img_b64 and len(img_b64) > 20 * 1024 * 1024:
        return JSONResponse(
            status_code=413,
            content={"error": {"message": "Image payload too large (max 20MB base64)", "code": "payload_too_large"}}
        )

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

    config = copy.deepcopy(config)
    config["upstream_timeout"] = ocr_timeout
    ocr_candidates = len(config.get("candidates", {}).get("ocr", []))
    config["schedule_total_budget"] = _scale_budget(config, ocr_timeout, ocr_candidates)

    try:
        sr = await schedule(config, "ocr", build_request)
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

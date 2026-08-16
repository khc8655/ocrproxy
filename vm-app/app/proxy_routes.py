"""
Proxy API routes: /v1/chat/completions, /v1/embeddings, /v1/rerank, /v1/ocr, /v1/models, /v1/reload

Two routing modes:
  1. KB ingestion mode (virtual alias): model="chat"/"embedding"/"reranker"/"ocr"
     - Uses all candidates of that type in configured order
     - Disables thinking/reasoning by default (chat)
     - Supports fast mode (force non-stream, shorter timeout)

  2. Agent mode (real model name): model="<actual model name from config>"
     - Filters candidates to those matching the requested model name
     - Fully transparent: passes through all request parameters untouched
     - Failover on 429/500 to other providers with the same model
     - Standard OpenAI-compatible interface

Chat relay optimisations:
  - Deep-copy request body to prevent cross-request mutation in concurrent scenarios.
  - Forward upstream error status + body to the client (instead of generic 503) so
    that agent frameworks receive meaningful error messages.
  - Full transparency: tools, tool_choice, reasoning_effort, reasoning_content,
    response_format, stream_options, and all other OpenAI-compatible fields are
    passed through untouched.  Streaming responses are forwarded as raw bytes so
    that provider-specific SSE fields (e.g. reasoning_content deltas from
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


def _error_response(exc: Exception) -> JSONResponse:
    """Build an error JSONResponse from an AllCandidatesFailedError or generic Exception."""
    if isinstance(exc, AllCandidatesFailedError):
        status = exc.last_status_code or 503
        if exc.last_response_body:
            try:
                body = json.loads(exc.last_response_body)
                return JSONResponse(status_code=status, content=body)
            except (json.JSONDecodeError, TypeError):
                pass
        return JSONResponse(
            status_code=status,
            content={"detail": str(exc), "errors": exc.errors},
        )
    return JSONResponse(status_code=503, content={"detail": str(exc)})


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
    exceeds typical client-side timeouts — the failover would be paid for but
    never observed.  An explicitly configured schedule_total_budget always wins."""
    computed = min(180.0, timeout * min(3, max(candidate_count, 1)))
    return max(float(config.get("schedule_total_budget", 15)), computed)


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

    # Collect all unique model names from all candidate types
    real_models: set[str] = set()
    for _type_name, cands in config.get("candidates", {}).items():
        for cand in cands:
            model_id = cand.get("model")
            if model_id:
                real_models.add(model_id)

    data = []
    # Real models (for agents) — sorted for consistent ordering
    for model_id in sorted(real_models):
        data.append({
            "id": model_id,
            "object": "model",
            "owned_by": "llm-proxy",
        })
    # Virtual aliases (for KB ingestion)
    for alias in ["chat", "embedding", "reranker", "ocr"]:
        data.append({
            "id": alias,
            "object": "model",
            "owned_by": "llm-proxy",
            "model_type": alias,
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

    body = await request.json()
    model_name = body.get("model", "")
    is_stream = body.get("stream", False)
    config = await get_config()

    all_chat_candidates = config.get("candidates", {}).get("chat", [])

    if model_name == "chat":
        # ── KB ingestion mode ──────────────────────────────────────
        # Always disable thinking/reasoning for KB ingestion — this is
        # batch processing where reasoning adds latency without value.
        body["reasoning_effort"] = "low"            # StepFun / OpenAI style
        body["enable_thinking"] = False              # Qwen3 / SenseNova style
        body["chat_template_kwargs"] = {             # vLLM / SiliconFlow style
            "enable_thinking": False,
        }

        fast_mode = bool(config.get("chat_fast_mode", False))
        if fast_mode:
            # Force non-stream for batch efficiency
            if is_stream:
                body["stream"] = False
                is_stream = False
            chat_timeout = float(config.get("chat_fast_timeout", 30))
        else:
            chat_timeout = float(config.get("upstream_timeout_chat", 120))

        candidates_list = all_chat_candidates

    elif model_name in VIRTUAL_ALIASES:
        # Other virtual aliases are not valid for chat endpoint
        return _model_not_found_response(model_name)

    else:
        # ── Agent mode (real model name) ──────────────────────────
        # Filter chat candidates to those matching the requested model.
        # This enables failover: if multiple providers/keys have the same
        # model configured, the scheduler will try them in order and
        # switch on 429/500.
        candidates_list = [c for c in all_chat_candidates if c.get("model") == model_name]

        if not candidates_list:
            return _model_not_found_response(model_name)

        # Agent mode: don't modify the request body at all.
        # Use the standard chat timeout.
        chat_timeout = float(config.get("upstream_timeout_chat", 120))

    if not candidates_list:
        return JSONResponse(
            status_code=503,
            content={"error": {"message": "No chat candidates configured", "type": "server_error"}},
        )

    # Build config copy with overridden settings
    config = dict(config)  # shallow copy to avoid mutating cached config
    config["upstream_timeout"] = chat_timeout
    config["schedule_total_budget"] = _scale_budget(config, chat_timeout, len(candidates_list))
    config["candidates"] = {"chat": candidates_list}

    def build_request(cand, api_key, upstream_base_url):
        # Deep-copy to isolate nested objects (messages, tools, etc.) across
        # concurrent requests that may share the same cached body dict.
        out = copy.deepcopy(body)
        out["model"] = cand["model"]
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
            return JSONResponse(status_code=503, content={"detail": str(e)})

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
        return JSONResponse(status_code=503, content={"detail": str(e)})


# ── Embeddings ──────────────────────────────────────────────────────

@router.post("/embeddings")
async def embeddings(request: Request):
    if not verify_proxy_auth(request):
        return JSONResponse(status_code=401, content={"error": "Invalid or missing proxy API key"})

    body = await request.json()
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
    emb_timeout = float(config.get("upstream_timeout_embedding", 60))
    config = dict(config)
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
        return JSONResponse(status_code=503, content={"detail": str(e)})


# ── Reranker ────────────────────────────────────────────────────────

@router.post("/rerank")
async def rerank(request: Request):
    if not verify_proxy_auth(request):
        return JSONResponse(status_code=401, content={"error": "Invalid or missing proxy API key"})

    body = await request.json()
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
    rerank_timeout = float(config.get("upstream_timeout_rerank", 30))
    config = dict(config)
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
        return JSONResponse(status_code=503, content={"detail": str(e)})


# ── OCR (KB only — not a standard OpenAI endpoint) ──────────────────

@router.post("/ocr")
async def ocr(request: Request):
    if not verify_proxy_auth(request):
        return JSONResponse(status_code=401, content={"error": "Invalid or missing proxy API key"})

    body = await request.json()
    img_b64 = body.get("image_base64")
    img_url = body.get("image_url")
    if not img_b64 and not img_url:
        return JSONResponse(status_code=400, content={"detail": "Must provide image_base64 or image_url"})

    prompt = body.get("prompt", "请识别图片中的所有文字内容，返回纯文本。")

    # Build the data-URL once and reuse the same string reference in every
    # failover attempt.  Python's string interning means all dict references
    # to `img` point to the same underlying buffer — no per-attempt copy.
    if img_url:
        img = img_url
    else:
        mime = "image/jpeg" if img_b64.startswith("/9j/") else "image/png"
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
    ocr_timeout = float(config.get("upstream_timeout_ocr", 60))
    config = dict(config)
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
        return JSONResponse(status_code=503, content={"detail": str(e)})

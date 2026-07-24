"""
Proxy API routes: /v1/chat/completions, /v1/embeddings, /v1/rerank, /v1/ocr, /v1/models, /v1/reload
Ported from EdgeOne cloud-functions/[[...all]].py.

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
import re
import urllib.parse
import httpx
from fastapi import APIRouter, Request
from fastapi.responses import StreamingResponse, JSONResponse

from .config_store import get_config, clear_cache
from .scheduler import schedule, AllCandidatesFailedError
from .auth import verify_proxy_auth

router = APIRouter(prefix="/v1")


def _join_upstream(base_url: str, path: str) -> str:
    """Build upstream URL, handling version paths automatically.

    Detects /v1, /v2, /v3, etc. at the end of base_url and does NOT
    append an extra /v1 in that case.  This supports providers like
    Volcano Engine (huoshan) whose base_url ends with /api/v3.
    """
    base = base_url.rstrip("/")
    if re.search(r"/v\d+$", base):
        return f"{base}/{path.lstrip('/')}"
    return f"{base}/v1/{path.lstrip('/')}"


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


@router.get("/models")
async def list_models(request: Request):
    if not verify_proxy_auth(request):
        return JSONResponse(status_code=401, content={"error": "Invalid or missing proxy API key"})
    return {"object": "list", "data": [
        {"id": "ocr", "object": "model", "owned_by": "llm-proxy", "model_type": "ocr"},
        {"id": "embedding", "object": "model", "owned_by": "llm-proxy", "model_type": "embedding"},
        {"id": "reranker", "object": "model", "owned_by": "llm-proxy", "model_type": "reranker"},
        {"id": "chat", "object": "model", "owned_by": "llm-proxy", "model_type": "chat"},
    ]}


@router.post("/reload")
async def reload_config(request: Request):
    """Force reload configuration from disk."""
    if not verify_proxy_auth(request):
        return JSONResponse(status_code=401, content={"error": "Unauthorized"})

    clear_cache()
    try:
        config = await get_config()
        return {
            "status": "ok",
            "message": "Configuration reloaded successfully.",
            "providers": list(config.get("providers", {}).keys())
        }
    except Exception as e:
        return JSONResponse(status_code=500, content={"error": f"Failed to reload config: {e}"})


@router.post("/chat/completions")
async def chat_completions(request: Request):
    if not verify_proxy_auth(request):
        return JSONResponse(status_code=401, content={"error": "Invalid or missing proxy API key"})

    body = await request.json()
    is_stream = body.get("stream", False)
    config = await get_config()

    # ── Fast mode (batch / summarisation) ──────────────────────────
    # When chat_fast_mode is enabled the proxy:
    #   1. Actively disables reasoning/thinking across all known provider
    #      parameter styles – saves 10-60s per request.
    #   2. Forces stream=false – the client gets a single JSON response
    #      instead of SSE chunks, which is more efficient for batch.
    #   3. Uses a shorter timeout (chat_fast_timeout, default 30s).
    fast_mode = bool(config.get("chat_fast_mode", False))
    if fast_mode:
        # Actively inject disable-reasoning parameters across all known
        # provider styles.  Unknown parameters are silently ignored by
        # OpenAI-compatible APIs, so it's safe to include them all.
        # NOTE: StepFun only supports low/medium/high (no "none"), so we
        # use "low" which cuts reasoning tokens by ~56%.
        body["reasoning_effort"] = "low"            # StepFun / OpenAI style
        body["enable_thinking"] = False             # Qwen3 / SenseNova style
        body["chat_template_kwargs"] = {            # vLLM / SiliconFlow style
            "enable_thinking": False,
        }
        # Force non-stream
        if is_stream:
            body["stream"] = False
            is_stream = False

    # Chat / reasoning models (e.g. DeepSeek-R1) need much longer timeouts
    # than the default 12s.  In fast mode we use a shorter timeout since
    # there is no reasoning step.
    if fast_mode:
        chat_timeout = float(config.get("chat_fast_timeout", 30))
    else:
        chat_timeout = float(config.get("upstream_timeout_chat", 120))
    config = dict(config)  # shallow copy to avoid mutating cached config
    config["upstream_timeout"] = chat_timeout
    # Budget must allow at least 3 failover attempts, but also scale with
    # the number of candidates so that 15 candidates aren't cut off after
    # just 2 timeouts.
    chat_candidates = len(config.get("candidates", {}).get("chat", []))
    config["schedule_total_budget"] = max(
        float(config.get("schedule_total_budget", 15)),
        chat_timeout * min(3, chat_candidates),  # at least 3 attempts, capped
    )

    def build_request(cand, api_key, upstream_base_url):
        # Deep-copy to isolate nested objects (messages, tools, etc.) across
        # concurrent requests that may share the same cached body dict.
        out = copy.deepcopy(body)
        out["model"] = cand["model"]
        url = _join_upstream(upstream_base_url, "chat/completions")
        headers = {
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        }
        return "POST", url, headers, out

    if is_stream:
        async def handle_stream(resp: httpx.Response):
            async def event_generator():
                try:
                    async for chunk in resp.aiter_bytes():
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
    except Exception as e:
        return JSONResponse(status_code=503, content={"detail": str(e)})


@router.post("/embeddings")
async def embeddings(request: Request):
    if not verify_proxy_auth(request):
        return JSONResponse(status_code=401, content={"error": "Invalid or missing proxy API key"})

    body = await request.json()
    config = await get_config()

    def build_request(cand, api_key, upstream_base_url):
        out = copy.deepcopy(body)
        out["model"] = cand["model"]
        url = _join_upstream(upstream_base_url, "embeddings")
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
    except Exception as e:
        return JSONResponse(status_code=503, content={"detail": str(e)})


@router.post("/rerank")
async def rerank(request: Request):
    if not verify_proxy_auth(request):
        return JSONResponse(status_code=401, content={"error": "Invalid or missing proxy API key"})

    body = await request.json()
    config = await get_config()

    def build_request(cand, api_key, upstream_base_url):
        out = copy.deepcopy(body)
        out["model"] = cand["model"]
        url = _join_upstream(upstream_base_url, "rerank")
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
    except Exception as e:
        return JSONResponse(status_code=503, content={"detail": str(e)})


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

    # Release the original body dict early so its copy of the base64 string
    # can be GC'd before the upstream request is sent.  After this point only
    # `img` and `prompt` are needed.
    del body

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
        url = _join_upstream(upstream_base_url, "chat/completions")
        headers = {
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        }
        return "POST", url, headers, chat_body

    # OCR / vision models need a longer timeout than chat
    ocr_timeout = float(config.get("upstream_timeout_ocr", 60))
    config_copy = dict(config)
    config_copy["upstream_timeout"] = ocr_timeout
    # Budget scales with candidate count: allow at least 3 failover attempts.
    ocr_candidates = len(config.get("candidates", {}).get("ocr", []))
    config_copy["schedule_total_budget"] = max(
        float(config_copy.get("schedule_total_budget", 15)),
        ocr_timeout * min(3, ocr_candidates),
    )

    try:
        sr = await schedule(config_copy, "ocr", build_request)
        resp = JSONResponse(content=sr.data)
        resp.headers["X-Routed-Via"] = urllib.parse.quote(sr.routed_via)
        resp.headers["X-Fallback-Attempts"] = str(sr.fallback_attempts)
        return resp
    except AllCandidatesFailedError as e:
        return _error_response(e)
    except Exception as e:
        return JSONResponse(status_code=503, content={"detail": str(e)})

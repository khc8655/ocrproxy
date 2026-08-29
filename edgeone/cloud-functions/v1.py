"""
v1.py — Cloud Function (Python 3.10 / FastAPI) for long-context fallback.

This is the *secondary* path — use only when:
  1. The V8 Edge Function returns 413 (body > 1 MB), OR
  2. The caller knows upfront they're sending > 1 MB.

Routing: this file lives at `cloud-functions/v1.py`, so the file-system
prefix is `/v1`.  EdgeOne strips the prefix before dispatching to FastAPI,
so the routes below are relative paths.

Why a Python function exists at all if V8 covers 90% of traffic?
  - 6 MB body limit (vs 1 MB) covers long-context chat (200K+ tokens)
  - 120 s upstream timeout (vs 200 ms CPU + 15-300 s fetch) for slow models
  - Keeps the V8 path simple — it never has to worry about 5xx from
    "request too large".

Trade-off: Cloud Functions run on Tencent Cloud data-center egress IPs,
NOT edge node IPs.  So this path does NOT amplify free-tier key usage the
way the V8 path does.  That's an intentional trade — long-context users
are by definition sending fewer requests, so IP diversity matters less.
"""

import os
import json
import time
import random
import logging
from typing import Optional, AsyncGenerator

import httpx
from fastapi import FastAPI, Request, Header
from fastapi.responses import JSONResponse, StreamingResponse

# ---- Config (env only — Python Cloud Functions cannot use EdgeOne KV) ---
def _load_config() -> dict:
    raw = os.environ.get("AGENT_CONFIG_JSON") or os.environ.get("AGENT_CONFIG")
    if not raw:
        raise RuntimeError(
            "AGENT_CONFIG_JSON env var is required. "
            "Set it in Makers console → Project → Functions → Environment Variables."
        )
    cfg = json.loads(raw) if isinstance(raw, str) else raw
    if "providers" not in cfg or "agent_models" not in cfg:
        raise RuntimeError("Config must contain 'providers' and 'agent_models'.")
    return cfg


CONFIG: dict = _load_config()
PROXY_API_KEY: Optional[str] = os.environ.get("PROXY_API_KEY")
UPSTREAM_TIMEOUT_SEC = float(os.environ.get("UPSTREAM_TIMEOUT_SEC", "90"))
MAX_BODY_BYTES = 6 * 1024 * 1024  # EdgeOne Cloud Function hard limit

logging.basicConfig(level=logging.INFO)
log = logging.getLogger("agent-relay-cf")

app = FastAPI(title="OCRProxy Agent Relay (Cloud Function fallback)")


# ---- Provider normalizations (mirror lib/normalize.js) -----------------
_PROVIDERS_NO_NONE_EFFORT = {"stepfun"}
_PROVIDERS_NO_OBJECT_TOOL_CHOICE = {"tokenrhythm"}


def _normalise_for_provider(body: dict, provider: str) -> None:
    if provider in _PROVIDERS_NO_NONE_EFFORT:
        if body.get("reasoning_effort") == "none":
            body["reasoning_effort"] = "low"
    if provider in _PROVIDERS_NO_OBJECT_TOOL_CHOICE:
        tc = body.get("tool_choice")
        if isinstance(tc, dict):
            body["tool_choice"] = "auto"
    if provider == "stepfun" and "reasoning_format" not in body:
        body["reasoning_format"] = "deepseek-style"


# ---- Auth ---------------------------------------------------------------
def _check_auth(authorization: Optional[str]) -> Optional[JSONResponse]:
    if not PROXY_API_KEY:
        return None
    expected = f"Bearer {PROXY_API_KEY}"
    if authorization != expected:
        return JSONResponse(
            status_code=401,
            content={
                "error": {
                    "type": "authentication_error",
                    "message": "Missing or invalid Authorization header.",
                    "code": "invalid_api_key",
                }
            },
            headers={"www-authenticate": "Bearer"},
        )
    return None


# ---- Binding resolution -------------------------------------------------
def _list_bindings(model: str) -> list:
    entry = CONFIG.get("agent_models", {}).get(model)
    if not entry or not isinstance(entry.get("keys"), list):
        return []
    out = []
    for k in entry["keys"]:
        if not isinstance(k, dict):
            continue
        provider = k.get("provider")
        key_label = k.get("key")
        if not provider or not key_label:
            continue
        if not CONFIG["providers"].get(provider, {}).get("keys", {}).get(key_label):
            continue
        out.append(
            {
                "provider": provider,
                "key_label": key_label,
                "upstream_model": k.get("upstream_model") or model,
            }
        )
    return out


def _pick_binding(bindings: list) -> Optional[dict]:
    if not bindings:
        return None
    if len(bindings) == 1:
        return bindings[0]
    return random.choice(bindings)


def _resolve(binding: dict) -> dict:
    provider = CONFIG["providers"][binding["provider"]]
    return {
        "api_key": provider["keys"][binding["key_label"]],
        "base_url": (provider.get("base_url") or "").rstrip("/"),
        "upstream_model": binding["upstream_model"],
    }


# ---- Global httpx client (per-isolate, reused) -------------------------
_http_client: Optional[httpx.AsyncClient] = None


def _get_client() -> httpx.AsyncClient:
    global _http_client
    if _http_client is None or _http_client.is_closed:
        _http_client = httpx.AsyncClient(
            timeout=httpx.Timeout(UPSTREAM_TIMEOUT_SEC, connect=10.0),
            limits=httpx.Limits(
                max_connections=40, max_keepalive_connections=10, keepalive_expiry=30.0
            ),
        )
    return _http_client


# ---- Streaming SSE relay -----------------------------------------------
async def _stream_upstream(
    client: httpx.AsyncClient,
    method: str,
    url: str,
    headers: dict,
    body: bytes,
    request: Request,
) -> AsyncGenerator[bytes, None]:
    """Async generator that proxies the upstream response body.  Detects
    client disconnect and closes the upstream stream cleanly."""
    try:
        async with client.stream(method, url, headers=headers, content=body) as resp:
            # Buffer at 8 KB — large enough to amortize overhead, small
            # enough that TTFB stays snappy.
            async for chunk in resp.aiter_bytes(chunk_size=8192):
                if await request.is_disconnected():
                    log.info("client disconnected, closing upstream")
                    break
                yield chunk
    except httpx.HTTPError as e:
        log.warning(f"upstream stream error: {e}")
        # Don't yield anything — the client will see a truncated stream.
        # We've already returned headers / status before this generator
        # is consumed, so there's no clean way to swap to JSON.
        return


# ---- /v1/chat/completions ---------------------------------------------
@app.post("/chat/completions")
async def chat_completions(
    request: Request,
    authorization: Optional[str] = Header(default=None),
):
    start = time.time()
    auth_err = _check_auth(authorization)
    if auth_err:
        return auth_err

    # ---- Body (6 MB limit, 1 MB beyond what V8 allows) ----
    body_bytes = await request.body()
    if len(body_bytes) > MAX_BODY_BYTES:
        return JSONResponse(
            status_code=413,
            content={
                "error": {
                    "type": "invalid_request_error",
                    "message": f"Body is {len(body_bytes)} bytes; max 6 MB on this endpoint.",
                    "code": "body_too_large",
                }
            },
        )

    try:
        body = json.loads(body_bytes)
    except Exception as e:
        return JSONResponse(
            status_code=400,
            content={"error": {"type": "invalid_request_error", "message": f"Invalid JSON: {e}"}},
        )

    if not isinstance(body, dict):
        return JSONResponse(
            status_code=400,
            content={"error": {"type": "invalid_request_error", "message": "Body must be an object."}},
        )
    model = body.get("model")
    if not model or not isinstance(model, str):
        return JSONResponse(
            status_code=400,
            content={"error": {"type": "invalid_request_error", "message": "Field 'model' is required."}},
        )

    # ---- Pick key ----
    bindings = _list_bindings(model)
    if not bindings:
        return JSONResponse(
            status_code=404,
            content={
                "error": {
                    "type": "invalid_request_error",
                    "message": f"Model '{model}' is not configured on this relay.",
                }
            },
        )
    binding = _pick_binding(bindings)
    try:
        resolved = _resolve(binding)
    except Exception as e:
        return JSONResponse(status_code=500, content={"error": {"type": "config_error", "message": str(e)}})

    # ---- Build upstream request ----
    upstream_body = json.loads(json.dumps(body))  # deep copy
    upstream_body["model"] = resolved["upstream_model"]
    _normalise_for_provider(upstream_body, binding["provider"])

    url = f"{resolved['base_url']}/chat/completions"
    headers = {
        "authorization": f"Bearer {resolved['api_key']}",
        "content-type": "application/json",
        "accept": "text/event-stream" if body.get("stream") else "application/json",
    }
    if request.headers.get("x-request-id"):
        headers["x-request-id"] = request.headers.get("x-request-id")

    # ---- Send & stream ----
    client = _get_client()
    try:
        # We use a "send" + manual stream rather than client.stream
        # so we can read the status code and content-type up front
        # for non-2xx passthrough.
        req = client.build_request(
            "POST", url, headers=headers, content=json.dumps(upstream_body).encode("utf-8")
        )
        upstream_resp = await client.send(req, stream=True)
    except httpx.HTTPError as e:
        return JSONResponse(
            status_code=502,
            content={"error": {"type": "upstream_error", "message": f"Upstream fetch failed: {e}"}},
        )

    # Forward status + headers
    resp_headers = {}
    upstream_ct = upstream_resp.headers.get("content-type")
    if upstream_ct:
        resp_headers["content-type"] = upstream_ct
    resp_headers["cache-control"] = "no-store"
    resp_headers["x-edgeone-relay"] = "py-cf-1"
    resp_headers["x-edgeone-routed-via"] = f"{binding['provider']}/{binding['key_label']}"
    resp_headers["x-edgeone-relay-latency-ms"] = str(int((time.time() - start) * 1000))

    return StreamingResponse(
        _stream_upstream(
            client,
            "POST",
            url,
            headers,
            json.dumps(upstream_body).encode("utf-8"),
            request,
        ),
        status_code=upstream_resp.status_code,
        headers=resp_headers,
    )


# ---- /v1/models --------------------------------------------------------
@app.get("/models")
async def list_models(authorization: Optional[str] = Header(default=None)):
    auth_err = _check_auth(authorization)
    if auth_err:
        return auth_err
    return {
        "object": "list",
        "data": [
            {
                "id": m,
                "object": "model",
                "created": int(time.time()),
                "owned_by": "edgeone-agent-relay-py",
            }
            for m in CONFIG["agent_models"].keys()
        ],
    }

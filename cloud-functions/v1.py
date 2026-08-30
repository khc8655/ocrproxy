import os
import json
import time
import random
import logging
from typing import Optional, AsyncGenerator

import httpx
from fastapi import FastAPI, Request, Header
from fastapi.responses import JSONResponse, StreamingResponse
from fastapi.middleware.cors import CORSMiddleware

logging.basicConfig(level=logging.INFO)
log = logging.getLogger("v1-relay")

app = FastAPI(title="OCRProxy V1 Relay")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

PROXY_API_KEY = os.environ.get("PROXY_API_KEY", "3q0xqZ7bes6lDUgltZg8uoj6LwXzMpcpwpIQ9wZh")
UPSTREAM_TIMEOUT_SEC = float(os.environ.get("UPSTREAM_TIMEOUT_SEC", "90"))

_cached_config = None
_cached_time = 0

async def get_config() -> dict:
    global _cached_config, _cached_time
    now = time.time()
    if _cached_config and (now - _cached_time < 30):
        return _cached_config

    raw = os.environ.get("AGENT_CONFIG_JSON") or os.environ.get("AGENT_CONFIG")
    if raw:
        try:
            cfg = json.loads(raw) if isinstance(raw, str) else raw
            _cached_config = cfg.get("config", cfg)
            _cached_time = now
            return _cached_config
        except Exception as e:
            log.warning(f"Failed to parse AGENT_CONFIG_JSON: {e}")

    # Fallback to fetching /api/config
    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            resp = await client.get(
                "https://api.khc6.cn/api/config",
                headers={"Authorization": f"Bearer {PROXY_API_KEY}"}
            )
            if resp.status_code == 200:
                data = resp.json()
                _cached_config = data.get("config", data)
                _cached_time = now
                return _cached_config
    except Exception as e:
        log.warning(f"Failed to fetch /api/config: {e}")

    return _cached_config or {"providers": {}, "agent_models": {}}


def _check_auth(authorization: Optional[str]) -> Optional[JSONResponse]:
    if not PROXY_API_KEY:
        return None
    if not authorization or not authorization.startswith("Bearer "):
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
    token = authorization[7:].strip()
    if token != PROXY_API_KEY:
        return JSONResponse(
            status_code=401,
            content={
                "error": {
                    "type": "authentication_error",
                    "message": "Incorrect API key provided.",
                    "code": "invalid_api_key",
                }
            },
            headers={"www-authenticate": "Bearer"},
        )
    return None


def _normalise_for_provider(body: dict, provider: str) -> dict:
    body = dict(body)
    p = (provider or "").lower()
    
    # StepFun
    if p == "stepfun":
        if body.get("reasoning_effort") == "none":
            body["reasoning_effort"] = "low"
        if "reasoning_format" not in body:
            body["reasoning_format"] = "deepseek-style"

    # TokenRhythm
    if p == "tokenrhythm":
        if isinstance(body.get("tool_choice"), dict):
            body["tool_choice"] = "auto"

    # Agnes AI
    if p == "agnes" or str(body.get("model", "")).lower().startswith("agnes"):
        if "reasoning_effort" in body:
            effort = str(body["reasoning_effort"]).lower()
            body.setdefault("chat_template_kwargs", {})
            if "enable_thinking" not in body["chat_template_kwargs"]:
                body["chat_template_kwargs"]["enable_thinking"] = (effort not in ("none", "false"))
            del body["reasoning_effort"]

    return body


async def _handle_models(authorization: Optional[str]):
    auth_err = _check_auth(authorization)
    if auth_err:
        return auth_err

    config = await get_config()
    models = []
    created_ts = int(time.time())
    for m in (config.get("agent_models") or {}).keys():
        models.append({
            "id": m,
            "object": "model",
            "created": created_ts,
            "owned_by": "ocrproxy",
        })

    return JSONResponse(
        content={"object": "list", "data": models},
        headers={"cache-control": "no-store"}
    )


@app.get("/models")
@app.get("/v1/models")
async def get_models(authorization: Optional[str] = Header(default=None)):
    return await _handle_models(authorization)


@app.post("/chat/completions")
@app.post("/v1/chat/completions")
async def post_chat_completions(
    request: Request,
    authorization: Optional[str] = Header(default=None)
):
    auth_err = _check_auth(authorization)
    if auth_err:
        return auth_err

    try:
        body = await request.json()
    except Exception as e:
        return JSONResponse(
            status_code=400,
            content={"error": {"type": "invalid_request_error", "message": f"Malformed JSON: {e}"}}
        )

    model_name = body.get("model")
    if not model_name:
        return JSONResponse(
            status_code=400,
            content={"error": {"type": "invalid_request_error", "message": "Field 'model' is required."}}
        )

    config = await get_config()
    model_entry = (config.get("agent_models") or {}).get(model_name)
    if not model_entry or not model_entry.get("keys"):
        return JSONResponse(
            status_code=404,
            content={"error": {"type": "invalid_request_error", "message": f"Model '{model_name}' not found."}}
        )

    bindings = []
    for k in model_entry["keys"]:
        provider = k.get("provider")
        key_label = k.get("key")
        if not provider or not key_label:
            continue
        prov_info = (config.get("providers") or {}).get(provider, {})
        api_key = (prov_info.get("keys") or {}).get(key_label)
        if not api_key:
            continue
        base_url = (prov_info.get("base_url") or "").rstrip("/")
        bindings.append({
            "provider": provider,
            "key_label": key_label,
            "api_key": api_key,
            "base_url": base_url,
            "upstream_model": k.get("upstream_model") or model_name,
        })

    if not bindings:
        return JSONResponse(
            status_code=503,
            content={"error": {"type": "service_unavailable", "message": "No valid keys configured for model."}}
        )

    is_stream = bool(body.get("stream", False))
    client = httpx.AsyncClient(timeout=httpx.Timeout(UPSTREAM_TIMEOUT_SEC, connect=10.0))

    for idx, binding in enumerate(bindings):
        norm_body = _normalise_for_provider(body, binding["provider"])
        norm_body["model"] = binding["upstream_model"]
        
        url = binding["base_url"]
        if not url.endswith("/v1"):
            chat_url = f"{url}/v1/chat/completions"
        else:
            chat_url = f"{url}/chat/completions"

        headers = {
            "Authorization": f"Bearer {binding['api_key']}",
            "Content-Type": "application/json",
            "Accept": "text/event-stream" if is_stream else "application/json",
        }

        try:
            if is_stream:
                req = client.build_request("POST", chat_url, headers=headers, json=norm_body)
                resp = await client.send(req, stream=True)
                if resp.status_code >= 400 and idx < len(bindings) - 1:
                    await resp.aclose()
                    continue

                async def sse_gen():
                    try:
                        async for chunk in resp.aiter_bytes():
                            yield chunk
                    finally:
                        await resp.aclose()
                        await client.aclose()

                return StreamingResponse(
                    sse_gen(),
                    status_code=resp.status_code,
                    media_type="text/event-stream",
                    headers={"cache-control": "no-store", "x-accel-buffering": "no"}
                )
            else:
                resp = await client.post(chat_url, headers=headers, json=norm_body)
                if resp.status_code >= 400 and idx < len(bindings) - 1:
                    continue
                await client.aclose()
                return JSONResponse(
                    content=resp.json() if resp.headers.get("content-type", "").startswith("application/json") else {"text": resp.text},
                    status_code=resp.status_code,
                    headers={"cache-control": "no-store"}
                )
        except Exception as e:
            if idx < len(bindings) - 1:
                continue
            await client.aclose()
            return JSONResponse(
                status_code=502,
                content={"error": {"type": "bad_gateway", "message": f"Upstream error: {e}"}}
            )

    await client.aclose()
    return JSONResponse(
        status_code=500,
        content={"error": {"type": "internal_error", "message": "Failed to contact upstream."}}
    )

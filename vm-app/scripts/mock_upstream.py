#!/usr/bin/env python3
"""
Mock upstream LLM server for load-testing ocrproxy locally.

Behaviour is driven by the model name in the request body:
  m429*           -> always HTTP 429
  moderation*     -> HTTP 400 content-moderation style error body
  deadstream*     -> stream=True gets HTTP 200 but zero bytes (dead stream)
  everything else -> normal OpenAI-style response (JSON or SSE)

Runtime knobs via POST /__set {"delay": 0.4, "resp_kb": 1024}
(and read back from GET /__stats together with request counters).
"""
import asyncio
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, StreamingResponse

app = FastAPI()

_counts = {"chat": 0, "embeddings": 0, "rerank": 0, "dead_stream": 0,
           "moderation_400": 0, "rate_limited_429": 0}
_last_bodies = {}
_settings = {"delay": 0.2, "resp_kb": 512}


@app.get("/__stats")
async def stats():
    return {
        "counts": dict(_counts),
        "settings": dict(_settings),
        "last_bodies": {k: {kk: vv for kk, vv in v.items() if kk != "messages"}
                        for k, v in _last_bodies.items()},
    }


@app.post("/__set")
async def set_cfg(request: Request):
    body = await request.json()
    _settings.update(body)
    return {"ok": True, "settings": dict(_settings)}


@app.get("/v1/models")
async def models():
    return {"object": "list", "data": [{"id": "mock", "object": "model"}]}


def _big_content() -> str:
    return "x" * (_settings["resp_kb"] * 1024)


@app.post("/v1/chat/completions")
async def chat(request: Request):
    body = await request.json()
    model = body.get("model", "")
    auth = request.headers.get("authorization", "")
    _last_bodies[model] = {k: v for k, v in body.items() if k != "messages"}
    _counts["chat"] += 1

    # Behaviour is keyed off the API key so that agent-mode failover tests
    # (same model name sent to several providers) can mix broken and healthy
    # candidates.
    if "sk-dead429" in auth:
        _counts["rate_limited_429"] += 1
        return JSONResponse(status_code=429, content={"error": {"message": "rate limited", "type": "rate_limit"}})

    if "sk-mod-" in auth:
        _counts["moderation_400"] += 1
        return JSONResponse(status_code=400, content={
            "error": {"message": "your request was rejected by content moderation: sensitive content detected",
                      "code": "content_filter"}})

    if body.get("stream"):
        if "sk-deadstream" in auth:
            _counts["dead_stream"] += 1

            async def empty():
                # yields nothing -> HTTP 200 with zero stream bytes
                return
                yield
            return StreamingResponse(empty(), media_type="text/event-stream")

        async def sse():
            await asyncio.sleep(_settings["delay"])
            yield b'data: {"id":"1","choices":[{"delta":{"content":"hello"}}]}\n\n'
            yield b"data: [DONE]\n\n"
        return StreamingResponse(sse(), media_type="text/event-stream")

    await asyncio.sleep(_settings["delay"])
    return {
        "id": "chatcmpl-mock", "object": "chat.completion", "model": model,
        "choices": [{"index": 0, "message": {"role": "assistant", "content": _big_content()},
                     "finish_reason": "stop"}],
        "usage": {"prompt_tokens": 10, "completion_tokens": 10, "total_tokens": 20},
    }


@app.post("/v1/embeddings")
async def embeddings(request: Request):
    body = await request.json()
    _counts["embeddings"] += 1
    await asyncio.sleep(_settings["delay"])
    n = 1
    inp = body.get("input")
    if isinstance(inp, list):
        n = len(inp)
    return {"object": "list", "model": body.get("model", "mock-emb"),
            "data": [{"object": "embedding", "index": i, "embedding": [0.1] * 8} for i in range(n)],
            "usage": {"prompt_tokens": 1, "total_tokens": 1}}


@app.post("/v1/rerank")
async def rerank(request: Request):
    _counts["rerank"] += 1
    await asyncio.sleep(_settings["delay"])
    return {"results": [{"index": 0, "relevance_score": 0.9}]}

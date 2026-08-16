#!/usr/bin/env python3
"""
Mock upstream LLM server for testing ocrproxy locally / on the VM.

Chat behaviour is driven by the request body and the API key:
  - Authorization contains "sk-dead429"    -> HTTP 429
  - Authorization contains "sk-mod-"       -> HTTP 400 content-moderation body
  - Authorization contains "sk-deadstream" -> stream=True gets 200 + 0 bytes
  - body contains "tools"                  -> tool_calls response (JSON, or SSE
                                              deltas when "stream" is true)
  - body has "stream": true                -> deterministic SSE with
                                              reasoning_content + content deltas
  - otherwise                              -> JSON response that ECHOES all
                                              non-messages request fields
                                              (used to verify passthrough)

Runtime knobs via POST /__set {"delay": 0.05, "resp_kb": 8,
                               "stream_gap": 0.02, "stream_chunks": 3}
GET /__stats returns request counters, settings and the last echoed bodies.
"""
import asyncio
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, StreamingResponse

app = FastAPI()

_counts = {"chat": 0, "embeddings": 0, "rerank": 0, "dead_stream": 0,
           "moderation_400": 0, "rate_limited_429": 0}
_last_bodies = {}
_settings = {"delay": 0.05, "resp_kb": 8, "stream_gap": 0.02, "stream_chunks": 3}


@app.get("/__stats")
async def stats():
    return {
        "counts": dict(_counts),
        "settings": dict(_settings),
        "last_bodies": {k: v for k, v in _last_bodies.items()},
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


def _echo(body: dict) -> dict:
    """Every request field except messages — tests assert these pass through
    the proxy untouched in agent mode (and are overridden in KB mode)."""
    return {k: v for k, v in body.items() if k != "messages"}


def _sse_stream(body: dict):
    """Deterministic SSE byte stream: reasoning deltas, content deltas,
    tool_call deltas (when tools were sent), then [DONE]."""
    model = body.get("model", "mock")
    gap = _settings["stream_gap"]
    n_chunks = _settings["stream_chunks"]

    async def gen():
        await asyncio.sleep(_settings["delay"])
        rid = f"chatcmpl-{model[:12]}"
        yield (f'data: {{"id":"{rid}","object":"chat.completion.chunk","model":"{model}","choices":['
               f'{{"index":0,"delta":{{"role":"assistant","reasoning_content":"thinking-1 "}},"finish_reason":null}}]}}\n\n').encode()
        await asyncio.sleep(gap)
        yield (f'data: {{"id":"{rid}","object":"chat.completion.chunk","model":"{model}","choices":['
               f'{{"index":0,"delta":{{"reasoning_content":"thinking-2"}},finish_reason":null}}]}}\n\n').encode()
        await asyncio.sleep(gap)
        for i in range(n_chunks):
            yield (f'data: {{"id":"{rid}","object":"chat.completion.chunk","model":"{model}","choices":['
                   f'{{"index":0,"delta":{{"content":"chunk-{i} "}},"finish_reason":null}}]}}\n\n').encode()
            await asyncio.sleep(gap)
        if "tools" in body:
            yield (f'data: {{"id":"{rid}","object":"chat.completion.chunk","model":"{model}","choices":['
                   f'{{"index":0,"delta":{{"tool_calls":[{{"index":0,"id":"call_mock_1","type":"function",'
                   f'"function":{{"name":"get_weather","arguments":"{{\\"city\\":\\"Beijing\\"}}"}}}}]}},"finish_reason":null}}]}}\n\n').encode()
            await asyncio.sleep(gap)
            yield (f'data: {{"id":"{rid}","object":"chat.completion.chunk","model":"{model}","choices":['
                   f'{{"index":0,"delta":{{}},"finish_reason":"tool_calls"}}]}}\n\n').encode()
        else:
            yield (f'data: {{"id":"{rid}","object":"chat.completion.chunk","model":"{model}","choices":['
                   f'{{"index":0,"delta":{{}},"finish_reason":"stop"}}]}}\n\n').encode()
        await asyncio.sleep(gap)
        yield b"data: [DONE]\n\n"
    return gen()


def _tool_calls_json_response(body: dict) -> dict:
    model = body.get("model", "mock")
    return {
        "id": "chatcmpl-tool", "object": "chat.completion", "model": model,
        "choices": [{
            "index": 0, "finish_reason": "tool_calls",
            "message": {
                "role": "assistant", "content": None,
                "tool_calls": [{
                    "id": "call_mock_1", "type": "function",
                    "function": {"name": "get_weather", "arguments": '{"city":"Beijing"}'},
                }],
            },
        }],
        "usage": {"prompt_tokens": 30, "completion_tokens": 10, "total_tokens": 40},
    }


@app.post("/v1/chat/completions")
async def chat(request: Request):
    body = await request.json()
    model = body.get("model", "")
    auth = request.headers.get("authorization", "")
    _last_bodies[model] = _echo(body)
    _counts["chat"] += 1

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
                return
                yield
            return StreamingResponse(empty(), media_type="text/event-stream")
        return StreamingResponse(_sse_stream(body), media_type="text/event-stream",
                                 headers={"X-Mock-Upstream": "sse"})

    if "tools" in body:
        await asyncio.sleep(_settings["delay"])
        return _tool_calls_json_response(body)

    await asyncio.sleep(_settings["delay"])
    return {
        "id": "chatcmpl-mock", "object": "chat.completion", "model": model,
        "echo": _echo(body),
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

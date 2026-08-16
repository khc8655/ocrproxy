#!/usr/bin/env python3
"""
Agent-mode relay test suite for ocrproxy.

Focus (per agent usage of the proxy): parameter passthrough fidelity for
thinking/reasoning levels, tool calling (JSON + streaming), streaming SSE
byte-fidelity (incl. reasoning_content deltas), agent_models routing,
/v1/models surface, and relay efficiency (RTT overhead, time-to-first-chunk,
concurrent streams).

Brings up mock upstream (127.0.0.1:9911) + the real app (127.0.0.1:8788)
with an isolated CONFIG_DIR, then runs:

  A. routing surface
     1. /v1/models lists ONLY agent_models entries (no KB aliases)
     2. KB alias "chat" still routes KB mode (thinking forced off + non-stream)
     3. unknown model -> 404 model_not_found
  B. thinking-level passthrough (agent mode must NOT touch the body)
     4. reasoning_effort=high / enable_thinking=true / chat_template_kwargs
        / temperature / top_p / max_tokens / user all echoed verbatim
     5. stream:false stays non-stream; stream:true passes through
  C. tool calling
     6. JSON tool_calls response intact (id/type/function name+arguments)
     7. streaming tool_call deltas byte-exact, finish_reason=tool_calls
  D. streaming fidelity
     8. full SSE body byte-identical to direct-to-upstream baseline
        (reasoning_content deltas preserved)
     9. X-Routed-Via / X-Fallback-Attempts headers present
  E. failover (agent_models list)
    10. 429 first candidate -> success via second, fallback=1
    11. dead stream (200 + 0 bytes) -> failover success
  F. efficiency
    12. RTT overhead vs direct: p50/p95/p99 over 60 sequential requests
    13. TTFB (first SSE byte) overhead vs direct
    14. 30 concurrent agent streams all complete byte-exact

Usage:  /path/to/venv/bin/python scripts/agent_test.py
"""
import asyncio
import json
import subprocess
import sys
import tempfile
import time
from pathlib import Path

import httpx
from cryptography.fernet import Fernet

REPO = Path(__file__).resolve().parent.parent
APP_PORT = 8788
MOCK_PORT = 9911
API = f"http://127.0.0.1:{APP_PORT}/v1"
MOCK = f"http://127.0.0.1:{MOCK_PORT}"
PROXY_KEY = "test-proxy-key-0000000000000000"

PASSED, FAILED = [], []


def check(name: str, ok: bool, detail: str = ""):
    (PASSED if ok else FAILED).append(name)
    print(f"  [{'PASS' if ok else 'FAIL'}] {name}" + (f" — {detail}" if detail else ""))


def build_config() -> dict:
    def provider(name: str, n_keys: int) -> dict:
        return {"base_url": MOCK, "keys": {f"k{i}": f"sk-{name}-{i}" for i in range(1, n_keys + 1)}}

    return {
        "upstream_timeout": 12,
        "schedule_total_budget": 15,
        "max_concurrency_per_key": 5,
        "cooldown_429_sec": 60,
        "upstream_timeout_chat": 120,
        "upstream_timeout_ocr": 30,
        "providers": {
            "mockA": provider("mockA", 5),
            "mockB": provider("mockB", 5),
            "dead429": provider("dead429", 1),
            "deadstream": provider("deadstream", 1),
            "deadstream2": provider("deadstream2", 1),
        },
        # Dedicated agent routing list (mirrors the v3.2 config schema)
        "agent_models": [
            {"provider": "dead429", "key": "k1", "model": "agent-main"},
            {"provider": "mockA", "key": "k1", "model": "agent-main"},
            {"provider": "deadstream", "key": "k1", "model": "agent-stream"},
            {"provider": "mockA", "key": "k2", "model": "agent-stream"},
            {"provider": "deadstream2", "key": "k1", "model": "agent-fail"},
            {"provider": "mockB", "key": "k3", "model": "agent-fail"},
            {"provider": "mockB", "key": "k1", "model": "deepseek-mock"},
            {"provider": "mockB", "key": "k2", "model": "deepseek-mock"},
        ],
        "candidates": {
            "chat": [{"provider": "mockA", "key": "k3", "model": "kb-chat-model"}],
            "embedding": [{"provider": "mockA", "key": "k4", "model": "mock-emb"}],
            "reranker": [{"provider": "mockA", "key": "k4", "model": "mock-rerank"}],
            "ocr": [{"provider": "mockA", "key": "k5", "model": "mock-ocr"}],
        },
    }


def start_procs(tmpdir: str):
    import os
    env = {
        **os.environ,
        "PROXY_API_KEY": PROXY_KEY,
        "ADMIN_PASSWORD": "test-admin",
        "ENCRYPT_KEY": Fernet.generate_key().decode(),
        "CONFIG_DIR": tmpdir,
    }
    fernet = Fernet(env["ENCRYPT_KEY"].encode())
    with open(os.path.join(tmpdir, "proxy_config.enc"), "wb") as f:
        f.write(fernet.encrypt(json.dumps(build_config()).encode()))

    mock = subprocess.Popen(
        [sys.executable, "-m", "uvicorn", "mock_upstream:app", "--port", str(MOCK_PORT), "--log-level", "warning"],
        cwd=str(REPO / "scripts"), env=env)
    app = subprocess.Popen(
        [sys.executable, "-m", "uvicorn", "app.main:app", "--host", "127.0.0.1", "--port", str(APP_PORT),
         "--workers", "1", "--log-level", "warning"],
        cwd=str(REPO), env=env)
    return mock, app


def wait_ready(url: str, proc: subprocess.Popen, timeout=30):
    deadline = time.time() + timeout
    while time.time() < deadline:
        if proc.poll() is not None:
            raise RuntimeError(f"process died early: {url}")
        try:
            httpx.get(url, timeout=1)
            return
        except Exception:
            time.sleep(0.3)
    raise RuntimeError(f"timeout waiting for {url}")


H = {"Authorization": f"Bearer {PROXY_KEY}"}

TOOLS = [{
    "type": "function",
    "function": {
        "name": "get_weather",
        "description": "Get current weather",
        "parameters": {"type": "object", "properties": {"city": {"type": "string"}}, "required": ["city"]},
    },
}]


def pct(sorted_times, p):
    idx = min(len(sorted_times) - 1, int(round((p / 100) * (len(sorted_times) - 1))))
    return sorted_times[idx]


async def read_stream(r: httpx.Response):
    buf = b""
    async for chunk in r.aiter_bytes():
        buf += chunk
    return buf


async def main():
    tmpdir = tempfile.mkdtemp(prefix="ocrproxy-agent-test-")
    mock, app = start_procs(tmpdir)
    try:
        wait_ready(f"{MOCK}/__stats", mock)
        wait_ready(f"http://127.0.0.1:{APP_PORT}/health", app)

        async with httpx.AsyncClient(timeout=60) as c:
            await c.post(f"{MOCK}/__set", json={"delay": 0.02, "resp_kb": 8, "stream_gap": 0.01, "stream_chunks": 3})

            print("\n== A. routing surface ==")
            r = await c.get(f"{API}/models", headers=H)
            ids = sorted(m["id"] for m in r.json()["data"])
            check("1. /v1/models = only agent_models", ids == ["agent-fail", "agent-main", "agent-stream", "deepseek-mock"], str(ids))

            r = await c.post(f"{API}/chat/completions", headers=H,
                             json={"model": "chat", "messages": [{"role": "user", "content": "hi"}], "stream": True})
            kb_echo = (await c.get(f"{MOCK}/__stats")).json()["last_bodies"].get("kb-chat-model", {})
            check("2. KB mode: forced non-stream + thinking off",
                  r.status_code == 200 and kb_echo.get("stream") is False
                  and kb_echo.get("enable_thinking") is False
                  and kb_echo.get("reasoning_effort") == "low", f"status={r.status_code} echo={kb_echo}")

            r = await c.post(f"{API}/chat/completions", headers=H,
                             json={"model": "no-such-model", "messages": [{"role": "user", "content": "hi"}]})
            check("3. unknown model -> 404 model_not_found",
                  r.status_code == 404 and r.json().get("error", {}).get("code") == "model_not_found")

            print("\n== B. thinking-level / parameter passthrough (agent) ==")
            req_body = {
                "model": "deepseek-mock",
                "messages": [{"role": "user", "content": "hi"}],
                "reasoning_effort": "high",              # OpenAI / StepFun style
                "enable_thinking": True,                 # Qwen3 / SenseNova style
                "chat_template_kwargs": {"enable_thinking": True},  # vLLM style
                "thinking": {"type": "enabled", "budget_tokens": 2048},  # Anthropic style
                "temperature": 0.13, "top_p": 0.97, "max_tokens": 777,
                "presence_penalty": 0.2, "frequency_penalty": 0.3, "user": "agent-001",
                "stop": ["\n\n"], "seed": 42, "n": 1, "logprobs": False,
            }
            r = await c.post(f"{API}/chat/completions", headers=H, json=req_body)
            echo = r.json().get("echo", {})
            expect = {k: v for k, v in req_body.items() if k != "messages"}
            bad = {k: (echo.get(k), v) for k, v in expect.items() if echo.get(k) != v}
            check("4. all params pass through byte-identical", r.status_code == 200 and not bad, f"diff={bad}")

            r = await c.post(f"{API}/chat/completions", headers=H,
                             json={"model": "agent-stream", "messages": [{"role": "user", "content": "hi"}],
                                   "stream": True, "enable_thinking": True})
            check("5. stream:true passes through (SSE delivered)", r.status_code == 200
                  and b"reasoning_content" in await read_stream(r))

            print("\n== C. tool calling ==")
            r = await c.post(f"{API}/chat/completions", headers=H, json={
                "model": "deepseek-mock", "messages": [{"role": "user", "content": "weather in beijing?"}],
                "tools": TOOLS, "tool_choice": "auto"})
            msg = r.json()["choices"][0]["message"]
            tc = (msg.get("tool_calls") or [{}])[0]
            check("6. JSON tool_calls intact",
                  r.status_code == 200 and r.json()["choices"][0]["finish_reason"] == "tool_calls"
                  and tc.get("type") == "function" and tc.get("id")
                  and tc.get("function", {}).get("name") == "get_weather"
                  and json.loads(tc.get("function", {}).get("arguments", "{}")) == {"city": "Beijing"},
                  f"tc={tc}")

            r = await c.post(f"{API}/chat/completions", headers=H, json={
                "model": "agent-stream", "messages": [{"role": "user", "content": "weather?"}],
                "tools": TOOLS, "tool_choice": "auto", "stream": True})
            body = await read_stream(r)
            has_tc_delta = b'"tool_calls"' in body and b"get_weather" in body
            has_done = body.rstrip().endswith(b"data: [DONE]")
            check("7. streaming tool_call deltas intact", r.status_code == 200 and has_tc_delta and has_done)

            print("\n== D. streaming fidelity ==")
            base_body = {"model": "agent-stream", "messages": [{"role": "user", "content": "hi"}],
                         "stream": True, "enable_thinking": True}
            direct = await c.post(f"{MOCK}/v1/chat/completions",
                                  headers={"Authorization": "Bearer sk-mockA-2"}, json=base_body)
            direct_bytes = await read_stream(direct)
            proxied = await c.post(f"{API}/chat/completions", headers=H, json=base_body)
            proxied_bytes = await read_stream(proxied)
            check("8. SSE byte-identical to direct upstream", proxied_bytes == direct_bytes,
                  f"len {len(proxied_bytes)} vs {len(direct_bytes)}")
            check("9. routing headers present",
                  bool(proxied.headers.get("X-Routed-Via")) and "X-Fallback-Attempts" in proxied.headers,
                  f"via={proxied.headers.get('X-Routed-Via')}")

            print("\n== E. failover on agent_models ==")
            r = await c.post(f"{API}/chat/completions", headers=H,
                             json={"model": "agent-main", "messages": [{"role": "user", "content": "hi"}]})
            check("10. 429 -> failover", r.status_code == 200 and r.headers.get("X-Fallback-Attempts") == "1",
                  f"status={r.status_code} attempts={r.headers.get('X-Fallback-Attempts')}")
            r = await c.post(f"{API}/chat/completions", headers=H, json={
                "model": "agent-fail", "messages": [{"role": "user", "content": "hi"}], "stream": True})
            sb = await read_stream(r)
            check("11. dead stream -> failover", r.status_code == 200 and b"[DONE]" in sb
                  and r.headers.get("X-Fallback-Attempts") == "1")

            print("\n== F. relay efficiency ==")
            await c.post(f"{MOCK}/__set", json={"delay": 0.0, "stream_gap": 0.005})
            plain = {"model": "deepseek-mock", "messages": [{"role": "user", "content": "hi"}]}

            async def timed_post(url, headers):
                t0 = time.perf_counter()
                rr = await c.post(url, headers=headers, json=plain)
                await rr.aread()
                return time.perf_counter() - t0

            # warm both paths
            for _ in range(5):
                await timed_post(f"{MOCK}/v1/chat/completions", {"Authorization": "Bearer sk-mockB-1"})
                await timed_post(f"{API}/chat/completions", H)
            direct_t = sorted([await timed_post(f"{MOCK}/v1/chat/completions", {"Authorization": "Bearer sk-mockB-1"})
                               for _ in range(60)])
            proxy_t = sorted([await timed_post(f"{API}/chat/completions", H) for _ in range(60)])
            ovh = [p - d for p, d in zip(proxy_t, direct_t)]
            print(f"  direct  p50={pct(direct_t,50)*1000:.1f}ms p95={pct(direct_t,95)*1000:.1f}ms")
            print(f"  proxy   p50={pct(proxy_t,50)*1000:.1f}ms p95={pct(proxy_t,95)*1000:.1f}ms")
            print(f"  overhead p50={pct(sorted(ovh),50)*1000:.1f}ms p95={pct(sorted(ovh),95)*1000:.1f}ms")
            check("12. RTT overhead p50 < 15ms", pct(sorted(ovh), 50) < 0.015,
                  f"p50={pct(sorted(ovh),50)*1000:.1f}ms p95={pct(sorted(ovh),95)*1000:.1f}ms")

            async def timed_first_chunk(url, headers):
                t0 = time.perf_counter()
                rr = await c.send(c.build_request("POST", url, headers=headers,
                                                  json={**base_body, "stream": True}), stream=True)
                it = rr.aiter_bytes()
                await anext(it)
                first = time.perf_counter() - t0
                async for _ in it:
                    pass
                await rr.aclose()
                return first

            for _ in range(3):
                await timed_first_chunk(f"{MOCK}/v1/chat/completions", {"Authorization": "Bearer sk-mockA-2"})
                await timed_first_chunk(f"{API}/chat/completions", H)
            d_first = sorted([await timed_first_chunk(f"{MOCK}/v1/chat/completions", {"Authorization": "Bearer sk-mockA-2"})
                              for _ in range(20)])
            p_first = sorted([await timed_first_chunk(f"{API}/chat/completions", H) for _ in range(20)])
            print(f"  TTFB direct p50={pct(d_first,50)*1000:.1f}ms  proxy p50={pct(p_first,50)*1000:.1f}ms")
            check("13. TTFB overhead p50 < 15ms", pct(p_first, 50) - pct(d_first, 50) < 0.015,
                  f"delta={(pct(p_first,50)-pct(d_first,50))*1000:.1f}ms")

            await c.post(f"{MOCK}/__set", json={"delay": 0.0, "stream_gap": 0.002, "stream_chunks": 5})
            ref = await c.post(f"{MOCK}/v1/chat/completions",
                               headers={"Authorization": "Bearer sk-mockA-2"}, json=base_body)
            ref_bytes = await read_stream(ref)
            results = await asyncio.gather(*[
                (lambda: c.post(f"{API}/chat/completions", headers=H, json=base_body))() for _ in range(30)])
            bodies = await asyncio.gather(*[read_stream(rr) for rr in results])
            ok_n = sum(1 for rr, b in zip(results, bodies) if rr.status_code == 200 and b == ref_bytes)
            check("14. 30 concurrent streams all byte-exact", ok_n == 30, f"ok={ok_n}/30")

    finally:
        for p in (app, mock):
            p.terminate()
            try:
                p.wait(timeout=5)
            except subprocess.TimeoutExpired:
                p.kill()

    print(f"\n===== {len(PASSED)} passed, {len(FAILED)} failed =====")
    if FAILED:
        print("FAILED:", FAILED)
        sys.exit(1)


if __name__ == "__main__":
    asyncio.run(main())

#!/usr/bin/env python3
"""End-to-end behaviour test: a real VM server in front of a real mock upstream.

Covers (no mocking of httpx / fastapi; real sockets):
  1. KB: 10 concurrent chat calls on ONE key all run in parallel upstream
     (kb_max_concurrency_per_key default 16, was 5).
  2. Agent: client headers (anthropic-beta, user-agent) reach the upstream on
     /v1/messages and /v1/chat/completions; credentials / forwarding headers do not.
  3. Agent sticky: a single transient 429 is retried on the SAME key; following
     turns stay on that key (prompt cache kept).
  4. Agent: 8 concurrent sessions all stay on the sticky key (no local per-key
     cap -> no spill to another key).
  5. reasoning.enabled is untouched unless the adapter file declares
     sanitization.strip_reasoning_enabled.

Needs vm-app/requirements.txt installed.
"""
import asyncio
import json
import os
import socket
import subprocess
import sys
import tempfile
import time
from pathlib import Path

import httpx
from cryptography.fernet import Fernet

ROOT = Path(__file__).resolve().parent.parent
VM = ROOT / "vm-app"

MOCK_UPSTREAM = r'''
import asyncio, json
from starlette.applications import Starlette
from starlette.responses import JSONResponse
from starlette.routing import Route
S = {"inflight": 0, "peak": 0, "log": [], "fail429": {}}
async def handle(req):
    body = await req.body()
    auth = req.headers.get("authorization", "")
    S["log"].append({"path": req.url.path, "auth": auth, "headers": dict(req.headers), "body": json.loads(body or b"{}")})
    n = S["fail429"].get(auth, 0)
    if n > 0:
        S["fail429"][auth] = n - 1
        return JSONResponse({"error": {"message": "rate limited"}}, status_code=429, headers={"retry-after": "1"})
    S["inflight"] += 1; S["peak"] = max(S["peak"], S["inflight"])
    try:
        await asyncio.sleep(1.0)
    finally:
        S["inflight"] -= 1
    if req.url.path.endswith("/messages"):
        return JSONResponse({"id": "m", "type": "message", "role": "assistant", "model": "x",
                             "content": [{"type": "text", "text": "ok"}], "stop_reason": "end_turn",
                             "usage": {"input_tokens": 1, "output_tokens": 1}})
    return JSONResponse({"id": "c", "object": "chat.completion",
                         "choices": [{"index": 0, "message": {"role": "assistant", "content": "ok"}, "finish_reason": "stop"}],
                         "usage": {"prompt_tokens": 1, "completion_tokens": 1}})
async def state(req): return JSONResponse(S)
async def reset(req):
    d = await req.json(); S.update(inflight=0, peak=0, log=[], fail429=d.get("fail429", {})); return JSONResponse({"ok": 1})
app = Starlette(routes=[Route("/v1/chat/completions", handle, methods=["POST"]),
                        Route("/v1/messages", handle, methods=["POST"]),
                        Route("/state", state), Route("/reset", reset, methods=["POST"])])
'''


def _free_port():
    s = socket.socket(); s.bind(("127.0.0.1", 0)); p = s.getsockname()[1]; s.close(); return p


def _wait(url, timeout=20):
    t = time.time()
    while time.time() - t < timeout:
        try:
            httpx.get(url, timeout=1, trust_env=False)
            return
        except Exception:
            time.sleep(0.2)
    raise RuntimeError(f"server did not start: {url}")


def _write_config(env, mode, up_port, extra_rules=None):
    code = (
        "import sys,asyncio,json;sys.path.insert(0,%r);from app import config_store;"
        "asyncio.run(config_store.save_config(json.loads(sys.argv[1])))" % str(VM)
    )
    prov = {"base_url": f"http://127.0.0.1:{up_port}/v1", "anthropic_base_url": f"http://127.0.0.1:{up_port}/v1",
            "protocols": ["chat", "messages"], "keys": {"k1": "sk-1", "k2": "sk-2"},
            "adapter_rules": extra_rules or {"reasoning": {"strategy": "openai_passthrough"}}}
    cfg = {"run_mode": mode, "proxy_api_key": "pk", "providers": {"up": prov},
           "candidates": {"chat": [{"provider": "up", "key": "k1", "model": "m"}]},
           "agent_models": {"claude": {"keys": [{"provider": "up", "key": "k1"}, {"provider": "up", "key": "k2"}],
                                       "upstream_model": "claude-up"}}}
    subprocess.run([sys.executable, "-c", code, json.dumps(cfg)], env=env, check=True)


async def _run(vm, up, env, up_port):
    H = {"Authorization": "Bearer pk"}
    async with httpx.AsyncClient(timeout=60, trust_env=False) as c:
        # ---- KB: 10 concurrent on one key
        _write_config(env, "kb", up_port)
        await c.post(f"{vm}/v1/reload", headers=H)
        await c.post(f"{up}/reset", json={})
        t0 = time.time()
        rs = await asyncio.gather(*[c.post(f"{vm}/v1/chat/completions", headers=H,
                                           json={"model": "chat", "messages": [{"role": "user", "content": "你好"}]})
                                    for _ in range(10)])
        dt = time.time() - t0
        st = (await c.get(f"{up}/state")).json()
        assert all(r.status_code == 200 for r in rs), [r.status_code for r in rs]
        assert st["peak"] == 10, f"KB upstream peak concurrency {st['peak']} != 10"
        assert dt < 1.9, f"KB 10 concurrent took {dt:.1f}s (serialised?)"
        print(f"  PASS: KB 10 concurrent on one key -> upstream peak {st['peak']}, wall {dt:.1f}s")

        # ---- Agent
        _write_config(env, "agent", up_port)
        await c.post(f"{vm}/v1/reload", headers=H)

        # header passthrough
        await c.post(f"{up}/reset", json={})
        r = await c.post(f"{vm}/v1/messages", headers={**H, "anthropic-version": "2023-06-01",
                                                       "anthropic-beta": "context-1m-2025-08-07",
                                                       "user-agent": "claude-cli/9.9", "x-forwarded-for": "1.2.3.4",
                                                       "cookie": "a=b"},
                         json={"model": "claude", "max_tokens": 10, "messages": [{"role": "user", "content": "hi"}]})
        r2 = await c.post(f"{vm}/v1/chat/completions", headers={**H, "x-session-id": "s-1", "user-agent": "cline/1"},
                          json={"model": "claude", "messages": [{"role": "user", "content": "hi"}],
                                "reasoning": {"enabled": True}})
        st = (await c.get(f"{up}/state")).json()
        assert r.status_code == 200 and r2.status_code == 200, (r.status_code, r2.status_code, r.text[:200])
        h1, h2 = st["log"][0]["headers"], st["log"][1]["headers"]
        assert h1.get("anthropic-beta") == "context-1m-2025-08-07", h1
        assert h1.get("user-agent") == "claude-cli/9.9", h1
        assert "x-forwarded-for" not in h1 and "cookie" not in h1, h1
        assert h1.get("authorization") == "Bearer sk-1" and h1.get("x-api-key") == "sk-1", h1
        assert h2.get("x-session-id") == "s-1" and h2.get("user-agent") == "cline/1", h2
        assert st["log"][1]["body"].get("reasoning") == {"enabled": True}, st["log"][1]["body"]
        print("  PASS: client headers (anthropic-beta / user-agent / session id) relayed; credentials & forwarding headers dropped")
        print("  PASS: reasoning.enabled untouched without strip_reasoning_enabled in the adapter file")

        # one transient 429 on the sticky key -> same-key retry, stay on k1
        await c.post(f"{up}/reset", json={"fail429": {"Bearer sk-1": 1}})
        seq = []
        for _ in range(3):
            r = await c.post(f"{vm}/v1/chat/completions", headers=H,
                             json={"model": "claude", "messages": [{"role": "user", "content": "turn"}]})
            seq.append((r.status_code, r.headers.get("x-routed-via")))
        assert seq == [(200, "up/k1")] * 3, seq
        print(f"  PASS: single 429 retried on the same key, all turns stay on k1: {seq}")

        # 8 concurrent sessions stay on the sticky key
        await c.post(f"{up}/reset", json={})
        rs = await asyncio.gather(*[c.post(f"{vm}/v1/chat/completions", headers=H,
                                           json={"model": "claude", "messages": [{"role": "user", "content": f"s{i}"}]})
                                    for i in range(8)])
        via = [r.headers.get("x-routed-via") for r in rs]
        assert via == ["up/k1"] * 8, via
        print("  PASS: 8 concurrent agent sessions all on the sticky key (no spill)")

        # adapter-declared strip still works
        _write_config(env, "agent", up_port, extra_rules={"reasoning": {"strategy": "openai_passthrough"},
                                                          "sanitization": {"strip_reasoning_enabled": True}})
        await c.post(f"{vm}/v1/reload", headers=H)
        await c.post(f"{up}/reset", json={})
        await c.post(f"{vm}/v1/chat/completions", headers=H,
                     json={"model": "claude", "messages": [{"role": "user", "content": "x"}],
                           "reasoning": {"enabled": True, "effort": "low"}})
        st = (await c.get(f"{up}/state")).json()
        assert st["log"][0]["body"].get("reasoning") == {"effort": "low"}, st["log"][0]["body"]
        print("  PASS: strip_reasoning_enabled declared in the adapter file removes only reasoning.enabled")


def main():
    tmp = tempfile.mkdtemp(prefix="relay-e2e-")
    up_port, vm_port = _free_port(), _free_port()
    env = {**os.environ, "CONFIG_DIR": tmp, "ENCRYPT_KEY": Fernet.generate_key().decode(),
           "PROXY_API_KEY": "pk", "ADMIN_PASSWORD": "adm", "APP_PORT": str(vm_port), "APP_HOST": "127.0.0.1",
           "NO_PROXY": "127.0.0.1,localhost", "no_proxy": "127.0.0.1,localhost"}
    Path(tmp, "mock_upstream.py").write_text(MOCK_UPSTREAM)
    _write_config(env, "kb", up_port)
    procs = [
        subprocess.Popen([sys.executable, "-m", "uvicorn", "mock_upstream:app", "--port", str(up_port), "--log-level", "warning"],
                         cwd=tmp, env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL),
        subprocess.Popen([sys.executable, "run_server.py"], cwd=str(VM), env=env,
                         stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL),
    ]
    try:
        up, vm = f"http://127.0.0.1:{up_port}", f"http://127.0.0.1:{vm_port}"
        _wait(f"{up}/state"); _wait(f"{vm}/v1/models")
        print("=== relay passthrough / KB concurrency / agent sticky (real servers) ===")
        asyncio.run(_run(vm, up, env, up_port))
        print("ALL PASS")
    finally:
        for p in procs:
            p.terminate()
        for p in procs:
            try:
                p.wait(timeout=5)
            except Exception:
                p.kill()


if __name__ == "__main__":
    main()

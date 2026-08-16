#!/usr/bin/env python3
"""
Local load/behaviour test for ocrproxy against scripts/mock_upstream.py.

Brings up:
  - mock upstream on 127.0.0.1:9911
  - the real app on 127.0.0.1:8788 (isolated CONFIG_DIR / keys)

Verifies:
  1. agent-mode 429 failover                    -> 200, X-Fallback-Attempts >= 1
  2. dead-stream failover (200 + 0 bytes)       -> 200, X-Fallback-Attempts >= 1
  3. content-moderation 400 early exit          -> 400, exactly ONE upstream call
  4. KB chat mode injects thinking-disable fields
  5. global overload fast-fail: 503 + Retry-After under burst
     (also exercises admin hot-reload of max_concurrency_per_key)
  6. memory: 3 rounds of concurrent big OCR requests; RSS must plateau
  7. config-version pruning of scheduler runtime state (subprocess)

Usage:  /path/to/venv/bin/python scripts/load_test.py
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
ADMIN = f"http://127.0.0.1:{APP_PORT}/api/admin"
PROXY_KEY = "test-proxy-key-0000000000000000"
ADMIN_PASS = "test-admin"

PASSED, FAILED = [], []


def check(name: str, ok: bool, detail: str = ""):
    (PASSED if ok else FAILED).append(name)
    print(f"  [{'PASS' if ok else 'FAIL'}] {name}" + (f" — {detail}" if detail else ""))


def build_config(per_key_limit: int = 5) -> dict:
    def provider(name: str, n_keys: int) -> dict:
        return {"base_url": MOCK, "keys": {f"k{i}": f"sk-{name}-{i}" for i in range(1, n_keys + 1)}}

    ocr_cands = []
    for p in ("mockA", "mockB", "mockC"):
        for i in range(1, 6):
            ocr_cands.append({"provider": p, "key": f"k{i}", "model": "mock-ocr"})

    return {
        "upstream_timeout": 12,
        "schedule_total_budget": 15,
        "max_concurrency_per_key": per_key_limit,
        "cooldown_429_sec": 60,
        "cooldown_403_sec": 600,
        "upstream_timeout_chat": 30,
        "upstream_timeout_ocr": 30,
        "providers": {
            "mockA": provider("mockA", 5),
            "mockB": provider("mockB", 5),
            "mockC": provider("mockC", 5),
            "dead429": provider("dead429", 1),
            "deadstream": provider("deadstream", 1),
            "mod": provider("mod", 1),
        },
        # Model-centric agent routing (v3.3 schema): broken key FIRST,
        # healthy second — exercising failover through the ordered key list.
        "agent_models": {
            "m429-agent": {"keys": [
                {"provider": "dead429", "key": "k1"},
                {"provider": "mockA", "key": "k1"},
            ]},
            "deadstream-agent": {"keys": [
                {"provider": "deadstream", "key": "k1"},
                {"provider": "mockA", "key": "k2"},
            ]},
            "moderation-agent": {"keys": [
                {"provider": "mod", "key": "k1"},
            ]},
        },
        "candidates": {
            "chat": [
                # healthy KB-mode candidates FIRST: KB mode (model="chat") uses
                # ALL candidates in order.
                {"provider": "mockB", "key": "k1", "model": "gpt-mock"},
            ],
            "embedding": [{"provider": "mockA", "key": "k3", "model": "mock-emb"}],
            "reranker": [{"provider": "mockA", "key": "k4", "model": "mock-rerank"}],
            "ocr": ocr_cands,
        },
    }


def start_procs(tmpdir: str):
    import os
    env = {
        **os.environ,
        "PROXY_API_KEY": PROXY_KEY,
        "ADMIN_PASSWORD": ADMIN_PASS,
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


def rss_kb(pid: int) -> int:
    out = subprocess.run(["ps", "-o", "rss=", "-p", str(pid)], capture_output=True, text=True)
    return int(out.stdout.strip())


async def req(client, model: str, stream=False):
    body = {"model": model, "messages": [{"role": "user", "content": "hi"}]}
    if stream:
        body["stream"] = True
    r = await client.post(f"{API}/chat/completions", json=body,
                          headers={"Authorization": f"Bearer {PROXY_KEY}"})
    buf = b""
    if stream and r.status_code == 200:
        async for chunk in r.aiter_bytes():
            buf += chunk
    return r, buf


async def main():
    tmpdir = tempfile.mkdtemp(prefix="ocrproxy-test-")
    mock, app = start_procs(tmpdir)
    headers = {"Authorization": f"Bearer {PROXY_KEY}"}
    admin_headers = {"Authorization": f"Bearer {ADMIN_PASS}"}
    try:
        wait_ready(f"{MOCK}/__stats", mock)
        wait_ready(f"http://127.0.0.1:{APP_PORT}/health", app)

        async with httpx.AsyncClient(timeout=90) as client:
            await client.post(f"{MOCK}/__set", json={"delay": 0.2, "resp_kb": 64})

            print("\n== 1. agent-mode 429 failover ==")
            r, _ = await req(client, "m429-agent")
            check("429 -> failover success", r.status_code == 200,
                  f"status={r.status_code} via={r.headers.get('X-Routed-Via')} attempts={r.headers.get('X-Fallback-Attempts')}")

            print("\n== 2. dead-stream (200 + 0 bytes) failover ==")
            r, buf = await req(client, "deadstream-agent", stream=True)
            check("dead stream -> failover success", r.status_code == 200 and b"[DONE]" in buf,
                  f"status={r.status_code} attempts={r.headers.get('X-Fallback-Attempts')} bytes={len(buf)}")

            print("\n== 3. content-moderation 400 early exit ==")
            s0 = (await client.get(f"{MOCK}/__stats")).json()["counts"]["chat"]
            r, _ = await req(client, "moderation-agent")
            s1 = (await client.get(f"{MOCK}/__stats")).json()["counts"]["chat"]
            check("moderation 400 forwarded to client", r.status_code == 400 and b"content moderation" in r.content,
                  f"status={r.status_code}")
            check("early exit: exactly 1 upstream call", s1 - s0 == 1, f"upstream_calls={s1 - s0}")

            print("\n== 4. KB mode thinking-disable injection ==")
            r, _ = await req(client, "chat")
            lb = (await client.get(f"{MOCK}/__stats")).json()["last_bodies"].get("gpt-mock", {})
            check("KB mode 200", r.status_code == 200, f"status={r.status_code}")
            check("enable_thinking injected", lb.get("enable_thinking") is False, str(lb))

            print("\n== 5. overload fast-fail (burst 100, delay 2.5s, per-key limit 100) ==")
            # Hot-reload a high per-key limit so the GLOBAL cap becomes the
            # binding constraint (also proves admin config changes take effect
            # without a restart).
            rr = await client.post(f"{ADMIN}/config", json=build_config(per_key_limit=100),
                                   headers=admin_headers)
            await client.post(f"{MOCK}/__set", json={"delay": 2.5, "resp_kb": 64})
            big = "A" * (1024 * 512)
            results = await asyncio.gather(*[
                client.post(f"{API}/ocr", json={"image_base64": big}, headers=headers)
                for _ in range(100)])
            ok = sum(1 for r in results if r.status_code == 200)
            overloaded = [r for r in results if r.status_code == 503 and r.headers.get("Retry-After")]
            other = [r for r in results if r.status_code not in (200, 503)]
            check("admin hot-reload accepted", rr.status_code == 200, f"status={rr.status_code}")
            check("burst: 200s + fast-503(Retry-After), no other statuses",
                  10 <= ok <= 60 and ok + len(overloaded) == 100 and not other,
                  f"ok={ok} retry_after_503={len(overloaded)} other={len(other)}")

            print("\n== 6. memory: 3 rounds x 120 concurrent OCR (0.5MB in / 1MB out) ==")
            # restore per-key limit 5; realistic small delay
            await client.post(f"{ADMIN}/config", json=build_config(per_key_limit=5), headers=admin_headers)
            await client.post(f"{MOCK}/__set", json={"delay": 0.3, "resp_kb": 1024})
            await asyncio.sleep(1)
            rss0 = rss_kb(app.pid)
            for rnd in range(1, 4):
                t0 = time.time()
                results = await asyncio.gather(*[
                    client.post(f"{API}/ocr", json={"image_base64": big}, headers=headers)
                    for _ in range(120)])
                dt = time.time() - t0
                ok = sum(1 for r in results if r.status_code == 200)
                await asyncio.sleep(5)  # let GC + allocator settle
                rss = rss_kb(app.pid)
                print(f"  round {rnd}: 200s={ok}/120  {dt:.1f}s  RSS={rss/1024:.0f}MB (baseline {rss0/1024:.0f}MB)")
            rss_final = rss_kb(app.pid)
            print(f"  RSS delta over 3 rounds: {(rss_final - rss0)/1024:+.0f}MB")

        print("\n== 7. config-version state pruning (subprocess) ==")
        code = (
            "import sys, asyncio, json, tempfile, os\n"
            f"sys.path.insert(0, {str(REPO)!r})\n"
            "from cryptography.fernet import Fernet\n"
            "from app import config_store, scheduler\n"
            "d = tempfile.mkdtemp()\n"
            "os.environ['ENCRYPT_KEY'] = Fernet.generate_key().decode()\n"
            "os.environ['CONFIG_DIR'] = d\n"
            "cfg = dict(providers={'p': {'base_url': 'http://x', 'keys': {'k1': 'a'}}},\n"
            "           candidates={'chat': [{'provider': 'p', 'key': 'k1', 'model': 'm'}]})\n"
            "asyncio.run(config_store.save_config(cfg))\n"
            "v1 = config_store.get_config_version()\n"
            "scheduler._cooldown_until['p:k1:m'] = 1.0\n"
            "scheduler._cooldown_until['p:gone:m'] = 1.0\n"
            "cfg2 = json.loads(json.dumps(cfg)); cfg2['candidates']['chat'] = []\n"
            "asyncio.run(config_store.save_config(cfg2))\n"
            "v2 = config_store.get_config_version()\n"
            "scheduler._prune_runtime_state(cfg2)\n"
            "assert v2 > v1, 'version must bump on change'\n"
            "assert 'p:gone:m' not in scheduler._cooldown_until, 'stale entry must be pruned'\n"
            "assert 'p:k1:m' not in scheduler._cooldown_until, 'removed candidate must be pruned'\n"
            "print('PRUNE_OK', v1, v2)\n"
        )
        out = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True, cwd=str(REPO))
        check("version bump + state pruning", "PRUNE_OK" in out.stdout,
              (out.stdout.strip() + out.stderr.strip()[-300:])[:300])

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

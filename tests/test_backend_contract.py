#!/usr/bin/env python3
"""Backend contract test: the SAME scenarios against VM and EdgeOne (shared/contracts/admin-ui-backend.json).

The shared admin UI is one copy; the two backends are written separately (Python process vs JS
isolates + KV). This test is what keeps them interchangeable: every scenario runs against
  * VM       — real vm-app server (run_server.py, agent mode)
  * EdgeOne  — real edge-function handlers served by tests/contract/eo_local_server.mjs (in-memory KV)
both in front of the same mock upstream, and the U1 scenario drives a real Chromium against each
console. Output is a side-by-side table; any FAIL exits 1.

Needs: vm-app/requirements.txt, node >= 18. U1 additionally needs playwright + chromium
(CHROMIUM_PATH=/usr/bin/chromium); without playwright U1 is reported SKIP.
"""
import asyncio
import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import textwrap
import time
from pathlib import Path

import httpx
from cryptography.fernet import Fernet

ROOT = Path(__file__).resolve().parent.parent
VM = ROOT / "vm-app"
CONTRACT = json.loads((ROOT / "shared" / "contracts" / "admin-ui-backend.json").read_text(encoding="utf-8"))
ADMIN_PW, PROXY_KEY = "contract-admin", "contract-pk"

MOCK = textwrap.dedent(r'''
    import asyncio, json
    from fastapi import FastAPI, Request
    from fastapi.responses import JSONResponse, StreamingResponse
    app = FastAPI()
    S = {"fail": {}}
    def _key(req):
        return (req.headers.get("authorization") or "").replace("Bearer ", "") or req.headers.get("x-api-key", "")
    def _failed(req):
        code = S["fail"].get(_key(req))
        if code:
            return JSONResponse({"error": {"message": "rate limit: too many requests", "type": "rate_limit"}}, status_code=code)
    @app.post("/ctl")
    async def ctl(req: Request):
        S["fail"] = (await req.json()).get("fail", {}); return {"ok": 1}
    @app.get("/v1/models")
    async def models(req: Request):
        return {"object": "list", "data": [{"id": m, "object": "model"} for m in ["mock-chat-1", "mock-chat-2"]]}
    @app.post("/v1/chat/completions")
    async def chat(req: Request):
        f = _failed(req)
        if f: return f
        b = await req.json()
        await asyncio.sleep(0.05)
        if b.get("stream"):
            async def gen():
                for t in ["po", "ng"]:
                    yield "data: " + json.dumps({"id": "x", "object": "chat.completion.chunk", "choices": [{"index": 0, "delta": {"content": t}}]}) + "\n\n"
                yield "data: [DONE]\n\n"
            return StreamingResponse(gen(), media_type="text/event-stream")
        return {"id": "x", "object": "chat.completion", "model": b.get("model"),
                "choices": [{"index": 0, "message": {"role": "assistant", "content": "ok"}, "finish_reason": "stop"}]}
    @app.post("/v1/messages")
    async def messages(req: Request):
        f = _failed(req)
        if f: return f
        await asyncio.sleep(0.05)
        return {"id": "m", "type": "message", "role": "assistant", "content": [{"type": "text", "text": "ok"}],
                "model": "mock-chat-1", "stop_reason": "end_turn", "usage": {"input_tokens": 1, "output_tokens": 1}}
''')


def free_port():
    s = socket.socket(); s.bind(("127.0.0.1", 0)); p = s.getsockname()[1]; s.close(); return p


def wait_http(url, timeout=25):
    t = time.time()
    while time.time() - t < timeout:
        try:
            httpx.get(url, timeout=1, trust_env=False); return True
        except Exception:
            time.sleep(0.2)
    return False


def config(mock_url):
    return {
        "run_mode": "agent", "proxy_api_key": PROXY_KEY,
        "providers": {"up": {"base_url": f"{mock_url}/v1", "anthropic_base_url": f"{mock_url}/v1",
                             "protocols": ["chat", "messages"], "keys": {"k1": "sk-k1", "k2": "sk-k2"}}},
        "agent_models": {"claude": {"upstream_model": "mock-chat-1",
                                    "keys": [{"provider": "up", "key": "k1"}, {"provider": "up", "key": "k2"}]}},
    }


def host_test_body(kind, binding, upstream_model, provider, agent_model):
    """Run the real shared/admin/js/host.js to get the body the UI sends for a manual test."""
    code = (
        "const vm=require('vm');const fs=require('fs');"
        "const g={__HOST_KIND__:process.argv[1],location:{pathname:'/'},document:{querySelector:()=>null,querySelectorAll:()=>[]}};"
        "vm.createContext(g);vm.runInContext(fs.readFileSync(process.argv[2],'utf8'),g);"
        "const a=JSON.parse(process.argv[3]);"
        "process.stdout.write(JSON.stringify({api:g.HOST.api,body:g.HOST.buildTestBody(a[0],a[1],a[2],a[3])}));"
    )
    out = subprocess.run(["node", "-e", code, kind, str(ROOT / "shared/admin/js/host.js"),
                          json.dumps([binding, upstream_model, provider, agent_model])],
                         capture_output=True, text=True, check=True).stdout
    return json.loads(out)


class Backend:
    def __init__(self, name, kind, base, console_path, upstream_url=""):
        self.name, self.kind, self.base, self.console_path = name, kind, base, console_path
        self.upstream_url = upstream_url
        self.results = {}

    def record(self, sid, ok, detail=""):
        self.results[sid] = ("PASS" if ok else "FAIL", detail)


async def run_api_scenarios(b: Backend, mock_url, c: httpx.AsyncClient):
    P = {"Authorization": f"Bearer {PROXY_KEY}"}
    A = {"Authorization": f"Bearer {ADMIN_PW}"}
    host = host_test_body(b.kind, {"provider": "up", "key": "k2"}, "mock-chat-1", "up", "claude")

    async def stats():
        r = await c.get(b.base + host["api"]["stats"], headers=A)
        return r.json() if r.status_code == 200 else {"_http": r.status_code}

    def entry(st, key):
        return (st.get("candidates_status") or {}).get(f"agent:claude:up:{key}")

    async def settle():
        await asyncio.sleep(0.3)

    await c.post(mock_url + "/ctl", json={"fail": {}})
    t0 = int(time.time() * 1000) - 5
    r = await c.post(b.base + "/v1/chat/completions", headers=P,
                     json={"model": "claude", "stream": True, "messages": [{"role": "user", "content": "hi"}]})
    await r.aread(); await settle()
    st = await stats(); e = entry(st, "k1")
    b.record("S1", r.status_code == 200 and bool(e) and e.get("status") == 200 and (e.get("latency_ms") or 0) > 0 and (e.get("time") or 0) >= t0,
             f"http={r.status_code} entry={e}")
    act = ((st.get("agent") or {}).get("active_keys") or {}).get("claude")
    b.record("S2", act in ("k1", "up:k1"), f"active_keys.claude={act!r}")

    t1 = int(time.time() * 1000) - 5
    r = await c.post(b.base + "/v1/messages", headers={**P, "anthropic-version": "2023-06-01"},
                     json={"model": "claude", "max_tokens": 5, "messages": [{"role": "user", "content": "hi"}]})
    await settle()
    e = entry(await stats(), "k1")
    gran = CONTRACT["endpoints"]["stats"]["time_granularity_ms"]
    b.record("S3", r.status_code == 200 and bool(e) and e.get("status") == 200 and (e.get("time") or 0) >= t1 - gran,
             f"http={r.status_code} entry={e}")
    return host


async def run_api_scenarios_after_ui(b: Backend, mock_url, c: httpx.AsyncClient, host):
    P = {"Authorization": f"Bearer {PROXY_KEY}"}
    A = {"Authorization": f"Bearer {ADMIN_PW}"}

    async def stats():
        r = await c.get(b.base + host["api"]["stats"], headers=A)
        return r.json() if r.status_code == 200 else {}

    await c.post(mock_url + "/ctl", json={"fail": {"sk-k1": 429}})
    r = await c.post(b.base + "/v1/chat/completions", headers=P,
                     json={"model": "claude", "messages": [{"role": "user", "content": "fresh session"}]})
    await asyncio.sleep(0.3)
    st = await stats(); cs = st.get("candidates_status") or {}
    e1, e2 = cs.get("agent:claude:up:k1"), cs.get("agent:claude:up:k2")
    act = ((st.get("agent") or {}).get("active_keys") or {}).get("claude")
    b.record("S4", r.status_code == 200 and bool(e1) and e1.get("status") == 429 and bool(e2) and e2.get("status") == 200
             and act in ("k2", "up:k2"), f"http={r.status_code} k1={e1} k2={e2} active={act!r}")
    await c.post(mock_url + "/ctl", json={"fail": {}})

    # S7: dashboard summary — VM keeps today's per-request totals, EdgeOne sends none
    summ = (st.get("agent") or {}).get("summary")
    if b.kind == "vm":
        ok7 = (isinstance(summ, dict) and summ.get("window") == "today"
               and bool(summ.get("date")) and summ.get("timezone") == "Asia/Shanghai"
               and (summ.get("requests") or 0) >= 3
               and isinstance(summ.get("failures"), int) and isinstance(summ.get("usage_requests"), int)
               and (summ.get("failovers") or 0) >= 1 and (summ.get("tokens_in") or 0) >= 1
               and isinstance(summ.get("models"), dict) and bool(summ["models"].get("claude"))
               and (summ.get("ttft_ms_avg") or 0) > 0 and (summ.get("total_ms_avg") or 0) > 0)
    else:
        ok7 = not (isinstance(summ, dict) and summ.get("window"))
    b.record("S7", ok7, f"summary={ {k: (summ or {}).get(k) for k in ('window', 'requests', 'failures', 'failovers', 'tokens_in', 'tokens_out', 'ttft_ms_avg')} }")

    t5 = int(time.time() * 1000) - 5
    r = await c.post(b.base + host["api"]["testKey"], headers=A, json=host["body"])
    d = r.json() if r.headers.get("content-type", "").startswith("application/json") else {}
    await asyncio.sleep(0.3)
    e = ((await stats()).get("candidates_status") or {}).get("agent:claude:up:k2")
    b.record("S5", bool(d.get("success") or d.get("ok")) and bool(e) and e.get("status") == 200 and (e.get("time") or 0) >= t5,
             f"body={host['body']} resp={ {k: d.get(k) for k in ('ok', 'success', 'status', 'error')} } entry={e}")

    r = await c.post(b.base + "/api/admin/probe-models", headers=A,
                     json={"provider": "up", "base_url": f"{b.upstream_url}/v1", "key_label": "k1", "key_labels": ["k1"]})
    d = r.json() if r.status_code == 200 else {"_http": r.status_code, "_text": r.text[:200]}
    ids = [m if isinstance(m, str) else (m or {}).get("id") for m in (d.get("models") or [])]
    b.record("S6", bool(d.get("ok")) and "mock-chat-1" in ids, f"ok={d.get('ok')} models={ids[:4]} err={d.get('error') or d.get('_text')}")


async def run_ui(b: Backend):
    try:
        from playwright.async_api import async_playwright
    except ImportError:
        for sid in ("U1", "U2", "U3"):
            b.results[sid] = ("SKIP", "playwright 未安装")
        return
    exe = os.environ.get("CHROMIUM_PATH") or shutil.which("chromium") or shutil.which("chromium-browser")
    async with async_playwright() as p:
        browser = await (p.chromium.launch(executable_path=exe, args=["--no-sandbox"]) if exe else p.chromium.launch())
        page = await browser.new_page()
        errors = []
        page.on("pageerror", lambda e: errors.append(str(e)))
        page.on("console", lambda m: errors.append(m.text) if m.type == "error" and "Failed to load resource" not in m.text else None)
        try:
            await page.goto(b.base + b.console_path)
            await page.fill("#loginKey", ADMIN_PW)
            await page.click("#loginOverlay button[type=submit]")
            await page.wait_for_function("document.getElementById('loginOverlay').style.display==='none'", timeout=10000)
            # what opening the Agent tab does on both consoles
            # (re-render until the console's own data load has landed)
            await page.wait_for_function(
                "(() => { if (typeof renderAgentModels === 'function') renderAgentModels();"
                " return (document.getElementById('agentModelsBox') || {}).innerHTML.includes('k1'); })()",
                timeout=10000, polling=300)
            # the per-key stats arrive in a separate request after config; wait for them too
            # (without this U1 was flaky on both backends), then assert on the final html below
            try:
                await page.wait_for_function(
                    "(() => { if (typeof renderAgentModels === 'function') renderAgentModels();"
                    " return (document.getElementById('agentModelsBox') || {}).innerHTML.includes('最近响应耗时'); })()",
                    timeout=8000, polling=300)
            except Exception:
                pass
            html = await page.evaluate("document.getElementById('agentModelsBox').innerHTML")
            # the k1 row: from its key badge to the next row
            i = html.find(">k1<")
            row = html[i:i + 4000] if i >= 0 else ""
            nxt = row.find(">k2<")
            row = row[:nxt] if nxt > 0 else row
            ok = ('最近响应耗时' in html[max(0, i - 4000):i] or '最近响应耗时' in row) and not errors
            b.record("U1", ok, "k1 行无耗时徽章（显示「未调用」）" if not ok else "")
            # U2: same UI, capability decides whether 「从中枢添加」 shows
            disp = await page.evaluate(
                "(() => { const p = state.config.providers.up; p.origin = 'vault'; openKeyModal('up');"
                " const d = getComputedStyle(document.getElementById('k_vault_section')).display;"
                " closeModal('keyModal'); return d; })()")
            want = "block" if b.kind == "vm" else "none"
            b.record("U2", disp == want, f"#k_vault_section display={disp}, 期望 {want}" if disp != want else "")
            # U3: dashboard Agent cards — VM shows today's totals, EdgeOne the snapshot.
            #     The snapshot numbers are asserted too: a key bound to several agent models
            #     must be counted once, so "可用 Key x / y" requires y == unique provider:key.
            info3 = await page.evaluate(
                "(() => { if (typeof renderDashboard === 'function') renderDashboard();"
                " const g = document.getElementById('agentStatsGrid');"
                " const models = (state.config && state.config.agent_models) || {};"
                " const ids = new Set();"
                " Object.entries(models).forEach(([m, cfg]) => (cfg.keys || []).forEach(b => {"
                "   if (b && b.provider && b.key) ids.add(b.provider + ':' + b.key); }));"
                " const text = g ? g.innerText : '';"
                " const mt = text.match(/\\/\\s*(\\d+)/);"
                " const summ = state.stats && state.stats.agent && state.stats.agent.summary;"
                " return { text, unique: ids.size, shownTotal: mt ? Number(mt[1]) : null,"
                "          summaryRequests: summ ? (summ.requests || 0) : null };"
                "})()")
            clean3 = "NaN" not in info3["text"] and "undefined" not in info3["text"]
            if b.kind == "vm":
                ok3 = ("今日 Token 总量" in info3["text"] and "失败请求" in info3["text"]
                       and info3["summaryRequests"] is not None and info3["summaryRequests"] >= 2 and clean3)
            else:
                ok3 = ("可用 Key" in info3["text"] and "冷却中" in info3["text"]
                       and info3["unique"] > 0 and info3["shownTotal"] == info3["unique"] and clean3)
            b.record("U3", ok3,
                     f"kind={b.kind} unique={info3['unique']} shownTotal={info3['shownTotal']} "
                     f"summaryRequests={info3['summaryRequests']} text={info3['text'][:160]!r}")
            if errors:
                b.results["U1"] = ("FAIL", "pageerror: " + "; ".join(errors[:2]))
        except Exception as e:
            b.record("U1", False, f"{type(e).__name__}: {str(e)[:160]}")
            for sid in ("U2", "U3"):
                if sid not in b.results:
                    b.results[sid] = ("SKIP", f"浏览器流程中断: {type(e).__name__}")
        finally:
            await browser.close()


async def drive(b: Backend, mock_url):
    async with httpx.AsyncClient(timeout=30, trust_env=False) as c:
        host = await run_api_scenarios(b, mock_url, c)
        await run_ui(b)
        await run_api_scenarios_after_ui(b, mock_url, c, host)


def main():
    tmp = Path(tempfile.mkdtemp(prefix="contract-"))
    mock_port, vm_port, eo_port = free_port(), free_port(), free_port()
    mock_url = f"http://127.0.0.1:{mock_port}"
    env = {**os.environ, "NO_PROXY": "127.0.0.1,localhost", "no_proxy": "127.0.0.1,localhost",
           "CONFIG_DIR": str(tmp / "vmcfg"), "ENCRYPT_KEY": Fernet.generate_key().decode(),
           "PROXY_API_KEY": PROXY_KEY, "ADMIN_PASSWORD": ADMIN_PW, "APP_PORT": str(vm_port), "APP_HOST": "127.0.0.1"}
    (tmp / "vmcfg").mkdir()
    (tmp / "mock_upstream.py").write_text(MOCK)
    cfg = config(mock_url)
    # EdgeOne never reaches a loopback upstream (its SSRF guard rejects it), so it gets a public-looking
    # hostname that the local harness maps to the mock (EDGE_HOST_MAP); the VM uses 127.0.0.1 directly.
    eo_mock_url = f"http://mock-upstream.example:{mock_port}"
    (tmp / "eo_config.json").write_text(json.dumps(config(eo_mock_url)))
    save = ("import sys,asyncio,json;sys.path.insert(0,%r);from app import config_store;"
            "asyncio.run(config_store.save_config(json.loads(sys.argv[1])))" % str(VM))
    subprocess.run([sys.executable, "-c", save, json.dumps(cfg)], env=env, check=True)
    logs = {n: open(tmp / f"{n}.log", "w") for n in ("mock", "vm", "eo")}
    procs = [
        subprocess.Popen([sys.executable, "-m", "uvicorn", "mock_upstream:app", "--port", str(mock_port), "--log-level", "warning"],
                         cwd=tmp, env=env, stdout=logs["mock"], stderr=subprocess.STDOUT),
        subprocess.Popen([sys.executable, "run_server.py"], cwd=VM, env=env, stdout=logs["vm"], stderr=subprocess.STDOUT),
        subprocess.Popen(["node", str(ROOT / "tests/contract/eo_local_server.mjs"), str(eo_port), str(tmp / "eo_config.json")],
                         env={**env, "EDGE_HOST_MAP": f"mock-upstream.example=127.0.0.1:{mock_port}"}, stdout=logs["eo"], stderr=subprocess.STDOUT),
    ]
    backends = [Backend("VM", "vm", f"http://127.0.0.1:{vm_port}", "/", mock_url),
                Backend("EdgeOne", "edgeone", f"http://127.0.0.1:{eo_port}", "/admin", eo_mock_url)]
    try:
        assert wait_http(mock_url + "/v1/models"), "mock upstream did not start"
        assert wait_http(backends[0].base + "/v1/models"), "VM did not start:\n" + (tmp / "vm.log").read_text()[-1500:]
        assert wait_http(backends[1].base + "/health"), "EdgeOne local server did not start:\n" + (tmp / "eo.log").read_text()[-1500:]
        for b in backends:
            asyncio.run(drive(b, mock_url))
    finally:
        for pr in procs:
            pr.terminate()
        for pr in procs:
            try: pr.wait(timeout=5)
            except Exception: pr.kill()
        if os.environ.get("CONTRACT_KEEP"):
            print("artifacts:", tmp)
        else:
            shutil.rmtree(tmp, ignore_errors=True)

    print("=== 后端契约测试（同一套场景，VM vs EdgeOne） ===")
    fails = 0
    for s in CONTRACT["scenarios"]:
        row = [f"{s['id']:<3} {s['title']}"]
        for b in backends:
            st, detail = b.results.get(s["id"], ("MISSING", ""))
            fails += st in ("FAIL", "MISSING")
            row.append(f"{b.name}={st}")
        print("  " + " | ".join(row))
        for b in backends:
            st, detail = b.results.get(s["id"], ("MISSING", ""))
            if st != "PASS" and detail:
                print(f"      {b.name}: {detail}")
    print("ALL PASS" if not fails else f"FAILED: {fails}")
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main())

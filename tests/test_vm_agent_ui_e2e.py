#!/usr/bin/env python3
"""
VM Agent 模式控制台 · 真实浏览器端到端测试 (离线、自包含)

与仓库里其它 UI 测试不同，本脚本不做字符串断言，而是：
  1. 本地起一个 OpenAI 兼容 Mock 上游 (http://127.0.0.1:<port>，含 /v1/models 与 /v1/chat/completions)；
  2. 用 scripts/init_config.py 生成全新加密配置，起真实 VM 服务 (run_server.py, RUN_MODE=agent)；
  3. 用 Chromium 真实点击：登录 → 新增供应商 → 新增 Key(在线校验) → 新增 Agent 模型(探测上游并点选) →
     单 Key 测 → 全部探活 → 实测 → 走 /v1/chat/completions 真实调用 → 概览统计；
  4. 全程收集 pageerror / console.error / 非预期 4xx-5xx，任何一个都判失败。

运行：
  pip install -r vm-app/requirements.txt playwright
  python3 -m playwright install chromium        # 或设置 CHROMIUM_PATH=/usr/bin/chromium
  python3 tests/test_vm_agent_ui_e2e.py

可选环境变量：CHROMIUM_PATH、E2E_KEEP=1 (保留临时目录与截图)、E2E_SHOTS=<dir> (截图目录)
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
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
VM = ROOT / "vm-app"

MOCK_SRC = textwrap.dedent('''
    import asyncio, json
    from fastapi import FastAPI, Request
    from fastapi.responses import JSONResponse, StreamingResponse
    app = FastAPI()
    MODELS = ["mock-chat-1", "mock-chat-2", "mock-reasoner"]
    def _bad(req):
        return "sk-bad" in (req.headers.get("authorization") or "")
    @app.get("/v1/models")
    async def models(req: Request):
        if _bad(req):
            return JSONResponse({"error": {"message": "invalid api key", "type": "invalid_request_error"}}, status_code=401)
        return {"object": "list", "data": [{"id": m, "object": "model"} for m in MODELS]}
    @app.post("/v1/chat/completions")
    async def chat(req: Request):
        if _bad(req):
            return JSONResponse({"error": {"message": "invalid api key", "type": "invalid_request_error"}}, status_code=401)
        b = await req.json()
        if b.get("stream"):
            async def gen():
                for t in ["po", "ng"]:
                    yield "data: " + json.dumps({"id": "x", "object": "chat.completion.chunk", "choices": [{"index": 0, "delta": {"content": t}}]}) + "\\n\\n"
                    await asyncio.sleep(0.02)
                yield "data: [DONE]\\n\\n"
            return StreamingResponse(gen(), media_type="text/event-stream")
        return {"id": "x", "object": "chat.completion", "model": b.get("model"),
                "choices": [{"index": 0, "message": {"role": "assistant", "content": "2"}, "finish_reason": "stop"}],
                "usage": {"prompt_tokens": 3, "completion_tokens": 1, "total_tokens": 4}}
''')

PASS, FAIL = [], []
# Local-only traffic: never route 127.0.0.1 through an ambient HTTP(S)_PROXY.
urllib.request.install_opener(urllib.request.build_opener(urllib.request.ProxyHandler({})))


def check(cond, name, detail=""):
    (PASS if cond else FAIL).append(name)
    print(("  ✓ " if cond else "  ✗ ") + name + ("" if cond else f"  -> {detail}"))


def free_port():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    p = s.getsockname()[1]
    s.close()
    return p


def wait_http(url, timeout=20):
    t0 = time.time()
    while time.time() - t0 < timeout:
        try:
            urllib.request.urlopen(url, timeout=2)
            return True
        except Exception:
            time.sleep(0.3)
    return False


def find_chromium():
    for c in (os.environ.get("CHROMIUM_PATH"), shutil.which("chromium"), shutil.which("chromium-browser"),
              shutil.which("google-chrome"), "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"):
        if c and os.path.exists(c):
            return c
    return None  # fall back to playwright-managed browser


async def run_ui(base, admin_pw, proxy_key, mock_url, shots):
    from playwright.async_api import async_playwright

    async with async_playwright() as p:
        exe = find_chromium()
        browser = await p.chromium.launch(executable_path=exe, args=["--no-sandbox"]) if exe else await p.chromium.launch()
        page = await browser.new_page(viewport={"width": 1440, "height": 900})
        js_errors, bad_http = [], []
        page.on("pageerror", lambda e: js_errors.append(str(e)))
        page.on("console", lambda m: js_errors.append(m.text) if m.type == "error" and "Failed to load resource" not in m.text else None)
        expected_4xx = {"/api/admin/verify-key"}  # the bad-key verification is expected to fail

        def on_resp(r):
            if "/api/" in r.url and r.status >= 400 and not any(x in r.url for x in expected_4xx):
                bad_http.append(f"{r.status} {r.request.method} {r.url}")
        page.on("response", on_resp)
        page.on("dialog", lambda d: asyncio.ensure_future(d.accept()))

        async def shot(name):
            if shots:
                await page.screenshot(path=str(Path(shots) / f"{name}.png"), full_page=True)

        async def modal_open(mid):
            return await page.evaluate(f"document.getElementById('{mid}').classList.contains('show')")

        # 1. login
        await page.goto(base + "/")
        await page.fill("#loginKey", admin_pw)
        await page.click("#loginOverlay button[type=submit]")
        await page.wait_for_function("document.getElementById('loginOverlay').style.display==='none' || !document.getElementById('loginOverlay').offsetParent", timeout=8000)
        mode_badge = await page.inner_text("#topModeBadge")
        check("Agent" in mode_badge, "登录后顶部显示 Agent 模式", mode_badge)

        # 2. provider
        await page.click("#topNav >> text=供应商")
        await page.click("#panel-providers >> text=新增供应商")
        await page.fill("#p_name", "mock")
        await page.fill("#p_url", mock_url)
        await page.click("#providerModal .modal-foot .btn-primary")
        await page.wait_for_function("!document.getElementById('providerModal').classList.contains('show')", timeout=8000)
        await shot("01_provider")
        check("💻 本地自建" in await page.inner_text("#panel-providers"), "本地供应商显示「本地自建」")

        # 3. keys: good key passes online verification, bad key is blocked with the real reason
        async def add_key(label, val):
            await page.click("#panel-providers >> text=+ Key")
            await page.fill("#k_label", label)
            await page.fill("#k_value", val)
            await page.click("#keyModal .modal-foot .btn-primary")
            await page.wait_for_timeout(1500)

        await add_key("主号", "sk-good-1")
        check(not await modal_open("keyModal"), "正确 Key 在线校验通过并保存 (http/内网上游已保存的 Base URL 允许校验)",
              await page.inner_text("#k_diag_box"))
        await add_key("坏号", "sk-bad-2")
        diag = await page.inner_text("#k_diag_box")
        check(await modal_open("keyModal") and ("401" in diag or "invalid" in diag.lower() or "失败" in diag),
              "错误 Key 被拦截且展示上游真实原因", diag)
        await page.check("#k_skip")
        await page.click("#keyModal .modal-foot .btn-primary")
        await page.wait_for_timeout(1200)
        check(not await modal_open("keyModal"), "勾选跳过校验后可强制保存")
        await shot("02_keys")
        chips = await page.eval_on_selector_all("#panel-providers .key-chip", "e=>e.map(x=>x.innerText.replace(/\\s+/g,' '))")
        check(len(chips) == 2 and all("本地" in c and "中枢" not in c for c in chips),
              "本地供应商下的 Key 标记为「本地」而非「中枢」", chips)

        # 4. agent model
        await page.click("#topNav >> text=模型及路由")
        await page.click("#panel-models >> text=+ 新增 Agent 模型")
        await page.wait_for_timeout(500)
        keylist = await page.inner_text("#a_keyList")
        check("主号" in keylist and "坏号" in keylist, "新增模型弹窗列出供应商下的全部 Key", keylist)
        await page.click("#btnProbeAgentModels")
        await page.wait_for_function("document.getElementById('probedListModal').classList.contains('show')", timeout=10000)
        items = await page.eval_on_selector_all("#probedModelsList [data-action='select-probed-model']", "e=>e.map(x=>x.dataset.model)")
        check("mock-chat-1" in items, "探测上游可用模型返回列表", items)
        await page.click("#probedModelsList [data-model='mock-chat-1']")
        check(await page.input_value("#a_name") == "mock-chat-1", "点选探测结果自动填入模型名")
        await page.click("#agentModal .modal-foot .btn-primary")
        await page.wait_for_timeout(1200)
        check(not await modal_open("agentModal"), "Agent 模型保存后关闭弹窗")
        await shot("03_model")
        box = await page.inner_text("#agentModelsBox")
        check("mock-chat-1" in box, "模型列表渲染出新模型", box[:200])

        # 5. per-key probe / probe all / live test
        el = page.locator("#agentModelsBox [data-action='probe-key']").first
        await el.click()
        await page.wait_for_timeout(2000)
        await shot("04_probe_key")
        probe_all_cnt = await page.locator("#agentModelsBox [data-action='probe-model-all']").count()
        check(probe_all_cnt == 0, "Agent 模式已彻底移除冗余「全部探活」按钮", f"count={probe_all_cnt}")
        await shot("05_probe_all_removed")

        # 5b. verify deprecated live test button is completely removed
        live_btn_count = await page.locator("#agentModelsBox [data-action='live-test']").count()
        check(live_btn_count == 0, "废弃「实测 1+1」按钮已彻底拔除不存在", f"count={live_btn_count}")

        # 5c. edit model: bind the second key as well -> two rows
        await page.click("#agentModelsBox [data-action='edit-model']")
        await page.wait_for_timeout(500)
        caps = page.locator("#a_keyList .key-capsule")
        for i in range(await caps.count()):
            if "坏号" in await caps.nth(i).inner_text() and "checked" not in (await caps.nth(i).get_attribute("class") or ""):
                await caps.nth(i).click()
        await page.click("#agentModal .modal-foot .btn-primary")
        await page.wait_for_timeout(1200)
        rows = await page.locator("#agentModelsBox tbody tr").count()
        check(rows == 2, "编辑模型追加第二个 Key 绑定后出现两行", rows)
        probe_key2 = page.locator("#agentModelsBox tbody tr:nth-child(2) [data-action='probe-key']")
        if await probe_key2.count() > 0:
            await probe_key2.click()
            await page.wait_for_timeout(2000)
            status_cell = await page.locator("#agentModelsBox tbody tr:nth-child(2) td:nth-child(5)").inner_text()
            check("401" in status_cell or "失败" in status_cell or "ERR" in status_cell or "invalid" in status_cell.lower(), "单 Key 测能精准定位到坏 Key 异常状态", status_cell)
        await shot("05b_two_keys")

        # 6. real client call through the gateway, then dashboard shows it
        req = urllib.request.Request(base + "/v1/chat/completions", method="POST",
                                     data=json.dumps({"model": "mock-chat-1", "messages": [{"role": "user", "content": "1+1"}]}).encode(),
                                     headers={"Authorization": "Bearer " + proxy_key, "Content-Type": "application/json"})
        try:
            body = json.loads(urllib.request.urlopen(req, timeout=10).read())
            check(body["choices"][0]["message"]["content"] == "2", "网关 /v1/chat/completions 实际转发成功")
        except Exception as e:
            check(False, "网关 /v1/chat/completions 实际转发成功", e)
        await page.click("#topNav >> text=概览")
        await page.click("header >> text=刷新")
        await page.wait_for_timeout(1500)
        await shot("06_dashboard")
        check("mock-chat-1" in await page.inner_text("#listAvailableModels"), "概览「可用模型」包含新模型")

        # 7. settings / access / raw tabs open without JS errors
        for tab in ("系统设置", "接入指引", "JSON 配置"):
            await page.click(f"#topNav >> text={tab}")
            await page.wait_for_timeout(400)
        await shot("07_last_tab")

        check(not js_errors, "全程无前端 JS 异常", js_errors[:5])
        check(not bad_http, "全程无非预期的 4xx/5xx 管理接口响应", bad_http[:5])
        await browser.close()


def main():
    try:
        import playwright  # noqa: F401
    except ImportError:
        print("SKIP: playwright 未安装 (pip install playwright)")
        return 0

    tmp = Path(tempfile.mkdtemp(prefix="ocrproxy-e2e-"))
    shots = os.environ.get("E2E_SHOTS") or (str(tmp / "shots") if os.environ.get("E2E_KEEP") else "")
    if shots:
        Path(shots).mkdir(parents=True, exist_ok=True)
    mock_port, app_port = free_port(), free_port()
    (tmp / "mock_upstream.py").write_text(MOCK_SRC)
    env = dict(os.environ, NO_PROXY="127.0.0.1,localhost", no_proxy="127.0.0.1,localhost")
    procs = []
    try:
        procs.append(subprocess.Popen([sys.executable, "-m", "uvicorn", "mock_upstream:app", "--port", str(mock_port)],
                                      cwd=tmp, env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL))
        cfg_dir = tmp / "config"
        cfg_dir.mkdir()
        envfile = tmp / ".env"
        subprocess.run([sys.executable, str(VM / "scripts" / "init_config.py"), "", str(cfg_dir), str(envfile),
                        str(app_port), "agent", "e2e-admin-pw", "vault-e2e"], check=True,
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        lines = []
        for ln in envfile.read_text().splitlines():
            if ln.startswith("APP_HOST="):
                ln = "APP_HOST=127.0.0.1"
            if ln.startswith("CONFIG_DIR="):
                ln = f"CONFIG_DIR={cfg_dir}"
            lines.append(ln)
        envfile.write_text("\n".join(lines) + "\n")
        proxy_key = next(l.split("=", 1)[1] for l in lines if l.startswith("PROXY_API_KEY="))
        log = open(tmp / "server.log", "w")
        procs.append(subprocess.Popen([sys.executable, "run_server.py"], cwd=VM, env=dict(env, ENV_FILE=str(envfile)),
                                      stdout=log, stderr=subprocess.STDOUT))
        base = f"http://127.0.0.1:{app_port}"
        if not (wait_http(f"http://127.0.0.1:{mock_port}/v1/models") and wait_http(base + "/")):
            print("FAIL: 服务未能启动，日志：", (tmp / "server.log").read_text()[-2000:])
            return 1
        print(f"=== VM Agent 控制台 E2E (server {base}, mock :{mock_port}) ===")
        asyncio.run(run_ui(base, "e2e-admin-pw", proxy_key, f"http://127.0.0.1:{mock_port}", shots))
    finally:
        for pr in procs:
            pr.terminate()
        for pr in procs:
            try:
                pr.wait(timeout=5)
            except Exception:
                pr.kill()
        if not os.environ.get("E2E_KEEP"):
            shutil.rmtree(tmp, ignore_errors=True)
        else:
            print("artifacts:", tmp)
    print(f"\nPASS {len(PASS)}  FAIL {len(FAIL)}")
    return 1 if FAIL else 0


if __name__ == "__main__":
    sys.exit(main())

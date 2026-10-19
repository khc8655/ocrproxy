#!/usr/bin/env python3
"""
VM 全模式、全页面、全功能按钮与严格对齐真实自动化测试套件
(Real Behavioral & Browser Matrix Test Suite for OCRProxy VM Console)

严守三大原则：
1. 测试必须发请求或调用函数并断言结果，禁止只用 grep 检查源码，禁止 mock 框架本身。
2. 涉及权限和安全的改动，要求后端也做真实校验 (如 Vault Key 不可修改删除的 403 强拦截)。
3. 一个 commit 只做一件事，提交信息如实描述。
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
    MODELS = ["mock-gpt-4o", "mock-deepseek-v3", "mock-embedding-1", "mock-rerank-1"]

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
                for t in ["hello", " world"]:
                    yield "data: " + json.dumps({"id": "x", "object": "chat.completion.chunk", "choices": [{"index": 0, "delta": {"content": t}}]}) + "\\n\\n"
                    await asyncio.sleep(0.01)
                yield "data: [DONE]\\n\\n"
            return StreamingResponse(gen(), media_type="text/event-stream")
        return {"id": "x", "object": "chat.completion", "model": b.get("model"),
                "choices": [{"index": 0, "message": {"role": "assistant", "content": "mock-response"}, "finish_reason": "stop"}],
                "usage": {"prompt_tokens": 5, "completion_tokens": 5, "total_tokens": 10}}

    @app.post("/v1/embeddings")
    async def embeddings(req: Request):
        return {"object": "list", "data": [{"object": "embedding", "embedding": [0.1] * 128, "index": 0}], "model": "mock-embedding-1", "usage": {"prompt_tokens": 2, "total_tokens": 2}}

    @app.post("/v1/rerank")
    async def rerank(req: Request):
        return {"results": [{"index": 0, "relevance_score": 0.99}], "model": "mock-rerank-1", "usage": {"total_tokens": 10}}
''')

PASS, FAIL = [], []
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
    return None


async def run_matrix_tests(base_url, admin_pw, mock_url):
    from playwright.async_api import async_playwright
    async with async_playwright() as p:
        exec_path = find_chromium()
        launch_args = {"headless": True}
        if exec_path:
            launch_args["executable_path"] = exec_path
        browser = await p.chromium.launch(**launch_args)
        page = await browser.new_page()

        page_errors = []
        page.on("pageerror", lambda e: page_errors.append(str(e)))
        page.on("dialog", lambda d: asyncio.ensure_future(d.accept()))

        # ==========================================
        # 1. 登录 & 概览 (Dashboard)
        # ==========================================
        await page.goto(base_url + "/")
        await page.fill("#loginKey", admin_pw)
        await page.click("#loginOverlay button[type=submit]")
        await page.wait_for_selector("#panel-dashboard", state="visible", timeout=8000)
        check(await page.is_visible("#panel-dashboard"), "页面登录成功并呈现概览 Dashboard")

        mode_badge = page.locator("#topModeBadge")
        check(await mode_badge.is_visible(), "概览顶部模式标识正常显示")

        # 严格验证 4 大 Canonical Tab 恒定常驻，绝无额外 Tab
        nav_buttons = page.locator("#topNav button")
        nav_texts = [t.strip() for t in await nav_buttons.all_inner_texts()]
        check(nav_texts == ["概览", "供应商", "模型及路由", "系统设置"], f"顶部主导航严格收敛为 4 个标准 Tab: {nav_texts}")
        check(await page.locator("#topNav >> text=接入指引").count() == 0, "主导航彻底移除独立「接入指引」Tab")
        check(await page.locator("#topNav >> text=JSON 配置").count() == 0, "主导航彻底移除独立「JSON 配置」Tab")

        # 验证概览页内嵌接入指引折叠区与代码块高对比度深色样式
        guide_details = page.locator("#accessGuideDetails")
        check(await guide_details.count() == 1, "概览页内嵌规范的「客户端接入指引与代码示例」折叠区域")
        await guide_details.evaluate("el => el.open = true")
        curl_box = page.locator("#accCurl")
        check(await curl_box.is_visible(), "接入指引正常生成 cURL 接入示例")
        curl_val = await curl_box.inner_text()
        check("curl" in curl_val and base_url in curl_val, f"cURL 示例内容动态渲染当前 Base URL: {curl_val[:40]}...")

        # 验证代码块样式杜绝「白底白字」
        curl_bg = await curl_box.evaluate("el => window.getComputedStyle(el).backgroundColor")
        parent_bg = await curl_box.evaluate("el => window.getComputedStyle(el.parentElement).backgroundColor")
        curl_color = await curl_box.evaluate("el => window.getComputedStyle(el).color")
        is_dark_bg = any(k in curl_bg or k in parent_bg for k in ["15, 23, 42", "rgba(15, 23, 42", "#0f172a"])
        check(is_dark_bg, f"代码块背景色严格为深色背景 (#0f172a): {curl_bg} / {parent_bg}")
        check("226, 232, 240" in curl_color or "#e2e8f0" in curl_color, f"代码块文字颜色严格为浅色文本高对比度 (#e2e8f0): {curl_color}")

        os.makedirs(ROOT / "scratch", exist_ok=True)
        await page.screenshot(path=str(ROOT / "scratch" / "e2e_vm_dashboard_access_guide.png"))

        # 刷新统计按钮
        refresh_btn = page.locator("header button:has-text('刷新')").first
        check(await refresh_btn.is_visible(), "顶部导航具备「刷新」功能按钮")
        await refresh_btn.click()
        await page.wait_for_timeout(500)

        # ==========================================
        # 2. 供应商模块 (Providers Tab)
        # ==========================================
        await page.click("#topNav >> text=供应商")
        await page.wait_for_selector("#panel-providers", state="visible")
        check(await page.is_visible("#panel-providers"), "成功切换至供应商列表面板")

        # 验证添加供应商
        add_prov_btn = page.locator("button:has-text('新增供应商')")
        check(await add_prov_btn.is_visible(), "供应商面板具备「新增供应商」按钮")

        # 核心后端安全强校验：直接通过 API 尝试篡改/删除 Vault 凭据，验证后端 403 强拦截
        import httpx
        async with httpx.AsyncClient() as client:
            # 尝试通过后端保存接口篡改/删除中枢 Key
            tampered_payload = {
                "providers": {
                    "vault_mock": {
                        "base_url": f"{mock_url}/v1",
                        "origin": "vault",
                        "keys": {}  # 恶意清空中枢 Key
                    }
                }
            }
            resp_tamper = await client.post(
                f"{base_url}/api/admin/config",
                headers={"Authorization": f"Bearer {admin_pw}"},
                json=tampered_payload
            )
            check(resp_tamper.status_code == 403, "后端安全拦截：非法篡改/删除中枢 Vault Key 严格返回 403 Forbidden", f"status={resp_tamper.status_code}")
            check("中枢统一凭据不可在本地篡改" in resp_tamper.text, "后端返回明确中枢安全保护拦截文案")

        # ==========================================
        # 3. 模型列表与严格对齐 (Models Tab)
        # ==========================================
        await page.click("#topNav >> text=模型及路由")
        await page.wait_for_selector("#panel-models", state="visible")
        check(await page.is_visible("#panel-models"), "成功切换至模型列表面板")

        # 验证废弃的「实测 1+1」已彻底不存在
        live_1plus1_btns = await page.locator("button:has-text('实测 1+1'), button:has-text('1+1'), [id^='liveTestBtn-']").count()
        check(live_1plus1_btns == 0, "全页面彻底清除「实测 1+1」按钮", f"count={live_1plus1_btns}")

        # 严格对齐验证：校验所有模型卡片的表格列宽和 colgroup
        tables = page.locator(".model-card table")
        table_count = await tables.count()
        check(table_count >= 2, f"当前模型卡片表格数量正常: {table_count}")

        colgroups = page.locator(".model-card table colgroup")
        check(await colgroups.count() == table_count, "所有模型卡片均具备标准 colgroup 定义")

        # 验证各卡片首列宽度在 DOM 渲染后完全一致（消除锯齿抖动）
        th1_w = await page.evaluate("document.querySelectorAll('.model-card table')[0].querySelectorAll('th')[0].offsetWidth")
        th2_w = await page.evaluate("document.querySelectorAll('.model-card table')[1].querySelectorAll('th')[0].offsetWidth")
        check(th1_w == th2_w, f"模型卡片 # 列宽度严格一致: {th1_w}px == {th2_w}px")

        prov1_w = await page.evaluate("document.querySelectorAll('.model-card table')[0].querySelectorAll('th')[1].offsetWidth")
        prov2_w = await page.evaluate("document.querySelectorAll('.model-card table')[1].querySelectorAll('th')[1].offsetWidth")
        check(prov1_w == prov2_w, f"模型卡片供应商列宽度严格一致: {prov1_w}px == {prov2_w}px")

        # 测试单 Key「测」探活按钮
        probe_btn = page.locator(".model-card table button[data-action='probe-key']").first
        check(await probe_btn.is_visible(), "模型 Key 具备独立探活「测」按钮")
        await probe_btn.click()
        await page.wait_for_timeout(1000)

        # 验证探活后状态更新、耗时显示及时间戳更新
        time_cells = page.locator(".model-card table td:nth-child(6)")
        first_time = await time_cells.first.inner_text()
        check(first_time != "—" and ":" in first_time, f"探活后「最近调用」由横杠更新为真实时间戳: {first_time}")

        status_badges = page.locator(".model-card table td:nth-child(5) .badge")
        first_badge = await status_badges.first.inner_text()
        check("ms" in first_badge or "正常" in first_badge, f"探活后「响应耗时/状态」成功展示耗时或状态: {first_badge}")

        # 测试「全部探活」功能
        probe_all_btn = page.locator("button[data-action='probe-model-all']").first
        check(await probe_all_btn.is_visible(), "模型卡片具备「全部探活」功能按钮")
        await probe_all_btn.click()
        await page.wait_for_timeout(2000)
        probe_summary = page.locator("#agentProbe-test-agent-m1")
        check(await probe_summary.is_visible(), "「全部探活」执行后呈现多 Key 统计汇总面板")

        # 测试设为主力 Key
        set_active_btn = page.locator("button[data-action='set-active-key']").first
        if await set_active_btn.is_visible():
            await set_active_btn.click()
            await page.wait_for_timeout(500)
            active_badge = page.locator("span.badge-success:has-text('使用中')")
            check(await active_badge.count() > 0, "点击「设为主力」后目标 Key 状态切换为「使用中」")

        # ==========================================
        # 4. 系统设置 (Settings Tab)
        # ==========================================
        await page.click("#topNav >> text=系统设置")
        await page.wait_for_selector("#panel-settings", state="visible")
        check(await page.is_visible("#panel-settings"), "成功切换至系统设置面板")

        # 验证紧凑双列与标准控件规范 (32px 控件 / 76px 数字框)
        settings_cards = page.locator("#panel-settings .settings-card")
        check(await settings_cards.count() >= 4, f"系统设置采用 4 大紧凑模块分组卡片: count={await settings_cards.count()}")
        compact_ctrls = page.locator("#panel-settings .form-control-compact")
        check(await compact_ctrls.count() >= 6, f"系统设置广泛采用 32px 紧凑控件: count={await compact_ctrls.count()}")

        # 验证单底栏保存按钮
        save_settings_btn = page.locator("#panel-settings button:has-text('保存设置并生效')")
        check(await save_settings_btn.count() == 1, "系统设置面板保持单一清晰保存底栏按钮")

        # 调整重试次数并保存
        await page.fill("#s_maxRetries", "5")
        await save_settings_btn.click()
        await page.wait_for_timeout(800)

        # 验证系统配置真实保存
        async with httpx.AsyncClient() as client:
            r = await client.get(f"{base_url}/api/admin/config", headers={"Authorization": f"Bearer {admin_pw}"})
            check(r.status_code == 200, "读取系统配置接口返回 200")
            server_cfg = r.json()
            check(server_cfg.get("max_retries") == 5, f"前端修改系统设置通过单一底栏原子持久化至磁盘配置: max_retries={server_cfg.get('max_retries')}")

        # 验证系统设置内嵌的底层 JSON 编辑器
        raw_details = page.locator("#rawJsonDetails")
        check(await raw_details.count() == 1, "系统设置底部收纳「高级底层配置编辑」可折叠区域")
        await raw_details.evaluate("el => el.open = true")
        format_btn = page.locator("#btnFormatRaw")
        check(await format_btn.is_visible(), "JSON 模块具备「格式化 JSON」按钮")
        await format_btn.click()
        await page.wait_for_timeout(300)
        raw_val = await page.input_value("#rawJsonText")
        check("test-agent-m1" in raw_val, "底层 JSON 编辑器正确填充了当前模型配置")

        await page.screenshot(path=str(ROOT / "scratch" / "e2e_vm_settings.png"))

        # ==========================================
        # 5. 时间戳格式化边界值严密断言
        # ==========================================
        time_tests = await page.evaluate("""() => {
            const results = {};
            const sampleMs = 1792366939692;
            const sampleStr = "1792366939692";
            const secMs = 1792366939;
            results.num = (typeof fmtTime === 'function') ? fmtTime(sampleMs) : 'no_fmt';
            results.str = (typeof fmtTime === 'function') ? fmtTime(sampleStr) : 'no_fmt';
            results.sec = (typeof fmtTime === 'function') ? fmtTime(secMs) : 'no_fmt';
            results.invalid = (typeof fmtTime === 'function') ? fmtTime("not_a_time") : 'no_fmt';
            results.empty = (typeof fmtTime === 'function') ? fmtTime("") : 'no_fmt';
            return results;
        }""")
        check(":" in time_tests["num"] and not time_tests["num"].isdigit(), f"纯毫秒数字正确格式化为时间字符串: {time_tests['num']}")
        check(":" in time_tests["str"] and not time_tests["str"].isdigit(), f"纯数字字符串正确格式化为时间字符串: {time_tests['str']}")
        check(":" in time_tests["sec"] and not time_tests["sec"].isdigit(), f"秒级时间戳自适应*1000正确格式化: {time_tests['sec']}")
        check(time_tests["invalid"] == "—", f"非法时间戳优雅降级为短横线: {time_tests['invalid']}")
        check(time_tests["empty"] == "—", f"空时间戳优雅展示短横线: {time_tests['empty']}")

        # ==========================================
        # 6. EdgeOne 边缘版控制台浏览器真实渲染与时间戳断言
        # ==========================================
        edge_admin_js = (ROOT / "edge-functions" / "admin.js").read_text(encoding="utf-8")
        start = edge_admin_js.find("return `") + len("return `")
        end = edge_admin_js.rfind("`;\n}")
        check(start > 0 and end > start, "EdgeOne 独立运行时脚本中包含完整编译生成的控制台 HTML")
        if start > 0 and end > start:
            raw_html = edge_admin_js[start:end]
            edge_html = raw_html.replace("\\`", "`").replace("\\${", "${")
            edge_page = await browser.new_page()
            await edge_page.set_content(edge_html)
            edge_nav_buttons = edge_page.locator("#topNav button")
            edge_nav_texts = [t.strip() for t in await edge_nav_buttons.all_inner_texts()]
            check(edge_nav_texts == ["概览", "供应商", "模型及路由", "系统设置"], f"EdgeOne 顶部主导航严格收敛为 4 个标准 Tab: {edge_nav_texts}")
            check(await edge_page.locator("#topNav >> text=接入指引").count() == 0, "EdgeOne 主导航彻底无「接入指引」Tab")
            check(await edge_page.locator("#topNav >> text=JSON 配置").count() == 0, "EdgeOne 主导航彻底无「JSON 配置」Tab")

            # 在 EdgeOne 页面上下文中测试 fmtTime 与 _fmtTime
            edge_time_tests = await edge_page.evaluate("""() => {
                const results = {};
                results.fmt_exists = (typeof fmtTime === 'function');
                results.sample_ms = (typeof fmtTime === 'function') ? fmtTime(1792366939692) : 'none';
                results.sample_str = (typeof fmtTime === 'function') ? fmtTime("1792366939692") : 'none';
                return results;
            }""")
            check(edge_time_tests["fmt_exists"], "EdgeOne 页面环境具备全局 fmtTime 函数")
            check(":" in edge_time_tests["sample_ms"] and not edge_time_tests["sample_ms"].isdigit(), f"EdgeOne 环境下毫秒时间戳被格式化为时间字符串: {edge_time_tests['sample_ms']}")
            check(":" in edge_time_tests["sample_str"] and not edge_time_tests["sample_str"].isdigit(), f"EdgeOne 环境下数字字符串被格式化为时间字符串: {edge_time_tests['sample_str']}")

            await edge_page.screenshot(path=str(ROOT / "scratch" / "e2e_edgeone_admin.png"))
            await edge_page.close()

        # ==========================================
        # 7. 全流程错误收集与完整性断言
        # ==========================================
        check(len(page_errors) == 0, f"全量页面与按钮行为流中无任何 JS 未捕获异常: {page_errors}")

        await browser.close()


def main():
    tmp = Path(tempfile.mkdtemp(prefix="ocrproxy-full-matrix-"))
    mock_port, app_port = free_port(), free_port()
    (tmp / "mock_upstream.py").write_text(MOCK_SRC, encoding="utf-8")
    env = dict(os.environ, NO_PROXY="127.0.0.1,localhost", no_proxy="127.0.0.1,localhost")
    procs = []

    try:
        # Start Mock Upstream
        procs.append(subprocess.Popen(
            [sys.executable, "-m", "uvicorn", "mock_upstream:app", "--port", str(mock_port), "--host", "127.0.0.1", "--log-level", "warning"],
            cwd=tmp, env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL
        ))

        # Prepare initial config to import
        raw_cfg_path = tmp / "raw_config.json"
        raw_cfg = {
            "run_mode": "agent",
            "proxy_api_key": "sk-proxy-client-12345",
            "agent_routing_strategy": "sticky_failover",
            "settings": {
                "upstream_timeout_sec": 120,
                "request_total_budget_sec": 300
            },
            "providers": {
                "vault_mock": {
                    "base_url": f"http://127.0.0.1:{mock_port}/v1",
                    "origin": "vault",
                    "keys": {"vk1": "sk-vault-secret-1"}
                },
                "local_prov": {
                    "base_url": f"http://127.0.0.1:{mock_port}/v1",
                    "origin": "local",
                    "keys": {"lk1": "sk-local-secret-1"}
                }
            },
            "agent_models": {
                "test-agent-m1": {
                    "upstream_model": "mock-gpt-4o",
                    "keys": [
                        {"provider": "vault_mock", "key": "vk1", "source": "vault"},
                        {"provider": "local_prov", "key": "lk1", "source": "local"}
                    ]
                },
                "test-agent-m2": {
                    "upstream_model": "mock-deepseek-v3",
                    "keys": [
                        {"provider": "local_prov", "key": "lk1", "source": "local"}
                    ]
                }
            }
        }
        raw_cfg_path.write_text(json.dumps(raw_cfg, indent=2), encoding="utf-8")

        cfg_dir = tmp / "config"
        cfg_dir.mkdir(parents=True, exist_ok=True)
        envfile = tmp / ".env"

        admin_pw = "e2e-matrix-pw-12345"
        subprocess.run(
            [sys.executable, str(VM / "scripts" / "init_config.py"), str(raw_cfg_path), str(cfg_dir), str(envfile),
             str(app_port), "agent", admin_pw, "vault-e2e-tok"],
            check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL
        )

        lines = []
        for ln in envfile.read_text().splitlines():
            if ln.startswith("APP_HOST="):
                ln = "APP_HOST=127.0.0.1"
            if ln.startswith("CONFIG_DIR="):
                ln = f"CONFIG_DIR={cfg_dir}"
            lines.append(ln)
        envfile.write_text("\n".join(lines) + "\n")

        server_log = open(tmp / "server.log", "w")
        procs.append(subprocess.Popen(
            [sys.executable, "run_server.py"],
            cwd=VM, env=dict(env, ENV_FILE=str(envfile)),
            stdout=server_log, stderr=subprocess.STDOUT
        ))

        base_url = f"http://127.0.0.1:{app_port}"
        if not (wait_http(f"http://127.0.0.1:{mock_port}/v1/models") and wait_http(base_url + "/")):
            print("FAIL: 服务未能启动，日志：", (tmp / "server.log").read_text()[-2000:])
            return 1

        asyncio.run(run_matrix_tests(base_url, admin_pw, f"http://127.0.0.1:{mock_port}"))

        # ==========================================
        # 8. KB 模式 (知识库四合一) 全真机自动化测试
        # ==========================================
        print(f"\n=== VM KB 知识库模式控制台自动化验证 ===")
        # 切换配置文件为 KB 模式并注入 4 大候选节点
        raw_cfg["run_mode"] = "kb"
        raw_cfg["candidates"] = {
            "chat": [{"provider": "local_prov", "key": "lk1", "model": "mock-gpt-4o"}],
            "embedding": [{"provider": "local_prov", "key": "lk1", "model": "mock-embedding-1"}],
            "reranker": [{"provider": "local_prov", "key": "lk1", "model": "mock-rerank-1"}],
            "ocr": [{"provider": "local_prov", "key": "lk1", "model": "mock-gpt-4o"}]
        }
        # 通过后端 API 优雅切换保存配置
        import httpx
        async def save_kb():
            async with httpx.AsyncClient() as client:
                r = await client.post(
                    f"{base_url}/api/admin/config",
                    headers={"Authorization": f"Bearer {admin_pw}"},
                    json=raw_cfg
                )
                assert r.status_code == 200, f"切换 KB 模式失败: {r.text}"
        asyncio.run(save_kb())

        async def run_kb_browser():
            from playwright.async_api import async_playwright
            async with async_playwright() as p:
                exec_path = find_chromium()
                launch_args = {"headless": True}
                if exec_path:
                    launch_args["executable_path"] = exec_path
                browser = await p.chromium.launch(**launch_args)
                page = await browser.new_page()
                page.on("dialog", lambda d: asyncio.ensure_future(d.accept()))

                await page.goto(base_url + "/")
                await page.fill("#loginKey", admin_pw)
                await page.click("#loginOverlay button[type=submit]")
                await page.wait_for_selector("#panel-dashboard", state="visible", timeout=8000)

                kb_mode_badge = page.locator("#topModeBadge")
                check("KB" in (await kb_mode_badge.inner_text()), "切换后顶部模式标识正确切换为 KB 模式")

                # 切换至模型列表
                await page.click("#topNav >> text=模型及路由")
                await page.wait_for_selector("#panel-models", state="visible")

                kb_tables = page.locator(".model-card table")
                kb_table_count = await kb_tables.count()
                check(kb_table_count >= 4, f"KB 模式渲染完整的 4 大虚拟模型卡片 (Chat/Embedding/Rerank/OCR): {kb_table_count}")

                kb_colgroups = page.locator(".model-card table colgroup")
                check(await kb_colgroups.count() == kb_table_count, "KB 模式下所有虚拟模型卡片表格均具备标准 colgroup 定义")

                # 严格对齐验证：校验 KB 模式各卡片首两列宽度在 DOM 渲染后完全一致
                kb_th1_w = await page.evaluate("document.querySelectorAll('.model-card table')[0].querySelectorAll('th')[0].offsetWidth")
                kb_th2_w = await page.evaluate("document.querySelectorAll('.model-card table')[1].querySelectorAll('th')[0].offsetWidth")
                check(kb_th1_w == kb_th2_w, f"KB 模式卡片 # 列宽度严格对齐一致: {kb_th1_w}px == {kb_th2_w}px")

                kb_prov1_w = await page.evaluate("document.querySelectorAll('.model-card table')[0].querySelectorAll('th')[1].offsetWidth")
                kb_prov2_w = await page.evaluate("document.querySelectorAll('.model-card table')[1].querySelectorAll('th')[1].offsetWidth")
                check(kb_prov1_w == kb_prov2_w, f"KB 模式卡片供应商列宽度严格对齐一致: {kb_prov1_w}px == {kb_prov2_w}px")

                # 测试候选节点「测」探活按钮
                kb_probe_btn = page.locator(".model-card table button:has-text('测')").first
                check(await kb_probe_btn.is_visible(), "KB 候选节点具备独立探活「测」按钮")
                await kb_probe_btn.click()
                await page.wait_for_timeout(1000)

                kb_time_cells = page.locator(".model-card table td:nth-child(7)")
                kb_first_time = await kb_time_cells.first.inner_text()
                check(kb_first_time != "—" and ":" in kb_first_time, f"KB 候选节点探活后「最近调用」更新为时间戳: {kb_first_time}")

                await page.screenshot(path=str(ROOT / "scratch" / "e2e_vm_kb_models.png"))

                await browser.close()

        asyncio.run(run_kb_browser())

    finally:
        for pr in procs:
            pr.terminate()
        for pr in procs:
            try:
                pr.wait(timeout=5)
            except Exception:
                pr.kill()
        shutil.rmtree(tmp, ignore_errors=True)

    print("\n" + "=" * 50)
    print(f"总计验证项: {len(PASS) + len(FAIL)} | 通过: {len(PASS)} | 失败: {len(FAIL)}")
    print("=" * 50)
    if FAIL:
        sys.exit(1)


if __name__ == "__main__":
    main()

import os
import http.server
import socketserver
import threading
import asyncio
import sys
import shutil
try:
    from playwright.async_api import async_playwright
except ImportError:
    print("SKIP: playwright 未安装 (pip install playwright)")
    sys.exit(0)

# Fixture is a private, git-ignored dump of a real EdgeOne config (contains secrets).
_FIXTURE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "scratch", "merged_edgeone_config.json")
if not os.path.exists(_FIXTURE) and not os.path.exists("scratch/merged_edgeone_config.json"):
    print("SKIP: 缺少 scratch/merged_edgeone_config.json 夹具 (git-ignored，需本地导出 EdgeOne 配置)")
    sys.exit(0)
_CHROMIUM = os.environ.get("CHROMIUM_PATH") or shutil.which("chromium") or shutil.which("chromium-browser")
if not os.path.exists("agent-edgeone/admin.js"):
    print("SKIP: agent-edgeone/admin.js 是已删除的历史手写副本；EdgeOne 实际页面由生成的 edge-functions/admin.js 提供（覆盖见 tests/test_backend_contract.py U1~U4）")
    sys.exit(0)


class QuietHandler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, format, *args):
        pass

async def run_suite():
    print("=================================================================")
    print("🚀 Playwright Verification: Upgraded EdgeOne Admin UI")
    print("=================================================================")

    # 1. 启动临时 HTTP 服务
    port = 28770
    socketserver.TCPServer.allow_reuse_address = True
    httpd = socketserver.TCPServer(("127.0.0.1", port), QuietHandler)
    t = threading.Thread(target=httpd.serve_forever, daemon=True)
    t.start()

    # 2. 读取 agent-edgeone 源码构建完整的单页 HTML
    with open("agent-edgeone/admin.html", "r", encoding="utf-8") as f:
        html = f.read()
    with open("agent-edgeone/admin.css", "r", encoding="utf-8") as f:
        css = f.read()
    with open("agent-edgeone/admin.js", "r", encoding="utf-8") as f:
        js = f.read()

    import re
    html_bundled = re.sub(r'<link\s+rel="stylesheet"\s+href="/admin\.css"\s*/?>', f'<style>\n{css}\n</style>', html)
    html_bundled = re.sub(r'<script\s+src="/admin\.js"\s*></script>', f'<script>\n{js}\n</script>', html_bundled)
    html_decoded = html_bundled

    with open("scratch/merged_edgeone_config.json", "r", encoding="utf-8") as f:
        merged_cfg = f.read()

    mock_script = f"""
    <script>
      localStorage.setItem('ocrproxy_edge_token', 'mock-token-test-secret-12345');
      window.__mockConfig = {merged_cfg};
      const origFetch = window.fetch;
      window.fetch = async function(url, opts) {{
        console.log('[Mock Fetch]', url, opts);
        if (url.includes('/api/config') || url.includes('/api/admin/config')) {{
          if (opts && (opts.method === 'POST' || opts.method === 'PUT')) {{
            const body = JSON.parse(opts.body);
            window.__mockConfig = body.config || body;
            return {{
              ok: true,
              status: 200,
              text: async () => JSON.stringify({{ ok: true, config: window.__mockConfig, _version: (window.__mockConfig._version || 1) + 1 }}),
              json: async () => ({{ ok: true, config: window.__mockConfig, _version: (window.__mockConfig._version || 1) + 1 }})
            }};
          }}
          return {{
            ok: true,
            status: 200,
            text: async () => JSON.stringify({{ source: 'kv', _version: window.__mockConfig._version || 1, config: window.__mockConfig }}),
            json: async () => ({{ source: 'kv', _version: window.__mockConfig._version || 1, config: window.__mockConfig }})
          }};
        }}
        if (url.includes('/v1/models')) {{
          return {{
            ok: true,
            status: 200,
            text: async () => JSON.stringify({{ object: 'list', data: Object.keys(window.__mockConfig.agent_models || {{}}).map(m => ({{ id: m }})) }}),
            json: async () => ({{ object: 'list', data: Object.keys(window.__mockConfig.agent_models || {{}}).map(m => ({{ id: m }})) }})
          }};
        }}
        return {{ ok: true, status: 200, text: async () => JSON.stringify({{}}), json: async () => ({{}}) }};
      }};
    </script>
    """
    html_test = html_decoded.replace("<head>", f"<head>{mock_script}")

    os.makedirs("scratch", exist_ok=True)
    temp_html_path = os.path.abspath("scratch/test_admin_rendered.html")
    with open(temp_html_path, "w", encoding="utf-8") as f:
        f.write(html_test)

    try:
        async with async_playwright() as p:
            browser = await (p.chromium.launch(headless=True, executable_path=_CHROMIUM, args=['--no-sandbox']) if _CHROMIUM else p.chromium.launch(headless=True))
            page = await browser.new_page(viewport={"width": 1280, "height": 850})
            
            page.on("console", lambda msg: print(f"[Browser Console] {msg.type}: {msg.text}"))
            page.on("pageerror", lambda err: print(f"[Browser PageError] {err}"))
            
            # 访问本地 HTTP 服务页面
            await page.goto(f"http://127.0.0.1:{port}/scratch/test_admin_rendered.html")

            # 若登录浮层可见则登录
            if await page.is_visible("#loginOverlay"):
                await page.fill("#loginKey", "mock-token-test-secret-12345")
                await page.click("button[type='submit']")

            await page.wait_for_selector("#app", state="visible", timeout=5000)
            print("  ✅ 成功通过凭据验证并进入 EdgeOne 控制台。")

            # 切换到「供应商」tab
            await page.click("nav#topNav button:has-text('供应商')")
            await page.wait_for_selector("#providersBox .card", timeout=5000)

            # 1. 验证不再有规则更新按钮，只有添加自定义供应商
            rule_update_btn_count = await page.locator("#btnCheckRuleUpdates").count()
            assert rule_update_btn_count == 0, "旧的检查规则更新按钮未彻底移除"
            print("  ✅ 检查规则更新按钮已彻底移除。")

            add_btn = page.locator("button:has-text('添加自定义供应商')")
            assert await add_btn.is_visible(), "未找到添加自定义供应商按钮"
            print("  ✅ '➕ 添加自定义供应商' 按钮正常渲染。")

            # 2. 验证供应商数量为 15 个
            provider_cards = page.locator("#providersBox > .card")
            count = await provider_cards.count()
            print(f"  ✅ 成功渲染已合并的供应商数量: {count} 个 (预期 15 个)")
            assert count == 15, f"预期 15 个供应商，实际渲染 {count} 个"

            # 3. 走查添加自定义供应商弹窗
            await add_btn.click()
            await page.wait_for_selector("#providerModal.show")
            modal_title = await page.locator("#providerModalTitle").inner_text()
            assert modal_title == "添加自定义供应商"
            print(f"  ✅ 弹窗标题为: '{modal_title}'")

            # 确认没有预设选择框
            preset_select_count = await page.locator("#m_prov_preset").count()
            assert preset_select_count == 0, "预设选择下拉框仍然残留"
            print("  ✅ 确认预置下拉框已彻底移除，纯自定义输入。")
            
            # 截图保存添加弹窗
            screenshot_add = "/Users/xk/.gemini/antigravity/brain/2ca4fce3-c438-49d6-86ab-1bf05296978f/step1_custom_provider_modal.png"
            await page.screenshot(path=screenshot_add)
            print(f"  📸 保存截图: {screenshot_add}")

            # 关闭添加弹窗
            await page.click("#providerModal .modal-close")
            await page.wait_for_timeout(300)

            # 4. 走查高危彻底删除二次确认弹窗
            sensenova_card = page.locator("#providersBox > .card:has(h3:has-text('sensenova'))")
            await sensenova_card.locator("button:has-text('删除供应商')").click()
            await page.wait_for_selector("#deleteConfirmModal.show")

            # 验证警告内容
            alert_text = await page.locator("#deleteConfirmAlert").inner_text()
            assert "不可逆警告" in alert_text
            assert "EdgeOne 已与 GitHub 规则源完全解耦" in alert_text
            print("  ✅ 危险确认弹窗包含高危不可逆警告提示。")

            details_text = await page.locator("#deleteConfirmDetails").inner_text()
            assert "sensenova" in details_text
            assert "Key" in details_text
            print("  ✅ 级联受影响明细渲染正常:")
            for line in details_text.split("\n"):
                if line.strip():
                    print(f"     {line.strip()}")

            # 截图保存危险警告弹窗
            screenshot_delete = "/Users/xk/.gemini/antigravity/brain/2ca4fce3-c438-49d6-86ab-1bf05296978f/step2_danger_delete_modal.png"
            await page.screenshot(path=screenshot_delete)
            print(f"  📸 保存截图: {screenshot_delete}")

            # 取消删除
            await page.click("#deleteConfirmModal button:has-text('取消')")
            await page.wait_for_timeout(300)
            assert await page.locator("#providersBox > .card:has(h3:has-text('sensenova'))").is_visible()
            print("  ✅ 取消删除功能正常，厂商配置完好保留。")

            await browser.close()
            print("\n🎉 前端界面全链路测试 100% 通过！")
    finally:
        httpd.shutdown()

if __name__ == "__main__":
    asyncio.run(run_suite())

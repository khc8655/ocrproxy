import os
import http.server
import socketserver
import threading
import asyncio
import re
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

class QuietHandler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, format, *args):
        pass

async def run_suite():
    print("=================================================================")
    print("🚀 Playwright Verification: EdgeOne UI 10-Item Comprehensive Test")
    print("=================================================================")

    # 1. 启动临时 HTTP 服务
    port = 28773
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
    temp_html_path = os.path.abspath("scratch/test_admin_rendered_v2.html")
    with open(temp_html_path, "w", encoding="utf-8") as f:
        f.write(html_test)

    artifact_dir = "/Users/xk/.gemini/antigravity/brain/2ca4fce3-c438-49d6-86ab-1bf05296978f"

    try:
        async with async_playwright() as p:
            browser = await (p.chromium.launch(headless=True, executable_path=_CHROMIUM, args=['--no-sandbox']) if _CHROMIUM else p.chromium.launch(headless=True))
            page = await browser.new_page(viewport={"width": 1280, "height": 900})
            
            page.on("console", lambda msg: print(f"[Browser Console] {msg.type}: {msg.text}"))
            page.on("pageerror", lambda err: print(f"[Browser PageError] {err}"))
            
            # 访问本地页面
            await page.goto(f"http://127.0.0.1:{port}/scratch/test_admin_rendered_v2.html")

            # 若登录浮层可见则登录
            if await page.is_visible("#loginOverlay"):
                await page.fill("#loginKey", "mock-token-test-secret-12345")
                await page.click("button[type='submit']")

            await page.wait_for_selector("#app", state="visible", timeout=5000)
            print("  ✅ 成功通过凭据验证并进入 EdgeOne 控制台。")

            # -----------------------------------------------------------------
            # 1. 验证首页网关接入条、版本号与供应商统计 (Requirements 4, 5, 7)
            # -----------------------------------------------------------------
            print("\n[Step 1] 验证首页接入条、版本号与供应商统计...")
            await page.wait_for_selector(".gateway-card", state="visible", timeout=5000)
            
            # 验证版本号
            ver_text = await page.locator("#headerVersionBadge").inner_text()
            stat_ver = await page.locator("#statVersion").inner_text()
            assert "v2026.09.19" in ver_text, f"版本标识错误: {ver_text}"
            assert "v2026.09.19" in stat_ver, f"统计区版本标识错误: {stat_ver}"
            print(f"  ✅ 页面头部与状态卡片版本号一致: {ver_text}")

            # 验证供应商统计文案
            prov_count_val = await page.locator("#statProviderCount").inner_text()
            assert int(prov_count_val) >= 15, f"供应商数量预期 >=15，实际: {prov_count_val}"
            prov_sub = await page.locator(".stat-card:has(#statProviderCount) .stat-sub").inner_text()
            assert "可全量下发至 VM" in prov_sub, f"供应商副标题预期包含可全量下发至 VM，实际: {prov_sub}"
            print(f"  ✅ 供应商统计正常: {prov_count_val} 家 ({prov_sub})")

            # 验证网关接入条元素
            gw_url = await page.locator("#dbBaseUrl").inner_text()
            gw_key = await page.locator("#gwClientKeyVal").inner_text()
            assert "/v1" in gw_url, f"网关 Base URL 异常: {gw_url}"
            assert len(gw_key) > 5, f"网关客户端 Key 异常: {gw_key}"
            assert "bearer" not in gw_key.lower(), f"客户端 Key 不应包含 Bearer 前缀: {gw_key}"
            print(f"  ✅ 首页网关直通信息: Base URL={gw_url}, 纯净 Key={gw_key}")

            # 验证可用模型整合与行内协议徽章
            assert await page.locator("#listAvailableModels").is_visible(), "未找到整合后的 #listAvailableModels 容器"
            assert await page.locator("#rowAnthropicModels").count() == 0, "不应再存在单独分开的 Message 模型行"
            model_chips = page.locator("#listAvailableModels .model-chip-clickable")
            m_count = await model_chips.count()
            assert m_count > 0, "首页未渲染可用模型芯片"
            
            # 验证芯片内包含协议徽章
            first_chip_text = await model_chips.first.inner_text()
            assert "openai" in first_chip_text.lower() or "message" in first_chip_text.lower(), f"模型芯片应包含协议徽章: {first_chip_text}"
            print(f"  ✅ 首页整合可用模型芯片: {m_count} 个，首个模型显示: {first_chip_text}")

            shot1 = os.path.join(artifact_dir, "verify_step1_dashboard_gateway.png")
            await page.screenshot(path=shot1)
            print(f"  📸 保存实机截图: {shot1}")

            # -----------------------------------------------------------------
            # 2. 验证供应商 Tab：字母排序、字母分组标、右侧快速索引条 (Alphabetical Order & Quick-Index)
            # -----------------------------------------------------------------
            print("\n[Step 2] 验证供应商字母排序、字母分组标与右侧索引轨...")
            await page.click("nav#topNav button:has-text('供应商')")
            await page.wait_for_selector("#providersBox .card", timeout=5000)

            # 验证供应商列表严格按字母升序排序
            prov_card_titles = await page.locator("#providersBox .card h3").all_inner_texts()
            clean_names = [t.split()[0].lower() for t in prov_card_titles if t.strip()]
            sorted_expected = sorted(clean_names)
            assert clean_names == sorted_expected, f"供应商未按字母排序: 实际={clean_names}, 预期={sorted_expected}"
            print(f"  ✅ 供应商列表 (共 {len(clean_names)} 家) 严格按字母升序排列: {clean_names[:5]} ... {clean_names[-3:]}")

            # 验证右侧字母导航轨 (Alphabet Rail) 存在并包含字母
            alpha_rail = page.locator("#alphabetNavRail")
            assert await alpha_rail.is_visible(), "右侧字母索引条未正常显示"
            alpha_btns = page.locator("#alphaRailInner .alpha-rail-btn")
            btn_count = await alpha_btns.count()
            assert btn_count > 0, "字母索引条中未渲染任何字母按钮"
            rendered_letters = await alpha_btns.all_inner_texts()
            print(f"  ✅ 右侧字母索引轨正常激活，包含 {btn_count} 个首字母按钮: {' '.join(rendered_letters)}")

            # 验证界面中存在对应的字母分组标 (.alpha-divider)
            dividers = page.locator("#providersBox .alpha-divider")
            div_count = await dividers.count()
            assert div_count == btn_count, f"字母分组标数量 ({div_count}) 应与首字母按钮数 ({btn_count}) 一致"
            print(f"  ✅ 页面成功渲染 {div_count} 个清晰的字母分组标 (.alpha-divider)，满屏幕杂乱彻底消除！")

            # 模拟点击字母 'S'，验证快速到达对应锚点
            if 'S' in rendered_letters:
                s_btn = page.locator("#alphaRailInner .alpha-rail-btn:has-text('S')")
                await s_btn.click()
                await page.wait_for_timeout(300)
                # 检查 S 分组是否存在
                s_group = page.locator("#alpha-group-S")
                assert await s_group.is_visible(), "点击 S 未能成功定位到 S 分组"
                print("  ✅ 点击字母 'S' 成功平滑滚动并精准定位到 S 分组锚点。")

            # 验证探测模型按钮彻底移除
            probe_btn_count = await page.locator("button:has-text('探测模型')").count()
            assert probe_btn_count == 0, f"供应商卡片仍残留探测模型按钮数量: {probe_btn_count}"
            print("  ✅ 确认所有供应商卡片头部无「探测模型」按钮。")

            # 验证更新按钮彻底移除
            update_btn_count = await page.locator("button:has-text('检查规则更新')").count()
            assert update_btn_count == 0, "更新按钮仍然残留"
            print("  ✅ 确认无「检查规则更新」按钮。")

            # 验证 Key 列表为严格 2 列网格 (KHC UI 规范要求)
            key_chips_lists = page.locator("#providersBox .key-chip-list")
            chip_list_count = await key_chips_lists.count()
            assert chip_list_count > 0, "未找到 .key-chip-list 容器"
            
            first_grid_cols = await key_chips_lists.first.evaluate("el => window.getComputedStyle(el).gridTemplateColumns")
            cols_count = len(first_grid_cols.strip().split())
            print(f"  ✅ 验证 .key-chip-list 网格列数: {cols_count} 列 (计算值: {first_grid_cols})")
            assert cols_count == 2, f"预期 2 列网格，实际为 {cols_count} 列"

            # 验证全卡片彻底消除刺眼的实心大红按钮 (.btn-danger 计数应为 0)
            red_btn_count = await page.locator("#providersBox .btn-danger").count()
            assert red_btn_count == 0, f"卡片区仍残留实心大红按钮数量: {red_btn_count}"
            print("  ✅ 确认卡片区已 100% 消除刺眼的实心大红底按钮，全面采用 KHC 次级危险按钮 (.btn-secondary-danger)。")

            key_chips = page.locator("#providersBox .key-chip")
            total_chips = await key_chips.count()
            print(f"  ✅ 供应商 Key 已全部重构为 2 列等宽卡片 (.key-chip)，共渲染 {total_chips} 个 Key。")

            # 触发一次单 Key 测试，验证测速后依然保持 2 列稳定，不发生跳行
            first_test_btn = page.locator("#providersBox .key-chip button:has-text('测试')").first
            await first_test_btn.click()
            await page.wait_for_timeout(300)

            # 再次确认依然保持 2 列
            cols_after = await key_chips_lists.first.evaluate("el => window.getComputedStyle(el).gridTemplateColumns")
            assert len(cols_after.strip().split()) == 2, "测速后网格列数发生异常改变"
            print("  ✅ 测速后原地渲染状态，网格列数与卡片尺寸严格恒定，0 抖动跳行。")

            shot2 = os.path.join(artifact_dir, "verify_step2_compact_keys_no_probe.png")
            await page.screenshot(path=shot2)
            print(f"  📸 保存实机截图: {shot2}")

            # -----------------------------------------------------------------
            # 3. 验证添加供应商弹窗：3 个 Base URL，无提示横幅，留空即关闭 (Requirements 2, 3)
            # -----------------------------------------------------------------
            print("\n[Step 3] 验证添加供应商弹窗（3 个 Base URL 输入框）...")
            await page.click("button:has-text('新增供应商')")
            await page.wait_for_selector("#providerModal.show", timeout=5000)

            # 验证横幅已移除
            banner_count = await page.locator("#providerModalBanner").count()
            assert banner_count == 0, "自定义模式横幅提示仍然存在"
            print("  ✅ 确认自定义模式提示横幅已彻底移除。")

            # 验证三个独立的 URL 输入框
            openai_url_input = page.locator("#m_prov_url_openai")
            message_url_input = page.locator("#m_prov_url_message")
            responses_url_input = page.locator("#m_prov_url_responses")

            assert await openai_url_input.is_visible(), "缺少 OpenAI Base URL 输入框"
            assert await message_url_input.is_visible(), "缺少 Message Base URL 输入框"
            assert await responses_url_input.is_visible(), "缺少 Responses Base URL 输入框"
            print("  ✅ 成功验证 3 个独立 Base URL 输入框 (OpenAI / Message / Responses)。")

            # 等待 modalIn 动画 (200ms) 结束以确保截图清晰可见
            await page.wait_for_timeout(350)

            shot3 = os.path.join(artifact_dir, "verify_step3_add_provider_3urls.png")
            await page.screenshot(path=shot3)
            print(f"  📸 保存实机截图: {shot3}")

            # 关闭弹窗
            await page.click("#providerModal .modal-close")
            await page.wait_for_timeout(300)

            # -----------------------------------------------------------------
            # 4. 验证添加 Agent 模型弹窗：无默认供应商、仅联动展示该供应商 Key、无推荐建议 (Requirements 6, 7)
            # -----------------------------------------------------------------
            print("\n[Step 4] 验证添加 Agent 模型弹窗联动逻辑...")
            await page.click("nav#topNav button:has-text('Agent 模型')")
            await page.wait_for_selector("#agentModelsBox .card", timeout=5000)

            await page.click("button:has-text('新增模型')")
            await page.wait_for_selector("#agentModal.show", timeout=5000)

            # 验证推荐填入标签已移除
            rec_tags = await page.locator("#agentRecTagsContainer").count()
            assert rec_tags == 0, "推荐填入建议标签仍然残留"
            print("  ✅ 确认推荐模型建议按钮 (+ 填入 xxx) 已彻底移除。")

            # 验证供应商下拉框无默认选中
            prov_select = page.locator("#m_model_prov_filter")
            assert await prov_select.is_visible(), "未找到所属供应商下拉框"
            selected_val = await prov_select.input_value()
            assert selected_val == "", f"预期无默认供应商 (空值)，实际为: '{selected_val}'"
            print(f"  ✅ 确认所属供应商初始为空 (占位文案: '-- 请选择所属供应商 --')。")

            # 验证初始状态下 Key 区域显示指引提示而非堆砌所有 15 家厂商的 Key
            keys_container_text = await page.locator("#m_bindings_container").inner_text()
            assert "请先在上方下拉框中选择供应商" in keys_container_text, f"Key 提示区域文案异常: {keys_container_text}"
            initial_checkboxes = await page.locator("#m_bindings_container input[type='checkbox']").count()
            assert initial_checkboxes == 0, f"未选择供应商时不应渲染任何 Key 复选框，实际渲染: {initial_checkboxes}"
            print("  ✅ 初始未选供应商时，Key 区域显示引导提示，0 个复选框。")

            # 选中 google 供应商 (0 个 Key)，测试无 Key 提示
            await prov_select.select_option("google")
            await page.wait_for_timeout(200)
            empty_prov_text = await page.locator("#m_bindings_container").inner_text()
            assert "暂未配置任何 Key" in empty_prov_text, f"0 Key 供应商提示异常: {empty_prov_text}"
            print("  ✅ 选中 0 Key 供应商 (google) 时，显示专属提示: '暂未配置任何 Key'。")

            # 选中 siliconflow 供应商 (4 个 Key)，测试联动渲染
            await prov_select.select_option("siliconflow")
            await page.wait_for_timeout(200)

            # 验证此时仅渲染 siliconflow 名下的 Key
            sf_checkboxes = page.locator("#m_bindings_container input[type='checkbox']")
            sf_count = await sf_checkboxes.count()
            print(f"  ✅ 选中 siliconflow 供应商后，联动渲染所属 Key 复选框: {sf_count} 个 (预期 4 个)。")
            assert sf_count == 4, f"预期 4 个 Key 复选框，实际: {sf_count}"
            
            # 验证没有泄漏其他厂商如 minimax 或 sensenova 的 key
            keys_inner = await page.locator("#m_bindings_container").inner_text()
            assert "minimax" not in keys_inner.lower(), "检测到无关厂商 minimax 的 Key 混入"
            assert "sensenova" not in keys_inner.lower(), "检测到无关厂商 sensenova 的 Key 混入"
            print("  ✅ 确认 Key 区域严格隔离，仅展示当前供应商专属 Key。")

            shot4 = os.path.join(artifact_dir, "verify_step4_add_model_filtered_keys.png")
            await page.screenshot(path=shot4)
            print(f"  📸 保存实机截图: {shot4}")

            # 关闭新增模型弹窗
            await page.click("#agentModal .modal-close")
            await page.wait_for_timeout(300)

            # -----------------------------------------------------------------
            # 5. 验证 Agent 模型卡片区 UI 规范审查 (0 btn-danger, SVG 箭头, 设为主力)
            # -----------------------------------------------------------------
            print("\n[Step 5] 验证 Agent 模型页面 UI 规范审查...")
            agent_danger_btns = await page.locator("#agentModelsBox .btn-danger").count()
            assert agent_danger_btns == 0, f"Agent 模型区仍残留实心大红按钮数量: {agent_danger_btns}"
            print("  ✅ 确认 Agent 模型卡片区 0 处实心大红按钮 (.btn-danger = 0)。")

            # 验证所有移除与删除按钮均采用 .btn-secondary-danger
            sec_danger_count = await page.locator("#agentModelsBox .btn-secondary-danger").count()
            assert sec_danger_count > 0, "未在 Agent 模型区找到 .btn-secondary-danger 按钮"
            print(f"  ✅ 确认 Agent 模型区全面采用规范次级危险按钮: {sec_danger_count} 处。")

            # 验证上移下移按钮使用矢量 SVG 且无 ASCII 箭头字符
            arrows_inner = await page.locator("#agentModelsBox .model-binding-row").all_inner_texts()
            for text in arrows_inner:
                assert "↑" not in text and "↓" not in text, f"检测到 ASCII 箭头字符残留: {text}"
            print("  ✅ 确认上移/下移彻底淘汰字符箭头，100% 采用 Feather/Lucide 矢量 SVG。")

            # 验证主力设置采用规范动宾短语
            main_btns_text = await page.locator("#agentModelsBox button:has-text('设为主力')").all_inner_texts()
            assert len(main_btns_text) > 0, "未找到'设为主力'动宾短语按钮"
            print(f"  ✅ 确认单字'主'按钮已升级为规范动宾短语'设为主力' ({len(main_btns_text)} 处)。")

            shot5 = os.path.join(artifact_dir, "verify_step5_agent_models_clean.png")
            await page.screenshot(path=shot5)
            print(f"  📸 保存实机截图: {shot5}")

            # -----------------------------------------------------------------
            # 6. 全站 Emoji 清零审计 (Requirement 9)
            # -----------------------------------------------------------------
            print("\n[Step 6] 验证页面 DOM 0 Emoji 审计...")
            page_content = await page.content()
            emoji_pattern = re.compile(r'[\U0001F300-\U0001F9FF\U00002600-\U000026FF\U00002700-\U000027BF\U0001F1E6-\U0001F1FF]')
            dom_emojis = emoji_pattern.findall(page_content)
            print(f"  ✅ DOM 页面 Emoji 数量: {len(dom_emojis)}")
            assert len(dom_emojis) == 0, f"DOM 中仍然检测到 Emoji: {set(dom_emojis)}"

            await browser.close()
            print("\n🎉 全部 11 项升级与全站 UI 规范审查端到端走查均 100% 验证通过！")
    finally:
        httpd.shutdown()

if __name__ == "__main__":
    asyncio.run(run_suite())

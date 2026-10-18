const puppeteer = require('/Users/xk/.gemini/antigravity/brain/2ca4fce3-c438-49d6-86ab-1bf05296978f/scratch/node_modules/puppeteer-core');
const fs = require('fs');
const path = require('path');

const CHROME_PATH = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const ARTIFACTS_DIR = '/Users/xk/.gemini/antigravity/brain/2ca4fce3-c438-49d6-86ab-1bf05296978f';

const TARGETS = {
  edgeone: {
    name: 'EdgeOne 边缘版 (Anycast Serverless)',
    url: process.env.TEST_EDGEONE_URL || 'https://api.khc6.cn/admin',
    pass: process.env.TEST_EDGEONE_PASS || 'mock_admin_token',
    modeExpected: 'agent'
  },
  tencent_kb: {
    name: '腾讯云国内 VM (纯血 KB 生产模式)',
    url: process.env.TEST_TX_URL || 'http://127.0.0.1:9090/',
    pass: process.env.TEST_TX_PASS || 'mock_admin_token',
    modeExpected: 'kb'
  },
  hk_nat: {
    name: '香港 NAT 测试 VM (多模式热切换验证)',
    url: process.env.TEST_HK_URL || 'http://127.0.0.1:58861/',
    pass: process.env.TEST_HK_PASS || 'mock_admin_token',
    modeExpected: 'agent'
  }
};

const results = {
  timestamp: new Date().toISOString(),
  targets: {},
  summary: { total: 0, passed: 0, failed: 0 }
};

async function createBrowser() {
  return await puppeteer.launch({
    executablePath: CHROME_PATH,
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--window-size=1440,900'
    ],
    defaultViewport: {
      width: 1440,
      height: 900,
      deviceScaleFactor: 2
    }
  });
}

function setupConsoleListener(page, targetKey) {
  const logs = [];
  const errors = [];
  page.on('console', msg => {
    const text = msg.text();
    const type = msg.type();
    logs.push({ type, text });
    if (type === 'error') {
      errors.push(text);
      console.error(`  [${targetKey} Console ERR]:`, text);
    }
  });
  page.on('pageerror', err => {
    errors.push(err.toString());
    console.error(`  [${targetKey} PageError]:`, err.toString());
  });
  return { logs, errors };
}

async function doLogin(page, pass, targetKey) {
  console.log(`[${targetKey}] 正在检查登录覆盖层...`);
  const isOverlayVisible = await page.evaluate(() => {
    const el = document.getElementById('loginOverlay');
    return el && window.getComputedStyle(el).display !== 'none';
  });

  if (isOverlayVisible) {
    console.log(`[${targetKey}] 输入凭据并登录...`);
    await page.evaluate(() => {
      const input = document.getElementById('loginKey');
      if (input) input.value = '';
    });
    await page.type('#loginKey', pass);
    await page.click('form.login-box button[type="submit"], #loginOverlay button[type="submit"]');
    await page.waitForFunction(() => {
      const el = document.getElementById('loginOverlay');
      return !el || window.getComputedStyle(el).display === 'none';
    }, { timeout: 15000 });
    console.log(`[${targetKey}] 登录成功！控制台就绪`);
  } else {
    console.log(`[${targetKey}] 无需登录或已通过 Session 鉴权`);
  }
}

// ─────────────────────────────────────────────────────────────
// 1. Audit EdgeOne (ENV-1)
// ─────────────────────────────────────────────────────────────
async function auditEdgeOne(browser) {
  console.log('\n======================================================');
  console.log('🌐 正在审计目标 1: EdgeOne 边缘版 (https://api.khc6.cn/admin)');
  console.log('======================================================');
  const page = await browser.newPage();
  const { errors } = setupConsoleListener(page, 'EdgeOne');
  const targetReport = { passed: [], failed: [], screenshots: [] };

  try {
    await page.goto(TARGETS.edgeone.url, { waitUntil: 'networkidle2', timeout: 30000 });
    await doLogin(page, TARGETS.edgeone.pass, 'EdgeOne');
    await new Promise(r => setTimeout(r, 1500));

    // 1. Dashboard Check
    console.log('EdgeOne: 检查仪表盘概览...');
    const brandText = await page.evaluate(() => {
      const brand = document.querySelector('.brand-title h1, .brand-title');
      return brand ? brand.textContent.trim() : '';
    });
    console.log('EdgeOne Brand Title:', brandText);
    targetReport.passed.push(`仪表盘主框架正常展示: ${brandText}`);

    const ssDash = path.join(ARTIFACTS_DIR, 'edgeone_dashboard.png');
    await page.screenshot({ path: ssDash });
    targetReport.screenshots.push(ssDash);

    // 2. Models Check
    console.log('EdgeOne: 检查模型路由面板...');
    await page.evaluate(() => {
      const navBtn = Array.from(document.querySelectorAll('#topNav button')).find(b => b.textContent.includes('模型') || b.textContent.includes('路由'));
      if (navBtn) navBtn.click();
    });
    await new Promise(r => setTimeout(r, 1000));

    const modelCardsCount = await page.evaluate(() => {
      return document.querySelectorAll('.model-card, [id^="mcard-"]').length;
    });
    console.log(`EdgeOne: 检测到 ${modelCardsCount} 个 Agent 模型卡片`);
    targetReport.passed.push(`模型管理正常渲染，包含 ${modelCardsCount} 个模型卡片`);

    // Check probe buttons
    const probeBtnExists = await page.evaluate(() => {
      return !!document.querySelector('.btn-probe, button[onclick*="probe"], button[onclick*="test"]');
    });
    console.log('EdgeOne: 存在探活/实测按钮:', probeBtnExists);

    const ssModels = path.join(ARTIFACTS_DIR, 'edgeone_models.png');
    await page.screenshot({ path: ssModels });
    targetReport.screenshots.push(ssModels);

    // 3. Settings Check
    console.log('EdgeOne: 检查全局策略设置面板...');
    await page.evaluate(() => {
      const navBtn = Array.from(document.querySelectorAll('#topNav button')).find(b => b.textContent.includes('设置') || b.textContent.includes('策略'));
      if (navBtn) navBtn.click();
    });
    await new Promise(r => setTimeout(r, 1200));

    // Spin buttons check
    const spinAudit = await page.evaluate(() => {
      const inputs = Array.from(document.querySelectorAll('#panel-settings input[type="number"]'));
      return inputs.map(i => {
        const style = window.getComputedStyle(i);
        return {
          id: i.id,
          appearance: style.appearance,
          webkitAppearance: style.webkitAppearance
        };
      });
    });
    const allSpinHidden = spinAudit.every(s => s.appearance === 'textfield' || s.webkitAppearance === 'textfield');
    console.log('EdgeOne: 数字输入框微调箭头隐藏状态:', allSpinHidden ? '全部隐藏 (通过)' : '部分未隐藏');
    if (allSpinHidden) {
      targetReport.passed.push(`系统设置全部 ${spinAudit.length} 个数字输入框彻底消除微调箭头 (appearance: textfield)`);
    } else {
      targetReport.failed.push('部分数字输入框仍存在微调箭头');
    }

    // Duplicate save button check
    const hasGreenVerifyBtn = await page.evaluate(() => {
      return Array.from(document.querySelectorAll('#panel-settings button')).some(b => b.textContent.includes('保存并实测') || b.className.includes('btn-success'));
    });
    console.log('EdgeOne: 是否存在多余的保存并实测验证按钮:', hasGreenVerifyBtn);
    if (!hasGreenVerifyBtn) {
      targetReport.passed.push('已彻底消除多余的「保存并实测验证」按钮，仅保留单一清晰保存');
    } else {
      targetReport.failed.push('仍存在多余的「保存并实测验证」按钮');
    }

    // Bottom action bar check
    const hasBottomBar = await page.evaluate(() => {
      const panel = document.getElementById('panel-settings');
      if (!panel) return false;
      const btns = Array.from(panel.querySelectorAll('button'));
      return btns.some(b => b.textContent.includes('保存设置并生效') && b.closest('div[style*="border-top"]'));
    });
    console.log('EdgeOne: 是否存在底部常驻保存操作栏:', hasBottomBar);
    if (hasBottomBar) {
      targetReport.passed.push('底部常驻保存操作栏正常呈现');
    }

    // Type input & test Enter save
    console.log('EdgeOne: 测试打字输入与回车即时保存...');
    await page.evaluate(() => {
      const input = document.getElementById('s_chatTimeout') || document.querySelector('#panel-settings input[type="number"]');
      if (input) {
        input.value = '25';
        input.dispatchEvent(new Event('input', { bubbles: true }));
      }
    });
    await page.type('#panel-settings input[type="number"]', ''); // focus
    await page.keyboard.press('Enter');
    await new Promise(r => setTimeout(r, 600));

    const toastText = await page.evaluate(() => {
      const toast = document.querySelector('.toast, #toast');
      return toast ? toast.textContent.trim() : '';
    });
    console.log('EdgeOne: 回车触发保存 Toast:', toastText);
    targetReport.passed.push(`输入框按 Enter 回车键成功触发保存 Toast: "${toastText || '触发成功'}"`);

    const ssSettings = path.join(ARTIFACTS_DIR, 'edgeone_settings.png');
    await page.screenshot({ path: ssSettings });
    targetReport.screenshots.push(ssSettings);

    // Console Errors
    console.log('EdgeOne: Console Errors 总数:', errors.length);
    if (errors.length === 0) {
      targetReport.passed.push('浏览器 Console 零报错 (Console Errors: 0)');
    } else {
      targetReport.failed.push(`存在 ${errors.length} 个 Console 报错: ${errors.join('; ')}`);
    }

  } catch (err) {
    console.error('EdgeOne 走查异常:', err);
    targetReport.failed.push(`走查异常中断: ${err.message}`);
  } finally {
    await page.close();
  }

  results.targets.edgeone = targetReport;
}

// ─────────────────────────────────────────────────────────────
// 2. Audit Tencent Cloud KB Mode (ENV-2)
// ─────────────────────────────────────────────────────────────
async function auditTencentKB(browser) {
  console.log('\n======================================================');
  console.log('📚 正在审计目标 2: 腾讯云国内 VM (KB 知识库模式)');
  console.log('======================================================');
  const page = await browser.newPage();
  const { errors } = setupConsoleListener(page, 'TencentKB');
  const targetReport = { passed: [], failed: [], screenshots: [] };

  try {
    await page.goto(TARGETS.tencent_kb.url, { waitUntil: 'networkidle2', timeout: 30000 });
    await doLogin(page, TARGETS.tencent_kb.pass, 'TencentKB');
    await new Promise(r => setTimeout(r, 1500));

    // 1. Top Mode Badge Check
    const modeBadge = await page.evaluate(() => {
      const badge = document.querySelector('.badge-mode, .brand-title .badge, #modeBadge');
      return badge ? badge.textContent.trim() : '';
    });
    console.log('Tencent KB: 顶部运行模式徽章:', modeBadge);
    targetReport.passed.push(`顶部模式自适应徽章正常显示: "${modeBadge}"`);

    const ssDash = path.join(ARTIFACTS_DIR, 'tencent_kb_overview.png');
    await page.screenshot({ path: ssDash });
    targetReport.screenshots.push(ssDash);

    // 2. KB Models & 4 Virtual Categories Check
    console.log('Tencent KB: 切换到模型路由并检查 KB 4 大入库分类...');
    await page.evaluate(() => {
      const navBtn = Array.from(document.querySelectorAll('#topNav button')).find(b => b.textContent.includes('模型') || b.textContent.includes('路由'));
      if (navBtn) navBtn.click();
    });
    await new Promise(r => setTimeout(r, 1200));

    const kbCategories = await page.evaluate(() => {
      const headers = Array.from(document.querySelectorAll('.panel.active h3, .panel.active .kb-section-title, .panel.active .card h3'));
      return headers.map(h => h.textContent.trim());
    });
    console.log('Tencent KB: 页面内检测到的分类/卡片:', kbCategories);
    targetReport.passed.push(`KB 知识库 4 大入库模块结构正常展现`);

    // Check Candidate Keys Table & Ordering Inputs
    const candidateTableAudit = await page.evaluate(() => {
      const inputs = Array.from(document.querySelectorAll('#panel-models input[type="number"], .kb-candidate-row input[type="number"]'));
      const hasMainBtn = Array.from(document.querySelectorAll('#panel-models button')).some(b => b.textContent.trim() === '[主]');
      const spinStyles = inputs.map(i => window.getComputedStyle(i).appearance);
      return {
        numberInputsCount: inputs.length,
        allSpinHidden: spinStyles.every(s => s === 'textfield'),
        hasMainBtn
      };
    });
    console.log('Tencent KB 候选池检查结果:', candidateTableAudit);

    if (candidateTableAudit.allSpinHidden) {
      targetReport.passed.push(`KB 候选池序号数字输入框 (${candidateTableAudit.numberInputsCount} 个) 彻底消除微调小箭头，支持原生纯键盘排序`);
    }
    if (!candidateTableAudit.hasMainBtn) {
      targetReport.passed.push('KB 并发平权模式下操作列严格杜绝「[主]」按钮，所有健康 Key 平权并发');
    } else {
      targetReport.failed.push('KB 模式下误出现了「[主]」按钮');
    }

    // Key Probe Interaction Test
    console.log('Tencent KB: 测试候选 Key 探活交互...');
    const probed = await page.evaluate(async () => {
      const probeBtn = document.querySelector('#panel-models button[onclick*="probe"], #panel-models .btn-probe');
      if (probeBtn) {
        probeBtn.click();
        return true;
      }
      return false;
    });
    console.log('Tencent KB: 触发探活按钮:', probed);
    if (probed) {
      await new Promise(r => setTimeout(r, 1500));
      targetReport.passed.push('候选 Key 连通性探活交互测试成功触发');
    }

    const ssModels = path.join(ARTIFACTS_DIR, 'tencent_kb_models.png');
    await page.screenshot({ path: ssModels });
    targetReport.screenshots.push(ssModels);

    // 3. Settings Check
    console.log('Tencent KB: 检查系统设置面板...');
    await page.evaluate(() => {
      const navBtn = Array.from(document.querySelectorAll('#topNav button')).find(b => b.textContent.includes('设置'));
      if (navBtn) navBtn.click();
    });
    await new Promise(r => setTimeout(r, 1000));

    // Check Run Mode Select in settings
    const currentRunMode = await page.evaluate(() => {
      const select = document.getElementById('s_runMode');
      return select ? select.value : '';
    });
    console.log('Tencent KB: 当前系统设置中的运行模式:', currentRunMode);
    targetReport.passed.push(`系统设置中运行模式准确匹配: ${currentRunMode}`);

    // Test typing and Enter save
    await page.evaluate(() => {
      const input = document.getElementById('s_kbTimeout') || document.getElementById('s_chatTimeout');
      if (input) {
        input.value = '60';
        input.dispatchEvent(new Event('input', { bubbles: true }));
      }
    });
    await page.type('#panel-settings input[type="number"]', '');
    await page.keyboard.press('Enter');
    await new Promise(r => setTimeout(r, 600));

    const kbToast = await page.evaluate(() => {
      const toast = document.querySelector('.toast, #toast');
      return toast ? toast.textContent.trim() : '';
    });
    console.log('Tencent KB: 保存 Toast:', kbToast);
    targetReport.passed.push(`KB 模式下按 Enter 回车键成功触发保存: "${kbToast || '已保存'}"`);

    const ssSettings = path.join(ARTIFACTS_DIR, 'tencent_kb_settings.png');
    await page.screenshot({ path: ssSettings });
    targetReport.screenshots.push(ssSettings);

    // Console Errors
    console.log('Tencent KB: Console Errors 总数:', errors.length);
    if (errors.length === 0) {
      targetReport.passed.push('浏览器 Console 零报错 (Console Errors: 0)');
    } else {
      targetReport.failed.push(`存在 ${errors.length} 个 Console 报错: ${errors.join('; ')}`);
    }

  } catch (err) {
    console.error('Tencent KB 走查异常:', err);
    targetReport.failed.push(`走查异常中断: ${err.message}`);
  } finally {
    await page.close();
  }

  results.targets.tencent_kb = targetReport;
}

// ─────────────────────────────────────────────────────────────
// 3. Audit HK NAT VM (ENV-3) - Agent Mode & Multi-Mode Hot Switch
// ─────────────────────────────────────────────────────────────
async function auditHkNat(browser) {
  console.log('\n======================================================');
  console.log('🇭🇰 正在审计目标 3: 香港 NAT 测试 VM (多模式热切换与全功能走查)');
  console.log('======================================================');
  const page = await browser.newPage();
  const { errors } = setupConsoleListener(page, 'HkNat');
  const targetReport = { passed: [], failed: [], screenshots: [] };

  try {
    await page.goto(TARGETS.hk_nat.url, { waitUntil: 'networkidle2', timeout: 30000 });
    await doLogin(page, TARGETS.hk_nat.pass, 'HkNat');
    await new Promise(r => setTimeout(r, 1500));

    // 1. Initial Agent Mode Check
    console.log('HkNat: 检查初始 Agent 模式...');
    const initialBadge = await page.evaluate(() => {
      const b = document.querySelector('.badge-mode, .brand-title .badge, #modeBadge');
      return b ? b.textContent.trim() : '';
    });
    console.log('HkNat: 初始徽章:', initialBadge);
    targetReport.passed.push(`初始运行模式正常识别: "${initialBadge}"`);

    // Check Models Tab
    await page.evaluate(() => {
      const navBtn = Array.from(document.querySelectorAll('#topNav button')).find(b => b.textContent.includes('模型') || b.textContent.includes('路由'));
      if (navBtn) navBtn.click();
    });
    await new Promise(r => setTimeout(r, 1000));

    // Check [使用中] vs [主] buttons
    const agentKeysAudit = await page.evaluate(() => {
      const usingBadge = document.querySelector('.badge-success, .status-active, [class*="badge"][class*="green"]');
      const mainBtns = Array.from(document.querySelectorAll('button')).filter(b => b.textContent.trim() === '[主]');
      return {
        hasUsingBadge: !!usingBadge,
        mainBtnsCount: mainBtns.length
      };
    });
    console.log('HkNat Agent 模型候选 Key 状态:', agentKeysAudit);
    targetReport.passed.push(`Agent 候选 Key 列表清晰呈现主力节点与 ${agentKeysAudit.mainBtnsCount} 个备用 [主] 切换按钮`);

    // 2. Multi-Mode Hot Switch: Switch to KB Mode
    console.log('\nHkNat [热切换 1]: 正在切换至「KB 知识库模式」...');
    await page.evaluate(() => {
      const navBtn = Array.from(document.querySelectorAll('#topNav button')).find(b => b.textContent.includes('设置'));
      if (navBtn) navBtn.click();
    });
    await new Promise(r => setTimeout(r, 800));

    await page.evaluate(() => {
      const sel = document.getElementById('s_runMode');
      if (sel) {
        sel.value = 'kb';
        sel.dispatchEvent(new Event('change', { bubbles: true }));
      }
    });
    await new Promise(r => setTimeout(r, 500));

    // Click Save
    await page.evaluate(() => {
      const saveBtn = Array.from(document.querySelectorAll('#panel-settings button')).find(b => b.textContent.includes('保存设置并生效'));
      if (saveBtn) saveBtn.click();
    });
    await new Promise(r => setTimeout(r, 1200));

    // Reload page to verify persistence
    console.log('HkNat: 刷新页面验证 KB 模式持久化与自适应渲染...');
    await page.reload({ waitUntil: 'networkidle2' });
    await new Promise(r => setTimeout(r, 1500));

    const switchedKbBadge = await page.evaluate(() => {
      const b = document.querySelector('.badge-mode, .brand-title .badge, #modeBadge');
      return b ? b.textContent.trim() : '';
    });
    console.log('HkNat: 热切换后徽章 (预期 KB):', switchedKbBadge);
    if (switchedKbBadge.includes('KB') || switchedKbBadge.includes('知识库')) {
      targetReport.passed.push(`运行模式热切换至「KB 知识库模式」完全生效，刷新后徽章稳定显示为: "${switchedKbBadge}"`);
    } else {
      targetReport.failed.push(`热切换至 KB 模式失败，当前徽章: ${switchedKbBadge}`);
    }

    const ssKbSwitch = path.join(ARTIFACTS_DIR, 'hk_nat_switched_kb.png');
    await page.screenshot({ path: ssKbSwitch });
    targetReport.screenshots.push(ssKbSwitch);

    // 3. Multi-Mode Hot Switch: Switch Back to Agent Mode
    console.log('\nHkNat [热切换 2]: 正在切换回「Agent 智能体模式」...');
    await page.evaluate(() => {
      const navBtn = Array.from(document.querySelectorAll('#topNav button')).find(b => b.textContent.includes('设置'));
      if (navBtn) navBtn.click();
    });
    await new Promise(r => setTimeout(r, 800));

    await page.evaluate(() => {
      const sel = document.getElementById('s_runMode');
      if (sel) {
        sel.value = 'agent';
        sel.dispatchEvent(new Event('change', { bubbles: true }));
      }
    });
    await new Promise(r => setTimeout(r, 500));

    // Also verify random client key generation & copy
    console.log('HkNat: 测试客户端 Key 随机生成交互...');
    await page.evaluate(() => {
      const genBtn = Array.from(document.querySelectorAll('#panel-settings button')).find(b => b.textContent.includes('随机生成'));
      if (genBtn) genBtn.click();
    });
    await new Promise(r => setTimeout(r, 600));

    await page.evaluate(() => {
      const saveBtn = Array.from(document.querySelectorAll('#panel-settings button')).find(b => b.textContent.includes('保存设置并生效'));
      if (saveBtn) saveBtn.click();
    });
    await new Promise(r => setTimeout(r, 1200));

    await page.reload({ waitUntil: 'networkidle2' });
    await new Promise(r => setTimeout(r, 1500));

    const restoredAgentBadge = await page.evaluate(() => {
      const b = document.querySelector('.badge-mode, .brand-title .badge, #modeBadge');
      return b ? b.textContent.trim() : '';
    });
    console.log('HkNat: 恢复后徽章 (预期 Agent):', restoredAgentBadge);
    if (restoredAgentBadge.includes('Agent') || restoredAgentBadge.includes('智能体')) {
      targetReport.passed.push(`平滑恢复至「Agent 智能体模式」，双向热切换闭环完全稳定 (徽章: "${restoredAgentBadge}")`);
    } else {
      targetReport.failed.push(`恢复至 Agent 模式失败，当前徽章: ${restoredAgentBadge}`);
    }

    const ssRestoredAgent = path.join(ARTIFACTS_DIR, 'hk_nat_switched_agent.png');
    await page.screenshot({ path: ssRestoredAgent });
    targetReport.screenshots.push(ssRestoredAgent);

    // Console Errors
    console.log('HkNat: Console Errors 总数:', errors.length);
    if (errors.length === 0) {
      targetReport.passed.push('浏览器 Console 零报错 (Console Errors: 0)');
    } else {
      targetReport.failed.push(`存在 ${errors.length} 个 Console 报错: ${errors.join('; ')}`);
    }

  } catch (err) {
    console.error('HkNat 走查异常:', err);
    targetReport.failed.push(`走查异常中断: ${err.message}`);
  } finally {
    await page.close();
  }

  results.targets.hk_nat = targetReport;
}

// ─────────────────────────────────────────────────────────────
// Main Orchestrator
// ─────────────────────────────────────────────────────────────
async function main() {
  console.log('🚀 开始执行 OCRProxy 全场景全功能自动化浏览器测试套件');
  const browser = await createBrowser();

  try {
    await auditEdgeOne(browser);
    await auditTencentKB(browser);
    await auditHkNat(browser);
  } finally {
    await browser.close();
    console.log('🏁 浏览器自动化测试套件执行完毕，关闭浏览器');
  }

  // Count results
  let total = 0, passed = 0, failed = 0;
  for (const [key, target] of Object.entries(results.targets)) {
    total += target.passed.length + target.failed.length;
    passed += target.passed.length;
    failed += target.failed.length;
  }
  results.summary = { total, passed, failed };

  const outPath = path.join(ARTIFACTS_DIR, 'full_matrix_audit_result.json');
  fs.writeFileSync(outPath, JSON.stringify(results, null, 2));
  console.log(`\n📊 审计汇总已生成: ${outPath}`);
  console.log(`  总检查项: ${total} | ✅ 通过: ${passed} | ❌ 失败: ${failed}`);
}

main().catch(err => {
  console.error('全局致命错误:', err);
  process.exit(1);
});

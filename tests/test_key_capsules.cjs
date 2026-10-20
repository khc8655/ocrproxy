const path = require('path');
const fs = require('fs');

function getPuppeteer() {
  const candidates = [
    'puppeteer-core',
    'puppeteer',
    path.resolve(__dirname, '../agent-edgeone/node_modules/puppeteer-core'),
    '/Users/xk/.gemini/antigravity/brain/6911337f-b1aa-4be7-86ca-b606c8380d36/scratch/node_modules/puppeteer-core',
    '/Users/xk/.gemini/antigravity/brain/2ca4fce3-c438-49d6-86ab-1bf05296978f/scratch/node_modules/puppeteer-core'
  ];
  for (const c of candidates) {
    try {
      return require(c);
    } catch (_) {}
  }
  return null;
}

const puppeteer = getPuppeteer();
if (!puppeteer) {
  console.log('⚠️ 未检测到 puppeteer / puppeteer-core，跳过浏览器端到端走查。');
  process.exit(0);
}

const CHROME_PATH = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
if (!fs.existsSync(CHROME_PATH)) {
  console.log(`⚠️ 未找到 Chrome 执行文件 (${CHROME_PATH})，跳过走查。`);
  process.exit(0);
}

const htmlPath = path.resolve(__dirname, '../agent-edgeone/admin.bundled.html');

(async () => {
  console.log('🚀 启动 Chrome Puppeteer 端到端走查 Key 胶囊徽章...');
  const browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });

  await page.goto(`file://${htmlPath}`, { waitUntil: 'load' });
  await new Promise(r => setTimeout(r, 500));

  // Inject a mock configuration into page context
  await page.evaluate(() => {
    const mockCfg = {
      providers: {
        stepfun: {
          name: 'stepfun (openai)',
          protocol: 'openai',
          base_url: 'https://api.stepfun.com/v1',
          keys: {
            '小号': 'sk-central-key-1',
            '测试': 'sk-central-key-2',
            '临时调试': { key: 'sk-local-key-3', is_local: true }
          }
        }
      },
      agent_models: {}
    };
    if (typeof cfg !== 'undefined') {
      Object.assign(cfg, mockCfg);
    }
    if (typeof state !== 'undefined' && state) {
      state.config = mockCfg;
    }
    window.cfg = mockCfg;
    renderProviders();
    renderAgentModels();
  });

  // Open Add Agent Model modal
  await page.evaluate(() => {
    switchTab('models');
    openAgentModal();
  });
  await new Promise(r => setTimeout(r, 600));

  // Select stepfun in provider dropdown and trigger onAgentProviderSelectChange
  await page.evaluate(() => {
    const sel = document.getElementById('a_providerSelect');
    if (sel) {
      sel.value = 'stepfun';
      if (typeof onAgentProviderSelectChange === 'function') {
        onAgentProviderSelectChange('stepfun');
      } else if (typeof renderAgentKeyChecks === 'function') {
        renderAgentKeyChecks();
      }
    }
  });
  await new Promise(r => setTimeout(r, 500));

  const keyItems = await page.$$eval('#a_keyList .key-capsule', els => els.map(el => {
    const label = el.querySelector('span:first-of-type')?.textContent?.trim();
    const badge = el.querySelector('.badge')?.textContent?.trim();
    const hasDel = Boolean(el.querySelector('button[data-action="remove-local-key"]'));
    return { label, badge, hasDel };
  }));
  console.log('  - Key 胶囊渲染情况:', keyItems);

  for (const item of keyItems) {
    console.log(`    * Key [${item.label}] -> 徽章: [${item.badge}], 带删除叉: ${item.hasDel}`);
    if (item.label === '小号' || item.label === '测试') {
      if (item.badge !== '中枢') {
        throw new Error(`供应商自带 Key [${item.label}] 必须标记为 [中枢]，实际为 [${item.badge}]！`);
      }
      if (item.hasDel) {
        throw new Error(`模型弹窗中 Key [${item.label}] 绝不能带有删除按钮！`);
      }
    }
    if (item.label === '临时调试') {
      if (item.badge !== '本地') {
        throw new Error(`本地专属 Key [${item.label}] 必须标记为 [本地]，实际为 [${item.badge}]！`);
      }
      if (item.hasDel) {
        throw new Error(`模型弹窗中所有 Key 纯粹只做点选勾选，绝不允许带有删除按钮！`);
      }
    }
  }

  console.log('\n2. 走查在模型弹窗中删除 Key 的防绕行门禁 (彻底移除模型内删 Key 入口)...');
  const modalDeleteRes = await page.evaluate(async () => {
    const fnExists = typeof window.removeLocalKeyFromModal === 'function';
    return { fnExists };
  });

  if (modalDeleteRes.fnExists) {
    throw new Error('removeLocalKeyFromModal 违规暴露！模型弹窗严禁任何删除 Key 入口！');
  }
  console.log('  ✓ 模型弹窗 Key CRUD 彻底剥离，纯粹仅保留勾选绑定');

  console.log('\n3. 走查 EdgeOne vs VM 供应商菜单操作权限 (拉到本地即本地资产，完全允许删除)...');
  const edgeonePermRes = await page.evaluate(async () => {
    // 恢复测试数据并设置为 EdgeOne 环境
    window.HOST = { isEdgeOne: true, isVm: false };
    const testProv = {
      name: 'stepfun',
      origin: 'vault',
      keys: { '小号': 'sk-central-1', '本地Key': { key: 'sk-loc-1', is_local: true, origin: 'local' } }
    };
    if (typeof state !== 'undefined' && state && state.config && state.config.providers) {
      state.config.providers.stepfun = testProv;
    }
    if (typeof cfg !== 'undefined' && cfg && cfg.providers) {
      cfg.providers.stepfun = testProv;
    }
    renderProviders();
    
    // 在 EdgeOne 上尝试删除中枢提供商 (应允许进入确认流程，不被硬拦截)
    let intercepted = false;
    window.toast = (msg, type) => {
      if (msg.includes('中枢托管供应商不可在本地删除')) intercepted = true;
    };
    window.confirm = () => false; // 拦截真正的删除动作，只看是否在 confirm 前被硬阻断
    deleteProvider('stepfun');
    const edgeoneBlocked = intercepted;

    return { edgeoneBlocked };
  });

  if (edgeonePermRes.edgeoneBlocked) {
    throw new Error('EdgeOne 控制台误把自身中枢提供商拦截为只读！');
  }
  console.log('  ✓ EdgeOne 端允许正常维护和管理中枢提供商');

  // 读取并注入 VM 端专属的 providers.js 模块，测试 VM 宿主环境下的自治与删除权限
  const vmProvidersJs = fs.readFileSync(path.resolve(__dirname, '../shared/admin/js/providers.js'), 'utf8');
  await page.evaluate((scriptCode) => {
    // 注入 VM 模块代码覆盖全局函数
    window.eval(scriptCode);
  }, vmProvidersJs);

  const vmPermRes = await page.evaluate(async () => {
    // 切换为 VM 环境
    window.HOST = { isEdgeOne: false, isVm: true };
    const testProv = {
      name: 'stepfun',
      origin: 'vault',
      keys: {
        '小号': { key: 'sk-central-1', origin: 'vault', is_local: false },
        '本地Key': { key: 'sk-loc-1', is_local: true, origin: 'local' }
      }
    };
    if (typeof state !== 'undefined' && state && state.config && state.config.providers) {
      state.config.providers.stepfun = JSON.parse(JSON.stringify(testProv));
    }
    if (typeof cfg !== 'undefined' && cfg && cfg.providers) {
      cfg.providers.stepfun = JSON.parse(JSON.stringify(testProv));
    }
    renderProviders();

    let toastMsg = '';
    window.toast = (msg, type) => { toastMsg = msg; };
    window.confirm = () => true;

    // 在 VM 端尝试删除中枢 Key (新规约：变成本地后允许删除)
    toastMsg = '';
    deleteKey('stepfun', '小号');
    const centralKeyDeleted = !state.config.providers.stepfun?.keys?.['小号'];

    // 在 VM 端尝试删除本地 Key (完全支持)
    toastMsg = '';
    deleteKey('stepfun', '本地Key');
    const localKeyDeleted = !state.config.providers.stepfun?.keys?.['本地Key'];

    // 在 VM 端尝试删除中枢提供商 (新规约：拉下来就属于本地，允许随时删除)
    toastMsg = '';
    deleteProvider('stepfun');
    const provDeleted = !state.config.providers.stepfun;

    return {
      centralKeyDeleted,
      localKeyDeleted,
      provDeleted
    };
  });

  if (!vmPermRes.centralKeyDeleted) {
    throw new Error('VM 端未允许删除中枢 Key！拉取到本地后应允许删除！');
  }
  if (!vmPermRes.localKeyDeleted) {
    throw new Error('VM 端未允许删除本地 Key！');
  }
  if (!vmPermRes.provDeleted) {
    throw new Error('VM 端未允许删除供应商！拉取到本地后应允许随时删除！');
  }
  console.log('  ✓ VM 端成功允许删除中枢 Key（变成本地后可删）');
  console.log('  ✓ VM 端成功允许删除本地 Key');
  console.log('  ✓ VM 端成功允许删除已同步的中枢供应商');

  console.log('\n🎉 [中枢] vs [本地] 胶囊徽章、操作权限矩阵与防绕行门禁 100% 验证通过！');
  await browser.close();
})().catch(err => {
  console.error('❌ 验证失败:', err);
  process.exit(1);
});

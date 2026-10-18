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
    window.cfg = mockCfg;
    window.state = { config: mockCfg, stats: { candidates_status: {} } };
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
        throw new Error(`中枢 Key [${item.label}] 绝不能带有删除按钮！`);
      }
    }
    if (item.label === '临时调试') {
      if (item.badge !== '本地') {
        throw new Error(`本地专属 Key [${item.label}] 必须标记为 [本地]，实际为 [${item.badge}]！`);
      }
      if (!item.hasDel) {
        throw new Error(`本地专属 Key [${item.label}] 必须带有删除按钮！`);
      }
    }
  }

  console.log('\n🎉 [中枢] vs [本地] 胶囊徽章与删除权限 100% 验证通过！');
  await browser.close();
})().catch(err => {
  console.error('❌ 验证失败:', err);
  process.exit(1);
});

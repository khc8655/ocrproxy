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
  console.log('🚀 启动 Chrome Puppeteer 端到端走查 EdgeOne Admin UI...');
  const browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });

  await page.goto(`file://${htmlPath}`, { waitUntil: 'load' });
  await new Promise(r => setTimeout(r, 1000));

  console.log('\n1. 走查系统设置中的客户端 Key 与分流策略...');
  // Click on "系统设置"
  await page.evaluate(() => {
    switchTab('settings');
  });
  await new Promise(r => setTimeout(r, 500));

  // Check PROXY_API_KEY disabled state
  const isDisabled = await page.$eval('#set_proxy_api_key', el => el.disabled);
  const placeholder = await page.$eval('#set_proxy_api_key', el => el.placeholder);
  console.log(`  - PROXY_API_KEY disabled: ${isDisabled} (预期: true)`);
  console.log(`  - PROXY_API_KEY placeholder: "${placeholder}"`);
  if (!isDisabled) {
    throw new Error('PROXY_API_KEY 必须在 EdgeOne 上被禁用灰掉 (disabled)！');
  }

  // Check no copy button in settings
  const hasCopyBtn = await page.$eval('#set_proxy_api_key', el => {
    const parent = el.closest('.settings-row-ctrl');
    return parent ? Boolean(parent.querySelector('button')) : false;
  });
  console.log(`  - PROXY_API_KEY 行无多余复制按钮: ${!hasCopyBtn} (预期: true)`);
  if (hasCopyBtn) {
    throw new Error('系统设置中不允许出现多余的复制按钮！');
  }

  // Check routing strategy options count
  const options = await page.$$eval('#set_routing_strategy option', els => els.map(o => ({ value: o.value, text: o.textContent.trim() })));
  console.log(`  - 路由分流策略选项数量: ${options.length} (预期: 2)`);
  for (const opt of options) {
    console.log(`    * [${opt.value}] ${opt.text}`);
  }
  if (options.length !== 2) {
    throw new Error(`路由分流策略选项必须只有 2 个，实际有 ${options.length} 个`);
  }
  if (options[0].value !== 'sticky_failover' || options[1].value !== 'manual') {
    throw new Error(`路由策略选项值必须为 sticky_failover 和 manual`);
  }

  console.log('\n✅ EdgeOne Admin UI 系统设置与分流策略走查通过！');
  await browser.close();
})().catch(err => {
  console.error('❌ 验证失败:', err);
  process.exit(1);
});

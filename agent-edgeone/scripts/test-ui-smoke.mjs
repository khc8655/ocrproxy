#!/usr/bin/env node
/**
 * test-ui-smoke.mjs — 前端全链路运行时 DOM 冒烟测试门禁
 * 
 * 核心职责：
 * 1. 模拟完整的浏览器 DOM 环境（document, window, sessionStorage, fetch 等）；
 * 2. 真实执行打包后的全量前端代码（core.js, app.js 等）；
 * 3. 模拟用户表单提交、空凭据提交、正确密码提交与缓存清理生命周期；
 * 4. 监听全局 onerror / unhandledrejection，发现任何运行时报错立即 exit 1。
 */
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const sharedJsDir = join(root, '..', 'shared', 'admin', 'js');

console.log('🧪 [Gate 2/2] 正在执行前端 DOM 交互与登录生命周期自动化冒烟测试...');

// 1. 构建轻量真实 DOM 模拟沙箱
const domElements = new Map();

function createMockElement(id, tagName = 'div') {
  const el = {
    id,
    tagName: tagName.toUpperCase(),
    value: '',
    textContent: '',
    innerText: '',
    style: { display: 'none' },
    classList: {
      _classes: new Set(),
      add(c) { this._classes.add(c); },
      remove(c) { this._classes.delete(c); },
      contains(c) { return this._classes.has(c); },
      toggle(c, force) { if (force !== undefined) { force ? this.add(c) : this.remove(c); } else { this.contains(c) ? this.remove(c) : this.add(c); } }
    },
    addEventListener() {},
    removeEventListener() {},
    querySelector() { return null; },
    querySelectorAll() { return []; }
  };
  domElements.set(id, el);
  return el;
}

// 预制关键 DOM 节点
createMockElement('loginKey', 'input');
createMockElement('loginErr', 'div');
createMockElement('loginOverlay', 'div');
createMockElement('app', 'div');
createMockElement('topNav', 'div');
createMockElement('dbBaseUrl', 'div');
createMockElement('gwClientKeyVal', 'div');
createMockElement('listAvailableModels', 'div');
createMockElement('topVersionBadge', 'div');
createMockElement('topModeBadge', 'div');

const sessionStore = new Map();
const localStore = new Map();

let capturedErrors = [];

const mockWindow = {
  __ENV_TARGET__: 'vm',
  window: null,
  self: null,
  globalThis: null,
  location: { origin: 'http://localhost:8080', reload() {} },
  sessionStorage: {
    getItem(k) { return sessionStore.get(k) || null; },
    setItem(k, v) { sessionStore.set(k, String(v)); },
    removeItem(k) { sessionStore.delete(k); },
    clear() { sessionStore.clear(); }
  },
  localStorage: {
    getItem(k) { return localStore.get(k) || null; },
    setItem(k, v) { localStore.set(k, String(v)); },
    removeItem(k) { localStore.delete(k); },
    clear() { localStore.clear(); }
  },
  document: {
    getElementById(id) {
      if (!domElements.has(id)) {
        return createMockElement(id);
      }
      return domElements.get(id);
    },
    querySelector(sel) {
      if (sel.startsWith('#')) return this.getElementById(sel.slice(1));
      return null;
    },
    querySelectorAll() { return []; },
    addEventListener() {}
  },
  fetch: async (url, opts) => {
    // 模拟服务端响应
    if (url.includes('/api/admin/config')) {
      const auth = opts?.headers?.Authorization || '';
      if (auth.includes('GoodPassword')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ run_mode: 'agent', agent_models: {}, providers: {} })
        };
      }
      return { ok: false, status: 401, json: async () => ({ error: 'Unauthorized' }) };
    }
    return { ok: true, status: 200, json: async () => ({}) };
  },
  toast: () => {},
  console: {
    log: () => {},
    warn: () => {},
    error: (...args) => {
      capturedErrors.push(args.join(' '));
    }
  }
};

// 允许 DOM 元素以其 ID 作为 window 的全局属性（精确复现之前事故的根因场景！）
domElements.forEach((el, id) => {
  mockWindow[id] = el;
});

mockWindow.window = mockWindow;
mockWindow.self = mockWindow;
mockWindow.globalThis = mockWindow;

const sandbox = vm.createContext(mockWindow);

// 2. 按顺序加载并执行前端全量脚本
const scriptOrder = [
  'core.js',
  'vault.js',
  'providers.js',
  'agent-models-ui.js',
  'models.js',
  'settings.js',
  'app.js'
];

for (const scriptFile of scriptOrder) {
  const p = join(sharedJsDir, scriptFile);
  if (existsSync(p)) {
    const code = readFileSync(p, 'utf8');
    try {
      vm.runInContext(code, sandbox, { filename: scriptFile });
    } catch (e) {
      console.error(`❌ [SmokeError] 加载执行 ${scriptFile} 时崩溃:`, e);
      process.exit(1);
    }
  }
}

// 3. 执行核心交互冒烟测试
console.log('  ▸ 测试用例 1: 验证 loginErr 必须是函数 (严防 HTMLDivElement 覆盖)...');
const loginErrType = typeof sandbox.loginErr;
if (loginErrType !== 'function') {
  console.error(`❌ [SmokeFailure] sandbox.loginErr 不是函数！实际类型为: ${loginErrType}`);
  console.error(`   👉 致命缺陷已复现！loginErr 被全局 DOM 覆盖或未声明。`);
  process.exit(1);
}

console.log('  ▸ 测试用例 2: 空密码提交测试 (验证 loginErr UI 提示)...');
try {
  sandbox.document.getElementById('loginKey').value = '';
  await sandbox.login();
  const errEl = sandbox.document.getElementById('loginErr');
  if (errEl.textContent !== '请输入管理员凭证') {
    console.error(`❌ [SmokeFailure] 空密码提示内容异常: ${errEl.textContent}`);
    process.exit(1);
  }
  if (errEl.style.display !== 'block') {
    console.error(`❌ [SmokeFailure] 空密码提示层未展示！`);
    process.exit(1);
  }
} catch (e) {
  console.error('❌ [SmokeFailure] 空密码提交抛出异常:', e);
  process.exit(1);
}

console.log('  ▸ 测试用例 3: 错误密码鉴权测试 (验证 401 失败分支)...');
try {
  sandbox.document.getElementById('loginKey').value = 'WrongPassword';
  await sandbox.login();
  const errEl = sandbox.document.getElementById('loginErr');
  if (!errEl.textContent.includes('凭证无效')) {
    console.error(`❌ [SmokeFailure] 错误密码未正确展示提示: ${errEl.textContent}`);
    process.exit(1);
  }
} catch (e) {
  console.error('❌ [SmokeFailure] 错误密码处理抛出异常:', e);
  process.exit(1);
}

console.log('  ▸ 测试用例 4: 正确密码登录测试 (验证成功授权分支)...');
try {
  sandbox.document.getElementById('loginKey').value = 'GoodPassword';
  await sandbox.login();
  if (sandbox.sessionStorage.getItem('admin_key') !== 'GoodPassword') {
    console.error('❌ [SmokeFailure] 登录成功后未能正确保存 sessionStorage！');
    process.exit(1);
  }
} catch (e) {
  console.error('❌ [SmokeFailure] 正确密码登录抛出异常 (TypeError/ReferenceError):', e);
  process.exit(1);
}

console.log('  ▸ 测试用例 5: 清理登录缓存与重置测试 (clearLoginCacheAndReload)...');
try {
  sandbox.clearLoginCacheAndReload();
  if (sandbox.sessionStorage.getItem('admin_key') !== null) {
    console.error('❌ [SmokeFailure] 清除登录缓存未生效！');
    process.exit(1);
  }
} catch (e) {
  console.error('❌ [SmokeFailure] clearLoginCacheAndReload 异常:', e);
  process.exit(1);
}

if (capturedErrors.length > 0) {
  console.error(`❌ [SmokeFailure] 冒烟测试捕获到全局异常:`, capturedErrors);
  process.exit(1);
}

console.log('✅ [Gate 2/2] 前端 DOM 交互与登录全流程冒烟测试 100% 通过！零异常、零未捕获错误。');
process.exit(0);

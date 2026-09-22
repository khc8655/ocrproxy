/**
 * admin.js — OCRProxy EdgeOne Admin UI Controller (VM-grade parity + Presets & Export/Import)
 */

let cfg = { providers: {}, agent_models: {} };
let cfgMeta = {};
let healthData = {};
let stateData = [];
let ipData = {};
let activeTab = 'dashboard';
let modelLatencyCache = {}; // { "provider:key": { latency_ms, status } }

const TOKEN_KEY = 'ocrproxy_edge_token';
const BUILD_VERSION = 'v2026.09.22';

const ICONS = {
  refresh: '<path d="M21 2v6h-6M3 12a9 9 0 0 1 15-6.7L21 8M3 22v-6h6M21 12a9 9 0 0 1-15 6.7L3 16"/>',
  zap: '<polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>',
  lock: '<rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
  search: '<circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>',
  chat: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
  layers: '<polygon points="12 2 2 7 12 12 22 7 12 2"/><polyline points="2 17 12 22 22 17"/><polyline points="2 12 12 17 22 12"/>',
  check: '<polyline points="20 6 9 17 4 12"/>',
  checkCircle: '<path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/>',
  xCircle: '<circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/>',
  alert: '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>',
  info: '<circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/>',
  plus: '<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>',
  trash: '<polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>',
  edit: '<path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>',
  copy: '<rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>',
  server: '<rect x="2" y="2" width="20" height="8" rx="2" ry="2"/><rect x="2" y="14" width="20" height="8" rx="2" ry="2"/><line x1="6" y1="6" x2="6.01" y2="6"/><line x1="6" y1="18" x2="6.01" y2="18"/>',
  box: '<path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/>',
  arrowUp: '<line x1="12" y1="19" x2="12" y2="5"/><polyline points="5 12 12 5 19 12"/>',
  arrowDown: '<line x1="12" y1="5" x2="12" y2="19"/><polyline points="19 12 12 19 5 12"/>'
};

function icon(name, size=14, cls='') {
  const p = ICONS[name] || '';
  return `<svg class="khc-icon ${cls}" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${p}</svg>`;
}

function esc(s) {
  if (s === null || s === undefined) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ---- Provider Presets Database & Dynamic Remote Catalog ------------------
let PRESET_CATALOG = [];
let CACHED_PRESETS = {};
let RULE_UPDATES_MAP = {};
let currentSelectedPreset = null;

const FALLBACK_PRESETS = {
  minimax: {
    id: 'minimax',
    name: 'MiniMax',
    version: '1.1.0',
    base_url: 'https://api.minimaxi.com/v1',
    anthropic_base_url: 'https://api.minimax.cn/anthropic',
    protocols: ['chat', 'messages'],
    description: 'MiniMax 官方国内订阅平台，支持 MiniMax-M3 系列，原生兼容 OpenAI Completions 与 Anthropic Messages 双协议直通',
    recommended_models: [
      { name: 'MiniMax-M3', upstream: 'MiniMax-M3', desc: 'MiniMax-M3 旗舰多模态通用模型 (支持超长思考，兼容 Messages)', checked: true },
    ]
  },
  bai: {
    id: 'bai',
    name: 'B.AI',
    version: '1.1.0',
    base_url: 'https://api.b.ai/v1',
    anthropic_base_url: 'https://api.b.ai/v1',
    protocols: ['chat', 'messages'],
    description: 'B.AI 统一大模型中转平台，原生兼容 OpenAI Chat Completions 与 Anthropic Messages 协议双通道',
    recommended_models: [
      { name: 'deepseek-v4-flash-vision-exp', upstream: 'deepseek-v4-flash-vision-exp', desc: 'DeepSeek V4 Flash 视觉/推理增强模型', checked: true },
      { name: 'qwen3.8-flash', upstream: 'qwen3.8-flash', desc: '通义千问 3.8 Flash 高速推理模型', checked: true },
      { name: 'claude-3-5-sonnet', upstream: 'claude-3-5-sonnet', desc: 'Claude 3.5 Sonnet 编程模型', checked: false },
      { name: 'deepseek-v3', upstream: 'deepseek-v3', desc: 'DeepSeek V3 全能大模型', checked: false },
    ]
  },
  agnes: {
    id: 'agnes',
    name: 'Agnes AI',
    version: '1.2.0',
    base_url: 'https://apihub.agnes-ai.com/v1',
    protocols: ['chat'],
    description: 'Agnes AI 平台，支持 agnes-3.0-flash 等高并发轻量 Agent 模型 (512K 上下文)',
    recommended_models: [
      { name: 'agnes-3.0-flash', upstream: 'agnes-3.0-flash', desc: 'Agnes 3.0 Flash 全新一代旗舰开源推理模型 (512K 上下文)', checked: true },
      { name: 'agnes-2.5-flash', upstream: 'agnes-2.5-flash', desc: 'Agnes 2.5 Flash 旗舰高速模型 (512K 上下文)', checked: false },
      { name: 'agnes-2.0-flash', upstream: 'agnes-2.0-flash', desc: 'Agnes 2.0 Flash 兼容回退模型', checked: false },
    ]
  },
  google: {
    id: 'google',
    name: 'Google AI Studio',
    version: '1.1.0',
    base_url: 'https://generativelanguage.googleapis.com/v1beta/openai',
    protocols: ['chat'],
    description: 'Google 官方 Gemini 系列大模型，支持 Gemini 2.5 / 3 / 3.5+，已内置 Thinking Config 思考等级映射',
    recommended_models: [
      { name: 'gemini-3.5-flash', upstream: 'gemini-3.5-flash', desc: '最新高性价比推理模型 (支持 low/medium/high 思考等级)', checked: true },
      { name: 'gemini-3.5-pro', upstream: 'gemini-3.5-pro', desc: '最新旗舰强推理模型 (支持 low/high 思考等级)', checked: true },
      { name: 'gemini-2.5-flash', upstream: 'gemini-2.5-flash', desc: '经典多模态快速模型', checked: false },
      { name: 'gemini-2.5-pro', upstream: 'gemini-2.5-pro', desc: '经典多模态深度思考模型', checked: false },
    ]
  },
  sensenova: {
    id: 'sensenova',
    name: 'SenseNova',
    version: '1.1.0',
    base_url: 'https://token.sensenova.cn/v1',
    protocols: ['chat'],
    description: '商汤 SenseNova 开放平台，支持 GLM-5.2、DeepSeek-V3/R1 等，原生支持 reasoning_effort 思考控制',
    recommended_models: [
      { name: 'glm-5.2', upstream: 'GLM-5.2', desc: '智谱/商汤最新 GLM-5.2 旗舰推理大模型', checked: true },
      { name: 'deepseek-v3', upstream: 'DeepSeek-V3', desc: 'DeepSeek-V3 基础推理模型', checked: false },
      { name: 'deepseek-r1', upstream: 'DeepSeek-R1', desc: 'DeepSeek-R1 深度思考推理模型', checked: false },
    ]
  },
  stepfun: {
    id: 'stepfun',
    name: 'StepFun',
    version: '1.1.0',
    base_url: 'https://api.stepfun.com/v1',
    protocols: ['chat'],
    description: '阶跃星辰 StepFun 大模型平台，已自动适配 reasoning_effort none->low 降级与 deepseek 思考格式注入',
    recommended_models: [
      { name: 'step-3.7-flash', upstream: 'step-3.7-flash', desc: '阶跃最新闪电高速推理大模型', checked: true },
      { name: 'step-2-16k', upstream: 'step-2-16k', desc: '阶跃 Step-2 旗舰大模型', checked: false },
    ]
  },
  siliconflow: {
    id: 'siliconflow',
    name: 'SiliconFlow',
    version: '1.1.0',
    base_url: 'https://api.siliconflow.cn/v1',
    protocols: ['chat'],
    description: '硅基流动 SiliconFlow 高并发推理平台，包含 DeepSeek、Qwen 等开源模型',
    recommended_models: [
      { name: 'deepseek-ai/DeepSeek-V3', upstream: 'deepseek-ai/DeepSeek-V3', desc: 'DeepSeek-V3 全尺寸旗舰模型', checked: true },
      { name: 'deepseek-ai/DeepSeek-R1', upstream: 'deepseek-ai/DeepSeek-R1', desc: 'DeepSeek-R1 全尺寸深度思考模型', checked: false },
      { name: 'Qwen/Qwen2.5-72B-Instruct', upstream: 'Qwen/Qwen2.5-72B-Instruct', desc: '通义千问 72B Instruct 指令模型', checked: false },
    ]
  },
  tokenrhythm: {
    id: 'tokenrhythm',
    name: 'TokenRhythm',
    version: '1.1.0',
    base_url: 'https://api.tokenrhythm.com/v1',
    protocols: ['chat'],
    description: 'TokenRhythm 聚合大模型路由网关，已自动适配 tool_choice 格式转换',
    recommended_models: [
      { name: 'claude-3-5-sonnet-20241022', upstream: 'claude-3-5-sonnet-20241022', desc: 'Claude 3.5 Sonnet 强编程模型', checked: true },
      { name: 'gpt-4o', upstream: 'gpt-4o', desc: 'OpenAI GPT-4o 旗舰全能模型', checked: false },
    ]
  },
  amd: {
    id: 'amd',
    name: 'AMD Radeon Cloud',
    version: '1.1.0',
    base_url: 'https://developer.amd.com.cn/radeon/api/v1',
    anthropic_base_url: 'https://developer.amd.com.cn/radeon/api/v1',
    protocols: ['chat', 'messages'],
    description: 'AMD 官方开发者平台，基于高性能推理集群。网关已全自动适配 reasoning_effort 深度思考、Anthropic output_config 与 system 消息置顶。',
    recommended_models: [
      { name: 'deepseek-v4-flash', upstream: 'DeepSeek-V4-Flash', desc: 'DeepSeek V4 Flash 原生百万上下文大模型 (自动注入 reasoning_effort 开启深度思考)', checked: true },
      { name: 'qwen3.8-flash-next', upstream: 'Qwen3.8-Flash-Next', desc: '千问全新 QSA 稀疏注意力大模型 (26.2万上下文，自动适配 system 消息置顶与安全思考级别)', checked: true }
    ]
  }
};

const PRESET_DEFINITIONS = new Proxy({}, {
  get: (target, prop) => CACHED_PRESETS[prop] || FALLBACK_PRESETS[prop]
});

function getKey() {
  return localStorage.getItem(TOKEN_KEY) || '';
}

function setKey(k) {
  localStorage.setItem(TOKEN_KEY, k);
}

function clearKey() {
  localStorage.removeItem(TOKEN_KEY);
}

function toast(msg, type = 'ok') {
  const container = document.getElementById('toastContainer');
  if (!container) return;
  const el = document.createElement('div');
  const tType = type || 'ok';
  el.className = `toast ${tType}`;
  const icName = (tType === 'ok' || tType === 'success') ? 'checkCircle' : ((tType === 'err' || tType === 'danger') ? 'xCircle' : 'info');
  el.innerHTML = `<span style="display:inline-flex;align-items:center;gap:6px;">${icon(icName, 15)}<span>${esc(msg)}</span></span>`;
  container.appendChild(el);
  setTimeout(() => el.classList.add('show'), 10);
  setTimeout(() => {
    el.classList.remove('show');
    setTimeout(() => el.remove(), 300);
  }, 3000);
}

function copySnippet(elementId) {
  const el = document.getElementById(elementId);
  if (!el) return;
  const text = el.textContent || '';
  navigator.clipboard.writeText(text).then(() => {
    toast('已复制到剪贴板', 'ok');
  }).catch(() => {
    prompt('请手动复制:', text);
  });
}

// ---- API wrapper ---------------------------------------------------------
async function api(method, path, body = null) {
  const token = getKey();
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const res = await fetch(path, {
    method,
    headers,
    body: body ? JSON.stringify(body) : null,
  });

  const text = await res.text();
  let data = null;
  try {
    data = JSON.parse(text);
  } catch {
    data = { raw: text };
  }

  if (res.status === 401) {
    clearKey();
    showLoginOverlay('凭证无效或已过期，请重新登录');
    throw new Error('未授权 (401)');
  }
  if (!res.ok) {
    throw new Error(data?.error?.message || data?.error || `HTTP ${res.status}`);
  }
  return data;
}

// ---- Navigation / Tabs ---------------------------------------------------
function switchTab(tabId) {
  activeTab = tabId;
  document.querySelectorAll('#topNav button').forEach(b => b.classList.remove('active'));
  const btn = Array.from(document.querySelectorAll('#topNav button')).find(b => b.getAttribute('onclick')?.includes(tabId));
  if (btn) btn.classList.add('active');

  document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
  const panel = document.getElementById(`panel-${tabId}`);
  if (panel) panel.classList.add('active');

  if (tabId === 'raw') renderRawJson();
  if (tabId === 'access') renderAccess();
}

// ---- Login Flow ----------------------------------------------------------
function showLoginOverlay(errText = '') {
  document.getElementById('loginOverlay').style.display = 'flex';
  document.getElementById('app').style.display = 'none';
  const err = document.getElementById('loginErr');
  if (errText) {
    err.textContent = errText;
    err.style.display = 'block';
  } else {
    err.style.display = 'none';
  }
}

function hideLoginOverlay() {
  document.getElementById('loginOverlay').style.display = 'none';
  document.getElementById('app').style.display = 'flex';
}

async function doLogin() {
  const input = document.getElementById('loginKey').value.trim();
  if (!input && !getKey()) {
    showLoginOverlay('请输入 PROXY_API_KEY');
    return;
  }
  if (input) setKey(input);

  try {
    await loadAllData();
    hideLoginOverlay();
    toast('登录成功', 'ok');
  } catch (e) {
    showLoginOverlay('验证失败: ' + (e?.message || e));
  }
}

function doLogout() {
  clearKey();
  showLoginOverlay();
}

// ---- Data Fetching -------------------------------------------------------
async function loadAllData() {
  try {
    const [cfgRes, healthRes] = await Promise.all([
      api('GET', '/api/config'),
      api('GET', '/health').catch(() => ({})),
    ]);

    cfg = cfgRes.config || cfgRes;
    cfgMeta = {
      source: cfgRes.source || 'EdgeOne KV',
      lastModified: cfgRes.last_modified,
    };
    healthData = healthRes;

    renderAll();
  } catch (e) {
    console.error('Failed to load data', e);
    throw e;
  }
}

// ---- Rendering -----------------------------------------------------------
function renderAll() {
  renderDashboard();
  renderAgentModels();
  renderProviders();
  renderSettings();
  renderRawJson();
  renderAccess();
}

function renderSettings() {
  const s = cfg.settings || {};
  const elStrat = document.getElementById('set_routing_strategy');
  if (elStrat) elStrat.value = s.agent_routing_strategy || cfg.agent_routing_strategy || 'sticky_failover';

  const elBudget = document.getElementById('set_request_total_budget_sec');
  if (elBudget) elBudget.value = s.request_total_budget_sec || 25;

  const elUpstream = document.getElementById('set_upstream_timeout_sec');
  if (elUpstream) elUpstream.value = s.upstream_timeout_sec || 15;

  const elRetries = document.getElementById('set_schedule_total_budget');
  if (elRetries) elRetries.value = s.schedule_total_budget || 3;

  const elProvMax = document.getElementById('set_max_attempts_per_provider');
  if (elProvMax) elProvMax.value = s.max_attempts_per_provider || 2;

  const elFastFail = document.getElementById('set_fast_failover_provider_down');
  if (elFastFail) elFastFail.checked = s.fast_failover_provider_down !== false;

  const elCd429 = document.getElementById('set_cooldown_429_sec');
  if (elCd429) elCd429.value = s.cooldown_429_sec || 60;

  const elCd5xx = document.getElementById('set_cooldown_5xx_sec');
  if (elCd5xx) elCd5xx.value = s.cooldown_5xx_sec || 30;

  const elCircuit = document.getElementById('set_circuit_break_threshold');
  if (elCircuit) elCircuit.value = s.circuit_break_threshold || 3;

  const elCd403 = document.getElementById('set_cooldown_403_sec');
  if (elCd403) elCd403.value = s.cooldown_403_sec || 600;
}

async function saveSettings() {
  cfg.settings = {
    agent_routing_strategy: document.getElementById('set_routing_strategy').value,
    request_total_budget_sec: Number(document.getElementById('set_request_total_budget_sec').value) || 25,
    upstream_timeout_sec: Number(document.getElementById('set_upstream_timeout_sec').value) || 15,
    schedule_total_budget: Number(document.getElementById('set_schedule_total_budget').value) || 3,
    max_attempts_per_provider: Number(document.getElementById('set_max_attempts_per_provider').value) || 2,
    fast_failover_provider_down: document.getElementById('set_fast_failover_provider_down').checked,
    cooldown_429_sec: Number(document.getElementById('set_cooldown_429_sec').value) || 60,
    cooldown_5xx_sec: Number(document.getElementById('set_cooldown_5xx_sec').value) || 30,
    circuit_break_threshold: Number(document.getElementById('set_circuit_break_threshold').value) || 3,
    cooldown_403_sec: Number(document.getElementById('set_cooldown_403_sec').value) || 600,
  };
  const ok = await persistConfig();
  if (ok) {
    toast('全局策略设置已保存生效', 'ok');
  }
}

function resetSettingsToDefault() {
  document.getElementById('set_routing_strategy').value = 'sticky_failover';
  document.getElementById('set_request_total_budget_sec').value = 25;
  document.getElementById('set_upstream_timeout_sec').value = 15;
  document.getElementById('set_schedule_total_budget').value = 3;
  document.getElementById('set_max_attempts_per_provider').value = 2;
  document.getElementById('set_fast_failover_provider_down').checked = true;
  document.getElementById('set_cooldown_429_sec').value = 60;
  document.getElementById('set_cooldown_5xx_sec').value = 30;
  document.getElementById('set_circuit_break_threshold').value = 3;
  document.getElementById('set_cooldown_403_sec').value = 600;
  toast('已填入推荐默认值，请点击保存生效', 'ok');
}

function renderDashboard() {
  const models = Object.keys(cfg.agent_models || {});
  const providers = cfg.providers || {};
  const provNames = Object.keys(providers);
  let totalKeys = 0;
  for (const p of Object.values(providers)) {
    totalKeys += Object.keys(p.keys || {}).length;
  }

  const elProvCount = document.getElementById('statProviderCount');
  if (elProvCount) elProvCount.textContent = provNames.length;

  const elModelCount = document.getElementById('statModelCount');
  if (elModelCount) elModelCount.textContent = models.length;

  const elKeySub = document.getElementById('statKeySub');
  if (elKeySub) elKeySub.textContent = `多 Key 轮询池 (${totalKeys} 个 Key)`;

  const elVer = document.getElementById('statVersion');
  if (elVer) elVer.textContent = BUILD_VERSION;
  const elHeadVer = document.getElementById('topVersionBadge') || document.getElementById('headerVersionBadge');
  if (elHeadVer) elHeadVer.textContent = BUILD_VERSION;

  const badge = document.getElementById('configSourceBadge');
  if (badge) {
    const src = cfgMeta.source || 'KV';
    badge.className = 'badge badge-success';
    badge.textContent = `${src} 已同步`;
    if (cfgMeta.lastModified) {
      badge.title = `最后同步时间: ${new Date(cfgMeta.lastModified).toLocaleString()}`;
    }
  }

  // Compact Gateway Access Strip
  renderDashboardGateway();
}

function renderDashboardGateway() {
  const base = window.location.origin + '/v1';
  const urlEl = document.getElementById('dbBaseUrl');
  if (urlEl) urlEl.textContent = base;

  const clientKey = getKey() || 'YOUR_PROXY_API_KEY';
  const keyEl = document.getElementById('gwClientKeyVal');
  if (keyEl) keyEl.textContent = clientKey || '<PROXY_API_KEY>';

  const listContainer = document.getElementById('listAvailableModels');
  if (!listContainer) return;

  const agentModels = cfg.agent_models || {};
  const modelNames = Object.keys(agentModels);

  if (!modelNames.length) {
    listContainer.innerHTML = '<span class="text-secondary" style="font-size:12px;">(暂无可用模型，请在「Agent 模型」中配置)</span>';
    return;
  }

  listContainer.innerHTML = modelNames.map(m => {
    const protos = getModelProtocols(m);
    const protoBadges = renderProtocolBadges(protos, true);
    return `
      <span class="badge badge-neutral model-chip-clickable mono" onclick="copyModelName('${esc(m)}')" title="点击复制模型名称: ${esc(m)}" style="display:inline-flex;align-items:center;gap:6px;padding:3px 8px;font-size:12px;cursor:pointer;background:var(--color-bg-page);border:1px solid var(--color-border);">
        <span style="font-weight:500;color:var(--color-text-1);">${esc(m)}</span>
        <span style="display:inline-flex;gap:3px;align-items:center;">${protoBadges}</span>
      </span>
    `;
  }).join('');
}

function copyDbBaseUrl() {
  const base = window.location.origin + '/v1';
  copyText(base, '网关 Base URL 已复制到剪贴板');
}

function copyDbClientKey() {
  const key = getKey() || 'YOUR_PROXY_API_KEY';
  copyText(key, '客户端 API Key 已复制到剪贴板');
}

function copyModelName(name) {
  copyText(name, `已复制模型名称: ${name}`);
}

function copyAllAvailableModels() {
  const models = Object.keys(cfg.agent_models || {});
  if (!models.length) {
    toast('当前暂无可用模型', 'err');
    return;
  }
  copyText(models.join(', '), '已复制全部模型名称');
}

function copyText(text, successMsg) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(() => toast(successMsg, 'ok')).catch(() => {
      prompt('请手动复制:', text);
    });
  } else {
    prompt('请手动复制:', text);
  }
}

// Protocol Metadata & Helpers (Factual Badges)
const PROTOCOLS = {
  openai: { label: 'OpenAI', short: 'openai', badgeClass: 'badge-success', title: '支持 OpenAI Chat 协议 (/v1/chat/completions)' },
  message: { label: 'Message', short: 'message', badgeClass: 'badge-warning', title: '支持 Anthropic Messages 协议 (/v1/messages)' },
  responses: { label: 'Responses', short: 'responses', badgeClass: 'badge-purple', title: '支持 OpenAI Responses 协议 (/v1/responses)' }
};

function normalizeProto(pr) {
  if (pr === 'chat') return 'openai';
  if (pr === 'messages' || pr === 'anthropic') return 'message';
  return pr;
}

function getProviderProtocols(name, provObj){
  const p = provObj || (cfg && cfg.providers && cfg.providers[name]) || {};
  let rawProtos = [];
  if (Array.isArray(p.protocols) && p.protocols.length > 0) {
    rawProtos = p.protocols;
  } else {
    rawProtos = ['openai'];
    const lower = (name || '').toLowerCase();
    const clean = lower.replace(/[^a-z0-9]/g, '');
    const preset = PRESET_DEFINITIONS[clean] || PRESET_DEFINITIONS[lower];
    if (p.anthropic_messages || p.anthropic_base_url || p.message_base_url || (preset && preset.anthropic_base_url)) {
      rawProtos.push('message');
    }
    if (p.openai_responses || p.supports_responses || p.responses_base_url) {
      rawProtos.push('responses');
    }
  }
  const set = new Set();
  rawProtos.forEach(pr => set.add(normalizeProto(pr)));
  return Array.from(set);
}

function getModelProtocols(modelName){
  const m = cfg && cfg.agent_models ? cfg.agent_models[modelName] : null;
  if (!m || !m.keys || !m.keys.length) return ['openai'];
  const set = new Set();
  for (const b of m.keys) {
    const provProtos = getProviderProtocols(b.provider);
    provProtos.forEach(pr => set.add(normalizeProto(pr)));
  }
  return set.size ? Array.from(set) : ['openai'];
}

function renderProtocolBadges(protoList, isShort=true){
  return (protoList || ['openai']).map(pr => {
    const norm = normalizeProto(pr);
    const meta = PROTOCOLS[norm] || { label: norm, short: norm, badgeClass: 'badge-neutral', title: norm };
    return `<span class="badge ${meta.badgeClass}" title="${esc(meta.title)}" style="font-weight:600;font-size:11px;padding:2px 7px;">${esc(isShort ? meta.short : meta.label)}</span>`;
  }).join(' ');
}

// Note: renderAgentModels() and binding table lifecycle are provided by shared/admin/js/agent-models-ui.js


function renderProviders() {
  const box = document.getElementById('providersBox');
  const rail = document.getElementById('alphabetNavRail');
  const railInner = document.getElementById('alphaRailInner');
  if (!box) return;
  box.innerHTML = '';
  const providers = cfg.providers || {};
  const provNames = Object.keys(providers).sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));

  if (provNames.length === 0) {
    box.innerHTML = '<div class="card card-pad empty">暂未配置供应商</div>';
    if (rail) rail.style.display = 'none';
    return;
  }

  // 1. 按首字母构建分组
  const groups = {};
  provNames.forEach(p => {
    const initial = (p.charAt(0) || '#').toUpperCase();
    const char = /^[A-Z]$/.test(initial) ? initial : '#';
    if (!groups[char]) groups[char] = [];
    groups[char].push(p);
  });

  const sortedChars = Object.keys(groups).sort((a, b) => {
    if (a === '#') return 1;
    if (b === '#') return -1;
    return a.localeCompare(b);
  });

  // 2. 渲染右侧字母索引导航轨 (Alphabet Rail)
  if (rail && railInner) {
    if (sortedChars.length <= 1) {
      rail.style.display = 'none';
    } else {
      rail.style.display = 'block';
      railInner.innerHTML = sortedChars.map(ch => `
        <button type="button" class="alpha-rail-btn" onclick="scrollToAlphaGroup('${ch}')" title="跳转到 ${ch} 组 (${groups[ch].length} 家供应商)">${ch}</button>
      `).join('');
    }
  }

  // 3. 渲染字母分组与供应商卡片
  for (const ch of sortedChars) {
    const list = groups[ch];
    const divider = document.createElement('div');
    divider.className = 'alpha-divider';
    divider.id = `alpha-group-${ch}`;
    divider.innerHTML = `
      <span class="alpha-char-badge">${ch}</span>
      <span class="alpha-divider-meta">${list.length} 家供应商</span>
      <span class="alpha-divider-line"></span>
    `;
    box.appendChild(divider);

    for (const p of list) {
      const prov = providers[p];
      const keysObj = prov.keys || {};
      const keyLabels = Object.keys(keysObj);
      const card = document.createElement('div');
      card.className = 'card';
      card.id = `provider-card-${p}`;

      let keysListHtml = '';
      if (keyLabels.length > 0) {
        const chips = keyLabels.map(k => {
          const val = keysObj[k];
          const masked = val ? `${val.slice(0, 6)}...${val.slice(-4)}` : '';
          const cacheKey = `prov:${p}:${k}`;
          const latInfo = modelLatencyCache[cacheKey];
          let latBadge = '';
          if (latInfo) {
            latBadge = latInfo.ok
              ? `<span class="badge badge-success" style="font-size:10px;padding:1px 5px;">${latInfo.latency_ms}ms</span>`
              : `<span class="badge badge-error" style="font-size:10px;padding:1px 5px;">${latInfo.status || 'ERR'}</span>`;
          }

          return `
            <div class="key-chip">
              <div style="display:flex;align-items:center;gap:8px;min-width:0;overflow:hidden;">
                <span style="font-weight:600;white-space:nowrap;color:var(--color-text-1);">${esc(k)}</span>
                <span class="mono text-secondary" style="font-size:11px;white-space:nowrap;">${esc(masked)}</span>
                <span class="key-lat-slot" style="display:inline-flex;align-items:center;">${latBadge}</span>
              </div>
              <div class="key-chip-actions">
                <button class="btn btn-secondary btn-xs" onclick="testSingleKey('${esc(p)}', '${esc(k)}')" title="测试连通性">${icon('zap', 11)} 测试</button>
                <button class="btn btn-secondary btn-xs" onclick="openEditKeyModal('${esc(p)}', '${esc(k)}', '${esc(val)}')" title="编辑 Key">${icon('edit', 11)} 编辑</button>
                <button class="btn btn-secondary-danger btn-xs" onclick="deleteKey('${esc(p)}', '${esc(k)}')" title="删除 Key">${icon('trash', 11)} 删除</button>
              </div>
            </div>
          `;
        }).join('');
        keysListHtml = `<div class="key-chip-list">${chips}</div>`;
      } else {
        keysListHtml = `<div style="padding:10px 16px;font-size:12px;color:var(--color-text-3);">暂未绑定 Key，点击右上角「新增 Key」添加凭据</div>`;
      }

      const protos = getProviderProtocols(p, prov);
      const protoBadges = renderProtocolBadges(protos, false);
      const hasMessages = protos.includes('message');
      let messagesUrlPart = '';
      if (hasMessages) {
        const msgUrl = prov.message_base_url || prov.anthropic_base_url;
        if (msgUrl && msgUrl !== prov.base_url) {
          messagesUrlPart = ` · Messages: ${esc(msgUrl)}`;
        } else {
          messagesUrlPart = ` · Messages: ${esc(msgUrl || prov.base_url || '')} (默认)`;
        }
      }
      const ver = prov.preset_version ? `规则 v${prov.preset_version}` : (prov.adapter_rules ? '自定义规则' : '默认');
      const verBadge = `<span class="badge badge-neutral" style="font-size:11px;padding:2px 7px;" title="规则版本">${ver}</span>`;
      card.innerHTML = `
        <div class="card-head">
          <div>
            <h3>${esc(p)} <span style="display:inline-flex;gap:4px;vertical-align:middle;margin-left:4px;">${protoBadges} ${verBadge}</span></h3>
            <div class="meta mono mt-2">${esc(prov.base_url || '—')}${messagesUrlPart} · ${keyLabels.length} 个 Key</div>
          </div>
          <div style="display:flex;gap:8px;align-items:center;">
            <button class="btn btn-ghost btn-sm" onclick="openEditProviderModal('${esc(p)}')">${icon('edit')} 编辑</button>
            <button class="btn btn-primary btn-sm" onclick="openAddKeyModal('${esc(p)}')">${icon('plus')} 新增 Key</button>
            <button class="btn btn-secondary-danger btn-sm" onclick="deleteProvider('${esc(p)}')">${icon('trash')} 删除供应商</button>
          </div>
        </div>
        <div style="background:var(--color-bg-page);">${keysListHtml}</div>
      `;
      box.appendChild(card);
    }
  }
}

function scrollToAlphaGroup(ch) {
  const target = document.getElementById(`alpha-group-${ch}`);
  if (target) {
    target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    target.classList.remove('alpha-target-highlight');
    void target.offsetWidth;
    target.classList.add('alpha-target-highlight');
  }
}

function renderRawJson() {
  const ta = document.getElementById('rawJsonText');
  if (ta) ta.value = JSON.stringify(cfg, null, 2);
}

function renderAccess() {
  const origin = window.location.origin;
  const base = `${origin}/v1`;
  const models = Object.keys(cfg.agent_models || {});
  const messagesModels = models.filter(m => getModelProtocols(m).includes('messages'));
  const demoMessages = messagesModels[0] || models[0] || 'qwen3.8-flash';
  const proxyKey = getKey() || 'YOUR_PROXY_API_KEY';

  const setT = (id, txt) => { const el = document.getElementById(id); if (el) el.textContent = txt; };
  setT('accBaseUrl', base);
  setT('accModelsList', models.join(', ') || '—');

  const protoContainer = document.getElementById('accProtocols');
  if (protoContainer) {
    const activeProtos = new Set(['chat']);
    if (messagesModels.length || Object.entries(cfg.providers || {}).some(([n, p]) => getProviderProtocols(n, p).includes('messages'))) {
      activeProtos.add('messages');
    }
    if (Object.entries(cfg.providers || {}).some(([n, p]) => getProviderProtocols(n, p).includes('responses'))) {
      activeProtos.add('responses');
    }
    protoContainer.innerHTML = renderProtocolBadges(Array.from(activeProtos), false);
  }

  // 1. OpenAI Chat
  const pySample = `from openai import OpenAI

client = OpenAI(
    api_key="${proxyKey}",
    base_url="${base}"
)

response = client.chat.completions.create(
    model="${models[0] || 'qwen3.8-flash'}",
    messages=[{"role": "user", "content": "你好，请介绍你自己。"}],
    stream=True
)

for chunk in response:
    content = chunk.choices[0].delta.content or ""
    print(content, end="", flush=True)
`;
  setT('accPy', pySample);

  // 2. Anthropic Messages
  const messagesPySample = `import anthropic

client = anthropic.Anthropic(
    api_key="${proxyKey}",
    base_url="${base}"  # 直连本网关
)

# 使用支持 Messages 协议的模型（当前支持：${messagesModels.join(', ') || demoMessages}）
response = client.messages.create(
    model="${demoMessages}",
    max_tokens=1024,
    messages=[{"role": "user", "content": "你好，请介绍你自己。"}]
)

print(response.content[0].text)
`;
  setT('accMessagesPy', messagesPySample);

  const curlSample = `curl -X POST ${base}/chat/completions \\
  -H "Authorization: Bearer ${proxyKey}" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "${models[0] || 'qwen3.8-flash'}",
    "messages": [{"role": "user", "content": "1+1="}],
    "stream": true
  }'`;
  setT('accCurl', curlSample);
}

// ---- Key & Model Test ---------------------------------------------------
async function testModelKey(modelName, provider, key) {
  const item = cfg.agent_models?.[modelName];
  const upstreamModel = item?.upstream_model || modelName;
  toast(`探活模型 ${modelName} (${provider}/${key})...`, 'ok');
  try {
    const res = await api('GET', `/api/config?action=test&provider=${encodeURIComponent(provider)}&key=${encodeURIComponent(key)}&model=${encodeURIComponent(upstreamModel)}`);
    modelLatencyCache[`model:${modelName}:${provider}:${key}`] = res;
    renderAgentModels();
    if (res.ok) {
      toast(`${modelName} [${provider}/${key}] 成功 (${res.latency_ms}ms)`, 'ok');
    } else {
      toast(`${modelName} [${provider}/${key}] 异常 (HTTP ${res.status || 'ERR'} - ${res.verdict || res.error || ''})`, 'err');
    }
  } catch (e) {
    toast(`探活异常: ${e?.message || e}`, 'err');
  }
}

async function testSingleKey(provider, key) {
  toast(`测试供应商 ${provider}/${key}...`, 'ok');
  try {
    const res = await api('GET', `/api/config?action=test&provider=${encodeURIComponent(provider)}&key=${encodeURIComponent(key)}`);
    modelLatencyCache[`prov:${provider}:${key}`] = res;
    renderProviders();
    if (res.ok) {
      toast(`${provider}/${key} 连接成功 (${res.latency_ms}ms)`, 'ok');
    } else {
      toast(`${provider}/${key} 探活异常 (HTTP ${res.status || 'ERR'})`, 'err');
    }
  } catch (e) {
    toast(`探活异常: ${e?.message || e}`, 'err');
  }
}

// ---- Modals & Actions ----------------------------------------------------
function openModal(id) {
  document.getElementById(id).classList.add('show');
}
function closeModal(id) {
  document.getElementById(id).classList.remove('show');
}

// ---- Custom Provider & Protocol Settings ---------------------------------
function onEdgeOneCustomUrlToggleChange() {
  const isChecked = document.getElementById('m_prov_custom_url_toggle')?.checked;
  const wrap = document.getElementById('m_prov_custom_url_section');
  if (wrap) wrap.style.display = isChecked ? 'block' : 'none';
}

function openAddProviderModal() {
  currentSelectedPreset = null;
  document.getElementById('providerModalTitle').textContent = '新增供应商';
  document.getElementById('m_prov_name').value = '';
  document.getElementById('m_prov_name').disabled = false;
  document.getElementById('m_prov_url_openai').value = '';
  document.getElementById('m_prov_url_message').value = '';
  document.getElementById('m_prov_url_responses').value = '';
  openModal('providerModal');
}

function openEditProviderModal(name) {
  currentSelectedPreset = null;
  const prov = cfg.providers?.[name] || {};
  document.getElementById('providerModalTitle').textContent = '编辑供应商 - ' + name;
  document.getElementById('m_prov_name').value = name;
  document.getElementById('m_prov_name').disabled = true;
  document.getElementById('m_prov_url_openai').value = prov.openai_base_url || prov.base_url || '';
  document.getElementById('m_prov_url_message').value = prov.message_base_url || prov.anthropic_base_url || '';
  document.getElementById('m_prov_url_responses').value = prov.responses_base_url || '';
  openModal('providerModal');
}

async function saveProviderModal() {
  const name = document.getElementById('m_prov_name').value.trim();
  const openaiUrl = document.getElementById('m_prov_url_openai').value.trim();
  const messageUrl = document.getElementById('m_prov_url_message').value.trim();
  const responsesUrl = document.getElementById('m_prov_url_responses').value.trim();

  if (!name) { toast('请填写供应商英文标识 (ID)', 'err'); return; }
  if (!openaiUrl && !messageUrl && !responsesUrl) {
    toast('请至少填写一个协议的 Base URL (有输入即启用)', 'err');
    return;
  }

  const selectedProtos = [];
  if (openaiUrl) selectedProtos.push('openai');
  if (messageUrl) selectedProtos.push('message');
  if (responsesUrl) selectedProtos.push('responses');

  const backupCfg = JSON.parse(JSON.stringify(cfg));

  cfg.providers = cfg.providers || {};
  cfg.providers[name] = cfg.providers[name] || { keys: {} };
  cfg.providers[name].protocols = selectedProtos;

  if (openaiUrl) {
    cfg.providers[name].base_url = openaiUrl;
    cfg.providers[name].openai_base_url = openaiUrl;
  } else {
    delete cfg.providers[name].openai_base_url;
  }

  if (messageUrl) {
    cfg.providers[name].anthropic_base_url = messageUrl;
    cfg.providers[name].message_base_url = messageUrl;
    cfg.providers[name].anthropic_messages = true;
    if (!openaiUrl) cfg.providers[name].base_url = messageUrl;
  } else {
    delete cfg.providers[name].anthropic_base_url;
    delete cfg.providers[name].message_base_url;
    cfg.providers[name].anthropic_messages = false;
  }

  if (responsesUrl) {
    cfg.providers[name].responses_base_url = responsesUrl;
    cfg.providers[name].openai_responses = true;
    if (!openaiUrl && !messageUrl) cfg.providers[name].base_url = responsesUrl;
  } else {
    delete cfg.providers[name].responses_base_url;
    cfg.providers[name].openai_responses = false;
  }

  const ok = await persistConfig();
  if (ok) {
    closeModal('providerModal');
    toast(`供应商「${name}」已保存并同步至 EdgeOne KV`, 'ok');
  } else {
    cfg = backupCfg;
    renderAll();
  }
}

function deleteProvider(name) {
  const prov = cfg.providers?.[name];
  if (!prov) return;
  const keysObj = prov.keys || {};
  const keyLabels = Object.keys(keysObj);

  // 检索级联影响的 Agent 模型
  const affectedModels = [];
  for (const [mName, m] of Object.entries(cfg.agent_models || {})) {
    if ((m.keys || []).some(k => k.provider === name)) {
      affectedModels.push(mName);
    }
  }

  // 检索级联影响的 candidate 节点
  let affectedCandidates = 0;
  for (const cat of ['chat', 'embedding', 'reranker', 'ocr']) {
    const list = cfg.candidates?.[cat] || [];
    affectedCandidates += list.filter(c => c.provider === name).length;
  }

  const detailsEl = document.getElementById('deleteConfirmDetails');
  if (detailsEl) {
    detailsEl.innerHTML = `
      <div style="margin-bottom:8px;"><strong>目标供应商：</strong><span class="badge badge-error" style="font-size:12px;">${esc(name)}</span> (${esc(prov.base_url || '')})</div>
      <div style="margin-bottom:8px;"><strong>名下 API Key：</strong>${keyLabels.length} 个 ${keyLabels.length ? `(<code>${keyLabels.map(esc).join(', ')}</code>)` : '<span class="text-secondary">无</span>'}</div>
      <div style="margin-bottom:8px;"><strong>关联 Agent 模型：</strong>${affectedModels.length} 个 ${affectedModels.length ? `(<code>${affectedModels.map(esc).join(', ')}</code>)` : '<span class="text-secondary">无直接绑定</span>'}</div>
      <div><strong>关联 Candidate 节点：</strong>${affectedCandidates} 个 (将一并级联解绑清理)</div>
    `;
  }

  const confirmBtn = document.getElementById('btnExecuteDeleteProvider');
  if (confirmBtn) {
    confirmBtn.onclick = async () => {
      confirmBtn.disabled = true;
      confirmBtn.textContent = '正在物理彻底删除...';
      try {
        delete cfg.providers[name];

        // 级联清理 agent_models 绑定
        if (cfg.agent_models) {
          for (const mName of Object.keys(cfg.agent_models)) {
            cfg.agent_models[mName].keys = (cfg.agent_models[mName].keys || []).filter(x => x.provider !== name);
            if (!cfg.agent_models[mName].keys.length) {
              delete cfg.agent_models[mName];
            }
          }
        }

        // 级联清理 candidates
        if (cfg.candidates) {
          for (const cat of ['chat', 'embedding', 'reranker', 'ocr']) {
            if (cfg.candidates[cat]) {
              cfg.candidates[cat] = cfg.candidates[cat].filter(x => x.provider !== name);
            }
          }
        }

        const ok = await persistConfig();
        if (ok) {
          closeModal('deleteConfirmModal');
          toast(`供应商「${name}」已从 EdgeOne KV 彻底销毁！`, 'ok');
        }
      } finally {
        confirmBtn.disabled = false;
        confirmBtn.textContent = '确认彻底删除';
      }
    };
  }

  openModal('deleteConfirmModal');
}

function openAddKeyModal(prov) {
  document.getElementById('keyModalTitle').textContent = `为 ${prov} 新增 Key`;
  document.getElementById('m_key_prov').value = prov;
  document.getElementById('m_key_old_label').value = '';
  document.getElementById('m_key_label').value = '';
  document.getElementById('m_key_val').value = '';
  const skipCb = document.getElementById('m_key_skip'); if (skipCb) skipCb.checked = false;
  const diagBox = document.getElementById('m_key_diag_box'); if (diagBox) { diagBox.style.display = 'none'; diagBox.innerHTML = ''; }
  const hintEl = document.getElementById('m_key_proto_hint');
  if (hintEl) {
    const protos = getProviderProtocols(prov);
    hintEl.innerHTML = `<div style="display:flex;align-items:center;justify-content:space-between;"><span>所属供应商: <b>${esc(prov)}</b></span><span>需校验协议: ${renderProtocolBadges(protos)}</span></div>`;
  }
  openModal('keyModal');
}

function openEditKeyModal(prov, label, val) {
  document.getElementById('keyModalTitle').textContent = `编辑 ${prov} Key: ${label}`;
  document.getElementById('m_key_prov').value = prov;
  document.getElementById('m_key_old_label').value = label;
  document.getElementById('m_key_label').value = label;
  document.getElementById('m_key_val').value = val;
  const skipCb = document.getElementById('m_key_skip'); if (skipCb) skipCb.checked = true;
  const diagBox = document.getElementById('m_key_diag_box'); if (diagBox) { diagBox.style.display = 'none'; diagBox.innerHTML = ''; }
  const hintEl = document.getElementById('m_key_proto_hint');
  if (hintEl) {
    const protos = getProviderProtocols(prov);
    hintEl.innerHTML = `<div style="display:flex;align-items:center;justify-content:space-between;"><span>所属供应商: <b>${esc(prov)}</b></span><span>需校验协议: ${renderProtocolBadges(protos)}</span></div>`;
  }
  openModal('keyModal');
}

async function saveKeyModal() {
  const prov = document.getElementById('m_key_prov').value;
  const oldLabel = (document.getElementById('m_key_old_label').value || '').trim();
  const label = document.getElementById('m_key_label').value.trim();
  const val = document.getElementById('m_key_val').value.trim();
  const skip = document.getElementById('m_key_skip')?.checked;
  const diagBox = document.getElementById('m_key_diag_box');
  if (diagBox) { diagBox.style.display = 'none'; diagBox.innerHTML = ''; }

  if (!label || !val) { toast('请填写 Key 别名与密钥明文', 'err'); return; }

  cfg.providers[prov] = cfg.providers[prov] || { keys: {} };
  cfg.providers[prov].keys = cfg.providers[prov].keys || {};

  if (oldLabel && oldLabel !== label) {
    if (cfg.providers[prov].keys[label] !== undefined) {
      toast(`Key 别名「${label}」已存在，请换一个别名`, 'err');
      return;
    }
  }

  // If online verification not skipped, test protocols
  if (!skip) {
    const spinner = document.getElementById('m_key_spinner');
    if (spinner) spinner.style.display = 'block';
    const pObj = cfg.providers[prov] || {};
    const protos = getProviderProtocols(prov, pObj);

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 15000);
      const r = await fetch('/api/admin/verify-key', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${getKey()}` },
        body: JSON.stringify({
          base_url: pObj.base_url,
          anthropic_base_url: pObj.anthropic_base_url,
          api_key: val,
          provider: prov,
          protocols: protos
        }),
        signal: controller.signal
      });
      clearTimeout(timer);
      const resText = await r.text();
      let d;
      try {
        d = JSON.parse(resText);
      } catch (jsonErr) {
        throw new Error(r.status === 404 ? '服务器未开通 /api/admin/verify-key 接口' : `服务端返回非 JSON 数据 (HTTP ${r.status})`);
      }

      if (d.valid) {
        const latList = [];
        for (const pr of protos) {
          const res = (d.protocols && d.protocols[pr]);
          if (res && res.latency_ms) latList.push(`${PROTOCOLS[pr]?.short || pr} ${res.latency_ms}ms`);
        }
        toast(`Key 校验全部通过 (${latList.join(' / ') || '成功'})`, 'ok');
      } else {
        if (diagBox) {
          let html = `<div style="font-weight:700;margin-bottom:8px;color:var(--color-danger);display:flex;align-items:center;gap:6px;">${icon('alert', 15)} 协议连通性未完全通过 (已阻止保存)</div>`;
          html += '<div style="display:flex;flex-direction:column;gap:6px;font-size:12px;">';
          for (const pr of protos) {
            const res = (d.protocols && d.protocols[pr]) || { valid: false, error: '未测试' };
            const pName = PROTOCOLS[pr] ? PROTOCOLS[pr].label : pr;
            if (res.valid) {
              html += `<div style="display:flex;align-items:center;gap:6px;color:var(--color-success);">${icon('checkCircle', 14)} <b>${esc(pName)}</b>: 验证通过 (${res.latency_ms || 0}ms)</div>`;
            } else {
              html += `<div style="display:flex;align-items:flex-start;gap:6px;color:var(--color-danger);">${icon('xCircle', 14)} <div><b>${esc(pName)}</b>: 验证失败 (${esc(res.error || '请求未通')})</div></div>`;
            }
          }
          html += '</div>';
          html += '<div class="text-secondary mt-2" style="font-size:11px;border-top:1px solid var(--color-border);padding-top:6px;">提示：请核对并修改密钥；若确属受限网络，请勾选上方「跳过连通性在线校验」后重新点击保存。</div>';
          diagBox.innerHTML = html;
          diagBox.style.display = 'block';
        }
        toast('协议校验存在失败项，已阻止保存', 'err');
        return;
      }
    } catch (e) {
      if (diagBox) {
        diagBox.innerHTML = `<div style="color:var(--color-danger);font-size:12px;display:flex;align-items:flex-start;gap:6px;">${icon('xCircle', 15)} <div>验证请求失败: ${esc(e.message)}。<br>如网络受限，可勾选上方「跳过连通性在线校验」后强制保存。</div></div>`;
        diagBox.style.display = 'block';
      }
      toast('网络请求异常: ' + e.message, 'err');
      return;
    } finally {
      if (spinner) spinner.style.display = 'none';
    }
  }

  const backupCfg = JSON.parse(JSON.stringify(cfg));

  if (oldLabel && oldLabel !== label) {
    delete cfg.providers[prov].keys[oldLabel];
    if (cfg.agent_models) {
      Object.values(cfg.agent_models).forEach(m => {
        (m.keys || []).forEach(x => {
          if (x.provider === prov && x.key === oldLabel) x.key = label;
        });
      });
    }
  }

  cfg.providers[prov].keys[label] = val;
  const ok = await persistConfig();
  if (ok) {
    closeModal('keyModal');
  } else {
    cfg = backupCfg;
    renderAll();
  }
}

async function deleteKey(prov, label) {
  if (!confirm(`删除 Key「${label}」？`)) return;
  if (cfg.providers && cfg.providers[prov] && cfg.providers[prov].keys) {
    delete cfg.providers[prov].keys[label];
  }
  if (cfg.agent_models) {
    Object.values(cfg.agent_models).forEach(m => {
      m.keys = (m.keys || []).filter(x => !(x.provider === prov && x.key === label));
    });
  }
  await persistConfig();
}

let currentEditingModelKeys = [];

function populateModelProvFilter(selectedProv = '') {
  const select = document.getElementById('m_model_prov_filter');
  if (!select) return;
  select.innerHTML = '<option value="" disabled selected>-- 请选择所属供应商 --</option>';
  const providers = cfg.providers || {};
  for (const p of Object.keys(providers)) {
    const opt = document.createElement('option');
    opt.value = p;
    opt.textContent = p;
    if (selectedProv && p === selectedProv) {
      opt.selected = true;
    }
    select.appendChild(opt);
  }
}

function onModelProvFilterChange() {
  const filterProv = document.getElementById('m_model_prov_filter').value;
  renderBindingsCheckboxes(getSelectedBindingsFromDom(), filterProv);
}

function getSelectedBindingsFromDom() {
  const checkedBoxes = document.querySelectorAll('#m_bindings_container input[type="checkbox"]:checked');
  const list = Array.from(checkedBoxes).map(cb => ({
    provider: cb.dataset.provider,
    key: cb.dataset.key,
  }));
  if (list.length > 0) return list;
  return currentEditingModelKeys;
}

function toggleSelectAllKeys(selectAll) {
  const checkboxes = document.querySelectorAll('#m_bindings_container input[type="checkbox"]');
  checkboxes.forEach(cb => {
    cb.checked = selectAll;
  });
}

function toggleProviderKeys(prov, forceCheck = false) {
  const checkboxes = document.querySelectorAll(`#m_bindings_container input[data-provider="${prov}"]`);
  const allChecked = Array.from(checkboxes).every(cb => cb.checked);
  checkboxes.forEach(cb => {
    cb.checked = forceCheck ? true : !allChecked;
  });
}

// Agent Models modal, probe, and operations are delegated to shared/admin/js/agent-models-ui.js
function openEditModelModal(m) {
  if (typeof editAgentModel === 'function') editAgentModel(m);
}



// ---- Config Export & Import (JSON / Blob) --------------------------------
function exportConfigJson() {
  try {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const filename = `ocrproxy_edgeone_config_${timestamp}.json`;
    const jsonStr = JSON.stringify(cfg, null, 2);

    const blob = new Blob([jsonStr], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    toast(`配置已导出: ${filename}`, 'ok');
  } catch (e) {
    toast('导出失败: ' + (e?.message || e), 'err');
  }
}

function triggerImportConfig() {
  const fileInput = document.getElementById('configFileImportInput');
  if (fileInput) {
    fileInput.value = '';
    fileInput.click();
  }
}

function handleConfigFileImport(event) {
  const file = event.target.files?.[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = async (e) => {
    try {
      const content = e.target.result;
      const parsed = JSON.parse(content);

      if (!parsed || typeof parsed !== 'object') {
        throw new Error('导入文件不是有效的 JSON 对象');
      }

      if (!parsed.providers && !parsed.agent_models) {
        throw new Error('未检测到 providers 或 agent_models 配置节点');
      }

      const countProv = Object.keys(parsed.providers || {}).length;
      const countModels = Object.keys(parsed.agent_models || {}).length;

      if (!confirm(`导入配置包含 ${countProv} 个供应商与 ${countModels} 个模型，覆盖当前 KV 配置？`)) {
        return;
      }

      cfg = parsed;
      await persistConfig();
      toast('配置已导入', 'ok');
    } catch (err) {
      toast('导入失败: ' + err.message, 'err');
    }
  };
  reader.readAsText(file);
}

// ---- Raw JSON ------------------------------------------------------------
function formatRawJson() {
  const ta = document.getElementById('rawJsonText');
  try {
    const parsed = JSON.parse(ta.value);
    ta.value = JSON.stringify(parsed, null, 2);
    document.getElementById('rawJsonErr').style.display = 'none';
  } catch (e) {
    const errEl = document.getElementById('rawJsonErr');
    errEl.textContent = 'JSON 格式错误: ' + e.message;
    errEl.style.display = 'block';
  }
}

async function saveRawJson() {
  const ta = document.getElementById('rawJsonText');
  const errEl = document.getElementById('rawJsonErr');
  try {
    const parsed = JSON.parse(ta.value);
    errEl.style.display = 'none';
    cfg = parsed;
    await persistConfig();
  } catch (e) {
    errEl.textContent = 'JSON 格式解析失败: ' + e.message;
    errEl.style.display = 'block';
  }
}

async function persistConfig() {
  const badge = document.getElementById('configSourceBadge');
  if (badge) {
    badge.className = 'badge badge-warning';
    badge.innerHTML = `${icon('refresh')} 保存同步中...`;
  }
  try {
    const res = await api('POST', '/api/config', cfg);
    cfgMeta = res;
    if (res?.config) {
      cfg = res.config;
    }
    renderAll();
    toast('配置已保存', 'ok');
    return true;
  } catch (e) {
    if (badge) {
      badge.className = 'badge badge-danger';
      badge.innerHTML = `${icon('xCircle')} 同步失败`;
    }
    toast('保存失败: ' + (e?.message || e), 'err');
    return false;
  }
}

// ---- Init ----------------------------------------------------------------
window.addEventListener('DOMContentLoaded', () => {
  if (getKey()) {
    doLogin();
  } else {
    showLoginOverlay();
  }
});

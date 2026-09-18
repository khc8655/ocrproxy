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
  el.className = `toast ${type}`;
  el.textContent = msg;
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
    toast('复制失败，请手动复制', 'err');
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
  if (res.status === 409) {
    const err = new Error(data?.error?.message || data?.error || '配置版本冲突：远端配置已被其他终端更新，请刷新重新编辑。');
    err.status = 409;
    throw err;
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
    if (cfgRes._version !== undefined && cfg) {
      cfg._version = cfgRes._version;
    }
    cfgMeta = {
      source: cfgRes.source || 'EdgeOne KV',
      lastModified: cfgRes.last_modified,
      version: cfgRes._version,
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
  let totalKeys = 0;
  for (const p of Object.values(providers)) {
    totalKeys += Object.keys(p.keys || {}).length;
  }

  document.getElementById('statModelCount').textContent = models.length;
  document.getElementById('statTotalKeys').textContent = totalKeys;

  const badge = document.getElementById('configSourceBadge');
  if (badge) {
    const src = cfgMeta.source || 'KV';
    badge.className = 'badge badge-success';
    badge.textContent = `${src} 已同步`;
    if (cfgMeta.lastModified) {
      badge.title = `最后同步时间: ${new Date(cfgMeta.lastModified).toLocaleString()}`;
    }
  }

  // Quick models table
  const tbody = document.getElementById('quickModelsBody');
  if (tbody) {
    tbody.innerHTML = '';
    if (models.length === 0) {
      tbody.innerHTML = '<tr><td colspan="4" class="text-secondary" style="text-align:center;padding:24px;">暂未配置 Agent 模型</td></tr>';
      return;
    }

    for (const m of models) {
      const item = cfg.agent_models[m];
      const keys = item.keys || [];
      const tr = document.createElement('tr');
      const modelProtos = getModelProtocols(m);
      const protoBadges = renderProtocolBadges(modelProtos, true);
      tr.innerHTML = `
        <td style="font-weight:600;"><span class="mono">${m}</span> <span style="display:inline-flex;gap:4px;vertical-align:middle;margin-left:4px;">${protoBadges}</span></td>
        <td class="mono text-secondary">${item.upstream_model || m}</td>
        <td><span class="badge badge-neutral">${keys.length} 个候选 Key</span></td>
        <td>
          <button class="btn btn-ghost btn-sm" onclick="switchTab('agents')">查看</button>
        </td>
      `;
      tbody.appendChild(tr);
    }
  }
}

// Protocol Metadata & Helpers (Factual Badges)
const PROTOCOLS = {
  chat: { label: 'OpenAI Chat', short: 'OpenAI', badgeClass: 'badge-success', title: '支持 OpenAI Chat 格式 (/v1/chat/completions)' },
  messages: { label: 'Anthropic Messages', short: 'Messages', badgeClass: 'badge-warning', title: '支持 Anthropic Claude Messages 格式 (/v1/messages)' },
  responses: { label: 'OpenAI Responses', short: 'Responses', badgeClass: 'badge-purple', title: '支持 OpenAI Responses 格式 (/v1/responses)' }
};

function getProviderProtocols(name, provObj){
  const p = provObj || (cfg && cfg.providers && cfg.providers[name]) || {};
  if (Array.isArray(p.protocols) && p.protocols.length > 0) {
    return p.protocols;
  }
  const protos = ['chat'];
  const lower = (name || '').toLowerCase();
  const clean = lower.replace(/[^a-z0-9]/g, '');
  const preset = PRESET_DEFINITIONS[clean] || PRESET_DEFINITIONS[lower];
  if (p.anthropic_messages || clean === 'minimax' || clean === 'bai' || lower === 'b.ai' || p.anthropic_base_url || (preset && preset.anthropic_base_url)) {
    protos.push('messages');
  }
  if (p.openai_responses || p.supports_responses) {
    protos.push('responses');
  }
  return protos;
}

function getModelProtocols(modelName){
  const m = cfg && cfg.agent_models ? cfg.agent_models[modelName] : null;
  if (!m || !m.keys || !m.keys.length) return ['chat'];
  const set = new Set();
  for (const b of m.keys) {
    const provProtos = getProviderProtocols(b.provider);
    provProtos.forEach(pr => set.add(pr));
  }
  return set.size ? Array.from(set) : ['chat'];
}

function renderProtocolBadges(protoList, isShort=true){
  return (protoList || ['chat']).map(pr => {
    const meta = PROTOCOLS[pr] || { label: pr, short: pr, badgeClass: 'badge-neutral', title: pr };
    return `<span class="badge ${meta.badgeClass}" title="${esc(meta.title)}" style="font-weight:600;font-size:11px;padding:2px 7px;">${esc(isShort ? meta.short : meta.label)}</span>`;
  }).join(' ');
}

function renderAgentModels() {
  const box = document.getElementById('agentModelsBox');
  if (!box) return;
  box.innerHTML = '';
  const models = Object.keys(cfg.agent_models || {});

  if (models.length === 0) {
    box.innerHTML = '<div class="card card-pad empty">暂未配置 Agent 模型</div>';
    return;
  }

  for (const m of models) {
    const item = cfg.agent_models[m];
    const keys = item.keys || [];
    const card = document.createElement('div');
    card.className = 'card';

    let keysRowsHtml = '';
    const activeKey = item.active_key || (keys[0] ? keys[0].key : '');
    const strategy = cfg.agent_routing_strategy || 'sticky_failover';
    
    let strategyLabel = `${keys.length} 个 Key · 粘性故障转移 (固定当前，遇错顺延)`;
    if(strategy === 'manual'){
      strategyLabel = `${keys.length} 个 Key · 纯手动直通 (当前使用: ${activeKey})`;
    } else if(strategy === 'round_robin'){
      strategyLabel = `${keys.length} 个 Key · 轮询负载均衡`;
    } else if(strategy === 'priority_fallback'){
      strategyLabel = `${keys.length} 个 Key · 主备优先级降级`;
    } else if(strategy === 'latency_based'){
      strategyLabel = `${keys.length} 个 Key · 最低延迟优先`;
    }

    keys.forEach((b, idx) => {
      const isActive = (b.key === activeKey);
      const cacheKey = `model:${m}:${b.provider}:${b.key}`;
      const latInfo = modelLatencyCache[cacheKey];
      let latBadge = '';
      if (latInfo) {
        latBadge = latInfo.ok
          ? `<span class="badge badge-success">${latInfo.latency_ms}ms</span>`
          : `<span class="badge badge-error">${latInfo.status || 'ERR'}</span>`;
      }

      const setActiveBtn = isActive
        ? `<span class="badge badge-success" style="font-size:11px;padding:2px 8px;font-weight:600;">使用中</span>`
        : `<button class="btn btn-secondary btn-sm" onclick="setActiveAgentKey('${m}', '${b.key}')" title="设为主力 Key" style="font-size:11px;padding:2px 8px;">主</button>`;

      keysRowsHtml += `
        <div class="provider-row" style="padding:10px 16px;">
          <div style="display:flex;align-items:center;gap:10px;">
            <input type="number" min="1" max="${keys.length}" value="${idx+1}" 
                   style="width:38px;height:22px;text-align:center;font-size:12px;font-weight:700;padding:0;border:1px solid #d0d7de;border-radius:4px;"
                   onchange="reorderModelKeyBinding('${m}', ${idx}, this.value)" title="修改数字直接调整顺序" />
            <span style="font-weight:600;">${b.provider}</span>
            <span class="key-chip">${b.key}</span>
            ${latBadge}
          </div>
          <div style="display:flex;align-items:center;gap:6px;">
            ${setActiveBtn}
            <button class="btn btn-ghost btn-sm" onclick="testModelKey('${m}', '${b.provider}', '${b.key}')">探活</button>
            <button class="btn btn-danger btn-sm" onclick="removeModelKeyBinding('${m}', ${idx})">移除</button>
          </div>
        </div>
      `;
    });

    card.innerHTML = `
      <div class="card-head">
        <div>
          <h3>${m} <span style="display:inline-flex;gap:4px;vertical-align:middle;margin-left:4px;">${renderProtocolBadges(getModelProtocols(m), true)}</span></h3>
        <div class="meta mono mt-2">上游映射: ${item.upstream_model || m} · ${strategyLabel}</div>
        </div>
        <div style="display:flex;gap:8px;">
          <button class="btn btn-ghost btn-sm" onclick="testAllKeysForModel('${m}')">探活全部</button>
          <button class="btn btn-primary btn-sm" onclick="openEditModelModal('${m}')">编辑</button>
          <button class="btn btn-danger btn-sm" onclick="deleteModel('${m}')">删除</button>
        </div>
      </div>
      <div style="background:var(--color-bg-page);">${keysRowsHtml || '<div class="empty">暂未绑定 Key</div>'}</div>
    `;
    box.appendChild(card);
  }
}

function renderProviders() {
  const box = document.getElementById('providersBox');
  if (!box) return;
  box.innerHTML = '';
  const providers = cfg.providers || {};
  const provNames = Object.keys(providers);

  if (provNames.length === 0) {
    box.innerHTML = '<div class="card card-pad empty">暂未配置供应商</div>';
    return;
  }

  for (const p of provNames) {
    const prov = providers[p];
    const keysObj = prov.keys || {};
    const keyLabels = Object.keys(keysObj);
    const card = document.createElement('div');
    card.className = 'card';

    let keysListHtml = '';
    keyLabels.forEach(k => {
      const val = keysObj[k];
      const masked = val ? `${val.slice(0, 6)}...${val.slice(-4)}` : '';
      const cacheKey = `prov:${p}:${k}`;
      const latInfo = modelLatencyCache[cacheKey];
      let latBadge = '';
      if (latInfo) {
        latBadge = latInfo.ok
          ? `<span class="badge badge-success">${latInfo.latency_ms}ms</span>`
          : `<span class="badge badge-error">${latInfo.status || 'ERR'}</span>`;
      }

      keysListHtml += `
        <div class="provider-row" style="padding:10px 16px;">
          <div style="display:flex;align-items:center;gap:10px;">
            <span style="font-weight:600;">${k}</span>
            <span class="mono text-secondary" style="font-size:12px;">${masked}</span>
            ${latBadge}
          </div>
          <div style="display:flex;gap:6px;">
            <button class="btn btn-ghost btn-sm" onclick="testSingleKey('${p}', '${k}')">测试</button>
            <button class="btn btn-ghost btn-sm" onclick="openEditKeyModal('${p}', '${k}', '${val}')">编辑</button>
            <button class="btn btn-danger btn-sm" onclick="deleteKey('${p}', '${k}')">删除</button>
          </div>
        </div>
      `;
    });

    const protos = getProviderProtocols(p, prov);
    const protoBadges = renderProtocolBadges(protos, false);
    const hasMessages = protos.includes('messages');
    let messagesUrlPart = '';
    if (hasMessages) {
      if (prov.anthropic_base_url && prov.anthropic_base_url !== prov.base_url) {
        messagesUrlPart = ` · Messages: ${prov.anthropic_base_url}`;
      } else {
        messagesUrlPart = ` · Messages: ${prov.anthropic_base_url || prov.base_url} (默认)`;
      }
    }
    const ver = prov.preset_version ? `规则 v${prov.preset_version}` : (prov.adapter_rules ? '自定义规则' : '默认');
    const verBadge = `<span class="badge badge-neutral" style="font-size:11px;padding:2px 7px;" title="预设规则版本">${ver}</span>`;
    const hasUpdate = RULE_UPDATES_MAP[p];
    const updateBtn = hasUpdate
      ? `<button class="btn btn-warning btn-sm" onclick="applySingleProviderRuleUpdate('${p}')">⬆️ 升级规则至 v${hasUpdate.remote_version}</button>`
      : '';

    let cachedModelsBar = '';
    if (prov.cached_models && prov.cached_models.length > 0) {
      const topSlice = prov.cached_models.slice(0, 8);
      const moreCount = prov.cached_models.length - topSlice.length;
      cachedModelsBar = `
        <div style="padding:6px 16px;background:var(--color-bg-page);border-bottom:1px solid var(--color-border);font-size:12px;display:flex;align-items:center;gap:6px;flex-wrap:wrap;">
          <span class="badge badge-primary" style="font-size:11px;padding:1px 6px;">已探得 ${prov.cached_models.length} 个模型</span>
          ${topSlice.map(m => `<span class="badge badge-neutral" style="font-size:11px;padding:1px 6px;">${m}</span>`).join('')}
          ${moreCount > 0 ? `<span class="text-secondary" style="font-size:11px;">+${moreCount} 更多</span>` : ''}
        </div>
      `;
    }

    card.innerHTML = `
      <div class="card-head">
        <div>
          <h3>${p} <span style="display:inline-flex;gap:4px;vertical-align:middle;margin-left:4px;">${protoBadges} ${verBadge}</span></h3>
        <div class="meta mono mt-2">${prov.base_url || '—'}${messagesUrlPart} · ${keyLabels.length} 个 Key</div>
        </div>
        <div style="display:flex;gap:8px;align-items:center;">
          ${updateBtn}
          <button class="btn btn-ghost btn-sm" onclick="openEditProviderModal('${p}')">编辑</button>
          <button class="btn btn-primary btn-sm" onclick="openAddKeyModal('${p}')">+ 新增 Key</button>
          <button class="btn btn-danger btn-sm" onclick="deleteProvider('${p}')">删除供应商</button>
        </div>
      </div>
      ${cachedModelsBar}
      <div style="background:var(--color-bg-page);">${keysListHtml || '<div class="empty">暂无 Key</div>'}</div>
    `;
    box.appendChild(card);
  }
}

async function probeProviderModels(p) {
  const prov = cfg.providers?.[p];
  if (!prov) return;
  const keys = Object.values(prov.keys || {});
  const firstKey = keys[0] || '';
  toast(`正在向上游探测「${p}」可用模型...`, 'info');
  try {
    const res = await fetch('/api/admin/probe-models', {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({
        base_url: prov.base_url,
        api_key: firstKey,
        provider: p
      })
    });
    const data = await res.json();
    if (data.ok && Array.isArray(data.models) && data.models.length > 0) {
      prov.cached_models = data.models;
      await persistConfig();
      renderProviders();
      toast(`探测成功，发现 ${data.models.length} 个可用模型并已更新`, 'ok');
    } else {
      toast(`探测完成: ${data.error || '未返回可用模型'}`, 'warn');
    }
  } catch (e) {
    toast(`探测异常: ${e.message}`, 'err');
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

// ---- Preset Selection & Remote Distribution -----------------------------
async function loadPresetsCatalog() {
  const select = document.getElementById('m_prov_preset');
  if (!select) return;
  if (!PRESET_CATALOG || PRESET_CATALOG.length === 0) {
    PRESET_CATALOG = Object.keys(FALLBACK_PRESETS).map(k => ({
      id: k,
      name: FALLBACK_PRESETS[k].name,
      version: FALLBACK_PRESETS[k].version || '1.1.0',
      description: FALLBACK_PRESETS[k].description
    }));
  }
  populateCatalogSelect(select);

  // Silent background sync for new remote presets without disturbing the UI
  try {
    const res = await api('GET', '/api/admin/presets?action=catalog');
    if (res && res.ok && Array.isArray(res.providers) && res.providers.length > 0) {
      PRESET_CATALOG = res.providers;
      populateCatalogSelect(select);
    }
  } catch (e) {
    // Silent fallback
  }
}

function populateCatalogSelect(select) {
  const cur = select.value;
  const catalog = (PRESET_CATALOG && PRESET_CATALOG.length > 0)
    ? PRESET_CATALOG
    : Object.keys(FALLBACK_PRESETS).map(k => ({
        id: k,
        name: FALLBACK_PRESETS[k].name,
        version: FALLBACK_PRESETS[k].version || '1.1.0',
        description: FALLBACK_PRESETS[k].description
      }));

  select.innerHTML = '<option value="">-- 自定义供应商 (本地内置·手动填写) --</option>' +
    '<optgroup label="官方预设厂商模板 (按需选用)">' +
    catalog.map(p => `<option value="${p.id}">${p.name} (v${p.version || '1.1.0'})</option>`).join('') +
    '</optgroup>';
  if (cur !== undefined && cur !== null) select.value = cur;
}

async function onPresetSelected() {
  const presetId = document.getElementById('m_prov_preset').value;
  const nameInput = document.getElementById('m_prov_name');
  const urlInput = document.getElementById('m_prov_url');
  const descEl = document.getElementById('m_prov_desc');
  const modelsWrap = document.getElementById('m_prov_models_wrap');
  const modelsList = document.getElementById('m_prov_models_list');

  if (!presetId) {
    currentSelectedPreset = null;
    nameInput.value = '';
    urlInput.value = '';
    nameInput.disabled = false;
    urlInput.disabled = false;
    descEl.style.display = 'block';
    descEl.style.background = 'var(--color-bg-page)';
    descEl.style.color = 'var(--color-text-2)';
    descEl.innerHTML = '<strong>自定义模式（本地内置）</strong>：无需拉取云端规则，可直接填写任意私有部署或第三方 OpenAI / Anthropic 兼容端点。';
    modelsWrap.style.display = 'none';
    modelsList.innerHTML = '';
    return;
  }

  // Fetch preset detail on demand if not cached
  let preset = CACHED_PRESETS[presetId];
  if (!preset) {
    descEl.textContent = '正在按需拉取云端厂商规则与推荐模型...';
    descEl.style.display = 'block';
    try {
      const res = await api('GET', `/api/admin/presets?action=detail&id=${encodeURIComponent(presetId)}`);
      if (res && res.ok && res.preset) {
        preset = res.preset;
        CACHED_PRESETS[presetId] = preset;
      }
    } catch (e) {
      console.warn('Failed to load preset detail on-demand:', e);
    }
  }
  if (!preset && FALLBACK_PRESETS[presetId]) {
    preset = FALLBACK_PRESETS[presetId];
  }

  if (!preset) {
    toast(`未能获取模板「${presetId}」规则`, 'err');
    return;
  }

  currentSelectedPreset = preset;
  nameInput.value = preset.id;
  urlInput.value = preset.base_url;
  descEl.textContent = `${preset.description || ''} · 规则版本: v${preset.version || '1.1.0'}`;
  descEl.style.display = 'block';

  // Preset protocols sync
  const presetProtos = preset.protocols || (preset.anthropic_base_url ? ['chat', 'messages'] : ['chat']);
  const cChat = document.getElementById('m_prov_proto_chat'); if(cChat) cChat.checked = presetProtos.includes('chat');
  const cMsg = document.getElementById('m_prov_proto_messages'); if(cMsg) cMsg.checked = presetProtos.includes('messages');
  const cResp = document.getElementById('m_prov_proto_responses'); if(cResp) cResp.checked = presetProtos.includes('responses');

  // Custom Anthropic URL
  const customToggle = document.getElementById('m_prov_custom_url_toggle');
  const customSection = document.getElementById('m_prov_custom_url_section');
  const customUrlInput = document.getElementById('m_prov_anthropic_url');
  if (preset.anthropic_base_url && preset.anthropic_base_url !== preset.base_url) {
    if (customToggle) customToggle.checked = true;
    if (customSection) customSection.style.display = 'block';
    if (customUrlInput) customUrlInput.value = preset.anthropic_base_url;
  } else {
    if (customToggle) customToggle.checked = false;
    if (customSection) customSection.style.display = 'none';
    if (customUrlInput) customUrlInput.value = '';
  }

  // Render recommended models checklist
  modelsList.innerHTML = '';
  const recModels = preset.recommended_models || [];
  if (recModels.length > 0) {
    modelsWrap.style.display = 'block';
    recModels.forEach((rm) => {
      const row = document.createElement('div');
      row.style.marginBottom = '6px';
      row.innerHTML = `
        <label class="checkbox" style="align-items:flex-start;">
          <input type="checkbox" data-model="${rm.name}" data-upstream="${rm.upstream || rm.upstream_model || rm.name}" ${rm.checked !== false ? 'checked' : ''}>
          <div style="font-size:12px;">
            <div style="font-weight:600;color:var(--color-text-1);">${rm.name} <span class="mono text-secondary" style="font-weight:normal;">(映射: ${rm.upstream || rm.upstream_model || rm.name})</span></div>
            <div class="text-secondary" style="font-size:11px;margin-top:2px;">${rm.desc || rm.description || ''}</div>
          </div>
        </label>
      `;
      modelsList.appendChild(row);
    });
  } else {
    modelsWrap.style.display = 'none';
  }
}

function onEdgeOneCustomUrlToggleChange() {
  const isChecked = document.getElementById('m_prov_custom_url_toggle')?.checked;
  const wrap = document.getElementById('m_prov_custom_url_section');
  if (wrap) wrap.style.display = isChecked ? 'block' : 'none';
}

function openAddProviderModal() {
  currentSelectedPreset = null;
  document.getElementById('providerModalTitle').textContent = '新增供应商';
  document.getElementById('presetSelectGroup').style.display = 'block';
  document.getElementById('m_prov_preset').value = '';
  onPresetSelected();
  document.getElementById('m_prov_name').value = '';
  document.getElementById('m_prov_name').disabled = false;
  document.getElementById('m_prov_url').value = '';
  const cChat = document.getElementById('m_prov_proto_chat'); if(cChat) cChat.checked = true;
  const cMsg = document.getElementById('m_prov_proto_messages'); if(cMsg) cMsg.checked = false;
  const cResp = document.getElementById('m_prov_proto_responses'); if(cResp) cResp.checked = false;
  const customToggle = document.getElementById('m_prov_custom_url_toggle'); if(customToggle) customToggle.checked = false;
  const customSection = document.getElementById('m_prov_custom_url_section'); if(customSection) customSection.style.display = 'none';
  const uInput = document.getElementById('m_prov_anthropic_url'); if(uInput) uInput.value = '';
  document.getElementById('m_prov_models_wrap').style.display = 'none';
  loadPresetsCatalog();
  openModal('providerModal');
}

function openEditProviderModal(name) {
  currentSelectedPreset = null;
  const prov = cfg.providers?.[name] || {};
  document.getElementById('providerModalTitle').textContent = '编辑供应商 - ' + name;
  document.getElementById('presetSelectGroup').style.display = 'none';
  document.getElementById('m_prov_name').value = name;
  document.getElementById('m_prov_name').disabled = true;
  document.getElementById('m_prov_url').value = prov.base_url || '';

  const protos = getProviderProtocols(name, prov);
  const cChat = document.getElementById('m_prov_proto_chat'); if(cChat) cChat.checked = protos.includes('chat');
  const cMsg = document.getElementById('m_prov_proto_messages'); if(cMsg) cMsg.checked = protos.includes('messages');
  const cResp = document.getElementById('m_prov_proto_responses'); if(cResp) cResp.checked = protos.includes('responses');

  const customToggle = document.getElementById('m_prov_custom_url_toggle');
  const customSection = document.getElementById('m_prov_custom_url_section');
  const uInput = document.getElementById('m_prov_anthropic_url');
  if (prov.anthropic_base_url) {
    if (customToggle) customToggle.checked = true;
    if (customSection) customSection.style.display = 'block';
    if (uInput) uInput.value = prov.anthropic_base_url;
  } else {
    if (customToggle) customToggle.checked = false;
    if (customSection) customSection.style.display = 'none';
    if (uInput) uInput.value = '';
  }

  document.getElementById('m_prov_desc').style.display = 'none';
  document.getElementById('m_prov_models_wrap').style.display = 'none';
  openModal('providerModal');
}

async function saveProviderModal() {
  const name = document.getElementById('m_prov_name').value.trim();
  const url = document.getElementById('m_prov_url').value.trim();
  if (!name || !url) { toast('请填写供应商与 Base URL', 'err'); return; }

  const selectedProtos = [];
  if (document.getElementById('m_prov_proto_chat')?.checked) selectedProtos.push('chat');
  if (document.getElementById('m_prov_proto_messages')?.checked) selectedProtos.push('messages');
  if (document.getElementById('m_prov_proto_responses')?.checked) selectedProtos.push('responses');
  if (!selectedProtos.length) { toast('请至少选择一种支持的协议类型', 'err'); return; }

  const backupCfg = JSON.parse(JSON.stringify(cfg));

  cfg.providers = cfg.providers || {};
  cfg.providers[name] = cfg.providers[name] || { keys: {} };
  cfg.providers[name].base_url = url;
  cfg.providers[name].protocols = selectedProtos;
  cfg.providers[name].anthropic_messages = selectedProtos.includes('messages');

  const customToggle = document.getElementById('m_prov_custom_url_toggle');
  const anthropicUrl = customToggle?.checked ? document.getElementById('m_prov_anthropic_url')?.value.trim() : '';
  if (selectedProtos.includes('messages') && anthropicUrl) {
    cfg.providers[name].anthropic_base_url = anthropicUrl;
  } else {
    delete cfg.providers[name].anthropic_base_url;
  }

  // If a preset was selected during creation, attach rules and metadata to local config
  if (currentSelectedPreset && (currentSelectedPreset.id === name || !cfg.providers[name].preset_id)) {
    cfg.providers[name].preset_id = currentSelectedPreset.id;
    cfg.providers[name].preset_version = currentSelectedPreset.version || '1.1.0';
    if (currentSelectedPreset.adapter_rules) {
      cfg.providers[name].adapter_rules = currentSelectedPreset.adapter_rules;
    }
    if (currentSelectedPreset.recommended_models) {
      cfg.providers[name].recommended_models = currentSelectedPreset.recommended_models;
    }
  }

  // If recommended models were checked, auto-register them
  const checkedModels = document.querySelectorAll('#m_prov_models_list input[type="checkbox"]:checked');
  if (checkedModels.length > 0) {
    cfg.agent_models = cfg.agent_models || {};
    checkedModels.forEach((cb) => {
      const modelName = cb.dataset.model;
      const upstream = cb.dataset.upstream || modelName;
      if (!cfg.agent_models[modelName]) {
        cfg.agent_models[modelName] = {
          upstream_model: upstream,
          keys: [],
        };
      }
    });
  }

  const ok = await persistConfig();
  if (ok) {
    closeModal('providerModal');
  } else {
    cfg = backupCfg;
    renderAll();
  }
}

async function deleteProvider(name) {
  if (!confirm(`删除供应商「${name}」及其全部 Key？本地规则与配置将一并清理。`)) return;
  delete cfg.providers[name];
  if (RULE_UPDATES_MAP[name]) delete RULE_UPDATES_MAP[name];
  await persistConfig();
}

// Incremental Rule Updates
async function checkAllRuleUpdates() {
  const btn = document.getElementById('btnCheckRuleUpdates');
  const alertEl = document.getElementById('ruleUpdatesAlert');
  if (btn) {
    btn.disabled = true;
    btn.textContent = '检查中...';
  }

  try {
    const provs = cfg.providers || {};
    const payload = {
      providers: Object.keys(provs).map(id => ({
        id,
        version: provs[id].preset_version || '1.0.0',
        rule_hash: provs[id].rule_hash || ''
      }))
    };

    const res = await api('POST', '/api/admin/presets?action=check-updates', payload);
    RULE_UPDATES_MAP = {};
    if (res && res.ok && Array.isArray(res.updates) && res.updates.length > 0) {
      res.updates.forEach(u => {
        RULE_UPDATES_MAP[u.provider_id] = u;
      });

      if (alertEl) {
        alertEl.style.display = 'flex';
        alertEl.innerHTML = `
          <div>
            <strong>发现 ${res.updates.length} 个供应商规则有更新</strong>：
            ${res.updates.map(u => `<span class="badge badge-warning" style="margin-left:4px;">${u.provider_id}: ${u.current_version} &rarr; ${u.latest_version || u.remote_version || '最新'}</span>`).join('')}
          </div>
          <button class="btn btn-primary btn-sm" onclick="applyAllProviderRuleUpdates()">一键更新全部规则</button>
        `;
      }
      toast(`检查完成：发现 ${res.updates.length} 个供应商有新规则`, 'ok');
    } else {
      if (alertEl) alertEl.style.display = 'none';
      toast('所有供应商规则均为最新版本 (无需更新)', 'ok');
    }
    renderProviders();
  } catch (e) {
    toast(`检查规则更新失败: ${e.message}`, 'err');
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = '检查规则更新';
    }
  }
}

async function applySingleProviderRuleUpdate(pName) {
  await applyRuleUpdates([pName]);
}

async function applyAllProviderRuleUpdates() {
  const ids = Object.keys(RULE_UPDATES_MAP);
  if (!ids.length) return;
  await applyRuleUpdates(ids);
}

async function applyRuleUpdates(providerIds) {
  try {
    toast(`正在增量拉取并更新 ${providerIds.join(', ')} 的规则...`, 'ok');
    const res = await api('POST', '/api/admin/presets?action=update-rules', { provider_ids: providerIds });
    if (res && res.ok && Array.isArray(res.updated) && res.updated.length > 0) {
      await loadConfig();
      providerIds.forEach(id => delete RULE_UPDATES_MAP[id]);
      const alertEl = document.getElementById('ruleUpdatesAlert');
      if (alertEl && Object.keys(RULE_UPDATES_MAP).length === 0) {
        alertEl.style.display = 'none';
      }
      toast(`成功更新 ${res.updated.length} 个供应商的规则并已自动生效！`, 'ok');
      renderProviders();
    } else {
      toast(res?.message || '规则更新失败或无变更', 'err');
    }
  } catch (e) {
    toast(`更新规则失败: ${e.message}`, 'err');
  }
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
          let html = '<div style="font-weight:700;margin-bottom:8px;color:var(--color-danger);display:flex;align-items:center;gap:6px;">协议连通性未完全通过 (已阻止保存)</div>';
          html += '<div style="display:flex;flex-direction:column;gap:6px;font-size:12px;">';
          for (const pr of protos) {
            const res = (d.protocols && d.protocols[pr]) || { valid: false, error: '未测试' };
            const pName = PROTOCOLS[pr] ? PROTOCOLS[pr].label : pr;
            if (res.valid) {
              html += `<div style="display:flex;align-items:center;gap:6px;color:var(--color-success);"><span class="badge badge-success">通过</span> <b>${esc(pName)}</b>: 验证通过 (${res.latency_ms || 0}ms)</div>`;
            } else {
              html += `<div style="display:flex;align-items:flex-start;gap:6px;color:var(--color-danger);"><span class="badge badge-error">失败</span> <div><b>${esc(pName)}</b>: 验证失败 (${esc(res.error || '请求未通')})</div></div>`;
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
        diagBox.innerHTML = `<div style="color:var(--color-danger);font-size:12px;">验证请求失败: ${esc(e.message)}。<br>如网络受限，可勾选上方「跳过连通性在线校验」后强制保存。</div>`;
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

function populateModelProvFilter() {
  const select = document.getElementById('m_model_prov_filter');
  if (!select) return;
  select.innerHTML = '<option value="">全部供应商</option>';
  const providers = cfg.providers || {};
  for (const p of Object.keys(providers)) {
    const opt = document.createElement('option');
    opt.value = p;
    opt.textContent = p;
    select.appendChild(opt);
  }
}

function onModelProvFilterChange() {
  const filterProv = document.getElementById('m_model_prov_filter').value;
  renderBindingsCheckboxes(getSelectedBindingsFromDom(), filterProv);
  renderQuickModelTags(filterProv);
}

function renderQuickModelTags(prov) {
  const tagBox = document.getElementById('m_quick_model_tags');
  if (!tagBox) return;
  tagBox.innerHTML = '';
  if (!prov) return;

  const provData = cfg.providers?.[prov];
  const recModels = provData?.recommended_models || CACHED_PRESETS[prov]?.recommended_models || FALLBACK_PRESETS[prov]?.recommended_models || [];
  if (recModels && recModels.length > 0) {
    recModels.forEach(m => {
      const mName = m.name || m.id;
      const mUpstream = m.upstream || m.upstream_model || mName;
      const tag = document.createElement('button');
      tag.type = 'button';
      tag.className = 'btn btn-ghost btn-sm';
      tag.style.cssText = 'font-size:11px;padding:2px 8px;height:24px;background:var(--color-bg-subtle);';
      tag.textContent = `+ 填入 ${mName}`;
      tag.onclick = () => {
        document.getElementById('m_model_name').value = mName;
        document.getElementById('m_upstream_model').value = mUpstream;
        toggleProviderKeys(prov, true);
      };
      tagBox.appendChild(tag);
    });
  }
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

function openAddModelModal() {
  openAddAgentModal();
}

function openAddAgentModal() {
  document.getElementById('agentModalTitle').textContent = '新增 Agent 模型';
  document.getElementById('m_model_old_name').value = '';
  document.getElementById('m_model_name').value = '';
  document.getElementById('m_model_name').disabled = false;
  document.getElementById('m_upstream_model').value = '';
  currentEditingModelKeys = [];
  populateModelProvFilter();
  document.getElementById('m_model_prov_filter').value = '';
  renderBindingsCheckboxes([]);
  renderQuickModelTags('');
  openModal('agentModal');
}

function openEditModelModal(m) {
  document.getElementById('agentModalTitle').textContent = `编辑 Agent 模型: ${m}`;
  document.getElementById('m_model_old_name').value = m;
  document.getElementById('m_model_name').value = m;
  document.getElementById('m_model_name').disabled = false; // Allow renaming
  const item = cfg.agent_models[m] || {};
  document.getElementById('m_upstream_model').value = item.upstream_model || '';
  currentEditingModelKeys = item.keys || [];
  populateModelProvFilter();
  document.getElementById('m_model_prov_filter').value = '';
  renderBindingsCheckboxes(item.keys || []);
  renderQuickModelTags('');
  openModal('agentModal');
}

function renderBindingsCheckboxes(existingKeys = [], filterProv = '') {
  const container = document.getElementById('m_bindings_container');
  if (!container) return;
  container.innerHTML = '';
  const providers = cfg.providers || {};
  let provList = Object.keys(providers);
  if (filterProv) {
    provList = provList.filter(p => p === filterProv);
  }

  let totalKeys = 0;
  for (const p of provList) {
    const prov = providers[p];
    const keysObj = prov.keys || {};
    const keyLabels = Object.keys(keysObj);
    if (keyLabels.length === 0) continue;

    const groupDiv = document.createElement('div');
    groupDiv.className = 'provider-key-group';
    groupDiv.style.cssText = 'border:1px solid var(--color-border);border-radius:var(--radius-sm);background:#fff;padding:8px 12px;';

    let keysCheckboxesHtml = '';
    keyLabels.forEach(k => {
      totalKeys++;
      const isChecked = existingKeys.some(b => b.provider === p && b.key === k);
      keysCheckboxesHtml += `
        <label class="checkbox" style="font-size:13px;cursor:pointer;margin:0;">
          <input type="checkbox" data-provider="${p}" data-key="${k}" ${isChecked ? 'checked' : ''}>
          <span><span class="key-chip" style="font-weight:600;">${k}</span></span>
        </label>
      `;
    });

    groupDiv.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;border-bottom:1px solid var(--color-border);padding-bottom:4px;">
        <span style="font-weight:700;font-size:13px;color:var(--color-text-primary);">${p}</span>
        <button type="button" class="btn btn-ghost btn-sm" style="font-size:11px;padding:0 6px;height:20px;" onclick="toggleProviderKeys('${p}')">选择该厂商</button>
      </div>
      <div style="display:flex;flex-wrap:wrap;gap:12px;">
        ${keysCheckboxesHtml}
      </div>
    `;
    container.appendChild(groupDiv);
  }

  if (totalKeys === 0) {
    container.innerHTML = '<div class="text-secondary" style="font-size:12px;padding:8px;">暂无匹配的 Key，请先添加供应商与 Key</div>';
  }
}

async function saveAgentModal() {
  const oldName = (document.getElementById('m_model_old_name').value || '').trim();
  const name = document.getElementById('m_model_name').value.trim();
  const upstream = document.getElementById('m_upstream_model').value.trim();
  if (!name) { toast('请输入模型名称', 'err'); return; }

  const checkedBoxes = document.querySelectorAll('#m_bindings_container input[type="checkbox"]:checked');
  const keys = Array.from(checkedBoxes).map(cb => ({
    provider: cb.dataset.provider,
    key: cb.dataset.key,
  }));

  if (keys.length === 0) {
    toast('请至少勾选一个候选 Key 绑定', 'err');
    return;
  }

  const backupCfg = JSON.parse(JSON.stringify(cfg));

  cfg.agent_models = cfg.agent_models || {};

  // Check if adding a new model that collides with an existing model
  if (!oldName && cfg.agent_models[name]) {
    const existing = cfg.agent_models[name];
    const existingKeySet = new Set((existing.keys || []).map(k => `${k.provider}:${k.key}`));
    const newKeysToAdd = keys.filter(k => !existingKeySet.has(`${k.provider}:${k.key}`));

    const msg = newKeysToAdd.length > 0
      ? `模型 ID「${name}」已存在！\n\n点击【确定】将勾选的 ${newKeysToAdd.length} 个新 Key 追加合并至该已有模型；\n点击【取消】返回修改模型名称。`
      : `模型 ID「${name}」已存在，且所选 Key 已全部绑定至该模型。\n\n点击【确定】保留原有配置并退出；点击【取消】返回修改模型名称。`;

    if (!confirm(msg)) {
      document.getElementById('m_model_name').focus();
      return;
    }

    if (newKeysToAdd.length > 0) {
      existing.keys = (existing.keys || []).concat(newKeysToAdd);
    }
    if (upstream && upstream !== name) {
      existing.upstream_model = upstream;
    }
  } else {
    if (oldName && oldName !== name) {
      delete cfg.agent_models[oldName];
    }
    cfg.agent_models[name] = { keys };
    if (upstream && upstream !== name) cfg.agent_models[name].upstream_model = upstream;
  }

  const ok = await persistConfig();
  if (ok) {
    closeModal('agentModal');
  } else {
    cfg = backupCfg;
    renderAll();
  }
}

async function removeModelKeyBinding(modelName, index) {
  if (cfg.agent_models?.[modelName]?.keys) {
    cfg.agent_models[modelName].keys.splice(index, 1);
    await persistConfig();
  }
}

async function reorderModelKeyBinding(modelName, fromIdx, inputVal) {
  if (!cfg.agent_models || !cfg.agent_models[modelName]) return;
  const list = cfg.agent_models[modelName].keys || [];
  let targetPos = parseInt(inputVal, 10);
  if (isNaN(targetPos)) {
    renderAgentModels();
    return;
  }
  let targetIdx = Math.max(0, Math.min(list.length - 1, targetPos - 1));
  if (targetIdx === fromIdx) {
    renderAgentModels();
    return;
  }
  const [item] = list.splice(fromIdx, 1);
  list.splice(targetIdx, 0, item);
  cfg.agent_models[modelName].keys = list;
  renderAgentModels();
  await persistConfig();
  toast('已调整 Key 优先级', 'ok');
}

async function moveModelKeyBinding(modelName, index, dir) {
  if (!cfg.agent_models || !cfg.agent_models[modelName]) return;
  const list = cfg.agent_models[modelName].keys || [];
  const target = index + dir;
  if (target < 0 || target >= list.length) return;
  const [item] = list.splice(index, 1);
  list.splice(target, 0, item);
  cfg.agent_models[modelName].keys = list;
  renderAgentModels();
  await persistConfig();
  toast('已调整 Key 优先级', 'ok');
}

async function testAllKeysForModel(modelName) {
  const item = cfg.agent_models?.[modelName];
  if (!item || !item.keys || !item.keys.length) return;
  toast(`正在并发探活 ${modelName} 的 ${item.keys.length} 个 Key...`, 'info');
  await Promise.all(item.keys.map(b => testModelKey(modelName, b.provider, b.key)));
  toast(`${modelName} 探活完成`, 'ok');
}

async function deleteModel(name) {
  if (!confirm(`删除模型「${name}」？`)) return;
  delete cfg.agent_models[name];
  await persistConfig();
}

async function setActiveAgentKey(modelName, keyLabel) {
  if (!cfg.agent_models || !cfg.agent_models[modelName]) return;
  cfg.agent_models[modelName].active_key = keyLabel;
  renderAgentModels();
  await persistConfig();
  toast(`已将模型 ${modelName} 设置为主力 Key: [${keyLabel}]`, 'ok');
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
    badge.textContent = '⏳ 保存同步中...';
  }
  try {
    const res = await api('POST', '/api/config', cfg);
    cfgMeta = res;
    if (res?.config) {
      cfg = res.config;
    }
    if (res?._version !== undefined && cfg) {
      cfg._version = res._version;
    }
    renderAll();
    toast('配置已保存', 'ok');
    return true;
  } catch (e) {
    if (badge) {
      badge.className = 'badge badge-danger';
      badge.textContent = '同步失败';
    }
    if (e?.status === 409 || (e?.message && e.message.includes('冲突'))) {
      alert('配置保存冲突：远端配置已被其他终端或窗口更新！\n\n为防止覆盖最新配置，系统将自动重新拉取线上最新配置。');
      await loadAllData();
      return false;
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

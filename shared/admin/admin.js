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

// ---- Provider Presets Database -------------------------------------------
const PRESET_DEFINITIONS = {
  minimax: {
    id: 'minimax',
    name: 'MiniMax (官方开放平台 / M3 系列)',
    base_url: 'https://api.minimaxi.com/v1',
    anthropic_base_url: 'https://api.minimax.cn/anthropic',
    description: 'MiniMax 官方国内订阅平台，支持 MiniMax-M3 系列，原生兼容 OpenAI Completions 与 Anthropic Messages 双协议直通',
    recommended_models: [
      { name: 'MiniMax-M3', upstream: 'MiniMax-M3', desc: 'MiniMax-M3 旗舰多模态通用模型 (支持超长思考，兼容 Messages)', checked: true },
    ]
  },
  bai: {
    id: 'bai',
    name: 'B.AI (双协议兼容中转)',
    base_url: 'https://api.b.ai/v1',
    anthropic_base_url: 'https://api.b.ai/v1',
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
    name: 'Agnes AI (爱格尼斯海外智能体)',
    base_url: 'https://apihub.agnes-ai.com/v1',
    anthropic_base_url: 'https://apihub.agnes-ai.com/v1',
    description: 'Agnes AI 平台，支持 agnes-2.5-flash 等高并发轻量 Agent 模型 (512K 上下文)',
    recommended_models: [
      { name: 'agnes-2.5-flash', upstream: 'agnes-2.5-flash', desc: 'Agnes 2.5 Flash 旗舰高速模型 (512K 上下文)', checked: true },
      { name: 'agnes-2.0-flash', upstream: 'agnes-2.0-flash', desc: 'Agnes 2.0 Flash 兼容回退模型', checked: false },
    ]
  },
  google: {
    id: 'google',
    name: 'Google AI Studio (Gemini)',
    base_url: 'https://generativelanguage.googleapis.com/v1beta/openai',
    description: 'Google 官方 Gemini 系列大模型，支持 Gemini 2.5 / 3 / 3.5+，已内置 Thinking Config 思考等级映射与 Schema 裁剪适配',
    recommended_models: [
      { name: 'gemini-3.5-flash', upstream: 'gemini-3.5-flash', desc: '最新高性价比推理模型 (支持 low/medium/high 思考等级)', checked: true },
      { name: 'gemini-3.5-pro', upstream: 'gemini-3.5-pro', desc: '最新旗舰强推理模型 (支持 low/high 思考等级)', checked: true },
      { name: 'gemini-2.5-flash', upstream: 'gemini-2.5-flash', desc: '经典多模态快速模型', checked: false },
      { name: 'gemini-2.5-pro', upstream: 'gemini-2.5-pro', desc: '经典多模态深度思考模型', checked: false },
    ]
  },
  sensenova: {
    id: 'sensenova',
    name: '商汤日日新 (SenseNova)',
    base_url: 'https://token.sensenova.cn/v1',
    description: '商汤日日新大模型开放平台，支持 GLM-5.2、DeepSeek-V3/R1 等，原生支持 reasoning_effort 思考控制',
    recommended_models: [
      { name: 'glm-5.2', upstream: 'GLM-5.2', desc: '智谱/商汤最新 GLM-5.2 旗舰推理大模型', checked: true },
      { name: 'deepseek-v3', upstream: 'DeepSeek-V3', desc: 'DeepSeek-V3 基础推理模型', checked: false },
      { name: 'deepseek-r1', upstream: 'DeepSeek-R1', desc: 'DeepSeek-R1 深度思考推理模型', checked: false },
    ]
  },
  stepfun: {
    id: 'stepfun',
    name: '阶跃星辰 (StepFun)',
    base_url: 'https://api.stepfun.com/v1',
    description: '阶跃星辰大模型平台，已自动适配 reasoning_effort none->low 降级与 deepseek-style 思考格式注入',
    recommended_models: [
      { name: 'step-3.7-flash', upstream: 'step-3.7-flash', desc: '阶跃最新闪电高速推理大模型', checked: true },
      { name: 'step-2-16k', upstream: 'step-2-16k', desc: '阶跃 Step-2 旗舰大模型', checked: false },
    ]
  },
  siliconflow: {
    id: 'siliconflow',
    name: '硅基流动 (SiliconFlow)',
    base_url: 'https://api.siliconflow.cn/v1',
    description: '硅基流动高并发推理平台，包含 DeepSeek-V3/R1、Qwen2.5 等海量开源模型',
    recommended_models: [
      { name: 'deepseek-ai/DeepSeek-V3', upstream: 'deepseek-ai/DeepSeek-V3', desc: 'DeepSeek-V3 全尺寸旗舰模型', checked: true },
      { name: 'deepseek-ai/DeepSeek-R1', upstream: 'deepseek-ai/DeepSeek-R1', desc: 'DeepSeek-R1 全尺寸深度思考模型', checked: false },
      { name: 'Qwen/Qwen2.5-72B-Instruct', upstream: 'Qwen/Qwen2.5-72B-Instruct', desc: '通义千问 72B Instruct 指令模型', checked: false },
    ]
  },
  tokenrhythm: {
    id: 'tokenrhythm',
    name: 'TokenRhythm',
    base_url: 'https://api.tokenrhythm.com/v1',
    description: 'TokenRhythm 聚合大模型路由网关，已自动适配 tool_choice 格式转换',
    recommended_models: [
      { name: 'claude-3-5-sonnet-20241022', upstream: 'claude-3-5-sonnet-20241022', desc: 'Claude 3.5 Sonnet 强编程模型', checked: true },
      { name: 'gpt-4o', upstream: 'gpt-4o', desc: 'OpenAI GPT-4o 旗舰全能模型', checked: false },
    ]
  },
  deepseek: {
    id: 'deepseek',
    name: 'DeepSeek 官方开放平台',
    base_url: 'https://api.deepseek.com/v1',
    description: 'DeepSeek 官方 API，原生支持 reasoning_content 深度思考与前缀缓存',
    recommended_models: [
      { name: 'deepseek-chat', upstream: 'deepseek-chat', desc: 'DeepSeek-V3 快速对话大模型', checked: true },
      { name: 'deepseek-reasoner', upstream: 'deepseek-reasoner', desc: 'DeepSeek-R1 深度思考推理大模型', checked: true },
    ]
  },
  openai: {
    id: 'openai',
    name: 'OpenAI 官方 / 标准中转',
    base_url: 'https://api.openai.com/v1',
    description: 'OpenAI 官方 API 或标准兼容中转网关',
    recommended_models: [
      { name: 'gpt-4o', upstream: 'gpt-4o', desc: 'OpenAI GPT-4o 旗舰全能大模型', checked: true },
      { name: 'gpt-4o-mini', upstream: 'gpt-4o-mini', desc: 'OpenAI GPT-4o-mini 高性价比快速模型', checked: true },
      { name: 'o3-mini', upstream: 'o3-mini', desc: 'OpenAI 最新 o3-mini 快速推理思考模型', checked: false },
      { name: 'o1', upstream: 'o1', desc: 'OpenAI o1 深度思考推理旗舰模型', checked: false },
    ]
  }
};

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
  await persistConfig();
  toast('全局策略设置已保存生效', 'ok');
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
    badge.textContent = `${cfgMeta.source || 'KV'} 同步中`;
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
      tr.innerHTML = `
        <td style="font-weight:600;"><span class="mono">${m}</span></td>
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
      strategyLabel = `${keys.length} 个 Key · 🔒 纯手动直通 (当前使用: ${activeKey})`;
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
        : `<button class="btn btn-secondary btn-sm" onclick="setActiveAgentKey('${m}', '${b.key}')" title="切换使用该 Key" style="font-size:11px;padding:2px 8px;">切</button>`;

      keysRowsHtml += `
        <div class="provider-row" style="padding:10px 16px;">
          <div style="display:flex;align-items:center;gap:10px;">
            <span class="badge badge-neutral">#${idx+1}</span>
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
          <h3>${m}</h3>
        <div class="meta mono mt-2">上游映射: ${item.upstream_model || m} · ${strategyLabel}</div>
        </div>
        <div style="display:flex;gap:8px;">
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

    const isDual = (p.toLowerCase() === 'minimax' || p.toLowerCase() === 'bai' || Boolean(prov.anthropic_base_url));
    const dualBadge = isDual ? `<span class="badge" style="background:#EEF2FF;color:#4338CA;border:1px solid #C7D2FE;font-size:11px;margin-left:6px;">OpenAI + Messages 双协议</span>` : '';
    const messagesUrlPart = (prov.anthropic_base_url && prov.anthropic_base_url !== prov.base_url) ? ` · Messages: ${prov.anthropic_base_url}` : '';

    card.innerHTML = `
      <div class="card-head">
        <div>
          <h3>${p}${dualBadge}</h3>
        <div class="meta mono mt-2">${prov.base_url || '—'}${messagesUrlPart} · ${keyLabels.length} 个 Key</div>
        </div>
        <div style="display:flex;gap:8px;">
          <button class="btn btn-primary btn-sm" onclick="openAddKeyModal('${p}')">+ 新增 Key</button>
          <button class="btn btn-danger btn-sm" onclick="deleteProvider('${p}')">删除供应商</button>
        </div>
      </div>
      <div style="background:var(--color-bg-page);">${keysListHtml || '<div class="empty">暂无 Key</div>'}</div>
    `;
    box.appendChild(card);
  }
}

function renderRawJson() {
  const ta = document.getElementById('rawJsonText');
  if (ta) ta.value = JSON.stringify(cfg, null, 2);
}

function renderAccess() {
  const origin = window.location.origin;
  document.getElementById('accBaseUrl').textContent = `${origin}/v1`;
  const models = Object.keys(cfg.agent_models || {});
  document.getElementById('accModelsList').textContent = models.join(', ') || '—';

  const pySample = `from openai import OpenAI

client = OpenAI(
    api_key="${getKey() || 'YOUR_PROXY_API_KEY'}",
    base_url="${origin}/v1"
)

response = client.chat.completions.create(
    model="${models[0] || 'glm-5.2'}",
    messages=[{"role": "user", "content": "你好，请介绍你自己。"}],
    stream=True
)

for chunk in response:
    content = chunk.choices[0].delta.content or ""
    print(content, end="", flush=True)
`;
  document.getElementById('accPy').textContent = pySample;

  const curlSample = `curl -X POST ${origin}/v1/chat/completions \\
  -H "Authorization: Bearer ${getKey() || 'YOUR_PROXY_API_KEY'}" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "${models[0] || 'glm-5.2'}",
    "messages": [{"role": "user", "content": "1+1="}],
    "stream": true
  }'`;
  document.getElementById('accCurl').textContent = curlSample;
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

// Preset Selection Handler
function onPresetSelected() {
  const presetId = document.getElementById('m_prov_preset').value;
  const nameInput = document.getElementById('m_prov_name');
  const urlInput = document.getElementById('m_prov_url');
  const descEl = document.getElementById('m_prov_desc');
  const modelsWrap = document.getElementById('m_prov_models_wrap');
  const modelsList = document.getElementById('m_prov_models_list');

  if (!presetId || !PRESET_DEFINITIONS[presetId]) {
    nameInput.value = '';
    urlInput.value = '';
    descEl.style.display = 'none';
    modelsWrap.style.display = 'none';
    modelsList.innerHTML = '';
    return;
  }

  const preset = PRESET_DEFINITIONS[presetId];
  nameInput.value = preset.id;
  urlInput.value = preset.base_url;
  descEl.textContent = preset.description || '';
  descEl.style.display = 'block';

  // Render recommended models checklist
  modelsList.innerHTML = '';
  if (preset.recommended_models && preset.recommended_models.length > 0) {
    modelsWrap.style.display = 'block';
    preset.recommended_models.forEach((rm) => {
      const row = document.createElement('div');
      row.style.marginBottom = '6px';
      row.innerHTML = `
        <label class="checkbox" style="align-items:flex-start;">
          <input type="checkbox" data-model="${rm.name}" data-upstream="${rm.upstream}" ${rm.checked ? 'checked' : ''}>
          <div style="font-size:12px;">
            <div style="font-weight:600;color:var(--color-text-1);">${rm.name} <span class="mono text-secondary" style="font-weight:normal;">(映射: ${rm.upstream})</span></div>
            <div class="text-secondary" style="font-size:11px;margin-top:2px;">${rm.desc || ''}</div>
          </div>
        </label>
      `;
      modelsList.appendChild(row);
    });
  } else {
    modelsWrap.style.display = 'none';
  }
}

function openAddProviderModal() {
  document.getElementById('providerModalTitle').textContent = '新增供应商';
  document.getElementById('presetSelectGroup').style.display = 'block';
  document.getElementById('m_prov_preset').value = '';
  document.getElementById('m_prov_name').value = '';
  document.getElementById('m_prov_name').disabled = false;
  document.getElementById('m_prov_url').value = '';
  document.getElementById('m_prov_key_label').value = 'default';
  document.getElementById('m_prov_key_val').value = '';
  document.getElementById('m_prov_init_key_wrap').style.display = 'block';
  document.getElementById('m_prov_desc').style.display = 'none';
  document.getElementById('m_prov_models_wrap').style.display = 'none';
  openModal('providerModal');
}

async function saveProviderModal() {
  const name = document.getElementById('m_prov_name').value.trim();
  const url = document.getElementById('m_prov_url').value.trim();
  if (!name || !url) { toast('请填写供应商与 Base URL', 'err'); return; }

  cfg.providers = cfg.providers || {};
  cfg.providers[name] = cfg.providers[name] || { keys: {} };
  cfg.providers[name].base_url = url;

  const presetId = document.getElementById('m_prov_preset')?.value;
  if (presetId && PRESET_DEFINITIONS[presetId]?.anthropic_base_url) {
    cfg.providers[name].anthropic_base_url = PRESET_DEFINITIONS[presetId].anthropic_base_url;
  }

  const keyLabel = document.getElementById('m_prov_key_label').value.trim() || 'default';
  const keyVal = document.getElementById('m_prov_key_val').value.trim();

  // If initial API Key provided, save it
  if (keyVal) {
    cfg.providers[name].keys = cfg.providers[name].keys || {};
    cfg.providers[name].keys[keyLabel] = keyVal;
  }

  // If recommended models were checked, auto-register / bind them
  const checkedModels = document.querySelectorAll('#m_prov_models_list input[type="checkbox"]:checked');
  if (checkedModels.length > 0) {
    cfg.agent_models = cfg.agent_models || {};
    const keyToBind = keyVal ? keyLabel : Object.keys(cfg.providers[name].keys || {})[0] || 'default';

    checkedModels.forEach((cb) => {
      const modelName = cb.dataset.model;
      const upstream = cb.dataset.upstream || modelName;

      if (!cfg.agent_models[modelName]) {
        cfg.agent_models[modelName] = {
          upstream_model: upstream,
          keys: [{ provider: name, key: keyToBind }],
        };
      } else {
        const existingKeys = cfg.agent_models[modelName].keys || [];
        if (!existingKeys.some((b) => b.provider === name && b.key === keyToBind)) {
          existingKeys.push({ provider: name, key: keyToBind });
          cfg.agent_models[modelName].keys = existingKeys;
        }
      }
    });
  }

  closeModal('providerModal');
  await persistConfig();
}

async function deleteProvider(name) {
  if (!confirm(`删除供应商「${name}」及其全部 Key？`)) return;
  delete cfg.providers[name];
  await persistConfig();
}

function openAddKeyModal(prov) {
  document.getElementById('keyModalTitle').textContent = `为 ${prov} 新增 Key`;
  document.getElementById('m_key_prov').value = prov;
  document.getElementById('m_key_old_label').value = '';
  document.getElementById('m_key_label').value = '';
  document.getElementById('m_key_val').value = '';
  openModal('keyModal');
}

function openEditKeyModal(prov, label, val) {
  document.getElementById('keyModalTitle').textContent = `编辑 ${prov} Key: ${label}`;
  document.getElementById('m_key_prov').value = prov;
  document.getElementById('m_key_old_label').value = label;
  document.getElementById('m_key_label').value = label;
  document.getElementById('m_key_val').value = val;
  openModal('keyModal');
}

async function saveKeyModal() {
  const prov = document.getElementById('m_key_prov').value;
  const oldLabel = (document.getElementById('m_key_old_label').value || '').trim();
  const label = document.getElementById('m_key_label').value.trim();
  const val = document.getElementById('m_key_val').value.trim();
  if (!label || !val) { toast('请填写 Key 别名与密钥明文', 'err'); return; }

  cfg.providers[prov] = cfg.providers[prov] || { keys: {} };
  cfg.providers[prov].keys = cfg.providers[prov].keys || {};

  if (oldLabel && oldLabel !== label) {
    if (cfg.providers[prov].keys[label] !== undefined) {
      toast(`Key 别名「${label}」已存在，请换一个别名`, 'err');
      return;
    }
    delete cfg.providers[prov].keys[oldLabel];
    // Cascade update agent_models
    if (cfg.agent_models) {
      Object.values(cfg.agent_models).forEach(m => {
        (m.keys || []).forEach(x => {
          if (x.provider === prov && x.key === oldLabel) x.key = label;
        });
      });
    }
  }

  cfg.providers[prov].keys[label] = val;

  closeModal('keyModal');
  await persistConfig();
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

  const preset = PRESETS[prov.toLowerCase()];
  if (preset && preset.models && preset.models.length > 0) {
    preset.models.forEach(m => {
      const tag = document.createElement('button');
      tag.type = 'button';
      tag.className = 'btn btn-ghost btn-sm';
      tag.style.cssText = 'font-size:11px;padding:2px 8px;height:24px;background:var(--color-bg-subtle);';
      tag.textContent = `+ 填入 ${m.id}`;
      tag.onclick = () => {
        document.getElementById('m_model_name').value = m.id;
        document.getElementById('m_upstream_model').value = m.upstream || '';
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

  cfg.agent_models = cfg.agent_models || {};
  if (oldName && oldName !== name) {
    delete cfg.agent_models[oldName];
  }
  cfg.agent_models[name] = { keys };
  if (upstream && upstream !== name) cfg.agent_models[name].upstream_model = upstream;

  closeModal('agentModal');
  await persistConfig();
}

async function removeModelKeyBinding(modelName, index) {
  if (cfg.agent_models?.[modelName]?.keys) {
    cfg.agent_models[modelName].keys.splice(index, 1);
    await persistConfig();
  }
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
  toast(`已将模型 ${modelName} 切换至 Key: [${keyLabel}]`, 'ok');
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
  try {
    const res = await api('POST', '/api/config', cfg);
    cfgMeta = res;
    renderAll();
    toast('配置已保存', 'ok');
  } catch (e) {
    toast('保存失败: ' + (e?.message || e), 'err');
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

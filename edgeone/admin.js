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
    base_url: 'https://api.stepfun.com/step_plan',
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
  if (tabId === 'state') probeEgressIp();
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
    const [cfgRes, healthRes, stateRes] = await Promise.all([
      api('GET', '/api/config'),
      api('GET', '/health').catch(() => ({})),
      api('GET', '/api/state').catch(() => ({ cooldowns: [] })),
    ]);

    cfg = cfgRes.config || cfgRes;
    cfgMeta = {
      source: cfgRes.source || 'EdgeOne KV',
      lastModified: cfgRes.last_modified,
    };
    healthData = healthRes;
    stateData = stateRes.cooldowns || [];

    renderAll();
  } catch (e) {
    console.error('Failed to load data', e);
    throw e;
  }
}

// ---- Egress IP probe -----------------------------------------------------
async function probeEgressIp() {
  const clientEl = document.getElementById('ipClient');
  const egressEl = document.getElementById('ipEgress');
  const nodeEl = document.getElementById('ipNode');
  const geoEl = document.getElementById('ipGeo');

  if (clientEl) clientEl.textContent = '探测中...';
  if (egressEl) egressEl.textContent = '探测中...';

  try {
    const data = await api('GET', '/check-ip');
    ipData = data;
    if (clientEl) clientEl.textContent = data.client_ip || '—';
    if (egressEl) egressEl.textContent = data.egress_ip || '—';
    if (nodeEl) nodeEl.textContent = data.node_uuid || '—';
    if (geoEl) geoEl.textContent = `${data.geo?.country || ''} ${data.geo?.region || ''} ${data.geo?.city || ''}`.trim() || '边缘节点网络';
  } catch (e) {
    if (clientEl) clientEl.textContent = '获取失败';
    if (egressEl) egressEl.textContent = '获取失败';
  }
}

// ---- Rendering -----------------------------------------------------------
function renderAll() {
  renderDashboard();
  renderAgentModels();
  renderProviders();
  renderStateTable();
  renderRawJson();
  renderAccess();
}

function renderDashboard() {
  const models = Object.keys(cfg.agent_models || {});
  const providers = cfg.providers || {};
  let totalKeys = 0;
  for (const p of Object.values(providers)) {
    totalKeys += Object.keys(p.keys || {}).length;
  }

  const activeCooldowns = stateData.filter(s => s.expiresAt > Date.now());

  document.getElementById('statModelCount').textContent = models.length;
  document.getElementById('statTotalKeys').textContent = totalKeys;
  document.getElementById('statCooldowns').textContent = activeCooldowns.length;

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

function renderStateTable() {
  const tbody = document.getElementById('stateTableBody');
  if (!tbody) return;
  tbody.innerHTML = '';

  if (!stateData || stateData.length === 0) {
    tbody.innerHTML = '<tr><td colspan="5" class="text-secondary" style="text-align:center;padding:24px;">无冷却记录</td></tr>';
    return;
  }

  const now = Date.now();
  for (const c of stateData) {
    const isCooling = c.expiresAt > now;
    const remainingSec = isCooling ? Math.round((c.expiresAt - now) / 1000) : 0;
    const expStr = isCooling ? `${remainingSec}s 后恢复` : '已解冻';
    const badgeHtml = isCooling
      ? `<span class="badge badge-warning">冷却中 (${c.cooldownSec || remainingSec}s)</span>`
      : `<span class="badge badge-success">正常就绪</span>`;

    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td style="font-weight:600;">${c.provider}</td>
      <td class="mono">${c.keyLabel}</td>
      <td>${badgeHtml}</td>
      <td class="mono">${c.failCount || 0} 次</td>
      <td class="mono">${expStr}</td>
    `;
    tbody.appendChild(tr);
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
    keys.forEach((b, idx) => {
      const cacheKey = `${b.provider}:${b.key}`;
      const latInfo = modelLatencyCache[cacheKey];
      let latBadge = '';
      if (latInfo) {
        latBadge = latInfo.ok
          ? `<span class="badge badge-success">${latInfo.latency_ms}ms</span>`
          : `<span class="badge badge-error">${latInfo.status}</span>`;
      }

      keysRowsHtml += `
        <div class="provider-row" style="padding:10px 16px;">
          <div style="display:flex;align-items:center;gap:10px;">
            <span class="badge badge-neutral">#${idx+1}</span>
            <span style="font-weight:600;">${b.provider}</span>
            <span class="key-chip">${b.key}</span>
            ${latBadge}
          </div>
          <div style="display:flex;gap:6px;">
            <button class="btn btn-ghost btn-sm" onclick="testSingleKey('${b.provider}', '${b.key}')">探活</button>
            <button class="btn btn-danger btn-sm" onclick="removeModelKeyBinding('${m}', ${idx})">移除</button>
          </div>
        </div>
      `;
    });

    card.innerHTML = `
      <div class="card-head">
        <div>
          <h3>${m}</h3>
        <div class="meta mono mt-2">上游映射: ${item.upstream_model || m} · ${keys.length} 个 Key</div>
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
      const cacheKey = `${p}:${k}`;
      const latInfo = modelLatencyCache[cacheKey];
      let latBadge = '';
      if (latInfo) {
        latBadge = latInfo.ok
          ? `<span class="badge badge-success">${latInfo.latency_ms}ms</span>`
          : `<span class="badge badge-error">${latInfo.status}</span>`;
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

    card.innerHTML = `
      <div class="card-head">
        <div>
          <h3>${p}</h3>
        <div class="meta mono mt-2">${prov.base_url || '—'} · ${keyLabels.length} 个 Key</div>
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

// ---- Key Test ------------------------------------------------------------
async function testSingleKey(provider, key) {
  toast(`探活 ${provider}/${key}...`, 'ok');
  try {
    const res = await api('POST', '/api/test', { provider, key });
    modelLatencyCache[`${provider}:${key}`] = res;
    renderAgentModels();
    renderProviders();
    if (res.ok) {
      toast(`${provider}/${key} 连接成功 (${res.latency_ms}ms)`, 'ok');
    } else {
      toast(`${provider}/${key} 失败 (HTTP ${res.status})`, 'err');
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
  document.getElementById('m_key_label').value = '';
  document.getElementById('m_key_val').value = '';
  openModal('keyModal');
}

function openEditKeyModal(prov, label, val) {
  document.getElementById('keyModalTitle').textContent = `编辑 ${prov} Key: ${label}`;
  document.getElementById('m_key_prov').value = prov;
  document.getElementById('m_key_label').value = label;
  document.getElementById('m_key_val').value = val;
  openModal('keyModal');
}

async function saveKeyModal() {
  const prov = document.getElementById('m_key_prov').value;
  const label = document.getElementById('m_key_label').value.trim();
  const val = document.getElementById('m_key_val').value.trim();
  if (!label || !val) { toast('请填写 Key 别名与密钥明文', 'err'); return; }

  cfg.providers[prov] = cfg.providers[prov] || { keys: {} };
  cfg.providers[prov].keys = cfg.providers[prov].keys || {};
  cfg.providers[prov].keys[label] = val;

  closeModal('keyModal');
  await persistConfig();
}

async function deleteKey(prov, label) {
  if (!confirm(`删除 Key「${label}」？`)) return;
  delete cfg.providers[prov].keys[label];
  await persistConfig();
}

function openAddModelModal() {
  document.getElementById('agentModalTitle').textContent = '新增 Agent 模型';
  document.getElementById('m_model_name').value = '';
  document.getElementById('m_model_name').disabled = false;
  document.getElementById('m_upstream_model').value = '';
  renderBindingsCheckboxes([]);
  openModal('agentModal');
}

function openEditModelModal(m) {
  document.getElementById('agentModalTitle').textContent = `编辑 Agent 模型: ${m}`;
  document.getElementById('m_model_name').value = m;
  document.getElementById('m_model_name').disabled = true;
  const item = cfg.agent_models[m] || {};
  document.getElementById('m_upstream_model').value = item.upstream_model || '';
  renderBindingsCheckboxes(item.keys || []);
  openModal('agentModal');
}

function renderBindingsCheckboxes(existingKeys = []) {
  const container = document.getElementById('m_bindings_container');
  container.innerHTML = '';
  const providers = cfg.providers || {};

  let count = 0;
  for (const [p, prov] of Object.entries(providers)) {
    for (const k of Object.keys(prov.keys || {})) {
      count++;
      const isChecked = existingKeys.some(b => b.provider === p && b.key === k);
      const div = document.createElement('div');
      div.style.marginBottom = '6px';
      div.innerHTML = `
        <label class="checkbox">
          <input type="checkbox" data-provider="${p}" data-key="${k}" ${isChecked ? 'checked' : ''}>
          <span><b>${p}</b> / ${k}</span>
        </label>
      `;
      container.appendChild(div);
    }
  }
  if (count === 0) {
    container.innerHTML = '<div class="text-secondary" style="font-size:12px;">暂无可用的 Key，请先添加供应商与 Key</div>';
  }
}

async function saveAgentModal() {
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
  cfg.agent_models[name] = { keys };
  if (upstream) cfg.agent_models[name].upstream_model = upstream;

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

// ---- Clear Cooldowns -----------------------------------------------------
async function clearAllCooldowns() {
  if (!confirm('清空全部 Key 冷却与失败计数？')) return;
  try {
    await api('DELETE', '/api/state');
    toast('冷却已清空', 'ok');
    await loadAllData();
  } catch (e) {
    toast('操作失败: ' + (e?.message || e), 'err');
  }
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

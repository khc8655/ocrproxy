/**
 * OCRProxy Admin - Core Framework & UI Foundation
 */
const IS_EDGEONE = (typeof window.__HOST_KIND__ !== 'undefined' && window.__HOST_KIND__ === 'edgeone') ||
  (typeof window.__ENV_TARGET__ !== 'undefined' && window.__ENV_TARGET__ === 'edgeone') ||
  (typeof window.HOST !== 'undefined' && Boolean(window.HOST.isEdgeOne));

// State
const state = { 
  key: sessionStorage.getItem('admin_key') || '', 
  config: null, 
  stats: null, 
  serverVersion: null,
  tab: 'dashboard', 
  modelTab: 'agents', 
  changed: false,
  probingKeys: new Set(),
  probingModels: new Set(),
  presetCatalog: [],
  cachedPresets: {},
  ruleUpdatesMap: {},
  currentSelectedPreset: null,
  vaultManifest: null
};

const tabs = [
  { id: 'dashboard', label: '概览', sub: '接入规范、实时请求统计与错误日志' },
  { id: 'providers', label: '供应商', sub: '上游 Base URL、协议、RPM 限流与密钥凭证库' },
  { id: 'models', label: '模型及路由', sub: 'Agent 模型与知识库模型路由' },
  { id: 'settings', label: '系统设置', sub: '运行参数、调度策略与配置迁移' }
];
const KB_TYPES = ['chat','embedding','reranker','ocr'];
const KB_LABELS = { chat:'Chat 对话', embedding:'Embedding 向量', reranker:'Reranker 重排', ocr:'OCR 识图' };
const KB_COLORS = { chat:'#2563eb', embedding:'#10b981', reranker:'#f59e0b', ocr:'#8b5cf6' };

const ICONS = {
  refresh: '<path d="M21 2v6h-6M3 12a9 9 0 0 1 15-6.7L21 8M3 22v-6h6M21 12a9 9 0 0 1-15 6.7L3 16"/>',
  zap: '<polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>',
  lock: '<rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
  search: '<circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>',
  chat: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
  layers: '<polygon points="12 2 2 7 12 12 22 7 12 2"/><polyline points="2 17 12 22 22 17"/><polyline points="2 12 12 17 22 12"/>',
  reranker: '<line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/>',
  image: '<rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/>',
  cloud: '<path d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z"/>',
  check: '<polyline points="20 6 9 17 4 12"/>',
  checkCircle: '<path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/>',
  xCircle: '<circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/>',
  alert: '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>',
  info: '<circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/>',
  plus: '<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>',
  trash: '<polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>',
  arrowUp: '<line x1="12" y1="19" x2="12" y2="5"/><polyline points="5 12 12 5 19 12"/>',
  copy: '<rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>',
  x: '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>'
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

function isMaskedSecret(val) {
  if (!val) return false;
  if (typeof val === 'string') {
    const s = val.trim();
    return s.includes('●') || s.includes('•') || s === '********' || s.startsWith('***');
  }
  if (typeof val === 'object') {
    const pk = val.private_key;
    if (typeof pk === 'string') {
      const s = pk.trim();
      return s.includes('●') || s.includes('•') || s === '********' || s.startsWith('***');
    }
  }
  return false;
}

function headers() { return { 'Authorization':'Bearer '+state.key, 'Content-Type':'application/json' }; }
function fmtTime(ms) {
  if (!ms) return '—';
  try {
    let num = Number(ms);
    let d;
    if (!isNaN(num) && num > 1000000000) {
      if (num < 10000000000) num *= 1000;
      d = new Date(num);
    } else {
      d = new Date(ms);
    }
    if (isNaN(d.getTime())) return '—';
    const now = new Date();
    const isToday = d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
    const pad = n => String(n).padStart(2, '0');
    const timeStr = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
    if (isToday) return timeStr;
    const dateStr = `${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    return `${dateStr} ${timeStr}`;
  } catch (_) {
    return '—';
  }
}

// Protocol and Model Helpers (Globally available to prevent script-ordering race conditions)
// ── Canonical protocol normalization (single source of truth) ──────────────
// Accepts arrays or strings in any legacy spelling ('chat', 'openai', 'openai+message',
// 'anthropic', 'OpenAI / Message', 'responses', ...) and returns canonical tokens:
// 'chat' | 'messages' | 'responses'. Every protocol label/badge/preselection in the
// admin UI goes through these two helpers so the vocabulary can never drift again.
function normalizeProtocolList(raw){
  const out = new Set();
  const parts = Array.isArray(raw) ? raw : String(raw || '').split(/[,+\s/|]+/);
  parts.forEach(item => {
    const v = String(item || '').toLowerCase().trim();
    if (!v) return;
    if (v.includes('anthropic') || v.includes('message')) out.add('messages');
    else if (v.includes('response')) out.add('responses');
    else out.add('chat');
  });
  if (!out.size) out.add('chat');
  return Array.from(out);
}

function formatProtocolLabel(raw){
  const list = normalizeProtocolList(raw);
  const parts = [];
  if (list.includes('chat')) parts.push('openai');
  if (list.includes('messages')) parts.push('message');
  if (list.includes('responses')) parts.push('responses');
  return parts.length ? parts.join('+') : 'openai';
}

function getProtocolBadge(proto){
  const p = String(proto || '').toLowerCase();
  if (p.includes('anthropic') || p.includes('messages')) {
    return `<span class="badge" style="background:rgba(217,119,6,0.15);color:#d97706;border:1px solid rgba(217,119,6,0.3);font-size:10px;padding:1px 5px;border-radius:4px;display:inline-flex;align-items:center;gap:3px;"><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>Messages</span>`;
  }
  return `<span class="badge badge-success" style="font-size:10px;padding:1px 5px;border-radius:4px;display:inline-flex;align-items:center;gap:3px;"><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M12 8v8M8 12h8"/></svg>OpenAI</span>`;
}

function getProviderProtocols(name, provObj){
  try {
    if (state.vaultManifest && Array.isArray(state.vaultManifest.providers)) {
      const vp = state.vaultManifest.providers.find(p => p.id === name || p.name === name);
      if (vp) {
        if (Array.isArray(vp.protocols) && vp.protocols.length > 0) return vp.protocols;
        if (vp.protocol === 'openai' && !vp.anthropic_messages && !vp.anthropic_base_url) return ['chat'];
        if (vp.protocol === 'anthropic' && !vp.anthropic_messages && !vp.base_url) return ['messages'];
      }
    }
    const p = provObj || (state.config && state.config.providers && state.config.providers[name]) || {};
    if (p.protocol === 'openai' && !p.anthropic_messages && !p.anthropic_base_url) return ['chat'];
    if (Array.isArray(p.protocols) && p.protocols.length > 0) return p.protocols;
    const protos = ['chat'];
    const lower = (name || '').toLowerCase();
    const clean = lower.replace(/[^a-z0-9]/g, '');
    const preset = (typeof PRESET_DEFINITIONS !== 'undefined') ? (PRESET_DEFINITIONS[clean] || PRESET_DEFINITIONS[lower]) : null;
    if (p.anthropic_messages || clean === 'minimax' || clean === 'bai' || lower === 'b.ai' || p.anthropic_base_url || (preset && preset.anthropic_base_url)) {
      protos.push('messages');
    }
    return normalizeProtocolList(protos);
  } catch (_) {
    return ['chat'];
  }
}

function renderProtocolBadges(protoList, isShort = true){
  try {
    const list = (Array.isArray(protoList) && protoList.length > 0) ? protoList : ['chat'];
    const hasAnthropic = list.some(pr => String(pr).toLowerCase().includes('anthropic') || String(pr).toLowerCase().includes('messages'));
    const hasOpenAI = list.some(pr => !String(pr).toLowerCase().includes('anthropic') && !String(pr).toLowerCase().includes('messages'));
    const badges = [];
    if (hasOpenAI || !hasAnthropic) badges.push(getProtocolBadge('openai'));
    if (hasAnthropic) badges.push(getProtocolBadge('anthropic'));
    return badges.join(' ');
  } catch (_) {
    return getProtocolBadge('openai');
  }
}

function getModelProtocols(modelName){
  try {
    const m = state.config && state.config.agent_models ? state.config.agent_models[modelName] : null;
    if (!m || !m.keys || !m.keys.length) return ['chat'];
    const set = new Set();
    for (const b of m.keys) {
      const provProtos = getProviderProtocols(b.provider);
      (provProtos || ['chat']).forEach(pr => set.add(pr));
    }
    return set.size ? Array.from(set) : ['chat'];
  } catch (_) {
    return ['chat'];
  }
}

function showLogin(){ document.getElementById('loginOverlay').style.display='flex'; document.getElementById('app').style.display='none'; }
function showApp(){ document.getElementById('loginOverlay').style.display='none'; document.getElementById('app').style.display='block'; }
function renderNav(){
  document.getElementById('topNav').innerHTML = tabs.map(t=>`<button class="${state.tab===t.id?'active':''}" onclick="switchTab('${t.id}')">${t.label}</button>`).join('');
}
function switchTab(id){
  if(id === 'agents' || id === 'agent-models') id = 'models';
  state.tab=id;
  document.querySelectorAll('.panel').forEach(p=>p.classList.remove('active'));
  const panel = document.getElementById('panel-'+id);
  if(panel) panel.classList.add('active');
  renderNav();
  render();
}
async function initAppAfterAuth(){
  showApp();
  renderNav();
  await loadData();
  if (typeof loadPresetsCatalog === 'function') loadPresetsCatalog();
  if (typeof fetchVaultManifest === 'function') fetchVaultManifest(true);
}
async function tryAutoLoginFromUrl(){
  let token = '';
  try {
    const params = new URLSearchParams(window.location.search);
    token = (params.get('token') || params.get('key') || '').trim();
  } catch (_) {}

  if (!token) return false;

  try {
    const r = await fetch('/api/admin/config', {
      headers: { 'Authorization': 'Bearer ' + token }
    });
    if (r.ok) {
      state.key = token;
      sessionStorage.setItem('admin_key', token);

      // 安全清理：无刷新抹除地址栏中的敏感 token 参数，防止历史记录或肩窥泄露
      try {
        const cleanUrl = window.location.pathname + window.location.hash;
        window.history.replaceState({}, document.title, cleanUrl);
      } catch (_) {}

      toast('免密登录成功', 'ok');
      await initAppAfterAuth();
      return true;
    } else {
      sessionStorage.removeItem('admin_key');
      state.key = '';
      showLogin();
      loginErr('URL 携带的 Token 凭据无效，请重新输入管理员密码');
    }
  } catch (e) {
    showLogin();
    loginErr('自动登录连接失败: ' + e.message);
  }
  return false;
}
async function login(){
  const k=document.getElementById('loginKey').value.trim();
  loginErr('');
  if(!k){ loginErr('请输入管理员凭证'); return; }
  try {
    const configUrl = (typeof HOST !== 'undefined' && HOST.api && HOST.api.config) ? HOST.api.config : '/api/admin/config';
    const r=await fetch(configUrl,{headers:{'Authorization':'Bearer '+k}});
    if(r.ok){
      state.key=k;
      sessionStorage.setItem('admin_key',k);
      // VM 控制台只在 sessionStorage 保存管理员密码 (关闭标签页即失效)；不再明文长期写入 localStorage
      try { localStorage.removeItem('ocrproxy_edge_token'); } catch(_) {}
      toast('登录成功','ok');
      await initAppAfterAuth();
    }
    else loginErr('凭证无效，请检查 ADMIN_PASSWORD 管理员密码');
  } catch(e){ loginErr('连接服务失败: '+e.message); }
}
function loginErr(m){ 
  const e = document.getElementById('loginErr'); 
  if (e) {
    e.textContent = m || ''; 
    e.style.display = m ? 'block' : 'none'; 
  }
}
function getClientKey(){
  const cfg = state.config || {};
  return cfg.proxy_api_key || state.key || '';
}

function logout(){ 
  sessionStorage.removeItem('admin_key'); 
  localStorage.removeItem('ocrproxy_edge_token');
  state.key=''; 
  location.reload(); 
}
function clearLoginCacheAndReload(){ 
  try {
    sessionStorage.clear();
    localStorage.clear();
  } catch(_) {}
  state.key=''; 
  location.reload(); 
}

// Data & Persistence & Vault

async function loadData(){
  try {
    let cr, sr;
    try {
      [cr, sr] = await Promise.all([
        fetch('/api/admin/config', { headers: headers() }),
        fetch('/api/admin/stats', { headers: headers() }).catch(() => null)
      ]);
    } catch (netErr) {
      toast('连接服务端失败: ' + netErr.message, 'err');
      return;
    }

    if (cr && cr.status === 401) { logout(); return; }
    if (!cr || !cr.ok) throw new Error('HTTP ' + (cr ? cr.status : 'unknown'));

    const resData = await cr.json();
    state.config = (resData && resData.config && typeof resData.config === 'object' && !resData.providers && !resData.agent_models)
      ? { ...resData.config, _version: resData._version ?? resData.config._version }
      : resData;

    // Stats defense: gracefully fallback to empty stats on serverless / 404
    if (sr && sr.ok) {
      try {
        state.stats = await sr.json();
      } catch (_) {
        state.stats = { agent: {}, candidates_status: {}, error_logs: [] };
      }
    } else {
      state.stats = { agent: {}, candidates_status: {}, error_logs: [] };
    }

    fetchVaultManifest(true); // background silent fetch
    if (!IS_EDGEONE && !state.serverVersion) {
      fetch('/api/admin/system/version', { headers: headers() })
        .then(r => r.ok ? r.json() : null)
        .then(vData => {
          if (vData && vData.current_version) {
            state.serverVersion = vData.current_version;
            const vb = document.getElementById('topVersionBadge');
            if (vb) vb.textContent = vData.current_version;
          }
        })
        .catch(() => {});
    }
    updateAccess();
    render();
  } catch(e){
    toast('加载配置失败: ' + e.message, 'err');
  }
}

let persistLock = Promise.resolve();

async function persistConfig(msg='配置已保存并立即生效'){
  const prevLock = persistLock;
  let releaseLock;
  persistLock = new Promise(resolve => { releaseLock = resolve; });
  await prevLock;

  try {
    let r = await fetch('/api/admin/config', {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify(state.config)
    });
    if (!r.ok) {
      if (r.status === 409) {
        alert('配置保存冲突拦截！\n\n检测到后端配置已被其他窗口或进程更新。为防止覆盖他人最新提交的内容，本次保存已安全拦截。\n\n系统将自动为您重新拉取最新线上配置。');
        await loadData();
        return;
      }
      const err = await r.json().catch(() => ({}));
      throw new Error(err.error || '保存配置失败');
    }
    const respData = await r.json().catch(()=>({}));
    if (respData._version !== undefined && state.config) {
      state.config._version = respData._version;
    }
    if (msg) toast(msg,'ok');
    await loadData();
  } catch(e){ 
    toast(e.message,'err'); 
  } finally {
    releaseLock();
  }
}

async function reloadRuntimeState(){
  try {
    const r=await fetch('/v1/reload',{method:'POST',headers:headers()});
    if(!r.ok) throw new Error('重载失败');
    toast('已重载配置并重置所有 Key 的冷却与熔断状态','ok');
    await loadData();
  } catch(e){ toast(e.message,'err'); }
}

// Render dispatcher
function render(){
  if(!state.config) return;

  const runMode = (state.config.run_mode || state.config._run_mode || 'agent').toLowerCase();

  // Top header badges
  const vBadge = document.getElementById('topVersionBadge');
  if (vBadge && state.serverVersion) {
    vBadge.textContent = state.serverVersion;
  }
  const badge = document.getElementById('topModeBadge');
  if (badge) {
    if (IS_EDGEONE) {
      badge.className = 'brand-badge badge badge-success';
      badge.textContent = 'EdgeOne 边缘版 (Agent 模式)';
    } else if (runMode === 'agent') {
      badge.className = 'brand-badge badge badge-success';
      badge.textContent = 'Agent 智能体直连';
    } else {
      badge.className = 'brand-badge badge badge-primary';
      badge.textContent = 'KB 知识库入库';
    }
  }
  const mtabKbSub = document.getElementById('msub-kb');
  if (mtabKbSub && IS_EDGEONE) mtabKbSub.style.display = 'none';

  // Log filter bar: in single mode (agent or kb), hide filter bar
  const lfb = document.getElementById('logFilterBar');
  if(lfb) lfb.style.display = 'none';

  // Dashboard visibility
  const sa = document.getElementById('db-section-agent');
  const sk = document.getElementById('db-section-kb');
  if(sa) sa.hidden = (runMode === 'kb');
  if(sk) sk.hidden = (runMode === 'agent');

  // Models Panel Direct View (No subtabs!)
  const isAgent = runMode === 'agent';
  const mtabAgents = document.getElementById('mtab-agents');
  const mtabKb = document.getElementById('mtab-kb');
  const panelTitle = document.getElementById('modelsPanelTitle');
  const panelDesc = document.getElementById('modelsPanelDesc');
  const primaryBtn = document.getElementById('btnPrimaryModelAction');

  if (isAgent) {
    if (panelTitle) panelTitle.textContent = 'Agent 模型管理';
    if (panelDesc) panelDesc.textContent = '对外暴露标准 OpenAI 兼容模型，按 Key 序列自动负载与 429/5xx 粘性故障转移';
    if (primaryBtn) {
      primaryBtn.innerHTML = icon('plus') + ' 新增 Agent 模型';
      primaryBtn.hidden = false;
    }
    if (mtabAgents) {
      mtabAgents.hidden = false;
      mtabAgents.classList.add('active');
    }
    if (mtabKb) {
      mtabKb.hidden = true;
      mtabKb.classList.remove('active');
    }
  } else {
    if (panelTitle) panelTitle.textContent = '知识库入库虚拟模型';
    if (panelDesc) panelDesc.textContent = '4 个入库专用聚合别名（chat / embedding / reranker / ocr），每个支持挂载多个供应商模型并发轮询';
    if (primaryBtn) {
      primaryBtn.innerHTML = icon('plus') + ' 挂载候选节点';
      primaryBtn.hidden = false;
    }
    if (mtabAgents) {
      mtabAgents.hidden = true;
      mtabAgents.classList.remove('active');
    }
    if (mtabKb) {
      mtabKb.hidden = false;
      mtabKb.classList.add('active');
    }
  }

  // Settings visibility
  const sta = document.getElementById('st-group-agent');
  const stk = document.getElementById('st-group-kb');
  if(sta) sta.hidden = (runMode === 'kb');
  if(stk) stk.hidden = (runMode === 'agent');

  const star = document.getElementById('st-item-agent-routing');
  const stkr = document.getElementById('st-item-kb-routing');
  if(star) star.hidden = (runMode === 'kb');
  if(stkr) stkr.hidden = (runMode === 'agent');

  // Access guide visibility
  const aca = document.getElementById('acc-section-agent');
  const ack = document.getElementById('acc-section-kb');
  if(aca) aca.hidden = (runMode === 'kb');
  if(ack) ack.hidden = (runMode === 'agent');

  if(state.tab==='dashboard') {
    renderDashboard();
    renderAccessPanel();
  }
  if(state.tab==='providers') renderProviders();
  if(state.tab==='models') renderModels();
  if(state.tab==='settings') {
    renderSettings();
    renderRawJsonPanel();
  }
  if(state.tab==='access') renderAccessPanel();
  if(state.tab==='raw') renderRawJsonPanel();

  if(typeof HOST !== 'undefined' && typeof HOST.applyCapabilities === 'function') {
    HOST.applyCapabilities();
  }
}

// Dashboard Log Filtering
state.logFilter = 'all';

function filterLogs(filter){
  state.logFilter = filter;
  ['all', 'agent', 'kb'].forEach(f => {
    const el = document.getElementById('lp-' + f);
    if(el) el.classList.toggle('active', f === filter);
  });
  renderLogsTable();
}

function renderLogsTable(){
  const allLogs = state.stats.error_logs || [];
  const runMode = (state.config.run_mode || state.config._run_mode || 'full').toLowerCase();
  let f = state.logFilter || 'all';
  if(runMode === 'agent') f = 'agent';
  else if(runMode === 'kb') f = 'kb';

  const filtered = (f === 'all' || runMode !== 'full')
    ? (runMode === 'agent' ? allLogs.filter(l => l.category === 'agent' || l.type === 'agent') : (runMode === 'kb' ? allLogs.filter(l => l.category !== 'agent' && l.type !== 'agent') : allLogs))
    : allLogs.filter(l => l.category === f || (f === 'kb' && l.type !== 'agent') || (f === 'agent' && l.type === 'agent'));
  const logs = filtered.slice(0, 50);
  const tbody = document.getElementById('logsBody');
  if(!tbody) return;
  if(!logs.length) {
    tbody.innerHTML = '<tr><td colspan="7" class="empty">暂无错误记录</td></tr>';
    return;
  }
  tbody.innerHTML = logs.map(l => {
    const isAg = (l.category === 'agent' || l.type === 'agent');
    const catBadge = isAg ? '<span class="badge badge-success">Agent</span>' : '<span class="badge badge-neutral">KB</span>';
    const modelTag = l.model_name || l.type || '—';
    const badge = l.status === 429 
      ? '<span class="badge badge-warn">429 限流</span>' 
      : '<span class="badge badge-error">' + l.status + '</span>';
    const repeatBadge = (l.repeat_count && l.repeat_count > 1)
      ? `<span class="badge badge-neutral" style="margin-left:5px;font-size:11px;font-weight:700;" title="最近60秒内连续折叠 ${l.repeat_count} 次">×${l.repeat_count}</span>`
      : '';
    return `<tr>
      <td class="mono">${new Date(l.timestamp).toLocaleString()}</td>
      <td>${catBadge}</td>
      <td class="mono truncate" style="max-width:180px;" title="${esc(modelTag)}"><b>${esc(modelTag)}</b></td>
      <td>${esc(l.provider)}</td>
      <td><span class="badge badge-neutral">${esc(l.key)}</span></td>
      <td>${badge}${repeatBadge}</td>
      <td class="mono" style="max-width:320px;white-space:normal;word-break:break-all;" title="${esc(l.error)}">${esc(l.error)}</td>
    </tr>`;
  }).join('');
}

// Dashboard Gateway & Available Models (Unified 3-Row Strip)
function renderDashboardGateway(){
  const base = window.location.origin + '/v1';
  const urlEl = document.getElementById('dbBaseUrl');
  if(urlEl) urlEl.textContent = base;

  const keyVal = (state.config && state.config.proxy_api_key) ? state.config.proxy_api_key : '';
  const keyEl = document.getElementById('gwClientKeyVal');
  if(keyEl) {
    keyEl.textContent = keyVal ? keyVal : '<CLIENT_KEY>';
  }

  const listContainer = document.getElementById('listAvailableModels');
  if(!listContainer) return;

  const runMode = (state.config?.run_mode || state.config?._run_mode || 'agent').toLowerCase();
  let modelsList = [];

  if(runMode === 'agent') {
    const agentModels = state.config?.agent_models || {};
    const names = Object.keys(agentModels);
    modelsList = names.map(mName => {
      const m = agentModels[mName] || {};
      const keyCount = (m.keys || []).length;
      const isAvail = keyCount > 0;
      const protos = getModelProtocols(mName);
      const protoBadges = renderProtocolBadges(protos, true);
      return `
        <span class="badge badge-neutral model-chip-clickable mono ${!isAvail ? 'disabled' : ''}" onclick="${isAvail ? `copyModelName('${esc(mName)}')` : ''}" title="${isAvail ? `点击复制模型名称: ${esc(mName)} (${keyCount} 个 Key)` : '未绑定有效 Key'}" style="display:inline-flex;align-items:center;gap:6px;padding:3px 8px;font-size:12px;cursor:${isAvail ? 'pointer' : 'default'};background:var(--bg-subtle, var(--bg-card));border:1px solid var(--border);${!isAvail ? 'opacity:0.45;border-style:dashed;' : ''}">
          <span style="font-weight:500;">${esc(mName)}</span>
          <span class="text-secondary" style="font-size:11px;">(${keyCount} Key)</span>
          <span style="display:inline-flex;gap:3px;align-items:center;">${protoBadges}</span>
        </span>
      `;
    });
  } else {
    // KB mode: 4 standard virtual model types (chat, embedding, reranker, ocr)
    const candidates = state.config?.candidates || {};
    modelsList = KB_TYPES.map(t => {
      const cList = candidates[t] || [];
      const nodeCount = cList.length;
      const isAvail = nodeCount > 0;
      const label = KB_LABELS[t] || t;

      // Extract unique protocols from mounted nodes
      const protoSet = new Set();
      cList.forEach(c => {
        const pList = getProviderProtocols(c.provider);
        pList.forEach(pr => protoSet.add(pr));
      });
      const protos = protoSet.size > 0 ? Array.from(protoSet) : ['chat'];
      const protoBadges = renderProtocolBadges(protos, true);

      if (isAvail) {
        return `
          <span class="badge badge-neutral model-chip-clickable mono" onclick="copyModelName('${esc(t)}')" title="点击复制模型名称: ${esc(t)} (${label})" style="display:inline-flex;align-items:center;gap:6px;padding:3px 8px;font-size:12px;cursor:pointer;background:var(--bg-subtle, var(--bg-card));border:1px solid var(--border);">
            <span style="font-weight:600;">${esc(t)}</span>
            <span class="text-secondary" style="font-size:11px;">(${label} · ${nodeCount} 节点)</span>
            <span style="display:inline-flex;gap:3px;align-items:center;">${protoBadges}</span>
          </span>
        `;
      } else {
        return `
          <span class="badge badge-neutral mono" title="未挂载候选节点，请前往「模型及路由」挂载" style="display:inline-flex;align-items:center;gap:6px;padding:3px 8px;font-size:12px;opacity:0.45;border:1px dashed var(--border);background:transparent;cursor:not-allowed;">
            <span style="font-weight:500;">${esc(t)}</span>
            <span class="text-secondary" style="font-size:11px;">(${label} · 未挂载)</span>
          </span>
        `;
      }
    });
  }

  if(modelsList.length === 0) {
    listContainer.innerHTML = '<span class="text-secondary" style="font-size:12px;">(暂无可用模型，请在「模型及路由」中配置)</span>';
  } else {
    listContainer.innerHTML = modelsList.join('');
  }
}

function copyText(text, successMsg) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(() => toast(successMsg || '已复制到剪贴板', 'ok')).catch(() => {
      prompt('请手动复制:', text);
    });
  } else {
    prompt('请手动复制:', text);
  }
}

function copyModelName(name) {
  copyText(name, `已复制模型名称: ${name}`);
}

function copyDbBaseUrl() {
  const base = window.location.origin + '/v1';
  copyText(base, '网关 Base URL 已复制到剪贴板');
}

function copyDbClientKey() {
  const keyVal = (state.config && state.config.proxy_api_key) ? state.config.proxy_api_key : '';
  if (!keyVal) { toast('尚未获取到有效 API Key', 'err'); return; }
  copyText(keyVal, '客户端 API Key 已复制到剪贴板');
}

function copyAllAvailableModels() {
  const runMode = (state.config?.run_mode || state.config?._run_mode || 'agent').toLowerCase();
  let models = [];
  if (runMode === 'agent') {
    models = Object.keys(state.config?.agent_models || {});
  } else {
    const candidates = state.config?.candidates || {};
    KB_TYPES.forEach(t => {
      if ((candidates[t] || []).length > 0) models.push(t);
    });
  }
  if (!models.length) {
    toast('当前暂无可用模型', 'err');
    return;
  }
  copyText(models.join(', '), '已复制全部模型名称');
}

function manageAllModels() {
  if (typeof switchTab === 'function') {
    if (document.getElementById('panel-models')) {
      switchTab('models');
    } else if (document.getElementById('panel-agents')) {
      switchTab('agents');
    }
  }
}

function fmtTokens(n){
  n = Number(n) || 0;
  if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M';
  if (n >= 1e4) return (n / 1e3).toFixed(1) + 'K';
  return String(n);
}

function fmtDurationMs(ms){
  if (ms == null || !isFinite(ms)) return '—';
  ms = Number(ms);
  if (ms < 1000) return Math.round(ms) + ' ms';
  if (ms < 60000) return (ms / 1000).toFixed(2) + ' s';
  return (ms / 60000).toFixed(1) + ' min';
}

function renderAgentSummaryCards(s){
  const tin = s.tokens_in || 0, tout = s.tokens_out || 0;
  const req = s.requests || 0, fail = s.failures || 0;
  const okReq = Math.max(0, req - fail);
  const cover = okReq ? Math.round(((s.usage_requests || 0) / okReq) * 100) : null;
  const coverTxt = cover == null ? '' : ` · 用量覆盖 <b>${cover}%</b>`;
  const failColor = fail ? (req && fail / req > 0.05 ? 'var(--error)' : '#f59e0b') : 'var(--text)';
  return `
      <div class="stat">
        <div class="stat-label">今日 Token 总量</div>
        <div class="stat-value" style="color:var(--primary);">${fmtTokens(tin + tout)}</div>
        <div class="stat-sub" title="OpenAI 流式请求只有客户端带 stream_options.include_usage 才返回用量，网关不注入">输入 <b>${fmtTokens(tin)}</b> · 输出 <b>${fmtTokens(tout)}</b>${coverTxt}</div>
      </div>
      <div class="stat">
        <div class="stat-label">平均首字延迟</div>
        <div class="stat-value">${fmtDurationMs(s.ttft_ms_avg)}</div>
        <div class="stat-sub">平均总耗时 <b>${fmtDurationMs(s.total_ms_avg)}</b></div>
      </div>
      <div class="stat">
        <div class="stat-label">失败请求</div>
        <div class="stat-value" style="color:${failColor};">${fail}</div>
        <div class="stat-sub">共 <b>${req}</b> 次 · 切 Key 救回 <b>${s.failovers || 0}</b> 次</div>
      </div>
  `;
}

function renderAgentSnapshotCards(st){
  const cs = (st && st.candidates_status) || {};
  const now = Date.now();
  // One entry per provider:key (a key may be bound to several agent models, and each
  // model has its own candidates_status row). Aggregate first, then count: otherwise a
  // key is double counted / mis-typed depending on which model row happens to exist.
  const byKey = new Map();  // provider:key -> [entry|null, ...]
  const models = (state.config && state.config.agent_models) || {};
  Object.entries(models).forEach(([mName, m]) => {
    (m.keys || []).forEach(b => {
      if (!b || !b.provider || !b.key) return;
      const id = b.provider + ':' + b.key;
      if (!byKey.has(id)) byKey.set(id, []);
      byKey.get(id).push(cs[`agent:${mName}:${b.provider}:${b.key}`] || null);
    });
  });
  let total = 0, healthy = 0, untested = 0, cooling = 0, failing = 0;
  const lats = [];
  byKey.forEach(entries => {
    total++;
    if (entries.some(e => e && e.cooldown_until && e.cooldown_until > now)) { cooling++; return; }
    const okEntries = entries.filter(e => e && e.status === 200);
    if (okEntries.length) {
      // "最近一次成功调用" for this key = latest successful row across its model bindings.
      const latest = okEntries.reduce((a, b) => ((b.time || 0) >= (a.time || 0) ? b : a));
      if (latest.latency_ms > 0) lats.push(latest.latency_ms);
      healthy++;
      return;
    }
    if (entries.some(e => e)) failing++;
    else untested++;
  });
  const avgLat = lats.length ? lats.reduce((a, b) => a + b, 0) / lats.length : null;
  const bad = cooling + failing;
  return `
      <div class="stat">
        <div class="stat-label">可用 Key</div>
        <div class="stat-value" style="color:var(--primary);">${healthy + untested}<span class="text-secondary" style="font-size:14px;font-weight:500;"> / ${total}</span></div>
        <div class="stat-sub">最近正常 <b>${healthy}</b> · 未调用 <b>${untested}</b></div>
      </div>
      <div class="stat">
        <div class="stat-label">冷却 / 故障中的 Key</div>
        <div class="stat-value" style="color:${bad ? '#f59e0b' : 'var(--text)'};">${bad}</div>
        <div class="stat-sub">冷却中 <b>${cooling}</b> · 最近失败 <b>${failing}</b></div>
      </div>
      <div class="stat">
        <div class="stat-label">最近响应耗时（平均）</div>
        <div class="stat-value">${fmtDurationMs(avgLat)}</div>
        <div class="stat-sub">按各 Key 最近一次成功调用</div>
      </div>
  `;
}

// Dashboard
function renderDashboard(){
  renderDashboardGateway();
  const st = state.stats || {};
  const ag = st.agent || { count: 0, success: 0, fallback_count: 0, '429': 0, '5xx': 0, '403': 0, '4xx': 0, models: {} };
  const kb = st.kb || { chat: st.chat||{}, embedding: st.embedding||{}, reranker: st.reranker||{}, ocr: st.ocr||{} };

  // 1. Agent Stats Grid
  //  - backend sends stats.agent.summary (VM): today's totals per request
  //    (tokens, avg first-token latency, failures) — see contract field stats.agent.summary;
  //  - no summary (EdgeOne keeps no running totals on purpose): a snapshot computed
  //    here from candidates_status (each key's last call / cooldown). Same UI on both.
  const summary = (ag && ag.summary && typeof ag.summary === 'object' && ag.summary.window) ? ag.summary : null;
  const agGrid = document.getElementById('agentStatsGrid');
  const modeBadge = document.getElementById('agentStatsMode');
  if (agGrid) {
    agGrid.innerHTML = summary ? renderAgentSummaryCards(summary) : renderAgentSnapshotCards(st);
  }
  if (modeBadge) {
    modeBadge.textContent = summary ? `今日累计 · ${summary.date || ''}` : '当前快照';
    modeBadge.title = summary
      ? '按北京时间自然日累计，0 点清零；重启服务不清零'
      : '按每个 Key 最近一次调用与冷却状态计算，不做累计';
  }

  // 2. Compact Top 3 Models Badge Strip (needs per-request totals -> summary mode only)
  const topStrip = document.getElementById('agentTopModelsStrip');
  if(topStrip) {
    const statModels = (summary && summary.models) || {};
    const modelEntries = Object.keys(statModels).map(name => {
      const m = statModels[name] || {};
      return { name, count: m.requests || 0, tokens: (m.tokens_in || 0) + (m.tokens_out || 0), ttft: m.ttft_ms_avg };
    }).filter(m => m.count > 0);
    modelEntries.sort((a, b) => b.count - a.count);
    const top3 = modelEntries.slice(0, 3);

    if (!summary) {
      topStrip.style.display = 'none';
      topStrip.innerHTML = '';
    } else if(top3.length === 0) {
      topStrip.style.display = '';
      topStrip.innerHTML = `
        <div style="display:flex;align-items:center;gap:8px;font-size:13px;color:var(--text-secondary);">
          <span style="font-weight:600;color:var(--text);">热门模型 Top 3：</span>
          <span>今天暂无调用</span>
        </div>
        <span class="badge badge-neutral">按调用量排行</span>
      `;
    } else {
      topStrip.style.display = '';
      const chips = top3.map((m, idx) => {
        const mProtos = getModelProtocols(m.name);
        const pBadges = renderProtocolBadges(mProtos, true);
        const ttft = (m.ttft != null) ? ` · 首字 ${fmtDurationMs(m.ttft)}` : '';
        return `
          <div class="model-chip" style="display:flex;align-items:center;gap:6px;">
            <span class="rank">#${idx + 1}</span>
            <span class="mono" style="font-weight:700;color:var(--text);">${esc(m.name)}</span>
            <span style="display:inline-flex;gap:4px;">${pBadges}</span>
            <span class="badge badge-primary">${m.count} 次 · ${fmtTokens(m.tokens)} Token${ttft}</span>
          </div>
        `;
      }).join('');

      topStrip.innerHTML = `
        <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;">
          <span style="font-weight:700;font-size:13px;color:var(--text);">热门模型 Top 3</span>
          <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
            ${chips}
          </div>
        </div>
        <span class="text-secondary text-sm">今天共 ${modelEntries.length} 个活跃模型</span>
      `;
    }
  }

  // 3. KB Stats Grid
  const kbGrid = document.getElementById('kbStatsGrid');
  if(kbGrid) {
    kbGrid.innerHTML = KB_TYPES.map(t => {
      const s = kb[t] || { count: 0, success: 0 };
      const rate = s.count ? ((s.success / s.count) * 100).toFixed(1) : '0.0';
      const errors = (s['429'] || 0) + (s['5xx'] || 0) + (s['403'] || 0) + (s['4xx'] || 0);
      return `<div class="stat">
        <div class="stat-label">${KB_LABELS[t]}</div>
        <div class="stat-value">${s.count || 0}</div>
        <div class="stat-sub">成功 <b>${s.success || 0}</b> · 异常 <b>${errors}</b> (成功率 <b>${rate}%</b>)</div>
      </div>`;
    }).join('');
  }

  // 4. Render Filtered Logs Table
  renderLogsTable();
}

async function resetStats(){
  if(!confirm('确定要清空所有请求统计与历史错误日志吗？')) return;
  const r=await fetch('/api/admin/stats',{method:'POST',headers:headers(),body:JSON.stringify({action:'reset'})});
  const resetData=await r.json().catch(()=>({}));
  state.stats=(resetData && resetData.stats) || resetData || {};
  toast('统计与日志已清空','ok'); renderDashboard();
}

function handlePrimaryModelAction(){
  const runMode = (state.config?.run_mode || state.config?._run_mode || 'agent').toLowerCase();
  if (runMode === 'agent') {
    openAgentModal();
  } else {
    openCandidateModal('chat');
  }
}

function switchModelTab(id){
  if (id === 'providers') {
    switchTab('providers');
    return;
  }
  state.modelTab = id;
  document.querySelectorAll('.model-subtab').forEach(m => m.classList.remove('active'));
  const target = document.getElementById('mtab-' + id);
  if (target) target.classList.add('active');

  if (id === 'agents') renderAgentModels();
  else if (id === 'kb') renderKbModels();
}

function renderModels(){
  const runMode = (state.config?.run_mode || state.config?._run_mode || 'agent').toLowerCase();
  // Agent mode locks to 'agents', KB mode locks to 'kb'
  state.modelTab = (runMode === 'kb') ? 'kb' : 'agents';
  switchModelTab(state.modelTab);
}

// Protocol Metadata & Helpers (Strict Standard: OpenAI and Anthropic linear SVG)

function updateAccess(){
  renderDashboardGateway();
}

// Backup & Import
async function exportConfig(){
  try {
    let blob, filename = `ocrproxy_config_${new Date().toISOString().slice(0,10)}.json`;
    try {
      const r = await fetch('/api/admin/config/export', { headers: headers() });
      if (r.ok) {
        const disposition = r.headers.get('Content-Disposition') || '';
        const match = disposition.match(/filename="?([^";]+)"?/);
        if(match && match[1]) filename = match[1];
        blob = await r.blob();
      }
    } catch (_) {}

    if (!blob) {
      if (!state.config) throw new Error('当前无可用配置数据');
      blob = new Blob([JSON.stringify(state.config, null, 2)], { type: 'application/json' });
    }

    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = filename; a.click(); URL.revokeObjectURL(url);
    toast('配置导出成功', 'ok');
  } catch(e){ toast('导出异常: ' + e.message, 'err'); }
}
let pendingImport=null;
function handleImportFile(e){
  const file=e.target.files[0]; if(!file)return;
  const reader=new FileReader();
  reader.onload=ev=>{
    try {
      const cfg=JSON.parse(ev.target.result);
      if(!cfg.providers||!cfg.candidates){ toast('无效配置文件：缺少 providers 或 candidates 结构','err'); return; }
      pendingImport=cfg;
      const pc=Object.keys(cfg.providers).length;
      const kc=Object.values(cfg.providers).reduce((a,p)=>a+Object.keys(p.keys||{}).length,0);
      const cc=cfg.candidates;
      const ac=Object.keys(cfg.agent_models||{}).length;
      document.getElementById('importPreview').innerHTML=`
        <div style="font-weight:700;color:var(--text);margin-bottom:6px;">待导入文件: ${esc(file.name)}</div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;color:var(--text-secondary);font-size:12px;">
          <div>供应商: <b>${pc}</b> 个</div>
          <div>API Key: <b>${kc}</b> 个</div>
          <div>Agent 模型: <b>${ac}</b> 个</div>
          <div>候选: Chat(${cc.chat?.length||0}) / Emb(${cc.embedding?.length||0}) / Rerank(${cc.reranker?.length||0}) / OCR(${cc.ocr?.length||0})</div>
        </div>
      `;
      openModal('importModal');
    } catch(err){ toast('JSON 文件解析失败，请检查文件格式','err'); }
  };
  reader.readAsText(file);
}
async function confirmImport(){
  if(!pendingImport)return;
  const mode=document.querySelector('input[name="importMode"]:checked').value;
  try {
    const r=await fetch('/api/admin/config/import',{method:'POST',headers:headers(),body:JSON.stringify({mode,config:pendingImport})});
    const d=await r.json(); if(!r.ok||!d.success) throw new Error(d.error||'导入失败');
    closeModal('importModal'); pendingImport=null; toast('配置导入成功，已自动刷新','ok'); await loadData();
  } catch(e){ toast(e.message,'err'); }
}

// Modal / Toast / Copy
let _modalZIndex = 200;
function openModal(id){
  const el = document.getElementById(id);
  if (el) {
    _modalZIndex += 10;
    el.style.zIndex = _modalZIndex;
    el.classList.add('show');
  }
  document.body.classList.add('modal-open');
}
function closeModal(id){
  const el = document.getElementById(id);
  if (el) {
    el.classList.remove('show');
    el.style.zIndex = '';
  }
  if (!document.querySelector('.modal.show')) {
    document.body.classList.remove('modal-open');
    _modalZIndex = 200;
  }
}
function toast(msg,type){
  const c=document.getElementById('toasts');
  if(!c) return;
  const t=document.createElement('div');
  const tType = type || 'info';
  t.className='toast '+tType;
  const icName = (tType==='ok'||tType==='success') ? 'checkCircle' : ((tType==='err'||tType==='danger') ? 'xCircle' : 'info');
  t.innerHTML = `<span style="display:inline-flex;align-items:center;gap:6px;">${icon(icName, 15)}<span>${esc(msg)}</span></span>`;
  c.appendChild(t); setTimeout(()=>t.classList.add('show'),10); setTimeout(()=>{t.classList.remove('show'); setTimeout(()=>t.remove(),250);},3200);
}
function copy(id){
  const text=document.getElementById(id).textContent;
  navigator.clipboard.writeText(text).then(()=>toast('已复制到剪贴板','ok')).catch(()=>toast('复制失败','err'));
}

function toggleKeyCapsule(el){
  const inp = el.querySelector('input[type="checkbox"]');
  if(!inp) return;
  inp.checked = !inp.checked;
  el.classList.toggle('checked', inp.checked);
}

// Cross-environment compatibility aliases
window.doLogin = login;
window.doLogout = logout;
window.loadAllData = loadData;
window.exportConfigJson = exportConfig;
window.ocrproxy_edge_token = function() {
  return sessionStorage.getItem('admin_key') || localStorage.getItem('ocrproxy_edge_token') || '';
};

// Raw JSON Panel Implementation
function renderRawJsonPanel() {
  const ta = document.getElementById('rawJsonText');
  if (ta && state.config) ta.value = JSON.stringify(state.config, null, 2);
}

function formatRawJson() {
  const ta = document.getElementById('rawJsonText');
  if (!ta) return;
  try {
    const parsed = JSON.parse(ta.value);
    ta.value = JSON.stringify(parsed, null, 2);
    const errEl = document.getElementById('rawJsonErr');
    if (errEl) errEl.style.display = 'none';
  } catch (e) {
    const errEl = document.getElementById('rawJsonErr');
    if (errEl) {
      errEl.textContent = 'JSON 格式错误: ' + e.message;
      errEl.style.display = 'block';
    }
  }
}

async function saveRawJson() {
  const ta = document.getElementById('rawJsonText');
  const errEl = document.getElementById('rawJsonErr');
  if (!ta) return;
  try {
    const parsed = JSON.parse(ta.value);
    if (errEl) errEl.style.display = 'none';
    state.config = parsed;
    await persistConfig('JSON 配置已更新并立即生效');
  } catch (e) {
    if (errEl) {
      errEl.textContent = 'JSON 格式解析失败: ' + e.message;
      errEl.style.display = 'block';
    }
  }
}

function triggerImportConfig() {
  const el = document.getElementById('configFileImportInput') || document.getElementById('importFile');
  if (el) el.click();
}

function renderAccessPanel() {
  // 接入与 SDK 调用示例已彻底移除
}

function copySnippet(id) {
  const el = document.getElementById(id);
  if (el && typeof copyText === 'function') copyText(el.textContent, '已复制到剪贴板');
}


// 全局彻底拦截数字输入框的鼠标滚轮微调行为，防止页面上下滚动误触修改数值
document.addEventListener('wheel', function(e) {
  if (e.target && e.target.tagName === 'INPUT' && e.target.type === 'number') {
    e.preventDefault();
    e.target.blur();
  }
  if (document.activeElement && document.activeElement.tagName === 'INPUT' && document.activeElement.type === 'number') {
    document.activeElement.blur();
  }
}, { passive: false });



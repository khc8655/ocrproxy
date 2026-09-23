
/* === Module: core.js === */
/**
 * OCRProxy Admin - Core Framework & UI Foundation
 */
const APP_VERSION = 'v2026.09.22';

// State
const state = { 
  key: sessionStorage.getItem('admin_key') || '', 
  config: null, 
  stats: null, 
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
  { id: 'models', label: '模型路由', sub: '供应商、Agent 模型与知识库模型' },
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

function headers() { return { 'Authorization':'Bearer '+state.key, 'Content-Type':'application/json' }; }
function esc(s) { if(s===null||s===undefined)return ''; return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;'); }
function fmtTime(ms) { if(!ms)return '—'; const d=Date.now()-ms; if(d<0)return '刚刚'; if(d<60000)return Math.floor(d/1000)+'s前'; if(d<3600000)return Math.floor(d/60000)+'m前'; if(d<86400000)return Math.floor(d/3600000)+'h前'; return new Date(ms).toLocaleString('zh-CN',{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'}); }

// Init
(function init(){
  renderNav();
  if(state.key) fetch('/api/admin/config',{headers:headers()}).then(r=>{ if(r.ok){ showApp(); loadData(); } else showLogin(); }).catch(showLogin);
  else showLogin();
})();

function showLogin(){ document.getElementById('loginOverlay').style.display='flex'; document.getElementById('app').style.display='none'; }
function showApp(){ document.getElementById('loginOverlay').style.display='none'; document.getElementById('app').style.display='block'; }
function renderNav(){
  document.getElementById('topNav').innerHTML = tabs.map(t=>`<button class="${state.tab===t.id?'active':''}" onclick="switchTab('${t.id}')">${t.label}</button>`).join('');
}
function switchTab(id){
  state.tab=id;
  document.querySelectorAll('.panel').forEach(p=>p.classList.remove('active'));
  document.getElementById('panel-'+id).classList.add('active');
  renderNav();
  render();
}
async function login(){
  const k=document.getElementById('loginKey').value.trim();
  loginErr('');
  if(!k){ loginErr('请输入管理员密码'); return; }
  try {
    const r=await fetch('/api/admin/config',{headers:{'Authorization':'Bearer '+k}});
    if(r.ok){ state.key=k; sessionStorage.setItem('admin_key',k); showApp(); toast('登录成功','ok'); loadData(); }
    else loginErr('密码无效，请检查配置的 ADMIN_PASSWORD');
  } catch(e){ loginErr('连接服务失败: '+e.message); }
}
function loginErr(m){ const e=document.getElementById('loginErr'); e.textContent=m; e.style.display=m?'block':'none'; }
function logout(){ sessionStorage.removeItem('admin_key'); state.key=''; location.reload(); }

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

    state.config = await cr.json();

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
    let r = await fetch('/api/admin/config',{method:'POST',headers:headers(),body:JSON.stringify(state.config)});
    if(!r.ok && r.status === 409){
      const latest = await fetch('/api/admin/config',{headers:headers()}).then(res=>res.json()).catch(()=>null);
      if(latest && latest._version !== undefined){
        state.config._version = latest._version;
        r = await fetch('/api/admin/config',{method:'POST',headers:headers(),body:JSON.stringify(state.config)});
      }
    }
    if(!r.ok){
      const err = await r.json().catch(()=>({}));
      if (r.status === 409) {
        alert('配置保存冲突：后端配置已被其他窗口或进程更新！\n\n为防止覆盖他人最新修改，系统已自动重新拉取最新线上配置，请在最新配置基础上重新操作。');
        await loadData();
        return;
      }
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
  if (vBadge) {
    vBadge.textContent = APP_VERSION;
  }
  const badge = document.getElementById('topModeBadge');
  if (badge) {
    if (runMode === 'agent') {
      badge.className = 'brand-badge badge badge-success';
      badge.textContent = 'Agent 智能体直连';
    } else {
      badge.className = 'brand-badge badge badge-primary';
      badge.textContent = 'KB 知识库入库';
    }
  }

  // Log filter bar: in single mode (agent or kb), hide filter bar
  const lfb = document.getElementById('logFilterBar');
  if(lfb) lfb.style.display = 'none';

  // Dashboard visibility
  const sa = document.getElementById('db-section-agent');
  const sk = document.getElementById('db-section-kb');
  if(sa) sa.style.display = (runMode === 'kb') ? 'none' : 'block';
  if(sk) sk.style.display = (runMode === 'agent') ? 'none' : 'block';

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
      primaryBtn.style.display = 'inline-flex';
    }
    if (mtabAgents) {
      mtabAgents.style.display = 'block';
      mtabAgents.classList.add('active');
    }
    if (mtabKb) {
      mtabKb.style.display = 'none';
      mtabKb.classList.remove('active');
    }
  } else {
    if (panelTitle) panelTitle.textContent = '知识库入库虚拟模型';
    if (panelDesc) panelDesc.textContent = '4 个入库专用聚合别名（chat / embedding / reranker / ocr），每个支持挂载多个供应商模型并发轮询';
    if (primaryBtn) {
      primaryBtn.innerHTML = icon('plus') + ' 挂载候选节点';
      primaryBtn.style.display = 'inline-flex';
    }
    if (mtabAgents) {
      mtabAgents.style.display = 'none';
      mtabAgents.classList.remove('active');
    }
    if (mtabKb) {
      mtabKb.style.display = 'block';
      mtabKb.classList.add('active');
    }
  }

  // Settings visibility
  const sta = document.getElementById('st-group-agent');
  const stk = document.getElementById('st-group-kb');
  if(sta) sta.style.display = (runMode === 'kb') ? 'none' : 'block';
  if(stk) stk.style.display = (runMode === 'agent') ? 'none' : 'block';

  const star = document.getElementById('st-item-agent-routing');
  const stkr = document.getElementById('st-item-kb-routing');
  if(star) star.style.display = (runMode === 'kb') ? 'none' : 'block';
  if(stkr) stkr.style.display = (runMode === 'agent') ? 'none' : 'block';

  // Access guide visibility
  const aca = document.getElementById('acc-section-agent');
  const ack = document.getElementById('acc-section-kb');
  if(aca) aca.style.display = (runMode === 'kb') ? 'none' : 'block';
  if(ack) ack.style.display = (runMode === 'agent') ? 'none' : 'block';

  if(state.tab==='dashboard') renderDashboard();
  if(state.tab==='providers') renderProviders();
  if(state.tab==='models') renderModels();
  if(state.tab==='settings') renderSettings();
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
    return `<tr>
      <td class="mono">${new Date(l.timestamp).toLocaleString()}</td>
      <td>${catBadge}</td>
      <td class="mono truncate" style="max-width:180px;" title="${esc(modelTag)}"><b>${esc(modelTag)}</b></td>
      <td>${esc(l.provider)}</td>
      <td><span class="badge badge-neutral">${esc(l.key)}</span></td>
      <td>${badge}</td>
      <td class="mono" style="max-width:320px;white-space:normal;word-break:break-all;" title="${esc(l.error)}">${esc(l.error)}</td>
    </tr>`;
  }).join('');
}

// Dashboard Gateway & Available Models (Compact Strip)
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
    modelsList = Object.keys(agentModels).map(mName => {
      const protos = getModelProtocols(mName);
      const protoBadges = renderProtocolBadges(protos, true);
      return `
        <span class="badge badge-neutral mono" onclick="copyModelName('${esc(mName)}')" title="点击复制模型名称: ${esc(mName)}" style="cursor:pointer; display:inline-flex; align-items:center; gap:5px; padding:2px 7px; font-size:11px;">
          <span style="font-weight:500;">${esc(mName)}</span>
          <span style="display:inline-flex; gap:3px;">${protoBadges}</span>
        </span>
      `;
    });
  } else {
    // KB mode
    const candidates = state.config?.candidates || {};
    KB_TYPES.forEach(t => {
      const cList = candidates[t] || [];
      if(cList.length > 0) {
        modelsList.push(`
          <span class="badge badge-neutral mono" onclick="copyModelName('${esc(t)}')" title="点击复制模型名称: ${esc(t)}" style="cursor:pointer; display:inline-flex; align-items:center; gap:5px; padding:2px 7px; font-size:11px;">
            <span style="font-weight:500;">${esc(t)}</span>
            <span class="badge badge-success" style="font-size:10px; padding:1px 4px;">openai</span>
          </span>
        `);
      }
    });
  }

  if(modelsList.length === 0) {
    listContainer.innerHTML = '<span class="text-secondary" style="font-size:11px;">(无可用模型)</span>';
  } else {
    listContainer.innerHTML = modelsList.join('');
  }
}

function copyDbBaseUrl(){
  const base = window.location.origin + '/v1';
  if(navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(base).then(() => toast('Base URL 已复制到剪贴板', 'ok')).catch(() => {
      prompt('请手动复制 Base URL:', base);
    });
  } else {
    prompt('请手动复制 Base URL:', base);
  }
}

function copyDbClientKey(){
  const keyVal = (state.config && state.config.proxy_api_key) ? state.config.proxy_api_key : '';
  if(!keyVal) { toast('尚未获取到有效 API Key', 'err'); return; }
  if(navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(keyVal).then(() => toast('客户端 API Key 已复制到剪贴板', 'ok')).catch(() => {
      prompt('请手动复制 Key:', keyVal);
    });
  } else {
    prompt('请手动复制 Key:', keyVal);
  }
}

// Dashboard
function renderDashboard(){
  renderDashboardGateway();
  const st = state.stats || {};
  const ag = st.agent || { count: 0, success: 0, fallback_count: 0, '429': 0, '5xx': 0, '403': 0, '4xx': 0, models: {} };
  const kb = st.kb || { chat: st.chat||{}, embedding: st.embedding||{}, reranker: st.reranker||{}, ocr: st.ocr||{} };

  // 1. Agent Stats Grid (3 Clean Cards)
  const agRate = ag.count ? ((ag.success / ag.count) * 100).toFixed(1) : '0.0';
  const agErrors = (ag['429'] || 0) + (ag['5xx'] || 0) + (ag['403'] || 0) + (ag['4xx'] || 0);

  const agGrid = document.getElementById('agentStatsGrid');
  if(agGrid) {
    agGrid.innerHTML = `
      <div class="stat">
        <div class="stat-label">Agent 对话总请求</div>
        <div class="stat-value" style="color:var(--primary);">${ag.count || 0}</div>
        <div class="stat-sub">成功 <b>${ag.success || 0}</b> · 异常 <b>${agErrors}</b></div>
      </div>
      <div class="stat">
        <div class="stat-label">请求成功率</div>
        <div class="stat-value" style="color:${Number(agRate) >= 95 ? 'var(--success)' : (Number(agRate) >= 80 ? '#f59e0b' : 'var(--error)')};">${agRate}%</div>
        <div class="stat-sub">429: <b>${ag['429'] || 0}</b> · 5xx: <b>${ag['5xx'] || 0}</b></div>
      </div>
      <div class="stat">
        <div class="stat-label">Key 故障轮换 (Failovers)</div>
        <div class="stat-value" style="color:${ag.fallback_count ? '#f59e0b' : 'var(--text)'};">${ag.fallback_count || 0}</div>
        <div class="stat-sub">429 / 5xx 自动避让切换</div>
      </div>
    `;
  }

  // 2. Compact Top 3 Models Badge Strip
  const topStrip = document.getElementById('agentTopModelsStrip');
  if(topStrip) {
    const statModels = ag.models || {};
    const modelEntries = Object.keys(statModels).map(name => {
      const m = statModels[name];
      const rate = m.count ? ((m.success / m.count) * 100).toFixed(1) : '0.0';
      return { name, count: m.count || 0, success: m.success || 0, fallback: m.fallback_count || 0, rate };
    }).filter(m => m.count > 0);

    modelEntries.sort((a, b) => b.count - a.count);
    const top3 = modelEntries.slice(0, 3);

    if(top3.length === 0) {
      topStrip.innerHTML = `
        <div style="display:flex;align-items:center;gap:8px;font-size:13px;color:var(--text-secondary);">
          <span style="font-weight:600;color:var(--text);">热门模型 Top 3：</span>
          <span>暂无实际调用记录</span>
        </div>
        <span class="badge badge-neutral">按调用量排行</span>
      `;
    } else {
      const chips = top3.map((m, idx) => {
        const pct = ag.count > 0 ? ((m.count / ag.count) * 100).toFixed(0) : '0';
        const mProtos = getModelProtocols(m.name);
        const pBadges = renderProtocolBadges(mProtos, true);
        return `
          <div class="model-chip" style="display:flex;align-items:center;gap:6px;">
            <span class="rank">#${idx + 1}</span>
            <span class="mono" style="font-weight:700;color:var(--text);">${esc(m.name)}</span>
            <span style="display:inline-flex;gap:4px;">${pBadges}</span>
            <span class="badge badge-primary">${m.count} 次 (${pct}%)</span>
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
        <span class="text-secondary text-sm">共 ${modelEntries.length} 个活跃模型</span>
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
  state.stats=await r.json(); toast('统计与日志已清空','ok'); renderDashboard();
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
  state.modelTab = id;
  document.querySelectorAll('#modelsSubTabs button').forEach(b => b.classList.remove('active'));
  const btn = document.getElementById('msub-' + id);
  if (btn) btn.classList.add('active');

  document.querySelectorAll('.model-subtab').forEach(m => m.classList.remove('active'));
  const target = document.getElementById('mtab-' + id);
  if (target) target.classList.add('active');

  if (id === 'providers') renderProviders();
  else if (id === 'agents') renderAgentModels();
  else if (id === 'kb') renderKbModels();
}

function renderModels(){
  const runMode = (state.config?.run_mode || state.config?._run_mode || 'agent').toLowerCase();
  const subTabs = document.getElementById('modelsSubTabs');
  if (subTabs) subTabs.style.display = 'none';

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
    const r=await fetch('/api/admin/config/export',{headers:headers()});
    if(!r.ok) throw new Error('导出失败');
    const disposition = r.headers.get('Content-Disposition') || '';
    let filename = 'ocrproxy_config.json';
    const match = disposition.match(/filename="?([^";]+)"?/);
    if(match && match[1]) filename = match[1];
    const blob=await r.blob(), url=URL.createObjectURL(blob);
    const a=document.createElement('a'); a.href=url; a.download=filename; a.click(); URL.revokeObjectURL(url);
    toast('配置导出成功','ok');
  } catch(e){ toast('导出异常: '+e.message,'err'); }
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
  const c=document.getElementById('toasts'); const t=document.createElement('div');
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


/* === Module: vault.js === */
/**
 * OCRProxy Admin - EdgeOne Vault Hub & Credential Sync
 */
async function fetchVaultManifest(silent = true) {
  const vaultUrl = (state.config && state.config.edgeone_vault && state.config.edgeone_vault.edgeone_url) || '';
  if (!vaultUrl) {
    state.vaultManifest = null;
    return null;
  }
  try {
    const res = await fetch('/api/admin/vault/manifest', {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({})
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok && data && data.ok) {
      state.vaultManifest = data;
      state.lastVaultError = null;
      return data;
    }
    const errMsg = data.error || (res.status === 401 ? '中枢凭据鉴权失败 (HTTP 401)' : `HTTP ${res.status}`);
    state.lastVaultError = errMsg;
    if (!silent) toast('获取 EdgeOne 中枢清单失败: ' + errMsg, 'err');
  } catch (e) {
    state.lastVaultError = e.message;
    if (!silent) toast('获取 EdgeOne 中枢清单异常: ' + e.message, 'err');
  }
  return null;
}

async function syncFromEdgeOneVault() {
  const btn = document.getElementById('btnSyncVault');
  if (btn) { btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> 同步中...'; }
  try {
    const res = await fetch('/api/admin/vault/sync', {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({})
    });
    const data = await res.json().catch(() => ({}));
    if (data && data.ok) {
      toast(`已成功从中枢同步 ${data.updated_count || 0} 个供应商规则并立即生效`, 'ok');
      await fetchVaultManifest(true);
      await loadData();
    } else {
      toast('同步失败: ' + (data?.error || `HTTP ${res.status}`), 'err');
    }
  } catch (e) {
    toast('同步中枢异常: ' + e.message, 'err');
  } finally {
    if (btn) { btn.disabled = false; btn.innerHTML = icon('refresh') + ' 同步中枢规则'; }
  }
}


// Provider & Key Helpers for Capsule Flow
function getVaultProviderList(){
  if (!state.vaultManifest || !state.vaultManifest.providers) return [];
  const p = state.vaultManifest.providers;
  if (Array.isArray(p)) return p;
  if (typeof p === 'object') {
    return Object.entries(p).map(([k, v]) => ({ id: v.id || k, ...v }));
  }
  return [];
}

function findVaultProvider(provId){
  if (!provId) return null;
  const list = getVaultProviderList();
  const low = provId.toLowerCase();
  return list.find(p => p.id === provId || (p.id && p.id.toLowerCase() === low)) || null;
}

function getAllAvailableProviders(){
  const localNames = new Set(Object.keys(state.config?.providers||{}));
  const remoteProviders = getVaultProviderList();
  const list = [];
  localNames.forEach(name => {
    const protos = getProviderProtocols(name);
    const protoStr = protos.map(pr => (PROTOCOLS[pr] ? PROTOCOLS[pr].short : pr)).join('+');
    const preset = PRESET_DEFINITIONS[name.toLowerCase()];
    const vaultProv = findVaultProvider(name);
    const label = preset?.name || vaultProv?.name || name;
    list.push({
      id: name,
      label: label,
      protoStr: protoStr,
      isVault: false,
      protocols: protos
    });
  });
  remoteProviders.forEach(rp => {
    if(!localNames.has(rp.id)){
      const protos = rp.protocols || ['chat'];
      const protoStr = protos.map(pr => (PROTOCOLS[pr] ? PROTOCOLS[pr].short : pr)).join('+');
      list.push({
        id: rp.id,
        label: rp.name || rp.id,
        protoStr: protoStr,
        isVault: true,
        protocols: protos
      });
    }
  });
  return list;
}

function toggleKeyCapsule(el){
  const inp = el.querySelector('input[type="checkbox"]');
  if(!inp) return;
  inp.checked = !inp.checked;
  el.classList.toggle('checked', inp.checked);
}

// Probed Models Selection Modal State & Logic

async function ensureKeysImported(bindings){
  const toFetch = [];
  for(const b of bindings){
    const hasLocal = state.config.providers &&
      state.config.providers[b.provider] &&
      state.config.providers[b.provider].keys &&
      state.config.providers[b.provider].keys[b.key];
    if(!hasLocal){
      toFetch.push(b);
    }
  }
  if(toFetch.length === 0) return true;

  toast(`正在从中枢拉取 ${toFetch.length} 个密钥凭据...`, 'ok');
  for(const item of toFetch){
    try {
      const res = await fetch('/api/admin/vault/fetch-key', {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({ provider: item.provider, key_label: item.key })
      });
      const d = await res.json().catch(() => ({}));
      if(!res.ok || !d.ok) {
        throw new Error(d.error || `HTTP ${res.status}`);
      }
    } catch(e) {
      toast(`从凭据中枢拉取密钥 [${item.provider}:${item.key}] 失败: ${e.message}`, 'err');
      return false;
    }
  }
  await loadData();
  return true;
}

async function refreshVaultManifestInModal() {
  toast('正在从 EdgeOne 中枢拉取最新供应商清单...', 'info');
  const d = await fetchVaultManifest(false);
  if (d) {
    const count = d.count || Object.keys(d.providers || {}).length || 0;
    const curA = document.getElementById('a_providerSelect')?.value;
    const curC = document.getElementById('c_providerSelect')?.value;
    populateAgentProviderSelect(curA);
    populateCandidateProviderSelect(curC);
    toast(`已成功同步 EdgeOne 中枢配置清单 (共 ${count} 个供应商)`, 'ok');
  } else {
    toast(`同步中枢清单失败: ${state.lastVaultError || '鉴权失败或网络不可达'}`, 'err');
  }
}

function toggleVaultTokenVisibility(){
  const el = document.getElementById('cfg_vault_token');
  if(!el) return;
  el.type = el.type === 'password' ? 'text' : 'password';
}

async function testVaultConnection(){
  const box = document.getElementById('vault_diag_box');
  const btn = document.getElementById('btnTestVault');
  const url = (document.getElementById('cfg_vault_url')?.value || '').trim();
  const token = (document.getElementById('cfg_vault_token')?.value || '').trim();

  if(box){
    box.style.display = 'block';
    box.innerHTML = `<span style="color:var(--text-secondary);display:inline-flex;align-items:center;gap:6px;">${icon('refresh', 14)} 正在探测 EdgeOne 凭据中枢 (${esc(url || '未配置地址')})...</span>`;
  }
  if(btn) btn.disabled = true;

  try {
    const res = await fetch('/api/admin/vault/test', {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({ edgeone_url: url, token: token })
    });
    const d = await res.json().catch(() => ({}));
    if(!res.ok || !d.ok){
      const errMsg = d.error || `HTTP ${res.status}: 探测失败`;
      if(box){
        box.innerHTML = `
          <div style="color:var(--accent-red);font-weight:600;margin-bottom:4px;display:flex;align-items:center;gap:6px;">
            ${icon('alert', 14)} 连通性测试未通过
          </div>
          <div style="color:var(--text-primary);font-size:12px;">${esc(errMsg)}</div>
          <div style="margin-top:6px;color:var(--text-secondary);font-size:11px;">
            排查提示：EdgeOne 中枢需在环境变量中配置 <code>PROXY_API_KEY</code>，且 VM 端填入的 Token 需与其严格一致。
          </div>`;
      }
      toast('凭据中枢连通性测试未通过: ' + errMsg, 'err');
      return;
    }

    const gKeys = (d.google_keys || []).map(k => `<span class="badge badge-neutral" style="font-family:monospace;font-size:11px;">${esc(k)}</span>`).join(' ') || '<span class="text-secondary">无</span>';
    if(box){
      box.innerHTML = `
        <div style="color:var(--accent-green);font-weight:600;margin-bottom:6px;display:flex;align-items:center;gap:6px;">
          ${icon('check', 14)} 凭据中枢连通成功 (延迟 ${d.latency_ms}ms)
        </div>
        <div style="display:grid;grid-template-columns:auto 1fr;gap:6px 12px;font-size:12px;">
          <span style="color:var(--text-secondary);">中枢地址:</span><span>${esc(d.edgeone_url)}</span>
          <span style="color:var(--text-secondary);">托管供应商:</span><span><strong>${d.providers_count}</strong> 个 (${esc((d.provider_ids || []).join(', '))})</span>
          <span style="color:var(--text-secondary);">Google Key (${d.google_keys_count} 个):</span><span>${gKeys}</span>
        </div>`;
    }
    toast(`凭据中枢连接正常，延迟 ${d.latency_ms}ms，发现 ${d.providers_count} 个供应商`, 'ok');
  } catch(e) {
    if(box){
      box.innerHTML = `
        <div style="color:var(--accent-red);font-weight:600;margin-bottom:4px;display:flex;align-items:center;gap:6px;">
          ${icon('alert', 14)} 请求异常
        </div>
        <div style="color:var(--text-primary);font-size:12px;">${esc(e.message)}</div>`;
    }
    toast('探测请求异常: ' + e.message, 'err');
  } finally {
    if(btn) btn.disabled = false;
  }
}

async function saveVaultConfig(){
  const url = (document.getElementById('cfg_vault_url')?.value || '').trim();
  const token = (document.getElementById('cfg_vault_token')?.value || '').trim();
  try {
    const res = await fetch('/api/admin/vault/config', {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({ edgeone_url: url, token: token })
    });
    const d = await res.json().catch(() => ({}));
    if(!res.ok || !d.ok){
      throw new Error(d.error || `HTTP ${res.status}`);
    }
    toast('EdgeOne 凭据中枢配置已成功保存到本地加密配置 (proxy_config.enc)', 'ok');
    await loadData();
    await fetchVaultManifest(false);
  } catch(e) {
    toast('保存中枢配置失败: ' + e.message, 'err');
  }
}



/* === Module: providers.js === */
/**
 * OCRProxy Admin - Provider Inventory, A-Z Nav Rail & Local Key Management
 */
const PROTOCOLS = {
  chat: { label: 'OpenAI Chat', short: 'OpenAI', badgeClass: 'badge-success', title: 'OpenAI 协议' },
  messages: { label: 'Anthropic Messages', short: 'Anthropic', badgeClass: 'badge-warning', title: 'Anthropic 协议' },
  responses: { label: 'OpenAI Responses', short: 'OpenAI', badgeClass: 'badge-success', title: 'OpenAI 协议' }
};

function getProtocolBadge(proto){
  const p = (proto || 'openai').toLowerCase();
  if (p.includes('anthropic') || p.includes('messages') || p.includes('claude')) {
    return `<span class="proto-badge proto-anthropic" title="Anthropic 协议"><svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><path d="M13.8 3.5l6.7 17h-3.6l-1.4-3.8h-7l-1.4 3.8H3.5l6.7-17h3.6zm-1.1 9.4L11 8.2l-1.7 4.7h3.4z"/></svg> Anthropic</span>`;
  }
  return `<span class="proto-badge proto-openai" title="OpenAI 兼容协议"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2a10 10 0 1 0 10 10A10 10 0 0 0 12 2zm0 15a5 5 0 1 1 5-5 5 5 0 0 1-5 5z"/><circle cx="12" cy="12" r="2"/></svg> OpenAI</span>`;
}

function getProviderProtocols(name, provObj){
  // 1. 若云端（Vault）中存在此提供商定义，以云端权威为准
  if (typeof findVaultProvider === 'function') {
    const vp = findVaultProvider(name);
    if (vp) {
      if (Array.isArray(vp.protocols) && vp.protocols.length > 0) {
        return vp.protocols;
      }
      if (vp.protocol === 'openai' && !vp.anthropic_messages && !vp.anthropic_base_url) {
        return ['chat'];
      }
      if (vp.protocol === 'anthropic' && !vp.anthropic_messages && !vp.base_url) {
        return ['messages'];
      }
    }
  }

  const p = provObj || (state.config && state.config.providers && state.config.providers[name]) || {};
  
  // 2. 若本地协议显式设定为 openai 且未配置 messages 混合，绝不误标为 messages
  if (p.protocol === 'openai' && !p.anthropic_messages && !p.anthropic_base_url) {
    return ['chat'];
  }
  
  if (Array.isArray(p.protocols) && p.protocols.length > 0) {
    return p.protocols;
  }
  
  const protos = ['chat'];
  const lower = (name || '').toLowerCase();
  const clean = lower.replace(/[^a-z0-9]/g, '');
  const preset = (typeof PRESET_DEFINITIONS !== 'undefined') ? (PRESET_DEFINITIONS[clean] || PRESET_DEFINITIONS[lower]) : null;
  if (p.anthropic_messages || clean === 'minimax' || clean === 'bai' || lower === 'b.ai' || p.anthropic_base_url || (preset && preset.anthropic_base_url)) {
    protos.push('messages');
  }
  return protos;
}


function renderProtocolBadges(protoList){
  const list = protoList || ['chat'];
  const hasAnthropic = list.some(pr => String(pr).toLowerCase().includes('anthropic') || String(pr).toLowerCase().includes('messages'));
  const hasOpenAI = list.some(pr => !String(pr).toLowerCase().includes('anthropic') && !String(pr).toLowerCase().includes('messages'));
  const badges = [];
  if (hasOpenAI || !hasAnthropic) badges.push(getProtocolBadge('openai'));
  if (hasAnthropic) badges.push(getProtocolBadge('anthropic'));
  return badges.join(' ');
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

function renderProviders(){
  const box = document.getElementById('providersBox');
  const rail = document.getElementById('alphabetNavRail');
  const railInner = document.getElementById('alphaRailInner');
  if (!box) return;
  box.innerHTML = '';
  const p = state.config.providers || {};
  const names = Object.keys(p).sort((a,b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));

  if (!names.length){
    box.innerHTML = '<div class="empty">暂无供应商配置，请点击右上角新增或从中枢同步</div>';
    if (rail) rail.style.display = 'none';
    return;
  }

  // 1. 按首字母构建 A-Z 分组
  const groups = {};
  names.forEach(name => {
    const initial = (name.charAt(0) || '#').toUpperCase();
    const char = /^[A-Z]$/.test(initial) ? initial : '#';
    if (!groups[char]) groups[char] = [];
    groups[char].push(name);
  });

  const sortedChars = Object.keys(groups).sort((a, b) => {
    if (a === '#') return 1;
    if (b === '#') return -1;
    return a.localeCompare(b);
  });

  // 2. 渲染右侧粘性字母索引导航轨
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
  let html = '';
  for (const ch of sortedChars) {
    const list = groups[ch];
    html += `
      <div class="alpha-divider" id="alpha-group-${ch}">
        <span class="alpha-char-badge">${ch}</span>
        <span class="alpha-divider-meta">${list.length} 家供应商</span>
        <span class="alpha-divider-line"></span>
      </div>
    `;

    for (const name of list) {
      const prov = p[name];
      const keys = Object.keys(prov.keys || {});
      const keyChips = keys.map(k => `
        <span class="key-chip">
          <b>${esc(k)}</b>
          <button class="btn-ghost" style="padding:0 2px" onclick="editKey('${esc(name)}','${esc(k)}')">编辑</button>
          <button class="btn-ghost" style="padding:0 2px;color:var(--error)" onclick="deleteKey('${esc(name)}','${esc(k)}')">×</button>
        </span>
      `).join('');

      const protos = getProviderProtocols(name, prov);
      const protoBadges = renderProtocolBadges(protos, false);
      const hasMessages = protos.includes('messages');
      let messagesUrlPart = '';
      if (hasMessages) {
        if (prov.anthropic_base_url && prov.anthropic_base_url !== prov.base_url) {
          messagesUrlPart = ` · Messages: ${esc(prov.anthropic_base_url)}`;
        } else {
          messagesUrlPart = ` · Messages: ${esc(prov.anthropic_base_url || prov.base_url)} (默认)`;
        }
      }
      const ver = prov.preset_version ? `规则 v${prov.preset_version}` : (prov.adapter_rules ? '自定义规则' : '默认');
      const verBadge = `<span class="badge badge-neutral" style="font-size:11px;padding:2px 7px;" title="适配规则版本">${esc(ver)}</span>`;
      const hasUpdate = state.ruleUpdatesMap && state.ruleUpdatesMap[name];
      const updateBtn = hasUpdate
        ? `<button class="btn btn-warning btn-sm" onclick="applySingleProviderRuleUpdate('${esc(name)}')">${icon('arrowUp')} 升级规则至 v${esc(hasUpdate.remote_version)}</button>`
        : '';

      html += `<div class="provider-row" id="provider-card-${esc(name)}">
        <div>
          <div class="provider-name" style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
            <span style="font-size:14px;font-weight:700;">${esc(name)}</span>
            <span style="display:inline-flex;gap:4px;">${protoBadges} ${verBadge}</span>
            <span class="provider-url">${esc(prov.base_url)}${messagesUrlPart}</span>
          </div>
          <div class="key-list" style="margin-top:6px;">${keyChips || '<span class="text-secondary text-sm">暂无 Key 凭证</span>'}</div>
        </div>
        <div class="flex gap-2" style="align-items:center;">
          ${updateBtn}
          <button class="btn btn-sm" onclick="editProvider('${esc(name)}')">编辑</button>
          <button class="btn btn-sm" onclick="openKeyModal('${esc(name)}')">+ Key</button>
          <button class="btn btn-danger btn-sm" onclick="deleteProvider('${esc(name)}')">删除</button>
        </div>
      </div>`;
    }
  }
  box.innerHTML = html;
}


const FALLBACK_PRESETS = {
  minimax: {
    id: 'minimax',
    name: 'MiniMax',
    version: '1.1.0',
    base_url: 'https://api.minimaxi.com/v1',
    anthropic_base_url: 'https://api.minimax.cn/anthropic',
    protocols: ['chat', 'messages'],
    description: 'MiniMax 官方开放平台，原生兼容 OpenAI Completions 与 Anthropic Messages 双协议直通。',
    recommended_models: [
      { name: 'MiniMax-M3', upstream: 'MiniMax-M3', desc: 'MiniMax-M3 旗舰多模态模型 (支持超长思考，Messages 原生兼容)', checked: true, kb_type: 'chat' }
    ]
  },
  bai: {
    id: 'bai',
    name: 'B.AI',
    version: '1.1.0',
    base_url: 'https://api.b.ai/v1',
    anthropic_base_url: 'https://api.b.ai/v1',
    protocols: ['chat', 'messages'],
    description: 'B.AI 统一大模型中转平台，原生兼容 OpenAI Chat Completions 与 Anthropic Messages 协议双通道。',
    recommended_models: [
      { name: 'deepseek-v4-flash-vision-exp', upstream: 'deepseek-v4-flash-vision-exp', desc: 'DeepSeek V4 Flash 视觉/推理增强模型', checked: true, kb_type: 'chat' },
      { name: 'qwen3.8-flash', upstream: 'qwen3.8-flash', desc: '通义千问 3.8 Flash 高速推理模型', checked: true, kb_type: 'chat' },
      { name: 'claude-3-5-sonnet', upstream: 'claude-3-5-sonnet', desc: 'Claude 3.5 Sonnet 编程模型', checked: false, kb_type: 'chat' },
      { name: 'deepseek-v3', upstream: 'deepseek-v3', desc: 'DeepSeek V3 全能大模型', checked: false, kb_type: 'chat' }
    ]
  },
  agnes: {
    id: 'agnes',
    name: 'Agnes AI',
    version: '1.2.0',
    base_url: 'https://apihub.agnes-ai.com/v1',
    protocols: ['chat'],
    description: 'Agnes AI 平台，支持 agnes-3.0-flash 等高并发轻量 Agent 模型 (512K 上下文)。',
    recommended_models: [
      { name: 'agnes-3.0-flash', upstream: 'agnes-3.0-flash', desc: 'Agnes 3.0 Flash 全新一代旗舰开源推理模型 (512K 上下文)', checked: true, kb_type: 'chat' },
      { name: 'agnes-2.5-flash', upstream: 'agnes-2.5-flash', desc: 'Agnes 2.5 Flash 旗舰高速模型 (512K 上下文)', checked: false, kb_type: 'chat' },
      { name: 'agnes-2.0-flash', upstream: 'agnes-2.0-flash', desc: 'Agnes 2.0 Flash 兼容回退模型', checked: false, kb_type: 'chat' }
    ]
  },
  google: {
    id: 'google',
    name: 'Google AI Studio',
    version: '1.1.0',
    base_url: 'https://generativelanguage.googleapis.com/v1beta/openai',
    protocols: ['chat'],
    description: 'Google 官方 Gemini 系列大模型，支持 Gemini 2.5 / 3 / 3.5+。系统已内置 Thinking Config 思考等级映射。',
    recommended_models: [
      { name: 'gemini-3.5-flash', upstream: 'gemini-3.5-flash', desc: '最新高性价比推理模型 (支持 low/medium/high 思考等级)', checked: true, kb_type: 'chat' },
      { name: 'gemini-3.5-pro', upstream: 'gemini-3.5-pro', desc: '最新旗舰强推理模型 (支持 low/high 思考等级)', checked: true, kb_type: 'chat' },
      { name: 'gemini-2.5-flash', upstream: 'gemini-2.5-flash', desc: '经典多模态快速模型', checked: false, kb_type: 'ocr' }
    ]
  },
  sensenova: {
    id: 'sensenova',
    name: 'SenseNova',
    version: '1.1.0',
    base_url: 'https://token.sensenova.cn/v1',
    protocols: ['chat'],
    description: '商汤 SenseNova 开放平台，支持 GLM-5.2、DeepSeek-V3/R1、多模态 OCR 等。',
    recommended_models: [
      { name: 'glm-5.2', upstream: 'GLM-5.2', desc: '商汤/智谱 GLM-5.2 旗舰推理大模型', checked: true, kb_type: 'chat' },
      { name: 'sensenova-6.8-flash-lite', upstream: 'sensenova-6.8-flash-lite', desc: 'SenseNova 多模态 OCR 高速识别模型', checked: false, kb_type: 'ocr' }
    ]
  },
  stepfun: {
    id: 'stepfun',
    name: 'StepFun',
    version: '1.1.0',
    base_url: 'https://api.stepfun.com/v1',
    protocols: ['chat'],
    description: '阶跃星辰 StepFun 大模型平台，系统内置 reasoning_effort none->low 降级兼容与 deepseek 思考格式注入。',
    recommended_models: [
      { name: 'step-3.7-flash', upstream: 'step-3.7-flash', desc: 'Step-3.7-Flash 闪电高速推理大模型', checked: true, kb_type: 'chat' },
      { name: 'step-2-16k', upstream: 'step-2-16k', desc: 'Step-2 旗舰大模型', checked: false, kb_type: 'chat' }
    ]
  },
  siliconflow: {
    id: 'siliconflow',
    name: 'SiliconFlow',
    version: '1.1.0',
    base_url: 'https://api.siliconflow.cn/v1',
    protocols: ['chat'],
    description: '硅基流动 SiliconFlow 高并发推理平台，包含 DeepSeek、Qwen 等开源模型及向量/重排模型。',
    recommended_models: [
      { name: 'deepseek-ai/DeepSeek-V3', upstream: 'deepseek-ai/DeepSeek-V3', desc: 'DeepSeek-V3 全尺寸旗舰模型', checked: true, kb_type: 'chat' },
      { name: 'deepseek-ai/DeepSeek-R1', upstream: 'deepseek-ai/DeepSeek-R1', desc: 'DeepSeek-R1 全尺寸深度思考模型', checked: false, kb_type: 'chat' },
      { name: 'Qwen/Qwen2.5-72B-Instruct', upstream: 'Qwen/Qwen2.5-72B-Instruct', desc: '通义千问 72B Instruct 指令模型', checked: false, kb_type: 'chat' },
      { name: 'Qwen/Qwen3-Embedding-4B', upstream: 'Qwen/Qwen3-Embedding-4B', desc: '通义千问高性能向量嵌入模型', checked: false, kb_type: 'embedding' },
      { name: 'Qwen/Qwen3-Reranker-0.6B', upstream: 'Qwen/Qwen3-Reranker-0.6B', desc: '通义千问高精度检索重排序模型', checked: false, kb_type: 'reranker' }
    ]
  },
  tokenrhythm: {
    id: 'tokenrhythm',
    name: 'TokenRhythm',
    version: '1.1.0',
    base_url: 'https://api.tokenrhythm.com/v1',
    protocols: ['chat'],
    description: 'TokenRhythm 聚合大模型路由网关，系统内置 tool_choice 对象转字符串自动清洗。',
    recommended_models: [
      { name: 'claude-3-5-sonnet-20241022', upstream: 'claude-3-5-sonnet-20241022', desc: 'Claude 3.5 Sonnet 强编程模型', checked: true, kb_type: 'chat' },
      { name: 'gpt-4o', upstream: 'gpt-4o', desc: 'OpenAI GPT-4o 旗舰全能模型', checked: false, kb_type: 'chat' }
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
      { name: 'deepseek-v4-flash', upstream: 'DeepSeek-V4-Flash', desc: 'DeepSeek V4 Flash 原生百万上下文大模型 (自动注入 reasoning_effort 开启深度思考)', checked: true, kb_type: 'chat' },
      { name: 'qwen3.8-flash-next', upstream: 'Qwen3.8-Flash-Next', desc: '千问全新 QSA 稀疏注意力大模型 (26.2万上下文，自动适配 system 消息置顶与安全思考级别)', checked: true, kb_type: 'chat' }
    ]
  }
};

const PRESET_DEFINITIONS = new Proxy({}, {
  get: (target, prop) => (state.cachedPresets && state.cachedPresets[prop]) || FALLBACK_PRESETS[prop]
});

// Custom URL Toggle Handler
function onCustomUrlToggleChange(){
  const isChecked = document.getElementById('p_custom_url_toggle').checked;
  document.getElementById('p_custom_url_section').style.display = isChecked ? 'block' : 'none';
}

async function loadPresetsCatalog() {
  const select = document.getElementById('p_preset');
  if (!select) return;
  if (!state.presetCatalog || state.presetCatalog.length === 0) {
    state.presetCatalog = Object.keys(FALLBACK_PRESETS).map(k => ({
      id: k,
      name: FALLBACK_PRESETS[k].name,
      version: FALLBACK_PRESETS[k].version || '1.1.0',
      description: FALLBACK_PRESETS[k].description
    }));
  }
  populateCatalogSelect(select);

  // Silent background sync for new remote presets without disturbing the UI
  try {
    const res = await fetch('/api/admin/presets/catalog', { headers: headers() });
    if (res.ok) {
      const data = await res.json();
      if (data && data.ok) {
        const list = (data.catalog && Array.isArray(data.catalog.providers))
          ? data.catalog.providers
          : (Array.isArray(data.providers) ? data.providers : null);
        if (list && list.length > 0) {
          state.presetCatalog = list;
          populateCatalogSelect(select);
        }
      }
    }
  } catch (e) {
    // Silent fallback
  }
}

function populateCatalogSelect(select) {
  const cur = select.value;
  const catalog = (state.presetCatalog && state.presetCatalog.length > 0)
    ? state.presetCatalog
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

// Preset Selection Handler
async function onProviderPresetChange(){
  const presetId = document.getElementById('p_preset').value;
  const nameInput = document.getElementById('p_name');
  const urlInput = document.getElementById('p_url');
  const descEl = document.getElementById('p_desc');
  const modelsWrap = document.getElementById('p_models_wrap');
  const modelsList = document.getElementById('p_models_list');

  if(!presetId){
    state.currentSelectedPreset = null;
    nameInput.value = '';
    urlInput.value = '';
    nameInput.disabled = false;
    urlInput.disabled = false;
    descEl.style.display = 'block';
    descEl.style.background = 'var(--bg-subtle)';
    descEl.style.color = 'var(--text-secondary)';
    descEl.innerHTML = `${icon('zap')} <strong>自定义模式（本地内置）</strong>：无需拉取云端规则，可直接填写任意私有部署或第三方 OpenAI / Anthropic 兼容端点。`;
    modelsWrap.style.display = 'none';
    modelsList.innerHTML = '';
    document.getElementById('p_custom_url_toggle').checked = false;
    document.getElementById('p_custom_url_section').style.display = 'none';
    document.getElementById('p_anthropic_url').value = '';
    return;
  }

  // Fetch preset detail on demand
  let preset = state.cachedPresets[presetId];
  if (!preset) {
    descEl.textContent = '正在按需拉取云端厂商规则与推荐模型...';
    descEl.style.display = 'block';
    try {
      const res = await fetch(`/api/admin/presets/detail?id=${encodeURIComponent(presetId)}`, { headers: headers() });
      if (res.ok) {
        const data = await res.json();
        if (data && data.ok && data.preset) {
          preset = data.preset;
          state.cachedPresets[presetId] = preset;
        }
      }
    } catch (e) {
      console.warn('Failed to fetch preset detail:', e);
    }
  }
  if (!preset && FALLBACK_PRESETS[presetId]) {
    preset = FALLBACK_PRESETS[presetId];
  }

  if (!preset) {
    toast(`未能获取模板「${presetId}」规则`, 'err');
    return;
  }

  state.currentSelectedPreset = preset;
  nameInput.value = preset.id;
  urlInput.value = preset.base_url;
  descEl.textContent = `${preset.description || ''} · 规则版本: v${preset.version || '1.1.0'}`;
  descEl.style.display = 'block';

  // Preset protocols sync
  const presetProtos = preset.protocols || (preset.anthropic_base_url ? ['chat', 'messages'] : ['chat']);
  document.getElementById('p_proto_chat').checked = presetProtos.includes('chat');
  document.getElementById('p_proto_messages').checked = presetProtos.includes('messages');
  document.getElementById('p_proto_responses').checked = presetProtos.includes('responses');

  // Custom Anthropic URL
  if(preset.anthropic_base_url && preset.anthropic_base_url !== preset.base_url){
    document.getElementById('p_custom_url_toggle').checked = true;
    document.getElementById('p_custom_url_section').style.display = 'block';
    document.getElementById('p_anthropic_url').value = preset.anthropic_base_url;
  } else {
    document.getElementById('p_custom_url_toggle').checked = false;
    document.getElementById('p_custom_url_section').style.display = 'none';
    document.getElementById('p_anthropic_url').value = '';
  }

  modelsList.innerHTML = '';
  const recModels = preset.recommended_models || [];
  if(recModels.length > 0){
    modelsWrap.style.display = 'block';
    recModels.forEach((rm) => {
      const row = document.createElement('div');
      row.style.marginBottom = '6px';
      row.innerHTML = `
        <label class="checkbox" style="align-items:flex-start;">
          <input type="checkbox" data-model="${esc(rm.name)}" data-upstream="${esc(rm.upstream || rm.upstream_model || rm.name)}" data-kb="${esc(rm.kb_type||'')}" ${rm.checked !== false ? 'checked' : ''}>
          <div style="font-size:12px;">
            <div style="font-weight:600;color:var(--text);">${esc(rm.name)} <span class="mono text-secondary" style="font-weight:normal;">(上游映射: ${esc(rm.upstream || rm.upstream_model || rm.name)})</span></div>
            <div class="text-secondary" style="font-size:11px;margin-top:2px;">${esc(rm.desc || rm.description || '')}</div>
          </div>
        </label>
      `;
      modelsList.appendChild(row);
    });
  } else {
    modelsWrap.style.display = 'none';
  }
}

// Key & Provider Actions
function openProviderModal(sourceModal){
  state.providerModalSource = sourceModal || null;
  state.currentSelectedPreset = null;
  document.getElementById('providerModalTitle').textContent = '新增供应商';
  document.getElementById('p_preset_wrap').style.display = 'block';
  document.getElementById('p_preset').value = '';
  onProviderPresetChange();
  document.getElementById('p_name').value = '';
  document.getElementById('p_name').disabled = false;
  document.getElementById('p_url').value = '';
  document.getElementById('p_proto_chat').checked = true;
  document.getElementById('p_proto_messages').checked = false;
  document.getElementById('p_proto_responses').checked = false;
  document.getElementById('p_custom_url_toggle').checked = false;
  document.getElementById('p_custom_url_section').style.display = 'none';
  document.getElementById('p_anthropic_url').value = '';
  document.getElementById('p_models_wrap').style.display = 'none';
  document.getElementById('p_models_list').innerHTML = '';
  loadPresetsCatalog();
  openModal('providerModal');
}

function editProvider(name){
  state.currentSelectedPreset = null;
  const p = state.config.providers[name];
  document.getElementById('providerModalTitle').textContent = '编辑供应商 - ' + name;
  document.getElementById('p_preset_wrap').style.display = 'none';
  document.getElementById('p_desc').style.display = 'none';
  document.getElementById('p_name').value = name;
  document.getElementById('p_name').disabled = true;
  document.getElementById('p_url').value = p.base_url || '';

  const protos = getProviderProtocols(name, p);
  document.getElementById('p_proto_chat').checked = protos.includes('chat');
  document.getElementById('p_proto_messages').checked = protos.includes('messages');
  document.getElementById('p_proto_responses').checked = protos.includes('responses');

  if(p.anthropic_base_url){
    document.getElementById('p_custom_url_toggle').checked = true;
    document.getElementById('p_custom_url_section').style.display = 'block';
    document.getElementById('p_anthropic_url').value = p.anthropic_base_url;
  } else {
    document.getElementById('p_custom_url_toggle').checked = false;
    document.getElementById('p_custom_url_section').style.display = 'none';
    document.getElementById('p_anthropic_url').value = '';
  }

  document.getElementById('p_models_wrap').style.display = 'none';
  openModal('providerModal');
}

function saveProvider(){
  const name = document.getElementById('p_name').value.trim();
  const url = document.getElementById('p_url').value.trim();
  if(!name || !url){ toast('供应商标识和 URL 不能为空', 'err'); return; }

  const selectedProtos = [];
  if(document.getElementById('p_proto_chat').checked) selectedProtos.push('chat');
  if(document.getElementById('p_proto_messages').checked) selectedProtos.push('messages');
  if(document.getElementById('p_proto_responses').checked) selectedProtos.push('responses');
  if(!selectedProtos.length){ toast('请至少选择一种支持的协议类型', 'err'); return; }

  const customUrlOpen = document.getElementById('p_custom_url_toggle').checked;
  const anthropicUrl = customUrlOpen ? document.getElementById('p_anthropic_url').value.trim() : '';

  const isEdit = document.getElementById('p_name').disabled;
  if(!isEdit && state.config.providers && state.config.providers[name]){ toast('供应商已存在', 'err'); return; }
  if(!state.config.providers) state.config.providers = {};

  if(isEdit) {
    state.config.providers[name].base_url = url;
    state.config.providers[name].protocols = selectedProtos;
    state.config.providers[name].anthropic_messages = selectedProtos.includes('messages');
    if(selectedProtos.includes('messages') && anthropicUrl){
      state.config.providers[name].anthropic_base_url = anthropicUrl;
    } else {
      delete state.config.providers[name].anthropic_base_url;
    }
  } else {
    state.config.providers[name] = { 
      base_url: url, 
      keys: (state.config.providers[name] && state.config.providers[name].keys) || {}, 
      protocols: selectedProtos,
      anthropic_messages: selectedProtos.includes('messages')
    };
    if(selectedProtos.includes('messages') && anthropicUrl){
      state.config.providers[name].anthropic_base_url = anthropicUrl;
    }

    // Attach preset metadata and rules if created from preset
    if(state.currentSelectedPreset && (state.currentSelectedPreset.id === name || !state.config.providers[name].preset_id)){
      state.config.providers[name].preset_id = state.currentSelectedPreset.id;
      state.config.providers[name].preset_version = state.currentSelectedPreset.version || '1.1.0';
      if(state.currentSelectedPreset.adapter_rules){
        state.config.providers[name].adapter_rules = state.currentSelectedPreset.adapter_rules;
      }
      if(state.currentSelectedPreset.recommended_models){
        state.config.providers[name].recommended_models = state.currentSelectedPreset.recommended_models;
      }
    }

    // Process optional recommended models creation
    const checkedModels = [];
    document.querySelectorAll('#p_models_list input[type="checkbox"]:checked').forEach(cb => {
      checkedModels.push({
        name: cb.dataset.model,
        upstream: cb.dataset.upstream,
        kb_type: cb.dataset.kb
      });
    });

    if(checkedModels.length > 0){
      if(!state.config.agent_models) state.config.agent_models = {};
      checkedModels.forEach(m => {
        if(!state.config.agent_models[m.name]){
          state.config.agent_models[m.name] = {
            keys: [],
            upstream_model: m.upstream
          };
        }
      });
    }
  }

  closeModal('providerModal');
  persistConfig(`供应商「${name}」已保存并立即生效`);
  renderProviders();
  renderModels();

  if (state.providerModalSource === 'agent') {
    populateAgentProviderSelect(name);
    state.providerModalSource = null;
  } else if (state.providerModalSource === 'candidate') {
    populateCandidateProviderSelect(name);
    state.providerModalSource = null;
  }
}

async function deleteProvider(name){ 
  if(!confirm('确定要删除供应商 "'+name+'" 及其名下的所有 Key 吗？本地规则与配置将一并清理。')) return; 
  delete state.config.providers[name]; 
  if(state.ruleUpdatesMap && state.ruleUpdatesMap[name]) delete state.ruleUpdatesMap[name];
  KB_TYPES.forEach(t=>{ if(state.config.candidates&&state.config.candidates[t]) state.config.candidates[t]=state.config.candidates[t].filter(x=>x.provider!==name); }); 
  if(state.config.agent_models){ 
    Object.keys(state.config.agent_models).forEach(k=>{ 
      const m=state.config.agent_models[k]; 
      m.keys=(m.keys||[]).filter(x=>x.provider!==name); 
      if(!m.keys.length) delete state.config.agent_models[k]; 
    }); 
  } 
  await persistConfig(`供应商「${name}」已删除并立即生效`);
  renderProviders();
  renderModels();
}

// Incremental Rule Updates
async function checkAllRuleUpdates(){
  const btn = document.getElementById('btnCheckRuleUpdates');
  const alertEl = document.getElementById('ruleUpdatesAlert');
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span> 检查中...';
  }

  try {
    const provs = state.config.providers || {};
    const payload = {
      providers: Object.keys(provs).map(id => ({
        id,
        version: provs[id].preset_version || '1.0.0',
        rule_hash: provs[id].rule_hash || ''
      }))
    };

    const res = await fetch('/api/admin/presets/check-updates', {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify(payload)
    });

    if (res.ok) {
      const data = await res.json();
      state.ruleUpdatesMap = {};
      if (data && data.ok && Array.isArray(data.updates) && data.updates.length > 0) {
        data.updates.forEach(u => {
          state.ruleUpdatesMap[u.provider_id] = u;
        });

        if (alertEl) {
          alertEl.style.display = 'flex';
          alertEl.innerHTML = `
            <div>
              <strong>发现 ${data.updates.length} 个供应商规则有新版本</strong>：
              ${data.updates.map(u => `<span class="badge badge-warning" style="margin-left:4px;">${esc(u.provider_id)}: ${esc(u.current_version)} &rarr; ${esc(u.remote_version)}</span>`).join('')}
            </div>
            <button class="btn btn-primary btn-sm" onclick="applyAllProviderRuleUpdates()">一键更新全部规则</button>
          `;
        }
        toast(`检查完成：发现 ${data.updates.length} 个供应商有新规则`, 'ok');
      } else {
        if (alertEl) alertEl.style.display = 'none';
        toast('所有供应商规则均为最新版本 (无需更新)', 'ok');
      }
      renderProviders();
    } else {
      toast('检查规则更新接口响应异常', 'err');
    }
  } catch (e) {
    toast(`检查规则更新失败: ${e.message}`, 'err');
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = icon('refresh') + ' 检查规则更新';
    }
  }
}

async function applySingleProviderRuleUpdate(pName){
  await applyRuleUpdates([pName]);
}

async function applyAllProviderRuleUpdates(){
  const ids = Object.keys(state.ruleUpdatesMap || {});
  if(!ids.length) return;
  await applyRuleUpdates(ids);
}

async function applyRuleUpdates(providerIds){
  try {
    toast(`正在增量拉取并更新 ${providerIds.join(', ')} 的规则...`, 'ok');
    const res = await fetch('/api/admin/presets/update-rules', {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({ provider_ids: providerIds })
    });

    if (res.ok) {
      const data = await res.json();
      if (data && data.ok && Array.isArray(data.updated) && data.updated.length > 0) {
        // Re-fetch config to sync state
        const cr = await fetch('/api/admin/config', { headers: headers() });
        if (cr.ok) state.config = await cr.json();

        providerIds.forEach(id => {
          if (state.ruleUpdatesMap) delete state.ruleUpdatesMap[id];
        });
        const alertEl = document.getElementById('ruleUpdatesAlert');
        if (alertEl && Object.keys(state.ruleUpdatesMap || {}).length === 0) {
          alertEl.style.display = 'none';
        }
        toast(`成功更新 ${data.updated.length} 个供应商的规则并已自动生效！`, 'ok');
        renderProviders();
      } else {
        toast(data?.message || '规则更新失败或无变更', 'err');
      }
    } else {
      toast('更新规则请求失败', 'err');
    }
  } catch (e) {
    toast(`更新规则失败: ${e.message}`, 'err');
  }
}

let _onKeySavedCallback = null;

function openKeyModal(prov, onSavedCallback){ 
  _onKeySavedCallback = onSavedCallback || null;
  document.getElementById('keyModalTitle').textContent='新增 Key 凭证 - '+prov; 
  document.getElementById('k_provider').value=prov; 
  document.getElementById('k_oldLabel').value=''; 
  document.getElementById('k_label').value=''; 
  document.getElementById('k_label').disabled=false; 
  document.getElementById('k_value').value=''; 
  document.getElementById('k_skip').checked=false; 
  const diagBox = document.getElementById('k_diag_box');
  if(diagBox) { diagBox.style.display='none'; diagBox.innerHTML=''; }
  const hintEl = document.getElementById('k_proto_hint');
  if(hintEl) {
    const protos = getProviderProtocols(prov);
    hintEl.innerHTML = `<div style="display:flex;align-items:center;justify-content:space-between;"><span>所属供应商: <b>${esc(prov)}</b></span><span>需校验协议: ${renderProtocolBadges(protos)}</span></div>`;
  }
  openModal('keyModal'); 
}
function editKey(prov,label){ 
  const p=state.config.providers[prov]||{}; 
  document.getElementById('keyModalTitle').textContent='编辑 Key 凭证 - '+prov; 
  document.getElementById('k_provider').value=prov; 
  document.getElementById('k_oldLabel').value=label; 
  document.getElementById('k_label').value=label; 
  document.getElementById('k_label').disabled=false; 
  document.getElementById('k_value').value=(p.keys&&p.keys[label])||''; 
  document.getElementById('k_skip').checked=true; 
  const diagBox = document.getElementById('k_diag_box');
  if(diagBox) { diagBox.style.display='none'; diagBox.innerHTML=''; }
  const hintEl = document.getElementById('k_proto_hint');
  if(hintEl) {
    const protos = getProviderProtocols(prov);
    hintEl.innerHTML = `<div style="display:flex;align-items:center;justify-content:space-between;"><span>所属供应商: <b>${esc(prov)}</b></span><span>需校验协议: ${renderProtocolBadges(protos)}</span></div>`;
  }
  openModal('keyModal'); 
}
async function deleteKey(prov,label){ 
  if(!confirm('确定要删除 Key "'+label+'" 吗？')) return; 
  if(state.config.providers&&state.config.providers[prov]&&state.config.providers[prov].keys) {
    delete state.config.providers[prov].keys[label]; 
  }
  KB_TYPES.forEach(t=>{ if(state.config.candidates&&state.config.candidates[t]) state.config.candidates[t]=state.config.candidates[t].filter(x=>!(x.provider===prov&&x.key===label)); }); 
  if(state.config.agent_models) Object.values(state.config.agent_models).forEach(m=>{ m.keys=(m.keys||[]).filter(x=>!(x.provider===prov&&x.key===label)); }); 
  await persistConfig(`Key「${label}」已删除并立即生效`);
  renderProviders();
  renderModels();
}
async function saveKey(){
  const prov=document.getElementById('k_provider').value;
  const oldLabel=(document.getElementById('k_oldLabel').value||'').trim();
  const label=document.getElementById('k_label').value.trim();
  const val=document.getElementById('k_value').value.trim();
  const skip=document.getElementById('k_skip').checked;
  const diagBox=document.getElementById('k_diag_box');
  if(diagBox) { diagBox.style.display='none'; diagBox.innerHTML=''; }

  if(!label||!val){ toast('Key 别名和密钥值不能为空','err'); return; }

  // If renaming an existing key and new label conflicts with another existing key
  if(label !== oldLabel && state.config.providers && state.config.providers[prov] && state.config.providers[prov].keys && state.config.providers[prov].keys[label] !== undefined){
    toast('Key 别名「'+label+'」已存在，请换一个别名','err'); 
    return; 
  }

  if(skip){ commitKey(prov,label,val); return; }

  const pObj = (state.config.providers && state.config.providers[prov]) || {};
  const protos = getProviderProtocols(prov, pObj);

  document.getElementById('k_spinner').style.display='block';
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    const r = await fetch('/api/admin/verify-key', {
      method: 'POST',
      headers: headers(),
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

    if(d.valid){
      const latList = [];
      for(const pr of protos){
        const res = (d.protocols && d.protocols[pr]);
        if(res && res.latency_ms) latList.push(`${PROTOCOLS[pr]?.short || pr} ${res.latency_ms}ms`);
      }
      toast(`Key 校验全部通过 (${latList.join(' / ') || '成功'})`, 'ok');
      commitKey(prov,label,val);
    } else {
      // Scheme A: strict block with detailed per-protocol diagnostics
      if(diagBox){
        let html = `<div style="font-weight:700;margin-bottom:8px;color:var(--danger);display:flex;align-items:center;gap:6px;">${icon('alert', 16)} 协议连通性未完全通过 (已阻止保存)</div>`;
        html += '<div style="display:flex;flex-direction:column;gap:6px;font-size:12px;">';
        for(const pr of protos){
          const res = (d.protocols && d.protocols[pr]) || { valid: false, error: '未测试' };
          const pName = PROTOCOLS[pr] ? PROTOCOLS[pr].label : pr;
          if(res.valid){
            html += `<div style="display:flex;align-items:center;gap:6px;color:var(--success);">${icon('checkCircle', 14)} <b>${esc(pName)}</b>: 验证通过 (${res.latency_ms || 0}ms)</div>`;
          } else {
            html += `<div style="display:flex;align-items:flex-start;gap:6px;color:var(--danger);">${icon('xCircle', 14)} <div><b>${esc(pName)}</b>: 验证失败 (${esc(res.error || '请求未通')})</div></div>`;
          }
        }
        html += '</div>';
        html += '<div class="text-secondary mt-2" style="font-size:11px;border-top:1px solid var(--border);padding-top:6px;">提示：请核对并修改密钥；若确属离线/受限网络，请勾选上方「跳过连通性在线校验」后重新点击保存。</div>';
        diagBox.innerHTML = html;
        diagBox.style.display = 'block';
      }
      toast('协议校验存在失败项，已阻止保存', 'err');
    }
  } catch(e){ 
    if(diagBox){
      diagBox.innerHTML = `<div style="display:flex;align-items:center;gap:6px;color:var(--danger);font-size:12px;">${icon('xCircle', 14)} 验证请求失败: ${esc(e.message)}。<br>如网络受限，可勾选上方「跳过连通性在线校验」后强制保存。</div>`;
      diagBox.style.display = 'block';
    }
    toast('网络请求异常: ' + e.message, 'err');
  } finally {
    document.getElementById('k_spinner').style.display='none';
  }
}
function commitKey(prov,label,val){ 
  const oldLabel=(document.getElementById('k_oldLabel').value||'').trim();
  if(!state.config.providers) state.config.providers={};
  if(!state.config.providers[prov]) {
    const vaultProv = findVaultProvider(prov);
    const preset = PRESET_DEFINITIONS[prov.toLowerCase()];
    state.config.providers[prov] = {
      name: preset?.name || vaultProv?.name || prov,
      base_url: vaultProv?.base_url || preset?.base_url || '',
      protocol: vaultProv?.protocol || preset?.protocol || 'openai',
      keys: {}
    };
    if (vaultProv?.adapter_rules || preset?.adapter_rules) {
      state.config.providers[prov].adapter_rules = vaultProv?.adapter_rules || preset?.adapter_rules;
    }
  }
  if(!state.config.providers[prov].keys) state.config.providers[prov].keys={};

  // If key renamed, delete old key and cascade rename in agent_models and candidates
  if(oldLabel && oldLabel !== label){
    delete state.config.providers[prov].keys[oldLabel];
    // Cascade update agent_models
    if(state.config.agent_models){
      Object.values(state.config.agent_models).forEach(m=>{
        (m.keys||[]).forEach(x=>{
          if(x.provider===prov && x.key===oldLabel) x.key = label;
        });
      });
    }
    // Cascade update candidates (KB)
    if(state.config.candidates){
      Object.values(state.config.candidates).forEach(list=>{
        (list||[]).forEach(x=>{
          if(x.provider===prov && x.key===oldLabel) x.key = label;
        });
      });
    }
  }

  state.config.providers[prov].keys[label]=val; 
  closeModal('keyModal'); 
  persistConfig(oldLabel && oldLabel !== label ? `Key 别名已从「${oldLabel}」更新为「${label}」并级联同步至关联模型` : `Key「${label}」已保存并立即生效`); 
  renderModels(); 

  if (typeof _onKeySavedCallback === 'function') {
    const cb = _onKeySavedCallback;
    _onKeySavedCallback = null;
    cb(prov, label);
  }
}

function openKeyModalFromAgentModal(){
  const prov = document.getElementById('a_provider')?.value;
  if (!prov) {
    toast('请先在上方选择一个有效提供商', 'err');
    return;
  }
  openKeyModal(prov, () => {
    renderAgentKeyChecks();
  });
}

function openKeyModalFromCandidateModal(){
  const prov = document.getElementById('c_provider')?.value;
  if (!prov) {
    toast('请先在上方选择一个有效提供商', 'err');
    return;
  }
  openKeyModal(prov, () => {
    renderCandidateKeyChecks();
  });
}



/* === Module: models.js === */
/**
 * OCRProxy Admin - Agent Models, Candidate Routing & Protocol Adapter
 */
function getModelProtocols(modelName){
  const m = state.config && state.config.agent_models ? state.config.agent_models[modelName] : null;
  if (!m || !m.keys || !m.keys.length) return ['chat'];
  const set = new Set();
  for (const b of m.keys) {
    const provProtos = getProviderProtocols(b.provider);
    provProtos.forEach(pr => set.add(pr));
  }
  return set.size ? Array.from(set) : ['chat'];
}


function renderAgentModels(){
  const box=document.getElementById('agentModelsBox');
  const models=state.config.agent_models||{};
  const names=Object.keys(models);
  if(!names.length){ box.innerHTML='<div class="hint-box">尚未配置 Agent 模型。点击右上角添加您的第一个模型。</div>'; return; }
  const status=state.stats.candidates_status||{};
  const strategy = state.config.agent_routing_strategy || 'sticky_failover';
  
  box.innerHTML=names.map(name=>{
    const m=models[name]; const upstream=m.upstream_model||name;
    const isProbingAll = state.probingModels.has(name);
    const activeKey = m.active_key || ((m.keys && m.keys[0]) ? m.keys[0].key : '');
    const modelProtos = getModelProtocols(name);
    const protoBadges = renderProtocolBadges(modelProtos, true);
    
    let strategyLabel = `${(m.keys||[]).length} 个 Key · 粘性故障转移 (固定当前，遇错顺延)`;
    if(strategy === 'manual'){
      strategyLabel = `${(m.keys||[]).length} 个 Key · 纯手动直通 (当前使用: ${esc(activeKey)})`;
    } else if(strategy === 'round_robin'){
      strategyLabel = `${(m.keys||[]).length} 个 Key · 轮询负载均衡 (依次轮流)`;
    } else if(strategy === 'priority_fallback'){
      strategyLabel = `${(m.keys||[]).length} 个 Key · 主备优先级降级 (首选降级)`;
    } else if(strategy === 'latency_based'){
      strategyLabel = `${(m.keys||[]).length} 个 Key · 最低延迟优先`;
    }

    const rows=(m.keys||[]).map((b,i)=>renderBindingRow(i+1,b,null,name,i,status,true));
    return `<div class="card model-card">
      <div class="card-head">
        <div>
          <div class="model-id" style="font-size:14px;font-weight:700;display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
            <span>${esc(name)}</span>
            ${upstream!==name?`<span class="badge badge-neutral" style="font-weight:400;">上游 ID: ${esc(upstream)}</span>`:''}
            <span style="display:inline-flex;gap:4px;">${protoBadges}</span>
          </div>
          <div class="meta" style="margin-top:2px;">${strategyLabel}</div>
        </div>
        <div class="flex gap-2" style="flex-wrap:wrap;">
          <button class="btn btn-secondary btn-sm" id="probeAllBtn-${esc(name)}" onclick="testAgentModelAll('${esc(name)}')" ${isProbingAll?'disabled':''}>
            ${isProbingAll ? '<span class="spinner"></span> 探测中...' : '全部探活'}
          </button>
          <button class="btn btn-secondary btn-sm" onclick="editAgentModel('${esc(name)}')">编辑</button>
          <button class="btn btn-secondary-danger btn-sm" onclick="deleteAgentModel('${esc(name)}')">删除</button>
        </div>
      </div>
      <div class="table-wrap">
        <table>
          <thead><tr><th>#</th><th>供应商</th><th>Key 别名</th><th>响应耗时 / 状态</th><th>最近调用</th><th style="text-align:right">操作</th></tr></thead>
          <tbody>${rows.length ? rows.join('') : '<tr><td colspan="6" class="empty">暂无绑定 Key</td></tr>'}</tbody>
        </table>
      </div>
      <div id="liveTestRes-${esc(name)}" style="display:none;padding:12px 18px;border-top:1px solid var(--border-subtle);background:var(--bg-subtle);font-size:12px;"></div>
      <div id="agentProbe-${esc(name)}" style="display:none;padding:12px 18px;border-top:1px solid var(--border-subtle);background:var(--bg-subtle);font-size:12px;"></div>
    </div>`;
  }).join('');
}

function renderKbModels(){
  const box=document.getElementById('kbModelsBox');
  const status=state.stats.candidates_status||{};
  box.innerHTML=KB_TYPES.map(type=>{
    const list=(state.config.candidates||{})[type]||[];
    const rows=list.map((c,i)=>renderBindingRow(i+1,c,type,null,i,status,false));
    return `<div class="card model-card">
      <div class="card-head">
        <div>
          <div class="model-id" style="font-size:14px;font-weight:700;">${KB_LABELS[type]} <span class="badge badge-neutral" style="font-weight:400;margin-left:6px;">model="${type}"</span></div>
          <div class="meta" style="margin-top:2px;">${list.length} 个挂载候选节点 · 按序故障切换</div>
        </div>
        <button class="btn btn-sm" onclick="openCandidateModal('${type}')">+ 挂载节点</button>
      </div>
      <div class="table-wrap">
        <table>
          <thead><tr><th>#</th><th>供应商</th><th>Key 别名</th><th>上游实际模型 ID</th><th>响应耗时 / 状态</th><th>最近调用</th><th style="text-align:right">操作</th></tr></thead>
          <tbody>${rows.length ? rows.join('') : '<tr><td colspan="7" class="empty">暂无候选节点</td></tr>'}</tbody>
        </table>
      </div>
    </div>`;
  }).join('');
}

function renderBindingRow(idx, binding, type, modelName, i, status, isAgent){
  const nk = isAgent
    ? ('agent:' + modelName + ':' + binding.provider + ':' + binding.key)
    : ('kb:' + type + ':' + binding.provider + ':' + binding.key + (binding.model ? (':' + binding.model) : ''));
  const ns = status[nk] || (isAgent ? status[binding.provider + ':' + binding.key + ':agent:' + modelName] : (status['kb:' + type + ':' + binding.provider + ':' + binding.key] || status[binding.provider + ':' + binding.key + ':' + type]));
  let badge = '<span class="badge badge-neutral">未调用</span>', time = '—';
  if(ns){ 
    if(ns.is_quota || ns.status === 'quota'){
      badge = `<span class="badge badge-error" style="font-weight:700;">欠费</span>`;
    } else if(ns.status === 429) {
      badge = `<span class="badge badge-warn" style="font-weight:700;">429 限流</span>`;
    } else if(ns.status === 200){
      if(ns.latency_ms !== null && ns.latency_ms !== undefined && ns.latency_ms > 0){
        const latStr = ns.latency_ms >= 1000 ? (ns.latency_ms / 1000).toFixed(2) + 's' : ns.latency_ms + 'ms';
        badge = `<span class="badge badge-success" title="最近响应耗时: ${ns.latency_ms}ms" style="font-weight:700;">${latStr}</span>`;
      } else {
        badge = `<span class="badge badge-success" style="font-weight:700;">正常</span>`;
      }
    } else {
      badge = `<span class="badge badge-error">${ns.status} 异常</span>`;
    }
    time = fmtTime(ns.time); 
  }
  const modelCell = isAgent ? '' : `<td class="mono truncate" title="${esc(binding.model)}"><b>${esc(binding.model)}</b></td>`;
  
  const probeKeyId = (isAgent ? 'agent:' + modelName : ('kb:' + type + (binding.model ? ':' + binding.model : ''))) + ':' + binding.provider + ':' + binding.key;
  const isProbing = state.probingKeys.has(probeKeyId);

  const keyBadgeHtml = `<span class="badge badge-neutral">${esc(binding.key)}</span>`;
  const totalCount = isAgent
    ? (state.config.agent_models?.[modelName]?.keys || []).length
    : ((state.config.candidates || {})[type] || []).length;

  const orderInputHtml = isAgent
    ? `<input type="number" min="1" max="${totalCount}" value="${idx}" 
        style="width:38px;height:22px;text-align:center;font-size:12px;font-weight:700;padding:0;border:1px solid #d0d7de;border-radius:4px;"
        onchange="reorderAgentKey('${esc(modelName)}', ${i}, this.value)" title="修改数字直接调整顺序">`
    : `<input type="number" min="1" max="${totalCount}" value="${idx}" 
        style="width:38px;height:22px;text-align:center;font-size:12px;font-weight:700;padding:0;border:1px solid #d0d7de;border-radius:4px;"
        onchange="reorderCandidate('${type}', ${i}, this.value)" title="修改数字直接调整顺序">`;

  let actions;
  if(isAgent){
    const list = state.config.agent_models[modelName]?.keys || [];
    const runtimeActiveKey = (state.stats && state.stats.agent && state.stats.agent.active_keys) ? state.stats.agent.active_keys[modelName] : null;
    const activeKey = runtimeActiveKey || state.config.agent_models[modelName]?.active_key || (list[0] ? list[0].key : '');
    const isActive = (binding.key === activeKey);

    const setActiveBtn = isActive
      ? `<span class="badge badge-success" style="font-size:11px;padding:3px 8px;font-weight:600;">使用中</span>`
      : `<button class="btn btn-sm btn-secondary" onclick="setActiveAgentKey('${esc(modelName)}','${esc(binding.key)}')" title="设为主力 Key" style="font-size:11px;padding:2px 8px;font-weight:500;">设为主力</button>`;

    actions = `
      ${setActiveBtn}
      <button class="btn btn-icon btn-sm btn-secondary" id="probeBtn-${esc(probeKeyId)}" onclick="testAgentKey('${esc(modelName)}',${i})" title="测试此 Key 连通性" ${isProbing?'disabled':''}>
        ${isProbing ? '<span class="spinner"></span>' : '测'}
      </button>
      <button class="btn btn-icon btn-sm btn-secondary-danger" onclick="deleteAgentKey('${esc(modelName)}',${i})" title="删除绑定">×</button>`;
  } else {
    actions = `
      <button class="btn btn-icon btn-sm btn-secondary" id="probeBtn-${esc(probeKeyId)}" onclick="testCandidate('${type}',${i})" title="测试此 Key 连通性" ${isProbing?'disabled':''}>
        ${isProbing ? '<span class="spinner"></span>' : '测'}
      </button>
      <button class="btn btn-icon btn-sm btn-secondary-danger" onclick="deleteCandidate('${type}',${i})" title="删除">×</button>`;
  }
  return `<tr>
    <td>${orderInputHtml}</td>
    <td><b>${esc(binding.provider)}</b></td>
    <td>${keyBadgeHtml}</td>
    ${modelCell}
    <td>${badge}</td>
    <td class="text-sm text-secondary">${time}</td>
    <td style="text-align:right"><div class="flex gap-2" style="justify-content:flex-end;align-items:center;">${actions}</div></td>
  </tr>`;
}

// ---- Provider Presets Database & Dynamic Remote Catalog ------------------

let _currentProbedModels = [];
let _probeTargetModal = 'agent';

async function executeProbe(targetModal) {
  _probeTargetModal = targetModal;
  const isAgent = targetModal === 'agent';
  const btn = document.getElementById(isAgent ? 'btnProbeAgentModels' : 'btnProbeCandidateModels');
  const selVal = document.getElementById(isAgent ? 'a_providerSelect' : 'c_providerSelect')?.value;

  if (!selVal) {
    toast('请先选择上方供应商', 'err');
    return;
  }

  const keyContainerId = isAgent ? '#a_keyList' : '#c_keyList';
  const checkedBoxes = Array.from(document.querySelectorAll(`${keyContainerId} input[type="checkbox"]:checked`));
  const keyLabels = checkedBoxes.map(b => b.value);

  if (btn) { btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> 探测中...'; }

  try {
    const res = await fetch('/api/admin/probe-models', {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({
        provider: selVal,
        key_label: keyLabels[0] || '',
        key_labels: keyLabels
      })
    });
    const data = await res.json();
    if (!data.ok || !data.models || data.models.length === 0) {
      toast(data.error || '未探测到可用模型列表，请检查供应商网络或凭据', 'err');
      return;
    }

    _currentProbedModels = data.models;
    const titleSuffix = data.used_key_label ? ` (使用凭据: ${data.used_key_label})` : '';
    document.getElementById('probedModalTitle').textContent = `供应商 [${selVal}] 上游可用模型 (${data.models.length})${titleSuffix}`;
    document.getElementById('probedSearchInput').value = '';
    renderProbedModelsList(_currentProbedModels);
    openModal('probedListModal');
    const succMsg = data.used_key_label ? `使用凭据 [${data.used_key_label}] 探测成功，发现 ${data.models.length} 个模型` : `成功探测到 ${data.models.length} 个可用模型`;
    toast(succMsg, 'ok');
  } catch(e) {
    toast(`探测模型异常: ${e.message}`, 'err');
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = `<svg class="khc-icon" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg> 探测上游可用模型`;
    }
  }
}

function renderProbedModelsList(models) {
  const listEl = document.getElementById('probedModelsList');
  const countEl = document.getElementById('probedCountHint');
  if (countEl) countEl.textContent = `共 ${models.length} 个模型`;

  if (!models.length) {
    listEl.innerHTML = '<div class="empty" style="padding:20px;">无匹配的模型</div>';
    return;
  }

  listEl.innerHTML = models.map(m => `
    <div class="probed-item" onclick="selectProbedModel('${esc(m)}')">
      <span class="mono" style="font-size:13px;font-weight:600;color:var(--text);word-break:break-all;">${esc(m)}</span>
      <button class="btn btn-sm btn-primary" style="padding:3px 10px;font-size:11px;">选取</button>
    </div>
  `).join('');
}

function filterProbedModels(kw) {
  const clean = (kw || '').trim().toLowerCase();
  if (!clean) {
    renderProbedModelsList(_currentProbedModels);
  } else {
    const filtered = _currentProbedModels.filter(m => m.toLowerCase().includes(clean));
    renderProbedModelsList(filtered);
  }
}

function selectProbedModel(modelName) {
  if (_probeTargetModal === 'agent') {
    document.getElementById('a_name').value = modelName;
    document.getElementById('a_upstream').value = modelName;
  } else {
    document.getElementById('c_model').value = modelName;
  }
  closeModal('probedListModal');
  toast(`已选取模型: ${modelName}`, 'ok');
}

function applyAgentQuickModel(name, upstream, el){
  document.getElementById('a_name').value = name;
  document.getElementById('a_upstream').value = upstream || name;
  document.querySelectorAll('#a_quickTags .model-capsule').forEach(c => c.classList.remove('active'));
  if(el) el.classList.add('active');
  toast(`已填入模型: ${name}`, 'info');
}



function populateAgentProviderSelect(selectedId){
  const sel = document.getElementById('a_providerSelect');
  const optLocal = document.getElementById('a_optgroup_local');
  const optVault = document.getElementById('a_optgroup_vault');
  if(!sel) return;
  const providers = getAllAvailableProviders();

  const localList = providers.filter(p => !p.isVault);
  const vaultList = providers.filter(p => p.isVault);

  if (optLocal) {
    optLocal.innerHTML = localList.length
      ? localList.map(p => `<option value="${esc(p.id)}">${esc(p.label)} (${esc(p.protoStr)})</option>`).join('')
      : '<option disabled>暂无本地已配置供应商</option>';
  }
  if (optVault) {
    optVault.innerHTML = vaultList.length
      ? vaultList.map(p => `<option value="${esc(p.id)}">${esc(p.label)} (${esc(p.protoStr)})</option>`).join('')
      : '<option disabled>暂无中枢托管供应商</option>';
  }

  const curId = (selectedId && providers.some(p => p.id === selectedId)) 
    ? selectedId 
    : (providers[0] ? providers[0].id : '');
  
  sel.value = curId;
  onAgentProviderSelectChange(curId);
}

function onAgentProviderSelectChange(val){
  document.getElementById('a_provider').value = val || '';
  const keyArea = document.getElementById('a_keyArea');
  const quickBox = document.getElementById('a_quickModels');
  const protoInfoEl = document.getElementById('a_model_proto_info');

  if(!val){
    if(keyArea) keyArea.style.display = 'none';
    if(quickBox) quickBox.style.display = 'none';
    if(protoInfoEl) protoInfoEl.innerHTML = `<span style="display:inline-flex;align-items:center;gap:4px;">${icon('info', 14)}</span> 请先选择或新建供应商。`;
  } else {
    if(keyArea) keyArea.style.display = 'block';
    renderAgentKeyChecks();
  }
}

async function openAgentModal(){ 
  document.getElementById('agentModalTitle').textContent='新增 Agent 模型'; 
  document.getElementById('a_oldName').value=''; 
  document.getElementById('a_name').value=''; 
  document.getElementById('a_name').readOnly=false; 
  document.getElementById('a_upstream').value=''; 
  if(!state.vaultManifest){ await fetchVaultManifest(true); }
  const providers = getAllAvailableProviders();
  const defaultProv = providers[0] ? providers[0].id : '';
  populateAgentProviderSelect(defaultProv);
  openModal('agentModal'); 
}

function renderAgentKeyChecks(){
  const prov = document.getElementById('a_provider').value;
  const box = document.getElementById('a_keyList');
  const quickBox = document.getElementById('a_quickModels');
  const quickTags = document.getElementById('a_quickTags');
  const protoInfoEl = document.getElementById('a_model_proto_info');

  if(!prov){ 
    box.innerHTML = '<div class="hint">请先在上方选择或新建供应商</div>'; 
    if(quickBox) quickBox.style.display = 'none';
    if(protoInfoEl) protoInfoEl.innerHTML = '';
    return; 
  }

  const localProv = state.config.providers && state.config.providers[prov];
  const remoteProv = findVaultProvider(prov);

  const provProtos = localProv ? getProviderProtocols(prov) : (remoteProv?.protocols || ['chat']);
  if(protoInfoEl) {
    protoInfoEl.innerHTML = renderProtocolBadges(provProtos);
  }

  const localKeys = localProv ? Object.keys(localProv.keys || {}) : [];
  const remoteKeys = remoteProv ? (remoteProv.keys || []).map(k => typeof k === 'string' ? k : (k.label || k.id || '')).filter(Boolean) : [];
  // Prioritize Vault keys first, then purely local keys
  const purelyLocalKeys = localKeys.filter(k => !remoteKeys.includes(k));
  const allKeyLabels = [...remoteKeys, ...purelyLocalKeys];

  if(allKeyLabels.length === 0){
    box.innerHTML = '<div class="hint">该供应商下暂无可用 Key</div>';
  } else {
    box.innerHTML = allKeyLabels.map((k, idx) => {
      const isVault = remoteKeys.includes(k);
      const isLocal = localKeys.includes(k);
      const isChecked = idx === 0;
      const tag = isVault 
        ? `<span class="badge badge-neutral" style="font-size:10px;padding:0 6px;">${icon('cloud', 11)} 中枢</span>`
        : `<span class="badge badge-success" style="font-size:10px;padding:0 6px;">${icon('check', 11)} 本地</span>`;
      
      const deleteBtn = (!isVault && isLocal)
        ? `<button type="button" class="btn-ghost" style="padding:0 4px;margin-left:4px;color:var(--error);font-weight:bold;line-height:1;" title="从本地存储中彻底删除此 Key" onclick="removeLocalKeyFromModal('${esc(prov)}', '${esc(k)}', event)">×</button>`
        : '';

      return `<div class="key-capsule ${isChecked ? 'checked' : ''}" onclick="toggleKeyCapsule(this)">
        <input type="checkbox" value="${esc(k)}" data-is-local="${isLocal}" ${isChecked ? 'checked' : ''} style="display:none;">
        <span style="font-weight:600;">${esc(k)}</span>
        ${tag}
        ${deleteBtn}
      </div>`;
    }).join('');
  }

  // Render quick model capsules (Preset or Remote Vault)
  const preset = PRESET_DEFINITIONS[prov.toLowerCase()] || remoteProv;
  const recModels = preset?.recommended_models || remoteProv?.recommended_models || [];
  if(recModels.length > 0 && quickBox && quickTags){
    quickTags.innerHTML = recModels.map(rm => {
      const mName = typeof rm === 'string' ? rm : (rm.name || rm.id);
      const mUpstream = typeof rm === 'string' ? rm : (rm.upstream || rm.name || rm.id);
      return `<div class="model-capsule" onclick="applyAgentQuickModel('${esc(mName)}', '${esc(mUpstream)}', this)">
        <span>${esc(mName)}</span>
      </div>`;
    }).join('');
    quickBox.style.display = 'block';
  } else if(quickBox) {
    quickBox.style.display = 'none';
  }
}

async function editAgentModel(name){
  const m=state.config.agent_models[name] || {};
  document.getElementById('agentModalTitle').textContent='编辑 Agent 模型';
  document.getElementById('a_oldName').value=name;
  document.getElementById('a_name').value=name;
  document.getElementById('a_name').readOnly=false;
  document.getElementById('a_upstream').value=m.upstream_model||'';
  if(!state.vaultManifest){ await fetchVaultManifest(true); }
  const boundProviders=[...new Set((m.keys||[]).map(x=>x.provider))];
  const activeProv = boundProviders[0] || (getAllAvailableProviders()[0]?.id || '');
  populateAgentProviderSelect(activeProv);
  const set=new Set((m.keys||[]).map(x=>x.provider+':'+x.key));
  document.querySelectorAll('#a_keyList .key-capsule').forEach(cap=>{
    const inp = cap.querySelector('input');
    const checked = set.has(activeProv+':'+inp.value);
    inp.checked = checked;
    cap.classList.toggle('checked', checked);
  });
  openModal('agentModal');
}

async function saveAgentModel(){
  const oldName=(document.getElementById('a_oldName').value||'').trim();
  const name=document.getElementById('a_name').value.trim();
  const upstream=document.getElementById('a_upstream').value.trim();
  const selVal=document.getElementById('a_providerSelect').value;
  if(!name){ toast('模型名称不能为空','err'); return; }

  const provider = selVal;
  if(!provider){ toast('请先选择所属供应商','err'); return; }

  const bindings = [];
  document.querySelectorAll('#a_keyList input:checked').forEach(inp=>{
    bindings.push({provider:inp.dataset.provider||provider, key:inp.value});
  });
  if(!bindings.length){ toast('请至少勾选绑定一个 Key','err'); return; }
  const ok = await ensureKeysImported(bindings);
  if(!ok) return;

  if(!state.config.agent_models) state.config.agent_models={};

  // Check if adding a new model that collides with an existing model
  if(!oldName && state.config.agent_models[name]) {
    const existing = state.config.agent_models[name];
    const existingKeySet = new Set((existing.keys || []).map(k => `${k.provider}:${k.key}`));
    const newKeysToAdd = bindings.filter(k => !existingKeySet.has(`${k.provider}:${k.key}`));

    const msg = newKeysToAdd.length > 0
      ? `模型 ID「${name}」已存在！\n\n点击【确定】将勾选的 ${newKeysToAdd.length} 个新 Key 追加合并至该已有模型；\n点击【取消】返回修改模型名称。`
      : `模型 ID「${name}」已存在，且所选 Key 已全部绑定至该模型。\n\n点击【确定】保留原有配置并退出；点击【取消】返回修改模型名称。`;

    if (!confirm(msg)) {
      document.getElementById('a_name').focus();
      return;
    }

    if (newKeysToAdd.length > 0) {
      existing.keys = (existing.keys || []).concat(newKeysToAdd);
    }
    if (upstream && upstream !== name) {
      existing.upstream_model = upstream;
    }
  } else {
    if(oldName && oldName!==name){ delete state.config.agent_models[oldName]; }
    const entry={keys:bindings}; 
    if(upstream && upstream!==name) {
      entry.upstream_model=upstream;
    }
    state.config.agent_models[name]=entry;
  }

  closeModal('agentModal');
  await persistConfig(oldName && oldName!==name ? `Agent 模型已从「${oldName}」重命名为「${name}」并立即生效` : `Agent 模型「${name}」已保存并立即生效`);
  renderAgentModels();
}

async function deleteAgentModel(name){ 
  if(!confirm('确定要删除 Agent 模型 "'+name+'" 吗？')) return; 
  delete state.config.agent_models[name]; 
  await persistConfig(`Agent 模型「${name}」已删除并立即生效`); 
  renderAgentModels(); 
}
function reorderAgentKey(name, fromIdx, inputVal){
  const keys = state.config.agent_models?.[name]?.keys;
  if (!Array.isArray(keys) || keys.length <= 1) return;
  let targetPos = parseInt(inputVal, 10);
  if (isNaN(targetPos)) {
    renderAgentModels();
    return;
  }
  let targetIdx = Math.max(0, Math.min(keys.length - 1, targetPos - 1));
  if (targetIdx === fromIdx) {
    renderAgentModels();
    return;
  }
  const [item] = keys.splice(fromIdx, 1);
  keys.splice(targetIdx, 0, item);
  persistConfig('Key 优先级已调整并立即生效');
  renderAgentModels();
}
function moveAgentKey(name,i,dir){ 
  const keys=state.config.agent_models[name].keys; 
  const t=i+dir; 
  if(t<0||t>=keys.length)return; 
  [keys[i],keys[t]]=[keys[t],keys[i]]; 
  persistConfig('Key 优先级已调整并立即生效'); 
  renderAgentModels(); 
}
function deleteAgentKey(name,i){ 
  state.config.agent_models[name].keys.splice(i,1); 
  if(!state.config.agent_models[name].keys.length) delete state.config.agent_models[name]; 
  persistConfig('Key 绑定已移除并立即生效'); 
  renderAgentModels(); 
}
function setActiveAgentKey(name, keyLabel){
  if(!state.config.agent_models || !state.config.agent_models[name]) return;
  state.config.agent_models[name].active_key = keyLabel;
  if(state.stats && state.stats.agent){
    if(!state.stats.agent.active_keys) state.stats.agent.active_keys = {};
    state.stats.agent.active_keys[name] = keyLabel;
  }
  persistConfig(`模型「${name}」已设置主力 Key: [${keyLabel}] 并立即生效`);
  renderAgentModels();
}

// Anti-repeat Probing Implementation
async function testAgentKey(name, i){
  const b = state.config.agent_models[name].keys[i];
  const probeKeyId = 'agent:' + name + ':' + b.provider + ':' + b.key;
  if(state.probingKeys.has(probeKeyId)) return;
  
  state.probingKeys.add(probeKeyId);
  const btn = document.getElementById('probeBtn-' + probeKeyId);
  if(btn) { btn.disabled = true; btn.innerHTML = '<span class="spinner"></span>'; }

  const model = b.upstream_model || state.config.agent_models[name].upstream_model || name;
  const start = Date.now();
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 12000);
    const r = await fetch('/api/admin/test-candidate', {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({ provider: b.provider, key: b.key, model, type: 'chat', category: 'agent', model_name: name }),
      signal: controller.signal
    });
    clearTimeout(timeout);
    const d = await r.json();
    const latency = Date.now() - start;
    if(d.success) {
      toast(`[${b.provider}/${b.key}] 探活成功 (${latency}ms)`, 'ok');
    } else {
      toast(`[${b.provider}/${b.key}] 探活失败: ${d.error || d.status}`, 'err');
    }
  } catch(e) {
    toast(`[${b.provider}/${b.key}] 探活超时或异常: ${e.message}`, 'err');
  } finally {
    state.probingKeys.delete(probeKeyId);
    await loadData();
  }
}

async function testAgentModelAll(name){
  if(state.probingModels.has(name)) return;
  state.probingModels.add(name);

  const btn = document.getElementById('probeAllBtn-' + name);
  if(btn) { btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> 探测中...'; }

  const box = document.getElementById('agentProbe-' + name);
  box.style.display = 'block';
  box.innerHTML = '<div style="display:flex;align-items:center;gap:8px;"><span class="spinner"></span> 正在并发探测所有 Key 连通性</div>';

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    const r = await fetch('/api/admin/test-agent-model', {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({ model: name }),
      signal: controller.signal
    });
    clearTimeout(timeout);
    const d = await r.json();
    if(!d.results){ box.innerHTML = '<span style="color:var(--error);">探活失败: 无响应数据</span>'; return; }
    
    const chips = d.results.map(res => {
      const lat = res.latency_ms !== null && res.latency_ms !== undefined ? ` ${res.latency_ms >= 1000 ? (res.latency_ms/1000).toFixed(2)+'s' : res.latency_ms+'ms'}` : '';
      return res.ok
        ? `<span class="badge badge-success" style="font-weight:600;">${esc(res.provider)}/${esc(res.key)}${lat}</span>`
        : `<span class="badge badge-error" title="${esc(res.error||'')}">${esc(res.provider)}/${esc(res.key)} (${res.status||'ERR'})</span>`;
    }).join(' ');

    box.innerHTML = `
      <div class="mb-2" style="font-weight:600;display:flex;align-items:center;justify-content:space-between;">
        <span>可用性统计: <b>${d.ok} / ${d.total}</b> 正常</span>
        <span class="text-secondary" style="font-weight:400;">探测时间: ${esc(d.checked_at||'')}</span>
      </div>
      <div class="flex gap-2" style="flex-wrap:wrap;">${chips}</div>
    `;
    toast(`探活完成: ${name} (可用 ${d.ok}/${d.total})`, d.ok > 0 ? 'ok' : 'err');
  } catch(e) {
    box.innerHTML = `<span style="color:var(--error);">探活异常或超时: ${esc(e.message)}</span>`;
    toast('探活异常: ' + e.message, 'err');
  } finally {
    state.probingModels.delete(name);
    if(btn) { btn.disabled = false; btn.innerHTML = '探活全部'; }
    await loadData();
  }
}

// Candidate Actions
function selectCandidateType(type){
  document.getElementById('c_type').value = type;
  document.querySelectorAll('#c_typeCapsules .capsule-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.type === type);
  });
  renderCandidateQuickModels();
}

function populateCandidateProviderSelect(selectedId){
  const sel = document.getElementById('c_providerSelect');
  const optLocal = document.getElementById('c_optgroup_local');
  const optVault = document.getElementById('c_optgroup_vault');
  if(!sel) return;
  const providers = getAllAvailableProviders();

  const localList = providers.filter(p => !p.isVault);
  const vaultList = providers.filter(p => p.isVault);

  if (optLocal) {
    optLocal.innerHTML = localList.length
      ? localList.map(p => `<option value="${esc(p.id)}">${esc(p.label)} (${esc(p.protoStr)})</option>`).join('')
      : '<option disabled>暂无本地已配置供应商</option>';
  }
  if (optVault) {
    optVault.innerHTML = vaultList.length
      ? vaultList.map(p => `<option value="${esc(p.id)}">${esc(p.label)} (${esc(p.protoStr)})</option>`).join('')
      : '<option disabled>暂无中枢托管供应商</option>';
  }

  const curId = (selectedId && providers.some(p => p.id === selectedId)) 
    ? selectedId 
    : (providers[0] ? providers[0].id : '');
  
  sel.value = curId;
  onCandidateProviderSelectChange(curId);
}

function onCandidateProviderSelectChange(val){
  document.getElementById('c_provider').value = val || '';
  const keyArea = document.getElementById('c_keyArea');
  const quickBox = document.getElementById('c_quickModels');
  const protoInfoEl = document.getElementById('c_model_proto_info');

  if(!val){
    if(keyArea) keyArea.style.display = 'none';
    if(quickBox) quickBox.style.display = 'none';
    if(protoInfoEl) protoInfoEl.innerHTML = '';
  } else {
    if(keyArea) keyArea.style.display = 'block';
    const localProv = state.config.providers && state.config.providers[val];
    const remoteProv = findVaultProvider(val);
    const provProtos = localProv ? getProviderProtocols(val) : (remoteProv?.protocols || ['chat']);
    if(protoInfoEl) {
      protoInfoEl.innerHTML = renderProtocolBadges(provProtos);
    }
    renderCandidateKeyChecks();
    renderCandidateQuickModels();
  }
}

function applyCandidateQuickModel(model, el){
  document.getElementById('c_model').value = model;
  document.querySelectorAll('#c_quickTags .model-capsule').forEach(c => c.classList.remove('active'));
  if(el) el.classList.add('active');
  toast(`已填入模型: ${model}`, 'info');
}

function renderCandidateQuickModels(){
  const prov = document.getElementById('c_provider').value;
  const type = document.getElementById('c_type').value || 'chat';
  const quickBox = document.getElementById('c_quickModels');
  const quickTags = document.getElementById('c_quickTags');

  if(!prov || !quickBox || !quickTags){
    if(quickBox) quickBox.style.display = 'none';
    return;
  }

  const preset = PRESET_DEFINITIONS[prov.toLowerCase()];
  const remoteProv = findVaultProvider(prov);
  const recModels = preset?.recommended_models || remoteProv?.recommended_models || remoteProv?.models || [];
  if(recModels.length > 0){
    const matching = recModels.filter(rm => !rm.kb_type || rm.kb_type === type);
    const listToRender = matching.length > 0 ? matching : recModels;
    quickTags.innerHTML = listToRender.map(rm => {
      const name = typeof rm === 'string' ? rm : (rm.name || rm.id);
      const upstream = typeof rm === 'string' ? rm : (rm.upstream || rm.name || rm.id);
      return `<div class="model-capsule" onclick="applyCandidateQuickModel('${esc(upstream)}', this)">
        <span>${esc(name)}</span>
      </div>`;
    }).join('');
    quickBox.style.display = 'block';
  } else {
    quickBox.style.display = 'none';
  }
}

async function openCandidateModal(type){
  const curType = type || 'chat';
  document.getElementById('candidateModalTitle').textContent='挂载候选节点';
  document.getElementById('c_editCat').value=''; 
  document.getElementById('c_editIdx').value='';
  document.getElementById('c_type').value = curType;
  document.querySelectorAll('#c_typeCapsules .capsule-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.type === curType);
  });
  if(!state.vaultManifest){ await fetchVaultManifest(true); }
  const providers = getAllAvailableProviders();
  const defaultProv = providers[0] ? providers[0].id : '';
  populateCandidateProviderSelect(defaultProv);
  document.getElementById('c_model').value='';
  openModal('candidateModal');
}

function renderCandidateKeyChecks(){
  const prov=document.getElementById('c_provider').value;
  const box=document.getElementById('c_keyList');

  if(!prov){ box.innerHTML='<div class="hint">请先在上方选择或新建供应商</div>'; return; }
  
  const localProv = state.config.providers && state.config.providers[prov];
  const remoteProv = findVaultProvider(prov);

  const localKeys = localProv ? Object.keys(localProv.keys || {}) : [];
  const remoteKeys = remoteProv ? (remoteProv.keys || []).map(k => typeof k === 'string' ? k : (k.label || k.id || '')).filter(Boolean) : [];
  // Prioritize Vault keys first, then purely local keys
  const purelyLocalKeys = localKeys.filter(k => !remoteKeys.includes(k));
  const allKeyLabels = [...remoteKeys, ...purelyLocalKeys];

  if(allKeyLabels.length === 0){
    box.innerHTML='<div class="hint">该供应商下暂无可用 Key</div>';
  } else {
    box.innerHTML=allKeyLabels.map((k, idx)=>{
      const isVault = remoteKeys.includes(k);
      const isLocal = localKeys.includes(k);
      const isChecked = idx === 0;
      const tag = isVault 
        ? `<span class="badge badge-neutral" style="font-size:10px;padding:0 6px;">${icon('cloud', 11)} 中枢</span>`
        : `<span class="badge badge-success" style="font-size:10px;padding:0 6px;">${icon('check', 11)} 本地</span>`;

      const deleteBtn = (!isVault && isLocal)
        ? `<button type="button" class="btn-ghost" style="padding:0 4px;margin-left:4px;color:var(--error);font-weight:bold;line-height:1;" title="从本地存储中彻底删除此 Key" onclick="removeLocalKeyFromModal('${esc(prov)}', '${esc(k)}', event)">×</button>`
        : '';

      return `<div class="key-capsule ${isChecked ? 'checked' : ''}" onclick="toggleKeyCapsule(this)">
        <input type="checkbox" value="${esc(k)}" data-is-local="${isLocal}" ${isChecked ? 'checked' : ''} style="display:none;">
        <span style="font-weight:600;">${esc(k)}</span>
        ${tag}
        ${deleteBtn}
      </div>`;
    }).join('');
  }
}

async function removeLocalKeyFromModal(prov, label, event){
  if(event) event.stopPropagation();
  if(!confirm(`确定要从本地存储中彻底删除 Key「${label}」吗？`)) return;
  if(state.config.providers && state.config.providers[prov] && state.config.providers[prov].keys){
    delete state.config.providers[prov].keys[label];
  }
  if(state.config.agent_models){
    Object.values(state.config.agent_models).forEach(m => {
      m.keys = (m.keys || []).filter(x => !(x.provider === prov && x.key === label));
    });
  }
  KB_TYPES.forEach(t => {
    if(state.config.candidates && state.config.candidates[t]){
      state.config.candidates[t] = state.config.candidates[t].filter(x => !(x.provider === prov && x.key === label));
    }
  });
  await persistConfig(`本地 Key「${label}」已彻底删除`);
  renderAgentKeyChecks();
  renderCandidateKeyChecks();
  renderProviders();
  renderModels();
}

async function editCandidate(type,i){
  const c=state.config.candidates[type][i];
  document.getElementById('candidateModalTitle').textContent='编辑候选节点';
  document.getElementById('c_editCat').value=type; 
  document.getElementById('c_editIdx').value=i;
  document.getElementById('c_type').value=type;
  document.querySelectorAll('#c_typeCapsules .capsule-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.type === type);
  });
  if(!state.vaultManifest){ await fetchVaultManifest(true); }
  populateCandidateProviderSelect(c.provider);
  document.querySelectorAll('#c_keyList .key-capsule').forEach(cap=>{
    const inp = cap.querySelector('input');
    const checked = inp.value === c.key;
    inp.checked = checked;
    cap.classList.toggle('checked', checked);
  });
  document.getElementById('c_model').value=c.model;
  openModal('candidateModal');
}

async function saveCandidate(){
  const type=document.getElementById('c_type').value;
  const selVal=document.getElementById('c_providerSelect').value;
  const model=document.getElementById('c_model').value.trim();
  if(!model){ toast('请填入或选定模型名称','err'); return; }

  const provider = selVal;
  if(!provider){ toast('请先选择所属供应商','err'); return; }

  const selected = Array.from(document.querySelectorAll('#c_keyList input:checked')).map(x=>x.value);
  if(!selected.length){ toast('请至少勾选一个 Key','err'); return; }

  const bindings = selected.map(k => ({ provider, key: k }));
  const ok = await ensureKeysImported(bindings);
  if(!ok) return;

  if(!state.config.candidates) state.config.candidates={};
  if(!state.config.candidates[type]) state.config.candidates[type]=[];
  const editCat=document.getElementById('c_editCat').value, editIdx=document.getElementById('c_editIdx').value;
  if(editCat&&editIdx!==''){
    state.config.candidates[editCat][parseInt(editIdx)]={provider,key:selected[0],model};
    for(let i=1;i<selected.length;i++) state.config.candidates[editCat].push({provider,key:selected[i],model});
  } else {
    selected.forEach(k=>state.config.candidates[type].push({provider,key:k,model}));
  }
  closeModal('candidateModal');
  await persistConfig(`候选节点已挂载到 [${type}] 并立即生效`);
  renderKbModels();
}
function reorderCandidate(type, fromIdx, inputVal){
  const list = state.config.candidates?.[type];
  if (!Array.isArray(list) || list.length <= 1) return;
  let targetPos = parseInt(inputVal, 10);
  if (isNaN(targetPos)) {
    renderKbModels();
    return;
  }
  let targetIdx = Math.max(0, Math.min(list.length - 1, targetPos - 1));
  if (targetIdx === fromIdx) {
    renderKbModels();
    return;
  }
  const [item] = list.splice(fromIdx, 1);
  list.splice(targetIdx, 0, item);
  persistConfig('候选节点优先级已调整并立即生效');
  renderKbModels();
}
function moveCandidate(type,i,dir){ 
  const list=state.config.candidates[type]; 
  const t=i+dir; 
  if(t<0||t>=list.length)return; 
  [list[i],list[t]]=[list[t],list[i]]; 
  persistConfig('候选节点优先级已调整并立即生效'); 
  renderKbModels(); 
}
async function deleteCandidate(type,i){ 
  if(!confirm('确定要删除该候选节点吗？')) return; 
  state.config.candidates[type].splice(i,1); 
  await persistConfig('候选节点已删除并立即生效'); 
  renderKbModels(); 
}

async function testCandidate(type, i){
  const c = state.config.candidates[type][i];
  const probeKeyId = 'kb:' + type + (c.model ? ':' + c.model : '') + ':' + c.provider + ':' + c.key;
  if(state.probingKeys.has(probeKeyId)) return;

  state.probingKeys.add(probeKeyId);
  const btn = document.getElementById('probeBtn-' + probeKeyId);
  if(btn) { btn.disabled = true; btn.innerHTML = '<span class="spinner"></span>'; }

  const start = Date.now();
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 12000);
    const r = await fetch('/api/admin/test-candidate', {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({ ...c, type, model: c.model }),
      signal: controller.signal
    });
    clearTimeout(timer);
    const d = await r.json();
    const latency = Date.now() - start;
    if(d.success){
      toast(`[${c.provider}/${c.key}${c.model ? `/${c.model}` : ''}] 探活成功 (${latency}ms)`, 'ok');
    } else {
      toast(`[${c.provider}/${c.key}${c.model ? `/${c.model}` : ''}] 探活失败: ${d.error || d.status}`, 'err');
    }
  } catch(e) {
    toast(`[${c.provider}/${c.key}${c.model ? `/${c.model}` : ''}] 探活异常: ${e.message}`, 'err');
  } finally {
    state.probingKeys.delete(probeKeyId);
    await loadData();
  }
}

// Settings

async function runLiveTest(modelName){
  const resBox = document.getElementById('liveTestRes-' + modelName);
  const btn = document.getElementById('liveTestBtn-' + modelName);
  if(!resBox) return;

  resBox.style.display = 'block';
  resBox.innerHTML = `
    <div style="display:flex;align-items:center;gap:8px;color:var(--text-secondary);">
      <span class="spinner"></span>
      <span>正在向生产端点发起真实测试请求 (POST /v1/chat/completions)...</span>
    </div>
  `;
  if(btn) { btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> 测试中'; }

  const start = Date.now();
  try {
    const apiKey = (state.config && state.config.proxy_api_key) ? state.config.proxy_api_key : (state.adminPassword || '');
    const resp = await fetch('/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + apiKey,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: modelName,
        messages: [{ role: 'user', content: '1+1等于几？请仅回复一个数字。' }],
        max_tokens: 15,
        stream: false
      })
    });

    const elapsed = Date.now() - start;
    const rawRouted = resp.headers.get('X-Routed-Via') || '';
    let routedVia = rawRouted;
    try { routedVia = decodeURIComponent(rawRouted); } catch(e) {}
    const fallbacks = resp.headers.get('X-Fallback-Attempts') || '0';

    if(resp.ok){
      const data = await resp.json();
      const content = data?.choices?.[0]?.message?.content || '(无返回文本)';
      resBox.innerHTML = `
        <div style="display:flex;flex-direction:column;gap:8px;">
          <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px;">
            <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
              <span class="badge badge-success" style="font-weight:700;">HTTP 200 OK</span>
              <span style="font-weight:600;color:var(--text);">实际调用节点:</span>
              <span class="badge badge-primary" style="font-family:monospace;font-size:12px;padding:2px 8px;">${esc(routedVia || '默认节点')}</span>
              <span style="color:var(--text-secondary);font-size:12px;">往返耗时: <b>${elapsed}ms</b></span>
              ${Number(fallbacks) > 0 ? `<span class="badge badge-warning">故障转移重试: ${fallbacks}次</span>` : ''}
            </div>
            <button class="btn btn-sm" onclick="this.closest('div').parentElement.parentElement.style.display='none'" style="font-size:11px;padding:2px 6px;">收起</button>
          </div>
          <div style="font-size:12px;background:var(--bg);padding:6px 12px;border-radius:var(--radius-sm);border:1px solid var(--border);color:var(--text);">
            <span style="color:var(--text-secondary);">模型输出：</span>${esc(content.trim())}
          </div>
        </div>
      `;
      toast(`[${modelName}] 实测验证成功！命中: ${routedVia} (${elapsed}ms)`, 'ok');
    } else {
      let errText = '';
      try {
        const errJson = await resp.json();
        errText = errJson?.error?.message || JSON.stringify(errJson);
      } catch(e) {
        errText = await resp.text();
      }
      resBox.innerHTML = `
        <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px;color:var(--error);">
          <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
            <span class="badge badge-error" style="font-weight:700;">HTTP ${resp.status}</span>
            <span style="font-weight:600;">调用失败:</span>
            <span style="font-size:12px;">${esc(errText || '未知错误')}</span>
            ${routedVia ? `<span class="badge badge-neutral" style="font-size:11px;">尝试节点: ${esc(routedVia)}</span>` : ''}
            <span style="color:var(--text-secondary);font-size:12px;">(${elapsed}ms)</span>
          </div>
          <button class="btn btn-sm" onclick="this.closest('div').parentElement.style.display='none'" style="font-size:11px;padding:2px 6px;">收起</button>
        </div>
      `;
      toast(`[${modelName}] 实测失败: HTTP ${resp.status}`, 'err');
    }
  } catch(e) {
    resBox.innerHTML = `
      <div style="color:var(--error);display:flex;align-items:center;justify-content:space-between;">
        <span>网络请求异常: ${esc(e.message)}</span>
        <button class="btn btn-sm" onclick="this.closest('div').parentElement.style.display='none'" style="font-size:11px;padding:2px 6px;">收起</button>
      </div>
    `;
  } finally {
    if(btn) { btn.disabled = false; btn.innerHTML = icon('zap') + ' 对话实测'; }
  }
}

// Access Guide -> Handled by renderDashboardGateway directly in dashboard


/* === Module: settings.js === */
/**
 * OCRProxy Admin - System Settings, Timeouts & Fault Tolerance
 */
function renderSettings(){
  const c=state.config||{};
  const set=(id,v)=>{ const el=document.getElementById(id); if(el) el.value=(v!==undefined && v!==null)?v:''; };
  
  // Card 1: Client Auth & Run Mode
  set('s_proxyApiKey', c.proxy_api_key || '');
  const modeEl = document.getElementById('s_runMode');
  if (modeEl) modeEl.value = c.run_mode || c._run_mode || 'agent';

  // Card 2: Routing Strategies
  set('s_agentRouting', c.agent_routing_strategy || 'sticky_failover');
  set('s_kbRouting', c.kb_routing_strategy || 'round_robin');

  // Card 3: Timeouts & Budget
  set('s_chatTimeout', c.upstream_timeout_sec ?? c.upstream_timeout_chat ?? 15);
  set('s_budget', c.request_total_budget_sec ?? c.schedule_total_budget ?? 45);
  set('s_maxRetries', c.max_retries ?? 3);
  set('s_maxAttemptsPerProvider', c.max_attempts_per_provider ?? 2);
  set('s_kbTimeout', c.upstream_timeout_kb ?? c.upstream_timeout_ocr ?? 60);
  set('s_concurrency', c.max_concurrency_per_key ?? 5);
  const ffEl = document.getElementById('s_fastFailover');
  if (ffEl) ffEl.checked = c.fast_failover_provider_down !== undefined ? !!c.fast_failover_provider_down : true;

  // Card 4: Fault Tolerance & Cooldown
  set('s_cooldown429', c.cooldown_429_sec ?? c.cooldown_tpm_sec ?? 60);
  set('s_cooldown5xx', c.cooldown_5xx_sec ?? c.cooldown_duration ?? 30);
  set('s_circuitThreshold', c.circuit_break_threshold ?? 3);
  set('s_cooldown403', c.cooldown_403_sec ?? 600);

  // Maintenance: Auto Restart
  const autoRestartEl=document.getElementById('s_autoRestart');
  if(autoRestartEl) {
    const isAgent = (c.run_mode || c._run_mode) === 'agent';
    autoRestartEl.checked = c.auto_restart_enabled !== undefined ? !!c.auto_restart_enabled : !isAgent;
  }

  // Card 6: EdgeOne Vault Hub
  const vCfg = c.edgeone_vault || {};
  set('cfg_vault_url', vCfg.url || '');
  set('cfg_vault_token', vCfg.token || '');

  onRunModeChange();
  updateRoutingSettingsState();
}

function onRunModeChange(){
  const modeEl = document.getElementById('s_runMode');
  if(!modeEl) return;
  const isKb = modeEl.value === 'kb';
  const isAgent = modeEl.value === 'agent';
  const kbItem = document.getElementById('st-item-kb-routing');
  const agItem = document.getElementById('st-item-agent-routing');
  const kbTimeout = document.getElementById('st-item-kb-timeout');
  if(kbItem) kbItem.style.display = isAgent ? 'none' : 'block';
  if(agItem) agItem.style.display = isKb ? 'none' : 'block';
  if(kbTimeout) kbTimeout.style.display = isAgent ? 'none' : 'block';
}

function onAgentRoutingChange(){
  updateRoutingSettingsState();
}

function updateRoutingSettingsState(){
  const agRouteEl = document.getElementById('s_agentRouting');
  const isManual = agRouteEl && agRouteEl.value === 'manual';
  
  const tipEl = document.getElementById('manual-routing-tip');
  const hintEl = document.getElementById('agent-routing-hint');
  if(tipEl) tipEl.style.display = isManual ? 'block' : 'none';
  if(hintEl) hintEl.style.display = isManual ? 'none' : 'block';

  const disabledSettingIds = [
    's_budget', 's_maxRetries', 's_maxAttemptsPerProvider',
    's_cooldown429', 's_cooldown5xx', 's_cooldown403',
    's_circuitThreshold', 's_fastFailover'
  ];

  disabledSettingIds.forEach(id => {
    const el = document.getElementById(id);
    if(el){
      el.disabled = isManual;
      const parent = el.closest('.setting-item') || el.closest('.toggle-card');
      if(parent){
        parent.style.opacity = isManual ? '0.45' : '1';
        parent.style.pointerEvents = isManual ? 'none' : 'auto';
      }
    }
  });
}

function restoreDefaultSettings(){
  if(!confirm('确定要恢复推荐默认参数吗？（不会影响已配置的模型和 Key）')) return;
  const set=(id,v)=>{ const el=document.getElementById(id); if(el) el.value=v; };
  set('s_chatTimeout', 15);
  set('s_budget', 45);
  set('s_maxRetries', 3);
  set('s_maxAttemptsPerProvider', 2);
  set('s_kbTimeout', 60);
  set('s_concurrency', 5);
  const ff = document.getElementById('s_fastFailover'); if(ff) ff.checked = true;
  set('s_cooldown429', 60);
  set('s_cooldown5xx', 30);
  set('s_circuitThreshold', 3);
  set('s_cooldown403', 600);
  toast('已填入官方推荐默认参数，请点击「保存设置」生效', 'ok');
}

function generateRandomKey() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let rand = '';
  for (let i = 0; i < 32; i++) {
    rand += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  const k = 'sk-ocrproxy-' + rand;
  const el = document.getElementById('s_proxyApiKey');
  if (el) el.value = k;
  toast('已生成新的客户端调用 Key，请点击保存设置生效', 'ok');
}

function copyProxyKey() {
  const el = document.getElementById('s_proxyApiKey');
  if (!el || !el.value) {
    toast('尚未配置客户端 Key', 'err');
    return;
  }
  navigator.clipboard.writeText(el.value);
  toast('客户端调用 Key 已复制到剪贴板', 'ok');
}

async function restartService(){
  if (!confirm('确定要平滑重启 OCRProxy 服务守护进程吗？（重启耗时约 2-3 秒）')) return;
  try {
    const r = await fetch('/api/admin/restart', { method: 'POST', headers: headers() });
    if (!r.ok) throw new Error('发送重启请求失败');
    toast('服务正在平滑重启中，3 秒后自动尝试重新连接...', 'ok');
    setTimeout(async () => {
      let retries = 5;
      while (retries > 0) {
        try {
          await loadData();
          toast('服务已成功恢复运行', 'ok');
          return;
        } catch(e) {
          retries--;
          await new Promise(res => setTimeout(res, 1000));
        }
      }
    }, 2500);
  } catch(e) {
    toast('重启失败: ' + e.message, 'err');
  }
}

async function saveSettings(silent=false){
  const c=state.config||{};

  // Card 1: Client Auth & Run Mode
  const keyEl = document.getElementById('s_proxyApiKey');
  if (keyEl) c.proxy_api_key = keyEl.value.trim();
  const modeEl = document.getElementById('s_runMode');
  if (modeEl) c.run_mode = modeEl.value;

  // Card 2: Key Routing Strategies
  const agRouteEl = document.getElementById('s_agentRouting');
  if (agRouteEl) c.agent_routing_strategy = agRouteEl.value;
  const kbRouteEl = document.getElementById('s_kbRouting');
  if (kbRouteEl) c.kb_routing_strategy = kbRouteEl.value;

  // Card 3: Timeouts & Budget
  c.upstream_timeout_sec = Number(document.getElementById('s_chatTimeout').value) || 15;
  c.upstream_timeout_chat = c.upstream_timeout_sec; // backward compatibility
  c.request_total_budget_sec = Number(document.getElementById('s_budget').value) || 45;
  c.schedule_total_budget = c.request_total_budget_sec; // backward compatibility
  c.max_retries = Number(document.getElementById('s_maxRetries').value) || 3;
  c.max_attempts_per_provider = Number(document.getElementById('s_maxAttemptsPerProvider').value) || 2;
  const kbTimeoutEl = document.getElementById('s_kbTimeout');
  c.upstream_timeout_kb = kbTimeoutEl ? (Number(kbTimeoutEl.value) || 60) : 60;
  c.upstream_timeout_ocr = c.upstream_timeout_kb;
  c.upstream_timeout_embedding = c.upstream_timeout_kb;
  c.upstream_timeout_rerank = Math.min(30, c.upstream_timeout_kb);
  c.max_concurrency_per_key = Number(document.getElementById('s_concurrency').value) || 5;
  const ffEl = document.getElementById('s_fastFailover');
  c.fast_failover_provider_down = ffEl ? !!ffEl.checked : true;

  // Card 4: Fault Tolerance & Cooldown
  c.cooldown_429_sec = Number(document.getElementById('s_cooldown429').value) || 60;
  c.cooldown_tpm_sec = c.cooldown_429_sec; // backward compatibility
  c.cooldown_5xx_sec = Number(document.getElementById('s_cooldown5xx').value) || 30;
  c.cooldown_duration = c.cooldown_5xx_sec; // backward compatibility
  c.circuit_break_threshold = Number(document.getElementById('s_circuitThreshold').value) || 3;
  c.cooldown_403_sec = Number(document.getElementById('s_cooldown403').value) || 600;
  delete c.latency_based_routing;

  // Maintenance: Auto Restart
  const autoRestartEl = document.getElementById('s_autoRestart');
  if (autoRestartEl) c.auto_restart_enabled = !!autoRestartEl.checked;

  // Card 6: EdgeOne Vault Hub
  const vaultUrlEl = document.getElementById('cfg_vault_url');
  const vaultTokenEl = document.getElementById('cfg_vault_token');
  if (vaultUrlEl || vaultTokenEl) {
    c.edgeone_vault = {
      url: (vaultUrlEl ? vaultUrlEl.value.trim() : ''),
      token: (vaultTokenEl ? vaultTokenEl.value.trim() : '')
    };
  }

  await persistConfig(silent ? null : '系统参数已保存并立即生效');
}


async function saveSettingsAndVerify(){
  await saveSettings(true);
  const models = Object.keys(state.config.agent_models || {});
  if(!models.length){
    toast('配置已保存。当前未配置任何 Agent 模型进行测试', 'info');
    return;
  }
  const testModel = models[0];
  switchTab('models');
  switchModelTab('agents');
  toast(`配置已保存！正在对首选模型 [${testModel}] 进行端到端生产连通性实测...`, 'info');
  setTimeout(() => {
    runLiveTest(testModel);
  }, 350);
}



/* === Module: app.js === */
/**
 * OCRProxy Admin - Application Entry Point & Lifecycle Bootstrap
 */
document.addEventListener("DOMContentLoaded", async () => {
  // Global Esc key modal close
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      const activeModal = document.querySelector(".modal.show");
      if (activeModal) {
        closeModal(activeModal.id);
      }
    }
  });

  // Modal backdrop click outside to close (Bootstrap standard dual-phase verification)
  // Prevents modal from closing when dragging mouse to select text inside inputs/modals
  document.querySelectorAll(".modal").forEach((m) => {
    let isBackdropMouseDown = false;

    m.addEventListener("mousedown", (e) => {
      isBackdropMouseDown = (e.target === m);
    });

    m.addEventListener("click", (e) => {
      if (isBackdropMouseDown && e.target === m) {
        closeModal(m.id);
      }
      isBackdropMouseDown = false;
    });
  });

  // Initial Auth & Data Load
  if (state.key) {
    showApp();
    renderNav();
    await loadData();
    // Load presets catalog
    loadPresetsCatalog();
    // Pre-fetch EdgeOne Vault manifest silently
    fetchVaultManifest(true);
  } else {
    showLogin();
  }
});


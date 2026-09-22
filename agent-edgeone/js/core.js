/**
 * OCRProxy Admin - Core Framework & UI Foundation
 */
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
    const [cr,sr]=await Promise.all([fetch('/api/admin/config',{headers:headers()}), fetch('/api/admin/stats',{headers:headers()})]);
    if(cr.status===401||sr.status===401){ logout(); return; }
    state.config=await cr.json(); state.stats=await sr.json();
    fetchVaultManifest(true); // background silent fetch
    updateAccess(); render();
  } catch(e){ toast('加载配置失败: '+e.message,'err'); }
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

  // Top header badge
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

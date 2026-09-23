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
  const hasVault = !!(state.config?.edgeone_vault && (state.config.edgeone_vault.edgeone_url || state.config.edgeone_vault.url));
  const syncBtn = document.getElementById('btnSyncVaultInAgentModal');
  if (syncBtn) syncBtn.style.display = hasVault ? 'inline-flex' : 'none';
  if (optVault) optVault.style.display = hasVault ? '' : 'none';

  const providers = getAllAvailableProviders();

  const localList = providers.filter(p => !p.isVault);
  const vaultList = providers.filter(p => p.isVault);

  if (optLocal) {
    optLocal.innerHTML = localList.length
      ? localList.map(p => `<option value="${esc(p.id)}">${esc(p.label)} (${esc(p.protoStr)})</option>`).join('')
      : '<option value="" disabled selected>-- 当前暂无可用供应商 (请先新建供应商) --</option>';
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
    if(protoInfoEl) {
      const providers = getAllAvailableProviders();
      if (!providers || providers.length === 0) {
        protoInfoEl.innerHTML = `
          <div style="background:var(--bg-subtle);border:1px dashed var(--primary);border-radius:6px;padding:10px 14px;display:flex;align-items:center;justify-content:space-between;margin:6px 0;width:100%;">
            <div style="font-size:12px;color:var(--text);line-height:1.5;">
              <strong>尚未添加供应商</strong>：请先新建供应商（支持选用 AMD、DeepSeek 等 11 家官方厂商并秒级自动填充规则与模型）
            </div>
            <button type="button" class="btn btn-sm btn-primary" onclick="openProviderModal('agent')" style="font-size:12px;padding:3px 10px;white-space:nowrap;margin-left:12px;">
              + 立即新建供应商
            </button>
          </div>`;
      } else {
        protoInfoEl.innerHTML = `<span style="display:inline-flex;align-items:center;gap:4px;">${icon('info', 14)}</span> 请先选择或新建供应商。`;
      }
    }
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

  const hasVault = !!(state.config?.edgeone_vault && (state.config.edgeone_vault.edgeone_url || state.config.edgeone_vault.url));
  const syncCandidateBtn = document.getElementById('btnSyncVaultInCandidateModal');
  if (syncCandidateBtn) syncCandidateBtn.style.display = hasVault ? 'inline-flex' : 'none';
  if (optVault) optVault.style.display = hasVault ? '' : 'none';

  const providers = getAllAvailableProviders();
  const localList = providers.filter(p => !p.isVault);
  const vaultList = providers.filter(p => p.isVault);

  if (optLocal) {
    optLocal.innerHTML = localList.length
      ? localList.map(p => `<option value="${esc(p.id)}">${esc(p.label)} (${esc(p.protoStr)})</option>`).join('')
      : '<option value="" disabled selected>-- 当前暂无可用供应商 (请先新建供应商) --</option>';
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
    if(protoInfoEl) {
      const providers = getAllAvailableProviders();
      if (!providers || providers.length === 0) {
        protoInfoEl.innerHTML = `
          <div style="background:var(--bg-subtle);border:1px dashed var(--primary);border-radius:6px;padding:10px 14px;display:flex;align-items:center;justify-content:space-between;margin:6px 0;width:100%;">
            <div style="font-size:12px;color:var(--text);line-height:1.5;">
              <strong>尚未添加供应商</strong>：请先新建供应商节点
            </div>
            <button type="button" class="btn btn-sm btn-primary" onclick="openProviderModal('candidate')" style="font-size:12px;padding:3px 10px;white-space:nowrap;margin-left:12px;">
              + 立即新建供应商
            </button>
          </div>`;
      } else {
        protoInfoEl.innerHTML = '';
      }
    }
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

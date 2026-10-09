/**
 * OCRProxy Admin - Knowledge Base (KB) Virtual Models & Candidate Routing
 */
if (typeof getModelProtocols === 'undefined') {
  function getModelProtocols(modelName){
    const m = state.config && state.config.agent_models ? state.config.agent_models[modelName] : null;
    if (!m || !m.keys || !m.keys.length) return ['chat'];
    const set = new Set();
    for (const b of m.keys) {
      const provProtos = (typeof getProviderProtocols === 'function') ? getProviderProtocols(b.provider) : ['chat'];
      provProtos.forEach(pr => set.add(pr));
    }
    return set.size ? Array.from(set) : ['chat'];
  }
}

function renderKbModels(){
  const box = document.getElementById('kbModelsBox');
  if (!box) return;
  const status = state.stats.candidates_status || {};
  box.innerHTML = KB_TYPES.map(type => {
    const list = (state.config.candidates || {})[type] || [];
    const rows = list.map((c, i) => renderKbBindingRow(i + 1, c, type, i, status));
    return `<div class="card model-card">
      <div class="card-head">
        <div>
          <div class="model-id" style="font-size:14px;font-weight:700;">${KB_LABELS[type]} <span class="badge badge-neutral" style="font-weight:400;margin-left:6px;">model="${type}"</span></div>
          <div class="meta" style="margin-top:2px;">${list.length} 个挂载候选节点 · 按序故障切换</div>
        </div>
        <button class="btn btn-sm btn-primary" onclick="openCandidateModal('${type}')">+ 挂载节点</button>
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

function renderKbBindingRow(idx, binding, type, i, status){
  const nk = 'kb:' + type + ':' + binding.provider + ':' + binding.key + (binding.model ? (':' + binding.model) : '');
  const ns = status[nk] || status['kb:' + type + ':' + binding.provider + ':' + binding.key] || status[binding.provider + ':' + binding.key + ':' + type];
  let badge = '<span class="badge badge-neutral">未调用</span>', time = '—';
  if (ns) { 
    if (ns.is_quota || ns.status === 'quota') {
      badge = `<span class="badge badge-error" style="font-weight:700;">欠费</span>`;
    } else if (ns.status === 429) {
      badge = `<span class="badge badge-warn" style="font-weight:700;">429 限流</span>`;
    } else if (ns.status === 200) {
      if (ns.latency_ms !== null && ns.latency_ms !== undefined && ns.latency_ms > 0) {
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
  const modelCell = `<td class="mono truncate" title="${esc(binding.model)}"><b>${esc(binding.model)}</b></td>`;
  
  const probeKeyId = 'kb:' + type + (binding.model ? ':' + binding.model : '') + ':' + binding.provider + ':' + binding.key;
  const isProbing = state.probingKeys.has(probeKeyId);

  const keyBadgeHtml = `<span class="badge badge-neutral">${esc(binding.key)}</span>`;
  const totalCount = ((state.config.candidates || {})[type] || []).length;

  const orderInputHtml = `<input type="number" min="1" max="${totalCount}" value="${idx}" 
      style="width:38px;height:22px;text-align:center;font-size:12px;font-weight:700;padding:0;border:1px solid #d0d7de;border-radius:4px;"
      onchange="reorderCandidate('${type}', ${i}, this.value)" title="修改数字直接调整顺序">`;

  const actions = `
    <button class="btn btn-icon btn-sm btn-secondary" id="probeBtn-${esc(probeKeyId)}" onclick="testCandidate('${type}',${i})" title="测试此 Key 连通性" ${isProbing ? 'disabled' : ''}>
      ${isProbing ? '<span class="spinner"></span>' : '测'}
    </button>
    <button class="btn btn-icon btn-sm btn-secondary-danger" onclick="deleteCandidate('${type}',${i})" title="删除">×</button>`;

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
    if (localList.length > 0) {
      optLocal.innerHTML = localList.map(p => {
        const protoSuffix = p.protoStr ? ` · ${esc(p.protoStr)}` : '';
        return `<option value="${esc(p.id)}">${esc(p.label)}${protoSuffix}</option>`;
      }).join('');
    } else if (vaultList.length > 0) {
      optLocal.innerHTML = '<option value="" disabled>-- 暂无本地自建供应商 --</option>';
    } else {
      optLocal.innerHTML = '<option value="" disabled selected>-- 当前暂无可用供应商 (请先新建供应商) --</option>';
    }
  }
  if (optVault) {
    optVault.innerHTML = vaultList.length
      ? vaultList.map(p => {
          const protoSuffix = p.protoStr ? ` · ${esc(p.protoStr)}` : '';
          return `<option value="${esc(p.id)}">${esc(p.label)}${protoSuffix}</option>`;
        }).join('')
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
      const badgeHtml = renderProtocolBadges(provProtos);
      let actionBtnHtml = '';
      if (localProv && remoteProv) {
        actionBtnHtml = `<button type="button" class="btn btn-sm btn-secondary" onclick="switchLocalProviderToVault('${esc(val)}')" style="font-size:11px;padding:2px 8px;margin-left:auto;display:inline-flex;align-items:center;gap:4px;" title="清理本地自建配置，切换使用 EdgeOne 中枢统一托管"><svg class="khc-icon" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z"/></svg><span>切换为中枢托管 (清理本地自建)</span></button>`;
      } else if (localProv) {
        actionBtnHtml = `<button type="button" class="btn btn-sm btn-ghost" onclick="deleteLocalProviderFromModal('${esc(val)}')" style="color:var(--error);font-size:11px;padding:2px 6px;margin-left:auto;" title="彻底删除此本地自建供应商">🗑️ 删除此本地供应商</button>`;
      }
      protoInfoEl.innerHTML = `<div style="display:flex;align-items:center;gap:8px;width:100%;flex-wrap:wrap;">${badgeHtml}${actionBtnHtml}</div>`;
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

      return `<div class="key-capsule ${isChecked ? 'checked' : ''}" onclick="toggleCandidateKeyCapsule(this)">
        <input type="checkbox" value="${esc(k)}" data-is-local="${isLocal}" ${isChecked ? 'checked' : ''} style="display:none;">
        <span style="font-weight:600;">${esc(k)}</span>
        ${tag}
        ${deleteBtn}
      </div>`;
    }).join('');
  }
}

function toggleCandidateKeyCapsule(el){
  const inp = el.querySelector('input[type="checkbox"]');
  if(!inp) return;
  inp.checked = !inp.checked;
  el.classList.toggle('checked', inp.checked);
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

if (typeof window.switchLocalProviderToVault !== 'function') {
  window.switchLocalProviderToVault = async function(provId) {
    if (!provId) return;
    if (!confirm(`确定要清理本地自建的供应商 [${provId}] 并切换为使用 EdgeOne 中枢托管吗？\n\n清理后将自动切换为中枢统一分发的密钥与规则。`)) {
      return;
    }
    if (state.config && state.config.providers && state.config.providers[provId]) {
      delete state.config.providers[provId];
      await persistConfig(`已清理本地自建供应商 [${provId}]，现已切换为中枢托管`);
      toast(`已成功切换为 EdgeOne 中枢托管 [${provId}]`, 'ok');
      if (typeof populateAgentProviderSelect === 'function') populateAgentProviderSelect(provId);
      if (typeof populateCandidateProviderSelect === 'function') populateCandidateProviderSelect(provId);
      if (typeof renderProviders === 'function') renderProviders();
    }
  };
}

if (typeof window.deleteLocalProviderFromModal !== 'function') {
  window.deleteLocalProviderFromModal = async function(provId) {
    if (!provId) return;
    if (!confirm(`确定要彻底删除本地自建供应商 [${provId}] 吗？`)) {
      return;
    }
    if (state.config && state.config.providers) {
      const targetKey = Object.keys(state.config.providers).find(k => k.toLowerCase() === provId.toLowerCase()) || provId;
      if (state.config.providers[targetKey]) {
        delete state.config.providers[targetKey];
      }
      if (state.config.providers[provId]) {
        delete state.config.providers[provId];
      }
      if (state.config.agent_models) {
        Object.values(state.config.agent_models).forEach(m => {
          m.keys = (m.keys || []).filter(x => x.provider.toLowerCase() !== provId.toLowerCase());
        });
      }
      await persistConfig(`本地供应商 [${provId}] 已删除并立即生效`);
      toast(`供应商 [${provId}] 已删除`, 'ok');
      if (typeof populateAgentProviderSelect === 'function') populateAgentProviderSelect('');
      if (typeof populateCandidateProviderSelect === 'function') populateCandidateProviderSelect('');
      if (typeof renderProviders === 'function') renderProviders();
    }
  };
}

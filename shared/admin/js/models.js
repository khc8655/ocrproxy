/**
 * OCRProxy Admin - Knowledge Base (KB) Virtual Models & Candidate Routing
 */

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
        <table style="table-layout: fixed; width: 100%;">
          <colgroup>
            <col style="width: 52px;">
            <col style="width: 130px;">
            <col style="width: 140px;">
            <col style="width: 80px;">
            <col style="width: 170px;">
            <col style="width: 130px;">
            <col style="width: 140px;">
            <col style="width: 120px;">
          </colgroup>
          <thead><tr><th style="width:52px;text-align:center;">#</th><th style="width:130px;">供应商</th><th style="width:140px;">Key 别名</th><th style="width:80px;text-align:center;">来源</th><th style="width:170px;">上游实际模型 ID</th><th style="width:130px;text-align:center;">响应耗时 / 状态</th><th style="width:140px;text-align:center;">最近调用</th><th style="width:120px;text-align:right;">操作</th></tr></thead>
          <tbody>${rows.length ? rows.join('') : '<tr><td colspan="8" class="empty">暂无候选节点</td></tr>'}</tbody>
        </table>
      </div>
    </div>`;
  }).join('');
}

function renderKbBindingRow(idx, binding, type, i, status){
  const nk = 'kb:' + type + ':' + binding.provider + ':' + binding.key + (binding.model ? (':' + binding.model) : '');
  let ns = status[nk] || status['kb:' + type + ':' + binding.provider + ':' + binding.key] || status[binding.provider + ':' + binding.key + ':' + type];

  if (!ns && typeof window !== 'undefined') {
    if (!window.modelLatencyCache) {
      try {
        const saved = localStorage.getItem('ocrprox_model_latency_cache');
        if (saved) window.modelLatencyCache = JSON.parse(saved);
      } catch (_) {}
    }
    if (window.modelLatencyCache) {
      ns = window.modelLatencyCache[nk] ||
           window.modelLatencyCache[`prov:${binding.provider}:${binding.key}`];
    }
  }
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
  const modelCell = `<td style="width:170px;" class="mono truncate" title="${esc(binding.model)}"><b>${esc(binding.model)}</b></td>`;
  
  const probeKeyId = 'kb:' + type + (binding.model ? ':' + binding.model : '') + ':' + binding.provider + ':' + binding.key;
  const isProbing = state.probingKeys.has(probeKeyId);

  const keyBadgeHtml = `<span class="mono" style="font-weight:600;color:var(--text);font-size:12px;background:var(--bg-subtle);padding:2px 8px;border-radius:var(--radius-sm);border:1px solid var(--border);">${esc(binding.key)}</span>`;
  const totalCount = ((state.config.candidates || {})[type] || []).length;

  const orderInputHtml = `<input type="number" min="1" max="${totalCount}" value="${idx}" 
      style="width:38px;height:22px;text-align:center;font-size:12px;font-weight:700;padding:0;border:1px solid #d0d7de;border-radius:4px;"
      onwheel="this.blur()"
      onchange="reorderCandidate('${type}', ${i}, this.value)" title="修改数字直接调整顺序">`;

  const actions = `
    <button class="btn btn-icon btn-sm btn-secondary" id="probeBtn-${esc(probeKeyId)}" onclick="testCandidate('${type}',${i})" title="测试此 Key 连通性" ${isProbing ? 'disabled' : ''}>
      ${isProbing ? '<span class="spinner"></span>' : '测'}
    </button>
    <button class="btn btn-icon btn-sm btn-secondary-danger" onclick="deleteCandidate('${type}',${i})" title="删除">×</button>`;

  const sourceBadge = (typeof _getKeySourceBadge === 'function')
    ? _getKeySourceBadge(binding.provider, binding.key, binding)
    : '<span class="badge badge-success" style="font-size:11px;padding:2px 6px;">本地</span>';

  return `<tr>
    <td style="width:52px;text-align:center;">${orderInputHtml}</td>
    <td style="width:130px;" class="truncate" title="${esc(binding.provider)}"><b>${esc(binding.provider)}</b></td>
    <td style="width:140px;" class="truncate" title="${esc(binding.key)}">${keyBadgeHtml}</td>
    <td style="width:80px;text-align:center;">${sourceBadge}</td>
    ${modelCell}
    <td style="width:130px;text-align:center;">${badge}</td>
    <td style="width:140px;text-align:center;" class="text-sm text-secondary">${time}</td>
    <td style="width:120px;text-align:right;"><div class="flex gap-2" style="justify-content:flex-end;align-items:center;">${actions}</div></td>
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
  const curId = populateLocalProviderSelect('c_providerSelect', 'c_optgroup_local', selectedId);
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
          <div style="background:var(--bg-subtle);border:1px dashed var(--border);border-radius:6px;padding:10px 14px;margin:6px 0;width:100%;">
            <div style="font-size:12px;color:var(--text-secondary);line-height:1.5;">
              尚未添加供应商，请前往「供应商」界面进行添加与配置。
            </div>
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
      protoInfoEl.innerHTML = `<div style="display:flex;align-items:center;gap:8px;width:100%;flex-wrap:wrap;">${badgeHtml}</div>`;
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
  const quickBox = document.getElementById('c_quickModels');
  const quickTags = document.getElementById('c_quickTags');
  if(quickBox) quickBox.style.display = 'none';
  if(quickTags) quickTags.innerHTML = '';
}

const KB_MODAL_ROLE_TITLES = {
  chat: '对话与摘要 (Chat)',
  ocr: '图文多模态识别 (OCR)',
  embedding: '向量嵌入 (Embedding)',
  reranker: '语义重排 (Reranker)'
};

async function openCandidateModal(type){
  const curType = type || 'chat';
  const typeLabel = KB_MODAL_ROLE_TITLES[curType] || ((typeof KB_LABELS !== 'undefined' && KB_LABELS[curType]) ? KB_LABELS[curType] : curType);
  const titleEl = document.getElementById('candidateModalTitle');
  if (titleEl) titleEl.textContent = `挂载 ${typeLabel} 节点`;
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
    box.innerHTML='<div class="hint" style="color:var(--text-secondary);font-size:12px;padding:8px;">该供应商下暂无可用 Key，请前往「供应商」页面添加 Key 凭证</div>';
  } else {
    box.innerHTML=allKeyLabels.map((k, idx)=>{
      const src = (typeof resolveKeySource === 'function') ? resolveKeySource(prov, k) : (remoteKeys.includes(k) ? 'vault' : 'local');
      const isVault = src === 'vault';
      const isLocal = src === 'local';
      const isChecked = idx === 0;
      const tag = (typeof keySourceBadge === 'function')
        ? keySourceBadge(src, 10)
        : (isVault 
          ? `<span class="badge badge-primary" style="font-size:10px;padding:0 6px;">${icon('cloud', 11)} 中枢</span>`
          : `<span class="badge badge-success" style="font-size:10px;padding:0 6px;">${icon('check', 11)} 本地</span>`);

      return `<div class="key-capsule ${isChecked ? 'checked' : ''}" onclick="toggleCandidateKeyCapsule(this)">
        <input type="checkbox" value="${esc(k)}" data-is-local="${isLocal}" ${isChecked ? 'checked' : ''} style="display:none;">
        <span style="font-weight:600;">${esc(k)}</span>
        ${tag}
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

async function editCandidate(type,i){
  const c=state.config.candidates[type][i];
  const typeLabel = (typeof KB_LABELS !== 'undefined' && KB_LABELS[type]) ? KB_LABELS[type] : type;
  document.getElementById('candidateModalTitle').textContent = `编辑 ${typeLabel} 节点`;
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

  const isMatch = (item, p, k, m) =>
    item &&
    (item.provider || '').toLowerCase() === (p || '').toLowerCase() &&
    item.key === k &&
    (item.model || '') === m;

  if(editCat&&editIdx!==''){
    const idx = parseInt(editIdx, 10);
    const targetCat = type;
    if (!state.config.candidates[targetCat]) state.config.candidates[targetCat] = [];

    // Check if selected[0] already exists in targetCat (excluding current index if editing in same category)
    const duplicate = state.config.candidates[targetCat].some((c, i) => {
      if (targetCat === editCat && i === idx) return false;
      return isMatch(c, provider, selected[0], model);
    });

    if (duplicate && selected.length === 1) {
      toast(`候选节点 [${provider}/${selected[0]}/${model}] 已在 [${targetCat}] 中存在，请勿重复添加`, 'err');
      return;
    }

    if (targetCat === editCat) {
      state.config.candidates[editCat][idx] = { provider, key: selected[0], model };
    } else {
      state.config.candidates[editCat].splice(idx, 1);
      if (!duplicate) {
        state.config.candidates[targetCat].push({ provider, key: selected[0], model });
      }
    }

    // Additional selected keys
    for(let i=1; i<selected.length; i++){
      const k = selected[i];
      const exists = state.config.candidates[targetCat].some(c => isMatch(c, provider, k, model));
      if (!exists) {
        state.config.candidates[targetCat].push({ provider, key: k, model });
      }
    }
  } else {
    const existingList = state.config.candidates[type] || [];
    const newKeys = selected.filter(k => !existingList.some(c => isMatch(c, provider, k, model)));

    if (newKeys.length === 0) {
      toast(`候选节点 [${provider}/${model}] 已绑定所选 Key，请勿重复添加`, 'err');
      return;
    }

    newKeys.forEach(k => state.config.candidates[type].push({ provider, key: k, model }));
    if (newKeys.length < selected.length) {
      toast(`已挂载 ${newKeys.length} 个新节点，自动跳过 ${selected.length - newKeys.length} 个已存在节点`, 'info');
    }
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
    if(typeof window !== 'undefined'){
      window.modelLatencyCache = window.modelLatencyCache || {};
      const cacheEntry = {
        ok: !!d.success,
        latency_ms: latency,
        status: d.success ? 200 : (d.status || 500),
        time: Date.now()
      };
      window.modelLatencyCache[probeKeyId] = cacheEntry;
      window.modelLatencyCache[`prov:${c.provider}:${c.key}`] = cacheEntry;
      try {
        localStorage.setItem('ocrprox_model_latency_cache', JSON.stringify(window.modelLatencyCache));
      } catch (_) {}
    }
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

// Settings and LiveTest are handled by shared components (agent-models-ui.js)




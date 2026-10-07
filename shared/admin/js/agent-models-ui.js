/**
 * agent-models-ui.js — Unified Agent Models Management Component
 * Shared across VM App and EdgeOne Admin UI
 *
 * Provides:
 *  - renderAgentModels()
 *  - renderAgentBindingRow()
 *  - openAgentModal() / editAgentModel() / saveAgentModel() / deleteAgentModel()
 *  - reorderAgentKey() / setActiveAgentKey() / deleteAgentKey()
 *  - testAgentKey() / testAgentModelAll() / runLiveTest()
 *  - executeProbe() / filterProbedModels() / selectProbedModel()
 */

(function(global){
  'use strict';

  // State draft for modal key bindings to prevent multi-provider binding loss
  let modalBindings = [];

  // Event Delegation Initializers (eliminates inline JS interpolation & XSS vectors)
  function initAgentModelsDelegation() {
    const box = document.getElementById('agentModelsBox');
    if (!box || box._hasDelegated) return;
    box._hasDelegated = true;

    box.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-action]');
      if (!btn) return;
      const action = btn.dataset.action;
      const model = btn.dataset.model;
      if (!action) return;

      if (action === 'edit-model') {
        editAgentModel(model);
      } else if (action === 'delete-model') {
        deleteAgentModel(model);
      } else if (action === 'probe-model-all') {
        testAgentModelAll(model);
      } else if (action === 'set-active-key') {
        const key = btn.dataset.key;
        setActiveAgentKey(model, key);
      } else if (action === 'probe-key') {
        const idx = parseInt(btn.dataset.index, 10);
        testAgentKey(model, idx);
      } else if (action === 'delete-key') {
        const idx = parseInt(btn.dataset.index, 10);
        deleteAgentKey(model, idx);
      } else if (action === 'collapse-panel') {
        const panel = btn.closest('[id^="liveTestRes-"]') || btn.closest('[id^="agentProbe-"]');
        if (panel) panel.style.display = 'none';
      }
    });

    box.addEventListener('change', (e) => {
      const input = e.target.closest('[data-action="reorder-key"]');
      if (!input) return;
      const model = input.dataset.model;
      const idx = parseInt(input.dataset.index, 10);
      reorderAgentKey(model, idx, input.value);
    });
  }

  function initModalDelegation() {
    const keyList = document.getElementById('a_keyList');
    if (keyList && !keyList._hasDelegated) {
      keyList._hasDelegated = true;
      keyList.addEventListener('click', (e) => {
        const delBtn = e.target.closest('[data-action="remove-local-key"]');
        if (delBtn) {
          e.stopPropagation();
          removeLocalKeyFromModal(delBtn.dataset.prov, delBtn.dataset.key, e);
          return;
        }
        const cap = e.target.closest('.key-capsule');
        if (cap) {
          toggleKeyCapsule(cap);
        }
      });
    }

    const summaryBox = document.getElementById('a_selectedBindingsSummary');
    if (summaryBox && !summaryBox._hasDelegated) {
      summaryBox._hasDelegated = true;
      summaryBox.addEventListener('click', (e) => {
        const rmBtn = e.target.closest('[data-action="remove-modal-binding"]');
        if (rmBtn) {
          e.stopPropagation();
          const p = rmBtn.dataset.prov;
          const k = rmBtn.dataset.key;
          modalBindings = modalBindings.filter(b => !(b.provider === p && b.key === k));
          renderAgentKeyChecks();
        }
      });
    }

    const quickTags = document.getElementById('a_quickTags');
    if (quickTags && !quickTags._hasDelegated) {
      quickTags._hasDelegated = true;
      quickTags.addEventListener('click', (e) => {
        const cap = e.target.closest('[data-action="apply-quick-model"]');
        if (cap) {
          applyAgentQuickModel(cap.dataset.name, cap.dataset.upstream, cap);
        }
      });
    }

    const probedList = document.getElementById('probedModelsList');
    if (probedList && !probedList._hasDelegated) {
      probedList._hasDelegated = true;
      probedList.addEventListener('click', (e) => {
        const item = e.target.closest('[data-action="select-probed-model"]');
        if (item) {
          selectProbedModel(item.dataset.model);
        }
      });
    }

    const protoInfo = document.getElementById('a_model_proto_info');
    if (protoInfo && !protoInfo._hasDelegated) {
      protoInfo._hasDelegated = true;
      protoInfo.addEventListener('click', (e) => {
        const switchBtn = e.target.closest('[data-action="switch-provider-vault"]');
        if (switchBtn) {
          switchLocalProviderToVault(switchBtn.dataset.prov);
          return;
        }
        const delProvBtn = e.target.closest('[data-action="delete-local-provider"]');
        if (delProvBtn) {
          deleteLocalProviderFromModal(delProvBtn.dataset.prov);
          return;
        }
      });
    }
  }

  // 1. Internal Context Resolution & Fallbacks
  function getCtx() {
    const isVm = (typeof state !== 'undefined' && state && state.config);
    const cfgObj = isVm ? state.config : (typeof cfg !== 'undefined' ? cfg : {});
    const statsObj = isVm ? (state.stats || {}) : { candidates_status: {} };
    const probingKeysSet = isVm ? state.probingKeys : (window._probingKeys = window._probingKeys || new Set());
    const probingModelsSet = isVm ? state.probingModels : (window._probingModels = window._probingModels || new Set());
    return { isVm, cfg: cfgObj, stats: statsObj, probingKeys: probingKeysSet, probingModels: probingModelsSet };
  }

  function _esc(s) {
    if (typeof esc === 'function') return esc(s);
    if (s === null || s === undefined) return '';
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function _toast(msg, type) {
    if (typeof toast === 'function') {
      toast(msg, type);
    } else {
      console.log(`[Toast ${type}]`, msg);
    }
  }

  function _openModal(id) {
    if (typeof openModal === 'function') openModal(id);
    else {
      const el = document.getElementById(id);
      if (el) el.style.display = 'flex';
    }
  }

  function _closeModal(id) {
    if (typeof closeModal === 'function') closeModal(id);
    else {
      const el = document.getElementById(id);
      if (el) el.style.display = 'none';
    }
  }

  function _fmtTime(ts) {
    if (typeof fmtTime === 'function') return fmtTime(ts);
    if (!ts) return '—';
    try {
      const d = new Date(ts);
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

  function _getHeaders() {
    if (typeof headers === 'function') return headers();
    const token = (typeof getAuthToken === 'function' ? getAuthToken() : (localStorage.getItem('ocrproxy_edge_token') || ''));
    return {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + token
    };
  }

  function _getAuthKeyForChat() {
    const { cfg } = getCtx();
    const clientKey = (typeof getClientKey === 'function') ? getClientKey() : (cfg.proxy_api_key || '');
    if (clientKey) return clientKey;
    const token = localStorage.getItem('ocrproxy_edge_token') || '';
    if (token) return token;
    if (typeof state !== 'undefined' && state.adminPassword) return state.adminPassword;
    return '';
  }

  async function _persist(summary) {
    if (typeof persistConfig === 'function') {
      return await persistConfig(summary);
    }
    if (typeof saveConfigToKv === 'function') {
      return await saveConfigToKv(summary);
    }
    _toast('已更新配置（未检测到持久化回调）', 'info');
  }

  // 2. Protocols and Provider Discovery
  function _getModelProtocols(modelName) {
    const { cfg } = getCtx();
    const m = cfg && cfg.agent_models ? cfg.agent_models[modelName] : null;
    if (!m || !m.keys || !m.keys.length) return ['chat'];
    const set = new Set();
    for (const b of m.keys) {
      const provProtos = (typeof getProviderProtocols === 'function') 
        ? getProviderProtocols(b.provider) 
        : ['chat'];
      provProtos.forEach(pr => set.add(pr));
    }
    return set.size ? Array.from(set) : ['chat'];
  }

  function _renderProtocolBadges(protoList, isShort = true) {
    if (typeof renderProtocolBadges === 'function') {
      return renderProtocolBadges(protoList, isShort);
    }
    return (protoList || ['chat']).map(pr => {
      const p = String(pr).toLowerCase();
      let cls = 'badge-neutral', label = p;
      if (p.includes('chat') || p === 'openai') { cls = 'badge-success'; label = 'chat'; }
      else if (p.includes('message') || p === 'anthropic') { cls = 'badge-warn'; label = 'messages'; }
      else if (p.includes('response')) { cls = 'badge-primary'; label = 'responses'; }
      return `<span class="badge ${cls}" style="font-weight:600;font-size:11px;padding:2px 7px;">${_esc(label)}</span>`;
    }).join(' ');
  }

  function _getAllProvidersList() {
    let list = [];
    if (typeof getAllAvailableProviders === 'function') {
      list = getAllAvailableProviders();
    } else {
      const { cfg } = getCtx();
      const provs = cfg.providers || {};
      list = Object.keys(provs).sort().map(id => {
        const p = provs[id];
        const protoList = (typeof getProviderProtocols === 'function') ? getProviderProtocols(id) : ['chat'];
        return {
          id,
          label: p.label || id,
          isVault: false,
          protoStr: protoList.join(', ')
        };
      });
    }

    // 保证 OpenCode 免费专区 (opencode-free) 选项始终可用
    const hasOpencode = list.some(p => p.id === 'opencode');
    const hasFree = list.some(p => p.id === 'opencode-free');
    if (hasOpencode && !hasFree) {
      const opIdx = list.findIndex(p => p.id === 'opencode');
      list.splice(opIdx + 1, 0, {
        id: 'opencode-free',
        label: 'OpenCode Free (免费专区)',
        isVault: false,
        protoStr: 'OpenAI',
        protocols: ['chat']
      });
    }
    return list;
  }

  // 3. Probed Upstream Models State
  let _currentProbedModels = [];
  let _probeTargetModal = 'agent';

  async function executeProbe(targetModal) {
    _probeTargetModal = targetModal || 'agent';
    const isAgent = _probeTargetModal === 'agent';
    const btn = document.getElementById(isAgent ? 'btnProbeAgentModels' : 'btnProbeCandidateModels');
    const selVal = document.getElementById(isAgent ? 'a_providerSelect' : 'c_providerSelect')?.value;

    if (!selVal) {
      _toast('请先选择上方供应商', 'err');
      return;
    }

    const keyContainerId = isAgent ? '#a_keyList' : '#c_keyList';
    const checkedBoxes = Array.from(document.querySelectorAll(`${keyContainerId} input[type="checkbox"]:checked`));
    const keyLabels = checkedBoxes.map(b => b.value);

    const { cfg } = getCtx();
    let probeBaseUrl = '';
    const provs = cfg?.providers || {};
    const localProv = provs[selVal] || Object.entries(provs).find(([k]) => k.toLowerCase() === selVal.toLowerCase())?.[1];
    if (localProv?.base_url) {
      probeBaseUrl = localProv.base_url;
    } else if (window.PRESET_DEFINITIONS && window.PRESET_DEFINITIONS[selVal]?.base_url) {
      probeBaseUrl = window.PRESET_DEFINITIONS[selVal].base_url;
    }

    if (btn) { btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> 探测中...'; }

    try {
      const res = await fetch('/api/admin/probe-models', {
        method: 'POST',
        headers: _getHeaders(),
        body: JSON.stringify({
          provider: selVal,
          base_url: probeBaseUrl,
          key_label: keyLabels[0] || '',
          key_labels: keyLabels
        })
      });
      const data = await res.json();
      if (!data.ok || !data.models || data.models.length === 0) {
        _toast(data.error || '未探测到可用模型列表，请检查供应商网络或凭据', 'err');
        return;
      }

      _currentProbedModels = data.models;
      const titleSuffix = data.used_key_label ? ` (使用凭据: ${data.used_key_label})` : '';
      const titleEl = document.getElementById('probedModalTitle');
      if (titleEl) titleEl.textContent = `供应商 [${selVal}] 上游可用模型 (${data.models.length})${titleSuffix}`;
      const searchInp = document.getElementById('probedSearchInput');
      if (searchInp) searchInp.value = '';
      renderProbedModelsList(_currentProbedModels);
      _openModal('probedListModal');
      const succMsg = data.used_key_label ? `使用凭据 [${data.used_key_label}] 探测成功，发现 ${data.models.length} 个模型` : `成功探测到 ${data.models.length} 个可用模型`;
      _toast(succMsg, 'ok');
    } catch(e) {
      _toast(`探测模型异常: ${e.message}`, 'err');
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
    if (!listEl) return;

    if (!models.length) {
      listEl.innerHTML = '<div class="empty" style="padding:20px;">无匹配的模型</div>';
      return;
    }

    listEl.innerHTML = models.map(m => `
      <div class="probed-item" data-action="select-probed-model" data-model="${_esc(m)}">
        <span class="mono" style="font-size:13px;font-weight:600;color:var(--text, var(--color-text-1));word-break:break-all;">${_esc(m)}</span>
        <button type="button" class="btn btn-sm btn-primary" data-action="select-probed-model" data-model="${_esc(m)}" style="padding:3px 10px;font-size:11px;">选取</button>
      </div>
    `).join('');
    initModalDelegation();
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
      const aName = document.getElementById('a_name');
      const aUpstream = document.getElementById('a_upstream');
      if (aName) aName.value = modelName;
      if (aUpstream) aUpstream.value = modelName;
    } else {
      const cModel = document.getElementById('c_model');
      if (cModel) cModel.value = modelName;
    }
    _closeModal('probedListModal');
    _toast(`已选取模型: ${modelName}`, 'ok');
  }

  function applyAgentQuickModel(name, upstream, el) {
    const aName = document.getElementById('a_name');
    const aUpstream = document.getElementById('a_upstream');
    if (aName) aName.value = name;
    if (aUpstream) aUpstream.value = upstream || name;
    document.querySelectorAll('#a_quickTags .model-capsule').forEach(c => c.classList.remove('active'));
    if (el) el.classList.add('active');
    _toast(`已填入模型: ${name}`, 'info');
  }

  function toggleKeyCapsule(el) {
    const inp = el.querySelector('input[type="checkbox"]');
    if (!inp) return;
    inp.checked = !inp.checked;
    el.classList.toggle('checked', inp.checked);
    const prov = inp.dataset.provider || document.getElementById('a_provider')?.value || '';
    const keyVal = inp.value;
    if (inp.checked) {
      if (!modalBindings.some(b => b.provider === prov && b.key === keyVal)) {
        modalBindings.push({ provider: prov, key: keyVal });
      }
    } else {
      modalBindings = modalBindings.filter(b => !(b.provider === prov && b.key === keyVal));
    }
    _renderSelectedBindingsSummary();
  }

  function _renderSelectedBindingsSummary() {
    const summaryEl = document.getElementById('a_selectedBindingsSummary');
    if (!summaryEl) return;
    if (!modalBindings || modalBindings.length === 0) {
      summaryEl.innerHTML = '';
      summaryEl.style.display = 'none';
      return;
    }
    const html = modalBindings.map(b => {
      return `<span class="badge" style="display:inline-flex;align-items:center;gap:4px;padding:3px 8px;font-size:11px;background:var(--bg);border:1px solid var(--border);">
        <strong style="color:var(--primary);">${_esc(b.provider)}:</strong> ${_esc(b.key)}
        <button type="button" class="btn-ghost" data-action="remove-modal-binding" data-prov="${_esc(b.provider)}" data-key="${_esc(b.key)}" style="padding:0 2px;margin-left:4px;color:var(--error);font-weight:bold;line-height:1;cursor:pointer;" title="移除此绑定">×</button>
      </span>`;
    }).join('');
    summaryEl.innerHTML = `<div style="font-size:11px;color:var(--text-secondary);margin-bottom:4px;">当前已选绑定 (${modalBindings.length})：</div><div style="display:flex;flex-wrap:wrap;gap:6px;">${html}</div>`;
    summaryEl.style.display = 'block';
  }

  // 4. Populate and Handle Provider Selection in Agent Modal
  function populateAgentProviderSelect(selectedId) {
    const sel = document.getElementById('a_providerSelect');
    const optLocal = document.getElementById('a_optgroup_local');
    const optVault = document.getElementById('a_optgroup_vault');
    if (!sel) return;

    const { cfg } = getCtx();
    const hasVault = !!(cfg && cfg.edgeone_vault && (cfg.edgeone_vault.edgeone_url || cfg.edgeone_vault.url));
    const syncBtn = document.getElementById('btnSyncVaultInAgentModal');
    if (syncBtn) syncBtn.style.display = hasVault ? 'inline-flex' : 'none';
    if (optVault) optVault.style.display = hasVault ? '' : 'none';

    const providers = _getAllProvidersList();
    const localList = providers.filter(p => !p.isVault);
    const vaultList = providers.filter(p => p.isVault);

    if (optLocal) {
      if (localList.length > 0) {
        optLocal.innerHTML = localList.map(p => `<option value="${_esc(p.id)}">${_esc(p.label)} (${_esc(p.protoStr)})</option>`).join('');
      } else if (vaultList.length > 0) {
        optLocal.innerHTML = '<option value="" disabled>-- 暂无本地自建供应商 --</option>';
      } else {
        optLocal.innerHTML = '<option value="" disabled selected>-- 当前暂无可用供应商 (请先新建供应商) --</option>';
      }
    } else {
      sel.innerHTML = providers.length
        ? providers.map(p => `<option value="${_esc(p.id)}">${_esc(p.label)}</option>`).join('')
        : '<option value="" disabled selected>-- 当前暂无可用供应商 (请先新建供应商) --</option>';
    }

    if (optVault) {
      optVault.innerHTML = vaultList.length
        ? vaultList.map(p => `<option value="${_esc(p.id)}">${_esc(p.label)} (${_esc(p.protoStr)})</option>`).join('')
        : '<option disabled>暂无中枢托管供应商</option>';
    }

    const curId = (selectedId && providers.some(p => p.id === selectedId)) 
      ? selectedId 
      : (providers[0] ? providers[0].id : '');
    
    sel.value = curId;
    onAgentProviderSelectChange(curId);
  }

  function onAgentProviderSelectChange(val) {
    const aProv = document.getElementById('a_provider');
    const oldVal = aProv ? aProv.value : '';
    if (aProv) aProv.value = val || '';
    const keyArea = document.getElementById('a_keyArea');
    const quickBox = document.getElementById('a_quickModels');
    const protoInfoEl = document.getElementById('a_model_proto_info');

    // 关键隔离修复：新增模型模式下，切换提供商即代表改变目标厂商，彻底清除非当前厂商的幽灵绑定
    const isNewModel = !document.getElementById('a_oldName')?.value;
    if (isNewModel && oldVal && oldVal !== val) {
      modalBindings = [];
    }

    if (!val) {
      if (keyArea) keyArea.style.display = 'none';
      if (quickBox) quickBox.style.display = 'none';
      if (protoInfoEl) {
        const providers = _getAllProvidersList();
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
          protoInfoEl.innerHTML = '请先选择上方供应商。';
        }
      }
    } else {
      if (keyArea) keyArea.style.display = 'block';
      renderAgentKeyChecks();
    }
  }

  function renderAgentKeyChecks() {
    const provInp = document.getElementById('a_provider');
    const prov = provInp ? provInp.value : '';
    const box = document.getElementById('a_keyList');
    const quickBox = document.getElementById('a_quickModels');
    const quickTags = document.getElementById('a_quickTags');
    const protoInfoEl = document.getElementById('a_model_proto_info');

    if (!box) return;

    if (!prov) {
      box.innerHTML = '<div class="hint">请先在上方选择供应商</div>';
      if (quickBox) quickBox.style.display = 'none';
      if (protoInfoEl) protoInfoEl.innerHTML = '';
      return;
    }

    const { cfg } = getCtx();
    const localProv = cfg.providers && cfg.providers[prov];
    const remoteProv = (typeof findVaultProvider === 'function') ? findVaultProvider(prov) : null;

    const provProtos = localProv
      ? ((typeof getProviderProtocols === 'function') ? getProviderProtocols(prov) : ['chat'])
      : (remoteProv?.protocols || ['chat']);

    if (protoInfoEl) {
      const badgeHtml = _renderProtocolBadges(provProtos);
      let actionBtnHtml = '';
      if (localProv && remoteProv) {
        actionBtnHtml = `<button type="button" class="btn btn-sm btn-secondary" data-action="switch-provider-vault" data-prov="${_esc(prov)}" style="font-size:11px;padding:2px 8px;margin-left:auto;display:inline-flex;align-items:center;gap:4px;" title="清理本地自建配置，切换使用 EdgeOne 中枢统一托管"><svg class="khc-icon" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z"/></svg><span>切换为中枢托管 (清理本地自建)</span></button>`;
      } else if (localProv) {
        actionBtnHtml = `<button type="button" class="btn btn-sm btn-ghost" data-action="delete-local-provider" data-prov="${_esc(prov)}" style="color:var(--error);font-size:11px;padding:2px 6px;margin-left:auto;" title="彻底删除此本地自建供应商">🗑️ 删除此本地供应商</button>`;
      }
      protoInfoEl.innerHTML = `<div style="display:flex;align-items:center;gap:8px;width:100%;flex-wrap:wrap;">${badgeHtml}${actionBtnHtml}</div>`;
    }

    const isFreeTier = (prov === 'opencode-free' || prov === 'opencode_free');
    let localKeys = localProv ? Object.keys(localProv.keys || {}) : [];
    if (isFreeTier) {
      const parentProv = cfg.providers && (cfg.providers['opencode'] || cfg.providers['opencode-free']);
      const parentKeys = parentProv ? Object.keys(parentProv.keys || {}) : [];
      localKeys = [...new Set(['public', ...parentKeys, ...localKeys])];
    }

    const remoteKeys = remoteProv ? (remoteProv.keys || []).map(k => typeof k === 'string' ? k : (k.label || k.id || '')).filter(Boolean) : [];
    const purelyLocalKeys = localKeys.filter(k => !remoteKeys.includes(k));
    const allKeyLabels = [...remoteKeys, ...purelyLocalKeys];

    const isNewModel = !document.getElementById('a_oldName')?.value;
    if (isNewModel) {
      modalBindings = modalBindings.filter(b => b.provider === prov);
      if (modalBindings.length === 0 && allKeyLabels.length > 0) {
        const defaultK = (isFreeTier && allKeyLabels.includes('public')) ? 'public' : allKeyLabels[0];
        modalBindings.push({ provider: prov, key: defaultK });
      }
    }

    if (allKeyLabels.length === 0) {
      box.innerHTML = '<div class="hint" style="color:var(--text-secondary);font-size:12px;padding:8px;">该供应商下暂无可用 Key，请点击上方添加本地 Key 或同步中枢规则</div>';
    } else {
      box.innerHTML = allKeyLabels.map((k) => {
        const isPublic = (k === 'public' || k === '__public__');
        const isVault = !isPublic && remoteKeys.includes(k);
        const isLocal = !isPublic && localKeys.includes(k);
        const isChecked = modalBindings.some(b => b.provider === prov && b.key === k);
        const tag = isPublic
          ? `<span class="badge badge-warning" style="font-size:10px;padding:0 6px;">免Key兜底</span>`
          : (isVault 
              ? `<span class="badge badge-neutral" style="font-size:10px;padding:0 6px;">中枢</span>`
              : `<span class="badge badge-success" style="font-size:10px;padding:0 6px;">本地</span>`);

        const deleteBtn = (!isVault && isLocal && !isPublic)
          ? `<button type="button" class="btn-ghost" data-action="remove-local-key" data-prov="${_esc(prov)}" data-key="${_esc(k)}" style="padding:0 4px;margin-left:4px;color:var(--error);font-weight:bold;line-height:1;" title="从本地存储中彻底删除此 Key">×</button>`
          : '';

        const displayLabel = isPublic ? '🌟 公共匿名凭据 (免Key兜底)' : k;

        return `<div class="key-capsule ${isChecked ? 'checked' : ''}" data-action="toggle-key-capsule">
          <input type="checkbox" value="${_esc(k)}" data-provider="${_esc(prov)}" data-is-local="${isLocal}" ${isChecked ? 'checked' : ''} style="display:none;">
          <span style="font-weight:600;">${_esc(displayLabel)}</span>
          ${tag}
          ${deleteBtn}
        </div>`;
      }).join('');
    }

    // Render quick model capsules
    let recModels = [];
    if (typeof PRESET_DEFINITIONS !== 'undefined' && PRESET_DEFINITIONS[prov.toLowerCase()]) {
      recModels = PRESET_DEFINITIONS[prov.toLowerCase()].recommended_models || [];
    } else if (typeof CACHED_PRESETS !== 'undefined' && CACHED_PRESETS[prov.toLowerCase()]) {
      recModels = CACHED_PRESETS[prov.toLowerCase()].recommended_models || [];
    } else if (remoteProv && remoteProv.recommended_models) {
      recModels = remoteProv.recommended_models || [];
    }

    if (recModels.length > 0 && quickBox && quickTags) {
      quickTags.innerHTML = recModels.map(rm => {
        const mName = typeof rm === 'string' ? rm : (rm.name || rm.id);
        const mUpstream = typeof rm === 'string' ? rm : (rm.upstream || rm.name || rm.id);
        return `<div class="model-capsule" data-action="apply-quick-model" data-name="${_esc(mName)}" data-upstream="${_esc(mUpstream)}">
          <span>${_esc(mName)}</span>
        </div>`;
      }).join('');
      quickBox.style.display = 'block';
    } else if (quickBox) {
      quickBox.style.display = 'none';
    }

    _renderSelectedBindingsSummary();
    initModalDelegation();
  }

  // 5. Open & Edit Model Modal
  async function openAgentModal() {
    modalBindings = [];
    const title = document.getElementById('agentModalTitle');
    if (title) title.textContent = '新增 Agent 模型';
    const aOld = document.getElementById('a_oldName');
    if (aOld) aOld.value = '';
    const aName = document.getElementById('a_name');
    if (aName) { aName.value = ''; aName.readOnly = false; }
    const aUp = document.getElementById('a_upstream');
    if (aUp) aUp.value = '';

    if (typeof state !== 'undefined' && !state.vaultManifest && typeof fetchVaultManifest === 'function') {
      await fetchVaultManifest(true);
    }
    const providers = _getAllProvidersList();
    const defaultProv = providers[0] ? providers[0].id : '';
    populateAgentProviderSelect(defaultProv);
    _openModal('agentModal');
    initModalDelegation();
  }

  async function editAgentModel(name) {
    const { cfg } = getCtx();
    const m = (cfg.agent_models && cfg.agent_models[name]) || {};
    modalBindings = (m.keys || []).map(x => ({ provider: x.provider, key: x.key }));

    const title = document.getElementById('agentModalTitle');
    if (title) title.textContent = '编辑 Agent 模型';
    const aOld = document.getElementById('a_oldName');
    if (aOld) aOld.value = name;
    const aName = document.getElementById('a_name');
    if (aName) { aName.value = name; aName.readOnly = false; }
    const aUp = document.getElementById('a_upstream');
    if (aUp) aUp.value = m.upstream_model || '';

    if (typeof state !== 'undefined' && !state.vaultManifest && typeof fetchVaultManifest === 'function') {
      await fetchVaultManifest(true);
    }

    const boundProviders = [...new Set((m.keys || []).map(x => x.provider))];
    const activeProv = boundProviders[0] || (_getAllProvidersList()[0]?.id || '');
    populateAgentProviderSelect(activeProv);
    _openModal('agentModal');
    initModalDelegation();
  }

  async function saveAgentModel() {
    const oldName = (document.getElementById('a_oldName')?.value || '').trim();
    const name = (document.getElementById('a_name')?.value || '').trim();
    const upstream = (document.getElementById('a_upstream')?.value || '').trim();
    const selVal = document.getElementById('a_providerSelect')?.value;

    if (!name) { _toast('模型名称不能为空', 'err'); return; }
    const provider = selVal;
    if (!provider) { _toast('请先选择所属供应商', 'err'); return; }

    // Sync currently displayed checkboxes in modal to modalBindings
    document.querySelectorAll('#a_keyList input[type="checkbox"]').forEach(inp => {
      const p = inp.dataset.provider || provider;
      const k = inp.value;
      if (inp.checked) {
        if (!modalBindings.some(b => b.provider === p && b.key === k)) {
          modalBindings.push({ provider: p, key: k });
        }
      } else {
        modalBindings = modalBindings.filter(b => !(b.provider === p && b.key === k));
      }
    });

    if (!oldName) {
      modalBindings = modalBindings.filter(b => b.provider === provider);
    }

    const bindings = modalBindings.filter(b => b.provider && b.key);
    if (!bindings.length) { _toast('请至少勾选绑定一个 Key', 'err'); return; }

    if (typeof ensureKeysImported === 'function') {
      const realKeys = bindings.filter(b => b.key !== 'public' && b.key !== '__public__');
      if (realKeys.length > 0) {
        const ok = await ensureKeysImported(realKeys);
        if (!ok) return;
      }
    }

    const { cfg } = getCtx();
    if (!cfg.agent_models) cfg.agent_models = {};

    // 自动补齐 opencode-free 供应商条目
    if (bindings.some(b => b.provider === 'opencode-free') && cfg.providers && !cfg.providers['opencode-free']) {
      const parentProv = cfg.providers['opencode'] || {};
      cfg.providers['opencode-free'] = {
        name: 'opencode-free',
        label: 'OpenCode Free (免费专区)',
        base_url: parentProv.base_url || 'https://opencode.ai/zen/v1',
        protocol: 'openai',
        protocols: ['chat'],
        keys: { 'public': 'public' },
        adapter_rules: { opencode_free_bypass: true }
      };
    }

    // Collision check 1: Adding keys to an existing model during creation
    if (!oldName && cfg.agent_models[name]) {
      const existing = cfg.agent_models[name];
      const existingKeySet = new Set((existing.keys || []).map(k => `${k.provider}:${k.key}`));
      const newKeysToAdd = bindings.filter(k => !existingKeySet.has(`${k.provider}:${k.key}`));

      const msg = newKeysToAdd.length > 0
        ? `模型 ID「${name}」已存在！\n\n点击【确定】将勾选的 ${newKeysToAdd.length} 个新 Key 追加合并至该已有模型；\n点击【取消】返回修改模型名称。`
        : `模型 ID「${name}」已存在，且所选 Key 已全部绑定至该模型。\n\n点击【确定】保留原有配置并退出；点击【取消】返回修改模型名称。`;

      if (!confirm(msg)) {
        document.getElementById('a_name')?.focus();
        return;
      }

      if (newKeysToAdd.length > 0) {
        existing.keys = (existing.keys || []).concat(newKeysToAdd);
      }
      if (upstream && upstream !== name) {
        existing.upstream_model = upstream;
      }
    }
    // Collision check 2: Renaming to another existing model
    else if (oldName && oldName !== name && cfg.agent_models[name]) {
      _toast(`目标模型 ID「${name}」已存在，不能重命名覆盖已有模型！`, 'err');
      document.getElementById('a_name')?.focus();
      return;
    }
    // Normal save or valid rename
    else {
      const existing = (oldName && cfg.agent_models[oldName]) ? cfg.agent_models[oldName] : {};
      if (oldName && oldName !== name) {
        delete cfg.agent_models[oldName];
      }
      const entry = { ...existing, keys: bindings };
      if (upstream && upstream !== name) {
        entry.upstream_model = upstream;
      } else {
        delete entry.upstream_model;
      }
      if (entry.active_key && !bindings.some(b => b.key === entry.active_key)) {
        delete entry.active_key;
      }
      cfg.agent_models[name] = entry;
    }

    _closeModal('agentModal');
    await _persist(oldName && oldName !== name ? `Agent 模型已从「${oldName}」重命名为「${name}」并立即生效` : `Agent 模型「${name}」已保存并立即生效`);
    renderAgentModels();
  }

  async function deleteAgentModel(name) {
    if (!confirm(`确定要删除 Agent 模型 "${name}" 吗？`)) return;
    const { cfg } = getCtx();
    delete cfg.agent_models[name];
    await _persist(`Agent 模型「${name}」已删除并立即生效`);
    renderAgentModels();
  }

  // 6. Key Operations: Reorder, Set Active, Delete
  function reorderAgentKey(name, fromIdx, inputVal) {
    const { cfg } = getCtx();
    const keys = cfg.agent_models?.[name]?.keys;
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
    _persist('Key 优先级已调整并立即生效');
    renderAgentModels();
  }

  function setActiveAgentKey(name, keyLabel) {
    const { cfg, stats } = getCtx();
    if (!cfg.agent_models || !cfg.agent_models[name]) return;
    cfg.agent_models[name].active_key = keyLabel;
    if (stats && stats.agent) {
      if (!stats.agent.active_keys) stats.agent.active_keys = {};
      stats.agent.active_keys[name] = keyLabel;
    }
    _persist(`模型「${name}」已设置主力 Key: [${keyLabel}] 并立即生效`);
    renderAgentModels();
  }

  function deleteAgentKey(name, i) {
    const { cfg } = getCtx();
    if (!cfg.agent_models?.[name]?.keys) return;
    cfg.agent_models[name].keys.splice(i, 1);
    if (!cfg.agent_models[name].keys.length) delete cfg.agent_models[name];
    _persist('Key 绑定已移除并立即生效');
    renderAgentModels();
  }

  // 7. Probing and Live Testing
  async function testAgentKey(name, i) {
    const { isVm, cfg, stats, probingKeys } = getCtx();
    const b = cfg.agent_models?.[name]?.keys?.[i];
    if (!b) return;

    const probeKeyId = 'agent:' + name + ':' + b.provider + ':' + b.key;
    if (probingKeys.has(probeKeyId)) return;
    probingKeys.add(probeKeyId);

    const btn = document.getElementById('probeBtn-' + probeKeyId);
    if (btn) { btn.disabled = true; btn.innerHTML = '<span class="spinner"></span>'; }

    const model = b.upstream_model || cfg.agent_models[name].upstream_model || name;
    const start = Date.now();

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 12000);

      const endpoint = isVm ? '/api/admin/test-candidate' : '/api/test';
      const body = isVm 
        ? { provider: b.provider, key: b.key, model, type: 'chat', category: 'agent', model_name: name }
        : { provider: b.provider, key: b.key, model };

      const r = await fetch(endpoint, {
        method: 'POST',
        headers: _getHeaders(),
        body: JSON.stringify(body),
        signal: controller.signal
      });
      clearTimeout(timer);
      const d = await r.json();
      const latency = Date.now() - start;

      const isSuccess = Boolean(d.success || d.ok);
      if (isSuccess) {
        _toast(`[${b.provider}/${b.key}] 探活成功 (${latency}ms)`, 'ok');
      } else {
        _toast(`[${b.provider}/${b.key}] 探活失败: ${d.error || d.verdict || d.status}`, 'err');
      }

      if (typeof modelLatencyCache !== 'undefined') {
        modelLatencyCache[`model:${name}:${b.provider}:${b.key}`] = {
          ok: isSuccess,
          latency_ms: latency,
          status: isSuccess ? 200 : (d.status || 500)
        };
      }
    } catch(e) {
      _toast(`[${b.provider}/${b.key}] 探活超时或异常: ${e.message}`, 'err');
    } finally {
      probingKeys.delete(probeKeyId);
      if (typeof loadData === 'function') await loadData();
      else renderAgentModels();
    }
  }

  async function testAgentModelAll(name) {
    const { isVm, probingModels } = getCtx();
    if (probingModels.has(name)) return;
    probingModels.add(name);

    const btn = document.getElementById('probeAllBtn-' + name);
    if (btn) { btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> 探测中...'; }

    const box = document.getElementById('agentProbe-' + name);
    if (box) {
      box.style.display = 'block';
      box.innerHTML = '<div style="display:flex;align-items:center;gap:8px;"><span class="spinner"></span> 正在并发探测所有 Key 连通性</div>';
    }

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 15000);
      const endpoint = isVm ? '/api/admin/test-agent-model' : '/api/test';

      const r = await fetch(endpoint, {
        method: 'POST',
        headers: _getHeaders(),
        body: JSON.stringify({ model: name }),
        signal: controller.signal
      });
      clearTimeout(timer);
      const d = await r.json();

      if (!d.results && !d.ok && !d.success) {
        if (box) box.innerHTML = `<span style="color:var(--error, #f53f3f);">探活失败: ${d.error || '无响应数据'}</span>`;
        return;
      }

      const results = d.results || [];
      const okCount = d.ok !== undefined ? d.ok : results.filter(x => x.ok).length;
      const totalCount = d.total !== undefined ? d.total : results.length;

      const chips = results.map(res => {
        const lat = (res.latency_ms !== null && res.latency_ms !== undefined)
          ? ` ${res.latency_ms >= 1000 ? (res.latency_ms/1000).toFixed(2)+'s' : res.latency_ms+'ms'}`
          : '';
        return res.ok
          ? `<span class="badge badge-success" style="font-weight:600;">${_esc(res.provider)}/${_esc(res.key)}${lat}</span>`
          : `<span class="badge badge-error" title="${_esc(res.error||'')}">${_esc(res.provider)}/${_esc(res.key)} (${res.status||'ERR'})</span>`;
      }).join(' ');

      if (box) {
        box.innerHTML = `
          <div class="mb-2" style="font-weight:600;display:flex;align-items:center;justify-content:space-between;">
            <span>可用性统计: <b>${okCount} / ${totalCount}</b> 正常</span>
            <span class="text-secondary" style="font-weight:400;font-size:11px;">探测时间: ${_esc(d.checked_at||'')}</span>
          </div>
          <div class="flex gap-2" style="flex-wrap:wrap;">${chips || '<span>全部检测完成</span>'}</div>
        `;
      }
      _toast(`探活完成: ${name} (可用 ${okCount}/${totalCount})`, okCount > 0 ? 'ok' : 'err');
    } catch(e) {
      if (box) box.innerHTML = `<span style="color:var(--error, #f53f3f);">探活异常或超时: ${_esc(e.message)}</span>`;
      _toast('探活异常: ' + e.message, 'err');
    } finally {
      probingModels.delete(name);
      if (btn) { btn.disabled = false; btn.innerHTML = '全部探活'; }
      if (typeof loadData === 'function') await loadData();
      else renderAgentModels();
    }
  }

  async function runLiveTest(modelName) {
    const resBox = document.getElementById('liveTestRes-' + modelName);
    const btn = document.getElementById('liveTestBtn-' + modelName);
    if (!resBox) return;

    resBox.style.display = 'block';
    resBox.innerHTML = `
      <div style="display:flex;align-items:center;gap:8px;color:var(--text-secondary);">
        <span class="spinner"></span>
        <span>正在向生产端点发起真实测试请求 (POST /v1/chat/completions)...</span>
      </div>
    `;
    if (btn) { btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> 测试中'; }

    const start = Date.now();
    try {
      const apiKey = _getAuthKeyForChat();
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

      if (resp.ok) {
        const data = await resp.json();
        const content = data?.choices?.[0]?.message?.content || '(无返回文本)';
        resBox.innerHTML = `
          <div style="display:flex;flex-direction:column;gap:8px;">
            <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px;">
              <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
                <span class="badge badge-success" style="font-weight:700;">HTTP 200 OK</span>
                <span style="font-weight:600;color:var(--text, var(--color-text-1));">实际调用节点:</span>
                <span class="badge badge-primary" style="font-family:monospace;font-size:12px;padding:2px 8px;">${_esc(routedVia || '默认节点')}</span>
                <span style="color:var(--text-secondary);font-size:12px;">往返耗时: <b>${elapsed}ms</b></span>
                ${Number(fallbacks) > 0 ? `<span class="badge badge-warning">故障转移重试: ${fallbacks}次</span>` : ''}
              </div>
              <button class="btn btn-sm" data-action="collapse-panel" style="font-size:11px;padding:2px 6px;">收起</button>
            </div>
            <div style="font-size:12px;background:var(--bg, var(--color-bg-page));padding:6px 12px;border-radius:var(--radius-sm);border:1px solid var(--border, var(--color-border));color:var(--text, var(--color-text-1));">
              <span style="color:var(--text-secondary);">模型输出：</span>${_esc(content.trim())}
            </div>
          </div>
        `;
        _toast(`[${modelName}] 实测验证成功！命中: ${routedVia} (${elapsed}ms)`, 'ok');
      } else {
        let errText = '';
        try {
          const errJson = await resp.json();
          errText = errJson?.error?.message || JSON.stringify(errJson);
        } catch(e) {
          errText = await resp.text();
        }
        resBox.innerHTML = `
          <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;">
            <div style="display:flex;align-items:center;gap:8px;">
              <span class="badge badge-error" style="font-weight:700;">HTTP ${resp.status}</span>
              <span style="color:var(--error, #f53f3f);font-size:12px;">${_esc(errText)}</span>
            </div>
            <button class="btn btn-sm" data-action="collapse-panel" style="font-size:11px;padding:2px 6px;">收起</button>
          </div>
        `;
        _toast(`[${modelName}] 实测失败: HTTP ${resp.status}`, 'err');
      }
    } catch(e) {
      resBox.innerHTML = `
        <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;">
          <span style="color:var(--error, #f53f3f);font-size:12px;">实测网络异常: ${_esc(e.message)}</span>
          <button class="btn btn-sm" data-action="collapse-panel" style="font-size:11px;padding:2px 6px;">收起</button>
        </div>
      `;
      _toast(`实测异常: ${e.message}`, 'err');
    } finally {
      if (btn) { btn.disabled = false; btn.innerHTML = '实测 1+1'; }
    }
  }

  // 8. Render Single Binding Row in Key Table
  function renderAgentBindingRow(idx, binding, modelName, i, status, totalCount) {
    const { probingKeys } = getCtx();
    const nk = 'agent:' + modelName + ':' + binding.provider + ':' + binding.key;
    let ns = status[nk] || status[binding.provider + ':' + binding.key + ':agent:' + modelName];

    if (!ns && typeof modelLatencyCache !== 'undefined') {
      const cacheKey = `model:${modelName}:${binding.provider}:${binding.key}`;
      const latInfo = modelLatencyCache[cacheKey];
      if (latInfo) {
        ns = {
          status: latInfo.status || (latInfo.ok ? 200 : 500),
          latency_ms: latInfo.latency_ms,
          time: Date.now()
        };
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
      time = _fmtTime(ns.time);
    }

    const probeKeyId = 'agent:' + modelName + ':' + binding.provider + ':' + binding.key;
    const isProbing = probingKeys.has(probeKeyId);

    const keyBadgeHtml = `<span class="badge badge-neutral">${_esc(binding.key)}</span>`;

    const orderInputHtml = `<input type="number" min="1" max="${totalCount}" value="${idx}" 
        style="width:38px;height:22px;text-align:center;font-size:12px;font-weight:700;padding:0;border:1px solid #d0d7de;border-radius:4px;"
        data-action="reorder-key" data-model="${_esc(modelName)}" data-index="${i}" title="修改数字直接调整顺序">`;

    const { cfg, stats: fullStats } = getCtx();
    const list = cfg.agent_models?.[modelName]?.keys || [];
    const runtimeActiveKey = (fullStats && fullStats.agent && fullStats.agent.active_keys) ? fullStats.agent.active_keys[modelName] : null;
    const activeKey = cfg.agent_models?.[modelName]?.active_key || runtimeActiveKey || (list[0] ? list[0].key : '');
    const isActive = (binding.key === activeKey);

    const setActiveBtn = isActive
      ? `<span class="badge badge-success" style="font-size:11px;padding:3px 8px;font-weight:600;">使用中</span>`
      : `<button class="btn btn-sm btn-secondary" data-action="set-active-key" data-model="${_esc(modelName)}" data-key="${_esc(binding.key)}" title="设为主力 Key" style="font-size:11px;padding:2px 8px;font-weight:500;">设为主力</button>`;

    const actions = `
      ${setActiveBtn}
      <button class="btn btn-icon btn-sm btn-secondary" id="probeBtn-${_esc(probeKeyId)}" data-action="probe-key" data-model="${_esc(modelName)}" data-index="${i}" title="测试此 Key 连通性" ${isProbing ? 'disabled' : ''}>
        ${isProbing ? '<span class="spinner"></span>' : '测'}
      </button>
      <button class="btn btn-icon btn-sm btn-secondary-danger" data-action="delete-key" data-model="${_esc(modelName)}" data-index="${i}" title="删除绑定">×</button>
    `;

    return `<tr>
      <td>${orderInputHtml}</td>
      <td><b>${_esc(binding.provider)}</b></td>
      <td>${keyBadgeHtml}</td>
      <td>${badge}</td>
      <td class="text-sm text-secondary">${time}</td>
      <td style="text-align:right"><div class="flex gap-2" style="justify-content:flex-end;align-items:center;">${actions}</div></td>
    </tr>`;
  }

  // 9. Master Card List Rendering
  function renderAgentModels() {
    const box = document.getElementById('agentModelsBox');
    if (!box) return;

    const { cfg, stats, probingModels } = getCtx();
    const models = cfg.agent_models || {};
    const names = Object.keys(models);

    if (!names.length) {
      box.innerHTML = '<div class="hint-box">尚未配置 Agent 模型。点击右上角「新增模型」添加您的第一个模型。</div>';
      return;
    }

    const candStatus = stats.candidates_status || {};
    const strategy = cfg.agent_routing_strategy || 'sticky_failover';

    box.innerHTML = names.map(name => {
      const m = models[name];
      const upstream = m.upstream_model || name;
      const isProbingAll = probingModels.has(name);
      const activeKey = m.active_key || ((m.keys && m.keys[0]) ? m.keys[0].key : '');
      const modelProtos = _getModelProtocols(name);
      const protoBadges = _renderProtocolBadges(modelProtos, true);

      let strategyLabel = `${(m.keys || []).length} 个 Key · 粘性故障转移 (固定当前，遇错顺延)`;
      if (strategy === 'manual') {
        strategyLabel = `${(m.keys || []).length} 个 Key · 纯手动直通 (当前使用: ${_esc(activeKey)})`;
      } else if (strategy === 'round_robin') {
        strategyLabel = `${(m.keys || []).length} 个 Key · 轮询负载均衡 (依次轮流)`;
      } else if (strategy === 'priority_fallback') {
        strategyLabel = `${(m.keys || []).length} 个 Key · 主备优先级降级 (首选降级)`;
      } else if (strategy === 'latency_based') {
        strategyLabel = `${(m.keys || []).length} 个 Key · 最低延迟优先`;
      }

      const totalKeys = (m.keys || []).length;
      const rows = (m.keys || []).map((b, i) => renderAgentBindingRow(i + 1, b, name, i, candStatus, totalKeys));

      return `<div class="card model-card mb-4" style="margin-bottom:16px;">
        <div class="card-head" style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;">
          <div>
            <div class="model-id" style="font-size:14px;font-weight:700;display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
              <span>${_esc(name)}</span>
              ${upstream !== name ? `<span class="badge badge-neutral" style="font-weight:400;">上游 ID: ${_esc(upstream)}</span>` : ''}
              <span style="display:inline-flex;gap:4px;">${protoBadges}</span>
            </div>
            <div class="meta" style="margin-top:2px;font-size:12px;color:var(--text-secondary);">${strategyLabel}</div>
          </div>
          <div class="flex gap-2" style="flex-wrap:wrap;display:flex;gap:6px;">
            <button class="btn btn-secondary btn-sm" id="probeAllBtn-${_esc(name)}" data-action="probe-model-all" data-model="${_esc(name)}" ${isProbingAll ? 'disabled' : ''}>
              ${isProbingAll ? '<span class="spinner"></span> 探测中...' : '全部探活'}
            </button>
            <button class="btn btn-secondary btn-sm" data-action="edit-model" data-model="${_esc(name)}">编辑</button>
            <button class="btn btn-secondary-danger btn-sm" data-action="delete-model" data-model="${_esc(name)}">删除</button>
          </div>
        </div>
        <div class="table-wrap">
          <table>
            <thead><tr><th>#</th><th>供应商</th><th>Key 别名</th><th>响应耗时 / 状态</th><th>最近调用</th><th style="text-align:right">操作</th></tr></thead>
            <tbody>${rows.length ? rows.join('') : '<tr><td colspan="6" class="empty">暂无绑定 Key</td></tr>'}</tbody>
          </table>
        </div>
        <div id="liveTestRes-${_esc(name)}" style="display:none;padding:12px 18px;border-top:1px solid var(--border-subtle, var(--color-border));background:var(--bg-subtle, var(--color-bg-page));font-size:12px;"></div>
        <div id="agentProbe-${_esc(name)}" style="display:none;padding:12px 18px;border-top:1px solid var(--border-subtle, var(--color-border));background:var(--bg-subtle, var(--color-bg-page));font-size:12px;"></div>
      </div>`;
    }).join('');

    initAgentModelsDelegation();
  }

  async function switchLocalProviderToVault(provId) {
    if (!provId) return;
    if (!confirm(`确定要清理本地自建的供应商 [${provId}] 并切换为使用 EdgeOne 中枢托管吗？\n\n清理后将自动切换为中枢统一分发的密钥与规则。`)) {
      return;
    }
    const { cfg } = getCtx();
    if (cfg && cfg.providers && cfg.providers[provId]) {
      delete cfg.providers[provId];
      await _persist(`已清理本地自建供应商 [${provId}]，现已切换为中枢托管`);
      _toast(`已成功切换为 EdgeOne 中枢托管 [${provId}]`, 'ok');
      populateAgentProviderSelect(provId);
      if (typeof renderProviders === 'function') renderProviders();
    }
  }

  async function deleteLocalProviderFromModal(provId) {
    if (!provId) return;
    if (!confirm(`确定要彻底删除本地自建供应商 [${provId}] 吗？`)) {
      return;
    }
    const { cfg } = getCtx();
    if (cfg && cfg.providers && cfg.providers[provId]) {
      delete cfg.providers[provId];
      await _persist(`本地供应商 [${provId}] 已删除并立即生效`);
      _toast(`供应商 [${provId}] 已删除`, 'ok');
      populateAgentProviderSelect('');
      if (typeof renderProviders === 'function') renderProviders();
    }
  }

  async function removeLocalKeyFromModal(prov, label, event) {
    if (event) event.stopPropagation();
    if (!confirm(`确定要从本地存储中彻底删除 Key「${label}」吗？`)) return;
    const { cfg } = getCtx();
    if (cfg && cfg.providers && cfg.providers[prov] && cfg.providers[prov].keys) {
      delete cfg.providers[prov].keys[label];
    }
    if (cfg && cfg.agent_models) {
      Object.values(cfg.agent_models).forEach(m => {
        m.keys = (m.keys || []).filter(x => !(x.provider === prov && x.key === label));
      });
    }
    if (cfg && cfg.candidates) {
      Object.values(cfg.candidates).forEach(list => {
        if (Array.isArray(list)) {
          const idxs = [];
          list.forEach((c, idx) => {
            if (c.provider === prov && c.key === label) idxs.push(idx);
          });
          for (let i = idxs.length - 1; i >= 0; i--) {
            list.splice(idxs[i], 1);
          }
        }
      });
    }
    await _persist(`本地 Key「${label}」已彻底删除并立即生效`);
    _toast(`已删除本地 Key: ${label}`, 'ok');
    renderAgentKeyChecks();
    if (typeof renderCandidateKeyChecks === 'function') renderCandidateKeyChecks();
    if (typeof renderProviders === 'function') renderProviders();
  }

  // 10. Exports to Window Scope
  global.switchLocalProviderToVault = switchLocalProviderToVault;
  global.deleteLocalProviderFromModal = deleteLocalProviderFromModal;
  global.removeLocalKeyFromModal = removeLocalKeyFromModal;
  global.renderAgentModels = renderAgentModels;
  global.renderAgentBindingRow = renderAgentBindingRow;
  global.openAgentModal = openAgentModal;
  global.openAddModelModal = openAgentModal;
  global.editAgentModel = editAgentModel;
  global.saveAgentModel = saveAgentModel;
  global.deleteAgentModel = deleteAgentModel;
  global.reorderAgentKey = reorderAgentKey;
  global.setActiveAgentKey = setActiveAgentKey;
  global.deleteAgentKey = deleteAgentKey;
  global.testAgentKey = testAgentKey;
  global.testAgentModelAll = testAgentModelAll;
  global.runLiveTest = runLiveTest;
  global.executeProbe = executeProbe;
  global.renderProbedModelsList = renderProbedModelsList;
  global.filterProbedModels = filterProbedModels;
  global.selectProbedModel = selectProbedModel;
  global.applyAgentQuickModel = applyAgentQuickModel;
  global.toggleKeyCapsule = toggleKeyCapsule;
  global.populateAgentProviderSelect = populateAgentProviderSelect;
  global.onAgentProviderSelectChange = onAgentProviderSelectChange;
  global.renderAgentKeyChecks = renderAgentKeyChecks;
  global.initAgentModelsDelegation = initAgentModelsDelegation;
  global.initModalDelegation = initModalDelegation;

  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', () => {
        initAgentModelsDelegation();
        initModalDelegation();
      });
    } else {
      initAgentModelsDelegation();
      initModalDelegation();
    }
  }

})(typeof window !== 'undefined' ? window : globalThis);

/**
 * OCRProxy Admin - EdgeOne Vault Hub & Credential Sync
 */
async function fetchVaultManifest(silent = true) {
  const vaultUrl = (state.config && state.config.edgeone_vault && (state.config.edgeone_vault.edgeone_url || state.config.edgeone_vault.url)) || '';
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

// 凭据来源只有两种：vault（中枢）与 local（本地）。origin 与旧字段 is_local 必须
// 同步写入，否则旧控制台 / 后端 secret_origin() 会读出不同结论。
function stampSecretOrigin(secret, origin){
  if (!secret) return secret;
  secret.origin = (origin === 'local') ? 'local' : 'vault';
  secret.is_local = (secret.origin === 'local');
  return secret;
}

function cleanProviderLabel(label) {
  if (!label) return '';
  return String(label)
    .replace(/\s*\([^)]*\)/g, '')
    .trim();
}

// Kept as a named alias for the dropdown labels: delegates to the canonical formatter.
function formatProtocolsDisplay(protos) {
  return formatProtocolLabel(protos);
}

function getAllAvailableProviders(){
  const localProviders = state.config?.providers || {};
  const remoteProviders = getVaultProviderList();
  const remoteMap = new Map();
  remoteProviders.forEach(rp => {
    if (rp.id) remoteMap.set(rp.id.toLowerCase(), rp);
  });
  const list = [];

  // 1. 本地已配置供应商 (优先且始终位于第一梯队，用户可直接选用绑定模型)
  const localKeys = Object.keys(localProviders).sort();
  localKeys.forEach(name => {
    const p = localProviders[name] || {};
    const low = name.toLowerCase();
    const rp = remoteMap.get(low);
    const protos = getProviderProtocols(name, p);
    const protoStr = formatProtocolsDisplay(protos);
    const isVault = (p.origin === 'vault');
    list.push({
      id: name,
      label: cleanProviderLabel(p.name || rp?.name || name),
      protoStr: protoStr,
      isConfigured: true,
      isVault: isVault,
      isCached: true,
      origin: p.origin || (isVault ? 'vault' : 'local'),
      protocols: protos
    });
  });

  // 2. 凭据中枢未导入项 (仅列出本地尚未配置的中枢供应商，供用户按需拉取)
  remoteProviders.forEach(rp => {
    const pId = rp.id;
    if (!pId) return;
    const low = pId.toLowerCase();
    if (localProviders[pId] || localKeys.some(k => k.toLowerCase() === low)) {
      return; // 已在本地配置列表中，不重复冗余展示
    }
    const protos = rp.protocols || ['chat'];
    const protoStr = formatProtocolsDisplay(protos);
    list.push({
      id: pId,
      label: cleanProviderLabel(rp.name || pId),
      protoStr: protoStr,
      isConfigured: false,
      isVault: true,
      isCached: false,
      origin: 'vault',
      protocols: protos
    });
  });

  return list;
}

// Shared 「本地已配置供应商」下拉渲染：Agent 模型弹窗与 KB 候选节点弹窗共用，
// 避免两处各写一套 option/label/占位/默认选中逻辑而漂移。
function populateLocalProviderSelect(selectId, optgroupId, selectedId){
  const sel = document.getElementById(selectId);
  const optLocal = document.getElementById(optgroupId);
  if (!sel) return '';
  const configuredList = (typeof getAllAvailableProviders === 'function' ? getAllAvailableProviders() : [])
    .filter(p => p.isConfigured !== false);
  const emptyHtml = '<option value="" disabled selected>-- 暂无已配置供应商 (请前往「供应商」界面添加) --</option>';
  const html = configuredList.length
    ? configuredList.map(p => {
        const label = `${p.label || p.name || p.id} (${formatProtocolLabel(p.protoStr || p.protocols || ['chat'])})`;
        return `<option value="${esc(p.id)}">${esc(label)}</option>`;
      }).join('')
    : emptyHtml;
  if (optLocal) optLocal.innerHTML = html;
  else sel.innerHTML = html;
  const curId = (selectedId && configuredList.some(p => p.id === selectedId))
    ? selectedId
    : (configuredList[0] ? configuredList[0].id : '');
  sel.value = curId;
  return curId;
}

// Probed Models Selection Modal State & Logic

// 绑定只允许选本地已有的 Key（中枢供应商须先在「供应商」页整体拉取）。
async function ensureKeysImported(bindings){
  const missing = (bindings || []).filter(b =>
    b.key !== 'public' && b.key !== '__public__' &&
    !state.config?.providers?.[b.provider]?.keys?.[b.key]);
  if (missing.length) {
    const m = missing[0];
    toast(`Key [${m.provider}:${m.key}] 不在本地，请先在「供应商」页添加或从中枢拉取该供应商`, 'err');
    return false;
  }
  return true;
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
        </div>
        <div style="margin-top:6px;color:var(--accent-green);font-size:11px;">
          中枢凭据已自动同步并持久化至本地加密配置，可在「模型及路由」中直接添加模型，或在「供应商」中管理凭据。
        </div>`;
    }
    toast(`凭据中枢连接正常，延迟 ${d.latency_ms}ms，发现 ${d.providers_count} 个供应商`, 'ok');

    // Auto-persist validated credentials so user never encounters state desync
    try {
      const payload = { edgeone_url: url, url: url };
      if (token && !isMaskedSecret(token)) {
        payload.token = token;
      }
      await fetch('/api/admin/vault/config', {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify(payload)
      });
      if (!state.config) state.config = {};
      state.config.edgeone_vault = state.config.edgeone_vault || {};
      state.config.edgeone_vault.url = url;
      state.config.edgeone_vault.edgeone_url = url;
      state.config.edgeone_vault.has_token = true;
      const badge = document.getElementById('vaultTokenStatusBadge');
      if (badge) badge.style.display = 'inline-block';
      await fetchVaultManifest(true);
    } catch (_) {}
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

async function saveVaultConfig(silent = false){
  const urlEl = document.getElementById('cfg_vault_url');
  const tokenEl = document.getElementById('cfg_vault_token');
  const btn = document.getElementById('btnSaveVaultConfig');
  const url = (urlEl?.value || '').trim();
  const token = (tokenEl?.value || '').trim();
  if(!url){
    toast('请先填写 EdgeOne 中枢服务地址', 'err');
    return;
  }
  const payload = { edgeone_url: url, url: url };
  if (token && !isMaskedSecret(token)) payload.token = token;
  if (btn) { btn.disabled = true; btn.dataset.busy = '1'; }
  try {
    const res = await fetch('/api/admin/vault/config', {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify(payload)
    });
    const d = await res.json().catch(() => ({}));
    if(!res.ok || !d.ok){
      throw new Error(d.error || `HTTP ${res.status}`);
    }
    if (!state.config) state.config = {};
    state.config.edgeone_vault = state.config.edgeone_vault || {};
    state.config.edgeone_vault.url = url;
    state.config.edgeone_vault.edgeone_url = url;
    if (payload.token) {
      state.config.edgeone_vault.has_token = true;
      // Token 只写不读：保存成功后清空输入框，避免驻留明文
      if (tokenEl) tokenEl.value = '';
    }
    const badge = document.getElementById('vaultTokenStatusBadge');
    if (badge && (payload.token || state.config.edgeone_vault.has_token)) {
      badge.style.display = 'inline-block';
    }
    if (!silent) toast('中枢配置已单独保存（不影响其它设置）', 'ok');
    // 独立保存会更新后端版本号，重新拉取以同步 _version 与状态
    await loadData();
    await fetchVaultManifest(false);
  } catch(e) {
    if (!silent) toast('保存中枢配置失败: ' + e.message, 'err');
  } finally {
    if (btn) { btn.disabled = false; delete btn.dataset.busy; }
  }
}

async function syncVaultFromSettings(){
  const btn = document.getElementById('btnSyncVaultFromSettings');
  const box = document.getElementById('vault_diag_box');
  const url = (document.getElementById('cfg_vault_url')?.value || '').trim();
  const token = (document.getElementById('cfg_vault_token')?.value || '').trim();

  if(!url){
    toast('请先在上方输入 EdgeOne 中枢服务地址', 'err');
    return;
  }

  if(btn){
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span> 正在精准增量同步...';
  }
  if(box){
    box.style.display = 'block';
    box.innerHTML = `<span style="color:var(--text-secondary);display:inline-flex;align-items:center;gap:6px;">${icon('refresh', 14)} 正在从中枢拉取已配置供应商的最新凭据与规则...</span>`;
  }

  try {
    const res = await fetch('/api/admin/vault/sync', {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({ edgeone_url: url, token: token })
    });
    const d = await res.json().catch(() => ({}));
    if(!res.ok || !d.ok){
      throw new Error(d.error || `HTTP ${res.status}: 同步失败`);
    }

    if(box){
      box.innerHTML = `
        <div style="color:var(--accent-green);font-weight:600;margin-bottom:6px;display:flex;align-items:center;gap:6px;">
          ${icon('check', 14)} ${esc(d.message || '中枢增量同步成功')}
        </div>
        <div style="font-size:12px;color:var(--text-secondary);">
          本次仅增量同步了当前本地已使用的供应商（更新: ${d.updated || 0} 个），未引入任何未配置的冗余项，所有本地临时凭据 100% 保持无损。
        </div>`;
    }
    toast(d.message || '中枢凭据增量同步成功！', 'ok');
    await loadData();
    if(typeof fetchVaultManifest === 'function') await fetchVaultManifest(true);
  } catch(e) {
    if(box){
      box.innerHTML = `<div style="color:var(--accent-red);font-size:12px;display:flex;align-items:center;gap:6px;">${icon('alert', 14)} 同步失败: ${esc(e.message)}</div>`;
    }
    toast('中枢同步失败: ' + e.message, 'err');
  } finally {
    if(btn){
      btn.disabled = false;
      btn.innerHTML = `<svg class="khc-icon" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67"/></svg> <span>增量同步中枢凭据与规则 (已添加项)</span>`;
    }
  }
}
window.syncVaultFromSettings = syncVaultFromSettings;


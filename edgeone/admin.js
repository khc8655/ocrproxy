// admin.js — Client logic for the EdgeOne Agent Relay admin page.
//
// Talks to four API endpoints:
//   GET   /api/config          read current config
//   POST  /api/config          write config to KV
//   GET   /api/state           read KV cooldowns
//   DELETE /api/state          clear all cooldowns
//   POST  /api/test            test a (provider, key) pair
//
// Auth: PROXY_API_KEY is held in sessionStorage as `admin_key` and
// sent on every request as `Authorization: Bearer <key>`.

const KEY_STORAGE = 'admin_key';
let cfg = null;          // current config (the { providers, agent_models } tree)
let cfgMeta = null;      // { source, last_modified }
let cooldowns = [];      // array of { provider, keyLabel, expiresAt, ... }

// ---- API helpers --------------------------------------------------------
function key() { return sessionStorage.getItem(KEY_STORAGE) || ''; }
function setKey(k) { sessionStorage.setItem(KEY_STORAGE, k); }
function clearKey() { sessionStorage.removeItem(KEY_STORAGE); }

async function api(method, path, body) {
  const headers = { 'content-type': 'application/json' };
  if (key()) headers['authorization'] = `Bearer ${key()}`;
  const init = { method, headers };
  if (body !== undefined) init.body = JSON.stringify(body);
  const r = await fetch(path, init);
  const text = await r.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch {}
  if (!r.ok) {
    const msg = data?.error?.message || text || `HTTP ${r.status}`;
    throw new Error(msg);
  }
  return data;
}

// ---- Toast --------------------------------------------------------------
let toastTimer = null;
function toast(msg, type = '') {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = 'toast show ' + type;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.className = 'toast'; }, 3000);
}

// ---- Auth ----------------------------------------------------------------
// Login flows:
//   1. Probe GET /api/config to verify the key.
//   2. If it succeeds → enter normally.
//   3. If it fails with "use admin UI" / "KV not bound" (i.e. auth PASSED
//      but the config store is empty/missing) → still let the user in
//      with an empty cfg, so they can write the first config.
//   4. Anything else (auth failed, etc.) → fail the login.
function doLogin() {
  const k = document.getElementById('loginKey').value.trim();
  if (!k) { document.getElementById('loginErr').textContent = '请输入 key'; return; }
  setKey(k);
  // Probe /api/config to verify the key
  api('GET', '/api/config').then((d) => {
    document.getElementById('loginErr').textContent = '';
    enterApp(d.config, d, false);
  }).catch((e) => {
    const msg = e?.message || '';
    // The "use admin UI" / "KV not bound" / "AGENT_CONFIG_JSON" errors
    // all mean auth passed but config store is not ready.  Let the user
    // in with an empty config so they can fix it from the UI.
    if (
      msg.includes('use admin UI') ||
      msg.includes('KV namespace is not bound') ||
      msg.includes('AGENT_CONFIG_JSON')
    ) {
      enterApp({ providers: {}, agent_models: {} }, { source: 'empty', last_modified: null }, true);
    } else {
      clearKey();
      document.getElementById('loginErr').textContent = '登录失败：' + msg;
    }
  });
}

function enterApp(config, meta, firstRun) {
  document.getElementById('loginScreen').style.display = 'none';
  document.getElementById('appScreen').style.display = '';
  document.getElementById('logoutBtn').style.display = '';
  cfg = config || { providers: {}, agent_models: {} };
  cfgMeta = meta || {};
  renderAll();
  if (firstRun) {
    toast('KV 还没 config。填好后点 "保存到 KV"。', 'ok');
  } else {
    toast('登录成功', 'ok');
  }
}

function doLogout() {
  clearKey();
  cfg = null; cfgMeta = null; cooldowns = [];
  document.getElementById('loginScreen').style.display = '';
  document.getElementById('appScreen').style.display = 'none';
  document.getElementById('logoutBtn').style.display = 'none';
  document.getElementById('loginKey').value = '';
}

document.getElementById('logoutBtn').addEventListener('click', doLogout);

// ---- Tabs ---------------------------------------------------------------
document.querySelectorAll('.tab').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((b) => b.classList.remove('active'));
    document.querySelectorAll('.pane').forEach((p) => p.style.display = 'none');
    btn.classList.add('active');
    const id = btn.dataset.tab;
    document.querySelector(`.pane[data-pane="${id}"]`).style.display = '';
    if (id === 'state') refreshState();
  });
});

// ---- Render: providers & keys -----------------------------------------
function renderProviders() {
  const root = document.getElementById('providersList');
  if (!cfg) { root.innerHTML = '<p class="hint">未加载</p>'; return; }
  const providers = cfg.providers || {};
  const names = Object.keys(providers);
  if (names.length === 0) {
    root.innerHTML = '<p class="hint">还没有服务商，点右上"+ 新增服务商"开始。</p>';
    return;
  }
  root.innerHTML = names.map((name) => {
    const p = providers[name] || {};
    const keys = p.keys || {};
    const keyRows = Object.entries(keys).map(([label, value]) => `
      <div class="field-row" data-key-row="${esc(name)}/${esc(label)}">
        <label>${esc(label)}</label>
        <input type="password" data-key-input="${esc(name)}/${esc(label)}" value="${esc(value)}" autocomplete="off" />
        <button class="btn btn-sm btn-ghost" data-test-key="${esc(name)}/${esc(label)}">测试</button>
        <button class="btn btn-sm btn-danger" data-del-key="${esc(name)}/${esc(label)}">删除</button>
      </div>
    `).join('');
    return `
      <div class="card" data-provider="${esc(name)}">
        <div class="card-head">
          <div class="card-title">📡 ${esc(name)}</div>
          <div class="card-actions">
            <button class="btn btn-sm" data-add-key="${esc(name)}">+ Key</button>
            <button class="btn btn-sm btn-danger" data-del-provider="${esc(name)}">删除服务商</button>
          </div>
        </div>
        <div class="field-row">
          <label>base_url</label>
          <input data-base="${esc(name)}" value="${esc(p.base_url || '')}" />
        </div>
        <div>${keyRows || '<p class="hint" style="margin:0">还没有 Key，点 "+ Key" 添加</p>'}</div>
      </div>
    `;
  }).join('');

  // Wire events
  root.querySelectorAll('[data-base]').forEach((el) => {
    el.addEventListener('change', (e) => { cfg.providers[e.target.dataset.base].base_url = e.target.value.trim(); });
  });
  root.querySelectorAll('[data-key-input]').forEach((el) => {
    el.addEventListener('change', (e) => {
      const [p, k] = e.target.dataset.keyInput.split('/');
      cfg.providers[p].keys[k] = e.target.value;
    });
  });
  root.querySelectorAll('[data-add-key]').forEach((el) => {
    el.addEventListener('click', (e) => {
      const p = e.target.dataset.addKey;
      const name = prompt('新 Key 标签（label）');
      if (!name) return;
      if (!cfg.providers[p].keys) cfg.providers[p].keys = {};
      cfg.providers[p].keys[name] = '';
      renderProviders();
    });
  });
  root.querySelectorAll('[data-del-key]').forEach((el) => {
    el.addEventListener('click', (e) => {
      const [p, k] = e.target.dataset.delKey.split('/');
      if (!confirm(`删除 Key "${p}/${k}"？`)) return;
      delete cfg.providers[p].keys[k];
      renderProviders();
    });
  });
  root.querySelectorAll('[data-del-provider]').forEach((el) => {
    el.addEventListener('click', (e) => {
      const p = e.target.dataset.delProvider;
      if (!confirm(`删除服务商 "${p}"？`)) return;
      delete cfg.providers[p];
      renderProviders();
    });
  });
  root.querySelectorAll('[data-test-key]').forEach((el) => {
    el.addEventListener('click', (e) => {
      const [p, k] = e.target.dataset.testKey.split('/');
      testConnection(p, k);
    });
  });
}

function addProvider() {
  const name = prompt('服务商名称（小写英文，如 sensenova）');
  if (!name) return;
  if (cfg.providers[name]) { toast('已存在', 'err'); return; }
  cfg.providers[name] = { base_url: 'https://', keys: {} };
  renderProviders();
}

// ---- Render: models -----------------------------------------------------
function renderModels() {
  const root = document.getElementById('modelsList');
  if (!cfg) { root.innerHTML = '<p class="hint">未加载</p>'; return; }
  const models = cfg.agent_models || {};
  const names = Object.keys(models);
  if (names.length === 0) {
    root.innerHTML = '<p class="hint">还没有模型。</p>';
    return;
  }
  root.innerHTML = names.map((name) => {
    const m = models[name] || {};
    const bindings = Array.isArray(m.keys) ? m.keys : [];
    const bindingRows = bindings.map((b, idx) => {
      const providerOptions = Object.keys(cfg.providers || {}).map((p) =>
        `<option value="${esc(p)}" ${p === b.provider ? 'selected' : ''}>${esc(p)}</option>`
      ).join('');
      const keyOptions = (() => {
        if (!b.provider || !cfg.providers[b.provider]) return '';
        return Object.keys(cfg.providers[b.provider].keys || {}).map((k) =>
          `<option value="${esc(k)}" ${k === b.key ? 'selected' : ''}>${esc(k)}</option>`
        ).join('');
      })();
      return `
        <div class="field-row" data-binding-row="${esc(name)}/${idx}">
          <select data-bind-provider="${esc(name)}/${idx}">
            <option value="">— provider —</option>
            ${providerOptions}
          </select>
          <select data-bind-key="${esc(name)}/${idx}">
            <option value="">— key —</option>
            ${keyOptions}
          </select>
          <input placeholder="upstream_model（可空）" data-bind-upstream="${esc(name)}/${idx}" value="${esc(b.upstream_model || '')}" />
          <button class="btn btn-sm btn-danger" data-del-binding="${esc(name)}/${idx}">删除</button>
        </div>
      `;
    }).join('');
    return `
      <div class="card" data-model="${esc(name)}">
        <div class="card-head">
          <div class="card-title">🤖 ${esc(name)}</div>
          <div class="card-actions">
            <button class="btn btn-sm" data-add-binding="${esc(name)}">+ 绑定</button>
            <button class="btn btn-sm btn-danger" data-del-model="${esc(name)}">删除模型</button>
          </div>
        </div>
        <div>${bindingRows || '<p class="hint" style="margin:0">还没有绑定</p>'}</div>
      </div>
    `;
  }).join('');

  // Wire events
  root.querySelectorAll('[data-bind-provider]').forEach((el) => {
    el.addEventListener('change', (e) => {
      const [name, idx] = e.target.dataset.bindProvider.split('/');
      const bindings = cfg.agent_models[name].keys;
      bindings[+idx].provider = e.target.value;
      bindings[+idx].key = '';
      renderModels(); // re-render so the key dropdown updates
    });
  });
  root.querySelectorAll('[data-bind-key]').forEach((el) => {
    el.addEventListener('change', (e) => {
      const [name, idx] = e.target.dataset.bindKey.split('/');
      cfg.agent_models[name].keys[+idx].key = e.target.value;
    });
  });
  root.querySelectorAll('[data-bind-upstream]').forEach((el) => {
    el.addEventListener('change', (e) => {
      const [name, idx] = e.target.dataset.bindUpstream.split('/');
      const v = e.target.value.trim();
      if (v) cfg.agent_models[name].keys[+idx].upstream_model = v;
      else delete cfg.agent_models[name].keys[+idx].upstream_model;
    });
  });
  root.querySelectorAll('[data-add-binding]').forEach((el) => {
    el.addEventListener('click', (e) => {
      cfg.agent_models[e.target.dataset.addBinding].keys.push({ provider: '', key: '' });
      renderModels();
    });
  });
  root.querySelectorAll('[data-del-binding]').forEach((el) => {
    el.addEventListener('click', (e) => {
      const [name, idx] = e.target.dataset.delBinding.split('/');
      cfg.agent_models[name].keys.splice(+idx, 1);
      renderModels();
    });
  });
  root.querySelectorAll('[data-del-model]').forEach((el) => {
    el.addEventListener('click', (e) => {
      const name = e.target.dataset.delModel;
      if (!confirm(`删除模型 "${name}"？`)) return;
      delete cfg.agent_models[name];
      renderModels();
    });
  });
}

function addModel() {
  const name = prompt('模型 ID（如 deepseek-v4-flash）');
  if (!name) return;
  if (cfg.agent_models[name]) { toast('已存在', 'err'); return; }
  cfg.agent_models[name] = { keys: [] };
  renderModels();
}

// ---- Render: state -----------------------------------------------------
async function refreshState() {
  try {
    const data = await api('GET', '/api/state');
    cooldowns = data.cooldowns || [];
    renderState();
  } catch (e) {
    document.getElementById('stateList').innerHTML = `<p class="err">读取 KV 状态失败：${esc(e.message)}</p>`;
  }
}

function renderState() {
  const root = document.getElementById('stateList');
  if (cooldowns.length === 0) {
    root.innerHTML = '<p class="hint">没有 cooldown 记录。</p>';
    return;
  }
  const inCooldown = cooldowns.filter((c) => c.inCooldown);
  const clean = cooldowns.filter((c) => !c.inCooldown);
  const fmt = (ms) => {
    if (ms <= 0) return '—';
    if (ms < 60_000) return `${Math.ceil(ms/1000)}s`;
    return `${Math.ceil(ms/60_000)}m ${Math.floor((ms%60_000)/1000)}s`;
  };
  const renderRow = (c) => `
    <div class="kv-row ${c.inCooldown ? 'bad' : 'cool'}" data-state-row="${esc(c.provider)}/${esc(c.keyLabel)}">
      <span>📡 <b>${esc(c.provider)}</b></span>
      <span>🔑 ${esc(c.keyLabel)} <span class="ts">(${esc(c.upstreamModel)})</span></span>
      <span>${c.inCooldown ? '⏱ 冷却中 剩余 ' + fmt(c.remainingMs) : '✅ 正常'}${c.consecutiveFailures > 0 ? ' · 失败 ' + c.consecutiveFailures + ' 次' : ''}</span>
      <button class="btn btn-sm btn-ghost" data-clear-key="${esc(c.provider)}/${esc(c.keyLabel)}">清除</button>
    </div>
  `;
  let html = '';
  if (inCooldown.length) {
    html += `<h3 style="margin:16px 0 8px 0;font-size:13px;color:var(--danger)">冷却中 (${inCooldown.length})</h3>`;
    html += inCooldown.map(renderRow).join('');
  }
  if (clean.length) {
    html += `<h3 style="margin:16px 0 8px 0;font-size:13px;color:var(--text-2)">正常 (${clean.length})</h3>`;
    html += clean.map(renderRow).join('');
  }
  root.innerHTML = html;
  root.querySelectorAll('[data-clear-key]').forEach((el) => {
    el.addEventListener('click', async (e) => {
      const [p, k] = e.target.dataset.clearKey.split('/');
      await clearKeyCooldown(p, k);
    });
  });
}

async function clearAllCooldowns() {
  if (!confirm('清空所有 key 的 cooldown 和失败计数？')) return;
  try {
    await api('DELETE', '/api/state');
    toast('已清空', 'ok');
    refreshState();
  } catch (e) {
    toast('清空失败：' + e.message, 'err');
  }
}

async function clearKeyCooldown(provider, keyLabel) {
  // We use DELETE /api/state?provider=...&key=... — but our endpoint
  // doesn't support that yet.  For now, just clear all and let the
  // operator pick the right one manually.
  await clearAllCooldowns();
}

// ---- Raw JSON editor ----------------------------------------------------
function renderRawJson() {
  const ta = document.getElementById('rawJson');
  ta.value = JSON.stringify(cfg, null, 2);
}
async function saveRawConfig() {
  const ta = document.getElementById('rawJson');
  const errEl = document.getElementById('rawErr');
  errEl.textContent = '';
  let parsed;
  try {
    parsed = JSON.parse(ta.value);
  } catch (e) {
    errEl.textContent = 'JSON 解析失败：' + e.message;
    return;
  }
  try {
    const res = await api('POST', '/api/config', { config: parsed });
    toast('已保存到 KV，' + (res.propagation_hint || ''), 'ok');
    cfg = res.config;
    if (res.last_modified) cfgMeta.last_modified = res.last_modified;
    cfgMeta.source = res.source || 'kv';
    renderAll();
  } catch (e) {
    errEl.textContent = '保存失败：' + e.message;
  }
}

// ---- Test connection ---------------------------------------------------
async function testConnection(provider, keyLabel) {
  toast(`测试 ${provider}/${keyLabel} ...`);
  try {
    const res = await api('POST', '/api/test', { provider, key: keyLabel });
    if (res.ok) toast(`✅ ${res.verdict} (${res.latency_ms}ms)`, 'ok');
    else toast(`❌ ${res.verdict}`, 'err');
  } catch (e) {
    toast('测试失败：' + e.message, 'err');
  }
}

// ---- Wiring ------------------------------------------------------------
function renderAll() {
  const sourceLabel = cfgMeta?.source === 'kv' ? 'KV'
    : cfgMeta?.source === 'env' ? 'ENV'
    : cfgMeta?.source === 'empty' ? '空'
    : '?';
  const sourceClass = cfgMeta?.source === 'kv' ? 'ok'
    : cfgMeta?.source === 'empty' ? 'warn'
    : (cfgMeta?.source === 'env' ? 'warn' : '');
  document.getElementById('configSource').textContent = sourceLabel;
  document.getElementById('configSource').className = 'badge ' + sourceClass;
  renderProviders();
  renderModels();
  renderRawJson();
  refreshState();
}

// ---- ESC helpers --------------------------------------------------------
function esc(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ---- Init ---------------------------------------------------------------
window.addEventListener('DOMContentLoaded', () => {
  // Auto-login if a key is already in storage
  if (key()) {
    doLogin();
  }
  document.getElementById('loginKey').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') doLogin();
  });
});

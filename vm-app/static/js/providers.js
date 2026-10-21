/**
 * OCRProxy Admin - Provider Inventory, A-Z Nav Rail & Local Key Management
 */
const PROTOCOLS = {
  chat: { label: 'OpenAI Chat', short: 'OpenAI', badgeClass: 'badge-success', title: 'OpenAI 协议' },
  openai: { label: 'OpenAI Chat', short: 'OpenAI', badgeClass: 'badge-success', title: 'OpenAI 协议' },
  messages: { label: 'Anthropic Messages', short: 'Message', badgeClass: 'badge-warning', title: 'Anthropic 协议' },
  anthropic: { label: 'Anthropic Messages', short: 'Message', badgeClass: 'badge-warning', title: 'Anthropic 协议' },
  responses: { label: 'OpenAI Responses', short: 'OpenAI', badgeClass: 'badge-success', title: 'OpenAI 协议' },
  google_openai: { label: 'Google OpenAI', short: 'OpenAI', badgeClass: 'badge-success', title: 'Google OpenAI 协议' }
};


function scrollToAlphaGroup(ch) {
  const target = document.getElementById(`alpha-group-${ch}`);
  if (target) {
    target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    target.classList.remove('alpha-target-highlight');
    void target.offsetWidth;
    target.classList.add('alpha-target-highlight');
  }
}

function getProviderPermissions(provName, provObj) {
  const isHostEdgeOne = Boolean(typeof HOST !== 'undefined' && HOST && HOST.isEdgeOne);
  const p = provObj || (state.config && state.config.providers && state.config.providers[provName]) || {};
  const isVault = p.origin === 'vault';
  return {
    isHostEdgeOne,
    isVault,
    isLocal: p.origin === 'local' || !isVault,
    canDelete: true, // VM 与 EdgeOne 均允许无条件删除本地配置
    canEdit: true,
    canAddKey: true
  };
}

function getProviderPresetMeta(provName, provObj) {
  const p = provObj || (state.config && state.config.providers && state.config.providers[provName]) || {};
  let ver = p.preset_version;
  let date = p.preset_updated_at;

  const presetKey = (p.preset_id || provName || '').toLowerCase().trim();
  const preset = (state.cachedPresets && state.cachedPresets[presetKey])
    || (state.presetCatalog && state.presetCatalog.find(x => x.id && x.id.toLowerCase() === presetKey))
    || FALLBACK_PRESETS[presetKey];

  if (preset) {
    if (!ver) ver = preset.version;
    if (!date) date = preset.updated_at;
  }
  return { version: ver, updated_at: date, isPreset: Boolean(preset) };
}

function getPresetProtocolLabel(p) {
  if (!p) return 'openai';
  return formatProtocolLabel(getPresetProtocols(p) || ['chat']);
}

function renderProviders(){
  const box = document.getElementById('providersBox');
  const rail = document.getElementById('alphabetNavRail');
  const railInner = document.getElementById('alphaRailInner');
  if (!box) return;
  box.innerHTML = '';
  const p = (state && state.config && state.config.providers) ? state.config.providers : (window.cfg?.providers || {});
  const names = Object.keys(p).sort((a,b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));

  if (!names.length){
    box.innerHTML = '<div class="empty">暂无供应商配置，请点击右上角「新增供应商」</div>';
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
      const perms = getProviderPermissions(name, prov);
      const isHostEdgeOne = perms.isHostEdgeOne;
      const isVaultManaged = perms.isVault;
      const keys = Object.keys(prov.keys || {});
      const keyChips = keys.map(k => {
        const val = prov.keys[k];
        const keySrc = resolveKeySource(name, k);
        const gcpBadge = (typeof val === 'object' && val !== null && (val.project_id || val.location))
          ? `<span class="badge badge-purple" style="font-size:10px;padding:1px 5px;" title="GCP: ${esc(val.project_id || '—')} (${esc(val.location || 'global')})">GCP: ${esc(val.project_id || '—')} (${esc(val.location || 'global')})</span>`
          : '';
        const sourceBadge = keySourceBadge(keySrc, 10);
        // VM 端中枢 Key 只读可删：编辑入口不渲染（点击也只会报错）；
        // EdgeOne 本身就是中枢母本，Key 仍可自由编辑。
        const editBtn = (keySrc === 'vault' && !isHostEdgeOne) ? '' : `<button class="btn-ghost" style="padding:0 2px" onclick="editKey('${esc(name)}','${esc(k)}')">编辑</button>`;
        const deleteBtn = `<button class="btn-ghost" style="padding:0 2px;color:var(--error)" onclick="deleteKey('${esc(name)}','${esc(k)}')">×</button>`;
        const actions = editBtn + deleteBtn;
        return `
          <span class="key-chip">
            <b>${esc(k)}</b>
            ${sourceBadge}
            ${gcpBadge}
            ${actions}
          </span>
        `;
      }).join('');

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
      const provRpmVal = prov.rpm || prov.rpm_per_key;
      const provRpmBadge = (provRpmVal && Number(provRpmVal) > 0)
        ? `<span class="badge" style="font-size:11px;padding:2px 7px;background:rgba(59,130,246,0.12);color:var(--primary);font-weight:600;" title="每 Key 默认限流阈值">${provRpmVal} RPM</span>`
        : '';
      const meta = getProviderPresetMeta(name, prov);
      let ver = '';
      if (meta.version) {
        ver = `规则 v${meta.version}`;
      } else if (prov.adapter_rules) {
        ver = '自定义规则';
      } else {
        ver = '默认';
      }
      const dateText = meta.updated_at ? ` · ${meta.updated_at}` : '';
      const verBadge = `<span class="badge badge-neutral" style="font-size:11px;padding:2px 7px;" title="适配规则版本与更新日期">${esc(ver + dateText)}</span>`;
      
      const lockIcon = `<svg class="khc-icon" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>`;
      let vaultBadge;
      if (isHostEdgeOne) {
        vaultBadge = (prov.origin === 'local')
          ? `<span class="badge badge-success" style="font-size:11px;padding:2px 7px;" title="EdgeOne 本地自建供应商">本地自建</span>`
          : `<span class="badge badge-primary" style="font-size:11px;padding:2px 7px;display:inline-flex;align-items:center;gap:3px;" title="EdgeOne 凭据中枢母本供应商">${lockIcon} 中枢统一</span>`;
      } else {
        vaultBadge = isVaultManaged 
          ? `<span class="badge badge-primary" style="font-size:11px;padding:2px 7px;display:inline-flex;align-items:center;gap:3px;" title="从 EdgeOne 凭据中枢拉取：规则随「同步中枢规则」更新；中枢 Key 只读可删，自加 Key 为本地">${lockIcon} 来自中枢</span>`
          : `<span class="badge badge-success" style="font-size:11px;padding:2px 7px;" title="本地手动自建供应商">本地自建</span>`;
      }

      const hasUpdate = state.ruleUpdatesMap && state.ruleUpdatesMap[name];
      const updateDateText = (hasUpdate && hasUpdate.updated_at) ? ` (${esc(hasUpdate.updated_at)})` : '';
      const updateBtn = hasUpdate
        ? `<button class="btn btn-warning btn-sm" onclick="applySingleProviderRuleUpdate('${esc(name)}')">${icon('arrowUp')} 升级至 v${esc(hasUpdate.remote_version)}${updateDateText}</button>`
        : '';

      const actionButtons = `
        <button class="btn btn-secondary btn-sm" onclick="editProvider('${esc(name)}')">编辑</button>
        <button class="btn btn-secondary btn-sm" onclick="openKeyModal('${esc(name)}')">+ Key</button>
        <button class="btn btn-danger btn-sm" onclick="deleteProvider('${esc(name)}')">删除</button>
      `;

      html += `<div class="provider-row" id="provider-card-${esc(name)}">
        <div class="provider-main-info" style="flex:1;min-width:0;">
          <div class="provider-header-line" style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
            <span style="font-size:14px;font-weight:700;color:var(--text);">${esc(name)}</span>
            <span style="display:inline-flex;gap:4px;align-items:center;flex-wrap:wrap;">${protoBadges} ${provRpmBadge} ${verBadge} ${vaultBadge}</span>
          </div>
          <div class="provider-url mono" style="font-size:12px;color:var(--text-secondary);margin-top:4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:100%;" title="${esc(prov.base_url)}${messagesUrlPart}">${esc(prov.base_url)}${messagesUrlPart}</div>
          <div class="key-list" style="margin-top:6px;">${keyChips || '<span class="text-secondary text-sm">暂无 Key 凭证</span>'}</div>
        </div>
        <div class="provider-actions" style="display:flex;align-items:center;gap:8px;flex-shrink:0;white-space:nowrap;margin-left:12px;">
          ${updateBtn}
          ${actionButtons}
        </div>
      </div>`;
    }
  }
  box.innerHTML = html;
}


const FALLBACK_PRESETS = {
  agnes: {
    id: 'agnes',
    name: 'Agnes AI',
    version: '1.4.0',
    updated_at: '2026-10-18',
    base_url: 'https://apihub.agnes-ai.com/v1',
    anthropic_base_url: 'https://apihub.agnes-ai.com/v1',
    protocols: ['chat', 'messages'],
    description: 'Agnes AI 平台，支持 agnes-3.0-flash 等高并发轻量 Agent 模型 (512K 上下文)。',
    features: { native_thinking: true, tools: true, multimodal: true, anthropic_messages: true }
  },
  amd: {
    id: 'amd',
    name: 'AMD Radeon Cloud',
    version: '2026.10.19',
    updated_at: '2026-10-19',
    base_url: 'https://developer.amd.com.cn/radeon/api/v1',
    anthropic_base_url: 'https://developer.amd.com.cn/radeon/api/v1',
    protocols: ['chat', 'messages'],
    description: 'AMD 官方开发者平台，基于高性能推理集群。原生直通深度思考，自动适配 system 消息置顶规整与 reasoning 思考字段映射。',
    features: { native_thinking: true, multimodal: false, tools: true, anthropic_messages: true }
  },
  bai: {
    id: 'bai',
    name: 'B.AI',
    version: '1.4.0',
    updated_at: '2026-10-18',
    base_url: 'https://api.b.ai/v1',
    anthropic_base_url: 'https://api.b.ai/v1',
    protocols: ['chat', 'messages'],
    description: 'B.AI 统一大模型中转平台，原生兼容 OpenAI Chat Completions 与 Anthropic Messages 协议双通道。',
    features: { native_thinking: true, tools: true, anthropic_messages: true }
  },
  cline: {
    id: 'cline',
    name: 'Cline',
    version: '1.1.0',
    updated_at: '2026-10-18',
    base_url: 'https://api.cline.bot/api/v1',
    protocols: ['chat'],
    description: 'Cline 官方大模型 API，基于 OpenRouter 聚合架构，支持 Claude、GPT-4o、Gemini 2.5 等多厂商模型。',
    features: { native_thinking: true, tools: true, multimodal: true }
  },
  deepseek: {
    id: 'deepseek',
    name: 'DeepSeek 官方开放平台',
    version: '1.2.0',
    updated_at: '2026-10-18',
    base_url: 'https://api.deepseek.com/v1',
    protocols: ['chat'],
    description: 'DeepSeek 官方 API，原生支持 reasoning_content 深度思考与前缀缓存。',
    features: { native_thinking: true, tools: true }
  },
  google: {
    id: 'google',
    name: 'Google AI Studio',
    version: '1.2.0',
    updated_at: '2026-10-18',
    base_url: 'https://generativelanguage.googleapis.com/v1beta/openai',
    protocols: ['chat'],
    description: 'Google 官方 Gemini 系列大模型，支持 Gemini 2.5 / 3 / 3.5+。系统已内置 Thinking Config 思考等级映射。',
    features: { native_thinking: true, multimodal: true, tools: true }
  },
  minimax: {
    id: 'minimax',
    name: 'MiniMax',
    version: '1.4.0',
    updated_at: '2026-10-18',
    base_url: 'https://api.minimaxi.com/v1',
    anthropic_base_url: 'https://api.minimax.cn/anthropic',
    protocols: ['chat', 'messages'],
    description: 'MiniMax 官方开放平台，原生兼容 OpenAI Completions 与 Anthropic Messages 双协议直通。',
    features: { native_thinking: true, multimodal: true, tools: true, anthropic_messages: true }
  },
  nvidia: {
    id: 'nvidia',
    name: 'NVIDIA NIM',
    version: '2.0.0',
    updated_at: '2026-10-18',
    base_url: 'https://integrate.api.nvidia.com/v1',
    protocols: ['chat'],
    description: 'NVIDIA NIM 官方加速平台，流式推理返回 reasoning_content，已加固自动关流防护。',
    features: { multimodal: true, native_thinking: true, tools: true }
  },
  openai: {
    id: 'openai',
    name: 'OpenAI 官方',
    version: '1.2.1',
    updated_at: '2026-10-19',
    base_url: 'https://api.openai.com/v1',
    protocols: ['chat'],
    description: 'OpenAI 官方 API 或标准兼容中转网关，纯中转零损耗极速透传，原生支持 reasoning_effort 思考控制。',
    features: { native_thinking: true, tools: true, multimodal: true }
  },
  opencode: {
    id: 'opencode',
    name: 'OpenCode Zen',
    version: '2.0.0',
    updated_at: '2026-10-18',
    base_url: 'https://opencode.ai/zen/v1',
    protocols: ['chat'],
    description: 'OpenCode 官方开放平台，纯净 OpenAI 协议直通透传，适用于个人已购配额或标准模型。',
    features: { multimodal: true, native_thinking: true, tools: true }
  },
  openrouter: {
    id: 'openrouter',
    name: 'OpenRouter',
    version: '1.0.0',
    updated_at: '2026-10-18',
    base_url: 'https://openrouter.ai/api/v1',
    anthropic_base_url: 'https://openrouter.ai/api/v1',
    protocols: ['chat', 'messages'],
    description: 'OpenRouter 全球模型聚合网关，原生支持 OpenAI 与 Anthropic 双协议。',
    features: { anthropic_messages: true, multimodal: true, native_thinking: true, tools: true }
  },
  sensenova: {
    id: 'sensenova',
    name: '商汤日日新',
    version: '1.3.0',
    updated_at: '2026-10-18',
    base_url: 'https://token.sensenova.cn/v1',
    anthropic_base_url: 'https://token.sensenova.cn/v1',
    protocols: ['chat', 'messages'],
    description: '商汤日日新大模型开放平台，支持 sensenova-6.8-flash-lite、deepseek-v4-flash、glm-5.2 等旗舰与轻量模型。',
    features: { native_thinking: true, multimodal: true, tools: true, anthropic_messages: true }
  },
  siliconflow: {
    id: 'siliconflow',
    name: '硅基流动',
    version: '1.2.0',
    updated_at: '2026-10-18',
    base_url: 'https://api.siliconflow.cn/v1',
    protocols: ['chat'],
    description: '硅基流动高并发推理平台，包含 DeepSeek、Qwen 等开源模型及向量/重排模型。',
    features: { native_thinking: true, tools: true }
  },
  stepfun: {
    id: 'stepfun',
    name: '阶跃星辰',
    version: '1.2.0',
    updated_at: '2026-10-18',
    base_url: 'https://api.stepfun.com/step_plan',
    protocols: ['chat'],
    description: '阶跃星辰 StepFun 大模型平台，系统内置 reasoning_effort none->low 降级兼容与 deepseek 思考格式注入。',
    features: { native_thinking: true, multimodal: true, tools: true }
  },
  tokenrhythm: {
    id: 'tokenrhythm',
    name: 'TokenRhythm',
    version: '1.2.0',
    updated_at: '2026-10-18',
    base_url: 'https://tokenrhythm.studio/v1',
    protocols: ['chat'],
    description: 'TokenRhythm 聚合大模型路由网关，系统内置 tool_choice 对象转字符串自动清洗。',
    features: { native_thinking: true, tools: true }
  },
  vertex: {
    id: 'vertex',
    name: 'Google Vertex AI',
    version: '1.1.0',
    updated_at: '2026-10-18',
    base_url: 'https://aiplatform.googleapis.com/v1beta1/projects/{project_id}/locations/global/endpoints/openapi',
    protocols: ['chat'],
    description: 'Google Cloud Vertex AI 官方大模型端点。凭证、Project ID 与服务区域在新增 Key 时强绑定，自动规整 google/ 前缀与思考配置。',
    features: { native_thinking: true, multimodal: true, tools: true }
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
      updated_at: FALLBACK_PRESETS[k].updated_at || '2026-10-18',
      protocols: FALLBACK_PRESETS[k].protocols,
      features: FALLBACK_PRESETS[k].features,
      anthropic_base_url: FALLBACK_PRESETS[k].anthropic_base_url,
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
  const isHostEdgeOne = Boolean(typeof HOST !== 'undefined' && HOST && HOST.isEdgeOne);
  let vaultGroupHtml = '';
  if (!isHostEdgeOne && typeof getVaultProviderList === 'function') {
    const localProviders = state.config?.providers || {};
    const localKeys = Object.keys(localProviders).map(k => k.toLowerCase());
    const remoteList = getVaultProviderList();
    const unconfigured = remoteList.filter(rp => {
      const pId = (rp.id || '').toLowerCase();
      return pId && !localKeys.includes(pId);
    });
    if (unconfigured.length > 0) {
      vaultGroupHtml = '<optgroup label="EdgeOne 凭据中枢托管 (按需拉取)">' +
        unconfigured.map(rp => {
          const protos = rp.protocols || ['chat'];
          const protoStr = (typeof formatProtocolsDisplay === 'function') ? formatProtocolsDisplay(protos) : protos.join('+');
          const cleanName = (typeof cleanProviderLabel === 'function') ? cleanProviderLabel(rp.name || rp.id) : (rp.name || rp.id);
          return `<option value="vault:${rp.id}">${cleanName} (${protoStr})</option>`;
        }).join('') +
        '</optgroup>';
    }
  }

  // 新增供应商下拉只表达「来源」：自定义（本地）或从中枢按需拉取。
  // 官方预设不是供应商来源、不再出现在 UI 中：它们是本地适配规则模板，
  // 只在供应商配置到本地后按 id/名称自动匹配并随保存落地（见 applyPresetForProviderName）。
  select.innerHTML = '<option value="">-- 自定义供应商 (手动填写) --</option>' + vaultGroupHtml;
  if (cur !== undefined && cur !== null) select.value = cur;
}

// Thin adapter over the canonical normalizer (kept as Set for legacy call sites).
function normalizePresetProtocols(raw){
  return new Set(normalizeProtocolList(raw));
}

// 适配脚本（本地预设文件）支持哪些协议：chat 恒有；Messages 由 features.anthropic_messages /
// anthropic_base_url 声明；Responses 由 features.openai_responses 声明。
function getPresetProtocols(preset){
  if (!preset) return null;
  const norm = normalizePresetProtocols(preset.protocols);
  const proto = String(preset.protocol || '').toLowerCase();
  const feat = preset.features || {};
  if (feat.anthropic_messages || preset.anthropic_base_url || proto.includes('messages')) norm.add('messages');
  if (feat.openai_responses || proto.includes('responses')) norm.add('responses');
  return Array.from(norm);
}

function findPresetForProvider(idOrName){
  const key = String(idOrName || '').trim().toLowerCase();
  if (!key) return null;
  return (state.cachedPresets && state.cachedPresets[key])
    || FALLBACK_PRESETS[key]
    || ((state.presetCatalog || []).find(p => p && (
        String(p.id || '').toLowerCase() === key || String(p.name || '').toLowerCase() === key)));
}

function _applyProviderProtocols(protocols, preset){
  const set = new Set(protocols || []);
  document.getElementById('p_proto_chat').checked = set.has('chat');
  document.getElementById('p_proto_messages').checked = set.has('messages');
  document.getElementById('p_proto_responses').checked = set.has('responses');
  const hint = document.getElementById('p_proto_hint');
  if (hint) {
    const labels = [];
    if (set.has('chat')) labels.push('OpenAI Chat');
    if (set.has('messages')) labels.push('Anthropic Messages');
    if (set.has('responses')) labels.push('OpenAI Responses');
    hint.textContent = labels.length
      ? `已按${preset ? '适配脚本' : '中枢返回'}预选：${labels.join(' + ')}（可手动调整）`
      : '未匹配到协议，请手动勾选';
  }
}

// 供应商来源说明只保留两条判断：中枢 Key 数量、是否有适配脚本及其版本。
function _renderProviderSourceDesc(title, keyCount, preset){
  const descEl = document.getElementById('p_desc');
  if (!descEl) return;
  const parts = [`<strong>${esc(title || '')}</strong>`];
  if (keyCount !== null && keyCount !== undefined) {
    parts.push(`<span class="badge badge-primary">中枢 ${keyCount} 个 Key</span>`);
  }
  if (preset) {
    const ver = preset.version ? `v${esc(preset.version)}` : '已匹配';
    const date = preset.updated_at ? ` · ${esc(preset.updated_at)}` : '';
    parts.push(`<span class="badge badge-success">适配脚本 ${ver}${date}</span>`);
  } else {
    parts.push(`<span class="badge badge-neutral">无适配脚本</span>`);
  }
  descEl.style.display = 'block';
  descEl.style.background = 'var(--bg-subtle)';
  descEl.style.color = 'var(--text-primary)';
  descEl.innerHTML = `<div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;">${parts.join('')}</div>`;
}

// 预设适配规则按「本地配置后的供应商名称」自动匹配：预设不进入下拉，
// 但输入与官方预设同名/同 id 的供应商标识时，自动带入 URL、协议、RPM 与规则说明。
function applyPresetForProviderName(){
  if (state.providerEditName || state.currentSelectedVaultProvider) return;
  const nameEl = document.getElementById('p_name');
  const key = (nameEl?.value || '').trim().toLowerCase();
  const hint = document.getElementById('p_proto_hint');
  if (!key) {
    state.currentSelectedPreset = null;
    if (hint) hint.textContent = '';
    return;
  }
  const preset = findPresetForProvider(key);
  state.currentSelectedPreset = preset || null;
  if (!preset) {
    if (hint) hint.textContent = '未匹配到适配脚本，请手动选择协议';
    return;
  }

  const urlInput = document.getElementById('p_url');
  if (urlInput && !urlInput.value.trim() && preset.base_url) urlInput.value = preset.base_url;

  const protos = getPresetProtocols(preset);
  _applyProviderProtocols(protos, preset);

  const anthropicUrl = preset.anthropic_base_url || '';
  const toggle = document.getElementById('p_custom_url_toggle');
  const section = document.getElementById('p_custom_url_section');
  if (anthropicUrl && protos.includes('messages') && toggle && section) {
    toggle.checked = true;
    section.style.display = 'block';
    document.getElementById('p_anthropic_url').value = anthropicUrl;
  }
  const rpmInput = document.getElementById('p_rpm');
  const provRpm = preset.rpm_per_key || preset.rpm;
  if (rpmInput && !rpmInput.value.trim() && provRpm) rpmInput.value = String(provRpm);

  _renderProviderSourceDesc(preset.name || key, null, preset);
}

// Vertex AI dynamic Base URL computation (Key Level)
function onKeyVertexParamChange(){
  const proj = (document.getElementById('k_vertex_project')?.value || '').trim();
  const locRaw = (document.getElementById('k_vertex_location')?.value || '').trim() || 'global';
  const loc = locRaw.toLowerCase();
  const projDisplay = proj || '{project_id}';
  
  let baseUrl = '';
  if (loc === 'global') {
    baseUrl = `https://aiplatform.googleapis.com/v1beta1/projects/${projDisplay}/locations/global/endpoints/openapi`;
  } else {
    baseUrl = `https://${loc}-aiplatform.googleapis.com/v1beta1/projects/${projDisplay}/locations/${loc}/endpoints/openapi`;
  }
  const urlDisplay = document.getElementById('k_vertex_computed_url');
  if (urlDisplay) {
    urlDisplay.textContent = baseUrl;
  }
  return { proj, loc, baseUrl };
}

// Preset Selection Handler
async function onProviderPresetChange(){
  const presetId = document.getElementById('p_preset').value;
  const nameInput = document.getElementById('p_name');
  const urlInput = document.getElementById('p_url');
  const descEl = document.getElementById('p_desc');

  if(!presetId){
    state.currentSelectedPreset = null;
    state.currentSelectedVaultProvider = null;
    nameInput.value = '';
    urlInput.value = '';
    nameInput.disabled = false;
    urlInput.disabled = false;
    descEl.style.display = 'block';
    descEl.style.background = 'var(--bg-subtle)';
    descEl.style.color = 'var(--text-secondary)';
    descEl.innerHTML = `${icon('zap')} <strong>自定义模式（本地内置）</strong>：无需拉取云端规则，可直接填写任意私有部署或第三方 OpenAI / Anthropic 兼容端点。`;
    document.getElementById('p_custom_url_toggle').checked = false;
    document.getElementById('p_custom_url_section').style.display = 'none';
    document.getElementById('p_anthropic_url').value = '';
    const pHint = document.getElementById('p_proto_hint');
    if (pHint) pHint.textContent = '';
    return;
  }

  // Handle EdgeOne Vault Hub On-Demand Import
  if(presetId.startsWith('vault:')){
    const realProvId = presetId.substring(6);
    const vaultProv = (typeof findVaultProvider === 'function') ? findVaultProvider(realProvId) : null;
    if(!vaultProv){
      toast(`未能获取中枢供应商「${realProvId}」信息`, 'err');
      return;
    }
    state.currentSelectedPreset = null;
    state.currentSelectedVaultProvider = vaultProv;

    nameInput.value = vaultProv.id || realProvId;
    nameInput.disabled = true;
    urlInput.value = vaultProv.base_url || '';
    urlInput.disabled = true; // 以中枢为准，拉取时不使用弹窗里的值

    // 协议以本地适配脚本为准（中枢 manifest 的 protocols 仅在无适配脚本时兜底）
    const matchedPreset = findPresetForProvider(vaultProv.id || vaultProv.name || realProvId);
    const presetProtos = getPresetProtocols(matchedPreset);
    const hubProtos = Array.from(normalizePresetProtocols(vaultProv.protocols || ['chat']));
    _applyProviderProtocols(presetProtos || hubProtos, matchedPreset);

    const anthropicUrl = (matchedPreset && matchedPreset.anthropic_base_url) || vaultProv.anthropic_base_url || '';
    if (anthropicUrl && (presetProtos || hubProtos).includes('messages')) {
      document.getElementById('p_custom_url_toggle').checked = true;
      document.getElementById('p_custom_url_section').style.display = 'block';
      document.getElementById('p_anthropic_url').value = anthropicUrl;
    } else {
      document.getElementById('p_custom_url_toggle').checked = false;
      document.getElementById('p_custom_url_section').style.display = 'none';
      document.getElementById('p_anthropic_url').value = '';
    }

    const rpmInput = document.getElementById('p_rpm');
    const provRpm = (matchedPreset && (matchedPreset.rpm_per_key || matchedPreset.rpm)) || vaultProv.rpm_per_key || vaultProv.rpm;
    if(rpmInput) rpmInput.value = provRpm ? String(provRpm) : '';

    const keyCount = Array.isArray(vaultProv.keys) ? vaultProv.keys.length : (vaultProv.keys ? Object.keys(vaultProv.keys).length : 0);
    const cleanName = (typeof cleanProviderLabel === 'function') ? cleanProviderLabel(vaultProv.name || vaultProv.id) : (vaultProv.name || vaultProv.id);
    _renderProviderSourceDesc(cleanName, keyCount, matchedPreset);
    descEl.title = '保存后一次性拉取该供应商规则与全部 Key；中枢 Key 只读可删，自建 Key 为本地。需要重新拉取时先删除该供应商。';
    return;
  }

  // 下拉只剩两种来源：自定义（本地）与从中枢按需拉取；官方预设不再作为选项，
  // 适配规则由用户在「供应商标识」中输入名称后自动匹配（见 applyPresetForProviderName）。
  state.currentSelectedVaultProvider = null;
  state.currentSelectedPreset = null;
  nameInput.disabled = false;
}

// Key & Provider Actions
function openProviderModal(sourceModal){
  state.providerModalSource = sourceModal || null;
  state.currentSelectedPreset = null;
  state.providerEditName = null;          // create mode (vault presets disable p_name but are NOT edit)
  state.currentSelectedVaultProvider = null;
  document.getElementById('providerModalTitle').textContent = '新增供应商';
  document.getElementById('p_preset_wrap').style.display = 'block';
  document.getElementById('p_preset').value = '';
  onProviderPresetChange();
  document.getElementById('p_name').value = '';
  document.getElementById('p_name').disabled = false;
  document.getElementById('p_url').value = '';
  document.getElementById('p_url').disabled = false;
  document.getElementById('p_url').title = '';
  document.getElementById('p_proto_chat').checked = true;
  document.getElementById('p_proto_messages').checked = false;
  document.getElementById('p_proto_responses').checked = false;
  const pHint = document.getElementById('p_proto_hint');
  if (pHint) pHint.textContent = '';
  document.getElementById('p_custom_url_toggle').checked = false;
  document.getElementById('p_custom_url_section').style.display = 'none';
  document.getElementById('p_anthropic_url').value = '';
  const rpmInput = document.getElementById('p_rpm');
  if(rpmInput) rpmInput.value = '';
  loadPresetsCatalog();
  openModal('providerModal');
}

function editProvider(name){
  state.currentSelectedPreset = null;
  state.providerEditName = name;          // edit mode
  state.currentSelectedVaultProvider = null;
  const isHostEdgeOne = Boolean(typeof HOST !== 'undefined' && HOST && HOST.isEdgeOne);
  const p = (state.config && state.config.providers && state.config.providers[name]) || (typeof findVaultProvider === 'function' ? findVaultProvider(name) : {}) || {};
  // VM：只有「从中枢拉取」的供应商 (origin=vault) 算中枢来源；本地同名自建不算
  const isVaultManaged = (p.origin === 'vault') || (isHostEdgeOne && p.origin !== 'local');
  const isVaultReadOnly = !isHostEdgeOne && isVaultManaged;

  document.getElementById('providerModalTitle').textContent = isVaultReadOnly
    ? `配置/查看供应商 - ${name} (中枢托管·只读)`
    : (isHostEdgeOne && isVaultManaged ? `编辑供应商 - ${name} (中枢统一)` : `编辑供应商 - ${name}`);
  document.getElementById('p_preset_wrap').style.display = 'none';
  document.getElementById('p_desc').style.display = 'none';
  document.getElementById('p_name').value = name;
  document.getElementById('p_name').disabled = true;
  document.getElementById('p_url').value = p.base_url || '';
  document.getElementById('p_url').disabled = Boolean(isVaultReadOnly);
  document.getElementById('p_url').title = isVaultReadOnly ? '中枢托管 Base URL 只读' : '';

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

  const rpmEditInput = document.getElementById('p_rpm');
  const provRpm = p.rpm_per_key || p.rpm;
  if(rpmEditInput) rpmEditInput.value = provRpm ? String(provRpm) : '';

  openModal('providerModal');
}

async function saveProvider(){
  const name = document.getElementById('p_name').value.trim();
  const url = document.getElementById('p_url').value.trim();
  if(!name || !url){ toast('供应商标识和 URL 不能为空', 'err'); return; }

  const isHostEdgeOne = Boolean(typeof HOST !== 'undefined' && HOST && HOST.isEdgeOne);
  // Never infer create/edit from `p_name.disabled`: the vault-preset branch disables the
  // name field too (it is read-only there), and doing so made "从中枢按需拉取" fall into the
  // edit branch, creating an empty local provider instead of calling /vault/fetch-key.
  const isEdit = Boolean(state.providerEditName);
  const existingProv = (state.config && state.config.providers && state.config.providers[name]) || (typeof findVaultProvider === 'function' ? findVaultProvider(name) : null);
  const isVaultManaged = existingProv && (existingProv.origin === 'vault' || (isHostEdgeOne && existingProv.origin !== 'local'));
  const isVaultReadOnly = !isHostEdgeOne && isVaultManaged;
  const isFromModelModal = (state.providerModalSource === 'agent' || state.providerModalSource === 'candidate');

  const selectedProtos = [];
  if(document.getElementById('p_proto_chat').checked) selectedProtos.push('chat');
  if(document.getElementById('p_proto_messages').checked) selectedProtos.push('messages');
  if(document.getElementById('p_proto_responses').checked) selectedProtos.push('responses');
  if(!selectedProtos.length){ toast('请至少选择一种支持的协议类型', 'err'); return; }

  const customUrlOpen = document.getElementById('p_custom_url_toggle').checked;
  const anthropicUrl = customUrlOpen ? document.getElementById('p_anthropic_url').value.trim() : '';

  const rpmInput = document.getElementById('p_rpm');
  let rpmVal = 0;
  if(rpmInput){
    const rpmRaw = rpmInput.value.trim();
    rpmVal = rpmRaw === '' ? 0 : Math.floor(Number(rpmRaw));
    if(!Number.isFinite(rpmVal) || rpmVal < 0){ toast('RPM 上限必须是不小于 0 的整数', 'err'); return; }
  }

  if(!isEdit && state.config.providers && state.config.providers[name]){ toast('供应商已存在', 'err'); return; }
  if(!state.config.providers) state.config.providers = {};

  const presetVal = document.getElementById('p_preset')?.value || '';
  const isVaultImport = Boolean(!isHostEdgeOne && !isEdit && (state.currentSelectedVaultProvider || presetVal.startsWith('vault:')));

  if (isVaultImport) {
    closeModal('providerModal');
    toast(`正在从 EdgeOne 凭据中枢按需拉取供应商「${name}」...`, 'info');
    try {
      const res = await fetch('/api/admin/vault/fetch-key', {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({ provider: name })
      });
      const d = await res.json().catch(() => ({}));
      if (res.ok && d && d.ok) {
        toast(`已成功从凭据中枢拉取供应商「${name}」及其密钥到本地！`, 'ok');
        await loadData();
        renderProviders();
        renderModels();
        return;
      }
      toast(`从中枢拉取失败: ${d?.error || '网络异常'}`, 'err');
    } catch(e) {
      toast(`从中枢拉取异常: ${e.message}`, 'err');
    }
    return;
  }

  if(isEdit) {
    if (!state.config.providers[name]) {
      const vp = typeof findVaultProvider === 'function' ? findVaultProvider(name) : null;
      state.config.providers[name] = {
        name: vp?.name || name,
        origin: isHostEdgeOne ? 'vault' : 'local',
        base_url: vp?.base_url || url,
        protocols: selectedProtos,
        keys: {}
      };
    } else {
      state.config.providers[name].base_url = url;
    }
    state.config.providers[name].protocols = selectedProtos;
    state.config.providers[name].anthropic_messages = selectedProtos.includes('messages');
    if(selectedProtos.includes('messages') && anthropicUrl){
      state.config.providers[name].anthropic_base_url = anthropicUrl;
    } else {
      delete state.config.providers[name].anthropic_base_url;
    }
    state.config.providers[name].rpm_per_key = (rpmVal > 0 ? rpmVal : 0);
  } else {
    // 新增供应商：
    // 若在“模型列表 / 候选弹窗”中快捷新增，无论 EdgeOne 还是 VM 均确立为本地自建 (origin: 'local')；
    // 若在 EdgeOne 的“模型提供商”菜单中新增，确立为中枢母本 (origin: 'vault')；
    // 若在 VM 的“模型提供商”菜单中新增，确立为本地自建 (origin: 'local')。
    const provOrigin = (!isFromModelModal && isHostEdgeOne) ? 'vault' : 'local';
    state.config.providers[name] = { 
      origin: provOrigin,
      base_url: url, 
      keys: (state.config.providers[name] && state.config.providers[name].keys) || {}, 
      protocols: selectedProtos,
      anthropic_messages: selectedProtos.includes('messages'),
      rpm_per_key: (rpmVal > 0 ? rpmVal : 0)
    };
    if(selectedProtos.includes('messages') && anthropicUrl){
      state.config.providers[name].anthropic_base_url = anthropicUrl;
    }
  }

  // Attach preset metadata and rules if created from preset or matches preset
  const matchedPreset = state.currentSelectedPreset || FALLBACK_PRESETS[name.toLowerCase()] || (state.presetCatalog && state.presetCatalog.find(x => x.id && x.id.toLowerCase() === name.toLowerCase()));
  if(matchedPreset && (matchedPreset.id === name.toLowerCase() || !state.config.providers[name].preset_id)){
    state.config.providers[name].preset_id = matchedPreset.id;
    state.config.providers[name].preset_version = matchedPreset.version || '1.1.0';
    if(matchedPreset.updated_at){
      state.config.providers[name].preset_updated_at = matchedPreset.updated_at;
    }
    if(matchedPreset.update_notes){
      state.config.providers[name].preset_update_notes = matchedPreset.update_notes;
    }
    if(matchedPreset.adapter_rules){
      state.config.providers[name].adapter_rules = matchedPreset.adapter_rules;
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
              <strong>发现 ${data.updates.length} 个本地已存供应商规则有新版本</strong>：
              ${data.updates.map(u => `<span class="badge badge-warning" style="margin-left:4px;">${esc(u.provider_id)}: ${esc(u.current_version)} &rarr; ${esc(u.remote_version)}${u.updated_at ? ` (${esc(u.updated_at)})` : ''}</span>`).join('')}
            </div>
            <button class="btn btn-primary btn-sm" onclick="applyAllProviderRuleUpdates()">一键更新本地已存供应商规则</button>
          `;
        }
        toast(`检查完成：发现 ${data.updates.length} 个本地已存供应商有新规则`, 'ok');
      } else {
        if (alertEl) alertEl.style.display = 'none';
        toast('所有本地已存供应商规则均为最新版本 (无需更新)', 'ok');
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
    toast(`正在按需拉取并更新本地已存供应商 [${providerIds.join(', ')}] 的规则...`, 'ok');
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
        toast(`成功按需更新 ${data.updated.length} 个本地供应商规则并已自动生效！`, 'ok');
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
let _isLocalKeyMode = false;

// ---- 从中枢添加 Key (VM 等「中枢客户端」部署；EdgeOne 本身是中枢，能力位为 false 不显示) ----
function canPullKeysFromVault(prov){
  const caps = (typeof HOST !== 'undefined' && HOST && HOST.capabilities) || {};
  const p = state.config?.providers?.[prov];
  return Boolean(caps.vaultClient && p && p.origin === 'vault');
}

function hideVaultKeyPicker(){
  const sec = document.getElementById('k_vault_section');
  if (sec) sec.style.display = 'none';
}

async function renderVaultKeyPicker(prov){
  const sec = document.getElementById('k_vault_section');
  const list = document.getElementById('k_vault_list');
  const btn = document.getElementById('k_vault_btn');
  if (!sec || !list) return;
  if (!canPullKeysFromVault(prov)) { sec.style.display = 'none'; return; }
  sec.style.display = 'block';
  if (btn) btn.disabled = true;
  list.innerHTML = '<span class="text-secondary">正在读取中枢清单…</span>';
  const manifest = (typeof fetchVaultManifest === 'function') ? await fetchVaultManifest(true) : null;
  if (document.getElementById('k_provider').value !== prov) return; // modal reopened for another provider
  const remote = manifest && manifest.providers && manifest.providers[prov];
  if (!remote) {
    list.innerHTML = `<span class="text-secondary">${esc(state.lastVaultError ? ('读取中枢清单失败：' + state.lastVaultError) : '中枢里已没有这个供应商')}</span>`;
    return;
  }
  const localKeys = (state.config.providers[prov] && state.config.providers[prov].keys) || {};
  const labels = (remote.keys || []).filter(l => !(l in localKeys));
  if (!labels.length) {
    list.innerHTML = '<span class="text-secondary">中枢的 Key 本地都已经有了</span>';
    return;
  }
  list.innerHTML = labels.map(l =>
    `<label style="display:flex;align-items:center;gap:6px;padding:2px 0;cursor:pointer;"><input type="checkbox" class="k-vault-pick" value="${esc(l)}"> <span class="mono">${esc(l)}</span></label>`
  ).join('');
  if (btn) btn.disabled = false;
}

async function addKeysFromVault(){
  const prov = document.getElementById('k_provider').value;
  const picked = Array.from(document.querySelectorAll('#k_vault_list .k-vault-pick:checked')).map(el => el.value);
  if (!picked.length) { toast('请先勾选要拉取的中枢 Key', 'err'); return; }
  const btn = document.getElementById('k_vault_btn');
  if (btn) { btn.disabled = true; btn.textContent = '拉取中…'; }
  try {
    const res = await fetch('/api/admin/vault/add-keys', {
      method: 'POST', headers: headers(), body: JSON.stringify({ provider: prov, keys: picked })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) { toast('从中枢添加 Key 失败: ' + (data.error || `HTTP ${res.status}`), 'err'); return; }
    const added = data.added || [];
    const missing = data.missing || [];
    let msg = `已从中枢添加 ${added.length} 个 Key`;
    if (missing.length) msg += `，${missing.length} 个中枢已不存在`;
    toast(msg, added.length ? 'ok' : 'err');
    await loadData();
    closeModal('keyModal');
    if (added.length && typeof _onKeySavedCallback === 'function') { const cb = _onKeySavedCallback; _onKeySavedCallback = null; try { cb(prov, added[0]); } catch (_) {} }
  } catch (e) {
    toast('从中枢添加 Key 异常: ' + e.message, 'err');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '拉取选中 Key'; }
  }
}

function isVertexProvider(prov){
  const p = state.config?.providers?.[prov];
  return prov === 'vertex' || p?.preset_id === 'vertex' || (p?.name && p.name.includes('Vertex')) || (p?.base_url && p.base_url.includes('aiplatform.googleapis.com'));
}

function openKeyModal(prov, onSavedCallback = null, isLocal = false){ 
  _onKeySavedCallback = onSavedCallback || null;
  _isLocalKeyMode = Boolean(isLocal);
  document.getElementById('keyModalTitle').textContent = isLocal
    ? `为 ${prov} 录入本地 Key (仅保存在本地)`
    : `为 ${prov} 新增 Key 凭证`; 
  document.getElementById('k_provider').value = prov; 
  document.getElementById('k_oldLabel').value = ''; 
  document.getElementById('k_label').value = ''; 
  document.getElementById('k_label').disabled = false; 
  document.getElementById('k_value').value = ''; 
  document.getElementById('k_skip').checked = false; 
  const diagBox = document.getElementById('k_diag_box');
  if(diagBox) { diagBox.style.display = 'none'; diagBox.innerHTML = ''; }

  const hintEl = document.getElementById('k_proto_hint');
  if(hintEl) {
    const protos = getProviderProtocols(prov);
    hintEl.innerHTML = `<div style="display:flex;align-items:center;justify-content:space-between;"><span>所属供应商: <b>${esc(prov)}</b></span><span>需校验协议: ${renderProtocolBadges(protos)}</span></div>`;
  }

  renderVaultKeyPicker(prov);

  const vSec = document.getElementById('k_vertex_section');
  if (isVertexProvider(prov) && vSec) {
    vSec.style.display = 'block';
    const pProj = document.getElementById('k_vertex_project'); if (pProj) pProj.value = '';
    const pLoc = document.getElementById('k_vertex_location'); if (pLoc) pLoc.value = 'global';
    onKeyVertexParamChange();
  } else if (vSec) {
    vSec.style.display = 'none';
  }

  openModal('keyModal'); 
}

function editKey(prov, label){ 
  const isHostEdgeOne = Boolean(typeof HOST !== 'undefined' && HOST && HOST.isEdgeOne);
  const keySrc = (typeof resolveKeySource === 'function') ? resolveKeySource(prov, label) : 'local';
  if (!isHostEdgeOne && keySrc === 'vault') {
    toast('中枢统一凭据不可在本地修改，请在 EdgeOne 中枢控制台进行维护', 'err');
    return;
  }
  const p = (state.config && state.config.providers && state.config.providers[prov]) || {}; 
  const currentKeyObj = p.keys && p.keys[label];
  let keyVal = '';
  let projVal = '';
  let locVal = 'global';
  let isLocal = (keySrc === 'local');

  if (typeof currentKeyObj === 'object' && currentKeyObj !== null) {
    keyVal = currentKeyObj.key || '';
    projVal = currentKeyObj.project_id || '';
    locVal = currentKeyObj.location || 'global';
    if (typeof currentKeyObj.is_local === 'boolean') isLocal = currentKeyObj.is_local;
  } else {
    keyVal = String(currentKeyObj || '');
  }

  hideVaultKeyPicker();
  _isLocalKeyMode = isLocal;
  document.getElementById('keyModalTitle').textContent = isLocal
    ? `编辑本地 Key 凭证 - ${prov} (${label})`
    : `编辑 Key 凭证 - ${prov} (${label})`; 
  document.getElementById('k_provider').value = prov; 
  document.getElementById('k_oldLabel').value = label; 
  document.getElementById('k_label').value = label; 
  document.getElementById('k_label').disabled = false; 
  document.getElementById('k_value').value = keyVal; 
  document.getElementById('k_skip').checked = true; 

  const diagBox = document.getElementById('k_diag_box');
  if(diagBox) { diagBox.style.display = 'none'; diagBox.innerHTML = ''; }
  const hintEl = document.getElementById('k_proto_hint');
  if(hintEl) {
    const protos = getProviderProtocols(prov);
    hintEl.innerHTML = `<div style="display:flex;align-items:center;justify-content:space-between;"><span>所属供应商: <b>${esc(prov)}</b></span><span>需校验协议: ${renderProtocolBadges(protos)}</span></div>`;
  }

  const vSec = document.getElementById('k_vertex_section');
  if (isVertexProvider(prov) && vSec) {
    vSec.style.display = 'block';
    const pProj = document.getElementById('k_vertex_project'); if (pProj) pProj.value = projVal;
    const pLoc = document.getElementById('k_vertex_location'); if (pLoc) pLoc.value = locVal;
    onKeyVertexParamChange();
  } else if (vSec) {
    vSec.style.display = 'none';
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
  const prov = document.getElementById('k_provider').value;
  const oldLabel = (document.getElementById('k_oldLabel').value||'').trim();
  const label = document.getElementById('k_label').value.trim();
  const val = document.getElementById('k_value').value.trim();
  const skip = document.getElementById('k_skip').checked;
  const diagBox = document.getElementById('k_diag_box');
  if(diagBox) { diagBox.style.display = 'none'; diagBox.innerHTML = ''; }

  if(!label||!val){ toast('Key 别名和密钥值不能为空','err'); return; }

  // If renaming an existing key and new label conflicts with another existing key
  if(label !== oldLabel && state.config.providers && state.config.providers[prov] && state.config.providers[prov].keys && state.config.providers[prov].keys[label] !== undefined){
    toast('Key 别名「'+label+'」已存在，请换一个别名','err'); 
    return; 
  }

  const isVertex = isVertexProvider(prov);
  let vertexKeyMeta = null;
  if (isVertex) {
    const vProj = (document.getElementById('k_vertex_project')?.value || '').trim();
    const vLoc = (document.getElementById('k_vertex_location')?.value || '').trim() || 'global';
    if (!vProj) {
      toast('请填写该 Key 归属的 GCP 项目 ID (Project ID)', 'err');
      return;
    }
    const locLower = vLoc.toLowerCase();
    const host = (locLower === 'global') ? 'aiplatform.googleapis.com' : `${locLower}-aiplatform.googleapis.com`;
    const computedBaseUrl = `https://${host}/v1beta1/projects/${vProj}/locations/${locLower}/endpoints/openapi`;
    vertexKeyMeta = {
      key: val,
      project_id: vProj,
      location: locLower,
      base_url: computedBaseUrl
    };
  }

  const isHostEdgeOne = Boolean(typeof HOST !== 'undefined' && HOST && HOST.isEdgeOne);
  let finalKeyVal;
  if (vertexKeyMeta) {
    finalKeyVal = { ...vertexKeyMeta };
  } else {
    finalKeyVal = { key: val };
  }

  const pObj = (state.config.providers && state.config.providers[prov]) || {};

  if (_isLocalKeyMode) {
    stampSecretOrigin(finalKeyVal, 'local');
    _isLocalKeyMode = false;
  } else {
    const keyOrigin = (pObj.origin === 'local' || !isHostEdgeOne) ? 'local' : 'vault';
    stampSecretOrigin(finalKeyVal, keyOrigin);
  }

  if(skip){ commitKey(prov, label, finalKeyVal); return; }

  const protos = getProviderProtocols(prov, pObj);
  const testBaseUrl = vertexKeyMeta ? vertexKeyMeta.base_url : pObj.base_url;

  document.getElementById('k_spinner').style.display='block';
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    const r = await fetch('/api/admin/verify-key', {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({
        base_url: testBaseUrl,
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
      commitKey(prov, label, finalKeyVal);
    } else {
      // Scheme A: strict block with detailed per-protocol diagnostics
      if(diagBox){
        let html = `<div style="font-weight:700;margin-bottom:8px;color:var(--danger);display:flex;align-items:center;gap:6px;">${icon('alert', 16)} 协议连通性未完全通过 (已阻止保存)</div>`;
        html += '<div style="display:flex;flex-direction:column;gap:6px;font-size:12px;">';
        // Request-level rejection (bad URL, SSRF guard, missing params) carries d.error
        // and no per-protocol results; show it instead of a misleading "未测试".
        const topErr = d.error || (Array.isArray(d.errors) ? d.errors.join('; ') : '');
        if (topErr && !d.protocols) {
          html += `<div style="display:flex;align-items:flex-start;gap:6px;color:var(--danger);">${icon('xCircle', 14)} <div>${esc(topErr)} (HTTP ${r.status})</div></div>`;
        }
        for(const pr of protos){
          if (topErr && !d.protocols) break;
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

function commitKey(prov, label, val){ 
  const oldLabel = (document.getElementById('k_oldLabel').value||'').trim();
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


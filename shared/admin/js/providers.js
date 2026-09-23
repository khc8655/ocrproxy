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


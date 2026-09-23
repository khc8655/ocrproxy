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


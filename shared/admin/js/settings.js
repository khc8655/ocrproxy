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
  set('s_chatTimeout', c.upstream_timeout_sec ?? c.upstream_timeout_chat ?? 30);
  const derivedBudget = c.request_total_budget_sec ?? c.schedule_total_budget ?? ((c.upstream_timeout_sec ?? 30) * (c.max_retries ?? 3));
  set('s_budget', derivedBudget);
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
  set('cfg_vault_url', vCfg.edgeone_url || vCfg.url || '');
  set('cfg_vault_token', vCfg.token || '');

  // EdgeOne Environment Adaptations: hide remote vault config and host restart
  if (typeof IS_EDGEONE !== 'undefined' && IS_EDGEONE) {
    const vaultCard = document.getElementById('cfg_vault_url')?.closest('.card');
    if (vaultCard) vaultCard.style.display = 'none';
    const restartCard = document.getElementById('s_autoRestart')?.closest('.card');
    if (restartCard) restartCard.style.display = 'none';
    if (modeEl) {
      Array.from(modeEl.options).forEach(opt => {
        if (opt.value !== 'agent') opt.style.display = 'none';
      });
      modeEl.value = 'agent';
    }
  }

  onRunModeChange();
  updateRoutingSettingsState();
  initSettingsKeyListeners();
}

let _settingsListenersBound = false;
function initSettingsKeyListeners(){
  if (_settingsListenersBound) return;
  _settingsListenersBound = true;
  const panel = document.getElementById('panel-settings');
  if (!panel) return;
  panel.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 's') {
      e.preventDefault();
      saveSettings();
    } else if (e.key === 'Enter' && e.target.tagName === 'INPUT' && e.target.type !== 'checkbox') {
      e.preventDefault();
      saveSettings();
    }
  });
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

  // Dynamic labels based on run mode
  const lblChatTimeout = document.getElementById('lbl_chatTimeout');
  const hintChatTimeout = document.getElementById('hint_chatTimeout');
  if (lblChatTimeout) {
    lblChatTimeout.textContent = isKb ? 'KB 对话单次处理超时 (upstream_timeout_sec)' : '智能体单次请求超时 (upstream_timeout_sec)';
  }
  if (hintChatTimeout) {
    hintChatTimeout.textContent = isKb
      ? 'KB 模式下调用 chat 虚拟模型的超时时限（秒）。总预算将根据候选池自动缩放。'
      : '向上游发起调用的等待上限（秒）。发生假死或超时立即切换备用 Key；总调度死线由系统自动推导。';
  }
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
    's_chatTimeout', 's_maxRetries', 's_maxAttemptsPerProvider',
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

  const chatTimeoutEl = document.getElementById('s_chatTimeout');
  const hintChatTimeout = document.getElementById('hint_chatTimeout');
  if (chatTimeoutEl && isManual) {
    chatTimeoutEl.placeholder = '纯直通已放宽至 300s';
    if (hintChatTimeout) {
      hintChatTimeout.textContent = '⚡ 纯手动直通模式：超时自动放宽至 300s，不打断 o1/o3/DeepSeek-R1 深度长思考，由客户端自身决定断开时机。';
    }
  }
}

function restoreDefaultSettings(){
  if(!confirm('确定要恢复推荐默认参数吗？（不会影响已配置的模型和 Key）')) return;
  const set=(id,v)=>{ const el=document.getElementById(id); if(el) el.value=v; };
  set('s_chatTimeout', 30);
  set('s_budget', 90);
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

async function checkSystemUpdate(manual=true){
  const btn = document.getElementById('btnCheckAppUpdate');
  const infoBox = document.getElementById('appUpdateInfoBox');
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = icon('refresh') + ' 正在检测更新...';
  }
  try {
    const r = await fetch('/api/admin/system/check-update', { headers: headers() });
    if (!r.ok) throw new Error('检测程序更新接口响应异常 (' + r.status + ')');
    const data = await r.json();
    
    // Update badge if available
    const badge = document.getElementById('topVersionBadge');
    if (badge && data.current_version) {
      badge.textContent = data.current_version;
    }

    if (!infoBox) return;

    if (data.has_update) {
      infoBox.style.display = 'block';
      infoBox.innerHTML = `
        <div style="background:var(--bg-subtle);border:1px solid var(--warning);border-radius:var(--radius-md);padding:14px;margin-top:10px;">
          <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;">
            <div>
              <span class="badge badge-warning" style="font-weight:700;">🚀 发现新程序版本: ${esc(data.latest_version)}</span>
              <span style="font-size:12px;color:var(--text-secondary);margin-left:8px;">当前运行版本: ${esc(data.current_version)} (发布日期: ${esc(data.release_date)})</span>
            </div>
            <button class="btn btn-primary btn-sm" onclick="upgradeSystem('${esc(data.latest_version)}', '${esc(data.current_version)}')" style="font-weight:600;">一键在线平滑升级</button>
          </div>
          ${data.title ? `<div style="font-weight:600;margin-top:8px;font-size:13px;color:var(--text);">${esc(data.title)}</div>` : ''}
          ${Array.isArray(data.changelog) && data.changelog.length ? `
            <ul style="margin:6px 0 0 18px;font-size:12px;color:var(--text-secondary);line-height:1.6;">
              ${data.changelog.map(item => `<li>${esc(item)}</li>`).join('')}
            </ul>
          ` : ''}
          <div style="margin-top:8px;font-size:11px;color:var(--text-secondary);">
            💡 升级过程为在线热更新并平滑重启守护进程，所有 Key、模型与环境配置 100% 保持无损。
          </div>
        </div>
      `;
      if (manual) toast(`检测到新程序版本: ${data.latest_version}，可立即一键升级`, 'ok');
    } else {
      infoBox.style.display = 'block';
      infoBox.innerHTML = `
        <div style="background:var(--bg-subtle);border:1px solid var(--border);border-radius:var(--radius-md);padding:10px 14px;margin-top:10px;font-size:12px;display:flex;align-items:center;justify-content:space-between;">
          <div style="color:var(--text-secondary);">
            ✅ 当前已是最新程序版本: <strong style="color:var(--primary);">${esc(data.current_version)}</strong> ${data.release_date ? `(${esc(data.release_date)})` : ''}
          </div>
          <span style="font-size:11px;color:var(--text-secondary);">检测时间: ${esc(data.checked_at || '')}</span>
        </div>
      `;
      if (manual) toast('当前 OCRProxy 程序已是最新版本，无需升级', 'ok');
    }
  } catch(e) {
    if (manual) toast('检测程序更新失败: ' + e.message, 'err');
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = icon('search') + ' 检查程序更新';
    }
  }
}

async function upgradeSystem(targetVer, currVer){
  if (!confirm('确定要一键在线平滑升级 OCRProxy 系统程序吗？\n\n• 系统将拉取 GitHub 最新版本制品就地更新\n• 所有已配置的 Key、模型和环境变量 100% 保留无损\n• 服务将在后台自动完成重载生效')) return;
  
  const oldVer = currVer || document.getElementById('topVersionBadge')?.textContent?.trim() || '';

  const infoBox = document.getElementById('appUpdateInfoBox');
  if (infoBox) {
    infoBox.innerHTML = `
      <div style="background:var(--bg-subtle);border:1px solid var(--primary);border-radius:var(--radius-md);padding:14px;margin-top:10px;text-align:center;">
        <div style="font-weight:600;color:var(--primary);font-size:14px;display:flex;align-items:center;justify-content:center;gap:8px;">
          <span class="spinner"></span> 正在下载最新制品并就地平滑升级...
        </div>
        <div id="upgradeStatusText" style="font-size:12px;color:var(--text-secondary);margin-top:6px;">正在拉取更新制品并派发独立守护单元，请稍候...</div>
      </div>
    `;
  }

  try {
    const r = await fetch('/api/admin/system/upgrade', { method: 'POST', headers: headers() });
    if (!r.ok) {
      const err = await r.json().catch(() => ({}));
      throw new Error(err.error || ('发起升级请求失败 HTTP ' + r.status));
    }
    const res = await r.json();
    toast(res.message || '程序升级已在后台执行，正在平滑更新...', 'ok');

    const statusTextEl = document.getElementById('upgradeStatusText');
    if (statusTextEl) statusTextEl.textContent = '升级任务已启动，正在持续校验新版本就绪状态...';

    // 等待 2.5 秒让后台 systemd-run 单元拉起下载与部署
    await new Promise(resolve => setTimeout(resolve, 2500));

    let attempts = 0;
    const maxAttempts = 35; // 最多探测 50 秒 (每 1.5 秒一次)
    const checkTimer = setInterval(async () => {
      attempts++;
      try {
        const verRes = await fetch('/api/admin/system/version', { headers: headers(), cache: 'no-store' }).then(res => res.json()).catch(() => null);
        const runningVer = verRes?.current_version || '';

        // 核心判定规则：只有检测到运行态版本确实发生跳变（与旧版本不同，或匹配目标版本），才断定升级成功！
        if (runningVer && (runningVer !== oldVer || (targetVer && runningVer === targetVer))) {
          clearInterval(checkTimer);
          const badge = document.getElementById('topVersionBadge');
          if (badge) badge.textContent = runningVer;

          if (infoBox) {
            infoBox.innerHTML = `
              <div style="background:var(--bg-subtle);border:1px solid var(--success);border-radius:var(--radius-md);padding:12px 14px;margin-top:10px;text-align:center;">
                <div style="font-weight:600;color:var(--success);font-size:14px;">🎉 系统在线平滑升级成功！</div>
                <div style="font-size:12px;color:var(--text-secondary);margin-top:4px;">当前运行版本已刷新为: <strong style="color:var(--primary);">${esc(runningVer)}</strong></div>
              </div>
            `;
          }
          toast('🎉 系统已成功平滑升级至 ' + runningVer + '！', 'ok');
          setTimeout(() => location.reload(), 1500);
          return;
        }
      } catch (_) {
        // 重启切换瞬间，网络暂时不可达属于正常现象
      }

      if (statusTextEl) {
        statusTextEl.textContent = `服务正在应用更新与平滑重载 (${attempts}/${maxAttempts})，请稍候...`;
      }

      if (attempts >= maxAttempts) {
        clearInterval(checkTimer);
        if (infoBox) {
          infoBox.innerHTML = `
            <div style="background:var(--bg-subtle);border:1px solid var(--warning);border-radius:var(--radius-md);padding:12px 14px;margin-top:10px;text-align:center;">
              <div style="font-weight:600;color:var(--warning);font-size:14px;">⚠️ 升级探测超时，当前版本未变</div>
              <div style="font-size:12px;color:var(--text-secondary);margin-top:4px;">版本仍为 ${esc(oldVer)}。可能权限受限或下载超时，建议在服务器执行 <code>ocrproxy upgrade</code> 或检查 journalctl 日志。</div>
            </div>
          `;
        }
        toast('升级超时，当前版本未发生变更', 'err');
      }
    }, 1500);

  } catch(e) {
    toast('发起在线升级失败: ' + e.message, 'err');
    if (infoBox) {
      infoBox.innerHTML = `
        <div style="background:var(--bg-subtle);border:1px solid var(--danger);border-radius:var(--radius-md);padding:12px 14px;margin-top:10px;text-align:center;">
          <div style="font-weight:600;color:var(--danger);font-size:14px;">❌ 发起升级失败</div>
          <div style="font-size:12px;color:var(--text-secondary);margin-top:4px;">${esc(e.message)}</div>
          <button class="btn btn-secondary btn-sm" onclick="checkSystemUpdate(true)" style="margin-top:8px;">重新检查</button>
        </div>
      `;
    }
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
  c.upstream_timeout_sec = Number(document.getElementById('s_chatTimeout').value) || 30;
  c.upstream_timeout_chat = c.upstream_timeout_sec; // backward compatibility
  c.max_retries = Number(document.getElementById('s_maxRetries').value) || 3;
  // 动态预算自适应：支持深度长思考（如 120s × 3 = 360s），按实际超时与重试次数计算，放宽硬编码上限至 600s
  c.request_total_budget_sec = Math.min(600, Math.max(60, c.upstream_timeout_sec * c.max_retries));
  c.schedule_total_budget = c.request_total_budget_sec; // backward compatibility
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
    const vUrl = (vaultUrlEl ? vaultUrlEl.value.trim() : '');
    const vToken = (vaultTokenEl ? vaultTokenEl.value.trim() : '');
    c.edgeone_vault = {
      url: vUrl,
      edgeone_url: vUrl,
      token: vToken
    };
  }

  await persistConfig(silent ? null : '系统参数已保存并立即生效');
}


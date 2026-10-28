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
  const msEn = document.getElementById('s_modeScheduleEnabled');
  if (msEn) msEn.checked = !!c.mode_schedule_enabled;
  set('s_modeScheduleKbStart', c.mode_schedule_kb_start || '22:00');
  set('s_modeScheduleKbEnd', c.mode_schedule_kb_end || '08:00');

  // Card 2: Routing Strategies
  set('s_agentRouting', c.agent_routing_strategy === 'manual' ? 'manual' : 'sticky_failover');
  set('s_kbRouting', c.kb_routing_strategy === 'manual' ? 'manual' : 'round_robin');

  // Card 3: Timeouts & Concurrency（chat 超时框按模式显示 agent 首字节 / KB chat）
  const isKbInitial = (c.run_mode || c._run_mode) === 'kb';
  set('s_chatTimeout', isKbInitial ? (c.kb_chat_timeout_sec ?? 60) : (c.agent_first_byte_timeout_sec ?? 90));
  set('s_embedTimeout', c.upstream_timeout_sec ?? 20);
  set('s_kbTimeout', c.upstream_timeout_kb ?? c.upstream_timeout_ocr ?? 60);
  set('s_concurrency', c.kb_max_concurrency_per_key ?? 4);
  set('s_ocrMaxInflight', c.ocr_max_inflight ?? 12);
  set('s_ocrQueueTimeout', c.ocr_queue_timeout_sec ?? 30);

  // Card 4: Cooldowns（冷宫以小时显示，存秒）
  const quotaSec = Number(c.cooldown_quota_sec ?? (c.settings && c.settings.cooldown_quota_sec) ?? 86400) || 86400;
  set('s_cooldownQuotaHours', Math.max(1, Math.round(quotaSec / 3600)));
  set('s_cooldown429', c.cooldown_429_sec ?? 60);
  set('s_cooldown5xx', c.cooldown_5xx_sec ?? 30);
  set('s_circuitThreshold', c.circuit_break_threshold ?? 3);
  set('s_circuitCooldown', c.circuit_cooldown_sec ?? 600);

  // Card 6: EdgeOne Vault Hub
  const vCfg = c.edgeone_vault || {};
  set('cfg_vault_url', vCfg.edgeone_url || vCfg.url || '');
  const vaultTokenInput = document.getElementById('cfg_vault_token');
  const vaultBadge = document.getElementById('vaultTokenStatusBadge');
  if (vaultTokenInput) {
    vaultTokenInput.value = '';
    const hasToken = Boolean(vCfg.has_token || (vCfg.token && !isMaskedSecret(vCfg.token)));
    if (hasToken) {
      vaultTokenInput.placeholder = '•••••••• (已保存，若不修改请留空)';
      if (vaultBadge) vaultBadge.style.display = 'inline-block';
    } else {
      vaultTokenInput.placeholder = '输入中枢 PROXY_API_KEY / 访问 Token';
      if (vaultBadge) vaultBadge.style.display = 'none';
    }
  }

  // EdgeOne Environment Adaptations: hide remote vault config
  if (typeof IS_EDGEONE !== 'undefined' && IS_EDGEONE) {
    const vaultCard = document.getElementById('cfg_vault_url')?.closest('.card');
    if (vaultCard) vaultCard.hidden = true;
    if (modeEl) {
      Array.from(modeEl.options).forEach(opt => {
        if (opt.value !== 'agent') opt.hidden = true;
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
      // 中枢 URL/Token 走独立保存接口，避免把 Token 混进整包保存触发版本冲突
      if (e.target.id === 'cfg_vault_url' || e.target.id === 'cfg_vault_token') {
        saveVaultConfig();
      } else {
        saveSettings();
      }
    }
  });
}

function onRunModeChange(){
  const modeEl = document.getElementById('s_runMode');
  if(!modeEl) return;
  const isKb = modeEl.value === 'kb';
  const kbItem = document.getElementById('st-item-kb-routing');
  const agItem = document.getElementById('st-item-agent-routing');
  if(kbItem) kbItem.hidden = !isKb;
  if(agItem) agItem.hidden = isKb;

  const lbl = document.getElementById('lbl_chatTimeout');
  const input = document.getElementById('s_chatTimeout');
  if (lbl) {
    lbl.textContent = isKb ? 'KB Chat 单次超时 (kb_chat_timeout_sec)' : '单 Key 首字节超时 (agent_first_byte_timeout_sec)';
    lbl.title = lbl.textContent;
  }
  if (input && state.config) {
    input.value = isKb ? (state.config.kb_chat_timeout_sec ?? 60) : (state.config.agent_first_byte_timeout_sec ?? 90);
  }
  updateRoutingSettingsState();
}

function onAgentRoutingChange(){
  updateRoutingSettingsState();
}

function onKbRoutingChange(){
  updateRoutingSettingsState();
}

// 各模式开放的参数（与 shared/config/settings.schema.json 的 modes/strategies 一致）：
//   Agent 手动直通：无参数（固定 300s）
//   Agent 稳定模式：首字节超时 + 冷宫时长
//   KB：Chat / Embedding·Rerank / OCR 超时、单 Key 并发、OCR 队列、429/5xx/熔断、冷宫时长
const KB_ONLY_ROWS = ['st-item-kb-embed-timeout', 'st-item-kb-timeout', 'st-item-kb-concurrency',
  'st-item-ocr-inflight', 'st-item-ocr-queue', 'st-item-cooldown-429', 'st-item-cooldown-5xx',
  'st-item-circuit-threshold', 'st-item-circuit-cooldown'];

function updateRoutingSettingsState(){
  const modeEl = document.getElementById('s_runMode');
  const isKb = !!(modeEl && modeEl.value === 'kb');
  const agRouteEl = document.getElementById('s_agentRouting');
  const kbRouteEl = document.getElementById('s_kbRouting');
  const isManual = isKb ? !!(kbRouteEl && kbRouteEl.value === 'manual') : !!(agRouteEl && agRouteEl.value === 'manual');
  const show = (id, on) => { const el = document.getElementById(id); if (el) el.hidden = !on; };

  show('manual-routing-tip', isManual);
  show('agent-routing-hint', !isManual && !isKb);

  KB_ONLY_ROWS.forEach(id => show(id, isKb));
  // 超时卡：Agent 手动直通没有任何可调参数，只显示提示
  const agentManual = !isKb && isManual;
  show('st-item-chat-timeout', !agentManual);
  show('manual-timeout-tip', agentManual);
  // 冷却卡：手动直通不冷却
  show('st-grid-cooldowns', !isManual);
  show('manual-cooldown-tip', isManual);

  const hint = document.getElementById('hint_chatTimeout');
  if (hint) {
    hint.textContent = isKb
      ? (isManual ? '纯手动直通调试：锁定第一个候选，不重试不切换' : '每个 Key 单次等待上限，超时换下一个 Key（默认 60s）')
      : '单个 Key 等首字节的上限，超时换下一个 Key；整单 300s 封顶（默认 90s）';
    hint.title = hint.textContent;
  }
}

async function restoreDefaultSettings(){
  if(!(await UI.confirm({title:'恢复默认参数', desc:'确定要恢复推荐默认参数吗？（不会影响已配置的模型和 Key）', confirmText:'恢复'}))) return;
  const set=(id,v)=>{ const el=document.getElementById(id); if(el) el.value=v; };
  const isKb = document.getElementById('s_runMode')?.value === 'kb';
  set('s_chatTimeout', isKb ? 60 : 90);
  set('s_embedTimeout', 20);
  set('s_kbTimeout', 60);
  set('s_concurrency', 4);
  set('s_ocrMaxInflight', 12);
  set('s_ocrQueueTimeout', 30);
  set('s_cooldownQuotaHours', 24);
  set('s_cooldown429', 60);
  set('s_cooldown5xx', 30);
  set('s_circuitThreshold', 3);
  set('s_circuitCooldown', 600);
  toast('已填入推荐默认参数，请点击「保存设置」生效', 'ok');
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
  if (!(await UI.confirm({title:'平滑重启服务', desc:'确定要平滑重启 OCRProxy 服务守护进程吗？（重启耗时约 2-3 秒）', danger:true, confirmText:'重启'}))) return;
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

    if (data.network_error || data.ok === false) {
      infoBox.style.display = 'block';
      infoBox.innerHTML = `
        <div style="background:var(--bg-subtle);border:1px solid var(--warning);border-radius:var(--radius-md);padding:10px 14px;margin-top:10px;font-size:12px;display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px;">
          <div style="color:var(--warning);font-weight:600;display:inline-flex;align-items:center;gap:6px;">
            <svg class="khc-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
            未能连接到版本更新服务器 (网络超时)
            <span style="font-weight:normal;color:var(--text-secondary);margin-left:6px;">当前运行版本: ${esc(data.current_version || '')}</span>
          </div>
          <span style="font-size:11px;color:var(--text-secondary);">检测时间: ${esc(data.checked_at || '')}</span>
        </div>
      `;
      if (manual) toast(data.notice || '无法连接到更新服务器，请检查外网网络', 'err');
      return;
    }

    if (data.has_update) {
      infoBox.style.display = 'block';
      infoBox.innerHTML = `
        <div style="background:var(--bg-subtle);border:1px solid var(--warning);border-radius:var(--radius-md);padding:14px;margin-top:10px;">
          <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;">
            <div>
              <span class="badge badge-warning" style="font-weight:700;">发现新程序版本: ${esc(data.latest_version)}</span>
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
            升级过程为在线热更新并平滑重启守护进程，所有 Key、模型与环境配置 100% 保持无损。
          </div>
        </div>
      `;
      if (manual) toast(`检测到新程序版本: ${data.latest_version}，可立即一键升级`, 'ok');
    } else {
      infoBox.style.display = 'block';
      infoBox.innerHTML = `
        <div style="background:var(--bg-subtle);border:1px solid var(--border);border-radius:var(--radius-md);padding:10px 14px;margin-top:10px;font-size:12px;display:flex;align-items:center;justify-content:space-between;">
          <div style="color:var(--text-secondary);display:inline-flex;align-items:center;gap:6px;">
            <svg class="khc-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--primary)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
            当前已是最新程序版本: <strong style="color:var(--primary);">${esc(data.current_version)}</strong> ${data.release_date ? `(${esc(data.release_date)})` : ''}
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
  if (!(await UI.confirm({title:'在线平滑升级', desc:'确定要一键在线平滑升级 OCRProxy 系统程序吗？\n\n• 系统将拉取 GitHub 最新版本制品就地更新\n• 所有已配置的 Key、模型和环境变量 100% 保留无损\n• 服务将在后台自动完成重载生效', confirmText:'升级'}))) return;
  
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
                <div style="font-weight:600;color:var(--success);font-size:14px;display:inline-flex;align-items:center;gap:6px;">
                  <svg class="khc-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
                  系统在线平滑升级成功！
                </div>
                <div style="font-size:12px;color:var(--text-secondary);margin-top:4px;">当前运行版本已刷新为: <strong style="color:var(--primary);">${esc(runningVer)}</strong></div>
              </div>
            `;
          }
          toast('系统已成功平滑升级至 ' + runningVer + '！', 'ok');
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
              <div style="font-weight:600;color:var(--warning);font-size:14px;">升级探测超时，当前版本未变</div>
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
          <div style="font-weight:600;color:var(--danger);font-size:14px;">发起升级失败</div>
          <div style="font-size:12px;color:var(--text-secondary);margin-top:4px;">${esc(e.message)}</div>
          <button class="btn btn-secondary btn-sm" onclick="checkSystemUpdate(true)" style="margin-top:8px;">重新检查</button>
        </div>
      `;
    }
  }
}

async function updateConfiguredPresetsFromSettings() {
  const btn = document.getElementById('btnUpdateConfiguredPresets');
  const infoBox = document.getElementById('presetsUpdateInfoBox');
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span> 正在增量更新已添加预设...';
  }
  try {
    const provs = state.config && state.config.providers ? Object.keys(state.config.providers) : [];
    if (!provs.length) {
      toast('当前本地尚未配置任何供应商，无需更新预设', 'info');
      if (infoBox) {
        infoBox.style.display = 'block';
        infoBox.innerHTML = '<div style="background:var(--bg-subtle);border:1px solid var(--border);border-radius:var(--radius-md);padding:10px 14px;font-size:12px;color:var(--text-secondary);">当前未配置任何供应商，无需更新预设。</div>';
      }
      return;
    }
    const r = await fetch('/api/admin/presets/update-rules', {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({ provider_ids: provs })
    });
    if (!r.ok) throw new Error('接口响应异常 (' + r.status + ')');
    const data = await r.json();
    if (!data.ok) throw new Error(data.error || '更新失败');

    const updated = data.updated || [];
    const failed = data.failed || [];
    if (infoBox) {
      infoBox.style.display = 'block';
      const updatedTags = updated.map(u => `<span class="badge badge-success" style="font-size:11px;margin-right:4px;">${esc(u.provider_id)} (规则 ${esc(u.new_version || '最新')})</span>`).join(' ');
      const failedTags = failed.length ? `<div style="color:var(--error);font-size:11px;margin-top:6px;">失败: ${failed.map(f => esc(f.provider_id)).join(', ')}</div>` : '';
      infoBox.innerHTML = `
        <div style="background:var(--bg-subtle);border:1px solid var(--border);border-radius:var(--radius-md);padding:10px 14px;font-size:12px;">
          <div style="color:var(--text);font-weight:600;margin-bottom:6px;display:inline-flex;align-items:center;gap:6px;">
            <svg class="khc-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--primary)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
            已增量更新 ${updated.length} 家供应商规则：
          </div>
          <div style="display:flex;flex-wrap:wrap;gap:4px;">${updatedTags || '<span class="text-secondary">无变动</span>'}</div>
          ${failedTags}
        </div>
      `;
    }
    toast(`成功更新 ${updated.length} 家已配置供应商的适配预设！`, 'ok');
    if (typeof loadConfig === 'function') await loadConfig();
    if (typeof renderProviders === 'function') renderProviders();
  } catch(e) {
    toast('增量更新预设失败: ' + e.message, 'err');
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = `<svg class="khc-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67"/></svg> 一键增量更新已添加预设`;
    }
  }
}
window.updateConfiguredPresetsFromSettings = updateConfiguredPresetsFromSettings;

async function saveSettings(silent=false){
  const c=state.config||{};

  // Card 1: Client Auth & Run Mode
  const keyEl = document.getElementById('s_proxyApiKey');
  if (keyEl) c.proxy_api_key = keyEl.value.trim();
  const modeEl = document.getElementById('s_runMode');
  if (modeEl) c.run_mode = modeEl.value;
  const msEnEl = document.getElementById('s_modeScheduleEnabled');
  if (msEnEl && !(typeof HOST !== 'undefined' && HOST.isEdgeOne)) {
    const hhmm = (id, dflt) => {
      const v = (document.getElementById(id)?.value || '').trim();
      return /^([01]\d|2[0-3]):[0-5]\d$/.test(v) ? v : dflt;
    };
    c.mode_schedule_enabled = !!msEnEl.checked;
    c.mode_schedule_kb_start = hhmm('s_modeScheduleKbStart', '22:00');
    c.mode_schedule_kb_end = hhmm('s_modeScheduleKbEnd', '08:00');
  }

  // Card 2: Key Routing Strategies
  const agRouteEl = document.getElementById('s_agentRouting');
  if (agRouteEl) c.agent_routing_strategy = agRouteEl.value === 'manual' ? 'manual' : 'sticky_failover';
  const kbRouteEl = document.getElementById('s_kbRouting');
  if (kbRouteEl) c.kb_routing_strategy = kbRouteEl.value === 'manual' ? 'manual' : 'round_robin';

  // Card 3: Timeouts & Concurrency
  const num = (id, dflt, lo, hi) => {
    const el = document.getElementById(id);
    if (!el || el.value.trim() === '') return dflt;
    const v = Number(el.value);
    return Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : dflt;
  };
  const isKbMode = c.run_mode === 'kb';
  if (isKbMode) c.kb_chat_timeout_sec = num('s_chatTimeout', 60, 10, 300);
  else c.agent_first_byte_timeout_sec = num('s_chatTimeout', 90, 5, 600);
  if (document.getElementById('s_embedTimeout')) c.upstream_timeout_sec = num('s_embedTimeout', 20, 5, 300);
  c.upstream_timeout_kb = num('s_kbTimeout', 60, 10, 300);
  c.upstream_timeout_ocr = c.upstream_timeout_kb;
  if (document.getElementById('s_concurrency')) c.kb_max_concurrency_per_key = num('s_concurrency', 4, 1, 100);
  if (document.getElementById('s_ocrMaxInflight')) c.ocr_max_inflight = num('s_ocrMaxInflight', 12, 1, 30);
  if (document.getElementById('s_ocrQueueTimeout')) c.ocr_queue_timeout_sec = num('s_ocrQueueTimeout', 30, 0, 300);

  // Card 4: Cooldowns
  c.cooldown_quota_sec = Math.round(num('s_cooldownQuotaHours', 24, 1, 168) * 3600);
  if (document.getElementById('s_cooldown429')) c.cooldown_429_sec = num('s_cooldown429', 60, 5, 600);
  if (document.getElementById('s_cooldown5xx')) c.cooldown_5xx_sec = num('s_cooldown5xx', 30, 5, 300);
  if (document.getElementById('s_circuitThreshold')) c.circuit_break_threshold = num('s_circuitThreshold', 3, 1, 10);
  if (document.getElementById('s_circuitCooldown')) c.circuit_cooldown_sec = num('s_circuitCooldown', 600, 5, 7200);

  // 已删除 / 并入其他参数的旧字段（与后端 _migrate_params_v2 一致）
  ['schedule_total_budget', 'request_total_budget_sec', 'max_retries', 'max_attempts_per_provider',
   'cooldown_403_sec', 'circuit_escalation_sec', 'fast_failover_provider_down', 'upstream_timeout_chat',
   'chat_fast_timeout', 'upstream_timeout_embedding', 'upstream_timeout_rerank', 'cooldown_tpm_sec',
   'cooldown_duration', 'latency_based_routing'].forEach(k => {
    delete c[k];
    if (c.settings) delete c.settings[k];
  });
  if (c.settings) {
    ['agent_first_byte_timeout_sec', 'kb_chat_timeout_sec', 'upstream_timeout_sec', 'upstream_timeout_kb',
     'kb_max_concurrency_per_key', 'cooldown_quota_sec', 'cooldown_429_sec', 'cooldown_5xx_sec',
     'circuit_break_threshold', 'circuit_cooldown_sec'].forEach(k => { if (c[k] !== undefined) c.settings[k] = c[k]; });
  }
  c._params_rev = 2;

  // Integrate Schema-driven form values if present
  if (typeof SettingsForm !== 'undefined' && typeof SettingsForm.collect === 'function') {
    const schemaSettings = SettingsForm.collect();
    Object.assign(c, schemaSettings);
    c.settings = Object.assign(c.settings || {}, schemaSettings);
  }

  // Card 6: EdgeOne Vault Hub
  const vaultUrlEl = document.getElementById('cfg_vault_url');
  const vaultTokenEl = document.getElementById('cfg_vault_token');
  if (vaultUrlEl || vaultTokenEl) {
    const vUrl = (vaultUrlEl ? vaultUrlEl.value.trim() : '');
    const vToken = (vaultTokenEl ? vaultTokenEl.value.trim() : '');
    c.edgeone_vault = c.edgeone_vault || {};
    c.edgeone_vault.url = vUrl;
    c.edgeone_vault.edgeone_url = vUrl;
    // 只有在用户主动输入了新 Token 时才发送；留空或掩码字符不覆写现有凭证
    if (vToken && !isMaskedSecret(vToken)) {
      c.edgeone_vault.token = vToken;
      c.edgeone_vault.has_token = true;
    }
  }

  await persistConfig(silent ? null : '系统参数已保存并立即生效');
}



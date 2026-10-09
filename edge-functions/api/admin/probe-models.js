/**
 * api/admin/probe-models.js — Dynamically query upstream /v1/models endpoint.
 *
 *   POST /api/admin/probe-models
 *   Body: { base_url, api_key, provider, key_label, key_labels }
 *   Returns: { ok: bool, models: string[], count: number, error: string|null, used_key_label?: string }
 */

import { loadConfig, resolveKvBinding, checkAdminAuth, validateUpstreamUrl } from '../../lib/config.js';
import { getPreset } from '../../lib/presets/index.js';

function checkAuth(request, env) {
  return checkAdminAuth(request, env);
}

export async function onRequestPost(context) {
  const authErr = checkAuth(context.request, context.env);
  if (authErr) return authErr;

  let body;
  try {
    const text = await context.request.text();
    body = JSON.parse(text);
  } catch (e) {
    return new Response(
      JSON.stringify({ ok: false, error: '请求体非合法 JSON' }),
      { status: 400, headers: { 'content-type': 'application/json' } }
    );
  }

  let { base_url, api_key, provider, key_label, key_labels } = body || {};
  base_url = (base_url || '').trim();
  provider = (provider || '').trim();
  api_key = (api_key || '').trim();
  key_label = (key_label || '').trim();

  const targetKeyLabels = [];
  if (key_label) targetKeyLabels.push(key_label);
  if (Array.isArray(key_labels)) {
    for (const kl of key_labels) {
      if (kl && typeof kl === 'string' && !targetKeyLabels.includes(kl.trim())) {
        targetKeyLabels.push(kl.trim());
      }
    }
  }

  // 1. 读取 EdgeOne KV 运行时配置
  let cfg = null;
  let p = null;
  let matchedProviderKey = provider;

  try {
    const kvRes = resolveKvBinding ? resolveKvBinding(context) : null;
    const kv = kvRes?.kv;
    cfg = await loadConfig(context.env, kv);
  } catch (e) {
    console.warn('probe-models: failed to load config:', e?.message || e);
  }

  const provs = cfg?.providers || cfg?.config?.providers || {};
  if (provider && provs) {
    if (provs[provider]) {
      p = provs[provider];
    } else {
      const lower = provider.toLowerCase();
      const foundKey = Object.keys(provs).find(k => k.toLowerCase() === lower);
      if (foundKey) {
        p = provs[foundKey];
        matchedProviderKey = foundKey;
      }
    }
  }

  // 2. 解析 base_url：多层兜底（传入值 -> 本地配置 -> 内置预设库 -> 常见厂商硬编码）
  if (!base_url && p?.base_url) {
    base_url = String(p.base_url).trim();
  }
  if (!base_url && provider) {
    try {
      const preset = getPreset(provider) || getPreset(matchedProviderKey);
      if (preset?.base_url) {
        base_url = String(preset.base_url).trim();
      }
    } catch (_) {}
  }
  if (!base_url && provider) {
    const pLow = provider.toLowerCase();
    if (pLow.includes('minimax')) {
      base_url = 'https://api.minimaxi.com/v1';
    } else if (pLow.includes('deepseek')) {
      base_url = 'https://api.deepseek.com/v1';
    } else if (pLow.includes('google') || pLow.includes('gemini')) {
      base_url = 'https://generativelanguage.googleapis.com/v1beta/openai';
    } else if (pLow.includes('openai')) {
      base_url = 'https://api.openai.com/v1';
    } else if (pLow.includes('amd')) {
      base_url = 'https://developer.amd.com.cn/radeon/api/v1';
    } else if (pLow.includes('sensenova')) {
      base_url = 'https://api.sensenova.cn/compatible-mode/v1';
    }
  }

  if (!base_url) {
    return new Response(
      JSON.stringify({ ok: false, error: 'base_url 不能为空且未找到对应供应商配置' }),
      { status: 400, headers: { 'content-type': 'application/json' } }
    );
  }

  // SSRF Protection
  const urlCheck = validateUpstreamUrl(base_url);
  if (!urlCheck.ok) {
    return new Response(
      JSON.stringify({ ok: false, error: `base_url ${urlCheck.error}` }),
      { status: 400, headers: { 'content-type': 'application/json' } }
    );
  }

  // 3. 提取候选 Key 列表
  const candidateKeys = [];
  if (api_key) {
    candidateKeys.push({ label: key_label || '直接输入Key', secret: api_key });
  }

  const pKeys = p?.keys && typeof p.keys === 'object' ? p.keys : {};
  // 优先匹配用户勾选的 targetKeyLabels
  for (const kl of targetKeyLabels) {
    if (pKeys[kl]) {
      candidateKeys.push({ label: kl, secret: pKeys[kl] });
    }
  }
  // 若未指定或未匹配到，加入本地供应商的所有有效 Key
  if (candidateKeys.length === 0) {
    for (const [lbl, sec] of Object.entries(pKeys)) {
      if (sec && typeof sec === 'string') {
        candidateKeys.push({ label: lbl, secret: sec });
      }
    }
  }
  // 兜底允许空 key 尝试探测
  if (candidateKeys.length === 0) {
    candidateKeys.push({ label: '无凭据', secret: '' });
  }

  // 4. 针对 Google 或通用 OpenAI 构建探测端点
  const isGoogle = provider.toLowerCase().includes('google') || base_url.toLowerCase().includes('generativelanguage.googleapis.com');
  let lastErr = null;

  for (const cand of candidateKeys) {
    const urlsToTry = [];
    const headers = {
      'accept': 'application/json',
      'user-agent': 'OCRProxy-ModelProber/1.0',
    };
    if (cand.secret) {
      headers['authorization'] = `Bearer ${String(cand.secret).trim()}`;
    }

    if (isGoogle) {
      urlsToTry.push('https://generativelanguage.googleapis.com/v1beta/openai/models');
      if (cand.secret) {
        urlsToTry.push(`https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(cand.secret)}`);
      }
    } else {
      const b = base_url.replace(/\/+$/, '');
      if (b.endsWith('/v1')) {
        urlsToTry.push(`${b}/models`);
      } else {
        urlsToTry.push(`${b}/v1/models`);
        urlsToTry.push(`${b}/models`);
      }
    }

    for (const url of urlsToTry) {
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 8000);
        const res = await fetch(url, {
          method: 'GET',
          headers,
          signal: controller.signal,
        });
        clearTimeout(timer);

        if (!res.ok) {
          lastErr = `上游 HTTP ${res.status}: ${res.statusText || 'Error'}`;
          continue;
        }

        const json = await res.json().catch(() => null);
        if (!json || typeof json !== 'object') {
          lastErr = '上游返回数据非有效 JSON';
          continue;
        }

        let rawList = [];
        if (Array.isArray(json.data)) {
          rawList = json.data;
        } else if (Array.isArray(json.models)) {
          rawList = json.models;
        } else if (Array.isArray(json)) {
          rawList = json;
        }

        const models = rawList
          .map(m => (typeof m === 'string' ? m : (m?.id || m?.name || '')))
          .filter(Boolean)
          .map(m => m.replace(/^models\//, ''));

        if (models.length === 0) {
          lastErr = '上游响应中未包含有效模型列表';
          continue;
        }

        const uniqueModels = Array.from(new Set(models)).sort((a, b) => a.localeCompare(b));

        return new Response(
          JSON.stringify({
            ok: true,
            models: uniqueModels,
            count: uniqueModels.length,
            endpoint: url,
            used_key_label: cand.label !== '无凭据' ? cand.label : undefined,
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      } catch (err) {
        lastErr = err?.name === 'AbortError' ? '上游请求超时 (8s)' : (err?.message || String(err));
      }
    }
  }

  return new Response(
    JSON.stringify({
      ok: false,
      models: [],
      count: 0,
      error: lastErr || '无法探测上游可用模型列表，请检查网络或凭据权限',
    }),
    { status: 200, headers: { 'content-type': 'application/json' } }
  );
}

/**
 * api/vault/fetch.js — Securely fetch provider configuration and specific key secrets on demand.
 *
 *   POST /api/vault/fetch
 *   Body: { provider: string, key_label?: string, keys?: string[] }
 *   Returns: {
 *     ok: true,
 *     provider: string,
 *     provider_config: {
 *       name: string,
 *       protocol: string,
 *       base_url: string,
 *       adapter_rules: object,
 *       keys: { [label: string]: string } // only requested keys
 *     }
 *   }
 */

import {
  loadConfig,
  ConfigError,
  resolveKvBinding,
  checkVaultAuth,
} from '../../lib/config.js';
import { getPreset } from '../../lib/presets/index.js';
import { isVaultExportableKey, toVaultProviderView } from '../../lib/config.js';

function checkAuth(request, env) {
  return checkVaultAuth(request, env);
}

export async function onRequestPost(context) {
  return handleVaultFetch(context);
}

export async function handleVaultFetch(context, options = {}) {
  const { request, env } = context;
  const authErr = checkAuth(request, env);
  if (authErr) return authErr;

  let body;
  try {
    const text = await request.text();
    body = JSON.parse(text);
  } catch (e) {
    return new Response(
      JSON.stringify({ ok: false, error: '请求体非合法 JSON' }),
      { status: 400, headers: { 'content-type': 'application/json' } }
    );
  }

  const { provider, key_label, keys, credentials_only, include_rules } = body || {};
  const isCredentialsOnly = Boolean(options.forceCredentialsOnly || credentials_only === true || include_rules === false);
  if (!provider) {
    return new Response(
      JSON.stringify({ ok: false, error: 'provider 字段不能为空' }),
      { status: 400, headers: { 'content-type': 'application/json' } }
    );
  }

  let config;
  try {
    const kvRes = resolveKvBinding(context);
    config = await loadConfig(env, kvRes?.kv);
  } catch (e) {
    if (e instanceof ConfigError) {
      return new Response(
        JSON.stringify({ ok: false, error: e.message }),
        { status: 500, headers: { 'content-type': 'application/json' } }
      );
    }
    return new Response(
      JSON.stringify({ ok: false, error: e?.message || String(e) }),
      { status: 500, headers: { 'content-type': 'application/json' } }
    );
  }

  const pCfg = config.providers?.[provider];
  if (!pCfg || pCfg.origin === 'local') {
    return new Response(
      JSON.stringify({ ok: false, error: `中枢未找到托管供应商「${provider}」` }),
      { status: 404, headers: { 'content-type': 'application/json' } }
    );
  }

  const preset = getPreset(provider);
  const targetKeys = {};
  const requestedLabels = keys && Array.isArray(keys) ? keys : (key_label ? [key_label] : Object.keys(pCfg.keys || {}));

  for (const label of requestedLabels) {
    if (pCfg.keys && pCfg.keys[label]) {
      const keyObj = pCfg.keys[label];
      // 严格安全隔离：本地凭据绝不对外分发（统一走 isVaultExportableKey 判定）
      if (!isVaultExportableKey(keyObj)) continue;
      targetKeys[label] = keyObj;
    }
  }

  if (isCredentialsOnly) {
    const singleKeyObj = key_label && targetKeys[key_label] ? targetKeys[key_label] : null;
    const singleKeyVal = (typeof singleKeyObj === 'object' && singleKeyObj !== null) ? singleKeyObj.key : singleKeyObj;
    const singleBaseUrl = (typeof singleKeyObj === 'object' && singleKeyObj !== null && singleKeyObj.base_url)
      ? singleKeyObj.base_url
      : (pCfg.base_url || preset?.base_url || '');

    const respData = {
      ok: true,
      provider,
      base_url: singleBaseUrl || pCfg.base_url || preset?.base_url || '',
      keys: targetKeys,
    };
    if (key_label && singleKeyVal) {
      respData.key_label = key_label;
      respData.key = singleKeyVal;
      if (typeof singleKeyObj === 'object' && singleKeyObj !== null) {
        if (singleKeyObj.project_id) respData.project_id = singleKeyObj.project_id;
        if (singleKeyObj.location) respData.location = singleKeyObj.location;
      }
    }
    return new Response(JSON.stringify(respData), {
      status: 200,
      headers: {
        'content-type': 'application/json',
        'cache-control': 'no-store',
      },
    });
  }

  const view = toVaultProviderView(provider, pCfg, preset, { includeSecrets: true });
  const responseConfig = {
    name: view.name,
    protocol: view.protocol,
    protocols: view.protocols,
    anthropic_messages: view.anthropic_messages,
    base_url: view.base_url,
    anthropic_base_url: view.anthropic_base_url,
    adapter_rules: view.adapter_rules,
    cached_models: view.models,
    keys: targetKeys,
    ...(view.rpm_per_key ? { rpm_per_key: view.rpm_per_key } : {}),
  };

  return new Response(
    JSON.stringify({
      ok: true,
      provider,
      provider_config: responseConfig,
    }),
    {
      status: 200,
      headers: {
        'content-type': 'application/json',
        'cache-control': 'no-store',
      },
    }
  );
}

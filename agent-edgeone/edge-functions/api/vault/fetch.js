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
} from '../../lib/config.js';
import { getPreset } from '../../lib/presets/index.js';

function checkAuth(request, env) {
  const need = env?.PROXY_API_KEY;
  if (!need) return null;
  const got = request.headers.get('authorization') || '';
  if (got !== `Bearer ${need}`) {
    return new Response(
      JSON.stringify({ error: { type: 'authentication_error', message: 'Missing or invalid Authorization header.', code: 'invalid_api_key' } }),
      { status: 401, headers: { 'content-type': 'application/json', 'www-authenticate': 'Bearer' } }
    );
  }
  return null;
}

export async function onRequestPost(context) {
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

  const { provider, key_label, keys } = body || {};
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
  if (!pCfg) {
    return new Response(
      JSON.stringify({ ok: false, error: `中枢未找到供应商「${provider}」` }),
      { status: 404, headers: { 'content-type': 'application/json' } }
    );
  }

  const preset = getPreset(provider);
  const targetKeys = {};
  const requestedLabels = keys && Array.isArray(keys) ? keys : (key_label ? [key_label] : Object.keys(pCfg.keys || {}));

  for (const label of requestedLabels) {
    if (pCfg.keys && pCfg.keys[label]) {
      targetKeys[label] = pCfg.keys[label];
    }
  }

  const protoStr = pCfg.protocol || preset?.protocol || 'openai';
  const rawProtos = (Array.isArray(pCfg.protocols) && pCfg.protocols.length > 0)
    ? pCfg.protocols
    : (protoStr === 'messages' ? ['messages'] : (pCfg.anthropic_messages ? ['chat', 'messages'] : ['chat']));
  const isAnthropic = Boolean(pCfg.anthropic_messages || rawProtos.includes('messages') || protoStr === 'messages');

  const responseConfig = {
    name: pCfg.name || preset?.name || provider,
    protocol: protoStr,
    protocols: rawProtos,
    anthropic_messages: isAnthropic,
    base_url: pCfg.base_url || preset?.base_url || '',
    anthropic_base_url: pCfg.anthropic_base_url || preset?.anthropic_base_url || '',
    adapter_rules: pCfg.adapter_rules || preset?.adapter_rules || {},
    cached_models: pCfg.cached_models || preset?.recommended_models?.map(m => m.name || m.upstream_model) || [],
    keys: targetKeys,
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

/**
 * api/vault/manifest.js — Read-only Vault Manifest of available providers and key labels.
 *
 *   GET /api/vault/manifest
 *   Returns: {
 *     ok: true,
 *     version: string|number,
 *     updated_at: string,
 *     providers: {
 *       [id]: {
 *         name: string,
 *         type: "specialized" | "standard",
 *         protocol: "openai" | "messages",
 *         base_url: string,
 *         keys: string[], // labels only, NO secret text
 *         models: string[],
 *         adapter_rules: object
 *       }
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

export async function onRequestGet(context) {
  const { request, env } = context;
  const authErr = checkAuth(request, env);
  if (authErr) return authErr;

  let config;
  try {
    const kvRes = resolveKvBinding(context);
    config = await loadConfig(env, kvRes?.kv);
  } catch (e) {
    if (e instanceof ConfigError) {
      return new Response(
        JSON.stringify({ ok: false, error: { type: 'config_error', message: e.message } }),
        { status: 500, headers: { 'content-type': 'application/json' } }
      );
    }
    return new Response(
      JSON.stringify({ ok: false, error: { type: 'server_error', message: e?.message || String(e) } }),
      { status: 500, headers: { 'content-type': 'application/json' } }
    );
  }

  const providers = config.providers || {};
  const manifestProviders = {};

  for (const [pId, pCfg] of Object.entries(providers)) {
    if (!pCfg || typeof pCfg !== 'object') continue;
    const preset = getPreset(pId);
    const isSpecialized = Boolean(preset && (preset.adapter_rules || preset.features?.native_thinking));

    // Extract key labels (never expose secrets in manifest)
    const keyLabels = Object.keys(pCfg.keys || {});

    // Models: from preset, or probe_models cache, or recommended_models
    let models = [];
    if (Array.isArray(pCfg.cached_models) && pCfg.cached_models.length > 0) {
      models = pCfg.cached_models;
    } else if (preset && Array.isArray(preset.recommended_models)) {
      models = preset.recommended_models.map(m => m.name || m.upstream_model).filter(Boolean);
    }

    const protoStr = pCfg.protocol || preset?.protocol || 'openai';
    const rawProtos = (Array.isArray(pCfg.protocols) && pCfg.protocols.length > 0)
      ? pCfg.protocols
      : (protoStr === 'messages' ? ['messages'] : (pCfg.anthropic_messages ? ['chat', 'messages'] : ['chat']));
    const isAnthropic = Boolean(pCfg.anthropic_messages || rawProtos.includes('messages') || protoStr === 'messages');

    manifestProviders[pId] = {
      id: pId,
      name: pCfg.name || preset?.name || pId,
      type: isSpecialized ? 'specialized' : 'standard',
      protocol: protoStr,
      protocols: rawProtos,
      anthropic_messages: isAnthropic,
      base_url: pCfg.base_url || preset?.base_url || '',
      anthropic_base_url: pCfg.anthropic_base_url || preset?.anthropic_base_url || '',
      doc_url: pCfg.doc_url || preset?.doc_url || '',
      description: pCfg.description || preset?.description || '',
      keys: keyLabels,
      models: models,
      adapter_rules: pCfg.adapter_rules || preset?.adapter_rules || {},
    };
  }

  return new Response(
    JSON.stringify({
      ok: true,
      version: config.version || '1.0.0',
      providers: manifestProviders,
      count: Object.keys(manifestProviders).length,
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

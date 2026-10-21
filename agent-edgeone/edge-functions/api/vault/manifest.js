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
  checkVaultAuth,
} from '../../lib/config.js';
import { getPreset } from '../../lib/presets/index.js';
import { toVaultProviderView } from '../../lib/config.js';

function checkAuth(request, env) {
  return checkVaultAuth(request, env);
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
    // Local/private providers are never advertised by the hub (fetch refuses them too).
    if (pCfg.origin === 'local') continue;
    manifestProviders[pId] = toVaultProviderView(pId, pCfg, getPreset(pId), { includeSecrets: false });
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

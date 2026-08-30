/**
 * api/state.js — admin endpoints for inspecting and clearing cooldowns.
 *
 *   GET    /api/state    — list all cooldowns (auth required)
 *   DELETE /api/state    — clear ALL cooldowns + failure counters (auth required)
 *
 * Useful when an operator needs to force a clean slate without waiting
 * for the 60s KV propagation or the 600s quota cooldown.
 */

import { loadConfig, ConfigError, resolveKvBinding, kvNotBoundResponse } from '../lib/config.js';
import { snapshotState, clearAllState } from '../lib/cooldowns.js';

function checkAuth(request, env) {
  const need = env?.PROXY_API_KEY;
  if (!need) return null; // no auth configured → allow
  const got = request.headers.get('authorization') || '';
  if (got !== `Bearer ${need}`) {
    return new Response(
      JSON.stringify({
        error: {
          type: 'authentication_error',
          message: 'Missing or invalid Authorization header.',
          code: 'invalid_api_key',
        },
      }),
      {
        status: 401,
        headers: { 'content-type': 'application/json', 'www-authenticate': 'Bearer' },
      }
    );
  }
  return null;
}

function collectBindings(config) {
  const out = [];
  for (const model of Object.values(config.agent_models || {})) {
    for (const k of (model?.keys || [])) {
      if (!k?.provider || !k?.key) continue;
      out.push({
        provider: k.provider,
        keyLabel: k.key,
        upstreamModel: k.upstream_model,
      });
    }
  }
  return out;
}

export async function onRequestGet(context) {
  const { env, request } = context;
  const authErr = checkAuth(request, env);
  if (authErr) return authErr;

  const kvRes = resolveKvBinding(context);
  if (!kvRes) {
    return kvNotBoundResponse(context);
  }
  const kv = kvRes.kv;

  let config;
  try {
    config = await loadConfig(env, kv);
  } catch (e) {
    return new Response(
      JSON.stringify({ error: { type: 'config_error', message: e?.message || String(e) } }),
      { status: 500, headers: { 'content-type': 'application/json' } }
    );
  }
  const bindings = collectBindings(config);
  const cooldowns = await snapshotState(bindings, kv);
  return new Response(
    JSON.stringify({
      timestamp: new Date().toISOString(),
      kv_binding: kvRes.name,
      keys_total: cooldowns.length,
      keys_in_cooldown: cooldowns.filter((c) => c.inCooldown).length,
      cooldowns,
    }),
    {
      status: 200,
      headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
    }
  );
}

export async function onRequestDelete(context) {
  const { env, request } = context;
  const authErr = checkAuth(request, env);
  if (authErr) return authErr;

  const kvRes = resolveKvBinding(context);
  if (!kvRes) {
    return kvNotBoundResponse(context);
  }
  const kv = kvRes.kv;

  let config;
  try {
    config = await loadConfig(env, kv);
  } catch (e) {
    return new Response(
      JSON.stringify({ error: { type: 'config_error', message: e?.message || String(e) } }),
      { status: 500, headers: { 'content-type': 'application/json' } }
    );
  }
  const bindings = collectBindings(config);
  const cleared = await clearAllState(bindings, kv);
  return new Response(
    JSON.stringify({
      timestamp: new Date().toISOString(),
      kv_binding: kvRes.name,
      cleared,
      cleared,
      message: `Cleared ${cleared} keys' cooldowns and failure counters.`,
    }),
    {
      status: 200,
      headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
    }
  );
}

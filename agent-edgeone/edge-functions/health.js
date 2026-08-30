/**
 * health.js — GET /health
 *
 * Liveness probe + state inspector.  Always returns 200 if the function
 * is reachable.  The `cooldowns` field surfaces the current KV state so
 * operators can debug without authenticating against the admin endpoint.
 */

import { loadConfig, ConfigError, resolveKvBinding } from './lib/config.js';
import { snapshotState, getCooldownsBatch, bindingId } from './lib/cooldowns.js';

export async function onRequestGet(context) {
  let configOk = false;
  let configErr = null;
  let modelCount = 0;
  let cooldowns = [];
  const kvRes = resolveKvBinding(context);
  const kv = kvRes?.kv;
  let kvBound = !!kv;
  let kvName = kvRes?.name || null;
  let kvError = null;

  try {
    const config = await loadConfig(context.env, kv);
    configOk = true;
    modelCount = Object.keys(config.agent_models || {}).length;
    // Aggregate cooldowns across all configured bindings
    const allBindings = [];
    for (const model of Object.values(config.agent_models || {})) {
      for (const k of (model?.keys || [])) {
        if (!k?.provider || !k?.key) continue;
        allBindings.push({
          provider: k.provider,
          keyLabel: k.key,
          upstreamModel: k.upstream_model,
        });
      }
    }
    cooldowns = await snapshotState(allBindings, kv);
  } catch (e) {
    if (e instanceof ConfigError) configErr = e.message;
    else {
      configErr = e?.message || String(e);
      kvError = (e?.message || '').toLowerCase().includes('kv') ? e.message : null;
    }
  }

  const inCooldown = cooldowns.filter((c) => c.inCooldown).length;

  return new Response(
    JSON.stringify({
      status: configOk ? 'ok' : 'degraded',
      uptime_hint: 'edge-function',
      config_loaded: configOk,
      config_error: configErr,
      kv_bound: kvBound,
      kv_error: kvError,
      model_count: modelCount,
      keys_total: cooldowns.length,
      keys_in_cooldown: inCooldown,
      cooldowns,
      timestamp: new Date().toISOString(),
    }),
    {
      status: 200,
      headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
    }
  );
}

export async function onRequest(context) {
  return onRequestGet(context);
}

export default onRequestGet;

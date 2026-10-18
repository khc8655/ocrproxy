/**
 * api/admin/stats.js — Return lightweight runtime statistics and error logs for EdgeOne admin panel.
 */
import { requireAuth, loadConfig, resolveKvBinding } from '../../lib/config.js';
import { getCooldownsBatch } from '../../lib/cooldowns.js';

async function getStats(context) {
  const candStatus = {};
  try {
    const kv = resolveKvBinding(context.env);
    if (kv) {
      const cfg = await loadConfig(context.env);
      const bindings = [];
      const agentModels = (cfg && cfg.agent_models) || {};
      for (const [modelName, m] of Object.entries(agentModels)) {
        for (const b of (m.keys || [])) {
          bindings.push({
            provider: b.provider,
            keyLabel: b.key,
            modelName,
            upstreamModel: b.upstream_model || ''
          });
        }
      }
      if (bindings.length > 0) {
        const cooldowns = await getCooldownsBatch(bindings, kv);
        for (const b of bindings) {
          const id = `${b.provider}:${b.keyLabel}`;
          const expiresAt = cooldowns.get(id);
          if (expiresAt && expiresAt > Date.now()) {
            candStatus[`agent:${b.modelName}:${b.provider}:${b.keyLabel}`] = {
              status: 429,
              is_quota: false,
              latency_ms: null,
              time: expiresAt
            };
          }
        }
      }
    }
  } catch (_) {}

  return {
    ok: true,
    agent: {
      active_keys: {}
    },
    candidates_status: candStatus,
    error_logs: [],
    requests_total: 0,
    success_rate: 1.0,
    timestamp: Date.now()
  };
}

export async function onRequestGet(context) {
  const authErr = requireAuth(context);
  if (authErr) return authErr;

  const stats = await getStats(context);
  return new Response(JSON.stringify(stats), {
    status: 200,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store'
    }
  });
}

export async function onRequestPost(context) {
  const authErr = requireAuth(context);
  if (authErr) return authErr;

  const stats = await getStats(context);
  return new Response(JSON.stringify(stats), {
    status: 200,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store'
    }
  });
}

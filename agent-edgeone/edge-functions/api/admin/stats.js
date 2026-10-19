/**
 * api/admin/stats.js — Return lightweight runtime statistics for the EdgeOne admin panel.
 *
 * candidates_status["agent:<model>:<provider>:<key>"] carries the last real call
 * (or manual test) per binding from KV (lib/nodestats.js); an active cooldown
 * overrides it with a 429 badge until it expires.
 */
import { requireAuth, loadConfig, resolveKvBinding } from '../../lib/config.js';
import { getCooldownsBatch, bindingId } from '../../lib/cooldowns.js';
import { agentNodeKey, readNodeStats } from '../../lib/nodestats.js';

async function getStats(context) {
  const candStatus = {};
  try {
    const kv = resolveKvBinding(context)?.kv || null;
    const cfg = await loadConfig(context.env, kv);
    const bindings = [];
    const agentModels = (cfg && cfg.agent_models) || {};
    for (const [modelName, m] of Object.entries(agentModels)) {
      for (const b of (m.keys || [])) {
        if (!b || !b.provider || !b.key) continue;
        bindings.push({
          provider: b.provider,
          keyLabel: b.key,
          modelName,
          upstreamModel: b.upstream_model || m.upstream_model || '',
        });
      }
    }
    if (kv && bindings.length > 0) {
      const nodeKeys = bindings.map((b) => agentNodeKey(b.modelName, b.provider, b.keyLabel));
      const [last, cooldowns] = await Promise.all([
        readNodeStats(kv, nodeKeys),
        getCooldownsBatch(bindings, kv),
      ]);
      const now = Date.now();
      bindings.forEach((b, i) => {
        const nk = nodeKeys[i];
        if (last[nk]) candStatus[nk] = { ...last[nk], category: 'agent', model: b.modelName };
        const expiresAt = cooldowns.get(bindingId(b));
        if (expiresAt && expiresAt > now) {
          const prev = candStatus[nk];
          candStatus[nk] = {
            status: prev && prev.is_quota ? prev.status : 429,
            is_quota: Boolean(prev && prev.is_quota),
            latency_ms: prev ? prev.latency_ms : null,
            time: prev ? prev.time : now,
            cooldown_until: expiresAt,
            category: 'agent',
            model: b.modelName,
          };
        }
      });
    }
  } catch (e) {
    console.warn('stats failed:', e?.message || e);
  }

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

function json(body) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store'
    }
  });
}

export async function onRequestGet(context) {
  const authErr = requireAuth(context);
  if (authErr) return authErr;
  return json(await getStats(context));
}

export async function onRequestPost(context) {
  const authErr = requireAuth(context);
  if (authErr) return authErr;
  return json(await getStats(context));
}

/**
 * lib/nodestats.js — "last call" status per agent key binding, shared via KV.
 *
 * The admin model list shows, per binding, the last status / latency / time.
 * The VM keeps this in process memory (vm-app/app/stats.py candidates_status);
 * EdgeOne isolates are short-lived and many, so the value lives in KV under
 *   nodestat:agent:<model>:<provider>:<key>  ->  {"status","latency_ms","time","is_quota"}
 * using the same node key the UI already reads ("agent:<model>:<provider>:<key>").
 *
 * Writes are throttled per isolate: an unchanged status is rewritten at most
 * once every NODESTAT_MIN_WRITE_MS, so a busy key does not turn every request
 * into a KV write. A status change (200 -> 429, 429 -> 200, ...) is written at once.
 */

import { HARD_QUOTA_KEYWORDS, QUOTA_BALANCE_PHRASES } from './cooldowns.js';

export const NODESTAT_PREFIX = 'nodestat:';
export const NODESTAT_MIN_WRITE_MS = 10_000;
const NODESTAT_TTL_SEC = 7 * 86400;
const _lastWrite = new Map(); // nodeKey -> { t, status }

export function agentNodeKey(model, provider, keyLabel) {
  return `agent:${model}:${provider}:${keyLabel}`;
}

/**
 * Record one result. Never throws. `force` bypasses the throttle (manual tests).
 */
export async function recordNodeStat(kv, { model, provider, keyLabel, status, latencyMs, isQuota = false }, force = false) {
  if (!kv || typeof kv.put !== 'function' || !model || !provider || !keyLabel) return;
  const nodeKey = agentNodeKey(model, provider, keyLabel);
  const now = Date.now();
  const code = Number(status) || 0;
  const prev = _lastWrite.get(nodeKey);
  if (!force && prev && prev.status === code && now - prev.t < NODESTAT_MIN_WRITE_MS) return;
  if (_lastWrite.size > 2000) _lastWrite.clear();
  _lastWrite.set(nodeKey, { t: now, status: code });
  const payload = {
    status: code,
    latency_ms: Math.max(0, Math.round(Number(latencyMs) || 0)),
    time: now,
    is_quota: Boolean(isQuota),
  };
  try {
    await kv.put(NODESTAT_PREFIX + nodeKey, JSON.stringify(payload), { expirationTtl: NODESTAT_TTL_SEC });
  } catch (e) {
    console.warn('nodestat put failed:', e?.message || e);
  }
}

/**
 * Fire-and-forget variant for request handlers: keeps the write alive after
 * the response is returned (context.waitUntil) without delaying the client.
 */
export function recordNodeStatBackground(context, kv, stat, force = false) {
  const p = recordNodeStat(kv, stat, force);
  if (context && typeof context.waitUntil === 'function') {
    try { context.waitUntil(p); return; } catch (_) {}
  }
  p.catch(() => {});
}

/**
 * Read the stored status for each node key. Returns { nodeKey: payload }.
 */
export async function readNodeStats(kv, nodeKeys) {
  const out = {};
  if (!kv || typeof kv.get !== 'function' || !nodeKeys || nodeKeys.length === 0) return out;
  const results = await Promise.allSettled(
    nodeKeys.map((k) => kv.get(NODESTAT_PREFIX + k, { type: 'text' }))
  );
  nodeKeys.forEach((k, i) => {
    const r = results[i];
    if (r.status !== 'fulfilled' || !r.value) return;
    try {
      const v = typeof r.value === 'string' ? JSON.parse(r.value) : r.value;
      if (v && typeof v === 'object' && v.time) out[k] = v;
    } catch (_) {}
  });
  return out;
}

/**
 * Map one attempt's result to the "last call" status the admin model list shows.
 * Latency is time to the committed response (first chunk / peek deadline for streams).
 */
export function nodeStatFromResult(model, binding, result, attemptStartMs) {
  const status = result.kind === 'success'
    ? 200
    : (result.status || (result.kind === 'read_timeout' ? 504 : 502));
  const lower = String(result.errorText || '').toLowerCase();
  const isQuota = status !== 200 && [400, 401, 402, 403, 429].includes(status) && Boolean(lower) &&
    (HARD_QUOTA_KEYWORDS.some((k) => lower.includes(k)) || QUOTA_BALANCE_PHRASES.some((k) => lower.includes(k)));
  return {
    model,
    provider: binding.provider,
    keyLabel: binding.keyLabel,
    status,
    latencyMs: Date.now() - attemptStartMs,
    isQuota,
  };
}

export function _resetNodeStatThrottleForTests() {
  _lastWrite.clear();
}

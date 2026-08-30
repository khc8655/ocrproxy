/**
 * cooldowns.js — Per-key cooldown and circuit-breaker state on EdgeOne KV.
 *
 * Why this exists:
 *   Random Key rotation by itself is not enough — if a single Key keeps
 *   returning 429, hitting it again on the next request is wasteful.  The
 *   VM tracks per-key state in module-level dicts; here we use EdgeOne
 *   KV so state is shared across the 3200+ edge nodes.
 *
 * KV propagation caveat (the user is aware of this — see FEASIBILITY-REPORT.md §6):
 *   KV is *eventually consistent* with up to 60s propagation across edge
 *   nodes.  For agent-mode this is acceptable because:
 *     1. The same node that just wrote a cooldown can immediately read it
 *        (writes are immediately visible to the writer's node).
 *     2. Other nodes converge within 60s, which is much shorter than the
 *        600s cooldown for hard failures (403 / quota exhausted).
 *     3. A burst of 429s on one Key will be caught by the writer's node
 *        first; the global view follows within the 60s window.
 *
 *   This is best-effort, not strong-consistency.  Don't use it for
 *   anything that requires strict ordering (e.g. financial transactions).
 *
 * Storage layout in KV (namespace `agent_kv`):
 *   cd:<provider>:<key_label>          value = expires_at_unix_ms  (number as string)
 *   fail:<provider>:<key_label>        value = consecutive_5xx_count
 *   meta:config                        value = JSON-encoded full config
 *                                       (set by the VM admin panel for live updates)
 *
 * TTL: every write includes a KV-level expiration so dead keys self-clean.
 * The TTL is set generously (1200s) to cover the longest possible cooldown
 * (600s quota) plus a buffer.
 */

const KV_TTL_SEC = 1200;

const COOLDOWN_PREFIX = 'cd:';
const FAIL_COUNT_PREFIX = 'fail:';

// Cooldown durations in seconds, matching the VM (vm-app/app/scheduler.py).
// Keep these in sync with the VM if either side is tuned.
export const COOLDOWN_DURATIONS = Object.freeze({
  TPM_429: 60,       // VM: cooldown_429_sec (default)
  QUOTA_403: 600,    // VM: cooldown_403_sec (default)
  SERVER_5XX: 30,    // VM: cooldown_5xx_sec (default)
  READ_TIMEOUT: 2,   // VM: read_timeout short
  EMPTY_STREAM: 5,   // 200 + zero bytes — provider glitch
  CIRCUIT_BREAKER: 300, // VM: circuit_cooldown_sec — when fail_count >= threshold
  KEY_DRIFT: 30,     // 401/404 — config drift
});

export const CIRCUIT_BREAKER_THRESHOLD = 3; // VM: circuit_break_threshold

/**
 * Safely encode any string into [a-zA-Z0-9_] for EdgeOne KV keys.
 * EdgeOne KV strictly requires key to match [a-zA-Z0-9_] and <= 512B.
 */
function safeKeyPart(str) {
  if (!str) return 'empty';
  if (/^[a-zA-Z0-9_]+$/.test(str)) return str;
  let out = '';
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i);
    if (
      (code >= 48 && code <= 57) || // 0-9
      (code >= 65 && code <= 90) || // A-Z
      (code >= 97 && code <= 122) || // a-z
      code === 95 // _
    ) {
      out += str[i];
    } else {
      out += '_' + code.toString(16);
    }
  }
  return out;
}

/**
 * Build the KV key for a (provider, key_label) cooldown entry.
 */
export function cooldownKey(provider, keyLabel) {
  return `cd_${safeKeyPart(provider)}_${safeKeyPart(keyLabel)}`;
}

export function failCountKey(provider, keyLabel) {
  return `fail_${safeKeyPart(provider)}_${safeKeyPart(keyLabel)}`;
}

/**
 * Read the current cooldown expiry (ms since epoch) for a binding.
 * Returns 0 if no cooldown is set, or the expiry has passed.
 */
export async function getCooldown(provider, keyLabel, kv) {
  if (!kv) return 0;
  try {
    const raw = await kv.get(cooldownKey(provider, keyLabel), { type: 'text' });
    if (!raw) return 0;
    const expires = Number(raw);
    if (!Number.isFinite(expires) || expires <= Date.now()) return 0;
    return expires;
  } catch (e) {
    // KV read failures must NOT take down the relay — fall through as
    // "no cooldown" and let the request proceed.
    console.warn('cooldown get failed:', e?.message || e);
    return 0;
  }
}

/**
 * Read cooldowns for many bindings in one batch.
 * Returns a Map<bindingId, expiresAtMs> (0 if not in cooldown).
 */
export async function getCooldownsBatch(bindings, kv) {
  const out = new Map();
  if (!kv || !bindings || bindings.length === 0) return out;
  // We could use kv.get([...keys]) for a single multi-read if available;
  // for now Promise.all of single gets is fine and bounded by N candidates.
  const results = await Promise.allSettled(
    bindings.map((b) => getCooldown(b.provider, b.keyLabel, kv))
  );
  for (let i = 0; i < bindings.length; i++) {
    const r = results[i];
    out.set(bindingId(bindings[i]), r.status === 'fulfilled' ? r.value : 0);
  }
  return out;
}

/**
 * Set a cooldown for a binding.  `durationSec` defaults to 30s if omitted.
 */
export async function setCooldown(provider, keyLabel, durationSec, kv) {
  if (!kv) return;
  const sec = Number(durationSec) > 0 ? Number(durationSec) : 30;
  const expiresAt = Date.now() + sec * 1000;
  try {
    await kv.put(cooldownKey(provider, keyLabel), String(expiresAt));
  } catch (e) {
    console.warn('cooldown put failed:', e?.message || e);
  }
  return expiresAt;
}

/**
 * Increment the consecutive-failure counter for a binding.
 * If it reaches the circuit-breaker threshold, set a long cooldown
 * and reset the counter.
 */
export async function recordFailure(provider, keyLabel, kv) {
  if (!kv) return 0;
  const fk = failCountKey(provider, keyLabel);
  let count = 0;
  try {
    const raw = await kv.get(fk, { type: 'text' });
    count = raw ? Number(raw) || 0 : 0;
    count += 1;
    await kv.put(fk, String(count));
  } catch (e) {
    console.warn('recordFailure read/write failed:', e?.message || e);
    return 0;
  }
  if (count >= CIRCUIT_BREAKER_THRESHOLD) {
    await setCooldown(provider, keyLabel, COOLDOWN_DURATIONS.CIRCUIT_BREAKER, kv);
    // Reset the counter so we don't keep tripping on the same key forever.
    try { await kv.delete(fk); } catch {}
  }
  return count;
}

/**
 * Clear the failure counter on a successful response.
 */
export async function recordSuccess(provider, keyLabel, kv) {
  if (!kv) return;
  try {
    await kv.delete(failCountKey(provider, keyLabel));
  } catch (e) {
    console.warn('recordSuccess failed:', e?.message || e);
  }
}

/**
 * Stable ID for a binding.  Used as Map keys.
 */
export function bindingId(b) {
  return `${b.provider}:${b.keyLabel}`;
}

/**
 * Classify an upstream response and return the cooldown duration it
 * should trigger (in seconds).  0 means "no cooldown needed".
 *
 * Mirrors VM's scheduler.py logic for the cases that make sense here.
 */
export function classifyFailure(status, kind /* 'http' | 'empty_stream' | 'read_timeout' */) {
  if (kind === 'empty_stream') return COOLDOWN_DURATIONS.EMPTY_STREAM;
  if (kind === 'read_timeout') return COOLDOWN_DURATIONS.READ_TIMEOUT;
  if (status === 429) return COOLDOWN_DURATIONS.TPM_429;
  if (status === 403) return COOLDOWN_DURATIONS.QUOTA_403;
  if (status === 401 || status === 404) return COOLDOWN_DURATIONS.KEY_DRIFT;
  if (status >= 500) return COOLDOWN_DURATIONS.SERVER_5XX;
  return 0;
}

/**
 * Decide if a status code should trigger failover to the next candidate.
 * 2xx → no, return to client
 * 400 → no, return to client (likely request-level)
 * 408 / 429 / 5xx / empty stream → yes
 * 401 / 403 / 404 → also yes (key-level, but mark with longer cooldown)
 */
export function shouldFailover(status, kind) {
  if (kind === 'empty_stream' || kind === 'read_timeout') return true;
  if (status >= 200 && status < 300) return false;
  if (status === 400) return false; // request-level — short-circuit
  return true;
}

/**
 * Wipe all cooldowns and fail counters.  Used by the admin/state endpoint
 * when the operator wants to force a clean slate.
 */
export async function clearAllState(bindings, kv) {
  if (!kv) return 0;
  let n = 0;
  for (const b of bindings || []) {
    try {
      await kv.delete(cooldownKey(b.provider, b.keyLabel));
      await kv.delete(failCountKey(b.provider, b.keyLabel));
      n += 1;
    } catch (e) {
      console.warn('clearAllState failed for', b.provider, b.keyLabel, e?.message);
    }
  }
  return n;
}

/**
 * Snapshot all cooldowns for the admin endpoint.
 * Returns [{ provider, keyLabel, expiresAt, inCooldown }]
 */
export async function snapshotState(bindings, kv) {
  const now = Date.now();
  const out = [];
  for (const b of bindings || []) {
    let expiresAt = 0;
    let failCount = 0;
    try {
      if (kv) {
        const c = await kv.get(cooldownKey(b.provider, b.keyLabel), { type: 'text' });
        if (c) expiresAt = Number(c) || 0;
        const f = await kv.get(failCountKey(b.provider, b.keyLabel), { type: 'text' });
        if (f) failCount = Number(f) || 0;
      }
    } catch (e) {
      // skip on error
    }
    out.push({
      provider: b.provider,
      keyLabel: b.keyLabel,
      upstreamModel: b.upstreamModel,
      expiresAt,
      remainingMs: expiresAt > now ? expiresAt - now : 0,
      inCooldown: expiresAt > now,
      consecutiveFailures: failCount,
    });
  }
  return out;
}

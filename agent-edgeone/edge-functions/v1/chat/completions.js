/**
 * v1/chat/completions.js — POST /v1/chat/completions (Agent mode)
 *
 * Stateful failover over the EdgeOne Makers Edge Function runtime.
 *
 * Behavior:
 *   1. Read all cooldowns from KV, filter out in-cooldown keys.
 *   2. Pick a random available binding for the requested model.
 *   3. Forward to upstream.  For stream=true, peek the first chunk
 *      before committing (mirrors VM's _peek_first_chunk behaviour).
 *   4. On retriable failure (429/5xx/401/403/empty-stream), write a
 *      cooldown to KV, then retry with the next available binding.
 *   5. On non-retriable failure (400 — request-level), return immediately.
 *   6. On 2xx, clear the failure counter and stream the response back.
 *
 * Limits respected:
 *   - Body ≤ 1 MB (Edge Function hard limit).  Larger → 413 with
 *     X-Fallback-Endpoint hint.
 *   - CPU < 200 ms — JSON parse + header construction only.  Upstream
 *     fetch and stream are I/O and excluded.
 *   - Max 3 retries per request (mirrors VM's schedule_total_budget).
 *   - KV propagation lag (60s) is acceptable for agent-mode cooldowns
 *     (the writer's own node sees the cooldown immediately, others catch
 *     up within 60s).
 *
 * Auth: Bearer <PROXY_API_KEY> required.
 */

import {
  loadConfig,
  listBindings,
  pickBinding,
  orderBindings,
  recordStickySuccess,
  resolveBinding,
  buildChatUrl,
  ConfigError,
  resolveKvBinding,
} from '../../lib/config.js';
import { normaliseForProvider } from '../../lib/normalize.js';
import {
  getCooldownsBatch,
  setCooldown,
  recordFailure,
  recordSuccess,
  classifyFailure,
  shouldFailover,
  bindingId,
} from '../../lib/cooldowns.js';

const MAX_BODY_BYTES = 1024 * 1024; // 1 MB Edge Function limit
const DEFAULT_UPSTREAM_TIMEOUT_MS = 25_000; // 25s upstream timeout to allow failover within EdgeOne 30s limit
const MAX_RETRIES = 3;

export default async function onRequestPost(context) {
  const { request, env } = context;
  const startMs = Date.now();
  // Try common KV binding names (agent_kv, kv, KV, etc.) — see
  // resolveKvBinding for the full list.
  const kvRes = resolveKvBinding(context);
  const kv = kvRes?.kv;

  // ---- Auth --------------------------------------------------------------
  const authErr = checkAuth(request, env);
  if (authErr) return authErr;

  // ---- Pre-flight body size check (use Content-Length) ------------------
  const declaredLen = Number(request.headers.get('content-length') || 0);
  if (declaredLen > MAX_BODY_BYTES) {
    return tooLargeResponse(declaredLen);
  }

  // ---- Read body ---------------------------------------------------------
  let bodyText;
  try {
    bodyText = await request.text();
  } catch (e) {
    if (e?.name === 'OverSize' || /over.?size/i.test(e?.message || '')) {
      return tooLargeResponse(declaredLen || 0);
    }
    return errorResponse(400, 'invalid_request_error', `Failed to read body: ${e?.message || e}`);
  }
  if (bodyText.length > MAX_BODY_BYTES) {
    return tooLargeResponse(bodyText.length);
  }

  let body;
  try {
    body = JSON.parse(bodyText);
  } catch (e) {
    return errorResponse(400, 'invalid_request_error', `Body is not valid JSON: ${e?.message || e}`);
  }
  if (!body || typeof body !== 'object') {
    return errorResponse(400, 'invalid_request_error', 'Body must be a JSON object.');
  }
  if (typeof body.model !== 'string' || !body.model) {
    return errorResponse(400, 'invalid_request_error', 'Field "model" is required.');
  }

  // ---- Load config -------------------------------------------------------
  let config;
  try {
    config = await loadConfig(env, kv);
  } catch (e) {
    if (e instanceof ConfigError) {
      return errorResponse(500, 'config_error', e.message);
    }
    return errorResponse(500, 'config_error', `Config load failed: ${e?.message || e}`);
  }

  // ---- Resolve candidate list -------------------------------------------
  const allBindings = listBindings(config, body.model);
  if (allBindings.length === 0) {
    return errorResponse(
      404,
      'invalid_request_error',
      `Model "${body.model}" is not configured on this relay. ` +
        `Call GET /v1/models to see available models.`
    );
  }

  // ---- Read cooldowns, filter to available -------------------------------
  const cooldownMap = await getCooldownsBatch(allBindings, kv);
  const available = allBindings.filter((b) => {
    const exp = cooldownMap.get(bindingId(b)) || 0;
    return exp <= Date.now();
  });
  if (available.length === 0) {
    // Everyone is in cooldown.  Return 503 with a Retry-After hint.
    // The operator can also DELETE /api/state to clear all cooldowns.
    return new Response(
      JSON.stringify({
        error: {
          type: 'overloaded',
          message: 'All candidate keys are in cooldown. Please retry shortly.',
          code: 'all_keys_in_cooldown',
        },
      }),
      {
        status: 503,
        headers: {
          'content-type': 'application/json',
          'retry-after': '30',
          'x-edgeone-relay': 'v8-1',
          'x-edgeone-state': 'all_in_cooldown',
        },
      }
    );
  }

  // ---- Failover loop -----------------------------------------------------
  const attemptLog = []; // for X-Edgeone-Route-Trace header
  const tried = new Set();
  let upstreamBody = JSON.parse(JSON.stringify(body)); // deep copy per attempt

  const strategy = config?.agent_routing_strategy || 'sticky_failover';
  const candidatePool = orderBindings(available, body.model, strategy);

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    // Pick from bindings in strategy order not yet tried in this request
    const binding = candidatePool.find((b) => !tried.has(bindingId(b)));
    if (!binding) break;
    tried.add(bindingId(binding));

    let resolved;
    try {
      resolved = resolveBinding(config, binding);
    } catch (e) {
      // Config drift — write a short cooldown and try the next
      await setCooldown(binding.provider, binding.keyLabel, 30, kv);
      attemptLog.push(`${binding.provider}/${binding.keyLabel}=config_drift`);
      continue;
    }

    // Per-attempt body normalization (provider-specific)
    upstreamBody.model = resolved.upstreamModel;
    normaliseForProvider(upstreamBody, binding.provider);

    const result = await forwardUpstream(
      resolved,
      upstreamBody,
      body.stream === true,
      request,
      env
    );

    if (result.kind === 'success') {
      recordStickySuccess(body.model, binding, allBindings);
      if (typeof context?.waitUntil === 'function') {
        context.waitUntil(recordSuccess(binding.provider, binding.keyLabel, kv));
      } else {
        await recordSuccess(binding.provider, binding.keyLabel, kv);
      }
      // Attach debug headers
      const headers = result.response.headers;
      headers.set('x-edgeone-relay', 'v8-1');
      headers.set('x-edgeone-routed-via', `${binding.provider}/${binding.keyLabel}`);
      headers.set('x-edgeone-route-trace', attemptLog.concat(`${binding.provider}/${binding.keyLabel}=ok`).join(','));
      headers.set('x-edgeone-relay-latency-ms', String(Date.now() - startMs));
      if (context.request?.eo?.clientIp) headers.set('x-edgeone-client-ip', context.request.eo.clientIp);
      return result.response;
    }

    // Failure path: record + cooldown + retry
    const cooldownSec = classifyFailure(result.status, result.kind);
    if (cooldownSec > 0) {
      await setCooldown(binding.provider, binding.keyLabel, cooldownSec, kv);
    }
    // For 5xx / empty-stream, also bump the failure counter (may trip breaker)
    if (result.kind === 'empty_stream' || result.kind === 'read_timeout' ||
        (result.status >= 500 && result.status < 600)) {
      await recordFailure(binding.provider, binding.keyLabel, kv);
    }
    attemptLog.push(
      `${binding.provider}/${binding.keyLabel}=${result.kind || `http_${result.status}`}`
    );

    // Non-retriable?  Stop the loop and return whatever upstream gave us.
    if (!shouldFailover(result.status, result.kind)) {
      const headers = result.response.headers;
      headers.set('x-edgeone-relay', 'v8-1');
      headers.set('x-edgeone-routed-via', `${binding.provider}/${binding.keyLabel}`);
      headers.set('x-edgeone-route-trace', attemptLog.join(','));
      headers.set('x-edgeone-relay-latency-ms', String(Date.now() - startMs));
      return result.response;
    }
    // Otherwise, continue to the next iteration.
  }

  // All retries exhausted — return the last seen error
  return new Response(
    JSON.stringify({
      error: {
        type: 'overloaded',
        message: `All ${tried.size} candidate keys were tried. Last failure: ${attemptLog[attemptLog.length - 1] || 'unknown'}.`,
        code: 'failover_exhausted',
        trace: attemptLog,
      },
    }),
    {
      status: 503,
      headers: {
        'content-type': 'application/json',
        'x-edgeone-relay': 'v8-1',
        'x-edgeone-route-trace': attemptLog.join(','),
        'x-edgeone-relay-latency-ms': String(Date.now() - startMs),
      },
    }
  );
}

// ------------------------------------------------------------------------
// Upstream forward + first-chunk peek
// ------------------------------------------------------------------------

async function forwardUpstream(resolved, body, isStream, request, env) {
  const url = buildChatUrl(resolved.baseUrl);
  const upstreamHeaders = {
    authorization: `Bearer ${resolved.apiKey}`,
    'content-type': 'application/json',
    accept: isStream ? 'text/event-stream' : 'application/json',
  };
  if (request.headers.get('x-request-id')) {
    upstreamHeaders['x-request-id'] = request.headers.get('x-request-id');
  }

  const upstreamTimeoutMs = Number(env?.UPSTREAM_TIMEOUT_MS || DEFAULT_UPSTREAM_TIMEOUT_MS);

  let upstreamResp;
  try {
    upstreamResp = await fetch(url, {
      method: 'POST',
      headers: upstreamHeaders,
      body: JSON.stringify(body),
      eo: {
        timeoutSetting: {
          connectTimeout: 10_000,
          readTimeout: upstreamTimeoutMs,
          writeTimeout: 15_000,
        },
      },
    });
  } catch (e) {
    // Network / timeout.  Read timeout is the most common case here.
    return { kind: 'read_timeout', status: 0, response: null };
  }

  // 2xx — process normally
  if (upstreamResp.status >= 200 && upstreamResp.status < 300) {
    if (isStream) {
      const peeked = await peekAndStream(upstreamResp);
      if (!peeked.ok) {
        // 200 + empty stream = provider glitch
        return { kind: 'empty_stream', status: 200, response: null };
      }
      return {
        kind: 'success',
        status: upstreamResp.status,
        response: new Response(peeked.stream, {
          status: upstreamResp.status,
          headers: buildOutHeaders(upstreamResp),
        }),
      };
    }
    // Non-streaming: pass through
    return {
      kind: 'success',
      status: upstreamResp.status,
      response: new Response(upstreamResp.body, {
        status: upstreamResp.status,
        headers: buildOutHeaders(upstreamResp),
      }),
    };
  }

  // Non-2xx: buffer the body so we can re-emit it as a Response
  let errBody = upstreamResp.body;
  return {
    kind: 'http',
    status: upstreamResp.status,
    response: new Response(errBody, {
      status: upstreamResp.status,
      headers: buildOutHeaders(upstreamResp),
    }),
  };
}

/**
 * Peek the first chunk of a streaming response, then build a new
 * ReadableStream that yields the cached first chunk followed by the rest.
 * Returns { ok: false } if the stream is empty (caller should fail over).
 */
async function peekAndStream(response) {
  if (!response.body) return { ok: false };
  const reader = response.body.getReader();
  let firstResult;
  try {
    firstResult = await reader.read();
  } catch (e) {
    return { ok: false };
  }
  if (firstResult.done || !firstResult.value || firstResult.value.length === 0) {
    try { await reader.cancel(); } catch {}
    return { ok: false };
  }
  const firstChunk = firstResult.value;
  let firstEmitted = false;
  const stream = new ReadableStream({
    async pull(controller) {
      if (!firstEmitted) {
        try { controller.enqueue(firstChunk); } catch { return; }
        firstEmitted = true;
        return;
      }
      try {
        const { value, done } = await reader.read();
        if (done) controller.close();
        else controller.enqueue(value);
      } catch (e) {
        try { controller.error(e); } catch {}
      }
    },
    async cancel(reason) {
      try { await reader.cancel(reason); } catch {}
    },
  });
  return { ok: true, stream };
}

function buildOutHeaders(upstreamResp) {
  const h = new Headers();
  const ct = upstreamResp.headers.get('content-type');
  if (ct) h.set('content-type', ct);
  h.set('cache-control', 'no-store');
  return h;
}

// ------------------------------------------------------------------------
// Helpers (auth, error responses)
// ------------------------------------------------------------------------

function checkAuth(request, env, config) {
  const need = env?.PROXY_API_KEY || config?.proxy_api_key;
  if (!need) return null;
  const rawAuth = request.headers.get('authorization') || request.headers.get('x-api-key') || '';
  const token = rawAuth.toLowerCase().startsWith('bearer ') ? rawAuth.slice(7).trim() : rawAuth.trim();
  if (token !== String(need).trim()) {
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

function errorResponse(status, type, message) {
  return new Response(
    JSON.stringify({ error: { type, message, code: type } }),
    { status, headers: { 'content-type': 'application/json' } }
  );
}

function tooLargeResponse(actualBytes) {
  const headers = { 'content-type': 'application/json' };
  const fallback = (typeof globalThis !== 'undefined' && globalThis?.EDGEONE_FALLBACK_URL) || '';
  if (fallback) headers['x-fallback-endpoint'] = fallback;
  return new Response(
    JSON.stringify({
      error: {
        type: 'invalid_request_error',
        message:
          `Request body is ${actualBytes} bytes, exceeding the Edge Function ` +
          `1 MB limit.  For longer contexts use the Cloud Function or VM endpoint ` +
          `documented in the deployment guide.`,
        code: 'body_too_large',
      },
    }),
    { status: 413, headers }
  );
}

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
  shouldFailover,
  bindingId,
} from '../../lib/cooldowns.js';

const MAX_BODY_BYTES = 1024 * 1024; // 1 MB Edge Function limit
const DEFAULT_UPSTREAM_TIMEOUT_MS = 25_000; // 25s upstream timeout to allow failover within EdgeOne 30s limit
const MAX_RETRIES = 3;

export async function onRequestPost(context) {
  try {
    const { request, env } = context;
    const startMs = Date.now();
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

  // ---- Load config & settings -------------------------------------------
  let config;
  try {
    config = await loadConfig(env, kv);
  } catch (e) {
    if (e instanceof ConfigError) {
      return errorResponse(500, 'config_error', e.message);
    }
    return errorResponse(500, 'config_error', `Config load failed: ${e?.message || e}`);
  }

  const settings = config.settings || {};
  const totalBudgetSec = Number(settings.request_total_budget_sec || 25);
  const upstreamTimeoutSec = Number(settings.upstream_timeout_sec || 15);
  const maxRetries = Number(settings.schedule_total_budget || 3);
  const maxAttemptsPerProv = Number(settings.max_attempts_per_provider || 2);
  const fastFailoverProvDown = settings.fast_failover_provider_down !== false;
  const strategy = settings.agent_routing_strategy || config.agent_routing_strategy || 'sticky_failover';
  const deadline = startMs + totalBudgetSec * 1000;

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

  // Check unique providers count among available bindings
  const uniqueProviders = new Set(allBindings.map((b) => b.provider));
  const hasMultipleProviders = uniqueProviders.size > 1;

  // ---- Stateless in-memory failover loop ----------------------------------
  const attemptLog = [];
  const tried = new Set();
  const providerAttempts = new Map(); // provider -> count
  const downProviders = new Set();    // providers that suffered 5xx/timeout in this request
  let lastStatus = 0;
  let lastErrorText = '';

  const candidatePool = orderBindings(allBindings, body.model, strategy);

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    // 1. Deadline check
    const now = Date.now();
    if (now >= deadline) {
      return new Response(
        JSON.stringify({
          error: {
            type: 'timeout_error',
            message: `Gateway timeout (${totalBudgetSec}s budget exceeded). Tried: ${attemptLog.join(' -> ')}. Upstream is currently overloaded.`,
            code: 'gateway_timeout',
            trace: attemptLog,
          },
        }),
        {
          status: 504,
          headers: {
            'content-type': 'application/json',
            'x-proxy-route': attemptLog.join('->'),
            'x-proxy-attempts': String(attemptLog.length),
            'x-proxy-latency-ms': String(now - startMs),
          },
        }
      );
    }

    // 2. Pick next candidate respecting provider quotas & fast-failover down list
    const binding = candidatePool.find((b) => {
      if (tried.has(bindingId(b))) return false;
      const provAttempts = providerAttempts.get(b.provider) || 0;
      if (provAttempts >= maxAttemptsPerProv) return false;
      if (downProviders.has(b.provider) && hasMultipleProviders) return false;
      return true;
    });

    if (!binding) break;
    tried.add(bindingId(binding));
    providerAttempts.set(binding.provider, (providerAttempts.get(binding.provider) || 0) + 1);

    let resolved;
    try {
      resolved = resolveBinding(config, binding);
    } catch (e) {
      attemptLog.push(`${binding.provider}/${binding.keyLabel}=config_drift`);
      continue;
    }

    // Per-attempt body normalization (provider-specific)
    const attemptBody = JSON.parse(JSON.stringify(body));
    attemptBody.model = resolved.upstreamModel;
    normaliseForProvider(attemptBody, binding.provider, resolved.providerConfig);

    // Calculate dynamic remaining timeout for this attempt
    const remainingMs = deadline - Date.now();
    const perAttemptTimeoutMs = Math.min(upstreamTimeoutSec * 1000, Math.max(3000, remainingMs));

    const result = await forwardUpstream(
      resolved,
      attemptBody,
      body.stream === true,
      request,
      env,
      perAttemptTimeoutMs
    );

    if (result.kind === 'success') {
      recordStickySuccess(body.model, binding, allBindings);

      // Attach debug headers
      const headers = result.response.headers;
      headers.set('x-edgeone-relay', 'v8-1');
      headers.set('x-proxy-routed-via', `${binding.provider}/${binding.keyLabel}`);
      headers.set('x-proxy-route', attemptLog.concat(`${binding.provider}/${binding.keyLabel}=ok`).join('->'));
      headers.set('x-proxy-attempts', String(attemptLog.length + 1));
      headers.set('x-proxy-latency-ms', String(Date.now() - startMs));
      if (context.request?.eo?.clientIp) headers.set('x-edgeone-client-ip', context.request.eo.clientIp);
      return result.response;
    }

    lastErrorText = result.errorText || '';
    lastStatus = result.status || 0;

    // For 5xx / timeout / empty stream, mark provider as down if fast-failover is on
    if (result.kind === 'empty_stream' || result.kind === 'read_timeout' ||
        (result.status >= 500 && result.status < 600)) {
      if (fastFailoverProvDown) {
        downProviders.add(binding.provider);
      }
    }

    attemptLog.push(
      `${binding.provider}/${binding.keyLabel}=${result.kind || `http_${result.status}`}`
    );

    // Non-retriable? (e.g. 400 bad request, or manual mode) Return immediately
    if (strategy === 'manual' || !shouldFailover(result.status, result.kind)) {
      if (result.response) {
        const headers = result.response.headers;
        headers.set('x-edgeone-relay', 'v8-1');
        headers.set('x-proxy-routed-via', `${binding.provider}/${binding.keyLabel}`);
        headers.set('x-proxy-route', attemptLog.join('->'));
        headers.set('x-proxy-attempts', String(attemptLog.length));
        headers.set('x-proxy-latency-ms', String(Date.now() - startMs));
        return result.response;
      }
    }
  }

  // All retries exhausted — preserve real upstream status code (e.g. 429, 401, 403, 502, 504)
  const lastDetail = lastErrorText ? `: ${lastErrorText.slice(0, 200)}` : '';
  const finalStatus = (lastStatus >= 400 && lastStatus < 600)
    ? lastStatus
    : (attemptLog.some((a) => a.includes('timeout') || a.includes('read_timeout')) ? 504 : 503);

  let userFriendlyMsg = `当前模型所有 ${tried.size} 个候选 Key 均已尝试但均失败 (${attemptLog.join(' -> ')})。`;
  if (finalStatus === 429) {
    userFriendlyMsg += ` 上游源站返回 429 频控/并发超限。服务暂不可用，建议切换备用模型。`;
  } else if (finalStatus === 403 || finalStatus === 401) {
    userFriendlyMsg += ` 上游源站返回 ${finalStatus} 鉴权或配额异常。建议检查配置或切换模型。`;
  } else if (finalStatus === 504) {
    userFriendlyMsg += ` 上游源站响应超时。服务暂不稳定，建议切换备用模型。`;
  } else {
    userFriendlyMsg += ` 上游源站返回 ${finalStatus} 异常，服务不稳定，建议切换模型。`;
  }
  if (lastDetail) {
    userFriendlyMsg += ` [详情${lastDetail}]`;
  }

  console.error(`[EdgeOne:FailoverExhausted] model=${body.model} final_status=${finalStatus} attempts=${attemptLog.join('->')} total_ms=${Date.now() - startMs}`);
  return new Response(
    JSON.stringify({
      error: {
        type: finalStatus === 429 ? 'rate_limit_error' : (finalStatus >= 500 ? 'upstream_error' : 'failover_exhausted'),
        message: userFriendlyMsg,
        code: finalStatus === 429 ? 'rate_limit_exceeded' : (finalStatus === 504 ? 'gateway_timeout' : 'failover_exhausted'),
        trace: attemptLog,
      },
    }),
    {
      status: finalStatus,
      headers: {
        'content-type': 'application/json',
        'x-edgeone-relay': 'v8-1',
        'x-proxy-route': attemptLog.join('->'),
        'x-proxy-attempts': String(attemptLog.length),
        'x-proxy-latency-ms': String(Date.now() - startMs),
        ...(finalStatus === 429 ? { 'retry-after': '5' } : {}),
      },
    }
  );
  } catch (err) {
    return new Response(
      JSON.stringify({
        error: {
          type: 'edge_internal_error',
          message: err?.message || String(err),
          code: 'edge_function_exception',
        },
      }),
      {
        status: 500,
        headers: {
          'content-type': 'application/json',
          'x-edgeone-relay': 'v8-1',
          'x-error-hint': 'caught_in_edge_function',
        },
      }
    );
  }
}

// ------------------------------------------------------------------------
// Upstream forward + first-chunk peek
// ------------------------------------------------------------------------

async function forwardUpstream(resolved, body, isStream, request, env, perAttemptTimeoutMs) {
  const url = buildChatUrl(resolved.baseUrl);
  const upstreamHeaders = {
    authorization: `Bearer ${resolved.apiKey}`,
    'content-type': 'application/json',
    accept: isStream ? 'text/event-stream' : 'application/json',
  };
  if (request.headers.get('x-request-id')) {
    upstreamHeaders['x-request-id'] = request.headers.get('x-request-id');
  }

  const timeoutMs = perAttemptTimeoutMs || Number(env?.UPSTREAM_TIMEOUT_MS || DEFAULT_UPSTREAM_TIMEOUT_MS);

  let upstreamResp;
  try {
    upstreamResp = await fetch(url, {
      method: 'POST',
      headers: upstreamHeaders,
      body: JSON.stringify(body),
      eo: {
        timeoutSetting: {
          connectTimeout: 8_000,
          readTimeout: timeoutMs,
          writeTimeout: 15_000,
        },
      },
    });
  } catch (e) {
    // Network / timeout. Read timeout is the most common case here.
    console.error(`[EdgeOne:NetworkError] fetch url=${url} failed: ${e?.message || e}`);
    return { kind: 'read_timeout', status: 0, errorText: e?.message || String(e), response: null };
  }

  // 2xx — process normally
  if (upstreamResp.status >= 200 && upstreamResp.status < 300) {
    if (isStream) {
      const peeked = await peekAndStream(upstreamResp);
      if (!peeked.ok) {
        // 200 + empty stream = provider glitch
        console.warn(`[EdgeOne:EmptyStream] url=${url} status=200 but stream was empty`);
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
    // Non-streaming: read buffer and normalize reasoning to reasoning_content if present
    const rawBytes = await upstreamResp.arrayBuffer();
    let finalBytes = rawBytes;
    try {
      const text = new TextDecoder().decode(rawBytes);
      if (text.includes('"reasoning":')) {
        const json = JSON.parse(text);
        if (Array.isArray(json?.choices)) {
          for (const c of json.choices) {
            if (c?.message?.reasoning && !c.message.reasoning_content) {
              c.message.reasoning_content = c.message.reasoning;
            }
          }
          finalBytes = new TextEncoder().encode(JSON.stringify(json));
        }
      }
    } catch {}

    return {
      kind: 'success',
      status: upstreamResp.status,
      response: new Response(finalBytes, {
        status: upstreamResp.status,
        headers: buildOutHeaders(upstreamResp),
      }),
    };
  }

  // Non-2xx: buffer the body so we can re-emit it as a Response and log it
  const errBytes = await upstreamResp.arrayBuffer().catch(() => null);
  const errText = errBytes ? new TextDecoder().decode(errBytes) : '';
  console.error(`[EdgeOne:UpstreamHTTPError] url=${url} status=${upstreamResp.status} body=${errText.slice(0, 300)}`);
  return {
    kind: 'http',
    status: upstreamResp.status,
    errorText: errText,
    response: new Response(errBytes, {
      status: upstreamResp.status,
      headers: buildOutHeaders(upstreamResp),
    }),
  };
}

/**
 * Peek the first chunk of a streaming response, then build a new
 * stream using TransformStream (as required by Tencent Cloud EdgeOne Doc 81914)
 * that yields the cached first chunk followed by the rest.
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

  const td = new TextDecoder();
  const te = new TextEncoder();
  const filterChunk = (chunk) => {
    if (!chunk) return chunk;
    const str = td.decode(chunk);
    if (str.includes('"reasoning":')) {
      return te.encode(str.replaceAll('"reasoning":', '"reasoning_content":'));
    }
    return chunk;
  };

  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  (async () => {
    try {
      await writer.write(filterChunk(firstChunk));
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        await writer.write(filterChunk(value));
      }
      await writer.close();
    } catch (e) {
      try { await writer.abort(e); } catch {}
    } finally {
      try { await reader.cancel(); } catch {}
    }
  })();

  return { ok: true, stream: readable };
}

function buildOutHeaders(upstreamResp) {
  const h = new Headers();
  const ct = upstreamResp.headers.get('content-type');
  if (ct) h.set('content-type', ct);
  h.set('cache-control', 'no-cache, no-store, no-transform, must-revalidate');
  h.set('x-accel-buffering', 'no');
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

export async function onRequest(context) {
  return onRequestPost(context);
}

export default onRequestPost;

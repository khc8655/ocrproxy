/**
 * v1/messages.js — POST /v1/messages (Anthropic Messages API Native Passthrough)
 *
 * Stateless failover over EdgeOne Edge Functions.
 *
 * Features:
 *   - Native Anthropic Messages passthrough (zero protocol translation overhead)
 *   - Automatic provider routing & Key failover
 *   - MiniMax-M3 & B.AI endpoint resolution (domestic endpoints supported)
 *   - Clean-up of Claude-specific fields (e.g. output_config) to avoid upstream 400s
 *   - Pure in-memory execution (0 KV I/O overhead on relay path)
 */

import {
  loadConfig,
  listBindings,
  orderBindings,
  recordStickySuccess,
  resolveBinding,
  buildMessagesUrl,
  ConfigError,
  resolveKvBinding,
} from '../lib/config.js';
import {
  shouldFailover,
  bindingId,
} from '../lib/cooldowns.js';

const MAX_BODY_BYTES = 1024 * 1024; // 1 MB Edge Function limit
const DEFAULT_UPSTREAM_TIMEOUT_MS = 25_000;

export async function onRequestPost(context) {
  try {
    const { request, env } = context;
    const startMs = Date.now();
    const kvRes = resolveKvBinding(context);
    const kv = kvRes?.kv;

    // ---- Auth --------------------------------------------------------------
    const authErr = checkAuth(request, env);
    if (authErr) return authErr;

    // ---- Pre-flight body size check ----------------------------------------
    const declaredLen = Number(request.headers.get('content-length') || 0);
    if (declaredLen > MAX_BODY_BYTES) {
      return anthropicError(413, 'invalid_request_error', `Request body too large: ${declaredLen} bytes (max ${MAX_BODY_BYTES})`);
    }

    // ---- Read body ---------------------------------------------------------
    let bodyText;
    try {
      bodyText = await request.text();
    } catch (e) {
      return anthropicError(400, 'invalid_request_error', `Failed to read body: ${e?.message || e}`);
    }
    if (bodyText.length > MAX_BODY_BYTES) {
      return anthropicError(413, 'invalid_request_error', `Request body too large: ${bodyText.length} bytes (max ${MAX_BODY_BYTES})`);
    }

    let body;
    try {
      body = JSON.parse(bodyText);
    } catch (e) {
      return anthropicError(400, 'invalid_request_error', `Body is not valid JSON: ${e?.message || e}`);
    }
    if (!body || typeof body !== 'object') {
      return anthropicError(400, 'invalid_request_error', 'Body must be a JSON object.');
    }
    if (typeof body.model !== 'string' || !body.model) {
      return anthropicError(400, 'invalid_request_error', 'Field "model" is required.');
    }

    // ---- Load config & settings -------------------------------------------
    let config;
    try {
      config = await loadConfig(env, kv);
    } catch (e) {
      if (e instanceof ConfigError) {
        return anthropicError(500, 'config_error', e.message);
      }
      return anthropicError(500, 'config_error', `Config load failed: ${e?.message || e}`);
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
    let allBindings = listBindings(config, body.model);
    // Case-insensitive lookup fallback if needed
    if (allBindings.length === 0 && config.agent_models) {
      const targetLower = body.model.toLowerCase();
      for (const [mName] of Object.entries(config.agent_models)) {
        if (mName.toLowerCase() === targetLower) {
          allBindings = listBindings(config, mName);
          break;
        }
      }
    }

    if (allBindings.length === 0) {
      return anthropicError(
        404,
        'not_found_error',
        `Model "${body.model}" is not configured on this relay. Call GET /v1/models to see available models.`
      );
    }

    const uniqueProviders = new Set(allBindings.map((b) => b.provider));
    const hasMultipleProviders = uniqueProviders.size > 1;

    // ---- Stateless in-memory failover loop ----------------------------------
    const attemptLog = [];
    const tried = new Set();
    const providerAttempts = new Map();
    const downProviders = new Set();
    let lastStatus = 0;
    let lastErrorText = '';

    const candidatePool = orderBindings(allBindings, body.model, strategy);
    const anthropicVersion = request.headers.get('anthropic-version') || '2023-06-01';

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      const now = Date.now();
      if (now >= deadline) {
        return new Response(
          JSON.stringify({
            type: 'error',
            error: {
              type: 'timeout_error',
              message: `Gateway timeout (${totalBudgetSec}s budget exceeded). Tried: ${attemptLog.join(' -> ')}.`,
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

      // Normalise request body for Messages API
      const attemptBody = JSON.parse(JSON.stringify(body));
      attemptBody.model = resolved.upstreamModel;
      normaliseMessagesForProvider(attemptBody, binding.provider);

      const provCfg = (config.providers || {})[binding.provider] || {};
      const targetUrl = buildMessagesUrl(resolved.baseUrl, provCfg.anthropic_base_url, binding.provider);

      const remainingMs = deadline - Date.now();
      const perAttemptTimeoutMs = Math.min(upstreamTimeoutSec * 1000, Math.max(3000, remainingMs));

      const result = await forwardMessagesUpstream(
        targetUrl,
        resolved.apiKey,
        anthropicVersion,
        attemptBody,
        body.stream === true,
        perAttemptTimeoutMs
      );

      if (result.kind === 'success') {
        recordStickySuccess(body.model, binding, allBindings);

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

      if (fastFailoverProvDown && (lastStatus >= 500 || result.kind === 'read_timeout' || result.kind === 'empty_stream')) {
        downProviders.add(binding.provider);
      }

      attemptLog.push(`${binding.provider}/${binding.keyLabel}=${lastStatus || result.kind}`);

      if (!shouldFailover(lastStatus, result.kind)) {
        return new Response(result.errorText || 'Upstream error', {
          status: lastStatus || 500,
          headers: {
            'content-type': 'application/json',
            'x-proxy-route': attemptLog.join('->'),
            'x-proxy-attempts': String(attemptLog.length),
            'x-proxy-latency-ms': String(Date.now() - startMs),
          },
        });
      }
    }

    // All retries failed
    return new Response(
      JSON.stringify({
        type: 'error',
        error: {
          type: 'api_error',
          message: `All candidates failed. Attempts: ${attemptLog.join(' -> ')}. Last error (${lastStatus}): ${lastErrorText.slice(0, 300)}`,
        },
      }),
      {
        status: lastStatus || 503,
        headers: {
          'content-type': 'application/json',
          'x-proxy-route': attemptLog.join('->'),
          'x-proxy-attempts': String(attemptLog.length),
          'x-proxy-latency-ms': String(Date.now() - startMs),
        },
      }
    );
  } catch (e) {
    return anthropicError(500, 'api_error', `Unhandled internal relay error: ${e?.message || e}`);
  }
}

function normaliseMessagesForProvider(out, provider) {
  const p = String(provider || '').toLowerCase().trim();
  if (p === 'minimax') {
    const m = String(out.model || '');
    if (m.toLowerCase() === 'minimax-m3') {
      out.model = 'MiniMax-M3';
    }
    delete out.output_config;
    if (out.thinking && typeof out.thinking === 'object') {
      if (out.thinking.budget_tokens && !out.thinking.type) {
        out.thinking.type = 'enabled';
      }
    }
  }
}

async function forwardMessagesUpstream(url, apiKey, anthropicVersion, body, isStream, timeoutMs) {
  const headers = {
    'content-type': 'application/json',
    'authorization': `Bearer ${apiKey}`,
    'x-api-key': apiKey,
    'anthropic-version': anthropicVersion,
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let resp;
  try {
    resp = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (e) {
    clearTimeout(timer);
    return {
      kind: e?.name === 'AbortError' ? 'read_timeout' : 'network_error',
      status: 0,
      errorText: `Fetch failed: ${e?.message || e}`,
    };
  }

  if (!resp.ok) {
    clearTimeout(timer);
    let errorText = '';
    try {
      errorText = await resp.text();
    } catch (_) {
      errorText = `Upstream returned status ${resp.status}`;
    }
    return { kind: 'http_error', status: resp.status, errorText };
  }

  if (!isStream) {
    clearTimeout(timer);
    return { kind: 'success', response: resp };
  }

  // Stream peek check
  const bodyStream = resp.body;
  if (!bodyStream) {
    clearTimeout(timer);
    return { kind: 'empty_stream', status: resp.status, errorText: 'Response has no body' };
  }

  const reader = bodyStream.getReader();
  let firstChunk;
  try {
    firstChunk = await reader.read();
  } catch (e) {
    clearTimeout(timer);
    return {
      kind: e?.name === 'AbortError' ? 'read_timeout' : 'network_error',
      status: resp.status,
      errorText: `Failed to read first chunk: ${e?.message || e}`,
    };
  }

  if (firstChunk.done) {
    clearTimeout(timer);
    return { kind: 'empty_stream', status: resp.status, errorText: 'Stream closed without any data' };
  }

  clearTimeout(timer);

  const combinedStream = new ReadableStream({
    start(ctrl) {
      ctrl.enqueue(firstChunk.value);
    },
    async pull(ctrl) {
      try {
        const { value, done } = await reader.read();
        if (done) {
          ctrl.close();
        } else {
          ctrl.enqueue(value);
        }
      } catch (e) {
        ctrl.error(e);
      }
    },
    cancel() {
      reader.cancel().catch(() => {});
    },
  });

  const responseHeaders = new Headers(resp.headers);
  responseHeaders.set('content-type', 'text/event-stream');
  responseHeaders.set('cache-control', 'no-cache');
  responseHeaders.set('x-accel-buffering', 'no');

  return {
    kind: 'success',
    response: new Response(combinedStream, {
      status: resp.status,
      statusText: resp.statusText,
      headers: responseHeaders,
    }),
  };
}

function checkAuth(request, env, config) {
  const need = env?.PROXY_API_KEY || config?.proxy_api_key;
  if (!need) return null;
  const rawAuth = request.headers.get('authorization') || request.headers.get('x-api-key') || '';
  const token = rawAuth.toLowerCase().startsWith('bearer ') ? rawAuth.slice(7).trim() : rawAuth.trim();
  if (token !== String(need).trim()) {
    return anthropicError(401, 'authentication_error', 'Missing or invalid Authorization header.');
  }
  return null;
}

function anthropicError(status, type, message) {
  return new Response(
    JSON.stringify({
      type: 'error',
      error: {
        type,
        message,
      },
    }),
    {
      status,
      headers: { 'content-type': 'application/json' },
    }
  );
}

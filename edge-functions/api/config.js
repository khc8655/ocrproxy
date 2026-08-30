/**
 * api/config.js — Config read/write and key/model probing API for the admin UI.
 *
 *   GET  /api/config              — read current config
 *   GET  /api/config?action=test   — probe a single (provider, key, model) upstream
 *   POST /api/config              — validate + write full config to KV key "config"
 *   PUT  /api/config              — same as POST
 *   DELETE /api/config            — reset config to empty
 */

import {
  loadConfig,
  validateConfig,
  ConfigError,
  sanitizeJsonString,
  resolveKvBinding,
  kvNotBoundResponse,
} from '../lib/config.js';
import { normaliseForProvider } from '../lib/normalize.js';

const CONFIG_KV_KEY = 'config';
const CONFIG_KV_TTL_SEC = 60 * 60 * 24 * 30; // 30 days

function checkAuth(request, env) {
  const need = env?.PROXY_API_KEY;
  if (!need) return null;
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

async function probeKey(providerName, keyLabel, apiKey, baseUrl, targetModel = '') {
  const start = Date.now();
  let resp = null;
  let lastErr = null;

  // 1. If targetModel is specified, probe chat completions directly for true model latency
  if (targetModel) {
    const chatUrl = baseUrl.endsWith('/v1') ? `${baseUrl}/chat/completions` : `${baseUrl}/v1/chat/completions`;
    let probeBody = {
      model: targetModel,
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 16,
      reasoning_effort: 'none',
    };
    try {
      probeBody = normaliseForProvider(probeBody, providerName);
    } catch (_) {}

    try {
      resp = await fetch(chatUrl, {
        method: 'POST',
        headers: {
          'authorization': `Bearer ${apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(probeBody),
        eo: {
          timeoutSetting: {
            connectTimeout: 8_000,
            readTimeout: 25_000,
            writeTimeout: 4_000,
          },
        },
      });
    } catch (e) {
      lastErr = e;
    }
  }

  // 2. Fallback to /models probe if targetModel was not provided or failed with network error
  if (!resp) {
    const urlsToTry = [];
    if (baseUrl.endsWith('/v1')) {
      urlsToTry.push(`${baseUrl}/models`);
    } else {
      urlsToTry.push(`${baseUrl}/v1/models`);
      urlsToTry.push(`${baseUrl}/models`);
    }

    for (const url of urlsToTry) {
      try {
        resp = await fetch(url, {
          method: 'GET',
          headers: {
            'authorization': `Bearer ${apiKey}`,
            'accept': 'application/json',
          },
          eo: {
            timeoutSetting: {
              connectTimeout: 8_000,
              readTimeout: 12_000,
              writeTimeout: 4_000,
            },
          },
        });
        if (resp && resp.status !== 404) {
          break;
        }
      } catch (e) {
        lastErr = e;
      }
    }
  }

  const latency = Date.now() - start;

  if (!resp) {
    return {
      ok: false,
      upstream: baseUrl,
      model: targetModel || null,
      status: 0,
      latency_ms: latency,
      error: `network_error: ${lastErr?.message || lastErr || 'timeout'}`,
    };
  }

  let ok = false;
  let verdict = '';
  if (resp.status >= 200 && resp.status < 300) {
    ok = true;
    verdict = targetModel ? `model ${targetModel} ok` : 'reachable + key accepted';
  } else if (resp.status === 401 || resp.status === 403) {
    ok = false;
    verdict = 'key rejected (401/403)';
  } else if (resp.status === 429) {
    ok = false;
    verdict = 'rate-limited (429)';
  } else if (resp.status === 404) {
    ok = targetModel ? false : true;
    verdict = targetModel ? `model ${targetModel} not found (404)` : 'reachable, but /models not exposed (chat works)';
  } else {
    // 400 with model thinking message could still mean model exists and key is good
    ok = resp.status === 400;
    verdict = `status ${resp.status}`;
  }

  return {
    ok,
    verdict,
    upstream: baseUrl,
    model: targetModel || null,
    status: resp.status,
    latency_ms: latency,
  };
}

export async function onRequestGet(context) {
  const authErr = checkAuth(context.request, context.env);
  if (authErr) return authErr;

  const kvRes = resolveKvBinding(context);
  const kv = kvRes?.kv;

  let source = 'env';
  let lastModified = null;
  let config = null;

  if (kv) {
    try {
      const raw = await kv.get(CONFIG_KV_KEY, { type: 'text' });
      if (raw) {
        const parsed = JSON.parse(sanitizeJsonString(raw));
        source = 'kv';
        config = parsed.config || parsed;
        lastModified = parsed.last_modified || null;
      }
    } catch (e) {
      return new Response(
        JSON.stringify({
          error: { type: 'config_error', message: `KV read failed: ${e?.message || e}` },
        }),
        { status: 500, headers: { 'content-type': 'application/json' } }
      );
    }
  }

  if (!config) {
    const rawEnv = context.env?.AGENT_CONFIG_JSON || context.env?.AGENT_CONFIG;
    if (rawEnv && typeof rawEnv === 'string' && rawEnv.trim()) {
      try {
        const parsed = JSON.parse(sanitizeJsonString(rawEnv));
        source = 'env';
        config = parsed.config || parsed;
      } catch (e) {
        console.warn('env config parse failed:', e?.message || e);
      }
    }
  }

  if (!config) {
    config = { providers: {}, agent_models: {} };
  }

  // Check if this is a test probe action in GET
  const reqUrl = String(context.request?.url || '');
  const url = new URL(reqUrl, 'http://localhost');
  const action = url.searchParams.get('action');
  if (action === 'test') {
    const providerName = String(url.searchParams.get('provider') || '').trim();
    const keyLabel = String(url.searchParams.get('key') || '').trim();
    const targetModel = String(url.searchParams.get('model') || '').trim();
    if (!providerName || !keyLabel) {
      return new Response(
        JSON.stringify({ error: { type: 'invalid_request_error', message: 'provider and key are required' } }),
        { status: 400, headers: { 'content-type': 'application/json' } }
      );
    }
    const provider = config.providers?.[providerName];
    if (!provider) {
      return new Response(
        JSON.stringify({ error: { type: 'not_found', message: `Provider "${providerName}" not found` } }),
        { status: 404, headers: { 'content-type': 'application/json' } }
      );
    }
    const apiKey = provider.keys?.[keyLabel];
    if (!apiKey) {
      return new Response(
        JSON.stringify({ error: { type: 'not_found', message: `Key "${keyLabel}" not found` } }),
        { status: 404, headers: { 'content-type': 'application/json' } }
      );
    }
    const baseUrl = (provider.base_url || '').replace(/\/+$/, '');
    const result = await probeKey(providerName, keyLabel, apiKey, baseUrl, targetModel);
    return new Response(JSON.stringify(result), {
      status: 200,
      headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
    });
  }

  return new Response(
    JSON.stringify({
      source,
      last_modified: lastModified,
      kv_binding: kvRes?.name || null,
      config,
    }),
    {
      status: 200,
      headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
    }
  );
}

export async function onRequestPut(context) {
  const authErr = checkAuth(context.request, context.env);
  if (authErr) return authErr;

  const kvRes = resolveKvBinding(context);
  if (!kvRes) {
    return kvNotBoundResponse(context);
  }
  const kv = kvRes.kv;

  let bodyText;
  try {
    bodyText = await context.request.text();
  } catch (e) {
    return new Response(
      JSON.stringify({ error: { type: 'invalid_request_error', message: `Body read: ${e?.message || e}` } }),
      { status: 400, headers: { 'content-type': 'application/json' } }
    );
  }
  if (bodyText.length > 1024 * 1024) {
    return new Response(
      JSON.stringify({ error: { type: 'invalid_request_error', message: 'Body too large (1 MB cap).' } }),
      { status: 413, headers: { 'content-type': 'application/json' } }
    );
  }

  let body;
  try {
    body = JSON.parse(sanitizeJsonString(bodyText));
  } catch (e) {
    return new Response(
      JSON.stringify({ error: { type: 'invalid_request_error', message: `Invalid JSON: ${e?.message || e}` } }),
      { status: 400, headers: { 'content-type': 'application/json' } }
    );
  }

  // Handle action=test in POST/PUT body
  if (body?.action === 'test') {
    const providerName = String(body.provider || '').trim();
    const keyLabel = String(body.key || '').trim();
    const targetModel = String(body.model || '').trim();
    let curConfig;
    try {
      curConfig = await loadConfig(context.env, kv);
    } catch (e) {
      return new Response(JSON.stringify({ error: { type: 'config_error', message: e?.message || e } }), { status: 500 });
    }
    const provider = curConfig.providers?.[providerName];
    if (!provider) {
      return new Response(JSON.stringify({ error: { type: 'not_found', message: `Provider "${providerName}" not found` } }), { status: 404 });
    }
    const apiKey = provider.keys?.[keyLabel];
    if (!apiKey) {
      return new Response(JSON.stringify({ error: { type: 'not_found', message: `Key "${keyLabel}" not found` } }), { status: 404 });
    }
    const baseUrl = (provider.base_url || '').replace(/\/+$/, '');
    const result = await probeKey(providerName, keyLabel, apiKey, baseUrl, targetModel);
    return new Response(JSON.stringify(result), {
      status: 200,
      headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
    });
  }

  const incoming = body?.config || body;
  const validationErr = validateConfig(incoming);
  if (validationErr) {
    return new Response(
      JSON.stringify({ error: { type: 'invalid_config', message: validationErr } }),
      { status: 400, headers: { 'content-type': 'application/json' } }
    );
  }

  const wrapped = {
    source: 'kv',
    last_modified: new Date().toISOString(),
    config: incoming,
  };

  try {
    await kv.put(CONFIG_KV_KEY, JSON.stringify(wrapped));
  } catch (e) {
    return new Response(
      JSON.stringify({ error: { type: 'kv_error', message: `KV write failed: ${e?.message || e}` } }),
      { status: 500, headers: { 'content-type': 'application/json' } }
    );
  }

  return new Response(
    JSON.stringify({
      ok: true,
      last_modified: wrapped.last_modified,
      source: 'kv',
      propagation_hint: 'New config propagates to all edge nodes within ~60 s.',
      config: incoming,
    }),
    { status: 200, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } }
  );
}

export async function onRequestPost(context) {
  return onRequestPut(context);
}

export async function onRequestDelete(context) {
  const authErr = checkAuth(context.request, context.env);
  if (authErr) return authErr;

  const kvRes = resolveKvBinding(context);
  if (!kvRes) {
    return kvNotBoundResponse(context);
  }
  const kv = kvRes.kv;

  try {
    await kv.delete(CONFIG_KV_KEY);
  } catch (e) {
    return new Response(
      JSON.stringify({ error: { type: 'kv_error', message: `KV delete failed: ${e?.message || e}` } }),
      { status: 500, headers: { 'content-type': 'application/json' } }
    );
  }

  return new Response(
    JSON.stringify({
      ok: true,
      message: 'Config reset to empty. Fallback to env on next read.',
    }),
    { status: 200, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } }
  );
}

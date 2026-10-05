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
  saveConfig,
  validateConfig,
  invalidateConfigCache,
  ConfigError,
  sanitizeJsonString,
  resolveKvBinding,
  kvNotBoundResponse,
  CONFIG_KV_KEY,
  CONFIG_KV_TTL_SEC,
} from '../lib/config.js';
import { normaliseForProvider } from '../lib/normalize.js';


function checkAuth(request, env) {
  const adminPass = env?.ADMIN_PASSWORD;
  if (!adminPass) {
    return new Response(
      JSON.stringify({
        error: {
          type: 'configuration_error',
          message: 'Server misconfiguration: ADMIN_PASSWORD is not configured in EdgeOne environment variables. Admin config endpoints are blocked in fail-closed mode.',
          code: 'admin_unconfigured',
        },
      }),
      { status: 503, headers: { 'content-type': 'application/json' } }
    );
  }

  const rawAuth = request.headers.get('authorization') || request.headers.get('x-api-key') || '';
  const token = rawAuth.toLowerCase().startsWith('bearer ') ? rawAuth.slice(7).trim() : rawAuth.trim();

  // If caller sent standard inference token PROXY_API_KEY, explicitly reject with 403 Forbidden
  const proxyKey = env?.PROXY_API_KEY;
  if (proxyKey && token === String(proxyKey).trim() && token !== String(adminPass).trim()) {
    return new Response(
      JSON.stringify({
        error: {
          type: 'forbidden_error',
          message: 'Forbidden: Inference token PROXY_API_KEY cannot modify or read administrator configuration. ADMIN_PASSWORD is required.',
          code: 'admin_required',
        },
      }),
      { status: 403, headers: { 'content-type': 'application/json' } }
    );
  }

  if (token !== String(adminPass).trim()) {
    return new Response(
      JSON.stringify({
        error: {
          type: 'authentication_error',
          message: 'Missing or invalid Authorization header.',
          code: 'invalid_admin_password',
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
      if (raw && typeof raw === 'string' && raw.trim()) {
        try {
          const parsed = JSON.parse(sanitizeJsonString(raw));
          if (parsed && typeof parsed === 'object') {
            source = 'kv';
            config = parsed.config || parsed;
            lastModified = parsed.last_modified || null;
          } else {
            console.warn('KV raw config parsed to non-object, fallback to env');
          }
        } catch (parseErr) {
          console.warn('KV JSON parse failed, fallback to env:', parseErr?.message || parseErr);
        }
      }
    } catch (e) {
      console.warn('KV read failed, fallback to env:', e?.message || e);
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
    const apiKeyRaw = provider.keys?.[keyLabel];
    if (!apiKeyRaw) {
      return new Response(
        JSON.stringify({ error: { type: 'not_found', message: `Key "${keyLabel}" not found` } }),
        { status: 404, headers: { 'content-type': 'application/json' } }
      );
    }
    const apiKey = (typeof apiKeyRaw === 'object' && apiKeyRaw !== null) ? (apiKeyRaw.key || '') : String(apiKeyRaw);
    const rawBaseUrl = (typeof apiKeyRaw === 'object' && apiKeyRaw !== null && apiKeyRaw.base_url)
      ? apiKeyRaw.base_url
      : (provider.base_url || '');
    const baseUrl = rawBaseUrl.replace(/\/+$/, '');
    const result = await probeKey(providerName, keyLabel, apiKey, baseUrl, targetModel);
    return new Response(JSON.stringify(result), {
      status: 200,
      headers: { 'content-type': 'application/json', 'cache-control': 'no-store, no-cache, must-revalidate' },
    });
  }

  return new Response(
    JSON.stringify({
      source,
      last_modified: lastModified,
      kv_binding: kvRes?.name || null,
      _version: config._version || 0,
      config,
    }),
    {
      status: 200,
      headers: { 'content-type': 'application/json', 'cache-control': 'no-store, no-cache, must-revalidate' },
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
    const apiKeyRaw = provider.keys?.[keyLabel];
    if (!apiKeyRaw) {
      return new Response(JSON.stringify({ error: { type: 'not_found', message: `Key "${keyLabel}" not found` } }), { status: 404 });
    }
    const apiKey = (typeof apiKeyRaw === 'object' && apiKeyRaw !== null) ? (apiKeyRaw.key || '') : String(apiKeyRaw);
    const rawBaseUrl = (typeof apiKeyRaw === 'object' && apiKeyRaw !== null && apiKeyRaw.base_url)
      ? apiKeyRaw.base_url
      : (provider.base_url || '');
    const baseUrl = rawBaseUrl.replace(/\/+$/, '');
    const result = await probeKey(providerName, keyLabel, apiKey, baseUrl, targetModel);
    return new Response(JSON.stringify(result), {
      status: 200,
      headers: { 'content-type': 'application/json', 'cache-control': 'no-store, no-cache, must-revalidate' },
    });
  }

  const incoming = body?.config || body;
  let wrapped;
  try {
    wrapped = await saveConfig(incoming, kv);
  } catch (e) {
    if (e.status === 409) {
      return new Response(
        JSON.stringify({ error: { type: 'conflict', message: e.message }, _version: e.curVersion }),
        { status: 409, headers: { 'content-type': 'application/json' } }
      );
    }
    if (e instanceof ConfigError) {
      return new Response(
        JSON.stringify({ error: { type: 'invalid_config', message: e.message } }),
        { status: 400, headers: { 'content-type': 'application/json' } }
      );
    }
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
      _version: wrapped._version,
      propagation_hint: 'New config propagates to all edge nodes within ~5 s.',
      config: incoming,
    }),
    { status: 200, headers: { 'content-type': 'application/json', 'cache-control': 'no-store, no-cache, must-revalidate' } }
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
    invalidateConfigCache();
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
    { status: 200, headers: { 'content-type': 'application/json', 'cache-control': 'no-store, no-cache, must-revalidate' } }
  );
}

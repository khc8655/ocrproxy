/**
 * api/test.js — Test a single (provider, key) against its
 * upstream by probing /v1/models or /models.
 *
 *   POST /api/test
 *   Body: { provider: "name", key: "label" }
 *   Returns: { ok, upstream, status, latency_ms, body_preview }
 */

import { loadConfig, ConfigError, resolveKvBinding } from '../lib/config.js';

function checkAuth(request, env) {
  const need = env?.PROXY_API_KEY;
  if (!need) return null;
  const got = request.headers.get('authorization') || '';
  if (got !== `Bearer ${need}`) {
    return new Response(
      JSON.stringify({ error: { type: 'authentication_error', message: 'Missing or invalid Authorization header.', code: 'invalid_api_key' } }),
      { status: 401, headers: { 'content-type': 'application/json', 'www-authenticate': 'Bearer' } }
    );
  }
  return null;
}

export async function onRequestPost(context) {
  const authErr = checkAuth(context.request, context.env);
  if (authErr) return authErr;

  let bodyText;
  try {
    bodyText = await context.request.text();
  } catch (e) {
    return new Response(
      JSON.stringify({ error: { type: 'invalid_request_error', message: `Body read: ${e?.message || e}` } }),
      { status: 400, headers: { 'content-type': 'application/json' } }
    );
  }

  let body;
  try { body = JSON.parse(bodyText); }
  catch (e) {
    return new Response(
      JSON.stringify({ error: { type: 'invalid_request_error', message: `Invalid JSON: ${e?.message || e}` } }),
      { status: 400, headers: { 'content-type': 'application/json' } }
    );
  }
  const modelName = String(body?.model || body?.name || '').trim();
  const providerName = String(body?.provider || '').trim();
  const keyLabel = String(body?.key || '').trim();

  if (!modelName && (!providerName || !keyLabel)) {
    return new Response(
      JSON.stringify({ error: { type: 'invalid_request_error', message: 'Provide either "model" or both "provider" and "key".' } }),
      { status: 400, headers: { 'content-type': 'application/json' } }
    );
  }

  let config;
  try {
    const kvRes = resolveKvBinding(context);
    config = await loadConfig(context.env, kvRes?.kv);
  } catch (e) {
    if (e instanceof ConfigError) {
      return new Response(
        JSON.stringify({ error: { type: 'config_error', message: e.message } }),
        { status: 500, headers: { 'content-type': 'application/json' } }
      );
    }
    throw e;
  }

  // --- Path A: Model-level parallel probe (matches VM's /api/admin/test-agent-model) ---
  if (modelName) {
    const entry = config.agent_models?.[modelName];
    if (!entry) {
      return new Response(
        JSON.stringify({ error: { type: 'not_found', message: `Model "${modelName}" not found in config.` } }),
        { status: 404, headers: { 'content-type': 'application/json' } }
      );
    }
    const bindings = entry.keys || [];
    const providers = config.providers || {};

    const probeBinding = async (b) => {
      const p = providers[b.provider];
      if (!p) {
        return { provider: b.provider, key: b.key, ok: false, status: null, latency_ms: null, error: 'Provider not found' };
      }
      const apiKey = p.keys?.[b.key];
      if (!apiKey) {
        return { provider: b.provider, key: b.key, ok: false, status: null, latency_ms: null, error: 'Key not found' };
      }
      const baseUrl = (p.base_url || '').replace(/\/+$/, '');
      const url = baseUrl.endsWith('/v1') ? `${baseUrl}/chat/completions` : `${baseUrl}/v1/chat/completions`;
      const upstreamModel = b.upstream_model || entry.upstream_model || modelName;

      const start = Date.now();
      try {
        const resp = await fetch(url, {
          method: 'POST',
          headers: {
            'authorization': `Bearer ${apiKey}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            model: upstreamModel,
            messages: [{ role: 'user', content: 'Hi' }],
            max_tokens: 16,
            stream: false,
          }),
          eo: {
            timeoutSetting: {
              connectTimeout: 5_000,
              readTimeout: 15_000,
              writeTimeout: 5_000,
            },
          },
        });
        const lat = Date.now() - start;
        const ok = resp.status >= 200 && resp.status < 300;
        let errText = null;
        if (!ok) {
          try {
            errText = (await resp.text()).slice(0, 200);
          } catch {}
        }
        return {
          provider: b.provider,
          key: b.key,
          ok,
          status: resp.status,
          latency_ms: lat,
          error: ok ? null : (errText || `HTTP ${resp.status}`),
        };
      } catch (e) {
        return {
          provider: b.provider,
          key: b.key,
          ok: false,
          status: null,
          latency_ms: Date.now() - start,
          error: e?.message || String(e),
        };
      }
    };

    const results = await Promise.all(bindings.map(probeBinding));
    const okCount = results.filter((r) => r.ok).length;

    return new Response(
      JSON.stringify({
        success: okCount > 0,
        model: modelName,
        total: results.length,
        ok: okCount,
        results,
        checked_at: new Date().toISOString(),
      }),
      { status: 200, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } }
    );
  }

  // --- Path B: Single (provider, key) endpoint probe ---
  const provider = config.providers?.[providerName];
  if (!provider) {
    return new Response(
      JSON.stringify({ error: { type: 'not_found', message: `Provider "${providerName}" not in config.` } }),
      { status: 404, headers: { 'content-type': 'application/json' } }
    );
  }
  const apiKey = provider.keys?.[keyLabel];
  if (!apiKey) {
    return new Response(
      JSON.stringify({ error: { type: 'not_found', message: `Key "${keyLabel}" not in provider "${providerName}".` } }),
      { status: 404, headers: { 'content-type': 'application/json' } }
    );
  }

  const baseUrl = (provider.base_url || '').replace(/\/+$/, '');
  if (!baseUrl) {
    return new Response(
      JSON.stringify({ error: { type: 'config_error', message: `Provider "${providerName}" has no base_url.` } }),
      { status: 500, headers: { 'content-type': 'application/json' } }
    );
  }

  // Probe upstream models endpoint
  const urlsToTry = [];
  if (baseUrl.endsWith('/v1')) {
    urlsToTry.push(`${baseUrl}/models`);
  } else {
    urlsToTry.push(`${baseUrl}/v1/models`);
    urlsToTry.push(`${baseUrl}/models`);
  }

  const start = Date.now();
  let resp = null;
  let finalUrl = urlsToTry[0];
  let lastErr = null;

  for (const url of urlsToTry) {
    finalUrl = url;
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
        break; // found live endpoint
      }
    } catch (e) {
      lastErr = e;
    }
  }

  const latency = Date.now() - start;

  if (!resp) {
    return new Response(
      JSON.stringify({
        ok: false,
        upstream: baseUrl,
        status: 0,
        latency_ms: latency,
        error: `network_error: ${lastErr?.message || lastErr || 'timeout'}`,
      }),
      { status: 200, headers: { 'content-type': 'application/json' } }
    );
  }

  let respText = '';
  try {
    respText = (await resp.text()).slice(0, 500);
  } catch {}

  let ok = false;
  let verdict = '';
  if (resp.status >= 200 && resp.status < 300) {
    ok = true;
    verdict = 'reachable + key accepted';
  } else if (resp.status === 401 || resp.status === 403) {
    ok = false;
    verdict = 'key rejected (401/403)';
  } else if (resp.status === 429) {
    ok = false;
    verdict = 'rate-limited (429)';
  } else if (resp.status === 404) {
    ok = true; // endpoint reached but /models not implemented
    verdict = 'reachable, but /models not exposed (chat works)';
  } else {
    ok = false;
    verdict = `status ${resp.status}`;
  }

  return new Response(
    JSON.stringify({
      ok,
      verdict,
      upstream: baseUrl,
      status: resp.status,
      latency_ms: latency,
      body_preview: respText,
    }),
    { status: 200, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } }
  );
}

export async function onRequestGet(context) {
  return new Response(JSON.stringify({ message: 'POST /api/test with {provider, key} to probe.' }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

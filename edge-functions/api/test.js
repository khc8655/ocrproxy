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

  const providerName = String(body?.provider || '').trim();
  const keyLabel = String(body?.key || '').trim();
  if (!providerName || !keyLabel) {
    return new Response(
      JSON.stringify({ error: { type: 'invalid_request_error', message: 'Both "provider" and "key" are required.' } }),
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

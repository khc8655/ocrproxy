/**
 * api/test-connection.js — Test a single (provider, key) against its
 * upstream by calling the upstream's /v1/models endpoint.
 *
 *   POST /api/test
 *   Body: { provider: "name", key: "label" }  (label is the key label in the config)
 *   Returns: { ok, upstream, status, latency_ms, body_preview }
 *
 * Used by the admin UI's "Test" button so the operator can verify a
 * freshly pasted key works before saving the whole config.
 *
 * No state side-effects — does NOT touch KV or cooldowns.
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

  // Read body
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

  // Load current config
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

  // Hit the upstream's /v1/models.  Some providers (DingTalk, custom)
  // might not support this exact path — they may return 404 and still
  // work for chat.  We treat 2xx AND 404 as "endpoint reachable" and
  // 401/403/429 as "endpoint reachable but key rejected".
  const url = `${baseUrl}/models`;
  const start = Date.now();
  let resp;
  try {
    resp = await fetch(url, {
      method: 'GET',
      headers: {
        'authorization': `Bearer ${apiKey}`,
        'accept': 'application/json',
      },
      eo: {
        timeoutSetting: {
          connectTimeout: 10_000,
          readTimeout: 15_000,
          writeTimeout: 5_000,
        },
      },
    });
  } catch (e) {
    return new Response(
      JSON.stringify({
        ok: false,
        upstream: baseUrl,
        status: 0,
        latency_ms: Date.now() - start,
        error: `network_error: ${e?.message || e}`,
      }),
      { status: 200, headers: { 'content-type': 'application/json' } }
    );
  }

  const latency = Date.now() - start;
  const respText = (await resp.text()).slice(0, 500);
  // Parse body if JSON
  let bodyJson = null;
  let bodyString = respText;
  try {
    bodyJson = JSON.parse(respText);
    bodyString = JSON.stringify(bodyJson).slice(0, 500);
  } catch {}

  // Verdict
  let ok = false;
  let verdict = '';
  if (resp.status >= 200 && resp.status < 300) {
    ok = true; verdict = 'reachable + key accepted';
  } else if (resp.status === 401 || resp.status === 403) {
    ok = false; verdict = 'key rejected';
  } else if (resp.status === 404) {
    // Some providers don't expose /v1/models but still work for chat
    ok = true; verdict = 'reachable, but /v1/models not exposed (likely still works for chat)';
  } else if (resp.status === 429) {
    ok = false; verdict = 'rate-limited on test call (try again later)';
  } else {
    ok = false; verdict = `unexpected status ${resp.status}`;
  }

  return new Response(
    JSON.stringify({
      ok,
      verdict,
      upstream: baseUrl,
      status: resp.status,
      latency_ms: latency,
      body_preview: bodyString,
    }),
    { status: 200, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } }
  );
}

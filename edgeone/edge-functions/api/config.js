/**
 * api/config.js — Config read/write API for the admin UI.
 *
 *   GET  /api/config    — read current config (KV > env fallback), plus
 *                          source indicator and last-modified timestamp
 *   POST /api/config    — validate + write full config to KV key "config"
 *
 * Writes go ONLY to KV (not env).  After a POST, every edge node will
 * pick up the new config within ~60s (KV eventual consistency).  The
 * writer's own node sees it immediately because of write-after-read
 * consistency on the same KV instance.
 *
 * Auth: same PROXY_API_KEY as the rest of the API.  In a production
 * hardening pass you'd want a separate ADMIN_PASSWORD; for now we
 * reuse the relay token since this is a personal-scale project.
 */

import {
  loadConfig,
  validateConfig,
  ConfigError,
  sanitizeJsonString,
  resolveKvBinding,
  kvNotBoundResponse,
} from '../lib/config.js';

const CONFIG_KV_KEY = 'config';
const CONFIG_KV_TTL_SEC = 60 * 60 * 24 * 30; // 30 days — admin writes are explicit

function checkAuth(request, env) {
  const need = env?.PROXY_API_KEY;
  if (!need) return null; // no auth configured — allow
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

export async function onRequestGet(context) {
  const authErr = checkAuth(context.request, context.env);
  if (authErr) return authErr;

  // Resolve KV binding by trying common variable names
  const kvRes = resolveKvBinding(context);
  const kv = kvRes?.kv;

  // Detect source: KV > env.  We probe KV by listing known config keys
  // (cheap; just one key + last_modified).  If KV is not bound we
  // fall back to env.
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
      // KV read failure — fall back to env, but report the error.
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
    source = 'empty';
    config = { providers: {}, agent_models: {} };
  }

  return new Response(
    JSON.stringify({
      source,
      last_modified: lastModified,
      kv_binding: kvRes?.name || null,
      config,
    }),
    { status: 200, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } }
  );
}

export async function onRequestPost(context) {
  const authErr = checkAuth(context.request, context.env);
  if (authErr) return authErr;

  const kvRes = resolveKvBinding(context);
  if (!kvRes) {
    return kvNotBoundResponse(context);
  }
  const kv = kvRes.kv;

  // Body
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

  // Accept either { providers, agent_models } or a full config
  const incoming = body?.config || body;
  const validationErr = validateConfig(incoming);
  if (validationErr) {
    return new Response(
      JSON.stringify({ error: { type: 'invalid_config', message: validationErr } }),
      { status: 400, headers: { 'content-type': 'application/json' } }
    );
  }

  try {
    await kv.put(CONFIG_KV_KEY, JSON.stringify(incoming));
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

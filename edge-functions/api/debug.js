/**
 * api/debug.js — diagnostic endpoint for KV binding introspection.
 *
 *   GET /api/debug  — returns the list of properties visible on each
 *                     scope (context, context.env, context.bindings,
 *                     globalThis), and which ones "look" like KV handles.
 *                     NO SECRETS, NO VALUES.  Safe to expose under auth.
 *
 * Why this exists:
 *   EdgeOne's KV binding convention has shifted across versions
 *   (context.<name> vs context.env.<name> vs context.bindings.<name>
 *   vs globalThis.<name>).  When a binding "isn't found" we need to
 *   see what EdgeOne actually exposed so the operator can name the
 *   variable correctly.  This endpoint makes that visible.
 */

import { scanKvBindings, resolveKvBinding } from '../lib/config.js';

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
  const { env, request } = context;
  const authErr = checkAuth(request, env);
  if (authErr) return authErr;

  const scan = scanKvBindings(context);

  return new Response(
    JSON.stringify(
      {
        timestamp: new Date().toISOString(),
        detected: scan.detected,
        // `kvLike` lists property names that duck-typed as KV handles.
        // If `detected` is null but any scope has `kvLike` entries, then
        // the binding exists but our candidate list didn't include it.
        hint: scan.detected
          ? `KV binding detected as "${scan.detected.name}" on scope "${scan.detected.scope}".`
          : 'No KV binding detected. Check `scopes.<name>.kvLike` — if any of those arrays is non-empty, that scope exposes a KV handle under one of those names. Consider adding it to KV_BINDING_CANDIDATES in lib/config.js, or rename your binding to one of the candidates.',
        scopes: scan.scopes,
        request_url: context.request.url,
        request_search: new URL(context.request.url, 'http://localhost').search,
        env_keys: env ? Object.keys(env) : [],
      },
      null,
      2
    ),
    {
      status: 200,
      headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
    }
  );
}

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

import { scanKvBindings, resolveKvBinding, checkAdminAuth } from '../lib/config.js';

function checkAuth(request, env) {
  return checkAdminAuth(request, env);
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
        hint: scan.detected
          ? `KV binding detected as "${scan.detected.name}" on scope "${scan.detected.scope}".`
          : 'No KV binding detected. Check `scopes.<name>.kvLike`.',
        scopes: scan.scopes,
        request_url: context.request.url,
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

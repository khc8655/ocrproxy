/**
 * api/admin/presets/check-updates.js — Compare configured providers against remote catalog.
 */
import { checkConfiguredUpdates } from '../../../lib/presets/hub.js';
import { requireAuth } from '../../../lib/config.js';

export async function onRequestPost(context) {
  const authErr = requireAuth(context);
  if (authErr) return authErr;

  let body = {};
  try {
    body = await context.request.json();
  } catch {}

  const providersToCheck = Array.isArray(body?.providers) ? body.providers : (Array.isArray(body?.installed) ? body.installed : null);
  const res = await checkConfiguredUpdates(context, providersToCheck);

  return new Response(JSON.stringify(res), {
    status: 200,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

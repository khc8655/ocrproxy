/**
 * api/admin/presets/update-rules.js — Incrementally update rules strictly for selected configured providers.
 */
import { updateConfiguredRules } from '../../../lib/presets/hub.js';
import { requireAuth, resolveKvBinding } from '../../../lib/config.js';

export async function onRequestPost(context) {
  const authErr = requireAuth(context);
  if (authErr) return authErr;

  let body = {};
  try {
    body = await context.request.json();
  } catch {}

  const targetIds = Array.isArray(body?.provider_ids) ? body.provider_ids : (body?.provider_ids ? [body.provider_ids] : []);
  if (targetIds.length === 0) {
    return new Response(JSON.stringify({ error: 'No provider_ids specified' }), {
      status: 400,
      headers: { 'content-type': 'application/json' }
    });
  }

  const kvRes = resolveKvBinding(context);
  const kv = kvRes?.kv;

  const res = await updateConfiguredRules(context, targetIds, kv);
  return new Response(JSON.stringify(res), {
    status: res.ok ? 200 : 400,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

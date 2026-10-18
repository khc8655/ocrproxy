/**
 * api/admin/presets/catalog.js — Return dynamic presets catalog via PresetHub.
 */
import { getCatalog } from '../../../lib/presets/hub.js';
import { requireAuth } from '../../../lib/config.js';

export async function onRequestGet(context) {
  const authErr = requireAuth(context);
  if (authErr) return authErr;

  const url = new URL(context.request.url);
  const force = url.searchParams.get('force') === 'true';
  const res = await getCatalog(context, force);

  return new Response(JSON.stringify(res), {
    status: 200,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'public, max-age=60'
    },
  });
}

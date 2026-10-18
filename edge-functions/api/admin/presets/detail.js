/**
 * api/admin/presets/detail.js — Return single preset detail via PresetHub.
 */
import { getPresetDetail } from '../../../lib/presets/hub.js';
import { requireAuth } from '../../../lib/config.js';

export async function onRequestGet(context) {
  const authErr = requireAuth(context);
  if (authErr) return authErr;

  const url = new URL(context.request.url);
  const id = String(url.searchParams.get('id') || '').toLowerCase().trim();
  const force = url.searchParams.get('force') === 'true';

  if (!id) {
    return new Response(JSON.stringify({ error: 'Missing preset id' }), {
      status: 400,
      headers: { 'content-type': 'application/json' }
    });
  }

  const res = await getPresetDetail(context, id, force);
  if (!res || !res.preset) {
    return new Response(JSON.stringify({ error: `Preset '${id}' not found` }), {
      status: 404,
      headers: { 'content-type': 'application/json' }
    });
  }

  return new Response(JSON.stringify(res), {
    status: 200,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'public, max-age=60'
    },
  });
}

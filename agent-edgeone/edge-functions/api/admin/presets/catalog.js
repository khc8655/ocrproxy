/**
 * api/admin/presets/catalog.js — Return presets catalog for EdgeOne admin panel.
 */
import { CATALOG } from '../../../lib/presets/index.js';
import { requireAuth } from '../../../lib/config.js';

export async function onRequestGet(context) {
  const authErr = requireAuth(context);
  if (authErr) return authErr;

  return new Response(JSON.stringify({
    ok: true,
    catalog: CATALOG,
  }), {
    status: 200,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'public, max-age=3600'
    },
  });
}

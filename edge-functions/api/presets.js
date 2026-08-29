/**
 * api/presets.js — Return available provider presets and recommended models.
 */

import { PRESETS, PRESET_MAP } from '../lib/presets/index.js';
import { requireAuth } from '../lib/config.js';

export async function onRequestGet(context) {
  const authErr = requireAuth(context);
  if (authErr) return authErr;

  return new Response(JSON.stringify({
    ok: true,
    presets: PRESETS,
    map: PRESET_MAP,
  }), {
    status: 200,
    headers: {
      'content-type': 'application/json',
      'cache-control': 'public, max-age=3600',
    },
  });
}

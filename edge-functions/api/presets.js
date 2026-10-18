/**
 * api/presets.js — Return available provider presets and handle remote updates via PresetHub.
 */

import {
  getCatalog,
  getPresetDetail,
  checkConfiguredUpdates,
  updateConfiguredRules,
  PRESETS,
  PRESET_MAP
} from '../lib/presets/hub.js';
import { requireAuth, resolveKvBinding } from '../lib/config.js';

export async function onRequestGet(context) {
  try {
    const authErr = requireAuth(context);
    if (authErr) return authErr;

    const url = new URL(context.request.url);
    const action = url.searchParams.get('action') || '';
    const force = url.searchParams.get('force') === 'true';

    if (action === 'catalog') {
      const res = await getCatalog(context, force);
      return new Response(JSON.stringify(res), {
        status: 200,
        headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'public, max-age=60' },
      });
    }

    if (action === 'detail') {
      const id = String(url.searchParams.get('id') || '').toLowerCase().trim();
      if (!id) {
        return new Response(JSON.stringify({ error: 'Missing preset id' }), { status: 400, headers: { 'content-type': 'application/json' } });
      }
      const res = await getPresetDetail(context, id, force);
      if (!res || !res.preset) {
        return new Response(JSON.stringify({ error: `Preset '${id}' not found` }), { status: 404, headers: { 'content-type': 'application/json' } });
      }
      return new Response(JSON.stringify(res), {
        status: 200,
        headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'public, max-age=60' },
      });
    }

    const catalogRes = await getCatalog(context, force);
    return new Response(JSON.stringify({
      ok: true,
      source: catalogRes?.source || 'hub',
      catalog: catalogRes?.catalog || {},
      presets: PRESETS,
      map: PRESET_MAP,
    }), {
      status: 200,
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'public, max-age=60',
      },
    });
  } catch (err) {
    return new Response(JSON.stringify({
      error: 'internal_error',
      message: err?.message || String(err),
    }), {
      status: 500,
      headers: { 'content-type': 'application/json' },
    });
  }
}

export async function onRequestPost(context) {
  try {
    const authErr = requireAuth(context);
    if (authErr) return authErr;

    const url = new URL(context.request.url);
    const action = url.searchParams.get('action') || '';

    let body = {};
    try {
      body = await context.request.json();
    } catch {}

    const kvRes = resolveKvBinding(context);
    const kv = kvRes?.kv;

    if (action === 'check-updates') {
      const providersToCheck = Array.isArray(body?.providers) ? body.providers : (Array.isArray(body?.installed) ? body.installed : null);
      const res = await checkConfiguredUpdates(context, providersToCheck);
      return new Response(JSON.stringify(res), {
        status: 200,
        headers: { 'content-type': 'application/json; charset=utf-8' },
      });
    }

    if (action === 'update-rules') {
      const targetIds = Array.isArray(body.provider_ids) ? body.provider_ids : (body.provider_ids ? [body.provider_ids] : []);
      if (targetIds.length === 0) {
        return new Response(JSON.stringify({ error: 'No provider_ids specified' }), { status: 400, headers: { 'content-type': 'application/json' } });
      }

      const res = await updateConfiguredRules(context, targetIds, kv);
      return new Response(JSON.stringify(res), {
        status: res.ok ? 200 : 400,
        headers: { 'content-type': 'application/json; charset=utf-8' },
      });
    }

    return new Response(JSON.stringify({ error: `Unknown action: ${action}` }), {
      status: 400,
      headers: { 'content-type': 'application/json' },
    });
  } catch (err) {
    return new Response(JSON.stringify({
      error: 'internal_error',
      message: err?.message || String(err),
    }), {
      status: 500,
      headers: { 'content-type': 'application/json' },
    });
  }
}

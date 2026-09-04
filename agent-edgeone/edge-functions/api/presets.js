/**
 * api/presets.js — Return available provider presets and handle remote updates.
 */

import { PRESETS, PRESET_MAP, CATALOG, getPreset } from '../lib/presets/index.js';
import { requireAuth, loadConfig, validateConfig, invalidateConfigCache, resolveKvBinding } from '../lib/config.js';

const CONFIG_KV_KEY = 'config';
const CONFIG_KV_TTL_SEC = 60 * 60 * 24 * 30; // 30 days

const CDN_CATALOG_URLS = [
  'https://cdn.jsdelivr.net/gh/khc8655/ocrproxy@main/shared/presets/catalog.json',
  'https://raw.githubusercontent.com/khc8655/ocrproxy/main/shared/presets/catalog.json',
];

const CDN_PRESET_BASE_URLS = [
  'https://cdn.jsdelivr.net/gh/khc8655/ocrproxy@main/shared/presets',
  'https://raw.githubusercontent.com/khc8655/ocrproxy/main/shared/presets',
];

async function fetchRemoteJson(urls, timeoutMs = 2500) {
  for (const url of urls) {
    try {
      let signal;
      if (typeof AbortController !== 'undefined') {
        const controller = new AbortController();
        setTimeout(() => controller.abort(), timeoutMs);
        signal = controller.signal;
      }
      const res = await fetch(url, signal ? { signal } : undefined);
      if (res && res.ok) {
        return await res.json();
      }
    } catch {}
  }
  return null;
}

export async function onRequestGet(context) {
  try {
    const authErr = requireAuth(context);
    if (authErr) return authErr;

    const url = new URL(context.request.url);
    const action = url.searchParams.get('action') || '';

    if (action === 'catalog') {
      const catalogData = await fetchRemoteJson(CDN_CATALOG_URLS, 2000) || CATALOG;
      return new Response(JSON.stringify({
        ok: true,
        catalog: catalogData,
      }), {
        status: 200,
        headers: { 'content-type': 'application/json', 'cache-control': 'public, max-age=600' },
      });
    }

    if (action === 'detail') {
      const id = String(url.searchParams.get('id') || '').toLowerCase().trim();
      if (!id) {
        return new Response(JSON.stringify({ error: 'Missing preset id' }), { status: 400, headers: { 'content-type': 'application/json' } });
      }
      const urls = CDN_PRESET_BASE_URLS.map((b) => `${b}/${id}.json`);
      const presetData = await fetchRemoteJson(urls, 2500) || getPreset(id);
      if (!presetData) {
        return new Response(JSON.stringify({ error: `Preset '${id}' not found` }), { status: 404, headers: { 'content-type': 'application/json' } });
      }
      return new Response(JSON.stringify({
        ok: true,
        preset: presetData,
      }), {
        status: 200,
        headers: { 'content-type': 'application/json', 'cache-control': 'public, max-age=600' },
      });
    }

    return new Response(JSON.stringify({
      ok: true,
      catalog: CATALOG,
      presets: PRESETS,
      map: PRESET_MAP,
    }), {
      status: 200,
      headers: {
        'content-type': 'application/json',
        'cache-control': 'public, max-age=3600',
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
      const catalogData = await fetchRemoteJson(CDN_CATALOG_URLS, 2000) || CATALOG;
      const catalogMap = Object.fromEntries(((catalogData && catalogData.providers) || []).map((p) => [p.id, p]));

      let providersToCheck = Array.isArray(body?.providers) ? body.providers : null;
      if (!providersToCheck && Array.isArray(body?.installed)) {
        providersToCheck = body.installed;
      }
      if (!providersToCheck) {
        let config = {};
        try {
          config = await loadConfig(context.env, kv) || {};
        } catch {}
        providersToCheck = Object.entries(config.providers || {}).map(([pid, pdata]) => ({
          provider_id: pid,
          preset_id: (pdata && pdata.preset_id) || pid,
          current_version: (pdata && pdata.preset_version) || '1.0.0',
          rule_hash: pdata && pdata.rule_hash,
        }));
      }

      const updates = [];
      const upToDate = [];

      for (const item of providersToCheck) {
        if (!item) continue;
        const provId = item.provider_id || item.id;
        const presId = item.preset_id || provId;
        const currVer = item.current_version || item.version || '1.0.0';

        const remotePreset = catalogMap[presId];
        if (!remotePreset) continue;

        const latestVer = remotePreset.version || '1.0.0';
        const hasUpdate = latestVer !== currVer;

        const resItem = {
          provider_id: provId,
          preset_id: presId,
          name: remotePreset.name || provId,
          current_version: currVer,
          latest_version: latestVer,
          has_update: hasUpdate,
        };

        if (hasUpdate) {
          updates.push(resItem);
        } else {
          upToDate.push(resItem);
        }
      }

      return new Response(JSON.stringify({
        ok: true,
        updates,
        up_to_date: upToDate,
        catalog_version: (catalogData && catalogData.version) || '1.1.0',
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }

  if (action === 'update-rules') {
    const targetIds = Array.isArray(body.provider_ids) ? body.provider_ids : (body.provider_ids ? [body.provider_ids] : []);
    if (targetIds.length === 0) {
      return new Response(JSON.stringify({ error: 'No provider_ids specified' }), { status: 400, headers: { 'content-type': 'application/json' } });
    }

    const config = await loadConfig(context.env, kv);
    const providers = config.providers || {};
    const updated = [];
    const failed = [];

    for (const pid of targetIds) {
      if (!providers[pid]) {
        failed.push({ provider_id: pid, error: 'Provider not found in current config' });
        continue;
      }
      const pdata = providers[pid];
      const presId = pdata.preset_id || pid;

      const urls = CDN_PRESET_BASE_URLS.map((b) => `${b}/${presId}.json`);
      const presetData = await fetchRemoteJson(urls, 2500) || getPreset(presId);

      if (!presetData) {
        failed.push({ provider_id: pid, error: `Failed to fetch rules for preset '${presId}'` });
        continue;
      }

      pdata.adapter_rules = presetData.adapter_rules || {};
      pdata.preset_version = presetData.version || '1.1.0';
      if (presetData.recommended_models) {
        pdata.recommended_models = presetData.recommended_models;
      }
      if (presetData.features) {
        pdata.features = presetData.features;
      }

      updated.push({
        provider_id: pid,
        preset_id: presId,
        new_version: pdata.preset_version,
      });
    }

    if (updated.length > 0 && kv) {
      const valid = validateConfig(config);
      await kv.put(CONFIG_KV_KEY, JSON.stringify(valid), { expirationTtl: CONFIG_KV_TTL_SEC });
      invalidateConfigCache();
    }

    return new Response(JSON.stringify({
      ok: true,
      updated,
      failed,
      message: `Successfully updated rules for ${updated.length} provider(s).`,
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }

    return new Response(JSON.stringify({ error: 'Invalid action' }), { status: 400, headers: { 'content-type': 'application/json' } });
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

export default onRequestGet;

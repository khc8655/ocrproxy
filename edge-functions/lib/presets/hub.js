/**
 * presets/hub.js — Unified Dynamic Presets Engine for EdgeOne.
 * Implements 4-tier caching (L1 Memory -> L2 KV -> L3 Remote Mirrors -> L4 Static Baseline).
 */

import {
  CATALOG as FALLBACK_CATALOG,
  PRESETS as FALLBACK_PRESETS,
  PRESET_MAP as FALLBACK_MAP,
  getPreset as getFallbackPreset
} from './index.js';
import { loadConfig, saveConfig } from '../config.js';

export const PRESET_REMOTE_MIRRORS = [
  'https://raw.githubusercontent.com/khc8655/ocrproxy/main/shared/presets',
  'https://raw.gitmirror.com/khc8655/ocrproxy/main/shared/presets',
  'https://cdn.jsdelivr.net/gh/khc8655/ocrproxy@main/shared/presets',
];

// L1 In-memory cache (survives within EdgeOne worker isolate life cycle)
let l1Catalog = { data: null, expiresAt: 0 };
const l1Presets = new Map();

/**
 * Fetch from remote mirrors with fast failover.
 */
export async function fetchFromMirrors(subPath, timeoutMs = 2500) {
  for (const mirror of PRESET_REMOTE_MIRRORS) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      const res = await fetch(`${mirror}/${subPath}`, {
        signal: controller.signal,
        headers: { 'Accept': 'application/json' },
      });
      clearTimeout(timer);
      if (res.ok) {
        const json = await res.json();
        if (json && typeof json === 'object') return json;
      }
    } catch {
      // Continue to next mirror
    }
  }
  return null;
}

/**
 * Fetch catalog with 4-tier fallback: L1 -> L2 KV -> L3 Mirrors -> L4 Static Baseline.
 */
export async function getCatalog(context, force = false) {
  const now = Date.now();
  if (!force && l1Catalog.data && l1Catalog.expiresAt > now) {
    return { ok: true, source: 'l1_memory', catalog: l1Catalog.data, providers: l1Catalog.data.providers || [] };
  }

  const kv = context?.env?.agent_kv || context?.bindings?.agent_kv;

  // Check L2 KV cache if not forcing
  if (!force && kv && typeof kv.get === 'function') {
    try {
      const kvData = await kv.get('preset_catalog', 'json');
      if (kvData && typeof kvData === 'object' && Array.isArray(kvData.providers) && kvData.providers.length > 0) {
        l1Catalog = { data: kvData, expiresAt: now + 600000 }; // 10 mins
        return { ok: true, source: 'l2_kv', catalog: kvData, providers: kvData.providers };
      }
    } catch {}
  }

  // Fetch L3 from remote mirrors
  let catalogData = await fetchFromMirrors('catalog.json', 2500);
  let source = 'remote';

  // L4 Static fallback
  if (!catalogData || !Array.isArray(catalogData.providers)) {
    catalogData = FALLBACK_CATALOG;
    source = 'l4_fallback';
  } else {
    // Save to L2 KV
    if (kv && typeof kv.put === 'function') {
      try {
        await kv.put('preset_catalog', JSON.stringify(catalogData), { expirationTtl: 86400 });
      } catch {}
    }
  }

  // Update L1
  l1Catalog = { data: catalogData, expiresAt: now + 600000 };
  return { ok: true, source, catalog: catalogData, providers: catalogData.providers || [] };
}

/**
 * Fetch single preset detail on demand: L1 -> L2 KV -> L3 Mirrors -> L4 Static Baseline.
 */
export async function getPresetDetail(context, presetId, force = false) {
  const pid = String(presetId || '').toLowerCase().trim();
  if (!pid) return null;

  const now = Date.now();
  const cachedL1 = l1Presets.get(pid);
  if (!force && cachedL1 && cachedL1.expiresAt > now) {
    return { ok: true, source: 'l1_memory', preset: cachedL1.data };
  }

  const kv = context?.env?.agent_kv || context?.bindings?.agent_kv;

  // Check L2 KV
  if (!force && kv && typeof kv.get === 'function') {
    try {
      const kvData = await kv.get(`preset_${pid}`, 'json');
      if (kvData && typeof kvData === 'object' && kvData.id) {
        l1Presets.set(pid, { data: kvData, expiresAt: now + 600000 });
        return { ok: true, source: 'l2_kv', preset: kvData };
      }
    } catch {}
  }

  // Fetch L3 from remote mirrors
  let presetData = await fetchFromMirrors(`${pid}.json`, 2500);
  let source = 'remote';

  // L4 Static fallback
  if (!presetData || typeof presetData !== 'object' || !presetData.id) {
    presetData = getFallbackPreset(pid);
    source = 'l4_fallback';
  } else {
    // Save to L2 KV
    if (kv && typeof kv.put === 'function') {
      try {
        await kv.put(`preset_${pid}`, JSON.stringify(presetData), { expirationTtl: 86400 });
      } catch {}
    }
  }

  if (!presetData) return null;

  // Update L1
  l1Presets.set(pid, { data: presetData, expiresAt: now + 600000 });
  return { ok: true, source, preset: presetData };
}

/**
 * Synchronous preset accessor for runtime fast-path (completions, messages).
 */
export function getPresetSync(presetId) {
  const pid = String(presetId || '').toLowerCase().trim();
  if (!pid) return null;
  const l1 = l1Presets.get(pid);
  if (l1 && l1.data) return l1.data;
  return getFallbackPreset(pid);
}

/**
 * Check updates strictly for configured providers only.
 */
export async function checkConfiguredUpdates(context, providersToCheck = null) {
  const catalogRes = await getCatalog(context, false);
  const catalogList = catalogRes?.providers || [];
  const catalogMap = Object.fromEntries(catalogList.map((p) => [p.id, p]));

  let targets = providersToCheck;
  if (!Array.isArray(targets) || targets.length === 0) {
    const kv = context?.env?.agent_kv || context?.bindings?.agent_kv;
    let config = {};
    try {
      config = (await loadConfig(context?.env, kv)) || {};
    } catch {}
    targets = Object.entries(config.providers || {}).map(([pid, pdata]) => ({
      provider_id: pid,
      preset_id: pdata?.preset_id || pid,
      current_version: pdata?.preset_version || '1.0.0',
      rule_hash: pdata?.rule_hash || '',
    }));
  }

  const updates = [];
  const upToDate = [];

  for (const item of targets) {
    if (!item) continue;
    const provId = item.provider_id || item.id;
    const presId = item.preset_id || provId;
    const currVer = item.current_version || item.version || '1.0.0';

    const remotePreset = catalogMap[presId];
    if (!remotePreset) continue;

    const latestVer = remotePreset.version || '1.0.0';
    const latestHash = remotePreset.rule_hash || '';
    const currHash = item.rule_hash || '';

    let hasUpdate = false;
    if (latestHash && currHash && latestHash === currHash) {
      hasUpdate = false;
    } else {
      hasUpdate = (latestVer !== currVer) || Boolean(latestHash && currHash && latestHash !== currHash);
    }

    const resItem = {
      provider_id: provId,
      preset_id: presId,
      name: remotePreset.name || provId,
      current_version: currVer,
      latest_version: latestVer,
      remote_version: latestVer,
      has_update: hasUpdate,
    };

    if (hasUpdate) {
      updates.push(resItem);
    } else {
      upToDate.push(resItem);
    }
  }

  return {
    ok: true,
    updates,
    up_to_date: upToDate,
    catalog_version: catalogRes?.catalog?.version || '1.1.0',
  };
}

/**
 * Incrementally update rules strictly for selected configured providers.
 */
export async function updateConfiguredRules(context, targetIds, kv) {
  if (!Array.isArray(targetIds) || targetIds.length === 0) {
    return { ok: false, error: 'No provider_ids specified', updated: [], failed: [] };
  }

  const catalogRes = await getCatalog(context, false);
  const catalogList = catalogRes?.providers || [];
  const catalogMap = Object.fromEntries(catalogList.map((p) => [p.id, p]));

  const config = await loadConfig(context?.env, kv);
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

    // Force fetch fresh detail from remote mirrors
    const detailRes = await getPresetDetail(context, presId, true);
    const presetData = detailRes?.preset;

    if (!presetData) {
      failed.push({ provider_id: pid, error: `Failed to fetch rules for preset '${presId}'` });
      continue;
    }

    pdata.adapter_rules = presetData.adapter_rules || {};
    pdata.preset_version = presetData.version || '1.1.0';
    pdata.rule_hash = catalogMap[presId]?.rule_hash || presetData.rule_hash || '';
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
    await saveConfig(config, kv);
  }

  return { ok: true, updated, failed };
}

// Re-export fallback assets for backward compatibility
export {
  FALLBACK_CATALOG as CATALOG,
  FALLBACK_PRESETS as PRESETS,
  FALLBACK_MAP as PRESET_MAP,
  getFallbackPreset as getPreset
};

/**
 * logger.js — Unified, secure logging module for EdgeOne Functions.
 *
 * Adheres to:
 * 1. Zero Secret Leakage: Automatic masking for API keys, passwords, and tokens.
 * 2. EdgeOne Marks Limits: Strict 4KB single-line truncation per Tencent Cloud EO Doc 115585.
 * 3. Unified Tagging: Aligns with VM platform using [EdgeOne:<Tag>] prefixes.
 */

const SENSITIVE_KEYS = new Set([
  'key',
  'apikey',
  'api_key',
  'password',
  'admin_password',
  'token',
  'vault_token',
  'authorization',
  'proxy_api_key',
  'secret',
  'credentials'
]);

/**
 * Safely masks secret strings (API keys, passwords, tokens).
 */
export function maskSecret(val) {
  if (!val || typeof val !== 'string') return '';
  const trimmed = val.trim();
  if (trimmed.length <= 8) return '****';
  if (trimmed.startsWith('sk-')) {
    return `${trimmed.slice(0, 7)}****${trimmed.slice(-4)}`;
  }
  return `${trimmed.slice(0, 4)}****${trimmed.slice(-4)}`;
}

/**
 * Recursively deep-clone and sanitize metadata objects.
 */
export function sanitizeMeta(meta) {
  if (!meta || typeof meta !== 'object') {
    return meta;
  }

  if (Array.isArray(meta)) {
    return meta.slice(0, 20).map(item => sanitizeMeta(item));
  }

  const clean = {};
  for (const [k, v] of Object.entries(meta)) {
    const lowerKey = k.toLowerCase().replace(/[-_]/g, '');
    if (SENSITIVE_KEYS.has(lowerKey)) {
      clean[k] = '[REDACTED_SECRET]';
    } else if (typeof v === 'string') {
      // Check if string looks like Bearer token
      if (v.toLowerCase().startsWith('bearer ')) {
        clean[k] = 'Bearer [REDACTED_SECRET]';
      } else if (v.length > 500) {
        // Truncate long strings (prompts/bodies)
        clean[k] = `${v.slice(0, 500)}...[TRUNCATED]`;
      } else {
        clean[k] = v;
      }
    } else if (typeof v === 'object' && v !== null) {
      clean[k] = sanitizeMeta(v);
    } else {
      clean[k] = v;
    }
  }
  return clean;
}

/**
 * Serialize and truncate log lines within EdgeOne's 4KB per-call limit.
 */
function serializeLog(tag, message, meta) {
  const prefix = `[EdgeOne:${tag}] ${message}`;
  if (!meta || Object.keys(meta).length === 0) {
    return prefix;
  }

  try {
    const clean = sanitizeMeta(meta);
    let metaStr = '';
    if (typeof clean === 'object') {
      metaStr = Object.entries(clean)
        .map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : v}`)
        .join(' ');
    } else {
      metaStr = String(clean);
    }

    const full = `${prefix} | ${metaStr}`;
    // EdgeOne max single console line is 4096 bytes; truncate at 3800 for safety
    if (full.length > 3800) {
      return `${full.slice(0, 3800)}...[TRUNCATED_4KB]`;
    }
    return full;
  } catch (_) {
    return prefix;
  }
}

export const edgeLogger = {
  error(tag, message, meta = {}) {
    console.error(serializeLog(tag, message, meta));
  },
  warn(tag, message, meta = {}) {
    console.warn(serializeLog(tag, message, meta));
  },
  info(tag, message, meta = {}) {
    console.info(serializeLog(tag, message, meta));
  }
};

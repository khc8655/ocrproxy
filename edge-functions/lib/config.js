/**
 * config.js — Config loader and Key pool for the Edge Function.
 *
 * Configuration shape (matches VM-side `vm-app/app/config_store.py`):
 *   {
 *     "providers": {
 *       "siliconflow": {
 *         "base_url": "https://api.siliconflow.cn",
 *         "keys": { "KeyA": "sk-xxxx", "KeyB": "sk-yyyy" }
 *       }
 *     },
 *     "agent_models": {
 *       "deepseek-v4-flash": {
 *         "keys": [
 *           { "provider": "sensenova", "key": "self", "upstream_model": "DeepSeek-V3-Flash" }
 *         ]
 *       }
 *     }
 *   }
 *
 * Sourcing priority (first hit wins):
 *   1. KV namespace bound as `agent_kv`  (recommended for production)
 *   2. env.AGENT_CONFIG_JSON               (string, JSON-encoded)
 *   3. env.AGENT_CONFIG                    (alias)
 *
 * Caching: in-memory per-isolate cache with 60s TTL.  EdgeOne isolates are
 * reused across requests; this avoids re-parsing the config on every call.
 * KV is already 60s eventually-consistent, so the cache window is harmless.
 */

const CACHE_TTL_MS = 60_000;
let _cache = { value: null, expires: 0 };

/** Candidate KV binding names.  Exported so the error helpers can list
 *  them and so /api/debug can show what was tried. */
export const KV_BINDING_CANDIDATES = [
  'agent_kv', 'my_kv', 'ocrproxy_kv', 'kv', 'KV',
  'KV_NAMESPACE', 'NAMESPACE', 'storage', 'STORE',
  'agentKV', 'MY_KV',
];

export const DEFAULT_SETTINGS = {
  agent_routing_strategy: 'sticky_failover',
  request_total_budget_sec: 25, // 25s budget for EdgeOne to be safely under 30s platform limit
  upstream_timeout_sec: 8,      // 8s per attempt so 3 keys can easily be tried within 25s budget
  schedule_total_budget: 3,     // max 3 total attempts per request
  max_attempts_per_provider: 3, // max 3 attempts per provider to allow trying 3 keys of same provider
  fast_failover_provider_down: true, // skip provider on 502/504/timeout if other providers exist
  cooldown_429_sec: 60,
  cooldown_5xx_sec: 30,
  cooldown_403_sec: 600,
  circuit_break_threshold: 3,
  circuit_cooldown_sec: 60,
};

/**
 * Parse + validate a config payload.  Used by both the KV path and the
 * env-var path so the error messages are consistent.
 */
function parseAndValidateConfig(raw, source) {
  let parsed;
  try {
    parsed = typeof raw === 'string' ? JSON.parse(sanitizeJsonString(raw)) : raw;
  } catch (e) {
    throw new ConfigError(
      `${source} is not valid JSON: ${e?.message || e}. ` +
      `The raw value starts with: ${JSON.stringify(String(raw).slice(0, 80))}`
    );
  }
  if (parsed && typeof parsed === 'object' && parsed.config && typeof parsed.config === 'object') {
    parsed = parsed.config;
  }
  if (!parsed || typeof parsed !== 'object') {
    throw new ConfigError(`${source} must be a JSON object.`);
  }
  if (!parsed.providers || typeof parsed.providers !== 'object') {
    throw new ConfigError(`${source} is missing "providers".`);
  }
  if (!parsed.agent_models || typeof parsed.agent_models !== 'object') {
    throw new ConfigError(`${source} is missing "agent_models".`);
  }
  
  // Normalize Schema v2 settings with backwards compatibility
  parsed.settings = { ...DEFAULT_SETTINGS, ...(parsed.settings || {}) };
  for (const k of Object.keys(DEFAULT_SETTINGS)) {
    if (parsed[k] !== undefined && (parsed.settings[k] === undefined || parsed.settings[k] === DEFAULT_SETTINGS[k])) {
      parsed.settings[k] = parsed[k];
    }
  }

  return parsed;
}

/**
 * Resolve the raw config object from KV / env.
 *
 * Source priority (first hit wins):
 *   1. KV (if bound AND has a non-empty value at key 'config')
 *   2. env.AGENT_CONFIG_JSON  (fallback if KV empty or unbound)
export const CONFIG_KV_KEY = 'config';
export const CONFIG_KV_TTL_SEC = 60 * 60 * 24 * 30; // 30 days

/**
 * Global single-point config persistence.
 * Validates, wraps, writes to KV, and invalidates cache.
 */
export async function saveConfig(incomingConfig, kv) {
  const incoming = incomingConfig?.config || incomingConfig;
  const validationErr = validateConfig(incoming);
  if (validationErr) {
    throw new ConfigError(validationErr);
  }
  const wrapped = {
    source: 'kv',
    last_modified: new Date().toISOString(),
    config: incoming,
  };
  if (kv && typeof kv.put === 'function') {
    await kv.put(CONFIG_KV_KEY, JSON.stringify(wrapped), { expirationTtl: CONFIG_KV_TTL_SEC });
    invalidateConfigCache();
  }
  return wrapped;
}

/**
 * Load the active configuration.
 *
 * Priority:
 *   1. KV binding (`agent_kv` or other named binding resolved by resolveKvBinding)
 *   2. env var `AGENT_CONFIG_JSON` (JSON string)
 *   3. env var `AGENT_CONFIG` (alias)
 *
 * @param {Object} env - function context.env
 * @param {Object} [kv] - optional pre-resolved KV binding (e.g. agent_kv)
 */
export async function loadConfig(env, kv) {
  const now = Date.now();
  if (_cache.value && now < _cache.expires) {
    return _cache.value;
  }

  // 1) KV (preferred — supports runtime updates without redeploy)
  if (kv && typeof kv.get === 'function') {
    let text = null;
    try {
      text = await kv.get(CONFIG_KV_KEY);
    } catch (e) {
      console.warn('KV read failed:', e?.message || e);
    }
    if (text && typeof text === 'string' && text.trim()) {
      try {
        const parsed = parseAndValidateConfig(text, 'KV[config]');
        _cache = { value: parsed, expires: now + CACHE_TTL_MS };
        return parsed;
      } catch (e) {
        console.warn('KV config parse failed, falling back to env:', e?.message || e);
      }
    }
  }

  // 2) env JSON fallback
  const raw = env?.AGENT_CONFIG_JSON || env?.AGENT_CONFIG || null;
  if (raw && typeof raw === 'string' && raw.trim()) {
    try {
      const parsed = parseAndValidateConfig(raw, 'env.AGENT_CONFIG_JSON');
      _cache = { value: parsed, expires: now + CACHE_TTL_MS };
      return parsed;
    } catch (e) {
      console.warn('env config parse failed:', e?.message || e);
    }
  }

  // 3) Graceful default if neither KV nor ENV is populated
  return {
    providers: {},
    agent_models: {},
    settings: { ...DEFAULT_SETTINGS },
  };
}


/**
 * Detect whether an object looks like a KV handle.  EdgeOne's KV SDK has
 * `get`, `put`, `delete`, `list`.  Some bindings might be wrapped or
 * partially exposed, so we accept "at least `get` + one of `put`/`delete`/
 * `list`".
 */
function looksLikeKvHandle(obj) {
  if (!obj || typeof obj !== 'object') return false;
  if (typeof obj.get !== 'function') return false;
  if (typeof obj.put === 'function') return true;
  if (typeof obj.delete === 'function') return true;
  if (typeof obj.list === 'function') return true;
  return false;
}

/**
 * Try a list of common KV binding names, then fall back to a duck-typed
 * recursive scan of `context` looking for any object that looks like a
 * KV handle.  Returns `{ kv, name, scope }` or `undefined`.
 *
 * EdgeOne has multiple runtime conventions for KV bindings:
 *
 *   1. **Pages Functions** (function-handler with `context`):
 *      KV is on `context.<varname>` and on `env.<varname>`.  Example
 *      binding name `agent_kv` → `context.agent_kv`.
 *
 *   2. **Edge Functions** (V8 function-handler / new function-handler):
 *      KV is a GLOBAL variable injected at the top of the function scope.
 *      The official docs example (https://cloud.tencent.com/document/product/1552/127420)
 *      is literally:
 *        let count = await my_kv.get('count');
 *      i.e. no `context.` prefix.  In V8 a true global of this kind is
 *      not on `globalThis`, but many EdgeOne deployments DO mirror
 *      bindings onto `globalThis`, so we probe that too.
 *
 *   3. **Makers / Pages Functions (some versions)**:
 *      Bindings may be exposed as `context.bindings.<name>`.
 *
 * We try common names in priority order across all scopes first, then
 * if nothing matches, we recursively scan the context for any object
 * that duck-types as a KV handle.
 */
export function resolveKvBinding(context) {
  // Build the list of scopes to probe.
  const scopes = [];
  if (context) {
    scopes.push(context);
    if (context.env) scopes.push(context.env);
    if (context.bindings) scopes.push(context.bindings);
  }
  if (typeof globalThis !== 'undefined') {
    scopes.push(globalThis);
  }

  // Pass 1: named candidates.
  for (const scope of scopes) {
    for (const name of KV_BINDING_CANDIDATES) {
      const obj = scope?.[name];
      if (looksLikeKvHandle(obj)) {
        return {
          kv: obj,
          name,
          scope: scope === context
            ? 'context'
            : scope === context?.env
              ? 'context.env'
              : scope === context?.bindings
                ? 'context.bindings'
                : 'global',
        };
      }
    }
  }

  // Pass 2: duck-typed recursive scan of `context` (one level deep —
  // bindings rarely nest deeper than `context.bindings.<name>`).
  if (context && typeof context === 'object') {
    for (const key of Object.keys(context)) {
      const sub = context[key];
      if (!sub || typeof sub !== 'object') continue;
      if (looksLikeKvHandle(sub)) {
        return { kv: sub, name: key, scope: 'context' };
      }
      // One level deeper — e.g. `context.bindings.agent_kv`.
      if (typeof sub === 'object' && !Array.isArray(sub)) {
        for (const inner of Object.keys(sub)) {
          if (looksLikeKvHandle(sub[inner])) {
            return { kv: sub[inner], name: `${key}.${inner}`, scope: 'context' };
          }
        }
      }
    }
  }

  return undefined;
}

/**
 * Diagnostic variant of `resolveKvBinding`.  Returns everything the
 * normal resolver would consider, plus a list of property names on each
 * scope that "look" like KV handles (so an operator can see what EdgeOne
 * actually exposed).  Used by `/api/debug` — no secrets, no values.
 */
export function scanKvBindings(context) {
  const scopes = {};
  const collect = (label, scope) => {
    if (!scope || typeof scope !== 'object') {
      scopes[label] = null;
      return;
    }
    const names = Object.keys(scope);
    const kvLike = names.filter((n) => looksLikeKvHandle(scope[n]));
    scopes[label] = {
      keyCount: names.length,
      keys: names.slice(0, 50), // cap for safety
      kvLike,
    };
  };
  collect('context', context);
  collect('context.env', context?.env);
  collect('context.bindings', context?.bindings);
  collect('globalThis', typeof globalThis !== 'undefined' ? globalThis : null);

  return {
    scopes,
    detected: resolveKvBinding(context) || null,
  };
}

/**
 * Build a "KV not bound" error Response.  Includes the candidate names we
 * tried plus a `scan` payload listing the property names actually visible
 * on each scope, so the operator can see what EdgeOne is exposing.
 */
export function kvNotBoundResponse(context, { status = 503 } = {}) {
  const scan = scanKvBindings(context);
  const message =
    'KV namespace is not bound to this function. ' +
    'Tried variable names: [' + KV_BINDING_CANDIDATES.join(', ') + '] ' +
    'across scopes: [context, context.env, context.bindings, globalThis]. ' +
    'In the Makers console: Project → Function → Extended Services → ' +
    'add a KV binding. Variable name should be one of: ' +
    KV_BINDING_CANDIDATES.join(', ') + '. ' +
    'See `scan.scopes` for what EdgeOne actually exposed in this function.';
  return new Response(
    JSON.stringify({
      error: { type: 'config_error', message },
      scan,
    }),
    { status, headers: { 'content-type': 'application/json' } }
  );
}

/** Force the cache to invalidate (used by /admin/sync if ever added). */
export function invalidateConfigCache() {
  _cache = { value: null, expires: 0 };
}

/**
 * Look up a model and return a list of valid (provider, key_label, upstream_model)
 * bindings.  Empty array means the model is not configured.
 *
 * @param {Object} config
 * @param {string} model
 * @returns {Array<{provider: string, keyLabel: string, upstreamModel: string}>}
 */
export function listBindings(config, model) {
  if (!config || !model) return [];
  const entry = config.agent_models[model];
  if (!entry || !Array.isArray(entry.keys) || entry.keys.length === 0) {
    return [];
  }
  const strategy = config.settings?.agent_routing_strategy || config.agent_routing_strategy || 'sticky_failover';
  const activeKey = entry.active_key;

  const out = [];
  for (const k of entry.keys) {
    if (!k || typeof k !== 'object') continue;
    const provider = k.provider;
    const keyLabel = k.key;
    if (!provider || !keyLabel) continue;
    if (!config.providers[provider]) continue;
    if (!config.providers[provider].keys?.[keyLabel]) continue;
    out.push({
      provider,
      keyLabel,
      upstreamModel: k.upstream_model || entry.upstream_model || model,
    });
  }

  if (strategy === 'manual') {
    if (activeKey) {
      const matched = out.filter(b => b.keyLabel === activeKey);
      if (matched.length > 0) return matched;
    }
    return out.slice(0, 1);
  }

  return out;
}

const _stickyAgentIndices = new Map(); // model -> active index
const _rrAgentIndices = new Map();      // model -> rr index

/**
 * Get ordered candidate bindings based on routing strategy (matches VM scheduler).
 * Strategies: 'manual', 'sticky_failover' (default), 'round_robin', 'priority_fallback', 'random'
 *
 * @param {Array} bindings - list of valid bindings
 * @param {string} model - requested model name
 * @param {string} [strategy] - routing strategy
 * @returns {Array} ordered bindings
 */
export function orderBindings(bindings, model, strategy = 'sticky_failover') {
  if (!bindings || bindings.length === 0) return [];
  const n = bindings.length;
  if (n <= 1 || strategy === 'manual') return bindings.slice(0, 1);

  if (strategy === 'sticky_failover') {
    const stickyIdx = (_stickyAgentIndices.get(model) || 0) % n;
    return bindings.slice(stickyIdx).concat(bindings.slice(0, stickyIdx));
  }
  if (strategy === 'round_robin') {
    const rrIdx = (_rrAgentIndices.get(model) || 0) % n;
    _rrAgentIndices.set(model, (rrIdx + 1) % n);
    return bindings.slice(rrIdx).concat(bindings.slice(0, rrIdx));
  }
  if (strategy === 'random') {
    const copy = bindings.slice();
    for (let i = copy.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [copy[i], copy[j]] = [copy[j], copy[i]];
    }
    return copy;
  }
  // 'priority_fallback' or default: keep configured order
  return bindings.slice();
}

/**
 * Record a successful binding index for sticky failover.
 */
export function recordStickySuccess(model, binding, allBindings) {
  if (!model || !binding || !allBindings) return;
  const idx = allBindings.findIndex(
    (b) => b.provider === binding.provider && b.keyLabel === binding.keyLabel
  );
  if (idx >= 0) {
    _stickyAgentIndices.set(model, idx);
  }
}

/**
 * Pick a random binding from a model's binding list. Uniform random.
 *
 * @param {Array} bindings - output of listBindings
 * @returns {Object|null}
 */
export function pickBinding(bindings) {
  if (!bindings || bindings.length === 0) return null;
  if (bindings.length === 1) return bindings[0];
  const idx = Math.floor(Math.random() * bindings.length);
  return bindings[idx];
}

/**
 * Resolve a binding to (apiKey, baseUrl, upstreamModel).  Throws ConfigError
 * if the binding references a missing provider / key (config drift).
 */
export function resolveBinding(config, binding) {
  const provider = config.providers[binding.provider];
  if (!provider) {
    throw new ConfigError(`Provider "${binding.provider}" not in providers map.`);
  }
  const apiKey = provider.keys?.[binding.keyLabel];
  if (!apiKey) {
    throw new ConfigError(
      `Key "${binding.keyLabel}" not in provider "${binding.provider}".`
    );
  }
  const baseUrl = (provider.base_url || '').replace(/\/+$/, '');
  if (!baseUrl) {
    throw new ConfigError(`Provider "${binding.provider}" has no base_url.`);
  }
  return { apiKey, baseUrl, upstreamModel: binding.upstreamModel, providerConfig: provider };
}

/**
 * Build the full upstream URL by appending /chat/completions to the
 * provider's base_url.  Defensive against trailing slashes so callers
 * can pass either `https://x.com` or `https://x.com/`.
 *
 * Note: most providers use the same /v1/chat/completions path; if a
 * new provider needs a different path, branch on provider name here.
 */
export function buildChatUrl(baseUrl) {
  const cleaned = String(baseUrl || '').replace(/\/+$/, '');
  if (cleaned.endsWith('/chat/completions')) {
    return cleaned;
  }
  if (cleaned.endsWith('/v1') || cleaned.endsWith('/v1beta/openai') || cleaned.includes('/v1/')) {
    return `${cleaned}/chat/completions`;
  }
  return `${cleaned}/v1/chat/completions`;
}

/**
 * Intelligently construct the Anthropic Messages endpoint (/v1/messages)
 * from a provider's base_url or anthropic_base_url.
 */
export function buildMessagesUrl(baseUrl, anthropicBaseUrl, provider) {
  if (anthropicBaseUrl) {
    const cleaned = String(anthropicBaseUrl || '').replace(/\/+$/, '');
    if (cleaned.endsWith('/messages')) return cleaned;
    if (cleaned.endsWith('/v1') || cleaned.includes('/v1/')) return `${cleaned}/messages`;
    return `${cleaned}/v1/messages`;
  }
  const p = String(provider || '').toLowerCase().trim();
  if (p === 'minimax') {
    const b = String(baseUrl || '').toLowerCase();
    if (b.includes('minimax.io')) {
      return 'https://api.minimax.io/anthropic/v1/messages';
    }
    return 'https://api.minimaxi.com/anthropic/v1/messages';
  }
  const cleaned = String(baseUrl || '').replace(/\/+$/, '');
  if (cleaned.endsWith('/messages')) {
    return cleaned;
  }
  if (cleaned.endsWith('/v1') || cleaned.includes('/v1/')) {
    return `${cleaned}/messages`;
  }
  return `${cleaned}/v1/messages`;
}

/**
 * Build the OpenAI-compatible /v1/models response body from agent_models.
 * Each model gets an `id` (the public name) and a stub `object` field.
 */
export function buildModelsList(config) {
  const now = Math.floor(Date.now() / 1000);
  return {
    object: 'list',
    data: Object.keys(config.agent_models).map((id) => ({
      id,
      object: 'model',
      created: now,
      owned_by: 'edgeone-agent-relay',
    })),
  };
}

export class ConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConfigError';
  }
}

/**
 * Validate the shape of an incoming config.  Mirrors the structural
 * checks the Edge Function does at runtime so the admin UI / API can
 * reject malformed configs before writing to KV.
 *
 * Returns null on success, or a human-readable error string on failure.
 */
export function validateConfig(cfg) {
  if (!cfg || typeof cfg !== 'object') return 'config must be an object';
  if (!cfg.providers || typeof cfg.providers !== 'object') {
    return 'config.providers is required and must be an object';
  }
  for (const [name, p] of Object.entries(cfg.providers)) {
    if (!p || typeof p !== 'object') return `provider "${name}" must be an object`;
    if (typeof p.base_url !== 'string' || !p.base_url) {
      return `provider "${name}" must have a non-empty base_url`;
    }
    if (!p.keys || typeof p.keys !== 'object') {
      p.keys = {};
    }
    for (const [k, v] of Object.entries(p.keys)) {
      if (typeof v !== 'string' || !v) {
        return `provider "${name}" key "${k}" must be a non-empty string`;
      }
    }
  }
  if (!cfg.agent_models || typeof cfg.agent_models !== 'object') {
    return 'config.agent_models is required and must be an object';
  }
  for (const [name, m] of Object.entries(cfg.agent_models)) {
    if (!m || typeof m !== 'object') return `model "${name}" must be an object`;
    if (!Array.isArray(m.keys)) {
      return `model "${name}" keys must be an array`;
    }
    for (const b of m.keys) {
      if (!b || typeof b !== 'object') {
        return `model "${name}" has a malformed binding entry`;
      }
      if (typeof b.provider !== 'string' || !b.provider) {
        return `model "${name}" binding missing "provider"`;
      }
      if (typeof b.key !== 'string' || !b.key) {
        return `model "${name}" binding missing "key"`;
      }
      if (!cfg.providers[b.provider]) {
        return `model "${name}" references unknown provider "${b.provider}"`;
      }
      if (!cfg.providers[b.provider].keys[b.key]) {
        return `model "${name}" references unknown key "${b.provider}/${b.key}"`;
      }
      if (b.upstream_model !== undefined && typeof b.upstream_model !== 'string') {
        return `model "${name}" binding upstream_model must be a string`;
      }
    }
  }
  return null;
}

/**
 * Clean up an env-style JSON string before parsing.  Console-saved env
 * vars often have leading/trailing whitespace, surrounding quotes, or
 * a trailing newline.  This helper:
 *   - trims whitespace
 *   - strips a single pair of surrounding double quotes (the most common
 *     copy-paste mistake when entering JSON in a web form)
 *   - if the string contains '{', locates the first '{' and the matching
 *     '}' via depth tracking (strips anything the console may have added
 *     at the start/end, and tolerates trailing junk like extra braces)
 */
export function sanitizeJsonString(raw) {
  if (raw == null) return '';
  let s = String(raw);
  // Trim outer whitespace and surrounding quotes (handles both ' and ")
  s = s.trim();
  for (let i = 0; i < 2; i++) {
    if (s.length >= 2 && (s[0] === '"' || s[0] === "'") && s[s.length - 1] === s[0]) {
      s = s.slice(1, -1).trim();
    } else {
      break;
    }
  }
  // Extract the JSON object boundaries, if present, with proper brace matching
  const open = s.indexOf('{');
  if (open !== -1) {
    let depth = 0;
    let inString = false;
    let escape = false;
    for (let i = open; i < s.length; i++) {
      const c = s[i];
      if (inString) {
        if (escape) { escape = false; continue; }
        if (c === '\\') { escape = true; continue; }
        if (c === '"') inString = false;
      } else {
        if (c === '"') inString = true;
        else if (c === '{') depth++;
        else if (c === '}') {
          depth--;
          if (depth === 0) {
            s = s.slice(open, i + 1);
            break;
          }
        }
      }
    }
  }
  return s;
}

/**
 * Check Bearer auth against PROXY_API_KEY.
 * Returns null if ok, or a Response object if unauthorized.
 */
export function checkAuth(request, env, config) {
  const need = env?.PROXY_API_KEY || config?.proxy_api_key;
  if (!need) return null;
  const rawAuth = request?.headers?.get('authorization') || request?.headers?.get('x-api-key') || '';
  const token = rawAuth.toLowerCase().startsWith('bearer ') ? rawAuth.slice(7).trim() : rawAuth.trim();
  if (token !== String(need).trim()) {
    return new Response(
      JSON.stringify({
        error: {
          type: 'authentication_error',
          message: 'Missing or invalid Authorization header.',
          code: 'invalid_api_key',
        },
      }),
      {
        status: 401,
        headers: { 'content-type': 'application/json', 'www-authenticate': 'Bearer' },
      }
    );
  }
  return null;
}

export function requireAuth(context) {
  return checkAuth(context?.request, context?.env);
}

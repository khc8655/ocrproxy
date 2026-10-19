/**
 * lib/headers.js — client request headers relayed upstream unchanged.
 *
 * Pure relay: everything the client sent (anthropic-beta, user-agent,
 * x-stainless-*, session ids, ...) reaches the upstream, EXCEPT hop-by-hop /
 * framing headers, credentials (the proxy sets the upstream key itself),
 * client identity / network metadata, and OpenAI org/project ids that belong
 * to another account.  Proxy-owned headers and adapter inject_headers are
 * applied after these and override them.
 */
const DENY = new Set([
  'host', 'content-length', 'content-type', 'transfer-encoding', 'connection',
  'keep-alive', 'proxy-authorization', 'proxy-authenticate', 'proxy-connection',
  'te', 'trailer', 'trailers', 'upgrade', 'expect', 'accept-encoding',
  'authorization', 'x-api-key', 'api-key', 'x-goog-api-key', 'cookie',
  'origin', 'referer', 'forwarded', 'via', 'x-real-ip', 'true-client-ip',
  'openai-organization', 'openai-project',
]);
const DENY_PREFIXES = ['x-forwarded-', 'cf-', 'eo-', 'x-edgeone-', 'sec-', 'x-proxy-'];

export function clientPassthroughHeaders(request) {
  const out = {};
  try {
    if (!request || !request.headers || typeof request.headers.forEach !== 'function') return out;
    request.headers.forEach((value, key) => {
      const k = String(key).toLowerCase();
      if (DENY.has(k)) return;
      if (DENY_PREFIXES.some((p) => k.startsWith(p))) return;
      out[k] = value;
    });
  } catch (_) {
    return {};
  }
  return out;
}

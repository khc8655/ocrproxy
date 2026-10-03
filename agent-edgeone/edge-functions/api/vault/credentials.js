/**
 * api/vault/credentials.js — Pure credential retrieval endpoint for MCP Servers and external microservices.
 *
 *   POST /api/vault/credentials
 *   Body: { provider: string, key_label?: string, keys?: string[] }
 *   Returns: Pure credentials only (base_url, key, project_id, etc.) without gateway adapter_rules.
 */
import { onRequestPost as handleFetch } from './fetch.js';

export async function onRequestPost(context) {
  let body = {};
  try {
    const text = await context.request.clone().text();
    if (text) body = JSON.parse(text);
  } catch (_) {}

  // Enforce credentials_only = true for MCP servers
  body.credentials_only = true;

  const newRequest = new Request(context.request.url, {
    method: 'POST',
    headers: context.request.headers,
    body: JSON.stringify(body),
  });

  return handleFetch({ ...context, request: newRequest });
}

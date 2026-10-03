/**
 * api/vault/credentials.js — Pure credential retrieval endpoint for MCP Servers and external microservices.
 *
 *   POST /api/vault/credentials
 *   Body: { provider: string, key_label?: string, keys?: string[] }
 *   Returns: Pure credentials only (base_url, key, project_id, etc.) without gateway adapter_rules.
 */
import { handleVaultFetch } from './fetch.js';

export async function onRequestPost(context) {
  return handleVaultFetch(context, { forceCredentialsOnly: true });
}

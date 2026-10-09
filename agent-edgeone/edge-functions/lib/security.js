/**
 * security.js — Core security primitives for EdgeOne functions.
 * 
 * Provides:
 * 1. Constant-time string comparison (mitigates timing attacks)
 * 2. Strict fail-closed authentication helpers for:
 *    - Client Proxy (/v1/*) -> PROXY_API_KEY only
 *    - Admin Management (/api/admin/*, /api/config, /api/test) -> ADMIN_PASSWORD only
 *    - Vault Sync Hub (/api/vault/*) -> VAULT_ACCESS_TOKEN or ADMIN_PASSWORD only (NEVER PROXY_API_KEY)
 * 3. SSRF Protection (blocks private IPs, link-local, cloud metadata, and loopback addresses)
 */

/**
 * Constant-time string comparison to prevent timing attacks.
 */
export function timingSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}

/**
 * Extract bearer token or raw api-key from request headers.
 */
export function extractAuthToken(request) {
  const rawAuth = request?.headers?.get('authorization') || request?.headers?.get('x-api-key') || '';
  return rawAuth.toLowerCase().startsWith('bearer ') ? rawAuth.slice(7).trim() : rawAuth.trim();
}

/**
 * Standard JSON response helper for auth failures.
 */
function authErrorResponse(status, type, code, message) {
  return new Response(
    JSON.stringify({
      error: {
        type,
        code,
        message,
      },
    }),
    {
      status,
      headers: {
        'content-type': 'application/json',
        ...(status === 401 ? { 'www-authenticate': 'Bearer' } : {}),
      },
    }
  );
}

/**
 * Role 1: Client Proxy Auth (for /v1/* endpoints).
 * Requires PROXY_API_KEY (or ADMIN_PASSWORD as superadmin). Fail-closed if unconfigured.
 */
export function checkClientAuth(request, env, config) {
  const proxyKey = (env?.PROXY_API_KEY || config?.proxy_api_key) ? String(env?.PROXY_API_KEY || config?.proxy_api_key).trim() : '';
  const adminPass = env?.ADMIN_PASSWORD ? String(env.ADMIN_PASSWORD).trim() : '';

  if (!proxyKey && !adminPass) {
    return authErrorResponse(
      503,
      'configuration_error',
      'proxy_key_unconfigured',
      'Server misconfiguration: Neither PROXY_API_KEY nor ADMIN_PASSWORD is configured in EdgeOne environment variables. Requests are blocked in fail-closed mode.'
    );
  }

  const token = extractAuthToken(request);
  if (!token) {
    return authErrorResponse(401, 'authentication_error', 'missing_api_key', 'Missing Authorization header.');
  }

  if (proxyKey && timingSafeEqual(token, proxyKey)) {
    return null; // Authorized
  }
  if (adminPass && timingSafeEqual(token, adminPass)) {
    return null; // Superadmin access to client proxy
  }

  return authErrorResponse(401, 'authentication_error', 'invalid_api_key', 'Invalid client API key.');
}

/**
 * Role 2: Admin Console Auth (for /api/admin/*, /api/config, /api/test).
 * Strictly requires ADMIN_PASSWORD. Fail-closed if unconfigured.
 * PROXY_API_KEY is EXPLICITLY FORBIDDEN from accessing admin APIs.
 */
export function checkAdminAuth(request, env) {
  const adminPass = env?.ADMIN_PASSWORD ? String(env.ADMIN_PASSWORD).trim() : '';

  if (!adminPass) {
    return authErrorResponse(
      503,
      'configuration_error',
      'admin_password_unconfigured',
      'Server misconfiguration: ADMIN_PASSWORD is not configured in EdgeOne environment variables. Admin APIs are blocked in fail-closed mode.'
    );
  }

  const token = extractAuthToken(request);
  if (!token) {
    return authErrorResponse(401, 'authentication_error', 'missing_credentials', 'Missing Authorization header for admin access.');
  }

  if (timingSafeEqual(token, adminPass)) {
    return null; // Authorized
  }

  return authErrorResponse(401, 'authentication_error', 'invalid_credentials', 'Invalid admin password.');
}

/**
 * Role 3: Vault Access Auth (for /api/vault/* endpoints).
 * Strictly requires VAULT_ACCESS_TOKEN (or ADMIN_PASSWORD as master fallback).
 * PROXY_API_KEY is EXPLICITLY FORBIDDEN from accessing the secret Vault.
 */
export function checkVaultAuth(request, env) {
  const vaultToken = env?.VAULT_ACCESS_TOKEN ? String(env.VAULT_ACCESS_TOKEN).trim() : '';
  const adminPass = env?.ADMIN_PASSWORD ? String(env.ADMIN_PASSWORD).trim() : '';

  if (!vaultToken && !adminPass) {
    return authErrorResponse(
      503,
      'configuration_error',
      'vault_unconfigured',
      'Server misconfiguration: Neither VAULT_ACCESS_TOKEN nor ADMIN_PASSWORD is configured. Vault access is blocked in fail-closed mode.'
    );
  }

  const token = extractAuthToken(request);
  if (!token) {
    return authErrorResponse(401, 'authentication_error', 'missing_vault_token', 'Missing Authorization header for Vault access.');
  }

  if (vaultToken && timingSafeEqual(token, vaultToken)) {
    return null; // Authorized
  }
  if (adminPass && timingSafeEqual(token, adminPass)) {
    return null; // Authorized
  }

  return authErrorResponse(401, 'authentication_error', 'invalid_vault_token', 'Invalid Vault access token.');
}

/**
 * SSRF Protection: Validate that target URL is a safe public endpoint.
 * Blocks:
 * - Non-HTTP/HTTPS protocols (e.g. file:, gopher:, dict:, ftp:)
 * - Loopback addresses (127.0.0.0/8, localhost, ::1)
 * - Private RFC1918 networks (10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16)
 * - Link-local & Cloud Metadata services (169.254.0.0/16)
 * - Broadcast & unspecified (0.0.0.0/8, 255.255.255.255)
 */
export function validateUpstreamUrl(urlStr) {
  if (!urlStr || typeof urlStr !== 'string') {
    return { ok: false, error: 'URL 不能为空' };
  }

  let parsed;
  try {
    parsed = new URL(urlStr.trim());
  } catch (e) {
    return { ok: false, error: `非法的 URL 格式: ${e.message}` };
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, error: `不支持的协议: ${parsed.protocol}，仅允许 HTTP / HTTPS` };
  }

  const rawHost = parsed.hostname.toLowerCase();
  const cleanHost = rawHost.replace(/^\[|\]$/g, '');

  // Localhost & loopback names
  if (
    cleanHost === 'localhost' ||
    cleanHost === '127.0.0.1' ||
    cleanHost === '::1' ||
    cleanHost === '0.0.0.0' ||
    cleanHost.endsWith('.localhost') ||
    cleanHost.endsWith('.local')
  ) {
    return { ok: false, error: '安全拦截：禁止请求本地回环地址 (SSRF Protection)' };
  }

  // IPv6 ULA (fc00::/7) and Link-Local (fe80::/10)
  if (cleanHost.startsWith('fc') || cleanHost.startsWith('fd') || cleanHost.startsWith('fe80')) {
    return { ok: false, error: '安全拦截：禁止请求 IPv6 私有或链路本地地址 (SSRF Protection)' };
  }

  // IPv4 Range Checks
  const ipv4Regex = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
  const match = cleanHost.match(ipv4Regex);
  if (match) {
    const o1 = Number(match[1]);
    const o2 = Number(match[2]);
    const o3 = Number(match[3]);
    const o4 = Number(match[4]);

    if (o1 > 255 || o2 > 255 || o3 > 255 || o4 > 255) {
      return { ok: false, error: '非法的 IP 地址格式' };
    }

    if (o1 === 0) {
      return { ok: false, error: '安全拦截：禁止请求 0.0.0.0/8 未指定网段' };
    }
    if (o1 === 127) {
      return { ok: false, error: '安全拦截：禁止请求 127.0.0.0/8 本地回环网段' };
    }
    if (o1 === 10) {
      return { ok: false, error: '安全拦截：禁止请求 10.0.0.0/8 私有私网地址' };
    }
    if (o1 === 172 && o2 >= 16 && o2 <= 31) {
      return { ok: false, error: '安全拦截：禁止请求 172.16.0.0/12 私有私网地址' };
    }
    if (o1 === 192 && o2 === 168) {
      return { ok: false, error: '安全拦截：禁止请求 192.168.0.0/16 私有私网地址' };
    }
    if (o1 === 169 && o2 === 254) {
      return { ok: false, error: '安全拦截：禁止请求 169.254.0.0/16 云元数据/链路本地地址' };
    }
  }

  return { ok: true, url: parsed.toString() };
}

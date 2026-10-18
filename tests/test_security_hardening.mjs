import test from 'node:test';
import assert from 'node:assert/strict';

import {
  timingSafeEqual,
  checkClientAuth,
  checkAdminAuth,
  checkVaultAuth,
  validateUpstreamUrl,
} from '../agent-edgeone/edge-functions/lib/security.js';

import onRequestCheckIp from '../agent-edgeone/edge-functions/check-ip.js';
import { onRequestGet as onRequestDebug } from '../agent-edgeone/edge-functions/api/debug.js';

test('Security Hardening — timingSafeEqual', () => {
  assert.equal(timingSafeEqual('secret_token_123', 'secret_token_123'), true);
  assert.equal(timingSafeEqual('secret_token_123', 'secret_token_456'), false);
  assert.equal(timingSafeEqual('short', 'longer_string'), false);
  assert.equal(timingSafeEqual('', ''), true);
  assert.equal(timingSafeEqual(null, 'abc'), false);
});

test('Security Hardening — Fail-Closed baseline (unconfigured secrets return 503)', async () => {
  const dummyReq = new Request('https://api.example.com/api/test', {
    headers: { authorization: 'Bearer some_token' },
  });

  // 1. Client proxy with no secrets
  const clientRes = checkClientAuth(dummyReq, {});
  assert.ok(clientRes);
  assert.equal(clientRes.status, 503);
  const clientBody = await clientRes.json();
  assert.equal(clientBody.error.code, 'proxy_key_unconfigured');

  // 2. Admin APIs with no secrets
  const adminRes = checkAdminAuth(dummyReq, {});
  assert.ok(adminRes);
  assert.equal(adminRes.status, 503);
  const adminBody = await adminRes.json();
  assert.equal(adminBody.error.code, 'admin_password_unconfigured');

  // 3. Vault APIs with no secrets
  const vaultRes = checkVaultAuth(dummyReq, {});
  assert.ok(vaultRes);
  assert.equal(vaultRes.status, 503);
  const vaultBody = await vaultRes.json();
  assert.equal(vaultBody.error.code, 'vault_unconfigured');
});

test('Security Hardening — Three-Role Privilege Separation (No PROXY_API_KEY elevation)', async () => {
  const env = {
    PROXY_API_KEY: 'client-key-sk-999',
    ADMIN_PASSWORD: 'admin-password-secret-777',
    VAULT_ACCESS_TOKEN: 'vault-sync-token-555',
  };

  const clientReq = new Request('https://api.example.com/v1/chat/completions', {
    headers: { authorization: 'Bearer client-key-sk-999' },
  });
  const adminReq = new Request('https://api.example.com/api/config', {
    headers: { authorization: 'Bearer admin-password-secret-777' },
  });
  const vaultReq = new Request('https://api.example.com/api/vault/fetch', {
    headers: { authorization: 'Bearer vault-sync-token-555' },
  });

  // 1. Client key accesses client proxy -> ALLOWED (returns null)
  assert.equal(checkClientAuth(clientReq, env), null);

  // 2. Client key tries to access admin config -> STRICTLY REJECTED 401
  const breachAdmin = checkAdminAuth(clientReq, env);
  assert.ok(breachAdmin);
  assert.equal(breachAdmin.status, 401);
  const breachAdminBody = await breachAdmin.json();
  assert.equal(breachAdminBody.error.code, 'invalid_credentials');

  // 3. Client key tries to access Vault secret -> STRICTLY REJECTED 401
  const breachVault = checkVaultAuth(clientReq, env);
  assert.ok(breachVault);
  assert.equal(breachVault.status, 401);
  const breachVaultBody = await breachVault.json();
  assert.equal(breachVaultBody.error.code, 'invalid_vault_token');

  // 3b. Admin password tries to access Vault secret -> STRICTLY REJECTED 401 (Strict 3-Role Separation)
  const adminBreachVault = checkVaultAuth(adminReq, env);
  assert.ok(adminBreachVault);
  assert.equal(adminBreachVault.status, 401);
  const adminBreachVaultBody = await adminBreachVault.json();
  assert.equal(adminBreachVaultBody.error.code, 'invalid_vault_token');

  // 4. Admin password accesses admin config -> ALLOWED
  assert.equal(checkAdminAuth(adminReq, env), null);

  // 5. Vault token accesses vault -> ALLOWED
  assert.equal(checkVaultAuth(vaultReq, env), null);
});

test('Security Hardening — SSRF Protection (Block private IPs and cloud metadata)', () => {
  // Loopback / Localhost
  assert.equal(validateUpstreamUrl('http://127.0.0.1/models').ok, false);
  assert.equal(validateUpstreamUrl('http://localhost:8080/v1').ok, false);
  assert.equal(validateUpstreamUrl('http://sub.localhost/').ok, false);
  assert.equal(validateUpstreamUrl('http://[::1]/models').ok, false);

  // Private RFC1918
  assert.equal(validateUpstreamUrl('http://10.0.0.1/v1/models').ok, false);
  assert.equal(validateUpstreamUrl('https://172.16.5.20/chat').ok, false);
  assert.equal(validateUpstreamUrl('http://172.31.255.255/').ok, false);
  assert.equal(validateUpstreamUrl('http://192.168.1.1/admin').ok, false);

  // Cloud Metadata / Link-local (169.254.x.x)
  assert.equal(validateUpstreamUrl('http://169.254.169.254/latest/meta-data').ok, false);

  // Disallowed non-HTTP protocols
  assert.equal(validateUpstreamUrl('file:///etc/passwd').ok, false);
  assert.equal(validateUpstreamUrl('gopher://127.0.0.1:6379').ok, false);

  // Legitimate Public Endpoints -> ALLOWED
  assert.equal(validateUpstreamUrl('https://api.openai.com/v1').ok, true);
  assert.equal(validateUpstreamUrl('https://generativelanguage.googleapis.com/v1beta/openai').ok, true);
  assert.equal(validateUpstreamUrl('https://api.siliconflow.cn').ok, true);
  assert.equal(validateUpstreamUrl('https://api.deepseek.com/v1').ok, true);
});

test('Security Hardening — /check-ip permanently disabled', async () => {
  const res = await onRequestCheckIp();
  assert.equal(res.status, 404);
  const data = await res.json();
  assert.equal(data.error.code, 'endpoint_disabled');
});

test('Security Hardening — /api/debug strictly requires ADMIN_PASSWORD and strips env_keys', async () => {
  const env = {
    PROXY_API_KEY: 'client-key-sk-999',
    ADMIN_PASSWORD: 'admin-password-secret-777',
    SECRET_KEY_ONE: 'foo',
    SECRET_KEY_TWO: 'bar',
  };

  // Client key tries to access debug -> BLOCKED 401
  const clientReq = new Request('https://api.example.com/api/debug', {
    headers: { authorization: 'Bearer client-key-sk-999' },
  });
  const blockedRes = await onRequestDebug({ env, request: clientReq });
  assert.equal(blockedRes.status, 401);

  // Admin password accesses debug -> ALLOWED 200, env_keys STRIPPED
  const adminReq = new Request('https://api.example.com/api/debug', {
    headers: { authorization: 'Bearer admin-password-secret-777' },
  });
  const okRes = await onRequestDebug({ env, request: adminReq });
  assert.equal(okRes.status, 200);
  const body = await okRes.json();
  assert.equal(body.env_keys, undefined, 'env_keys must NOT be exposed in /api/debug');
});

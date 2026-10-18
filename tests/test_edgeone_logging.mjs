/**
 * Test suite for EdgeOne unified logging and secret redaction.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { maskSecret, sanitizeMeta, edgeLogger } from '../agent-edgeone/edge-functions/lib/logger.js';

test('EdgeOne Logger — maskSecret', () => {
  assert.equal(maskSecret(null), '');
  assert.equal(maskSecret(''), '');
  assert.equal(maskSecret('123'), '****');
  assert.equal(maskSecret('12345678'), '****');

  const skKey = 'sk-proj-1234567890abcdef1234';
  const maskedSk = maskSecret(skKey);
  assert.equal(maskedSk.startsWith('sk-proj'), true);
  assert.equal(maskedSk.endsWith('1234'), true);
  assert.equal(maskedSk.includes('****'), true);
  assert.equal(maskedSk.includes('1234567890abcdef'), false);

  const token = 'secret_password_token_here';
  const maskedToken = maskSecret(token);
  assert.equal(maskedToken, 'secr****here');
});

test('EdgeOne Logger — sanitizeMeta', () => {
  const meta = {
    key: 'sk-1234567890',
    api_key: 'my-secret-key',
    password: 'super-secret-admin-pass',
    token: 'bearer-token-val',
    normal_field: 'deepseek-chat',
    bearer_header: 'Bearer raw_token_secret',
    long_body: 'x'.repeat(600),
  };
  const clean = sanitizeMeta(meta);
  assert.equal(clean.key, '[REDACTED_SECRET]');
  assert.equal(clean.api_key, '[REDACTED_SECRET]');
  assert.equal(clean.password, '[REDACTED_SECRET]');
  assert.equal(clean.token, '[REDACTED_SECRET]');
  assert.equal(clean.normal_field, 'deepseek-chat');
  assert.equal(clean.bearer_header, 'Bearer [REDACTED_SECRET]');
  assert.equal(clean.long_body.endsWith('...[TRUNCATED]'), true);
});

test('EdgeOne Logger — edgeLogger output capture', (t) => {
  const errLogs = [];
  const origError = console.error;
  console.error = (msg) => errLogs.push(msg);

  try {
    edgeLogger.error('AuthError', 'Invalid admin password rejected', {
      ip: '1.2.3.4',
      password: 'mypassword123',
    });

    assert.equal(errLogs.length, 1);
    assert.equal(errLogs[0].startsWith('[EdgeOne:AuthError] Invalid admin password rejected |'), true);
    assert.equal(errLogs[0].includes('ip=1.2.3.4'), true);
    assert.equal(errLogs[0].includes('password=[REDACTED_SECRET]'), true);
    assert.equal(errLogs[0].includes('mypassword123'), false);
  } finally {
    console.error = origError;
  }
});

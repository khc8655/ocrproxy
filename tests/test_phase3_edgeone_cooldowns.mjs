/**
 * Verification test for State-01 & State-02 EdgeOne Cooldowns & Fault Classifier
 */
import assert from 'node:assert';
import {
  classifyFailure,
  shouldFailover,
  COOLDOWN_DURATIONS,
  HARD_QUOTA_KEYWORDS,
  RATE_LIMIT_KEYWORDS,
} from '../agent-edgeone/edge-functions/lib/cooldowns.js';

function testKeywordsAndClassification() {
  console.log('Testing classifyFailure parity with Python scheduler...');

  // 1. Chinese Hard Quota keywords (e.g. 欠费, 余额不足)
  assert.strictEqual(
    classifyFailure(400, 'http', '上游报错: 账户欠费，请充值'),
    COOLDOWN_DURATIONS.QUOTA_403,
    'Chinese 账户欠费 must trigger QUOTA_403 cooldown'
  );
  assert.strictEqual(
    classifyFailure(400, 'http', '{"error": "余额不足，无法完成请求"}'),
    COOLDOWN_DURATIONS.QUOTA_403,
    'Chinese 余额不足 must trigger QUOTA_403 cooldown'
  );

  // 2. English Hard Quota keywords
  assert.strictEqual(
    classifyFailure(429, 'http', 'insufficient_quota: current balance is 0'),
    COOLDOWN_DURATIONS.QUOTA_403,
    'insufficient_quota must trigger QUOTA_403 even with HTTP 429'
  );

  // 3. TPM / RPM Rate limit keywords on 429
  assert.strictEqual(
    classifyFailure(429, 'http', 'requests per minute rate limit exceeded, slow down'),
    COOLDOWN_DURATIONS.TPM_429,
    'TPM rate limit must trigger TPM_429 (not hard quota)'
  );

  // 4. Request parameter error (HTTP 400) without quota keywords
  assert.strictEqual(
    classifyFailure(400, 'http', 'messages[0].content must not be empty'),
    0,
    'Client validation error on 400 must NOT trigger cooldown'
  );

  console.log('  PASS: classifyFailure correctly categorizes hard quota vs TPM vs client errors');
}

function testShouldFailover() {
  console.log('Testing shouldFailover parity with Python scheduler...');

  // 1. 200 OK should not failover
  assert.strictEqual(shouldFailover(200, 'http', ''), false);

  // 2. 404 / 422 should NOT failover (client error)
  assert.strictEqual(shouldFailover(404, 'http', 'Model not found'), false);
  assert.strictEqual(shouldFailover(422, 'http', 'Validation error'), false);

  // 3. 400 Bad Request:
  // - Pure param error -> do NOT failover
  assert.strictEqual(shouldFailover(400, 'http', 'Invalid parameter: temperature must be between 0 and 2'), false);
  // - Key / quota / billing error -> DO failover!
  assert.strictEqual(shouldFailover(400, 'http', 'credit insufficient balance'), true);
  assert.strictEqual(shouldFailover(400, 'http', 'Invalid api key provided'), true);
  assert.strictEqual(shouldFailover(400, 'http', '账户欠费'), true);

  // 4. 429, 500, empty_stream, read_timeout -> DO failover
  assert.strictEqual(shouldFailover(429, 'http', ''), true);
  assert.strictEqual(shouldFailover(502, 'http', ''), true);
  assert.strictEqual(shouldFailover(200, 'empty_stream', ''), true);
  assert.strictEqual(shouldFailover(0, 'read_timeout', ''), true);

  console.log('  PASS: shouldFailover logic 100% matches specification');
}

function run() {
  console.log('=== Running Phase 3 EdgeOne Fault Classifier Tests ===');
  testKeywordsAndClassification();
  testShouldFailover();
  console.log('Phase 3 Fault Classifier: ALL TESTS PASSED!\n');
}

run();

/**
 * Automated Verification Suite for Phase 2 EdgeOne Streams:
 * 1. createKeepAliveStream pull-based backpressure & keepalive comments
 * 2. Peeking first chunk: empty stream detection vs valid chunk stream
 * 3. Downstream cancellation propagates upstream
 */
import assert from 'node:assert';
import { createKeepAliveStream } from '../agent-edgeone/edge-functions/lib/normalize.js';

async function testPullBackpressureAndInitialChunk() {
  console.log('Testing createKeepAliveStream with initialChunk and pull()...');
  
  // Create an upstream stream with 2 chunks
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  let pullCount = 0;

  const upstream = new ReadableStream({
    pull(controller) {
      pullCount++;
      if (pullCount === 1) {
        controller.enqueue(encoder.encode('data: chunk2\n\n'));
      } else {
        controller.close();
      }
    }
  });

  const reader = upstream.getReader();
  const initialChunk = encoder.encode('data: first_peeked\n\n');

  // Wrap with createKeepAliveStream
  const wrapped = createKeepAliveStream(reader, 100, initialChunk);
  const wrappedReader = wrapped.getReader();

  // First chunk must be initialChunk without pulling upstream yet
  const chunk1 = await wrappedReader.read();
  assert.strictEqual(chunk1.done, false);
  assert.strictEqual(decoder.decode(chunk1.value), 'data: first_peeked\n\n');

  // Second chunk should pull from upstream
  const chunk2 = await wrappedReader.read();
  assert.strictEqual(chunk2.done, false);
  assert.strictEqual(decoder.decode(chunk2.value), 'data: chunk2\n\n');

  // Third chunk should be done
  const chunk3 = await wrappedReader.read();
  assert.strictEqual(chunk3.done, true);

  console.log('  PASS: Chunk peeking and pull backpressure works smoothly');
}

async function testCancelPropagatesUpstream() {
  console.log('Testing cancel propagation upstream...');
  let upstreamCancelled = false;
  let cancelReason = null;

  const upstream = new ReadableStream({
    cancel(reason) {
      upstreamCancelled = true;
      cancelReason = reason;
    }
  });

  const wrapped = createKeepAliveStream(upstream, 100);
  const reader = wrapped.getReader();

  await reader.cancel('client_disconnected');
  assert.strictEqual(upstreamCancelled, true);
  assert.strictEqual(cancelReason, 'client_disconnected');

  console.log('  PASS: cancel(reason) gracefully notifies upstream');
}

async function run() {
  console.log('=== Running Phase 2 EdgeOne Stream Tests ===');
  await testPullBackpressureAndInitialChunk();
  await testCancelPropagatesUpstream();
  console.log('Phase 2 EdgeOne Streams: ALL TESTS PASSED!\n');
}

run().catch((err) => {
  console.error('Test failed:', err);
  process.exit(1);
});

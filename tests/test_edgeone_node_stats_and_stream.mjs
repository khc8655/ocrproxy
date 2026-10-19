// EdgeOne behaviour tests (real handlers, mocked upstream fetch + in-memory KV):
//  1. A real /v1/chat/completions and /v1/messages call is stored as the binding's
//     "last call" and returned by /api/admin/stats (model list badge + time),
//     not only manual tests. A 429 on one key shows on that key.
//  2. When the first upstream chunk is only an SSE comment (": ping") and the next
//     chunk arrives after the 300ms re-peek window, that chunk is NOT lost.
//  3. createKeepAliveStream uses one interval per stream, emits keep-alive only when idle.
//  4. GET / redirects to /admin (console bundle not shipped twice).
import { readFileSync } from 'node:fs';

const EF = new URL('../agent-edgeone/edge-functions/', import.meta.url);
const { onRequestPost: chatPost } = await import(new URL('v1/chat/completions.js', EF));
const { onRequestPost: messagesPost } = await import(new URL('v1/messages.js', EF));
const { onRequestGet: statsGet } = await import(new URL('api/admin/stats.js', EF));
const { createKeepAliveStream } = await import(new URL('lib/normalize.js', EF));
const { invalidateConfigCache } = await import(new URL('lib/config.js', EF));
const indexMod = await import(new URL('index.js', EF));

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log(`  PASS: ${name}`); }
  catch (e) { failed++; console.log(`  FAIL: ${name}\n    ${e?.stack || e}`); }
}
function assert(c, m) { if (!c) throw new Error(m || 'assertion failed'); }

function makeKV() {
  const data = new Map();
  return {
    data,
    async get(k) { return data.has(k) ? data.get(k) : null; },
    async put(k, v) { data.set(k, String(v)); },
    async delete(k) { data.delete(k); },
    async list() { return { keys: [...data.keys()].map((name) => ({ name })) }; },
  };
}

const enc = new TextEncoder();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Upstream stream: emits each [delayMs, text] in order.
function sseResponse(parts, status = 200) {
  let i = 0;
  const body = new ReadableStream({
    async pull(c) {
      if (i >= parts.length) { c.close(); return; }
      const [d, t] = parts[i++];
      if (d) await sleep(d);
      c.enqueue(enc.encode(t));
    },
  });
  return new Response(body, { status, headers: { 'content-type': 'text/event-stream' } });
}

async function setup(cfg) {
  const kv = makeKV();
  await kv.put('config', JSON.stringify(cfg));
  invalidateConfigCache();
  const waits = [];
  const env = { ADMIN_PASSWORD: 'adm', PROXY_API_KEY: 'pk', agent_kv: kv };
  const ctx = (request) => ({ request, env, waitUntil: (p) => waits.push(p) });
  return { kv, env, ctx, flush: () => Promise.all(waits.splice(0)) };
}

const CFG = {
  providers: { up: { base_url: 'https://up.example/v1', anthropic_base_url: 'https://up.example/v1',
                     protocols: ['chat', 'messages'], keys: { k1: 'sk-1', k2: 'sk-2' } } },
  agent_models: { claude: { upstream_model: 'claude-up', keys: [{ provider: 'up', key: 'k1' }, { provider: 'up', key: 'k2' }] } },
};

function chatReq(stream = true) {
  return new Request('https://eo.example/v1/chat/completions', {
    method: 'POST', headers: { authorization: 'Bearer pk', 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'claude', stream, messages: [{ role: 'user', content: 'hi' }] }),
  });
}
async function stats(ctx) {
  const r = await statsGet(ctx(new Request('https://eo.example/api/admin/stats', { headers: { authorization: 'Bearer adm' } })));
  return (await r.json()).candidates_status;
}

const realFetch = globalThis.fetch;
console.log('=== EdgeOne: real-call node stats / stream re-peek / keep-alive ===');

await test('real streaming chat call is shown as the binding\'s last call (status, latency, time)', async () => {
  const { ctx, flush } = await setup(CFG);
  globalThis.fetch = async () => sseResponse([[30, 'data: {"choices":[{"delta":{"content":"ok"}}]}\n\n'], [0, 'data: [DONE]\n\n']]);
  try {
    const before = Date.now();
    const r = await chatPost(ctx(chatReq()));
    assert(r.status === 200, `status ${r.status}`);
    await r.text();
    await flush();
    const s = (await stats(ctx))['agent:claude:up:k1'];
    assert(s, 'no candidates_status entry for agent:claude:up:k1 after a real call');
    assert(s.status === 200, `status ${s.status}`);
    assert(s.latency_ms > 0, `latency ${s.latency_ms}`);
    assert(s.time >= before, 'time not set');
  } finally { globalThis.fetch = realFetch; }
});

await test('429 on k1 then success on k2: k1 shows 429, k2 shows 200', async () => {
  const { ctx, flush } = await setup(CFG);
  globalThis.fetch = async (url, opts) => {
    const auth = new Headers(opts?.headers).get('authorization');
    if (auth === 'Bearer sk-1') return new Response('{"error":{"message":"quota daily exceeded"}}', { status: 429, headers: { 'content-type': 'application/json' } });
    return new Response('{"choices":[{"message":{"content":"ok"}}]}', { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    const r = await chatPost(ctx(chatReq(false)));
    assert(r.status === 200, `status ${r.status}`);
    await r.text();
    await flush();
    const cs = await stats(ctx);
    assert(cs['agent:claude:up:k1']?.status === 429, JSON.stringify(cs));
    assert(cs['agent:claude:up:k2']?.status === 200, JSON.stringify(cs));
  } finally { globalThis.fetch = realFetch; }
});

await test('/v1/messages real call is recorded too', async () => {
  const { ctx, flush } = await setup(CFG);
  globalThis.fetch = async () => new Response('{"type":"message","content":[]}', { status: 200, headers: { 'content-type': 'application/json' } });
  try {
    const req = new Request('https://eo.example/v1/messages', {
      method: 'POST', headers: { authorization: 'Bearer pk', 'content-type': 'application/json', 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude', max_tokens: 5, messages: [{ role: 'user', content: 'hi' }] }),
    });
    const r = await messagesPost(ctx(req));
    assert(r.status === 200, `status ${r.status}`);
    await r.text();
    await flush();
    assert((await stats(ctx))['agent:claude:up:k1']?.status === 200, 'messages call not recorded');
  } finally { globalThis.fetch = realFetch; }
});

for (const [label, post, mkReq, dataLine] of [
  ['chat/completions', chatPost, () => chatReq(), 'data: {"choices":[{"delta":{"content":"FIRST-REAL-TOKEN"}}]}\n\n'],
  ['messages', messagesPost, () => new Request('https://eo.example/v1/messages', {
      method: 'POST', headers: { authorization: 'Bearer pk', 'content-type': 'application/json', 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude', stream: true, max_tokens: 5, messages: [{ role: 'user', content: 'hi' }] }) }),
    'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"text":"FIRST-REAL-TOKEN"}}\n\n'],
]) {
  await test(`${label}: chunk arriving after the 300ms re-peek window (first chunk ": ping") is not dropped`, async () => {
    const { ctx } = await setup(CFG);
    globalThis.fetch = async () => sseResponse([[0, ': ping\n\n'], [600, dataLine], [0, 'data: [DONE]\n\n']]);
    try {
      const r = await post(ctx(mkReq()));
      assert(r.status === 200, `status ${r.status}`);
      const text = await r.text();
      assert(text.includes('FIRST-REAL-TOKEN'), `first real chunk lost; client got: ${JSON.stringify(text)}`);
    } finally { globalThis.fetch = realFetch; }
  });
}

await test('keep-alive stream: one interval per stream, keep-alive only while idle, no chunk lost', async () => {
  const realSetInterval = globalThis.setInterval;
  let intervals = 0;
  globalThis.setInterval = (...a) => { intervals++; return realSetInterval(...a); };
  try {
    const parts = [[0, 'data: a\n\n'], [0, 'data: b\n\n'], [0, 'data: c\n\n'], [1000, 'data: d\n\n'], [0, 'data: [DONE]\n\n']];
    const up = sseResponse(parts).body;
    const out = await new Response(createKeepAliveStream(up, 300)).text();
    for (const x of ['a', 'b', 'c', 'd']) assert(out.includes(`data: ${x}\n\n`), `missing ${x}: ${out}`);
    assert(out.includes(': keep-alive'), 'no keep-alive during 1s idle gap');
    assert(intervals === 1, `expected 1 setInterval for the stream, got ${intervals}`);
  } finally { globalThis.setInterval = realSetInterval; }
});

await test('GET / redirects to /admin; index.js no longer duplicates the console bundle', async () => {
  const r = indexMod.onRequestGet({ request: new Request('https://eo.example/?token=x') });
  assert(r.status === 302 && r.headers.get('location') === '/admin?token=x', `${r.status} ${r.headers.get('location')}`);
  const size = readFileSync(new URL('index.js', EF)).length;
  assert(size < 2000, `index.js is ${size} bytes`);
});

console.log(`PASS: ${passed}\nFAIL: ${failed}`);
process.exit(failed ? 1 : 0);

#!/usr/bin/env node
/**
 * tests/contract/eo_local_server.mjs — run the EdgeOne edge-functions locally over real HTTP
 * so backend-contract tests can hit EdgeOne and VM with the same client code (and a real browser).
 *
 * File-based routing like EdgeOne Pages:  /a/b -> edge-functions/a/b.js | edge-functions/a/b/index.js,
 * "/" -> index.js; handler onRequest<Method> or onRequest. In-memory KV (bound as agent_kv),
 * context.waitUntil kept alive. Upstream fetch is the real Node fetch.
 *
 * Usage: node eo_local_server.mjs <port> <config.json path>
 * Env:   ADMIN_PASSWORD, PROXY_API_KEY (passed through as EdgeOne env)
 */
import http from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const EF = join(here, '..', '..', 'agent-edgeone', 'edge-functions');
const port = Number(process.argv[2] || 8788);
const cfgPath = process.argv[3];

// Test-harness "hosts file": EDGE_HOST_MAP="mock-upstream.example=127.0.0.1:1234" lets the EdgeOne
// code see a public-looking upstream (its SSRF guard rightly rejects loopback) while the bytes go to the mock.
const hostMap = Object.fromEntries((process.env.EDGE_HOST_MAP || '').split(',').filter(Boolean).map((x) => x.split('=')));
if (Object.keys(hostMap).length) {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (input, init) => {
    const u = new URL(typeof input === 'string' || input instanceof URL ? String(input) : input.url);
    if (hostMap[u.hostname]) {
      const [h, p] = hostMap[u.hostname].split(':');
      u.hostname = h; if (p) u.port = p;
      input = typeof input === 'string' || input instanceof URL ? u.toString() : new Request(u, input);
    }
    return realFetch(input, init);
  };
}

const data = new Map();
const kv = {
  async get(k, opts) {
    if (!data.has(k)) return null;
    const v = data.get(k);
    if (opts?.type === 'json' || opts === 'json') { try { return JSON.parse(v); } catch { return null; } }
    return v;
  },
  async put(k, v) { data.set(k, typeof v === 'string' ? v : JSON.stringify(v)); },
  async delete(k) { data.delete(k); },
  async list(opts = {}) {
    const p = opts.prefix || '';
    return { keys: [...data.keys()].filter((k) => k.startsWith(p)).map((name) => ({ name })), list_complete: true };
  },
};
if (cfgPath) data.set('config', readFileSync(cfgPath, 'utf8'));

const env = {
  ADMIN_PASSWORD: process.env.ADMIN_PASSWORD || 'adm',
  PROXY_API_KEY: process.env.PROXY_API_KEY || 'pk',
  agent_kv: kv,
};

const modCache = new Map();
async function resolveHandler(pathname) {
  const clean = pathname.replace(/\/+$/, '') || '/';
  const candidates = clean === '/'
    ? [join(EF, 'index.js')]
    : [join(EF, clean + '.js'), join(EF, clean, 'index.js')];
  for (const f of candidates) {
    if (existsSync(f)) {
      if (!modCache.has(f)) modCache.set(f, await import(pathToFileURL(f).href));
      return modCache.get(f);
    }
  }
  return null;
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://127.0.0.1:${port}`);
    const mod = await resolveHandler(url.pathname);
    const m = req.method.toUpperCase();
    const name = 'onRequest' + m[0] + m.slice(1).toLowerCase();
    const fn = mod && (mod[name] || mod.onRequest);
    if (!fn) { res.writeHead(404, { 'content-type': 'text/plain' }); res.end('not found'); return; }

    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = chunks.length ? Buffer.concat(chunks) : null;
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) headers.set(k, Array.isArray(v) ? v.join(', ') : v);
    const request = new Request(url, { method: m, headers, body: (m === 'GET' || m === 'HEAD') ? undefined : body });

    const waits = [];
    const context = { request, env, params: {}, waitUntil: (p) => waits.push(Promise.resolve(p).catch(() => {})) };
    const resp = await fn(context);
    const outHeaders = {};
    resp.headers.forEach((v, k) => { outHeaders[k] = v; });
    res.writeHead(resp.status, outHeaders);
    if (resp.body && m !== 'HEAD') {
      const reader = resp.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(Buffer.from(value));
      }
    }
    res.end();
    await Promise.all(waits);
  } catch (e) {
    console.error('[eo_local_server]', e?.stack || e);
    if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain' });
    res.end(String(e?.message || e));
  }
});
server.listen(port, '127.0.0.1', () => console.log(`eo_local_server listening on ${port}`));

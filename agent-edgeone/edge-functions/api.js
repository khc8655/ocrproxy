/**
 * api.js — Master API Router for EdgeOne
 * Handles all /api/* endpoints: /api/config, /api/state, /api/presets, /api/test, /api/debug
 */

import { onRequestGet as configGet, onRequestPut as configPut, onRequestDelete as configDelete } from './api/config.js';
import { onRequestGet as stateGet, onRequestDelete as stateDelete } from './api/state.js';
import { onRequestGet as presetsGet } from './api/presets.js';
import { onRequestPost as testPost, onRequestGet as testGet } from './api/test.js';
import { onRequestGet as debugGet } from './api/debug.js';

export async function onRequest(context) {
  const url = new URL(context.request.url);
  const pathname = url.pathname.replace(/\/+$/, '');
  const method = context.request.method.toUpperCase();

  // /api/test
  if (pathname === '/api/test') {
    if (method === 'POST') return testPost(context);
    return testGet(context);
  }

  // /api/config
  if (pathname === '/api/config') {
    if (method === 'GET') return configGet(context);
    if (method === 'PUT' || method === 'POST') return configPut(context);
    if (method === 'DELETE') return configDelete(context);
    return new Response(JSON.stringify({ error: 'Method Not Allowed' }), { status: 405 });
  }

  // /api/state
  if (pathname === '/api/state') {
    if (method === 'GET') return stateGet(context);
    if (method === 'DELETE') return stateDelete(context);
    return new Response(JSON.stringify({ error: 'Method Not Allowed' }), { status: 405 });
  }

  // /api/presets
  if (pathname === '/api/presets') {
    if (method === 'GET') return presetsGet(context);
    return new Response(JSON.stringify({ error: 'Method Not Allowed' }), { status: 405 });
  }

  // /api/debug
  if (pathname === '/api/debug') {
    if (method === 'GET') return debugGet(context);
    return new Response(JSON.stringify({ error: 'Method Not Allowed' }), { status: 405 });
  }

  return new Response(JSON.stringify({ error: `Unknown API endpoint: ${pathname}` }), {
    status: 404,
    headers: { 'content-type': 'application/json' },
  });
}

export default onRequest;
export { onRequest as onRequestGet, onRequest as onRequestPost, onRequest as onRequestPut, onRequest as onRequestDelete };

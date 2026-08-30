/**
 * v1.js — Master Router for all /v1/* endpoints on EdgeOne
 * Handles:
 *   - GET  /v1/models
 *   - POST /v1/chat/completions
 */

import { onRequestGet as modelsGet } from './v1/models.js';
import { onRequestPost as chatCompletionsPost } from './v1/chat/completions.js';

export async function onRequest(context) {
  const url = new URL(context.request.url);
  const pathname = url.pathname.replace(/\/+$/, '');
  const method = context.request.method.toUpperCase();

  // CORS preflight for /v1/*
  if (method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'access-control-allow-origin': '*',
        'access-control-allow-methods': 'GET, POST, PUT, DELETE, OPTIONS',
        'access-control-allow-headers': '*',
        'access-control-max-age': '86400',
      },
    });
  }

  // /v1/models
  if (pathname === '/v1/models' || pathname === '/v1/models/') {
    if (method === 'GET') return modelsGet(context);
    return new Response(JSON.stringify({ error: { message: 'Method Not Allowed', type: 'invalid_request_error' } }), {
      status: 405,
      headers: { 'content-type': 'application/json' },
    });
  }

  // /v1/chat/completions
  if (pathname === '/v1/chat/completions' || pathname === '/v1/chat/completions/') {
    if (method === 'POST') return chatCompletionsPost(context);
    return new Response(JSON.stringify({ error: { message: 'Method Not Allowed', type: 'invalid_request_error' } }), {
      status: 405,
      headers: { 'content-type': 'application/json' },
    });
  }

  return new Response(
    JSON.stringify({
      error: {
        message: `Invalid URL (GET / POST ${pathname})`,
        type: 'invalid_request_error',
        code: 'not_found',
      },
    }),
    {
      status: 404,
      headers: { 'content-type': 'application/json' },
    }
  );
}

export default onRequest;
export { onRequest as onRequestGet, onRequest as onRequestPost, onRequest as onRequestPut, onRequest as onRequestDelete, onRequest as onRequestOptions };

/**
 * v1/models.js — GET /v1/models
 *
 * Returns the list of real model names from the agent_models config.
 */

import {
  loadConfig,
  buildModelsList,
  ConfigError,
  resolveKvBinding,
} from '../lib/config.js';

export async function onRequestGet(context) {
  const { env } = context;

  // Optional auth
  const authNeeded = env?.PROXY_API_KEY;
  if (authNeeded) {
    const got = context.request.headers.get('authorization') || '';
    if (got !== `Bearer ${authNeeded}`) {
      return new Response(
        JSON.stringify({
          error: {
            type: 'authentication_error',
            message: 'Missing or invalid Authorization header.',
            code: 'invalid_api_key',
          },
        }),
        {
          status: 401,
          headers: {
            'content-type': 'application/json',
            'www-authenticate': 'Bearer',
          },
        }
      );
    }
  }

  let config;
  try {
    const kvRes = resolveKvBinding(context);
    config = await loadConfig(env, kvRes?.kv);
  } catch (e) {
    if (e instanceof ConfigError) {
      return new Response(
        JSON.stringify({ error: { type: 'config_error', message: e.message } }),
        { status: 500, headers: { 'content-type': 'application/json' } }
      );
    }
    throw e;
  }

  const body = buildModelsList(config);
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      'content-type': 'application/json',
      'cache-control': 'no-store',
    },
  });
}

export default onRequestGet;

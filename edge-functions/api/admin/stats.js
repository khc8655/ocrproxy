/**
 * api/admin/stats.js — Return lightweight runtime statistics and error logs for EdgeOne admin panel.
 */
import { requireAuth } from '../../lib/config.js';

function getEmptyStats() {
  return {
    ok: true,
    agent: {
      active_keys: {}
    },
    candidates_status: {},
    error_logs: [],
    requests_total: 0,
    success_rate: 1.0,
    timestamp: Date.now()
  };
}

export async function onRequestGet(context) {
  const authErr = requireAuth(context);
  if (authErr) return authErr;

  return new Response(JSON.stringify(getEmptyStats()), {
    status: 200,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store'
    }
  });
}

export async function onRequestPost(context) {
  const authErr = requireAuth(context);
  if (authErr) return authErr;

  return new Response(JSON.stringify(getEmptyStats()), {
    status: 200,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store'
    }
  });
}

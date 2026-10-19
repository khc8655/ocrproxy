/**
 * api/test.js — Test a single (provider, key) against its
 * upstream by probing /v1/models or /models.
 *
 *   POST /api/test
 *   Body: { provider: "name", key: "label" }
 *   Returns: { ok, upstream, status, latency_ms, body_preview }
 */

import {
  loadConfig,
  ConfigError,
  resolveKvBinding,
  checkAdminAuth,
  validateUpstreamUrl,
} from '../lib/config.js';
import { recordNodeStat } from '../lib/nodestats.js';

function checkAuth(request, env) {
  return checkAdminAuth(request, env);
}

export async function onRequestPost(context) {
  const authErr = checkAuth(context.request, context.env);
  if (authErr) return authErr;

  let bodyText;
  try {
    bodyText = await context.request.text();
  } catch (e) {
    return new Response(
      JSON.stringify({ error: { type: 'invalid_request_error', message: `Body read: ${e?.message || e}` } }),
      { status: 400, headers: { 'content-type': 'application/json' } }
    );
  }

  let body;
  try { body = JSON.parse(bodyText); }
  catch (e) {
    return new Response(
      JSON.stringify({ error: { type: 'invalid_request_error', message: `Invalid JSON: ${e?.message || e}` } }),
      { status: 400, headers: { 'content-type': 'application/json' } }
    );
  }
  const modelName = String(body?.model || body?.name || '').trim();
  const providerName = String(body?.provider || '').trim();
  const keyLabel = String(body?.key || '').trim();

  if (!modelName && (!providerName || !keyLabel)) {
    return new Response(
      JSON.stringify({ error: { type: 'invalid_request_error', message: 'Provide either "model" or both "provider" and "key".' } }),
      { status: 400, headers: { 'content-type': 'application/json' } }
    );
  }

  let config;
  let kv = null;
  try {
    const kvRes = resolveKvBinding(context);
    kv = kvRes?.kv || null;
    config = await loadConfig(context.env, kv);
  } catch (e) {
    if (e instanceof ConfigError) {
      return new Response(
        JSON.stringify({ error: { type: 'config_error', message: e.message } }),
        { status: 500, headers: { 'content-type': 'application/json' } }
      );
    }
    throw e;
  }

  const isSingleKeyProbe = Boolean(providerName && keyLabel);

  // --- Path A: Model-level parallel probe (when ONLY modelName is provided without specific key) ---
  if (modelName && !isSingleKeyProbe) {
    const entry = config.agent_models?.[modelName];
    if (!entry) {
      return new Response(
        JSON.stringify({ error: { type: 'not_found', message: `Model "${modelName}" not found in config.` } }),
        { status: 404, headers: { 'content-type': 'application/json' } }
      );
    }
    const bindings = entry.keys || [];
    const MAX_PROBE_BATCH = 60; // Stay under EdgeOne 64 fetch-per-invocation hard limit
    const PROBE_CONCURRENCY = 6; // Stay under EdgeOne 8 concurrent fetch hard limit
    const bindingsToProbe = bindings.slice(0, MAX_PROBE_BATCH);
    const providers = config.providers || {};

    const probeBinding = async (b) => {
      const p = providers[b.provider];
      if (!p) {
        return { provider: b.provider, key: b.key, ok: false, status: null, latency_ms: null, error: 'Provider not found' };
      }
      const apiKey = p.keys?.[b.key];
      if (!apiKey) {
        return { provider: b.provider, key: b.key, ok: false, status: null, latency_ms: null, error: 'Key not found' };
      }
      const baseUrl = (p.base_url || '').replace(/\/+$/, '');
      const url = baseUrl.endsWith('/v1') ? `${baseUrl}/chat/completions` : `${baseUrl}/v1/chat/completions`;
      const upstreamModel = b.upstream_model || entry.upstream_model || modelName;

      // Start timing right before dispatching fetch to eliminate queue latency
      const start = Date.now();
      try {
        const resp = await fetch(url, {
          method: 'POST',
          headers: {
            'authorization': `Bearer ${apiKey}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            model: upstreamModel,
            messages: [{ role: 'user', content: 'Hi' }],
            max_tokens: 16,
            stream: false,
          }),
          redirect: 'manual', // Prevent 301/302 from silently converting POST to GET and dropping body
          eo: {
            timeoutSetting: {
              connectTimeout: 5_000,
              readTimeout: 15_000,
              writeTimeout: 5_000,
            },
          },
        });
        const lat = Date.now() - start;

        // 3xx Redirection — Base URL misconfiguration
        if (resp.status >= 300 && resp.status < 400) {
          const loc = resp.headers.get('location') || '';
          return {
            provider: b.provider,
            key: b.key,
            ok: false,
            status: resp.status,
            latency_ms: lat,
            error: `Base URL 配置错误: 上游返回 HTTP ${resp.status} 重定向${loc ? ' (指向 ' + loc + ')' : ''}，请检查 Base URL 是否缺少 https 或路径有误`,
          };
        }

        const ok = resp.status >= 200 && resp.status < 300;
        let errText = null;
        if (!ok) {
          try {
            errText = (await resp.text()).slice(0, 200);
          } catch {}
        }
        return {
          provider: b.provider,
          key: b.key,
          ok,
          status: resp.status,
          latency_ms: lat,
          error: ok ? null : (errText || `HTTP ${resp.status}`),
        };
      } catch (e) {
        return {
          provider: b.provider,
          key: b.key,
          ok: false,
          status: null,
          latency_ms: Date.now() - start,
          error: e?.message || String(e),
        };
      }
    };

    // Worker pool: execute at most PROBE_CONCURRENCY simultaneous probes
    async function mapConcurrent(items, limit, fn) {
      const results = new Array(items.length);
      let nextIndex = 0;
      async function worker() {
        while (nextIndex < items.length) {
          const idx = nextIndex++;
          results[idx] = await fn(items[idx]);
        }
      }
      const workers = [];
      const count = Math.min(limit, items.length);
      for (let i = 0; i < count; i++) {
        workers.push(worker());
      }
      await Promise.all(workers);
      return results;
    }

    const results = await mapConcurrent(bindingsToProbe, PROBE_CONCURRENCY, probeBinding);
    const okCount = results.filter((r) => r.ok).length;
    // Store each probe as the binding's last call so the model list shows it to every admin session.
    await Promise.all(results.map((r) => (r && r.status) ? recordNodeStat(kv, {
      model: modelName, provider: r.provider, keyLabel: r.key, status: r.status, latencyMs: r.latency_ms,
    }, true) : null));

    return new Response(
      JSON.stringify({
        success: okCount > 0,
        model: modelName,
        total: results.length,
        ok: okCount,
        results,
        checked_at: new Date().toISOString(),
        truncated: bindings.length > MAX_PROBE_BATCH,
        total_bindings: bindings.length,
        ...(bindings.length > MAX_PROBE_BATCH ? { message: `单次探测已截断至前 ${MAX_PROBE_BATCH} 个候选以符合 EdgeOne 单请求 64 次 fetch 限制` } : {}),
      }),
      { status: 200, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } }
    );
  }

  // --- Path B: Single (provider, key) endpoint probe ---
  const provider = config.providers?.[providerName];
  if (!provider) {
    return new Response(
      JSON.stringify({ error: { type: 'not_found', message: `Provider "${providerName}" not in config.` } }),
      { status: 404, headers: { 'content-type': 'application/json' } }
    );
  }
  const apiKeyRaw = provider.keys?.[keyLabel];
  if (!apiKeyRaw) {
    return new Response(
      JSON.stringify({ error: { type: 'not_found', message: `Key "${keyLabel}" not in provider "${providerName}".` } }),
      { status: 404, headers: { 'content-type': 'application/json' } }
    );
  }
  const apiKey = (typeof apiKeyRaw === 'object' && apiKeyRaw !== null) ? (apiKeyRaw.key || '') : String(apiKeyRaw);
  const rawBaseUrl = (typeof apiKeyRaw === 'object' && apiKeyRaw !== null && apiKeyRaw.base_url)
    ? apiKeyRaw.base_url
    : (provider.base_url || '');
  const baseUrl = rawBaseUrl.replace(/\/+$/, '');
  if (!baseUrl) {
    return new Response(
      JSON.stringify({ error: { type: 'config_error', message: `Provider "${providerName}" has no base_url.` } }),
      { status: 500, headers: { 'content-type': 'application/json' } }
    );
  }

  // If a target model is specified, try probing chat completions directly first for accurate model latency
  const targetModel = String(body?.model || body?.target_model || '').trim();
  if (targetModel) {
    const chatUrl = baseUrl.endsWith('/v1') ? `${baseUrl}/chat/completions` : `${baseUrl}/v1/chat/completions`;
    try {
      const chatStart = Date.now();
      const chatResp = await fetch(chatUrl, {
        method: 'POST',
        headers: {
          'authorization': `Bearer ${apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: targetModel,
          messages: [{ role: 'user', content: 'hi' }],
          max_tokens: 4,
        }),
        redirect: 'manual',
        eo: { timeoutSetting: { connectTimeout: 8_000, readTimeout: 12_000, writeTimeout: 4_000 } },
      });
      if (chatResp && chatResp.status >= 200 && chatResp.status < 300) {
        const chatLatency = Date.now() - chatStart;
        const agentModel = String(body?.agent_model || '').trim();
        if (agentModel && config.agent_models?.[agentModel]) {
          await recordNodeStat(kv, {
            model: agentModel, provider: providerName, keyLabel, status: chatResp.status, latencyMs: chatLatency,
          }, true);
        }
        return new Response(JSON.stringify({
          ok: true,
          verdict: `model ${targetModel} verified`,
          upstream: baseUrl,
          status: chatResp.status,
          latency_ms: chatLatency,
        }), { status: 200, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
      }
    } catch (_) {}
  }

  // Probe upstream models endpoint
  const urlsToTry = [];
  if (baseUrl.endsWith('/v1')) {
    urlsToTry.push(`${baseUrl}/models`);
  } else {
    urlsToTry.push(`${baseUrl}/v1/models`);
    urlsToTry.push(`${baseUrl}/models`);
  }

  const start = Date.now();
  let resp = null;
  let finalUrl = urlsToTry[0];
  let lastErr = null;

  for (const url of urlsToTry) {
    finalUrl = url;
    try {
      resp = await fetch(url, {
        method: 'GET',
        headers: {
          'authorization': `Bearer ${apiKey}`,
          'accept': 'application/json',
        },
        redirect: 'manual',
        eo: {
          timeoutSetting: {
            connectTimeout: 8_000,
            readTimeout: 12_000,
            writeTimeout: 4_000,
          },
        },
      });
      if (resp && resp.status >= 300 && resp.status < 400) {
        const loc = resp.headers.get('location') || '';
        lastErr = new Error(`Base URL 配置错误: 上游返回 HTTP ${resp.status} 重定向${loc ? ' (指向 ' + loc + ')' : ''}，请检查 Base URL 是否缺少 https 或路径有误`);
        break;
      }
      if (resp && resp.status !== 404) {
        break; // found live endpoint
      }
    } catch (e) {
      lastErr = e;
    }
  }

  const latency = Date.now() - start;

  if (!resp) {
    return new Response(
      JSON.stringify({
        ok: false,
        upstream: baseUrl,
        status: 0,
        latency_ms: latency,
        error: `network_error: ${lastErr?.message || lastErr || 'timeout'}`,
      }),
      { status: 200, headers: { 'content-type': 'application/json' } }
    );
  }

  let respText = '';
  try {
    respText = (await resp.text()).slice(0, 500);
  } catch {}

  let ok = false;
  let verdict = '';
  if (resp.status >= 200 && resp.status < 300) {
    ok = true;
    verdict = 'reachable + key accepted';
  } else if (resp.status === 401 || resp.status === 403) {
    ok = false;
    verdict = 'key rejected (401/403)';
  } else if (resp.status === 429) {
    ok = false;
    verdict = 'rate-limited (429)';
  } else if (resp.status === 404) {
    ok = true; // endpoint reached but /models not implemented
    verdict = 'reachable, but /models not exposed (chat works)';
  } else {
    ok = false;
    verdict = `status ${resp.status}`;
  }

  return new Response(
    JSON.stringify({
      ok,
      verdict,
      upstream: baseUrl,
      status: resp.status,
      latency_ms: latency,
      body_preview: respText,
    }),
    { status: 200, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } }
  );
}

export async function onRequestGet(context) {
  return new Response(JSON.stringify({ message: 'POST /api/test with {provider, key} to probe.' }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

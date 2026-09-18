/**
 * api/admin/probe-models.js — Dynamically query upstream /v1/models endpoint.
 *
 *   POST /api/admin/probe-models
 *   Body: { base_url, api_key, provider }
 *   Returns: { ok: bool, models: string[], count: number, error: string|null }
 */

function checkAuth(request, env) {
  const need = env?.PROXY_API_KEY;
  if (!need) return null;
  const got = request.headers.get('authorization') || '';
  if (got !== `Bearer ${need}`) {
    return new Response(
      JSON.stringify({ error: { type: 'authentication_error', message: 'Missing or invalid Authorization header.', code: 'invalid_api_key' } }),
      { status: 401, headers: { 'content-type': 'application/json', 'www-authenticate': 'Bearer' } }
    );
  }
  return null;
}

function resolveModelsUrls(base) {
  const b = String(base || '').trim().replace(/\/+$/, '');
  const urls = [];
  if (b.endsWith('/v1')) {
    urls.push(`${b}/models`);
  } else {
    urls.push(`${b}/v1/models`);
    urls.push(`${b}/models`);
  }
  return urls;
}

export async function onRequestPost(context) {
  const authErr = checkAuth(context.request, context.env);
  if (authErr) return authErr;

  let body;
  try {
    const text = await context.request.text();
    body = JSON.parse(text);
  } catch (e) {
    return new Response(
      JSON.stringify({ ok: false, error: '请求体非合法 JSON' }),
      { status: 400, headers: { 'content-type': 'application/json' } }
    );
  }

  let { base_url, api_key, provider } = body || {};

  if (!base_url && provider) {
    const { loadConfig } = await import('../../lib/config.js');
    try {
      const cfg = await loadConfig(context.env);
      const p = cfg?.providers?.[provider];
      if (p) {
        base_url = p.base_url;
        if (!api_key && p.keys && typeof p.keys === 'object') {
          const firstKey = Object.values(p.keys)[0];
          if (firstKey) api_key = firstKey;
        }
      }
    } catch (_) {}
  }

  if (!base_url) {
    return new Response(
      JSON.stringify({ ok: false, error: 'base_url 不能为空且未找到对应供应商配置' }),
      { status: 400, headers: { 'content-type': 'application/json' } }
    );
  }

  const urls = resolveModelsUrls(base_url);
  let lastErr = null;
  const headers = {
    'accept': 'application/json',
    'user-agent': 'OCRProxy-ModelProber/1.0',
  };
  if (api_key) {
    headers['authorization'] = `Bearer ${String(api_key).trim()}`;
  }

  for (const url of urls) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 8000);
      const res = await fetch(url, {
        method: 'GET',
        headers,
        signal: controller.signal,
      });
      clearTimeout(timer);

      if (!res.ok) {
        lastErr = `上游 HTTP ${res.status}: ${res.statusText}`;
        continue;
      }

      const json = await res.json().catch(() => null);
      if (!json || typeof json !== 'object') {
        lastErr = '上游返回数据非有效 JSON';
        continue;
      }

      let rawList = [];
      if (Array.isArray(json.data)) {
        rawList = json.data;
      } else if (Array.isArray(json.models)) {
        rawList = json.models;
      } else if (Array.isArray(json)) {
        rawList = json;
      }

      const models = rawList
        .map(m => (typeof m === 'string' ? m : (m?.id || m?.name || '')))
        .filter(Boolean);

      // Unique and sort
      const uniqueModels = Array.from(new Set(models)).sort((a, b) => a.localeCompare(b));

      return new Response(
        JSON.stringify({
          ok: true,
          models: uniqueModels,
          count: uniqueModels.length,
          endpoint: url,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    } catch (err) {
      lastErr = err?.name === 'AbortError' ? '上游请求超时 (8s)' : (err?.message || String(err));
    }
  }

  return new Response(
    JSON.stringify({
      ok: false,
      models: [],
      count: 0,
      error: lastErr || '无法探测上游可用模型列表',
    }),
    { status: 200, headers: { 'content-type': 'application/json' } }
  );
}

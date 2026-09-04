/**
 * api/admin/verify-key.js — Protocol-aware single key online verification endpoint.
 *
 *   POST /api/admin/verify-key
 *   Body: { base_url, anthropic_base_url, api_key, provider, protocols: ['chat', 'messages'] }
 *   Returns: { valid: bool, protocols: { chat: {...}, messages: {...} }, error: string|null }
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

function joinUpstream(base, path) {
  const b = String(base || '').replace(/\/+$/, '');
  const p = String(path || '').replace(/^\/+/, '');
  if (p === 'models') {
    return b.endsWith('/v1') ? `${b}/models` : `${b}/v1/models`;
  }
  if (p === 'chat/completions') {
    return b.endsWith('/v1') ? `${b}/chat/completions` : `${b}/v1/chat/completions`;
  }
  return `${b}/${p}`;
}

function buildMessagesUpstream(base, anthropicBase, provider) {
  const p = String(provider || '').toLowerCase().trim();
  if (anthropicBase) {
    const ab = String(anthropicBase).replace(/\/+$/, '');
    return ab.endsWith('/messages') ? ab : (ab.endsWith('/v1') ? `${ab}/messages` : `${ab}/v1/messages`);
  }
  const b = String(base || '').replace(/\/+$/, '');
  if (p === 'minimax') {
    return 'https://api.minimax.cn/anthropic/v1/messages';
  }
  if (b.endsWith('/v1')) {
    return `${b}/messages`;
  }
  return `${b}/v1/messages`;
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
      JSON.stringify({ valid: false, error: '请求体解析失败，非合法 JSON' }),
      { status: 400, headers: { 'content-type': 'application/json' } }
    );
  }

  const baseUrl = String(body.base_url || '').trim();
  const apiKey = String(body.api_key || '').trim();
  if (!baseUrl || !apiKey) {
    return new Response(
      JSON.stringify({ valid: false, error: '缺少 base_url 或 api_key' }),
      { status: 400, headers: { 'content-type': 'application/json' } }
    );
  }

  const protocols = Array.isArray(body.protocols) && body.protocols.length > 0 ? body.protocols : ['chat'];
  const provider = String(body.provider || '').trim();
  const anthropicBaseUrl = body.anthropic_base_url ? String(body.anthropic_base_url).trim() : '';

  const results = {};
  let overallValid = true;
  const errorMsgs = [];

  // 1. OpenAI Chat protocol probe
  if (protocols.includes('chat')) {
    const startT = Date.now();
    try {
      const url = joinUpstream(baseUrl, 'models');
      const resp = await fetch(url, {
        method: 'GET',
        headers: {
          'authorization': `Bearer ${apiKey}`,
          'accept': 'application/json',
          'user-agent': 'ocrproxy-verifier/1.0',
        },
        eo: {
          timeoutSetting: {
            connectTimeout: 5_000,
            readTimeout: 10_000,
            writeTimeout: 5_000,
          },
        },
      });

      const lat = Date.now() - startT;
      if (resp.status >= 200 && resp.status < 300) {
        results['chat'] = { valid: true, status: resp.status, latency_ms: lat, message: '鉴权验证通过' };
      } else if (resp.status === 401 || resp.status === 403) {
        overallValid = false;
        const err = `密钥无效，上游拒绝访问 (HTTP ${resp.status})`;
        results['chat'] = { valid: false, status: resp.status, latency_ms: lat, error: err };
        errorMsgs.push(`OpenAI Chat: ${err}`);
      } else if (resp.status === 404 || resp.status === 405) {
        // Fallback: send minimal chat completion probe
        const chatUrl = joinUpstream(baseUrl, 'chat/completions');
        const chatResp = await fetch(chatUrl, {
          method: 'POST',
          headers: {
            'authorization': `Bearer ${apiKey}`,
            'content-type': 'application/json',
            'user-agent': 'ocrproxy-verifier/1.0',
          },
          body: JSON.stringify({
            model: 'test-key-probe',
            messages: [{ role: 'user', content: 'hi' }],
            max_tokens: 1,
          }),
          eo: {
            timeoutSetting: {
              connectTimeout: 5_000,
              readTimeout: 10_000,
              writeTimeout: 5_000,
            },
          },
        });
        const chatLat = Date.now() - startT;
        if (chatResp.status === 200 || chatResp.status === 201 || chatResp.status === 400 || chatResp.status === 404) {
          results['chat'] = { valid: true, status: chatResp.status, latency_ms: chatLat, message: '鉴权验证通过' };
        } else if (chatResp.status === 401 || chatResp.status === 403) {
          overallValid = false;
          const err = `密钥无效，上游拒绝访问 (HTTP ${chatResp.status})`;
          results['chat'] = { valid: false, status: chatResp.status, latency_ms: chatLat, error: err };
          errorMsgs.push(`OpenAI Chat: ${err}`);
        } else {
          overallValid = false;
          const err = `上游返回异常状态 (HTTP ${chatResp.status})`;
          results['chat'] = { valid: false, status: chatResp.status, latency_ms: chatLat, error: err };
          errorMsgs.push(`OpenAI Chat: ${err}`);
        }
      } else {
        overallValid = false;
        const err = `上游返回非预期响应 (HTTP ${resp.status})`;
        results['chat'] = { valid: false, status: resp.status, latency_ms: lat, error: err };
        errorMsgs.push(`OpenAI Chat: ${err}`);
      }
    } catch (e) {
      overallValid = false;
      const err = `无法连通上游服务器: ${e?.message || e}`;
      results['chat'] = { valid: false, status: 0, latency_ms: Date.now() - startT, error: err };
      errorMsgs.push(`OpenAI Chat: ${err}`);
    }
  }

  // 2. Anthropic Messages protocol probe
  if (protocols.includes('messages')) {
    const startT = Date.now();
    try {
      const msgUrl = buildMessagesUpstream(baseUrl, anthropicBaseUrl, provider);
      const pClean = provider.toLowerCase().replace(/[\.\-_]/g, '').trim();
      let probeModel = 'claude-3-5-sonnet-20241022';
      if (pClean === 'minimax') probeModel = 'MiniMax-M3';
      else if (pClean === 'bai') probeModel = 'qwen3.8-flash';
      else if (pClean === 'amd') probeModel = 'DeepSeek-V4-Flash';

      const resp = await fetch(msgUrl, {
        method: 'POST',
        headers: {
          'authorization': `Bearer ${apiKey}`,
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
          'user-agent': 'ocrproxy-verifier/1.0',
        },
        body: JSON.stringify({
          model: probeModel,
          max_tokens: 1,
          messages: [{ role: 'user', content: 'hi' }],
        }),
        eo: {
          timeoutSetting: {
            connectTimeout: 5_000,
            readTimeout: 10_000,
            writeTimeout: 5_000,
          },
        },
      });

      const lat = Date.now() - startT;
      const text = (await resp.text().catch(() => '')).toLowerCase();

      if (resp.status >= 200 && resp.status < 300) {
        results['messages'] = { valid: true, status: resp.status, latency_ms: lat, message: '鉴权验证通过' };
      } else if (resp.status === 401 || resp.status === 403) {
        overallValid = false;
        const err = `密钥无效，Anthropic 端点拒绝访问 (HTTP ${resp.status})`;
        results['messages'] = { valid: false, status: resp.status, latency_ms: lat, error: err };
        errorMsgs.push(`Anthropic Messages: ${err}`);
      } else if (resp.status === 400 || resp.status === 404) {
        if (text.includes('authentication') || text.includes('unauthorized') || text.includes('invalid_api_key') || text.includes('forbidden')) {
          overallValid = false;
          const err = `密钥认证失败 (HTTP ${resp.status})`;
          results['messages'] = { valid: false, status: resp.status, latency_ms: lat, error: err };
          errorMsgs.push(`Anthropic Messages: ${err}`);
        } else {
          results['messages'] = { valid: true, status: resp.status, latency_ms: lat, message: '端点鉴权通过' };
        }
      } else {
        overallValid = false;
        const err = `端点返回非预期响应 (HTTP ${resp.status})`;
        results['messages'] = { valid: false, status: resp.status, latency_ms: lat, error: err };
        errorMsgs.push(`Anthropic Messages: ${err}`);
      }
    } catch (e) {
      overallValid = false;
      const err = `无法连通 Anthropic 端点: ${e?.message || e}`;
      results['messages'] = { valid: false, status: 0, latency_ms: Date.now() - startT, error: err };
      errorMsgs.push(`Anthropic Messages: ${err}`);
    }
  }

  // 3. Responses protocol (future-proof)
  if (protocols.includes('responses')) {
    results['responses'] = { valid: true, status: 200, latency_ms: 1, message: '协议就绪 (未来支持)' };
  }

  return new Response(
    JSON.stringify({
      valid: overallValid,
      protocols: results,
      error: errorMsgs.length > 0 ? errorMsgs.join('；') : null,
    }),
    {
      status: 200,
      headers: {
        'content-type': 'application/json',
        'cache-control': 'no-store',
      },
    }
  );
}

export async function onRequestGet(context) {
  return new Response(JSON.stringify({ message: 'POST /api/admin/verify-key to verify credentials.' }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

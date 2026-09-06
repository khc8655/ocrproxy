// scripts/test-units.mjs
//
// Local unit tests for the pure-logic modules — runs on Node 18+.
// We don't need EdgeOne runtime to test these; the libs are pure ESM.
//
// Run with:  node scripts/test-units.mjs
// Exit 0 on success, non-zero on first failure.

import {
  loadConfig,
  listBindings,
  pickBinding,
  orderBindings,
  recordStickySuccess,
  resolveBinding,
  buildChatUrl,
  buildMessagesUrl,
  buildModelsList,
  ConfigError,
  sanitizeJsonString,
  validateConfig,
  resolveKvBinding,
  scanKvBindings,
  kvNotBoundResponse,
  KV_BINDING_CANDIDATES,
  DEFAULT_SETTINGS,
} from '../edge-functions/lib/config.js';
import { normaliseForProvider, rescueToolCallsFromText } from '../edge-functions/lib/normalize.js';
import {
  getCooldown,
  setCooldown,
  getCooldownsBatch,
  recordFailure,
  recordSuccess,
  classifyFailure,
  shouldFailover,
  bindingId,
  clearAllState,
  snapshotState,
  COOLDOWN_DURATIONS,
  CIRCUIT_BREAKER_THRESHOLD,
} from '../edge-functions/lib/cooldowns.js';
import { PRESETS, PRESET_MAP, getPreset } from '../edge-functions/lib/presets/index.js';

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  PASS  ${name}`);
    passed++;
  } catch (e) {
    console.log(`  FAIL  ${name}`);
    console.log(`        ${e?.message || e}`);
    if (e?.stack) console.log(e.stack.split('\n').slice(1, 4).join('\n'));
    failed++;
  }
}

function eq(a, b) {
  if (a !== b) throw new Error(`expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}
function deepEq(a, b) {
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    throw new Error(`expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
  }
}
function truthy(v) {
  if (!v) throw new Error(`expected truthy, got ${JSON.stringify(v)}`);
}

// ---- Sample config used by most tests -----------------------------------
const SAMPLE_CONFIG = {
  providers: {
    siliconflow: {
      base_url: 'https://api.siliconflow.cn',
      keys: { KeyA: 'sk-aaa', KeyB: 'sk-bbb' },
    },
    sensenova: {
      base_url: 'https://api.sensenova.cn/v1',
      keys: { self: 'sk-self' },
    },
  },
  agent_models: {
    'deepseek-v4-flash': {
      keys: [
        { provider: 'sensenova', key: 'self', upstream_model: 'DeepSeek-V3-Flash' },
      ],
    },
    'multi-key-model': {
      keys: [
        { provider: 'siliconflow', key: 'KeyA' },
        { provider: 'siliconflow', key: 'KeyB' },
        { provider: 'sensenova', key: 'self', upstream_model: 'deepseek-v3' },
      ],
    },
  },
};

console.log('== config.js ==');

// loadConfig: env JSON
test('loadConfig: reads from env.AGENT_CONFIG_JSON', async () => {
  const cfg = await loadConfig({ AGENT_CONFIG_JSON: JSON.stringify(SAMPLE_CONFIG) });
  deepEq(Object.keys(cfg.providers).sort(), ['sensenova', 'siliconflow']);
});

// loadConfig: missing config throws ConfigError
test('loadConfig: throws ConfigError when nothing is set', async () => {
  try {
    await loadConfig({});
    throw new Error('should have thrown');
  } catch (e) {
    if (!(e instanceof ConfigError)) throw new Error('expected ConfigError, got ' + e?.name);
  }
});

// loadConfig: missing fields throws ConfigError
test('loadConfig: throws ConfigError when providers is missing', async () => {
  try {
    await loadConfig({ AGENT_CONFIG_JSON: JSON.stringify({ agent_models: {} }) });
    throw new Error('should have thrown');
  } catch (e) {
    if (!(e instanceof ConfigError)) throw new Error('expected ConfigError, got ' + e?.name);
  }
});

// listBindings
test('listBindings: returns single binding for single-key model', () => {
  const b = listBindings(SAMPLE_CONFIG, 'deepseek-v4-flash');
  eq(b.length, 1);
  eq(b[0].provider, 'sensenova');
  eq(b[0].keyLabel, 'self');
  eq(b[0].upstreamModel, 'DeepSeek-V3-Flash');
});

test('listBindings: returns multiple bindings for multi-key model', () => {
  const b = listBindings(SAMPLE_CONFIG, 'multi-key-model');
  eq(b.length, 3);
});

test('listBindings: returns [] for unknown model', () => {
  eq(listBindings(SAMPLE_CONFIG, 'no-such-model').length, 0);
});

test('listBindings: drops bindings with missing provider', () => {
  const cfg = JSON.parse(JSON.stringify(SAMPLE_CONFIG));
  cfg.agent_models['broken-model'] = {
    keys: [{ provider: 'does-not-exist', key: 'x' }],
  };
  eq(listBindings(cfg, 'broken-model').length, 0);
});

test('listBindings: drops bindings with missing key', () => {
  const cfg = JSON.parse(JSON.stringify(SAMPLE_CONFIG));
  cfg.agent_models['broken-model'] = {
    keys: [{ provider: 'siliconflow', key: 'KeyDoesNotExist' }],
  };
  eq(listBindings(cfg, 'broken-model').length, 0);
});

// pickBinding
test('pickBinding: returns the only binding if length 1', () => {
  const b = pickBinding([{ x: 1 }]);
  deepEq(b, { x: 1 });
});

test('pickBinding: returns one of the bindings when multiple', () => {
  const seen = new Set();
  for (let i = 0; i < 100; i++) {
    const x = pickBinding([{ x: 'a' }, { x: 'b' }, { x: 'c' }]);
    seen.add(x.x);
  }
  if (seen.size < 2) throw new Error('pickBinding is biased, only saw ' + [...seen]);
  if (seen.size > 3) throw new Error('pickBinding returned extra values');
});

test('pickBinding: returns null for empty list', () => {
  eq(pickBinding([]), null);
});

// orderBindings & sticky_failover
test('orderBindings: priority_fallback maintains original list order', () => {
  const list = [{ provider: 'p1', keyLabel: 'k1' }, { provider: 'p2', keyLabel: 'k2' }];
  const ordered = orderBindings(list, 'my-model', 'priority_fallback');
  eq(ordered[0].provider, 'p1');
  eq(ordered[1].provider, 'p2');
});

test('orderBindings: sticky_failover starts at cursor and updates on success', () => {
  const list = [
    { provider: 'p1', keyLabel: 'k1' },
    { provider: 'p2', keyLabel: 'k2' },
    { provider: 'p3', keyLabel: 'k3' }
  ];
  // Initial order
  let ordered = orderBindings(list, 'test-sticky-model', 'sticky_failover');
  eq(ordered[0].provider, 'p1');

  // Record success on p2 -> sticky cursor updates to index 1
  recordStickySuccess('test-sticky-model', list[1], list);

  // Subsequent call starts at p2
  ordered = orderBindings(list, 'test-sticky-model', 'sticky_failover');
  eq(ordered[0].provider, 'p2');
  eq(ordered[1].provider, 'p3');
  eq(ordered[2].provider, 'p1');
});

test('orderBindings: round_robin advances cursor sequentially', () => {
  const list = [
    { provider: 'p1', keyLabel: 'k1' },
    { provider: 'p2', keyLabel: 'k2' }
  ];
  const o1 = orderBindings(list, 'test-rr-model', 'round_robin');
  eq(o1[0].provider, 'p1');
  const o2 = orderBindings(list, 'test-rr-model', 'round_robin');
  eq(o2[0].provider, 'p2');
  const o3 = orderBindings(list, 'test-rr-model', 'round_robin');
  eq(o3[0].provider, 'p1');
});

// resolveBinding
test('resolveBinding: returns api key + base url', () => {
  const b = listBindings(SAMPLE_CONFIG, 'deepseek-v4-flash')[0];
  const r = resolveBinding(SAMPLE_CONFIG, b);
  eq(r.apiKey, 'sk-self');
  eq(r.baseUrl, 'https://api.sensenova.cn/v1');
  eq(r.upstreamModel, 'DeepSeek-V3-Flash');
});

test('resolveBinding: trims trailing slashes from base url', () => {
  const cfg = JSON.parse(JSON.stringify(SAMPLE_CONFIG));
  cfg.providers.sensenova.base_url = 'https://api.sensenova.cn/v1///';
  const b = listBindings(cfg, 'deepseek-v4-flash')[0];
  const r = resolveBinding(cfg, b);
  eq(r.baseUrl, 'https://api.sensenova.cn/v1');
});

test('resolveBinding: throws ConfigError if provider disappears', () => {
  const cfg = JSON.parse(JSON.stringify(SAMPLE_CONFIG));
  const b = listBindings(cfg, 'multi-key-model')[0];
  delete cfg.providers[b.provider];
  try {
    resolveBinding(cfg, b);
    throw new Error('should have thrown');
  } catch (e) {
    if (!(e instanceof ConfigError)) throw new Error('expected ConfigError');
  }
});

// buildChatUrl
test('buildChatUrl: intelligently formats /v1/chat/completions', () => {
  eq(buildChatUrl('https://api.siliconflow.cn'), 'https://api.siliconflow.cn/v1/chat/completions');
  eq(buildChatUrl('https://api.siliconflow.cn/'), 'https://api.siliconflow.cn/v1/chat/completions');
  eq(buildChatUrl('https://api.siliconflow.cn/v1'), 'https://api.siliconflow.cn/v1/chat/completions');
  eq(buildChatUrl('https://api.stepfun.com/step_plan'), 'https://api.stepfun.com/step_plan/v1/chat/completions');
  eq(buildChatUrl('https://generativelanguage.googleapis.com/v1beta/openai'), 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions');
});

// buildMessagesUrl
test('buildMessagesUrl: intelligently formats /v1/messages', () => {
  eq(buildMessagesUrl('https://api.b.ai/v1'), 'https://api.b.ai/v1/messages');
  eq(buildMessagesUrl('https://api.b.ai/v1/'), 'https://api.b.ai/v1/messages');
  eq(buildMessagesUrl('https://api.minimaxi.com/v1', null, 'minimax'), 'https://api.minimaxi.com/anthropic/v1/messages');
  eq(buildMessagesUrl('https://api.minimax.io/v1', null, 'minimax'), 'https://api.minimax.io/anthropic/v1/messages');
  eq(buildMessagesUrl('https://api.minimaxi.com/v1', 'https://api.minimaxi.com/anthropic', 'minimax'), 'https://api.minimaxi.com/anthropic/v1/messages');
});

// buildModelsList
test('buildModelsList: returns object= list with one entry per model', () => {
  const list = buildModelsList(SAMPLE_CONFIG);
  eq(list.object, 'list');
  eq(list.data.length, 2);
  const ids = list.data.map((d) => d.id).sort();
  deepEq(ids, ['deepseek-v4-flash', 'multi-key-model']);
});

console.log('\n== normalize.js ==');

// normaliseForProvider — stepfun
test('normalize: stepfun reason "none" → "low"', () => {
  const body = { reasoning_effort: 'none' };
  normaliseForProvider(body, 'stepfun');
  eq(body.reasoning_effort, 'low');
});

test('normalize: stepfun reason "low" stays "low"', () => {
  const body = { reasoning_effort: 'low' };
  normaliseForProvider(body, 'stepfun');
  eq(body.reasoning_effort, 'low');
});

test('normalize: stepfun injects reasoning_format=deepseek-style', () => {
  const body = {};
  normaliseForProvider(body, 'stepfun');
  eq(body.reasoning_format, 'deepseek-style');
});

test('normalize: stepfun respects existing reasoning_format', () => {
  const body = { reasoning_format: 'native' };
  normaliseForProvider(body, 'stepfun');
  eq(body.reasoning_format, 'native');
});

// normaliseForProvider — tokenrhythm
test('normalize: tokenrhythm object tool_choice → "auto"', () => {
  const body = { tool_choice: { type: 'function', function: { name: 'foo' } } };
  normaliseForProvider(body, 'tokenrhythm');
  eq(body.tool_choice, 'auto');
});

test('normalize: tokenrhythm string tool_choice stays string', () => {
  const body = { tool_choice: 'auto' };
  normaliseForProvider(body, 'tokenrhythm');
  eq(body.tool_choice, 'auto');
});

// normaliseForProvider — other providers
test('normalize: sensenova "none" reason is preserved', () => {
  const body = { reasoning_effort: 'none' };
  normaliseForProvider(body, 'sensenova');
  eq(body.reasoning_effort, 'none');
});

test('normalize: sensenova does not inject reasoning_format', () => {
  const body = { reasoning_effort: 'none' };
  normaliseForProvider(body, 'sensenova');
  eq(body.reasoning_format, undefined);
});

// normaliseForProvider — Google AI Studio / Gemini
test('normalize: google reasoning "none" → include_thoughts: false', () => {
  const body = { model: 'gemini-3.5-flash', reasoning_effort: 'none' };
  normaliseForProvider(body, 'google');
  eq(body.reasoning_effort, undefined);
  deepEq(body.extra_body.google.thinking_config, { include_thoughts: false });
});

test('normalize: google reasoning "low" → thinking_level: low', () => {
  const body = { model: 'gemini-3.5-flash', reasoning_effort: 'low' };
  normaliseForProvider(body, 'google');
  eq(body.reasoning_effort, undefined);
  deepEq(body.extra_body.google.thinking_config, { include_thoughts: true, thinking_level: 'low' });
});

test('normalize: google reasoning "medium" on Flash → thinking_level: medium', () => {
  const body = { model: 'gemini-3.5-flash', reasoning_effort: 'medium' };
  normaliseForProvider(body, 'google');
  eq(body.reasoning_effort, undefined);
  deepEq(body.extra_body.google.thinking_config, { include_thoughts: true, thinking_level: 'medium' });
});

test('normalize: google reasoning "medium" on Pro → thinking_level: low (Pro only has low/high)', () => {
  const body = { model: 'gemini-3.5-pro', reasoning_effort: 'medium' };
  normaliseForProvider(body, 'google');
  eq(body.reasoning_effort, undefined);
  deepEq(body.extra_body.google.thinking_config, { include_thoughts: true, thinking_level: 'low' });
});

test('normalize: google reasoning "high" → thinking_level: high', () => {
  const body = { model: 'gemini-3.5-flash', reasoning_effort: 'high' };
  normaliseForProvider(body, 'google');
  eq(body.reasoning_effort, undefined);
  deepEq(body.extra_body.google.thinking_config, { include_thoughts: true, thinking_level: 'high' });
});

test('normalize: google strips $schema from tool parameters', () => {
  const body = {
    model: 'gemini-3.5-flash',
    tools: [
      {
        type: 'function',
        function: {
          name: 'get_weather',
          parameters: {
            $schema: 'http://json-schema.org/draft-07/schema#',
            type: 'object',
            properties: {
              location: { type: 'string', $schema: '...' },
            },
          },
        },
      },
    ],
  };
  normaliseForProvider(body, 'google');
  eq(body.tools[0].function.parameters.$schema, undefined);
  eq(body.tools[0].function.parameters.properties.location.$schema, undefined);
});

test('normalize: google deep schema sanitization (additionalProperties, $defs, $ref, invalid required)', () => {
  const body = {
    model: 'gemini-3.5-flash',
    tools: [
      {
        type: 'function',
        function: {
          name: 'complex_tool',
          parameters: {
            $schema: 'http://json-schema.org/draft-07/schema#',
            additionalProperties: false,
            $defs: { CustomType: { type: 'string' } },
            $ref: '#/$defs/CustomType',
            type: 'object',
            required: ['valid_field', 'ghost_field'],
            properties: {
              valid_field: {
                type: 'object',
                additionalProperties: false,
                required: ['sub_ghost'],
                properties: {
                  sub_field: { type: 'string' }
                }
              }
            }
          }
        }
      }
    ]
  };
  normaliseForProvider(body, 'google');
  const params = body.tools[0].function.parameters;
  eq(params.$schema, undefined);
  eq(params.additionalProperties, undefined);
  eq(params.$defs, undefined);
  eq(params.$ref, undefined);
  deepEq(params.required, ['valid_field']);
  eq(params.properties.valid_field.additionalProperties, undefined);
  eq(params.properties.valid_field.required, undefined);
});

test('normalize: google elevates max_tokens when thinking is active', () => {
  const body1 = { model: 'gemini-3.5-flash', reasoning_effort: 'high', max_tokens: 2048 };
  normaliseForProvider(body1, 'google');
  eq(body1.max_tokens, 65535);

  const body2 = { model: 'gemini-3.5-flash', reasoning_effort: 'none', max_tokens: 2048 };
  normaliseForProvider(body2, 'google');
  eq(body2.max_tokens, 2048);
});

test('normalize: google skips thinking_config for gemma models', () => {
  const body = { model: 'gemma-2-27b-it', reasoning_effort: 'high' };
  normaliseForProvider(body, 'google');
  eq(body.extra_body?.google?.thinking_config, undefined);
});

// normaliseForProvider — Agnes AI
test('normalize: agnes reasoning "high" → chat_template_kwargs.enable_thinking: true', () => {
  const body = { model: 'agnes-2.5-flash', reasoning_effort: 'high' };
  normaliseForProvider(body, 'agnes');
  eq(body.reasoning_effort, undefined);
  deepEq(body.chat_template_kwargs, { enable_thinking: true });
});

test('normalize: agnes reasoning "none" → chat_template_kwargs.enable_thinking: false', () => {
  const body = { model: 'agnes-2.5-flash', reasoning_effort: 'none' };
  normaliseForProvider(body, 'agnes');
  eq(body.reasoning_effort, undefined);
  deepEq(body.chat_template_kwargs, { enable_thinking: false });
});

// normaliseForProvider — AMD
test('normalize: amd default (no reasoning_effort) → defaults to reasoning_effort: "medium"', () => {
  const body = { model: 'DeepSeek-V4-Flash' };
  normaliseForProvider(body, 'amd');
  eq(body.reasoning_effort, 'medium');
  eq(body.chat_template_kwargs, undefined);
  eq(body.thinking, undefined);
});

test('normalize: amd qwen with "high" reasoning_effort → safely downgraded to "medium"', () => {
  const body = { model: 'Qwen3.8-Flash-Next', reasoning_effort: 'high' };
  normaliseForProvider(body, 'amd');
  eq(body.reasoning_effort, 'medium');
});

test('normalize: amd deepseek with "none" reasoning_effort → removed (thinking off by default)', () => {
  const body = { model: 'DeepSeek-V4-Flash', reasoning_effort: 'none' };
  normaliseForProvider(body, 'amd');
  eq(body.reasoning_effort, undefined);
  eq(body.chat_template_kwargs, undefined);
});

test('normalize: amd sanitizes messages (developer -> system, multiple systems merged to index 0)', () => {
  const body = {
    model: 'Qwen3.8-Flash-Next',
    messages: [
      { role: 'user', content: 'hello' },
      { role: 'developer', content: 'system instruction 1' },
      { role: 'assistant', content: 'hi' },
      { role: 'system', content: 'system instruction 2' },
    ]
  };
  normaliseForProvider(body, 'amd');
  eq(body.messages.length, 3);
  eq(body.messages[0].role, 'system');
  eq(body.messages[0].content, 'system instruction 1\n\nsystem instruction 2');
  eq(body.messages[1].role, 'user');
  eq(body.messages[2].role, 'assistant');
});

// normaliseForProvider — SenseNova
test('normalize: sensenova object tool_choice → "auto"', () => {
  const body = { model: 'sensenova-6.8-flash-lite', tool_choice: { type: 'function', function: { name: 'calc' } } };
  normaliseForProvider(body, 'sensenova');
  eq(body.tool_choice, 'auto');
});

// normaliseForProvider — MiniMax
test('normalize: minimax with reasoning_effort "medium" enables reasoning_split and adaptive thinking', () => {
  const body = { model: 'minimax-m3', reasoning_effort: 'medium' };
  normaliseForProvider(body, 'minimax');
  eq(body.model, 'MiniMax-M3');
  eq(body.reasoning_split, true);
  deepEq(body.thinking, { type: 'adaptive' });
  eq(body.reasoning_effort, undefined);
});

test('normalize: minimax standard chat defaults to reasoning_split=true for clean agent reasoning_content', () => {
  const body = { model: 'MiniMax-M3', messages: [{ role: 'user', content: 'hello' }] };
  normaliseForProvider(body, 'minimax');
  eq(body.model, 'MiniMax-M3');
  eq(body.reasoning_split, true);
  deepEq(body.thinking, { type: 'adaptive' });
});

test('normalize: minimax with reasoning_effort "none" explicitly disables thinking', () => {
  const body = { model: 'MiniMax-M3', reasoning_effort: 'none' };
  normaliseForProvider(body, 'minimax');
  deepEq(body.thinking, { type: 'disabled' });
  eq(body.reasoning_split, undefined);
  eq(body.reasoning_effort, undefined);
});

test('normalize: minimax strips output_config', () => {
  const body = { model: 'minimax-m3', output_config: { format: 'text' } };
  normaliseForProvider(body, 'minimax');
  eq(body.output_config, undefined);
});

test('rescueToolCallsFromText: extracts markdown json tool call', () => {
  const text = 'Here is the tool call:\n```json\n{"name": "fetch_weather", "arguments": {"city": "Shanghai"}}\n```';
  const rescued = rescueToolCallsFromText(text);
  truthy(rescued);
  eq(rescued.length, 1);
  eq(rescued[0].function.name, 'fetch_weather');
  eq(JSON.parse(rescued[0].function.arguments).city, 'Shanghai');
});

test('rescueToolCallsFromText: extracts <tool_call> xml tag', () => {
  const text = '<tool_call>{"name": "search", "arguments": {"q": "test"}}</tool_call>';
  const rescued = rescueToolCallsFromText(text);
  truthy(rescued);
  eq(rescued.length, 1);
  eq(rescued[0].function.name, 'search');
});

console.log('\n== cooldowns.js ==');

// ---- Mock KV store -----------------------------------------------------
function makeMockKV() {
  const data = new Map();
  return {
    data,
    async get(key, opts) {
      if (!data.has(key)) return null;
      const entry = data.get(key);
      if (entry.expiresAt && entry.expiresAt < Date.now()) {
        data.delete(key);
        return null;
      }
      return opts?.type === 'text' ? entry.value : entry.value;
    },
    async put(key, value, opts) {
      data.set(key, { value: String(value), expiresAt: opts?.expirationTtl ? Date.now() + opts.expirationTtl * 1000 : 0 });
    },
    async delete(key) { data.delete(key); },
  };
}

// ---- classifyFailure / shouldFailover -----------------------------------
test('classifyFailure: returns 60s for 429', () => {
  eq(classifyFailure(429, 'http'), COOLDOWN_DURATIONS.TPM_429);
  eq(COOLDOWN_DURATIONS.TPM_429, 60);
});

test('classifyFailure: returns 600s for 403', () => {
  eq(classifyFailure(403, 'http'), COOLDOWN_DURATIONS.QUOTA_403);
  eq(COOLDOWN_DURATIONS.QUOTA_403, 600);
});

test('classifyFailure: returns 30s for 5xx', () => {
  eq(classifyFailure(500, 'http'), COOLDOWN_DURATIONS.SERVER_5XX);
  eq(classifyFailure(502, 'http'), COOLDOWN_DURATIONS.SERVER_5XX);
  eq(classifyFailure(503, 'http'), COOLDOWN_DURATIONS.SERVER_5XX);
});

test('classifyFailure: returns 0 for 2xx (no cooldown needed)', () => {
  eq(classifyFailure(200, 'http'), 0);
  eq(classifyFailure(201, 'http'), 0);
});

test('classifyFailure: returns 0 for 400 (request-level, do not cooldown)', () => {
  eq(classifyFailure(400, 'http'), 0);
});

test('classifyFailure: returns 5s for empty stream', () => {
  eq(classifyFailure(200, 'empty_stream'), COOLDOWN_DURATIONS.EMPTY_STREAM);
});

test('classifyFailure: returns 2s for read timeout', () => {
  eq(classifyFailure(0, 'read_timeout'), COOLDOWN_DURATIONS.READ_TIMEOUT);
});

test('shouldFailover: 2xx and 400 do NOT failover', () => {
  eq(shouldFailover(200, 'http'), false);
  eq(shouldFailover(201, 'http'), false);
  eq(shouldFailover(400, 'http'), false);
});

test('shouldFailover: 429, 5xx, 401, 403, 404 DO failover', () => {
  eq(shouldFailover(429, 'http'), true);
  eq(shouldFailover(500, 'http'), true);
  eq(shouldFailover(502, 'http'), true);
  eq(shouldFailover(401, 'http'), true);
  eq(shouldFailover(403, 'http'), true);
  eq(shouldFailover(404, 'http'), true);
});

test('shouldFailover: empty_stream and read_timeout always failover', () => {
  eq(shouldFailover(200, 'empty_stream'), true);
  eq(shouldFailover(0, 'read_timeout'), true);
});

// ---- bindingId ---------------------------------------------------------
test('bindingId: produces stable id', () => {
  eq(bindingId({ provider: 'a', keyLabel: 'b' }), 'a:b');
});

// ---- setCooldown / getCooldown -----------------------------------------
test('setCooldown + getCooldown: round-trip', async () => {
  const kv = makeMockKV();
  await setCooldown('prov', 'key', 30, kv);
  const exp = await getCooldown('prov', 'key', kv);
  truthy(exp > Date.now() && exp <= Date.now() + 30_100);
});

test('getCooldown: returns 0 when no entry', async () => {
  const kv = makeMockKV();
  eq(await getCooldown('nope', 'nope', kv), 0);
});

test('getCooldown: returns 0 when KV is undefined', async () => {
  eq(await getCooldown('p', 'k', undefined), 0);
});

test('setCooldown: no-op when KV is undefined', async () => {
  // Should not throw
  await setCooldown('p', 'k', 30, undefined);
});

// ---- getCooldownsBatch ------------------------------------------------
test('getCooldownsBatch: returns map with all binding IDs', async () => {
  const kv = makeMockKV();
  await setCooldown('a', 'k1', 30, kv);
  const bindings = [
    { provider: 'a', keyLabel: 'k1' },
    { provider: 'a', keyLabel: 'k2' },
    { provider: 'b', keyLabel: 'k1' },
  ];
  const map = await getCooldownsBatch(bindings, kv);
  eq(map.size, 3);
  truthy(map.get('a:k1') > 0);
  eq(map.get('a:k2'), 0);
  eq(map.get('b:k1'), 0);
});

test('getCooldownsBatch: returns empty map when KV is undefined', async () => {
  const bindings = [{ provider: 'a', keyLabel: 'k1' }];
  const map = await getCooldownsBatch(bindings, undefined);
  eq(map.size, 0);
});

// ---- recordFailure / circuit breaker ---------------------------------
test('recordFailure: increments counter up to threshold then triggers breaker', async () => {
  const kv = makeMockKV();
  let count;
  count = await recordFailure('p', 'k', kv);
  eq(count, 1);
  count = await recordFailure('p', 'k', kv);
  eq(count, 2);
  count = await recordFailure('p', 'k', kv);
  eq(count, 3);
  // After 3 failures, breaker cooldown should be set
  const exp = await getCooldown('p', 'k', kv);
  truthy(exp > Date.now() + (COOLDOWN_DURATIONS.CIRCUIT_BREAKER - 5) * 1000);
  // And the counter is reset
  eq(await recordFailure('p', 'k', kv), 1);
});

test('recordSuccess: clears the failure counter', async () => {
  const kv = makeMockKV();
  await recordFailure('p', 'k', kv);
  await recordFailure('p', 'k', kv);
  await recordSuccess('p', 'k', kv);
  // After clearing, next failure should be 1 again
  eq(await recordFailure('p', 'k', kv), 1);
});

test('recordSuccess: no-op when KV is undefined', async () => {
  await recordSuccess('p', 'k', undefined);
});

// ---- clearAllState ----------------------------------------------------
test('clearAllState: wipes cooldowns and counters', async () => {
  const kv = makeMockKV();
  const bindings = [
    { provider: 'a', keyLabel: 'k1' },
    { provider: 'a', keyLabel: 'k2' },
  ];
  await setCooldown('a', 'k1', 60, kv);
  await setCooldown('a', 'k2', 60, kv);
  await recordFailure('a', 'k1', kv);
  const n = await clearAllState(bindings, kv);
  eq(n, 2);
  eq(await getCooldown('a', 'k1', kv), 0);
  eq(await getCooldown('a', 'k2', kv), 0);
  eq(await recordFailure('a', 'k1', kv), 1); // counter was reset
});

test('clearAllState: no-op when KV is undefined', async () => {
  eq(await clearAllState([{ provider: 'a', keyLabel: 'k' }], undefined), 0);
});

// ---- snapshotState ----------------------------------------------------
test('snapshotState: returns structured state for all bindings', async () => {
  const kv = makeMockKV();
  await setCooldown('a', 'k1', 30, kv);
  await recordFailure('b', 'k1', kv);
  await recordFailure('b', 'k1', kv);
  const bindings = [
    { provider: 'a', keyLabel: 'k1', upstreamModel: 'model-a' },
    { provider: 'b', keyLabel: 'k1', upstreamModel: 'model-b' },
  ];
  const snap = await snapshotState(bindings, kv);
  eq(snap.length, 2);
  const a = snap.find((s) => s.provider === 'a');
  eq(a.inCooldown, true);
  eq(a.upstreamModel, 'model-a');
  const b = snap.find((s) => s.provider === 'b');
  eq(b.inCooldown, false);
  eq(b.consecutiveFailures, 2);
});

test('snapshotState: works when KV is undefined (returns 0/0)', async () => {
  const bindings = [{ provider: 'a', keyLabel: 'k1' }];
  const snap = await snapshotState(bindings, undefined);
  eq(snap.length, 1);
  eq(snap[0].inCooldown, false);
  eq(snap[0].consecutiveFailures, 0);
});

test('circuit breaker threshold is 3 (matches VM)', () => {
  eq(CIRCUIT_BREAKER_THRESHOLD, 3);
});

console.log('\n== sanitizeJsonString ==');

test('sanitize: passes clean JSON through unchanged', () => {
  const clean = '{"providers":{"a":{"base_url":"x","keys":{"k":"v"}}},"agent_models":{}}';
  eq(sanitizeJsonString(clean), clean);
});

test('sanitize: trims leading and trailing whitespace', () => {
  const clean = '{"a":1}';
  eq(sanitizeJsonString('   \n\t' + clean + '   \n'), clean);
});

test('sanitize: strips surrounding double quotes', () => {
  const clean = '{"a":1}';
  eq(sanitizeJsonString('"' + clean + '"'), clean);
});

test('sanitize: strips surrounding single quotes', () => {
  const clean = '{"a":1}';
  eq(sanitizeJsonString("'" + clean + "'"), clean);
});

test('sanitize: strips quotes + whitespace together', () => {
  const clean = '{"a":1}';
  eq(sanitizeJsonString('  "\n' + clean + '\n"  '), clean);
});

test('sanitize: extracts JSON from junk-prefixed string (env console prefix)', () => {
  const clean = '{"providers":{},"agent_models":{}}';
  eq(sanitizeJsonString('Some leading text: ' + clean + ' trailing'), clean);
});

test('sanitize: handles multi-line JSON with newlines inside', () => {
  const ml = '{\n  "a": 1,\n  "b": 2\n}';
  eq(sanitizeJsonString(ml), ml);
});

test('sanitize: empty / null returns empty', () => {
  eq(sanitizeJsonString(''), '');
  eq(sanitizeJsonString(null), '');
  eq(sanitizeJsonString(undefined), '');
});

test('sanitize: real-world edge case (extra trailing chars)', () => {
  const clean = '{"providers":{},"agent_models":{}}';
  // Some console UIs append a copy button that leaks extra closing brace
  eq(sanitizeJsonString(clean + '}'), clean);
});

console.log('\n== loadConfig with malformed env ==');

test('loadConfig: tolerates surrounding quotes around JSON env', async () => {
  const clean = JSON.stringify(SAMPLE_CONFIG);
  const wrapped = '"' + clean + '"';  // console-stripped wrongly
  const cfg = await loadConfig({ AGENT_CONFIG_JSON: wrapped });
  deepEq(Object.keys(cfg.providers).sort(), ['sensenova', 'siliconflow']);
});

test('loadConfig: tolerates leading "Some text: " prefix', async () => {
  const clean = JSON.stringify(SAMPLE_CONFIG);
  const dirty = 'Value: ' + clean + ' (end)';
  const cfg = await loadConfig({ AGENT_CONFIG_JSON: dirty });
  deepEq(Object.keys(cfg.providers).sort(), ['sensenova', 'siliconflow']);
});

test('loadConfig: gives helpful preview when value is unrecoverable garbage', async () => {
  try {
    await loadConfig({ AGENT_CONFIG_JSON: 'not json at all !!!' });
    throw new Error('should have thrown');
  } catch (e) {
    if (!(e instanceof ConfigError)) throw new Error('expected ConfigError');
    if (!e.message.includes('value preview')) {
      throw new Error('error should include value preview, got: ' + e.message);
    }
  }
});

test('loadConfig: reads from KV when KV is bound and has data', async () => {
  // Mock KV handle: get returns our config string.
  const kv = {
    get: async (key) => key === 'config' ? JSON.stringify(SAMPLE_CONFIG) : null,
  };
  const cfg = await loadConfig({ AGENT_CONFIG_JSON: 'GARBAGE_NOT_USED' }, kv);
  deepEq(Object.keys(cfg.providers).sort(), ['sensenova', 'siliconflow']);
});

test('loadConfig: when KV is bound but empty, throws clear "use admin UI" error', async () => {
  const kv = { get: async () => null };
  try {
    await loadConfig({ AGENT_CONFIG_JSON: 'GARBAGE' }, kv);
    throw new Error('should have thrown');
  } catch (e) {
    if (!(e instanceof ConfigError)) throw new Error('expected ConfigError');
    if (!e.message.includes('admin UI')) {
      throw new Error('error should mention admin UI, got: ' + e.message);
    }
    if (!e.message.includes('intentionally ignored')) {
      throw new Error('error should explain env is ignored, got: ' + e.message);
    }
  }
});

test('loadConfig: when KV is bound but throws, surfaces the error', async () => {
  const kv = { get: async () => { throw new Error('upstream timeout'); } };
  try {
    await loadConfig({ AGENT_CONFIG_JSON: 'GARBAGE' }, kv);
    throw new Error('should have thrown');
  } catch (e) {
    if (!(e instanceof ConfigError)) throw new Error('expected ConfigError');
    if (!e.message.includes('upstream timeout')) {
      throw new Error('error should include underlying error, got: ' + e.message);
    }
  }
});

console.log('\n== validateConfig ==');

const GOOD_CONFIG = {
  providers: {
    s1: { base_url: 'https://x.com', keys: { k1: 'sk-1', k2: 'sk-2' } },
  },
  agent_models: {
    m1: { keys: [{ provider: 's1', key: 'k1' }] },
    m2: { keys: [
      { provider: 's1', key: 'k1' },
      { provider: 's1', key: 'k2', upstream_model: 'real-name' },
    ] },
  },
};

test('validateConfig: accepts good config', () => {
  eq(validateConfig(GOOD_CONFIG), null);
});

test('validateConfig: rejects null', () => {
  truthy(validateConfig(null));
  truthy(validateConfig(undefined));
});

test('validateConfig: rejects non-object', () => {
  truthy(validateConfig('string'));
  truthy(validateConfig(42));
  truthy(validateConfig([]));
});

test('validateConfig: rejects missing providers', () => {
  truthy(validateConfig({ agent_models: {} }));
  truthy(validateConfig({ providers: 'not-an-object', agent_models: {} }));
});

test('validateConfig: rejects provider without base_url', () => {
  const bad = { providers: { s1: { keys: { k1: 'v' } } }, agent_models: {} };
  truthy(validateConfig(bad));
});

test('validateConfig: rejects provider with empty base_url', () => {
  const bad = { providers: { s1: { base_url: '', keys: { k1: 'v' } } }, agent_models: {} };
  truthy(validateConfig(bad));
});

test('validateConfig: accepts provider with empty keys object', () => {
  const ok = { providers: { s1: { base_url: 'https://api.example.com', keys: {} } }, agent_models: {} };
  eq(validateConfig(ok), null);
});

test('validateConfig: rejects empty key value', () => {
  const bad = { providers: { s1: { base_url: 'x', keys: { k1: '' } } }, agent_models: {} };
  truthy(validateConfig(bad));
});

test('validateConfig: rejects missing agent_models', () => {
  truthy(validateConfig({ providers: { s1: { base_url: 'x', keys: { k1: 'v' } } } }));
});

test('validateConfig: accepts model with empty keys array', () => {
  const ok = { providers: { s1: { base_url: 'x', keys: { k1: 'v' } } }, agent_models: { m1: { keys: [] } } };
  eq(validateConfig(ok), null);
});

test('validateConfig: rejects binding to unknown provider', () => {
  const bad = { providers: { s1: { base_url: 'x', keys: { k1: 'v' } } },
    agent_models: { m1: { keys: [{ provider: 'unknown', key: 'k1' }] } } };
  truthy(validateConfig(bad));
});

test('validateConfig: rejects binding to unknown key', () => {
  const bad = { providers: { s1: { base_url: 'x', keys: { k1: 'v' } } },
    agent_models: { m1: { keys: [{ provider: 's1', key: 'unknown' }] } } };
  truthy(validateConfig(bad));
});

test('validateConfig: rejects malformed binding', () => {
  const bad = { providers: { s1: { base_url: 'x', keys: { k1: 'v' } } },
    agent_models: { m1: { keys: [null, 'string', 42] } } };
  truthy(validateConfig(bad));
});

test('validateConfig: rejects non-string upstream_model', () => {
  const bad = { providers: { s1: { base_url: 'x', keys: { k1: 'v' } } },
    agent_models: { m1: { keys: [{ provider: 's1', key: 'k1', upstream_model: 42 }] } } };
  truthy(validateConfig(bad));
});

test('validateConfig: accepts upstream_model omitted', () => {
  const ok = { providers: { s1: { base_url: 'x', keys: { k1: 'v' } } },
    agent_models: { m1: { keys: [{ provider: 's1', key: 'k1' }] } } };
  eq(validateConfig(ok), null);
});

console.log('\n== resolveKvBinding ==');

function makeFakeKv() {
  return { get: () => {}, put: () => {}, delete: () => {} };
}

test('resolveKvBinding: returns undefined when nothing is bound', () => {
  eq(resolveKvBinding({}), undefined);
  eq(resolveKvBinding(null), undefined);
  eq(resolveKvBinding({ env: { FOO: 'bar' } }), undefined);
});

test('resolveKvBinding: finds agent_kv', () => {
  const kv = makeFakeKv();
  const ctx = { agent_kv: kv };
  const r = resolveKvBinding(ctx);
  truthy(r);
  eq(r.name, 'agent_kv');
  eq(r.kv, kv);
});

test('resolveKvBinding: finds kv (lowercase)', () => {
  const kv = makeFakeKv();
  const r = resolveKvBinding({ kv });
  eq(r.name, 'kv');
});

test('resolveKvBinding: finds KV (uppercase)', () => {
  const kv = makeFakeKv();
  const r = resolveKvBinding({ KV: kv });
  eq(r.name, 'KV');
});

test('resolveKvBinding: rejects a property that is not a KV handle', () => {
  // The bound value must be a KV handle (have get/put).  Strings,
  // numbers, and objects without those methods are not valid.
  const r = resolveKvBinding({ agent_kv: 'not-a-kv' });
  eq(r, undefined);
  const r2 = resolveKvBinding({ agent_kv: { get: 'string-not-func' } });
  eq(r2, undefined);
});

test('resolveKvBinding: picks the first match in priority order', () => {
  const kv1 = makeFakeKv();
  const kv2 = makeFakeKv();
  // Both 'kv' and 'agent_kv' bound — should pick whichever comes first
  // in the candidate list.
  const r = resolveKvBinding({ kv: kv1, agent_kv: kv2 });
  // Both are valid; first one in CANDIDATES list wins.
  truthy(['kv', 'agent_kv'].includes(r.name));
});

test('resolveKvBinding: finds my_kv (doc example name)', () => {
  const kv = makeFakeKv();
  const r = resolveKvBinding({ my_kv: kv });
  truthy(r, 'expected a binding');
  eq(r.name, 'my_kv');
});

test('resolveKvBinding: finds bindings via context.env', () => {
  const kv = makeFakeKv();
  const r = resolveKvBinding({ env: { agent_kv: kv } });
  truthy(r);
  eq(r.name, 'agent_kv');
  eq(r.scope, 'context.env');
});

test('resolveKvBinding: finds bindings via context.bindings', () => {
  const kv = makeFakeKv();
  const r = resolveKvBinding({ bindings: { agent_kv: kv } });
  truthy(r);
  eq(r.name, 'agent_kv');
  eq(r.scope, 'context.bindings');
});

test('resolveKvBinding: duck-typed scan finds a KV handle under unknown name', () => {
  // Operator bound the namespace as "WEIRD_NAME" — our candidate list
  // doesn't include it, but the duck-typed scan should still find it.
  const kv = makeFakeKv();
  const r = resolveKvBinding({ WEIRD_NAME: kv });
  truthy(r, 'expected a binding via duck-typing');
  eq(r.name, 'WEIRD_NAME');
});

test('resolveKvBinding: duck-typed scan finds KV nested at one level', () => {
  const kv = makeFakeKv();
  const r = resolveKvBinding({ stuff: { DEEPLY_NAMED: kv } });
  truthy(r, 'expected a nested binding');
  eq(r.name, 'stuff.DEEPLY_NAMED');
});

test('KV_BINDING_CANDIDATES: includes the doc example name (my_kv)', () => {
  truthy(KV_BINDING_CANDIDATES.includes('my_kv'));
  truthy(KV_BINDING_CANDIDATES.includes('agent_kv'));
});

test('scanKvBindings: reports which scope has a KV-like handle', () => {
  const kv = makeFakeKv();
  const scan = scanKvBindings({ agent_kv: kv, env: { FOO: 'bar' } });
  truthy(scan.detected);
  eq(scan.detected.name, 'agent_kv');
  truthy(scan.scopes.context.kvLike.includes('agent_kv'));
  // `env` is at context level in this test (not nested), so it shows up
  // as a regular key on `scopes.context`, not as `scopes.context.env`.
  truthy(scan.scopes.context.keys.includes('env'));
});

test('scanKvBindings: when nothing is bound, detected is null', () => {
  const scan = scanKvBindings({ env: { X: 'y' } });
  eq(scan.detected, null);
});

test('kvNotBoundResponse: returns 503 with diagnostic scan in body', async () => {
  const resp = kvNotBoundResponse({ env: { X: 'y' } });
  eq(resp.status, 503);
  const body = await resp.json();
  truthy(body.error.message.includes('KV namespace is not bound'));
  truthy(body.scan, 'expected scan payload');
  truthy(body.scan.scopes);
});

// ============================================================================
// Presets Registry Tests
// ============================================================================
console.log('\n== presets ==');

test('PRESETS: contains all 8 major providers', () => {
  truthy(PRESETS.length >= 8);
  const ids = PRESETS.map(p => p.id);
  truthy(ids.includes('google'));
  truthy(ids.includes('sensenova'));
  truthy(ids.includes('stepfun'));
  truthy(ids.includes('siliconflow'));
  truthy(ids.includes('tokenrhythm'));
  truthy(ids.includes('deepseek'));
  truthy(ids.includes('openai'));
  truthy(ids.includes('agnes'));
  truthy(ids.includes('minimax'));
  truthy(ids.includes('bai'));
});

test('getPreset: finds minimax preset with MiniMax-M3 and domestic anthropic endpoint', () => {
  const p = getPreset('minimax');
  truthy(p);
  eq(p.name, 'MiniMax');
  eq(p.base_url, 'https://api.minimaxi.com/v1');
  eq(p.anthropic_base_url, 'https://api.minimaxi.com/anthropic');
  const m = p.recommended_models.find(x => x.name === 'MiniMax-M3');
  truthy(m);
  eq(m.upstream_model, 'MiniMax-M3');
});

test('getPreset: finds bai preset with dual completions and messages support', () => {
  const p = getPreset('bai');
  truthy(p);
  eq(p.name, 'B.AI');
  eq(p.base_url, 'https://api.b.ai/v1');
  eq(p.anthropic_base_url, 'https://api.b.ai/v1');
});

test('getPreset: finds google preset with recommended models', () => {
  const p = getPreset('google');
  truthy(p);
  eq(p.name, 'Google AI Studio (Gemini)');
  truthy(p.base_url.includes('generativelanguage.googleapis.com'));
  truthy(p.recommended_models.length >= 2);
  const modelNames = p.recommended_models.map(m => m.name);
  truthy(modelNames.includes('gemini-3.5-flash'));
  truthy(modelNames.includes('gemini-3.5-pro'));
});

test('getPreset: finds sensenova with GLM-5.2', () => {
  const p = getPreset('sensenova');
  truthy(p);
  eq(p.id, 'sensenova');
  const modelNames = p.recommended_models.map(m => m.name);
  truthy(modelNames.includes('glm-5.2'));
});

test('getPreset: is case-insensitive', () => {
  const p = getPreset('Google');
  truthy(p);
  eq(p.id, 'google');
});

// ============================================================================
// Schema v2 Settings & Timeout Defaults Tests
// ============================================================================
console.log('\n== Schema v2 Settings ==');

test('DEFAULT_SETTINGS: contains all 10 standard fields', () => {
  eq(DEFAULT_SETTINGS.request_total_budget_sec, 25);
  eq(DEFAULT_SETTINGS.upstream_timeout_sec, 8);
  eq(DEFAULT_SETTINGS.schedule_total_budget, 3);
  eq(DEFAULT_SETTINGS.max_attempts_per_provider, 3);
  eq(DEFAULT_SETTINGS.fast_failover_provider_down, true);
  eq(DEFAULT_SETTINGS.agent_routing_strategy, 'sticky_failover');
  eq(DEFAULT_SETTINGS.cooldown_429_sec, 60);
  eq(DEFAULT_SETTINGS.cooldown_5xx_sec, 30);
  eq(DEFAULT_SETTINGS.cooldown_403_sec, 600);
  eq(DEFAULT_SETTINGS.circuit_break_threshold, 3);
});

test('loadConfig: injects default settings when missing', async () => {
  const env = {
    AGENT_CONFIG_JSON: JSON.stringify({
      providers: { p1: { base_url: 'https://p1.com', keys: { k1: 'sk-1' } } },
      agent_models: { m1: { keys: [{ provider: 'p1', key: 'k1' }] } },
    }),
  };
  const cfg = await loadConfig(env, null);
  truthy(cfg.settings);
  eq(cfg.settings.request_total_budget_sec, 25);
  eq(cfg.settings.max_attempts_per_provider, 2);
  eq(cfg.settings.fast_failover_provider_down, true);
});

test('loadConfig: preserves custom settings when provided', async () => {
  const env = {
    AGENT_CONFIG_JSON: JSON.stringify({
      settings: { request_total_budget_sec: 40, max_attempts_per_provider: 1 },
      providers: { p1: { base_url: 'https://p1.com', keys: { k1: 'sk-1' } } },
      agent_models: { m1: { keys: [{ provider: 'p1', key: 'k1' }] } },
    }),
  };
  const cfg = await loadConfig(env, null);
  truthy(cfg.settings);
  eq(cfg.settings.request_total_budget_sec, 40);
  eq(cfg.settings.max_attempts_per_provider, 1);
  eq(cfg.settings.upstream_timeout_sec, 15); // merged default
});

console.log('\n== TransformStream Streaming (Doc 81914) ==');

test('TransformStream: combines firstChunk and remaining stream per Doc 81914', async () => {
  const chunks = ['data: {"foo":"bar"}\n\n', 'data: {"baz":1}\n\n', 'data: [DONE]\n\n'];
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  const { readable: upstreamReadable, writable: upstreamWritable } = new TransformStream();
  const upWriter = upstreamWritable.getWriter();
  (async () => {
    for (const c of chunks) {
      await upWriter.write(encoder.encode(c));
    }
    await upWriter.close();
  })();

  const reader = upstreamReadable.getReader();
  const first = await reader.read();
  truthy(!first.done);
  const firstChunk = first.value;

  const { readable: outReadable, writable: outWritable } = new TransformStream();
  const outWriter = outWritable.getWriter();
  (async () => {
    try {
      await outWriter.write(firstChunk);
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        await outWriter.write(value);
      }
      await outWriter.close();
    } catch (e) {
      await outWriter.abort(e);
    }
  })();

  const outReader = outReadable.getReader();
  const received = [];
  while (true) {
    const { value, done } = await outReader.read();
    if (done) break;
    received.push(decoder.decode(value));
  }
  eq(received.join(''), chunks.join(''));
});

test('resolveBinding: includes provider and adapterRules from preset', () => {
  const b = listBindings(SAMPLE_CONFIG, 'deepseek-v4-flash')[0];
  const r = resolveBinding(SAMPLE_CONFIG, b);
  eq(r.provider, 'sensenova');
  truthy(typeof r.adapterRules === 'object');
  eq(r.adapterRules.reasoning?.strategy, 'openai_passthrough');
});

test('TransformStream: reasoning filter rewrites reasoning to reasoning_content and normalizes event: done', async () => {
  const td = new TextDecoder();
  const te = new TextEncoder();
  const filterChunk = (chunk) => {
    if (!chunk) return chunk;
    let str = td.decode(chunk, { stream: true });
    let modified = false;
    if (str.includes('"reasoning":')) {
      str = str.replaceAll('"reasoning":', '"reasoning_content":');
      modified = true;
    }
    if (str.includes('event: done\ndata: [DONE]')) {
      str = str.replaceAll('event: done\ndata: [DONE]', 'data: [DONE]');
      modified = true;
    }
    return modified ? te.encode(str) : chunk;
  };

  const sampleAmdChunks = [
    'data: {"choices":[{"delta":{"reasoning":"思考中"}}]}\nid: 0\n\n',
    'data: {"choices":[{"delta":{"content":"答案"}}]}\nid: 1\n\n',
    'event: done\ndata: [DONE]\nid: 2\n\n'
  ];

  const processed = sampleAmdChunks.map(c => td.decode(filterChunk(te.encode(c))));
  truthy(processed[0].includes('"reasoning_content":"思考中"'));
  truthy(!processed[0].includes('"reasoning":"'));
  truthy(processed[1].includes('"content":"答案"'));
  truthy(processed[2].includes('data: [DONE]'));
  truthy(!processed[2].includes('event: done'));
});

console.log('\n----');
console.log(`PASS: ${passed}`);
console.log(`FAIL: ${failed}`);
process.exit(failed === 0 ? 0 : 1);


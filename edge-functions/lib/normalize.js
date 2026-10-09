/**
 * normalize.js — Provider-specific request body normalization.
 *
 * Ported and enhanced with Google AI Studio / Gemini 3.5+ adaptation
 * and FreeLLMAPI param pruning & tool rescue capabilities.
 *
 * Rules:
 *   1. StepFun:
 *      - reasoning_effort: "none" → "low" (StepFun rejects "none")
 *      - inject reasoning_format="deepseek-style" so agent tools receive reasoning_content.
 *   2. TokenRhythm:
 *      - tool_choice: object form → "auto" (TokenRhythm rejects object form).
 *   3. Google AI Studio / Gemini (Gemini 2.5, 3, 3.5+):
 *      - Map reasoning_effort ("none" / "low" / "medium" / "high") to extra_body.google.thinking_config.
 *      - Sanitize tool function schemas (remove $schema, additionalProperties that Gemini rejects).
 */

import { getPreset } from './presets/index.js';

/**
 * Sanitize JSON Schema for tools (e.g. Google Gemini strictly rejects $schema).
 */
export function sanitizeGeminiSchema(schema) {
  if (!schema || typeof schema !== 'object') return schema;
  if (Array.isArray(schema)) {
    return schema.map(sanitizeGeminiSchema);
  }
  const clean = { ...schema };
  delete clean['$schema'];
  delete clean['additionalProperties'];
  delete clean['$defs'];
  delete clean['$ref'];

  if (clean.properties && typeof clean.properties === 'object') {
    const props = {};
    for (const [k, v] of Object.entries(clean.properties)) {
      props[k] = sanitizeGeminiSchema(v);
    }
    clean.properties = props;

    // Validate required array: only retain properties that actually exist
    if (Array.isArray(clean.required)) {
      clean.required = clean.required.filter(r => Object.prototype.hasOwnProperty.call(clean.properties, r));
      if (clean.required.length === 0) {
        delete clean.required;
      }
    }
  } else if (clean.required && (!clean.properties || Object.keys(clean.properties).length === 0)) {
    delete clean.required;
  }

  if (clean.items) {
    clean.items = sanitizeGeminiSchema(clean.items);
  }

  for (const unionKey of ['anyOf', 'allOf', 'oneOf']) {
    if (Array.isArray(clean[unionKey])) {
      clean[unionKey] = clean[unionKey].map(sanitizeGeminiSchema);
    }
  }

  return clean;
}

/**
 * Ensure messages conform strictly to AMD/Qwen requirements:
 * 1. Replace 'developer' role with 'system'.
 * 2. Ensure at most one 'system' message, and it MUST be the first item (messages[0]).
 */
export function sanitizeAmdMessages(body) {
  applyAdapterRules(body, {
    messages: {
      deny_developer_role: true,
      system_first_only: true,
      merge_system: true,
    }
  }, true, false);
}

/**
 * Pure Declarative Adapter Rules Executor.
 * Mutates `body` in place according to provider adapter_rules schema.
 */
const EFFORT_ORDER = ['minimal', 'low', 'medium', 'high'];
const GEMINI25_BUDGET = { minimal: 1024, low: 1024, medium: 8192, high: 24576 };

function deepMergeParams(body, params) {
  for (const [k, v] of Object.entries(params)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && body[k] && typeof body[k] === 'object' && !Array.isArray(body[k])) {
      body[k] = { ...body[k], ...v };
    } else {
      body[k] = (v && typeof v === 'object') ? JSON.parse(JSON.stringify(v)) : v;
    }
  }
}

/**
 * OpenAI-compatible providers. Agent mode: reasoning_effort passes through unless
 * the preset declares effort_map (value -> replacement, null = drop) or
 * effort_to_params (value or "*" -> params to inject). KB mode: kb_mode
 * "none" (default, reasoning_effort="none") | "omit"; kb_params merged when present.
 */
function stripParam(obj, path) {
  const i = path.indexOf('.');
  if (i < 0) { delete obj[path]; return; }
  const head = path.slice(0, i);
  const sub = obj[head];
  if (sub && typeof sub === 'object' && !Array.isArray(sub)) {
    const copy = { ...sub };
    stripParam(copy, path.slice(i + 1));
    if (Object.keys(copy).length) obj[head] = copy; else delete obj[head];
  }
}

export function applyEffortRules(body, rr, isAgentMode) {
  if (!isAgentMode) {
    if ((rr.kb_mode || 'none') === 'omit') {
      delete body.reasoning_effort;
    } else {
      body.reasoning_effort = 'none';
    }
    if (rr.kb_params && typeof rr.kb_params === 'object') deepMergeParams(body, rr.kb_params);
    return;
  }
  if (body.reasoning_effort === undefined || body.reasoning_effort === null) return;
  let e = String(body.reasoning_effort).toLowerCase();
  const emap = rr.effort_map || {};
  if (Object.prototype.hasOwnProperty.call(emap, e)) {
    const repl = emap[e];
    if (repl === null) {
      delete body.reasoning_effort;
    } else {
      body.reasoning_effort = repl;
      e = String(repl).toLowerCase();
    }
  }
  const e2p = rr.effort_to_params;
  if (e2p && typeof e2p === 'object' && Object.keys(e2p).length) {
    const params = e2p[e] !== undefined ? e2p[e] : e2p['*'];
    if (params && typeof params === 'object') deepMergeParams(body, params);
    if (rr.drop_effort_after_params !== false) delete body.reasoning_effort;
  }
}

function geminiHeadroom(body, rr, thinkingOn) {
  if (thinkingOn && rr.headroom_elevation !== false) {
    for (const f of ['max_tokens', 'max_completion_tokens']) {
      if (typeof body[f] === 'number' && body[f] < 16384) body[f] = 65535;
    }
  }
}

/**
 * Gemini (AI Studio / Vertex): reasoning_effort -> extra_body.google.thinking_config.
 * 3.x uses thinking_level from model_matrix; 2.5 uses thinking_budget (1K/8K/24K).
 * "none" / KB mode use the lowest setting the model allows.
 */
export function applyGeminiThinking(body, rr, modelName, isAgentMode) {
  if (modelName.startsWith('gemma') || modelName.startsWith('google/gemma')) return;
  const name = modelName.includes('/') ? modelName.split('/').slice(1).join('/') : modelName;
  const is25 = name.startsWith('gemini-2.5-');
  const isPro = name.includes('pro');
  const matrix = rr.model_matrix || {};
  let levels = ((isPro ? matrix.pro : matrix.flash) || []).filter((l) => EFFORT_ORDER.includes(l));
  if (!levels.length) levels = isPro ? ['low', 'high'] : ['minimal', 'low', 'medium', 'high'];
  levels.sort((a, b) => EFFORT_ORDER.indexOf(a) - EFFORT_ORDER.indexOf(b));

  const effort = body.reasoning_effort;
  delete body.reasoning_effort;
  if (isAgentMode && (effort === undefined || effort === null)) {
    const cfg = body.extra_body?.google?.thinking_config;
    geminiHeadroom(body, rr, !!cfg && cfg.include_thoughts !== false);
    return;
  }
  let e = isAgentMode ? String(effort).toLowerCase() : 'none';
  if (e === 'xhigh' || e === 'max') e = 'high';

  let tc;
  let thinkingOn;
  if (e === 'none' || e === 'false' || e === 'off') {
    tc = is25 ? { include_thoughts: false, thinking_budget: isPro ? 128 : 0 } : { include_thoughts: false, thinking_level: levels[0] };
    thinkingOn = false;
  } else {
    if (!EFFORT_ORDER.includes(e)) e = 'medium';
    if (is25) {
      tc = { include_thoughts: true, thinking_budget: GEMINI25_BUDGET[e] };
    } else {
      const req = EFFORT_ORDER.indexOf(e);
      let lvl = levels[0];
      for (const l of levels) if (EFFORT_ORDER.indexOf(l) <= req) lvl = l;
      tc = { include_thoughts: true, thinking_level: lvl };
    }
    thinkingOn = true;
  }
  body.extra_body = { ...(body.extra_body || {}) };
  body.extra_body.google = { ...(body.extra_body.google || {}), thinking_config: tc };
  geminiHeadroom(body, rr, thinkingOn);
}

export function applyAdapterRules(body, rules, isAgentMode = true, isAnthropic = false) {
  if (!body || typeof body !== 'object' || !rules || typeof rules !== 'object') return body;

  const modelName = String(body.model || '').toLowerCase();

  // 1. Model casing mapping
  const casingMap = rules.case_sensitive_models;
  if (casingMap && typeof casingMap === 'object') {
    for (const [k, v] of Object.entries(casingMap)) {
      if (modelName === k.toLowerCase()) {
        body.model = v;
        break;
      }
    }
  }

  // 1b. Model alias mapping (e.g. cline-free/muse-spark-1.3 -> meta/muse-spark-1.3, gemini-3.5-flash -> google/gemini-3.5-flash)
  const aliasMap = rules.model_alias;
  if (aliasMap && typeof aliasMap === 'object') {
    for (const [k, v] of Object.entries(aliasMap)) {
      if (modelName === k.toLowerCase() || modelName === v.toLowerCase()) {
        body.model = v;
        break;
      }
    }
  }

  // 1c. Ensure Google prefix for Vertex AI
  if (rules.ensure_google_prefix) {
    if (typeof body.model === 'string' && body.model && !body.model.startsWith('google/')) {
      body.model = 'google/' + body.model;
    }
  }

  // 2. Sanitization (parameter blacklisting and clamping)
  const stripParams = rules.sanitization?.strip_params || rules.sanitization?.unsupported_params;
  if (Array.isArray(stripParams)) {
    for (const sp of stripParams) {
      stripParam(body, String(sp));
    }
  }
  const maxTokensCeil = rules.sanitization?.max_tokens_ceiling;
  if (typeof maxTokensCeil === 'number' && maxTokensCeil > 0) {
    if (typeof body.max_tokens === 'number' && body.max_tokens > maxTokensCeil) {
      body.max_tokens = maxTokensCeil;
    }
    if (typeof body.max_completion_tokens === 'number' && body.max_completion_tokens > maxTokensCeil) {
      body.max_completion_tokens = maxTokensCeil;
    }
  }

  // 3. Messages normalization
  const msgRules = rules.messages;
  if (msgRules && typeof msgRules === 'object' && Array.isArray(body.messages) && body.messages.length > 0) {
    const denyDev = Boolean(msgRules.deny_developer_role);
    const sysFirst = Boolean(msgRules.system_first_only);
    const mergeSys = Boolean(msgRules.merge_system);
    const stripEmpty = Boolean(msgRules.strip_empty);

    if (sysFirst || mergeSys || denyDev || stripEmpty) {
      const systemParts = [];
      const otherMessages = [];

      for (const m of body.messages) {
        if (!m || typeof m !== 'object') continue;
        let role = m.role;
        if (role === 'developer' && denyDev) {
          role = 'system';
        }

        const content = m.content;
        if (stripEmpty && (content === null || content === undefined || content === '' || (Array.isArray(content) && content.length === 0))) {
          continue;
        }

        if (role === 'system' && (sysFirst || mergeSys)) {
          if (typeof content === 'string' && content.trim()) {
            systemParts.push(content.trim());
          } else if (Array.isArray(content)) {
            for (const part of content) {
              if (part && typeof part === 'object' && part.type === 'text' && part.text) {
                systemParts.push(String(part.text).trim());
              } else if (typeof part === 'string' && part.trim()) {
                systemParts.push(part.trim());
              }
            }
          }
        } else {
          const mCopy = { ...m };
          if (role !== m.role) {
            mCopy.role = role;
          }
          otherMessages.push(mCopy);
        }
      }

      if (sysFirst || mergeSys) {
        const newMessages = [];
        if (systemParts.length > 0) {
          newMessages.push({
            role: 'system',
            content: systemParts.join('\n\n')
          });
        }
        newMessages.push(...otherMessages);
        body.messages = newMessages;
      }
    }
  }

  // 3b. Thinking protocol & reasoning block filtering on messages
  let thinkingPolicy = rules.thinking_policy || rules.reasoning?.thinking_policy;
  if (!thinkingPolicy && isAnthropic) {
    const idLower = modelName.toLowerCase();
    if (['claude-', 'opus-', 'sonnet-', 'haiku-'].some(p => idLower.startsWith(p))) {
      thinkingPolicy = 'strict_signature';
    } else if (['deepseek-', 'kimi-', 'moonshot-', 'glm-', 'minimax-'].some(p => idLower.startsWith(p)) || idLower.includes('-thinking') || idLower === 'k3' || idLower === 'k3-256k') {
      thinkingPolicy = 'passback_required';
    }
  }

  if (thinkingPolicy && Array.isArray(body.messages)) {
    for (const m of body.messages) {
      if (!m || typeof m !== 'object' || m.role !== 'assistant') continue;
      if (Array.isArray(m.content)) {
        const newContent = [];
        for (const b of m.content) {
          if (b && typeof b === 'object' && b.type === 'thinking') {
            if (thinkingPolicy === 'strip') {
              continue;
            } else if (thinkingPolicy === 'strict_signature' && !b.signature) {
              continue;
            }
          }
          newContent.push(b);
        }
        m.content = newContent;
      } else if (thinkingPolicy === 'strip') {
        delete m.reasoning_content;
        delete m.reasoning;
      }
    }
  }

  // 4. Tools schema normalization
  const toolRules = rules.tools;
  if (toolRules && typeof toolRules === 'object') {
    if (toolRules.normalize_choice_to_string && body.tool_choice && typeof body.tool_choice === 'object') {
      body.tool_choice = 'auto';
    }

    if (toolRules.deep_schema_sanitization || toolRules.strip_json_schema) {
      if (Array.isArray(body.tools)) {
        body.tools = body.tools.map((t) => {
          if (t && t.type === 'function' && t.function && t.function.parameters) {
            return {
              ...t,
              function: {
                ...t.function,
                parameters: sanitizeGeminiSchema(t.function.parameters),
              },
            };
          }
          return t;
        });
      }
    }
  }

  // 5. Injected parameters
  const injectParams = rules.inject_params || rules.reasoning?.inject_params;
  if (injectParams && typeof injectParams === 'object') {
    for (const [ik, iv] of Object.entries(injectParams)) {
      if (body[ik] === undefined) {
        body[ik] = iv;
      }
    }
  }

  // 6. Reasoning control (declarative, driven by preset `reasoning` rules)
  const reasoningRules = rules.reasoning;
  if (reasoningRules && typeof reasoningRules === 'object' && !isAnthropic) {
    const strat = reasoningRules.strategy || 'openai_passthrough';
    if (strat === 'gemini_thinking_matrix') {
      applyGeminiThinking(body, reasoningRules, modelName, isAgentMode);
    } else {
      applyEffortRules(body, reasoningRules, isAgentMode);
    }
  }

  // 7. Anthropic Messages endpoint specific rules
  if (isAnthropic) {
    if (!body.max_tokens || typeof body.max_tokens !== 'number' || body.max_tokens <= 0) {
      body.max_tokens = 4096;
    }
  }

  return body;
}

/**
 * Public normalisation API for chat completions.
 */
export function normaliseForProvider(body, provider, configOverride = null, isAgentMode = true) {
  if (!body || typeof body !== 'object') return body;
  const p = String(provider || '').toLowerCase();
  const preset = getPreset(p) || {};
  const rules = configOverride?.adapter_rules || preset.adapter_rules || {};
  const agentMode = configOverride?.isAgentMode !== undefined ? configOverride.isAgentMode : isAgentMode;
  return applyAdapterRules(body, rules, agentMode, false);
}

/**
 * Public normalisation API for Anthropic messages.
 */
export function normaliseMessagesForProvider(body, provider, configOverride = null) {
  if (!body || typeof body !== 'object') return body;
  const p = String(provider || '').toLowerCase();
  const preset = getPreset(p) || {};
  const rules = configOverride?.adapter_rules || preset.adapter_rules || {};
  return applyAdapterRules(body, rules, true, true);
}

/**
 * Normalise response JSON (non-streaming) based on declarative response rules.
 */
export function normalizeResponseReasoning(data, rules = {}) {
  if (!data || typeof data !== 'object') return data;
  const respRules = rules?.response;
  if (!respRules || typeof respRules !== 'object') return data;
  const reasoningFields = respRules.reasoning_fields;
  if (!Array.isArray(reasoningFields) || reasoningFields.length === 0) return data;

  if (Array.isArray(data.choices)) {
    for (const ch of data.choices) {
      if (!ch || typeof ch !== 'object') continue;
      const msg = ch.message;
      if (msg && typeof msg === 'object') {
        if (!msg.reasoning_content) {
          for (const rf of reasoningFields) {
            if (msg[rf]) {
              msg.reasoning_content = msg[rf];
              break;
            }
          }
        }
      }
    }
  }

  if (data.usage && typeof data.usage === 'object') {
    if (!data.usage.reasoning_tokens) {
      const details = data.usage.completion_tokens_details;
      if (details && typeof details === 'object' && details.reasoning_tokens !== undefined) {
        data.usage.reasoning_tokens = details.reasoning_tokens;
      }
    }
  }

  return data;
}

/**
 * Tool-call Rescue helper:
 * When an LLM model emits raw JSON or <tool_call> tags in markdown text
 * instead of structured tool_calls, extract and rescue it into standard OpenAI tool_calls.
 */
export function rescueToolCallsFromText(content) {
  if (!content || typeof content !== 'string') return null;
  const trimmed = content.trim();

  // Pattern 1: ```json { "name": "fn", "arguments": { ... } } ```
  const jsonBlockMatch = trimmed.match(/```(?:json)?\s*(\{\s*"name"\s*:\s*"[^"]+".*?\})\s*```/s);
  if (jsonBlockMatch) {
    try {
      const parsed = JSON.parse(jsonBlockMatch[1]);
      if (parsed.name && (parsed.arguments || parsed.parameters)) {
        return [{
          id: `call_rescue_${Date.now()}`,
          type: 'function',
          function: {
            name: parsed.name,
            arguments: typeof parsed.arguments === 'string' ? parsed.arguments : JSON.stringify(parsed.arguments || parsed.parameters || {}),
          },
        }];
      }
    } catch {}
  }

  // Pattern 2: <tool_call> { "name": ... } </tool_call>
  const xmlMatch = trimmed.match(/<tool_call>\s*(\{.*?\})\s*<\/tool_call>/s);
  if (xmlMatch) {
    try {
      const parsed = JSON.parse(xmlMatch[1]);
      if (parsed.name) {
        return [{
          id: `call_rescue_${Date.now()}`,
          type: 'function',
          function: {
            name: parsed.name,
            arguments: typeof parsed.arguments === 'string' ? parsed.arguments : JSON.stringify(parsed.arguments || {}),
          },
        }];
      }
    } catch {}
  }

  return null;
}

/**
 * Wraps an upstream ReadableStream or reader with pull-based backpressure and keep-alive SSE comments.
 * If no chunk is emitted for `intervalMs` (default 5000ms), an SSE comment ": keep-alive\n\n" is enqueued
 * to maintain the connection with downstream clients / edge gateways without buffering leaks.
 * Supports optional `initialChunk` from upstream chunk peeking or `pendingFirstChunkPromise`
 * when peeking was still in progress after the initial fast race window.
 */
export function createKeepAliveStream(bodyOrReader, intervalMs = 5000, initialChunk = null, pendingFirstChunkPromise = null) {
  if (!bodyOrReader) return null;
  const reader = typeof bodyOrReader.getReader === 'function' ? bodyOrReader.getReader() : bodyOrReader;
  if (!reader || typeof reader.read !== 'function') {
    return bodyOrReader;
  }

  const encoder = new TextEncoder();
  let timer = null;
  let unconsumedInitial = initialChunk;
  let pendingPromise = pendingFirstChunkPromise;

  const resetTimer = (controller) => {
    if (timer) clearInterval(timer);
    timer = setInterval(() => {
      try {
        controller.enqueue(encoder.encode(': keep-alive\n\n'));
      } catch (e) {
        if (timer) {
          clearInterval(timer);
          timer = null;
        }
      }
    }, intervalMs);
  };

  const isSseDone = (chunk) => {
    if (!chunk) return false;
    try {
      const text = typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk);
      return text.includes('data: [DONE]') || text.includes('data:[DONE]');
    } catch (e) {
      return false;
    }
  };

  return new ReadableStream({
    start(controller) {
      resetTimer(controller);
    },
    async pull(controller) {
      if (unconsumedInitial) {
        const chunk = unconsumedInitial;
        unconsumedInitial = null;
        resetTimer(controller);
        controller.enqueue(chunk);
        if (isSseDone(chunk)) {
          if (timer) {
            clearInterval(timer);
            timer = null;
          }
          try { reader.cancel(); } catch (e) {}
          controller.close();
        }
        return;
      }

      if (pendingPromise) {
        const p = pendingPromise;
        pendingPromise = null;
        try {
          const { done, value } = await p;
          if (done) {
            if (timer) {
              clearInterval(timer);
              timer = null;
            }
            controller.close();
            return;
          }
          if (value) {
            resetTimer(controller);
            controller.enqueue(value);
            if (isSseDone(value)) {
              if (timer) {
                clearInterval(timer);
                timer = null;
              }
              try { reader.cancel(); } catch (e) {}
              controller.close();
              return;
            }
          }
        } catch (err) {
          if (timer) {
            clearInterval(timer);
            timer = null;
          }
          try {
            const errPayload = JSON.stringify({
              error: {
                type: 'upstream_error',
                message: `Stream read error: ${err?.message || String(err)}`,
                code: 'stream_exception',
              },
            });
            controller.enqueue(encoder.encode(`event: error\ndata: ${errPayload}\n\n`));
          } catch (_) {}
          controller.close();
          return;
        }
        return;
      }

      try {
        const { done, value } = await reader.read();
        if (done) {
          if (timer) {
            clearInterval(timer);
            timer = null;
          }
          controller.close();
        } else if (value) {
          resetTimer(controller);
          controller.enqueue(value);
          if (isSseDone(value)) {
            if (timer) {
              clearInterval(timer);
              timer = null;
            }
            try { reader.cancel(); } catch (e) {}
            controller.close();
          }
        }
      } catch (err) {
        if (timer) {
          clearInterval(timer);
          timer = null;
        }
        try {
          const errPayload = JSON.stringify({
            error: {
              type: 'upstream_error',
              message: `Stream read error: ${err?.message || String(err)}`,
              code: 'stream_exception',
            },
          });
          controller.enqueue(encoder.encode(`event: error\ndata: ${errPayload}\n\n`));
        } catch (_) {}
        controller.close();
      }
    },
    cancel(reason) {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
      try {
        return reader.cancel(reason);
      } catch (e) {}
    }
  });
}


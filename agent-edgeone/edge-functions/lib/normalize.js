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
 * Apply declarative provider-specific body normalizations. Mutates `body` in place.
 *
 * @param {Object} body - parsed JSON body, will be mutated
 * @param {string} provider - provider name (e.g. "stepfun", "google", "sensenova", "agnes")
 * @param {Object} [configOverride] - optional custom adapter rules from provider config
 * @returns {Object} the same body (for chaining)
 */
export function normaliseForProvider(body, provider, configOverride = null) {
  if (!body || typeof body !== 'object') return body;
  const p = String(provider || '').toLowerCase();
  const modelName = String(body.model || '').toLowerCase();

  // 1. Resolve preset & rules (declarative schema)
  const preset = getPreset(p) || {};
  const rules = configOverride?.adapter_rules || preset.adapter_rules || {};

  // 2. Reasoning / Thinking level adapter
  const reasoningRules = rules.reasoning || {};
  const isGoogle = reasoningRules.strategy === 'gemini_thinking_matrix' || p.includes('google') || modelName.startsWith('gemini');
  const isMiniMax = reasoningRules.strategy === 'minimax_adaptive' || p === 'minimax' || modelName.startsWith('minimax');

  // MiniMax model casing and parameter sanitization
  if (p === 'minimax' || isMiniMax) {
    if (String(body.model || '').toLowerCase() === 'minimax-m3') {
      body.model = 'MiniMax-M3';
    }
    delete body.output_config;
  }

  if (body.reasoning_effort !== undefined) {
    const rawEffort = String(body.reasoning_effort).toLowerCase();

    if (isGoogle) {
      const isGemma = modelName.startsWith('gemma');
      if (!isGemma) {
        body.extra_body = body.extra_body || {};
        body.extra_body.google = body.extra_body.google || {};
        const isGemini25 = modelName.startsWith('gemini-2.5-');
        const isPro = modelName.includes('pro');

        if (rawEffort === 'none' || rawEffort === 'false') {
          body.extra_body.google.thinking_config = { include_thoughts: false };
        } else if (isGemini25) {
          body.extra_body.google.thinking_config = { include_thoughts: true };
        } else {
          let thinkingLevel = 'low';
          if (rawEffort === 'high' || rawEffort === 'xhigh' || rawEffort === 'max') {
            thinkingLevel = 'high';
          } else if (rawEffort === 'medium' && !isPro) {
            thinkingLevel = 'medium';
          } else {
            thinkingLevel = 'low';
          }
          body.extra_body.google.thinking_config = {
            include_thoughts: true,
            thinking_level: thinkingLevel,
          };
        }
      }
      delete body.reasoning_effort;
    } else if (isMiniMax) {
      if (rawEffort === 'none' || rawEffort === 'false') {
        body.thinking = { type: 'disabled' };
        delete body.reasoning_split;
      } else {
        body.reasoning_split = true;
        body.thinking = { type: 'adaptive' };
      }
      delete body.reasoning_effort;
    } else if (reasoningRules.strategy === 'chat_template_kwargs' || p === 'agnes' || modelName.startsWith('agnes') || p === 'amd') {
      body.chat_template_kwargs = body.chat_template_kwargs || {};
      const enableKey = p === 'amd' ? 'thinking' : (reasoningRules.enable_key || 'enable_thinking');
      if (body.chat_template_kwargs[enableKey] === undefined) {
        body.chat_template_kwargs[enableKey] = (rawEffort !== 'none' && rawEffort !== 'false');
      }
      delete body.reasoning_effort;
    } else if (reasoningRules.strategy === 'effort_remapping' || p === 'stepfun') {
      const supported = reasoningRules.supported_levels || ['low', 'medium', 'high'];
      if (!supported.includes(rawEffort)) {
        body.reasoning_effort = reasoningRules.none_fallback || 'low';
      }
      if (reasoningRules.inject_params) {
        for (const [ik, iv] of Object.entries(reasoningRules.inject_params)) {
          if (body[ik] === undefined) {
            body[ik] = iv;
          }
        }
      }
    }
  } else {
    // If client did not specify reasoning_effort:
    if (p === 'amd') {
      // Default to thinking: true for AMD models if not explicitly disabled
      body.chat_template_kwargs = body.chat_template_kwargs || {};
      if (body.chat_template_kwargs.thinking === undefined) {
        body.chat_template_kwargs.thinking = true;
      }
    } else if (isMiniMax) {
      if (body.thinking && typeof body.thinking === 'object') {
        const t = String(body.thinking.type || '').toLowerCase();
        if (t === 'disabled') {
          body.thinking = { type: 'disabled' };
          delete body.reasoning_split;
        } else {
          body.reasoning_split = true;
          body.thinking = { type: 'adaptive' };
        }
      } else {
        // Default for MiniMax-M3 in OpenAI mode: enable reasoning_split so Hermes and standard OpenAI clients receive reasoning_content cleanly
        body.reasoning_split = true;
        if (!body.thinking) {
          body.thinking = { type: 'adaptive' };
        }
      }
    } else if (reasoningRules.inject_params) {
      for (const [ik, iv] of Object.entries(reasoningRules.inject_params)) {
        if (body[ik] === undefined) {
          body[ik] = iv;
        }
      }
    }
  }

  // Max output tokens headroom elevation for Google Gemini thinking
  if (isGoogle) {
    const thinkingCfg = body.extra_body?.google?.thinking_config;
    const isThinkingOn = thinkingCfg?.include_thoughts !== false && (thinkingCfg?.include_thoughts === true || thinkingCfg?.thinking_level);
    if (isThinkingOn) {
      if (typeof body.max_tokens === 'number' && body.max_tokens < 16384) {
        body.max_tokens = 65535;
      }
      if (typeof body.max_completion_tokens === 'number' && body.max_completion_tokens < 16384) {
        body.max_completion_tokens = 65535;
      }
    }
  }

  // 3. Tool Calling adapter
  const toolRules = rules.tools || {};
  if (toolRules.normalize_choice_to_string || p === 'tokenrhythm' || p === 'sensenova' || p === 'deepseek') {
    if (body.tool_choice && typeof body.tool_choice === 'object') {
      body.tool_choice = 'auto';
    }
  }

  if (toolRules.strip_json_schema || isGoogle) {
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

  // 4. Parameter sanitization
  if (rules.sanitization?.unsupported_params) {
    for (const field of rules.sanitization.unsupported_params) {
      delete body[field];
    }
  }

  return body;
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

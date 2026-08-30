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

const PROVIDERS_NO_NONE_EFFORT = new Set(['stepfun']);
const PROVIDERS_NO_OBJECT_TOOL_CHOICE = new Set(['tokenrhythm']);
const GOOGLE_PROVIDERS = new Set(['google', 'gemini', 'aistudio', 'google-ai']);

/**
 * Sanitize JSON Schema for Google Gemini tools.
 * Gemini strictly rejects $schema, and non-standard keywords in parameters.
 */
function sanitizeGeminiSchema(schema) {
  if (!schema || typeof schema !== 'object') return schema;
  if (Array.isArray(schema)) {
    return schema.map(sanitizeGeminiSchema);
  }
  const clean = { ...schema };
  delete clean['$schema'];
  if (clean.properties && typeof clean.properties === 'object') {
    const props = {};
    for (const [k, v] of Object.entries(clean.properties)) {
      props[k] = sanitizeGeminiSchema(v);
    }
    clean.properties = props;
  }
  if (clean.items) {
    clean.items = sanitizeGeminiSchema(clean.items);
  }
  return clean;
}

/**
 * Apply provider-specific body normalizations.  Mutates `body` in place.
 *
 * @param {Object} body - parsed JSON body, will be mutated
 * @param {string} provider - provider name (e.g. "stepfun", "google")
 * @returns {Object} the same body (for chaining)
 */
export function normaliseForProvider(body, provider) {
  if (!body || typeof body !== 'object') return body;
  const p = String(provider || '').toLowerCase();

  // 1) StepFun: reasoning_effort: "none" → "low"
  if (PROVIDERS_NO_NONE_EFFORT.has(p)) {
    if (body.reasoning_effort === 'none') {
      body.reasoning_effort = 'low';
    }
    if (body.reasoning_format === undefined) {
      body.reasoning_format = 'deepseek-style';
    }
  }

  // 2) TokenRhythm: tool_choice: object → "auto"
  if (PROVIDERS_NO_OBJECT_TOOL_CHOICE.has(p)) {
    if (body.tool_choice && typeof body.tool_choice === 'object') {
      body.tool_choice = 'auto';
    }
  }

  // 3) Google AI Studio / Gemini Adaptation (Gemini 2.5 / 3 / 3.5+)
  const isGoogle = GOOGLE_PROVIDERS.has(p) || String(body.model || '').toLowerCase().startsWith('gemini');
  if (isGoogle) {
    // A. Map reasoning_effort to extra_body.google.thinking_config
    if (body.reasoning_effort !== undefined) {
      const effort = String(body.reasoning_effort).toLowerCase();
      body.extra_body = body.extra_body || {};
      body.extra_body.google = body.extra_body.google || {};
      
      const modelName = String(body.model || '').toLowerCase();
      const isGemini25 = modelName.startsWith('gemini-2.5-');
      const isPro = modelName.includes('pro');

      if (effort === 'none' || effort === 'false') {
        body.extra_body.google.thinking_config = { include_thoughts: false };
      } else if (isGemini25) {
        // Gemini 2.5 only supports include_thoughts
        body.extra_body.google.thinking_config = { include_thoughts: true };
      } else {
        // Gemini 3 / 3.1 / 3.5: Flash supports low/medium/high, Pro supports low/high
        let thinkingLevel = 'low';
        if (effort === 'high' || effort === 'xhigh' || effort === 'max') {
          thinkingLevel = 'high';
        } else if (effort === 'medium' && !isPro) {
          thinkingLevel = 'medium';
        } else {
          thinkingLevel = 'low';
        }
        body.extra_body.google.thinking_config = {
          include_thoughts: true,
          thinking_level: thinkingLevel,
        };
      }
      // Drop top-level reasoning_effort so Google doesn't return 400
      delete body.reasoning_effort;
    }

    // B. Sanitize tools function parameters
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

  // 4) Agnes AI: map reasoning_effort to chat_template_kwargs.enable_thinking
  if (p === 'agnes' || String(body.model || '').toLowerCase().startsWith('agnes')) {
    if (body.reasoning_effort !== undefined) {
      const effort = String(body.reasoning_effort).toLowerCase();
      body.chat_template_kwargs = body.chat_template_kwargs || {};
      if (body.chat_template_kwargs.enable_thinking === undefined) {
        body.chat_template_kwargs.enable_thinking = (effort !== 'none' && effort !== 'false');
      }
      delete body.reasoning_effort;
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

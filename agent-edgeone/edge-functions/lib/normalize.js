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

  // 2. Sanitization (parameter blacklisting and clamping)
  const stripParams = rules.sanitization?.strip_params || rules.sanitization?.unsupported_params;
  if (Array.isArray(stripParams)) {
    for (const sp of stripParams) {
      delete body[sp];
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

  // 6. Reasoning strategy execution
  const reasoningRules = rules.reasoning;
  if (reasoningRules && typeof reasoningRules === 'object') {
    const strat = reasoningRules.strategy || 'openai_passthrough';

    let modelSpecific = {};
    if (reasoningRules.model_rules && typeof reasoningRules.model_rules === 'object') {
      for (const [mPrefix, mCfg] of Object.entries(reasoningRules.model_rules)) {
        if (modelName.includes(mPrefix.toLowerCase())) {
          modelSpecific = mCfg;
          break;
        }
      }
    }

    if (!isAgentMode) {
      // KB mode: suppress thinking latency
      if (strat === 'gemini_thinking_matrix') {
        delete body.reasoning_effort;
        body.extra_body = body.extra_body || {};
        body.extra_body.google = body.extra_body.google || {};
        body.extra_body.google.thinking_config = { include_thoughts: false };
      } else if (strat === 'minimax_adaptive') {
        delete body.reasoning_effort;
        delete body.reasoning_split;
        body.thinking = { type: 'disabled' };
      } else if (strat === 'chat_template_kwargs') {
        delete body.reasoning_effort;
        body.chat_template_kwargs = body.chat_template_kwargs || {};
        const enableKey = reasoningRules.enable_key || 'enable_thinking';
        body.chat_template_kwargs[enableKey] = false;
      } else if (strat === 'effort_remapping') {
        delete body.thinking;
        const noneFb = modelSpecific.none_fallback || reasoningRules.none_fallback;
        const noneAct = modelSpecific.none_action || reasoningRules.none_action;
        if (noneAct === 'omit' && !noneFb) {
          delete body.reasoning_effort;
        } else if (noneFb) {
          body.reasoning_effort = noneFb;
        } else {
          body.reasoning_effort = 'none';
        }
      } else {
        body.reasoning_effort = 'none';
      }
    } else {
      // Agent mode
      if (strat === 'gemini_thinking_matrix') {
        const isGemma = modelName.startsWith('gemma');
        let thinkingEnabled = false;

        if (!isGemma) {
          const rawEffort = body.reasoning_effort !== undefined ? String(body.reasoning_effort).toLowerCase() : null;
          if (rawEffort !== null) {
            delete body.reasoning_effort;
            body.extra_body = body.extra_body || {};
            body.extra_body.google = body.extra_body.google || {};
            const isGemini25 = modelName.startsWith('gemini-2.5-');
            const isPro = modelName.includes('pro');

            if (rawEffort === 'none' || rawEffort === 'false') {
              body.extra_body.google.thinking_config = { include_thoughts: false };
            } else if (isGemini25) {
              body.extra_body.google.thinking_config = { include_thoughts: true };
              thinkingEnabled = true;
            } else {
              let thinkingLevel = 'low';
              if (rawEffort === 'high' || rawEffort === 'xhigh' || rawEffort === 'max') {
                thinkingLevel = 'high';
              } else if (rawEffort === 'medium' && !isPro) {
                thinkingLevel = 'medium';
              }
              body.extra_body.google.thinking_config = {
                include_thoughts: true,
                thinking_level: thinkingLevel,
              };
              thinkingEnabled = true;
            }
          } else {
            const cfg = body.extra_body?.google?.thinking_config;
            if (cfg?.include_thoughts !== false && cfg?.thinking_level) {
              thinkingEnabled = true;
            }
          }
        }

        if (thinkingEnabled && reasoningRules.headroom_elevation !== false) {
          if (typeof body.max_tokens === 'number' && body.max_tokens < 16384) {
            body.max_tokens = 65535;
          }
          if (typeof body.max_completion_tokens === 'number' && body.max_completion_tokens < 16384) {
            body.max_completion_tokens = 65535;
          }
        }
      } else if (strat === 'minimax_adaptive') {
        const rawEffort = body.reasoning_effort !== undefined ? String(body.reasoning_effort).toLowerCase() : null;
        if (rawEffort !== null) {
          delete body.reasoning_effort;
          if (rawEffort === 'none' || rawEffort === 'false') {
            body.thinking = { type: 'disabled' };
            delete body.reasoning_split;
          } else {
            if (reasoningRules.enable_reasoning_split !== false) {
              body.reasoning_split = true;
            }
            body.thinking = { type: 'adaptive' };
          }
        } else if (body.thinking && typeof body.thinking === 'object') {
          const t = String(body.thinking.type || '').toLowerCase();
          if (t === 'disabled') {
            body.thinking = { type: 'disabled' };
            delete body.reasoning_split;
          } else {
            if (reasoningRules.enable_reasoning_split !== false) {
              body.reasoning_split = true;
            }
            body.thinking = { type: 'adaptive' };
          }
        } else {
          if (reasoningRules.enable_reasoning_split !== false) {
            body.reasoning_split = true;
          }
          if (!body.thinking) {
            body.thinking = { type: reasoningRules.default_type || 'adaptive' };
          }
        }
      } else if (strat === 'chat_template_kwargs') {
        const rawEffort = body.reasoning_effort !== undefined ? String(body.reasoning_effort).toLowerCase() : null;
        if (rawEffort !== null) {
          delete body.reasoning_effort;
          body.chat_template_kwargs = body.chat_template_kwargs || {};
          const enableKey = reasoningRules.enable_key || 'enable_thinking';
          if (body.chat_template_kwargs[enableKey] === undefined) {
            body.chat_template_kwargs[enableKey] = (rawEffort !== 'none' && rawEffort !== 'false');
          }
        } else if (reasoningRules.default_thinking) {
          body.chat_template_kwargs = body.chat_template_kwargs || {};
          const enableKey = reasoningRules.enable_key || 'enable_thinking';
          if (body.chat_template_kwargs[enableKey] === undefined) {
            body.chat_template_kwargs[enableKey] = true;
          }
        }
      } else if (strat === 'effort_remapping') {
        if (reasoningRules.strip_thinking) {
          delete body.thinking;
        }
        if (body.reasoning_effort !== undefined) {
          const reStr = String(body.reasoning_effort).toLowerCase();
          const supported = modelSpecific.supported_levels || reasoningRules.supported_levels || ['low', 'medium', 'high'];
          const fallbacks = modelSpecific.level_fallback || reasoningRules.level_fallback || {};
          const noneFb = modelSpecific.none_fallback || reasoningRules.none_fallback;
          const noneAct = modelSpecific.none_action || reasoningRules.none_action;

          if (reStr === 'none' || reStr === 'false') {
            if (supported.includes('none') && !noneFb && noneAct !== 'omit') {
              body.reasoning_effort = 'none';
            } else if (noneFb) {
              body.reasoning_effort = noneFb;
            } else if (noneAct === 'omit') {
              delete body.reasoning_effort;
            } else {
              body.reasoning_effort = 'low';
            }
          } else if (fallbacks[reStr]) {
            body.reasoning_effort = fallbacks[reStr];
          } else if (!supported.includes(reStr)) {
            body.reasoning_effort = fallbacks[reStr] || reasoningRules.default_effort || 'medium';
          }
        } else {
          const defaultEff = modelSpecific.default_effort || reasoningRules.default_effort;
          if (defaultEff) {
            body.reasoning_effort = defaultEff;
          }
        }
      } else if (strat === 'openai_passthrough') {
        const supported = reasoningRules.supported_levels || ['none', 'low', 'medium', 'high'];
        if (body.reasoning_effort === 'none' && !supported.includes('none')) {
          body.reasoning_effort = reasoningRules.none_fallback || 'low';
        }
      }
    }
  }

  // 7. Anthropic Messages endpoint specific rules
  if (isAnthropic) {
    if (!body.max_tokens || typeof body.max_tokens !== 'number' || body.max_tokens <= 0) {
      body.max_tokens = 4096;
    }

    const anthropicRules = rules.anthropic;
    if (anthropicRules && typeof anthropicRules === 'object') {
      if (anthropicRules.strip_thinking) {
        const thinking = body.thinking;
        delete body.thinking;
        if (anthropicRules.thinking_to_output_config) {
          if (thinking && typeof thinking === 'object' && String(thinking.type || '').toLowerCase() !== 'disabled') {
            body.output_config = { effort: anthropicRules.default_effort || 'medium' };
          } else if (body.output_config && typeof body.output_config === 'object') {
            const eff = String(body.output_config.effort || '').toLowerCase();
            const modelRules = anthropicRules.model_rules || {};
            for (const [mk, mc] of Object.entries(modelRules)) {
              if (modelName.includes(mk.toLowerCase())) {
                const fb = mc.level_fallback || {};
                if (fb[eff]) {
                  body.output_config.effort = fb[eff];
                }
                break;
              }
            }
          }
        }
      } else if (anthropicRules.thinking_to_adaptive) {
        if (body.thinking && typeof body.thinking === 'object') {
          const t = String(body.thinking.type || '').toLowerCase();
          if (t === 'enabled' || (!body.thinking.type && body.thinking.budget_tokens)) {
            body.thinking.type = 'adaptive';
          }
        }
      }
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
  const respRules = rules?.response || {};
  const reasoningFields = respRules.reasoning_fields || ['reasoning_split', 'reasoning_content', 'reasoning'];

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
 * Wraps an upstream ReadableStream so that if no chunk is emitted for
 * `intervalMs` (default 15s), an SSE comment ": keep-alive\n\n" is enqueued
 * to maintain the connection with downstream clients / edge gateways.
 */
export function createKeepAliveStream(upstreamBody, intervalMs = 15000) {
  if (!upstreamBody || typeof upstreamBody.getReader !== 'function') {
    return upstreamBody;
  }
  const reader = upstreamBody.getReader();
  const encoder = new TextEncoder();
  let timer = null;

  return new ReadableStream({
    async start(controller) {
      const scheduleKeepAlive = () => {
        timer = setTimeout(() => {
          try {
            controller.enqueue(encoder.encode(': keep-alive\n\n'));
            scheduleKeepAlive();
          } catch (e) {}
        }, intervalMs);
      };

      scheduleKeepAlive();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (timer) {
            clearTimeout(timer);
            timer = null;
          }
          if (done) {
            break;
          }
          controller.enqueue(value);
          scheduleKeepAlive();
        }
        controller.close();
      } catch (err) {
        controller.error(err);
      } finally {
        if (timer) clearTimeout(timer);
      }
    },
    cancel(reason) {
      if (timer) clearTimeout(timer);
      return reader.cancel(reason);
    }
  });
}

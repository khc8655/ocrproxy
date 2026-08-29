/**
 * normalize.js — Provider-specific request body normalization.
 *
 * Ported from `vm-app/app/proxy_routes.py:_normalise_for_provider` and
 * `_disable_thinking_for_kb`.  Edge Function does NOT do KB mode
 * (chat is always Agent mode = real model name = transparent passthrough),
 * so only Agent-side normalizations are included.
 *
 * Rules (kept identical to VM to keep behaviour in sync):
 *   1. reasoning_effort: "none" → "low" for providers that don't accept "none"
 *      (currently: stepfun)
 *   2. tool_choice: object form → "auto" for providers that reject objects
 *      (currently: tokenrhythm)
 *   3. StepFun: set reasoning_format="deepseek-style" so agent tools receive
 *      reasoning_content (not the StepFun-native "reasoning" field).
 *
 * Adding a new provider:
 *   1. Add the provider name to one of the sets below.
 *   2. (Optional) add a per-provider block.
 */

const PROVIDERS_NO_NONE_EFFORT = new Set(['stepfun']);
const PROVIDERS_NO_OBJECT_TOOL_CHOICE = new Set(['tokenrhythm']);

/**
 * Apply provider-specific body normalizations.  Mutates `body` in place.
 *
 * @param {Object} body - parsed JSON body, will be mutated
 * @param {string} provider - provider name (e.g. "stepfun")
 * @returns {Object} the same body (for chaining)
 */
export function normaliseForProvider(body, provider) {
  if (!body || typeof body !== 'object') return body;

  // 1) reasoning_effort: "none" → "low"
  if (PROVIDERS_NO_NONE_EFFORT.has(provider)) {
    if (body.reasoning_effort === 'none') {
      body.reasoning_effort = 'low';
    }
  }

  // 2) tool_choice: object → "auto"
  if (PROVIDERS_NO_OBJECT_TOOL_CHOICE.has(provider)) {
    if (body.tool_choice && typeof body.tool_choice === 'object') {
      body.tool_choice = 'auto';
    }
  }

  // 3) StepFun: inject reasoning_format so agent gets reasoning_content
  if (provider === 'stepfun' && body.reasoning_format === undefined) {
    body.reasoning_format = 'deepseek-style';
  }

  return body;
}

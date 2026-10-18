import { normaliseForProvider, applyAdapterRules, normalizeResponseReasoning } from '../agent-edgeone/edge-functions/lib/normalize.js';
import { getPreset } from '../agent-edgeone/edge-functions/lib/presets/index.js';

let passed = 0;
let failed = 0;

function check(name, condition) {
  if (condition) {
    passed++;
    console.log(`  PASS: ${name}`);
  } else {
    failed++;
    console.log(`  FAIL: ${name}`);
  }
}

console.log('=== EdgeOne Normalize.js Verification ===');

// 1. OpenAI
const bOpenai = { model: 'gpt-4o', reasoning_effort: 'high', tool_choice: { type: 'function' } };
const resOpenai = normaliseForProvider({ ...bOpenai }, 'openai');
check('OpenAI reasoning_effort preserved', resOpenai.reasoning_effort === 'high');
check('OpenAI tool_choice not changed to auto', typeof resOpenai.tool_choice === 'object');

// 2. MiniMax
const bMm = { model: 'MiniMax-M3', reasoning_effort: 'high' };
const resMm = normaliseForProvider({ ...bMm }, 'minimax');
check('MiniMax reasoning_effort preserved', resMm.reasoning_effort === 'high');
check('MiniMax no thinking object injected', resMm.thinking === undefined);

// 3. StepFun
const bSf = { model: 'step-3.7-flash', reasoning_effort: 'medium' };
const resSf = normaliseForProvider({ ...bSf }, 'stepfun');
check('StepFun reasoning_effort preserved', resSf.reasoning_effort === 'medium');
check('StepFun no reasoning_format injected', resSf.reasoning_format === undefined);

// 4. AMD
const bAmd = { model: 'Qwen3.8-Flash-Next', reasoning_effort: 'high' };
const resAmd = normaliseForProvider({ ...bAmd }, 'amd');
check('AMD reasoning_effort preserved (no downgrade)', resAmd.reasoning_effort === 'high');

const bAmdReasoning = { model: 'DeepSeek-V4.1-Flash', reasoning: { enabled: true, effort: 'medium' } };
const resAmdReasoning = normaliseForProvider({ ...bAmdReasoning }, 'amd');
check('AMD reasoning.enabled stripped', resAmdReasoning.reasoning?.enabled === undefined && resAmdReasoning.reasoning?.effort === 'medium');

const amdPreset = getPreset('amd');
check('AMD preset rpm_per_key is undefined (user configurable)', amdPreset.rpm_per_key === undefined);
check('AMD preset has 4 recommended models', amdPreset.recommended_models?.length === 4);

const mockAmdResp = {
  choices: [{ message: { role: 'assistant', content: 'Hi', reasoning: 'Thinking deep' } }],
  usage: { completion_tokens_details: { reasoning_tokens: 35 } }
};
const normAmdResp = normalizeResponseReasoning(mockAmdResp, amdPreset.adapter_rules);
check('AMD response reasoning mapped to reasoning_content', normAmdResp.choices[0].message.reasoning_content === 'Thinking deep');
check('AMD response usage details mapped to reasoning_tokens', normAmdResp.usage.reasoning_tokens === 35);

// 5. Gemini
const bGem = {
  model: 'gemini-3.5-flash',
  reasoning_effort: 'high',
  tools: [{
    type: 'function',
    function: {
      parameters: {
        $schema: 'http://json-schema.org/draft-07/schema#',
        type: 'object',
        properties: { a: { type: 'string' } },
        additionalProperties: false,
      }
    }
  }]
};
const resGem = normaliseForProvider({ ...bGem }, 'google');
check('Gemini reasoning_effort converted to extra_body.google.thinking_config',
  resGem.extra_body?.google?.thinking_config?.thinking_level === 'high');
check('Gemini $schema stripped', resGem.tools[0].function.parameters.$schema === undefined);
check('Gemini additionalProperties stripped', resGem.tools[0].function.parameters.additionalProperties === undefined);

console.log(`\nEdgeOne Summary: ${passed} PASSED, ${failed} FAILED`);
if (failed > 0) process.exit(1);

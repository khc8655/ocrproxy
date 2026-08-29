/**
 * presets/index.js — Registry of pre-configured Provider Presets.
 */

import googlePreset from './google.json' with { type: 'json' };
import sensenovaPreset from './sensenova.json' with { type: 'json' };
import stepfunPreset from './stepfun.json' with { type: 'json' };
import siliconflowPreset from './siliconflow.json' with { type: 'json' };
import tokenrhythmPreset from './tokenrhythm.json' with { type: 'json' };
import deepseekPreset from './deepseek.json' with { type: 'json' };
import openaiPreset from './openai.json' with { type: 'json' };

export const PRESETS = [
  googlePreset,
  sensenovaPreset,
  stepfunPreset,
  siliconflowPreset,
  tokenrhythmPreset,
  deepseekPreset,
  openaiPreset,
];

export const PRESET_MAP = Object.fromEntries(PRESETS.map((p) => [p.id, p]));

export function getPreset(id) {
  return PRESET_MAP[String(id).toLowerCase()] || null;
}

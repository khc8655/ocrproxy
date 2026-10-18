/**
 * tests/test_duplicate_model_prevention.mjs
 * Verification test for duplicate candidate and agent model key prevention.
 */
import assert from 'node:assert';
import { readFileSync } from 'node:fs';

console.log('--- Testing Duplicate Model & Key Prevention Logic ---');

// 1. Test saveCandidate logic extracted from shared/admin/js/models.js
function simulateSaveCandidate({ state, type, provider, model, selected, editCat, editIdx, toasts }) {
  const isMatch = (item, p, k, m) =>
    item &&
    (item.provider || '').toLowerCase() === (p || '').toLowerCase() &&
    item.key === k &&
    (item.model || '') === m;

  if (!state.config.candidates) state.config.candidates = {};
  if (!state.config.candidates[type]) state.config.candidates[type] = [];

  if (editCat && editIdx !== '') {
    const idx = parseInt(editIdx, 10);
    const targetCat = type;
    if (!state.config.candidates[targetCat]) state.config.candidates[targetCat] = [];

    const duplicate = state.config.candidates[targetCat].some((c, i) => {
      if (targetCat === editCat && i === idx) return false;
      return isMatch(c, provider, selected[0], model);
    });

    if (duplicate && selected.length === 1) {
      toasts.push({ type: 'err', msg: `候选节点 [${provider}/${selected[0]}/${model}] 已在 [${targetCat}] 中存在，请勿重复添加` });
      return false;
    }

    if (targetCat === editCat) {
      state.config.candidates[editCat][idx] = { provider, key: selected[0], model };
    } else {
      state.config.candidates[editCat].splice(idx, 1);
      if (!duplicate) {
        state.config.candidates[targetCat].push({ provider, key: selected[0], model });
      }
    }

    for (let i = 1; i < selected.length; i++) {
      const k = selected[i];
      const exists = state.config.candidates[targetCat].some(c => isMatch(c, provider, k, model));
      if (!exists) {
        state.config.candidates[targetCat].push({ provider, key: k, model });
      }
    }
  } else {
    const existingList = state.config.candidates[type] || [];
    const newKeys = selected.filter(k => !existingList.some(c => isMatch(c, provider, k, model)));

    if (newKeys.length === 0) {
      toasts.push({ type: 'err', msg: `候选节点 [${provider}/${model}] 已绑定所选 Key，请勿重复添加` });
      return false;
    }

    newKeys.forEach(k => state.config.candidates[type].push({ provider, key: k, model }));
    if (newKeys.length < selected.length) {
      toasts.push({ type: 'info', msg: `已挂载 ${newKeys.length} 个新节点，自动跳过 ${selected.length - newKeys.length} 个已存在节点` });
    }
  }
  return true;
}

// Test Suite 1: Candidate Duplicate Intercept
{
  const state = {
    config: {
      candidates: {
        chat: [
          { provider: 'siliconflow', key: 'key1', model: 'deepseek-ai/DeepSeek-V3' }
        ]
      }
    }
  };
  const toasts = [];

  // 1. Try to add exact duplicate
  const ok1 = simulateSaveCandidate({
    state,
    type: 'chat',
    provider: 'siliconflow',
    model: 'deepseek-ai/DeepSeek-V3',
    selected: ['key1'],
    editCat: '',
    editIdx: '',
    toasts
  });

  assert.strictEqual(ok1, false, 'Adding exact duplicate should be intercepted');
  assert.strictEqual(state.config.candidates.chat.length, 1, 'Length must remain 1');
  assert.strictEqual(toasts[0].type, 'err');
  assert.match(toasts[0].msg, /请勿重复添加/);

  // 2. Try to add case-insensitive provider duplicate
  const ok2 = simulateSaveCandidate({
    state,
    type: 'chat',
    provider: 'SiliconFlow', // casing variant
    model: 'deepseek-ai/DeepSeek-V3',
    selected: ['key1'],
    editCat: '',
    editIdx: '',
    toasts
  });
  assert.strictEqual(ok2, false, 'Casing variant provider duplicate must also be intercepted');
  assert.strictEqual(state.config.candidates.chat.length, 1);

  // 3. Try to add multi-key where one is duplicate and one is new
  const ok3 = simulateSaveCandidate({
    state,
    type: 'chat',
    provider: 'siliconflow',
    model: 'deepseek-ai/DeepSeek-V3',
    selected: ['key1', 'key2'],
    editCat: '',
    editIdx: '',
    toasts
  });
  assert.strictEqual(ok3, true, 'Partial duplicate should succeed for new keys');
  assert.strictEqual(state.config.candidates.chat.length, 2, 'Only key2 should be appended');
  assert.strictEqual(state.config.candidates.chat[1].key, 'key2');
  assert.strictEqual(toasts[toasts.length - 1].type, 'info');

  console.log('✔ Candidate duplicate prevention tests passed');
}

// Test Suite 2: Candidate Edit Duplicate Intercept
{
  const state = {
    config: {
      candidates: {
        chat: [
          { provider: 'siliconflow', key: 'key1', model: 'model-a' },
          { provider: 'siliconflow', key: 'key2', model: 'model-b' }
        ]
      }
    }
  };
  const toasts = [];

  // Edit item 1 (key2, model-b) to match item 0 (key1, model-a)
  const ok = simulateSaveCandidate({
    state,
    type: 'chat',
    provider: 'siliconflow',
    model: 'model-a',
    selected: ['key1'],
    editCat: 'chat',
    editIdx: '1',
    toasts
  });
  assert.strictEqual(ok, false, 'Editing to an already existing node should be intercepted');
  assert.strictEqual(toasts[0].type, 'err');
  assert.match(toasts[0].msg, /已在 \[chat\] 中存在/);

  console.log('✔ Candidate edit duplicate prevention tests passed');
}

// Test Suite 3: Agent Model Duplicate Key Intercept
function simulateSaveAgentModel({ cfg, oldName, name, upstream, bindings, toasts }) {
  const existingModelName = (!oldName && cfg.agent_models)
    ? Object.keys(cfg.agent_models).find(k => k.toLowerCase() === name.toLowerCase())
    : null;

  if (!oldName && existingModelName) {
    const existing = cfg.agent_models[existingModelName];
    const existingKeySet = new Set((existing.keys || []).map(k => `${(k.provider || '').toLowerCase()}:${k.key}`));
    const newKeysToAdd = bindings.filter(k => !existingKeySet.has(`${(k.provider || '').toLowerCase()}:${k.key}`));

    if (newKeysToAdd.length === 0) {
      toasts.push({ type: 'err', msg: `模型「${existingModelName}」已存在且所选 Key 已全部绑定，请勿重复添加` });
      return false;
    }

    existing.keys = (existing.keys || []).concat(newKeysToAdd);
    if (upstream && upstream !== existingModelName) {
      existing.upstream_model = upstream;
    }
    return true;
  }

  const existing = (oldName && cfg.agent_models[oldName]) ? cfg.agent_models[oldName] : {};
  if (oldName && oldName !== name) {
    delete cfg.agent_models[oldName];
  }
  const seenBindings = new Set();
  const dedupedBindings = bindings.filter(b => {
    const sig = `${(b.provider || '').toLowerCase()}:${b.key}`;
    if (seenBindings.has(sig)) return false;
    seenBindings.add(sig);
    return true;
  });
  cfg.agent_models[name] = { ...existing, keys: dedupedBindings };
  return true;
}

{
  const cfg = {
    agent_models: {
      'deepseek-chat': {
        keys: [{ provider: 'siliconflow', key: 'default' }],
        upstream_model: 'deepseek-ai/DeepSeek-V3'
      }
    }
  };
  const toasts = [];

  // Try to create new agent model with exact same name and key
  const ok1 = simulateSaveAgentModel({
    cfg,
    oldName: '',
    name: 'deepseek-chat',
    upstream: 'deepseek-ai/DeepSeek-V3',
    bindings: [{ provider: 'siliconflow', key: 'default' }],
    toasts
  });
  assert.strictEqual(ok1, false, 'Adding existing agent model with already bound key should be intercepted');
  assert.strictEqual(toasts[0].type, 'err');
  assert.match(toasts[0].msg, /请勿重复添加/);
  assert.strictEqual(cfg.agent_models['deepseek-chat'].keys.length, 1);

  // Try case-insensitive matching 'DeepSeek-Chat'
  const ok2 = simulateSaveAgentModel({
    cfg,
    oldName: '',
    name: 'DeepSeek-Chat',
    upstream: 'deepseek-ai/DeepSeek-V3',
    bindings: [{ provider: 'siliconflow', key: 'default' }],
    toasts
  });
  assert.strictEqual(ok2, false, 'Case-insensitive model name match should be intercepted');
  assert.strictEqual(Object.keys(cfg.agent_models).length, 1, 'No duplicate model created');

  console.log('✔ Agent model duplicate prevention tests passed');
}

console.log('All duplicate prevention tests PASSED successfully!');

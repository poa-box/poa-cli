import vm from 'node:vm';

// Test/build-time static document checks, never part of the SDK runtime.
export function validateRecipeSchema(value, rule, path = '$') {
  const supported = ['$schema', '$id', 'type', 'properties', 'required', 'additionalProperties', 'items', 'minItems', 'minLength', 'const', 'enum'];
  for (const key of Object.keys(rule)) if (!supported.includes(key)) throw new Error('UNSUPPORTED_SCHEMA_KEY:' + key);
  if ('const' in rule && JSON.stringify(value) !== JSON.stringify(rule.const)) throw new Error(path + ':const');
  if (rule.enum && !rule.enum.some(item => JSON.stringify(item) === JSON.stringify(value))) throw new Error(path + ':enum');
  if (rule.type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(path + ':object');
    for (const key of rule.required || []) if (!(key in value)) throw new Error(path + ':required:' + key);
    for (const key of Object.keys(value)) {
      if (!(key in rule.properties) && rule.additionalProperties === false) throw new Error(path + ':unexpected:' + key);
      if (key in rule.properties) validateRecipeSchema(value[key], rule.properties[key], path + '.' + key);
    }
  } else if (rule.type === 'array') {
    if (!Array.isArray(value) || value.length < (rule.minItems || 0)) throw new Error(path + ':array');
    value.forEach((item, index) => validateRecipeSchema(item, rule.items, path + '[' + index + ']'));
  } else if (rule.type && typeof value !== rule.type) throw new Error(path + ':type');
  if (rule.minLength && value.length < rule.minLength) throw new Error(path + ':minLength');
}

export function validateWorkflowRecipes(catalog, schema, loadApi) {
  validateRecipeSchema(catalog, schema);
  const seen = new Set();
  for (const recipe of catalog.recipes) {
    if (seen.has(recipe.id)) throw new Error('DUPLICATE_RECIPE:' + recipe.id);
    seen.add(recipe.id);
    if (recipe.effects.signs || recipe.effects.broadcasts || recipe.effects.persists) throw new Error('UNSAFE_RECIPE_EFFECT:' + recipe.id);
    for (const reference of recipe.apis) {
      if (!/^@poa-box\/core\/[a-z0-9/-]+$/.test(reference.module)) throw new Error('NONPUBLIC_RECIPE_IMPORT');
      const api = loadApi(reference.module);
      for (const name of reference.exports) if (typeof api[name] !== 'function') throw new Error('MISSING_RECIPE_EXPORT:' + reference.module + ':' + name);
    }
    const steps = new Set();
    for (const step of recipe.steps) {
      if (steps.has(step.id)) throw new Error('DUPLICATE_RECIPE_STEP:' + step.id);
      steps.add(step.id);
      for (const call of step.calls) {
        const reference = recipe.apis.find(api => api.module === call.module && api.exports.includes(call.export));
        if (!reference) throw new Error('UNDECLARED_RECIPE_STEP:' + call.module + ':' + call.export);
      }
    }
  }
}

export function executableSnippet(markdown, marker, ts, loadApi) {
  const escaped = marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = markdown.match(new RegExp('<!-- sdk-test:' + escaped + ' -->\\s*```js\\n([\\s\\S]*?)```'));
  if (!match) throw new Error('MISSING_EXECUTABLE_RECIPE:' + marker);
  const js = ts.transpileModule(match[1], { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  const sandbox = { exports: {}, require: loadApi };
  vm.runInNewContext(js, sandbox);
  return sandbox.exports;
}

/** Execute the documented unsigned task/poll/ballot helpers against the caller's
 * independently installed distributed SDK. No provider, wallet or publisher. */
export function verifyUnsignedRecipes(api, loadApi) {
  const { ethers } = loadApi('ethers');
  const address = '0x' + '12'.repeat(20), hash = '0x' + '34'.repeat(32);
  const raw = '9007199254740993';
  const task = api.prepareTask({ taskManagerAddress: address, projectId: hash, title: 'Reviewed task',
    payoutRaw: raw, metadataHash: ethers.constants.HashZero, features: { deadlines: true } });
  const taskDecoded = new ethers.utils.Interface(task.abi).decodeFunctionData(task.method,
    new ethers.utils.Interface(task.abi).encodeFunctionData(task.method, task.args));
  if (taskDecoded[0].toString() !== raw || taskDecoded[3] !== hash) throw new Error('TASK_RECIPE_UNITS_CHANGED');
  const poll = api.preparePoll({ votingAddress: address, title: 'Choose together', descriptionHash: hash,
    durationMinutes: '60', numOptions: 2 });
  if (poll.args[2] !== '60' || poll.args[4].length !== 0) throw new Error('POLL_RECIPE_LANE_CHANGED');
  const proposalId = (1n << 200n).toString();
  const vote = api.prepareVote({ votingAddress: address, votingAbiName: 'DirectDemocracyVotingNew', proposalId,
    optionIndices: [0, 1], weights: [60, 40] });
  if (vote.args[0] !== proposalId || String(vote.args[2]) !== '60,40') throw new Error('VOTE_RECIPE_UNITS_CHANGED');
  let refused = false;
  try { api.prepareVote({ votingAddress: address, votingAbiName: 'DirectDemocracyVotingNew', proposalId,
    optionIndices: [0, 1], weights: [60, 60] }); } catch { refused = true; }
  if (!refused) throw new Error('VOTE_RECIPE_INVALID_VECTOR_ACCEPTED');
}

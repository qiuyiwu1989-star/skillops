const DEFAULT_RUNNER = 'fixture:v1';
const DEFAULT_ENVIRONMENT = Object.freeze({ kind: 'offline-fixture' });

function cloneJson(value, label) {
  let serialized;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new TypeError(`${label} must be JSON serializable`);
  }
  if (serialized === undefined) throw new TypeError(`${label} must be JSON serializable`);
  return JSON.parse(serialized);
}

function nonNegativeInteger(value, label, fallback = 0) {
  const resolved = value === undefined ? fallback : value;
  if (!Number.isSafeInteger(resolved) || resolved < 0) throw new TypeError(`${label} must be a non-negative integer`);
  return resolved;
}

function normalizeEntry(value, caseId) {
  if (value && typeof value === 'object' && !Array.isArray(value)
    && (Object.hasOwn(value, 'output') || Object.hasOwn(value, 'delayMs') || Object.hasOwn(value, 'error'))) {
    const unknown = Object.keys(value).filter(key => !['output', 'delayMs', 'error'].includes(key));
    if (unknown.length) throw new TypeError(`fixture ${caseId} contains unknown fields: ${unknown.join(', ')}`);
    if (!Object.hasOwn(value, 'output') && !Object.hasOwn(value, 'error')) {
      throw new TypeError(`fixture ${caseId} requires output or error`);
    }
    if (value.error !== undefined && (typeof value.error !== 'string' || !value.error.trim())) {
      throw new TypeError(`fixture ${caseId} error must be a non-empty string`);
    }
    return Object.freeze({
      ...(Object.hasOwn(value, 'output') ? { output: cloneJson(value.output, `fixture ${caseId} output`) } : {}),
      delayMs: nonNegativeInteger(value.delayMs, `fixture ${caseId} delayMs`),
      ...(value.error !== undefined ? { error: value.error.trim() } : {}),
    });
  }
  return Object.freeze({ output: cloneJson(value, `fixture ${caseId} output`), delayMs: 0 });
}

export function createFixtureEvalAdapter(resultMap, {
  runner = DEFAULT_RUNNER,
  environment = DEFAULT_ENVIRONMENT,
} = {}) {
  if (!resultMap || typeof resultMap !== 'object' || Array.isArray(resultMap)) {
    throw new TypeError('fixture result map must be an object keyed by case id');
  }
  if (typeof runner !== 'string' || !runner.trim()) throw new TypeError('fixture runner identity is required');
  const normalizedEnvironment = cloneJson(environment, 'fixture environment');
  if (!normalizedEnvironment || typeof normalizedEnvironment !== 'object' || Array.isArray(normalizedEnvironment)) {
    throw new TypeError('fixture environment must be an object');
  }
  const entries = new Map(Object.entries(resultMap).map(([caseId, value]) => {
    if (!caseId) throw new TypeError('fixture case id must be non-empty');
    return [caseId, normalizeEntry(value, caseId)];
  }));

  const executor = async ({ case: evalCase }) => {
    const entry = entries.get(evalCase?.id);
    if (!entry) throw new Error(`fixture result missing for case: ${evalCase?.id || '(unknown)'}`);
    if (entry.delayMs > 0) await new Promise(resolve => setTimeout(resolve, entry.delayMs));
    if (entry.error) throw new Error(entry.error);
    return cloneJson(entry.output, `fixture ${evalCase.id} output`);
  };
  Object.defineProperties(executor, {
    runner: { value: runner.trim(), enumerable: true },
    environment: { value: Object.freeze(normalizedEnvironment), enumerable: true },
    kind: { value: 'fixture', enumerable: true },
  });
  return Object.freeze(executor);
}

export const FIXTURE_EVAL_RUNNER = DEFAULT_RUNNER;

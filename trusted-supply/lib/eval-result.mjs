import { normalizeEvalSuite } from './eval-suite.mjs';

export const EVAL_RESULT_SCHEMA_VERSION = 1;

export const DEFAULT_EVAL_RESULT_LIMITS = Object.freeze({
  maxCases: 1_000,
  maxAssertionsPerCase: 500,
  maxOutputSummaryChars: 4_000,
  maxErrorChars: 2_000,
  maxEnvironmentBytes: 32 * 1024,
  maxResultBytes: 8 * 1024 * 1024,
});

const CASE_STATUSES = new Set(['passed', 'failed', 'error', 'timeout']);
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const RUNNER = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,255}$/;

export class EvalResultValidationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'EvalResultValidationError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new EvalResultValidationError(code, message);
}

function resolvedLimits(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('invalid_limits', 'limits must be an object');
  const result = { ...DEFAULT_EVAL_RESULT_LIMITS };
  for (const key of Object.keys(result)) {
    if (input[key] !== undefined) {
      if (!Number.isSafeInteger(input[key]) || input[key] < 1) fail('invalid_limit', `${key} must be a positive integer`);
      result[key] = input[key];
    }
  }
  return result;
}

function exactKeys(value, allowed, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('invalid_structure', `${label} must be an object`);
  const unknown = Object.keys(value).filter(key => !allowed.has(key));
  if (unknown.length) fail('unknown_field', `${label} contains unknown fields: ${unknown.join(', ')}`);
}

function requiredText(value, label, maximum) {
  if (typeof value !== 'string' || !value.trim()) fail('invalid_text', `${label} must be a non-empty string`);
  const normalized = value.normalize('NFC').trim();
  if (normalized.includes('\0')) fail('invalid_text', `${label} must not contain NUL`);
  if ([...normalized].length > maximum) fail('text_limit_exceeded', `${label} exceeds ${maximum} characters`);
  return normalized;
}

function optionalText(value, label, maximum) {
  if (value === undefined || value === null) return null;
  return requiredText(value, label, maximum);
}

function timestamp(value, label) {
  const text = requiredText(value, label, 128);
  const milliseconds = Date.parse(text);
  if (!Number.isFinite(milliseconds)) fail('invalid_timestamp', `${label} must be a valid timestamp`);
  return new Date(milliseconds).toISOString();
}

function jsonClone(value, label, maximum) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('invalid_environment', `${label} must be a JSON object`);
  let serialized;
  try { serialized = JSON.stringify(value); } catch { fail('invalid_environment', `${label} must be JSON serializable`); }
  if (Buffer.byteLength(serialized, 'utf8') > maximum) fail('environment_limit_exceeded', `${label} exceeds ${maximum} bytes`);
  return structuredClone(value);
}

function normalizeAssertionResult(value, label) {
  exactKeys(value, new Set(['type', 'value', 'path', 'passed', 'actual', 'message']), label);
  if (typeof value.type !== 'string' || !['contains', 'not_contains', 'json_path_equals', 'max_chars'].includes(value.type)) {
    fail('invalid_assertion_result', `${label}.type is unsupported`);
  }
  if (typeof value.passed !== 'boolean') fail('invalid_assertion_result', `${label}.passed must be boolean`);
  const result = { type: value.type };
  if (Object.hasOwn(value, 'path')) result.path = requiredText(value.path, `${label}.path`, 1_024);
  if (Object.hasOwn(value, 'value')) result.value = structuredClone(value.value);
  result.passed = value.passed;
  if (Object.hasOwn(value, 'actual')) result.actual = structuredClone(value.actual);
  if (value.message !== undefined) result.message = requiredText(value.message, `${label}.message`, 1_000);
  return result;
}

function normalizeCase(value, label, limits) {
  exactKeys(value, new Set(['id', 'status', 'durationMs', 'assertions', 'outputSummary', 'error']), label);
  const id = requiredText(value.id, `${label}.id`, 512);
  if (!CASE_STATUSES.has(value.status)) fail('invalid_case_status', `${label}.status is unsupported`);
  if (!Number.isSafeInteger(value.durationMs) || value.durationMs < 0) fail('invalid_duration', `${label}.durationMs must be a non-negative integer`);
  if (!Array.isArray(value.assertions) || value.assertions.length > limits.maxAssertionsPerCase) fail('invalid_assertion_results', `${label}.assertions must be an array within limits`);
  const assertions = value.assertions.map((assertion, index) => normalizeAssertionResult(assertion, `${label}.assertions[${index}]`));
  const assertionsPassed = assertions.length > 0 && assertions.every(assertion => assertion.passed);
  if ((value.status === 'passed') !== assertionsPassed) {
    fail('case_status_mismatch', `${label}.status does not match assertion results`);
  }
  if ((value.status === 'error' || value.status === 'timeout') && !value.error) {
    fail('missing_case_error', `${label}.error is required for ${value.status}`);
  }
  return {
    id,
    status: value.status,
    durationMs: value.durationMs,
    assertions,
    outputSummary: optionalText(value.outputSummary, `${label}.outputSummary`, limits.maxOutputSummaryChars),
    error: optionalText(value.error, `${label}.error`, limits.maxErrorChars),
  };
}

function digest(value, label) {
  if (typeof value !== 'string' || !DIGEST.test(value)) fail('invalid_digest', `${label} must be sha256:<64 hexadecimal characters>`);
  return value;
}

function canonicalResult(input, suite, limits) {
  exactKeys(input, new Set([
    'schemaVersion', 'status', 'suiteId', 'suiteVersion', 'suiteDigest', 'basedOnPackageDigest',
    'runner', 'environment', 'cases', 'passed', 'failed', 'successRate', 'startedAt', 'completedAt',
  ]), 'result');
  if (input.schemaVersion !== undefined && input.schemaVersion !== EVAL_RESULT_SCHEMA_VERSION) fail('unsupported_schema', `schemaVersion must be ${EVAL_RESULT_SCHEMA_VERSION}`);
  if (input.status !== undefined && input.status !== 'complete') fail('invalid_status', 'result status must be complete');
  if (!Array.isArray(input.cases) || input.cases.length < 1 || input.cases.length > limits.maxCases) fail('invalid_cases', 'result cases must be a non-empty array within limits');
  const cases = input.cases.map((value, index) => normalizeCase(value, `cases[${index}]`, limits));
  const ids = new Set();
  for (const item of cases) {
    if (ids.has(item.id)) fail('duplicate_case_id', `duplicate result case id: ${item.id}`);
    ids.add(item.id);
  }
  if (suite) {
    if (cases.length !== suite.cases.length || suite.cases.some((item, index) => cases[index]?.id !== item.id)) {
      fail('suite_case_mismatch', 'result cases must exactly match the suite case order');
    }
  }
  const passed = cases.filter(item => item.status === 'passed').length;
  const failed = cases.length - passed;
  const successRate = Number((passed / cases.length).toFixed(4));
  for (const [field, calculated] of [['passed', passed], ['failed', failed], ['successRate', successRate]]) {
    if (input[field] !== undefined && input[field] !== calculated) fail('result_summary_mismatch', `${field} does not match case results`);
  }
  const startedAt = timestamp(input.startedAt, 'startedAt');
  const completedAt = timestamp(input.completedAt, 'completedAt');
  if (Date.parse(completedAt) < Date.parse(startedAt)) fail('invalid_time_range', 'completedAt must not precede startedAt');
  const suiteId = requiredText(input.suiteId ?? suite?.suiteId, 'suiteId', 256);
  const suiteVersion = requiredText(input.suiteVersion ?? suite?.suiteVersion, 'suiteVersion', 128);
  const suiteDigest = digest(input.suiteDigest ?? suite?.suiteDigest, 'suiteDigest');
  if (suite && (suiteId !== suite.suiteId || suiteVersion !== suite.suiteVersion || suiteDigest !== suite.suiteDigest)) {
    fail('suite_identity_mismatch', 'result suite identity does not match the validated suite');
  }
  const runner = requiredText(input.runner, 'runner', 256);
  if (!RUNNER.test(runner)) fail('invalid_runner', 'runner identity contains unsupported characters');
  const result = {
    schemaVersion: EVAL_RESULT_SCHEMA_VERSION,
    status: 'complete',
    suiteId,
    suiteVersion,
    suiteDigest,
    basedOnPackageDigest: digest(input.basedOnPackageDigest, 'basedOnPackageDigest'),
    runner,
    environment: jsonClone(input.environment, 'environment', limits.maxEnvironmentBytes),
    cases,
    passed,
    failed,
    successRate,
    startedAt,
    completedAt,
  };
  if (Buffer.byteLength(JSON.stringify(result), 'utf8') > limits.maxResultBytes) fail('result_size_limit_exceeded', `result exceeds ${limits.maxResultBytes} bytes`);
  return result;
}

export function createEvalResult(input, { suite, packageDigest, limits: limitInput } = {}) {
  const resolved = resolvedLimits(limitInput);
  const canonicalSuite = suite ? normalizeEvalSuite(suite) : null;
  const candidate = packageDigest === undefined ? input : { ...input, basedOnPackageDigest: packageDigest };
  if (packageDigest !== undefined && input.basedOnPackageDigest !== undefined && input.basedOnPackageDigest !== packageDigest) {
    fail('package_identity_mismatch', 'basedOnPackageDigest does not match packageDigest');
  }
  return canonicalResult(candidate, canonicalSuite, resolved);
}

export function validateEvalResult(input, { suite, packageDigest, runner, limits: limitInput } = {}) {
  const result = createEvalResult(input, { suite, packageDigest, limits: limitInput });
  if (runner !== undefined && result.runner !== runner) fail('runner_identity_mismatch', 'result runner does not match expected runner');
  return result;
}

export function isEvalResultCurrent(result, { packageDigest, suiteDigest, runner } = {}) {
  try {
    const validated = validateEvalResult(result);
    return (packageDigest === undefined || validated.basedOnPackageDigest === packageDigest)
      && (suiteDigest === undefined || validated.suiteDigest === suiteDigest)
      && (runner === undefined || validated.runner === runner);
  } catch {
    return false;
  }
}

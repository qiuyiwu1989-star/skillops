import crypto from 'node:crypto';

export const EVAL_SUITE_SCHEMA_VERSION = 1;

export const DEFAULT_EVAL_SUITE_LIMITS = Object.freeze({
  maxCases: 100,
  maxPromptChars: 16_000,
  maxAssertionsPerCase: 50,
  maxExpectedChars: 16_000,
  maxSuiteBytes: 2 * 1024 * 1024,
  maxCaseIdChars: 128,
  maxSuiteIdChars: 256,
});

const HARD_LIMITS = Object.freeze({
  maxCases: 1_000,
  maxPromptChars: 100_000,
  maxAssertionsPerCase: 500,
  maxExpectedChars: 100_000,
  maxSuiteBytes: 16 * 1024 * 1024,
  maxCaseIdChars: 512,
  maxSuiteIdChars: 1_024,
});

const ASSERTION_TYPES = new Set(['contains', 'not_contains', 'json_path_equals', 'max_chars']);
const FORBIDDEN_PATH_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const PACKAGE_DIGEST = /^sha256:[a-f0-9]{64}$/;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/;

export class EvalSuiteValidationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'EvalSuiteValidationError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new EvalSuiteValidationError(code, message);
}

function limits(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('invalid_limits', 'limits must be an object');
  return Object.fromEntries(Object.entries(DEFAULT_EVAL_SUITE_LIMITS).map(([key, fallback]) => {
    const value = input[key] ?? fallback;
    if (!Number.isSafeInteger(value) || value < 1 || value > HARD_LIMITS[key]) fail('invalid_limit', `${key} must be between 1 and ${HARD_LIMITS[key]}`);
    return [key, value];
  }));
}

function exactKeys(value, allowed, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('invalid_structure', `${label} must be an object`);
  const unknown = Object.keys(value).filter(key => !allowed.has(key));
  if (unknown.length) fail('unknown_field', `${label} contains unknown fields: ${unknown.join(', ')}`);
}

function text(value, label, maximum) {
  if (typeof value !== 'string' || !value.trim()) fail('invalid_text', `${label} must be a non-empty string`);
  const normalized = value.normalize('NFC').trim();
  if (normalized.includes('\0')) fail('invalid_text', `${label} must not contain NUL`);
  if ([...normalized].length > maximum) fail('text_limit_exceeded', `${label} exceeds ${maximum} characters`);
  return normalized;
}

function identifier(value, label, maximum) {
  const normalized = text(value, label, maximum);
  if (!IDENTIFIER.test(normalized)) fail('invalid_identifier', `${label} contains unsupported characters`);
  return normalized;
}

function jsonSize(value, label, maximum) {
  let serialized;
  try {
    serialized = JSON.stringify(value);
  } catch {
    fail('invalid_json_value', `${label} must be JSON serializable`);
  }
  if (serialized === undefined) fail('invalid_json_value', `${label} must be JSON serializable`);
  if (Buffer.byteLength(serialized, 'utf8') > maximum) fail('expected_value_limit_exceeded', `${label} exceeds ${maximum} bytes`);
  return structuredClone(value);
}

function parseJsonPath(path) {
  if (typeof path !== 'string' || !path.startsWith('$')) fail('invalid_json_path', 'JSON path must start with $');
  const tokens = [];
  let index = 1;
  while (index < path.length) {
    if (path[index] === '.') {
      const match = path.slice(index).match(/^\.([A-Za-z_][A-Za-z0-9_-]*)/);
      if (!match) fail('invalid_json_path', `unsupported JSON path: ${path}`);
      if (FORBIDDEN_PATH_KEYS.has(match[1])) fail('invalid_json_path', `unsupported JSON path: ${path}`);
      tokens.push(match[1]);
      index += match[0].length;
      continue;
    }
    if (path[index] === '[') {
      const match = path.slice(index).match(/^\[(0|[1-9][0-9]*)\]/);
      if (!match) fail('invalid_json_path', `unsupported JSON path: ${path}`);
      tokens.push(Number(match[1]));
      index += match[0].length;
      continue;
    }
    fail('invalid_json_path', `unsupported JSON path: ${path}`);
  }
  return tokens;
}

function normalizeAssertion(value, label, resolved) {
  exactKeys(value, new Set(['type', 'value', 'path']), label);
  if (typeof value.type !== 'string' || !ASSERTION_TYPES.has(value.type)) fail('unknown_assertion', `${label} has an unsupported assertion type`);
  if (value.type === 'contains' || value.type === 'not_contains') {
    if (Object.hasOwn(value, 'path')) fail('invalid_assertion', `${label} must not define path`);
    return { type: value.type, value: text(value.value, `${label}.value`, resolved.maxExpectedChars) };
  }
  if (value.type === 'max_chars') {
    if (Object.hasOwn(value, 'path')) fail('invalid_assertion', `${label} must not define path`);
    if (!Number.isSafeInteger(value.value) || value.value < 0 || value.value > resolved.maxExpectedChars) {
      fail('invalid_assertion', `${label}.value must be a non-negative integer no greater than ${resolved.maxExpectedChars}`);
    }
    return { type: value.type, value: value.value };
  }
  const normalizedPath = text(value.path, `${label}.path`, 1_024);
  parseJsonPath(normalizedPath);
  return { type: value.type, path: normalizedPath, value: jsonSize(value.value, `${label}.value`, resolved.maxExpectedChars) };
}

function canonicalSuite(input, resolved) {
  exactKeys(input, new Set(['schemaVersion', 'suiteId', 'suiteVersion', 'cases', 'suiteDigest']), 'suite');
  if (input.schemaVersion !== EVAL_SUITE_SCHEMA_VERSION) fail('unsupported_schema', `schemaVersion must be ${EVAL_SUITE_SCHEMA_VERSION}`);
  if (!Array.isArray(input.cases) || input.cases.length < 1) fail('invalid_cases', 'suite cases must be a non-empty array');
  if (input.cases.length > resolved.maxCases) fail('case_limit_exceeded', `suite contains more than ${resolved.maxCases} cases`);
  const seen = new Set();
  const cases = input.cases.map((caseValue, caseIndex) => {
    const label = `cases[${caseIndex}]`;
    exactKeys(caseValue, new Set(['id', 'prompt', 'assertions']), label);
    const id = identifier(caseValue.id, `${label}.id`, resolved.maxCaseIdChars);
    if (seen.has(id)) fail('duplicate_case_id', `duplicate case id: ${id}`);
    seen.add(id);
    if (!Array.isArray(caseValue.assertions) || caseValue.assertions.length < 1) fail('invalid_assertions', `${label}.assertions must be a non-empty array`);
    if (caseValue.assertions.length > resolved.maxAssertionsPerCase) fail('assertion_limit_exceeded', `${label} contains too many assertions`);
    return {
      id,
      prompt: text(caseValue.prompt, `${label}.prompt`, resolved.maxPromptChars),
      assertions: caseValue.assertions.map((assertion, assertionIndex) => normalizeAssertion(assertion, `${label}.assertions[${assertionIndex}]`, resolved)),
    };
  });
  return {
    schemaVersion: EVAL_SUITE_SCHEMA_VERSION,
    suiteId: identifier(input.suiteId, 'suiteId', resolved.maxSuiteIdChars),
    suiteVersion: identifier(input.suiteVersion, 'suiteVersion', 128),
    cases,
  };
}

function digest(value) {
  return `sha256:${crypto.createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex')}`;
}

export function normalizeEvalSuite(input, { limits: limitInput } = {}) {
  const resolved = limits(limitInput);
  const canonical = canonicalSuite(input, resolved);
  if (Buffer.byteLength(JSON.stringify(canonical), 'utf8') > resolved.maxSuiteBytes) fail('suite_size_limit_exceeded', `suite exceeds ${resolved.maxSuiteBytes} bytes`);
  const suiteDigest = digest(canonical);
  if (input.suiteDigest !== undefined && (!PACKAGE_DIGEST.test(input.suiteDigest) || input.suiteDigest !== suiteDigest)) {
    fail('suite_digest_mismatch', 'suiteDigest does not match the canonical suite');
  }
  return { ...canonical, suiteDigest };
}

export function validateEvalSuite(input, options = {}) {
  return normalizeEvalSuite(input, options);
}

function outputText(output) {
  if (typeof output === 'string') return output;
  try { return JSON.stringify(output); } catch { return String(output); }
}

function jsonOutput(output) {
  if (typeof output !== 'string') return output;
  try { return JSON.parse(output); } catch { return undefined; }
}

function atPath(value, tokens) {
  let current = value;
  for (const token of tokens) {
    if (current === null || current === undefined || (typeof current !== 'object' && !Array.isArray(current)) || !Object.hasOwn(current, token)) {
      return { found: false, value: undefined };
    }
    current = current[token];
  }
  return { found: true, value: current };
}

function equalJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function evaluateAssertion(assertion, output) {
  const normalized = normalizeAssertion(assertion, 'assertion', limits());
  const rendered = outputText(output);
  if (normalized.type === 'contains') {
    const passed = rendered.includes(normalized.value);
    return { ...normalized, passed, message: passed ? '包含预期文本' : '未包含预期文本' };
  }
  if (normalized.type === 'not_contains') {
    const passed = !rendered.includes(normalized.value);
    return { ...normalized, passed, message: passed ? '未包含禁止文本' : '包含了禁止文本' };
  }
  if (normalized.type === 'max_chars') {
    const actual = [...rendered].length;
    const passed = actual <= normalized.value;
    return { ...normalized, passed, actual, message: passed ? '输出长度符合限制' : '输出长度超过限制' };
  }
  const source = jsonOutput(output);
  const selected = source === undefined ? { found: false } : atPath(source, parseJsonPath(normalized.path));
  const passed = selected.found && equalJson(selected.value, normalized.value);
  return {
    ...normalized,
    passed,
    actual: selected.found ? structuredClone(selected.value) : null,
    message: passed ? 'JSON 路径值符合预期' : selected.found ? 'JSON 路径值不符合预期' : 'JSON 路径不存在或输出不是有效 JSON',
  };
}

export function evaluateAssertions(assertions, output) {
  if (!Array.isArray(assertions) || assertions.length < 1) fail('invalid_assertions', 'assertions must be a non-empty array');
  const results = assertions.map(assertion => evaluateAssertion(assertion, output));
  return { passed: results.every(result => result.passed), assertions: results };
}

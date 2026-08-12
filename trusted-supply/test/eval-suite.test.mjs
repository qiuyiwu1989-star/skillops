import assert from 'node:assert/strict';
import test from 'node:test';

import {
  evaluateAssertion,
  evaluateAssertions,
  normalizeEvalSuite,
  validateEvalSuite,
} from '../lib/eval-suite.mjs';

function suite(overrides = {}) {
  return {
    schemaVersion: 1,
    suiteId: 'fixture/basic-zh',
    suiteVersion: '1.0.0',
    cases: [
      { id: 'rewrite-natural', prompt: '请把这段话改写得更自然。', assertions: [{ type: 'contains', value: '自然' }, { type: 'max_chars', value: 200 }] },
      { id: 'structured-json', prompt: '请返回结构化 JSON。', assertions: [{ type: 'json_path_equals', path: '$.status', value: 'ok' }] },
    ],
    ...overrides,
  };
}

test('suite normalization produces a stable content-bound digest', () => {
  const first = normalizeEvalSuite(suite());
  const second = validateEvalSuite(structuredClone(suite()));
  assert.match(first.suiteDigest, /^sha256:[a-f0-9]{64}$/);
  assert.deepEqual(first, second);
  assert.notEqual(normalizeEvalSuite(suite({ suiteVersion: '1.0.1' })).suiteDigest, first.suiteDigest);
  const reversed = suite();
  reversed.cases.reverse();
  assert.notEqual(normalizeEvalSuite(reversed).suiteDigest, first.suiteDigest);
  assert.throws(() => validateEvalSuite({ ...first, suiteDigest: 'sha256:' + '0'.repeat(64) }), /digest/i);
});

test('suite fails closed on unknown fields, assertion types and duplicate cases', () => {
  assert.throws(() => normalizeEvalSuite({ ...suite(), executable: 'alert(1)' }), /unknown field/i);
  const unknown = suite();
  unknown.cases[0].assertions = [{ type: 'javascript', value: 'true' }];
  assert.throws(() => normalizeEvalSuite(unknown), /unsupported assertion/i);
  const duplicate = suite();
  duplicate.cases[1].id = duplicate.cases[0].id;
  assert.throws(() => normalizeEvalSuite(duplicate), /duplicate/i);
  const empty = suite();
  empty.cases[0].assertions = [];
  assert.throws(() => normalizeEvalSuite(empty), /non-empty/i);
});

test('suite hard limits cover cases, prompt, assertions, values and JSON bytes', () => {
  assert.throws(() => normalizeEvalSuite(suite(), { limits: { maxCases: 1 } }), /cases/i);
  assert.throws(() => normalizeEvalSuite(suite(), { limits: { maxPromptChars: 3 } }), /prompt/i);
  assert.throws(() => normalizeEvalSuite(suite(), { limits: { maxAssertionsPerCase: 1 } }), /assertion/i);
  assert.throws(() => normalizeEvalSuite(suite(), { limits: { maxExpectedChars: 2 } }), /value|max_chars/i);
  assert.throws(() => normalizeEvalSuite(suite(), { limits: { maxSuiteBytes: 10 } }), /suite/i);
});

test('contains, not_contains and max_chars use deterministic text semantics', () => {
  assert.equal(evaluateAssertion({ type: 'contains', value: '中文' }, '包含中文文本').passed, true);
  assert.equal(evaluateAssertion({ type: 'contains', value: '中文' }, 'English').passed, false);
  assert.equal(evaluateAssertion({ type: 'not_contains', value: 'AI' }, '自然文本').passed, true);
  assert.equal(evaluateAssertion({ type: 'not_contains', value: 'AI' }, 'AI 文本').passed, false);
  assert.deepEqual(evaluateAssertion({ type: 'max_chars', value: 2 }, '😀a'), {
    type: 'max_chars', value: 2, passed: true, actual: 2, message: '输出长度符合限制',
  });
  const group = evaluateAssertions([{ type: 'contains', value: 'ok' }, { type: 'max_chars', value: 4 }], 'ok');
  assert.equal(group.passed, true);
  assert.equal(group.assertions.length, 2);
});

test('json_path_equals supports restricted dot/index paths without evaluating expressions', () => {
  const assertion = { type: 'json_path_equals', path: '$.items[0].status', value: 'ok' };
  assert.equal(evaluateAssertion(assertion, '{"items":[{"status":"ok"}]}').passed, true);
  assert.equal(evaluateAssertion(assertion, { items: [{ status: 'no' }] }).passed, false);
  assert.equal(evaluateAssertion(assertion, 'not json').passed, false);
  for (const path of ['$.*', '$["secret"]', '$.items[?(@.x)]', '$.__proto__.x', '$.x()']) {
    assert.throws(() => evaluateAssertion({ type: 'json_path_equals', path, value: true }, {}), /JSON path/i, path);
  }
});

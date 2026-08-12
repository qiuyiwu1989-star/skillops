import assert from 'node:assert/strict';
import test from 'node:test';

import { createEvalResult, isEvalResultCurrent, validateEvalResult } from '../lib/eval-result.mjs';
import { normalizeEvalSuite } from '../lib/eval-suite.mjs';

const PACKAGE = `sha256:${'a'.repeat(64)}`;
const OTHER_PACKAGE = `sha256:${'b'.repeat(64)}`;

const SUITE = normalizeEvalSuite({
  schemaVersion: 1,
  suiteId: 'fixture/basic',
  suiteVersion: '1.0.0',
  cases: [
    { id: 'pass', prompt: '返回 ok。', assertions: [{ type: 'contains', value: 'ok' }] },
    { id: 'fail', prompt: '不要输出 forbidden。', assertions: [{ type: 'not_contains', value: 'forbidden' }] },
    { id: 'error', prompt: '处理输入。', assertions: [{ type: 'max_chars', value: 100 }] },
  ],
});

function input(overrides = {}) {
  return {
    suiteId: SUITE.suiteId,
    suiteVersion: SUITE.suiteVersion,
    suiteDigest: SUITE.suiteDigest,
    basedOnPackageDigest: PACKAGE,
    runner: 'fixture:v1',
    environment: { kind: 'offline-fixture', node: '24' },
    cases: [
      { id: 'pass', status: 'passed', durationMs: 2, assertions: [{ type: 'contains', value: 'ok', passed: true, message: '包含预期文本' }], outputSummary: 'ok' },
      { id: 'fail', status: 'failed', durationMs: 3, assertions: [{ type: 'not_contains', value: 'forbidden', passed: false, message: '包含了禁止文本' }], outputSummary: 'forbidden' },
      { id: 'error', status: 'error', durationMs: 5, assertions: [], error: 'fixture failed' },
    ],
    startedAt: '2026-08-13T02:00:00Z',
    completedAt: '2026-08-13T02:00:01Z',
    ...overrides,
  };
}

test('result creation binds package, suite and runner and derives summaries', () => {
  const result = createEvalResult(input(), { suite: SUITE, packageDigest: PACKAGE });
  assert.equal(result.schemaVersion, 1);
  assert.equal(result.status, 'complete');
  assert.equal(result.passed, 1);
  assert.equal(result.failed, 2);
  assert.equal(result.successRate, 0.3333);
  assert.equal(result.basedOnPackageDigest, PACKAGE);
  assert.equal(result.suiteDigest, SUITE.suiteDigest);
  assert.equal(result.runner, 'fixture:v1');
  assert.equal(result.cases[0].error, null);
  assert.equal(result.cases[2].outputSummary, null);
});

test('forged aggregate summaries are rejected', () => {
  for (const override of [{ passed: 3 }, { failed: 0 }, { successRate: 1 }]) {
    assert.throws(() => validateEvalResult(input(override), { suite: SUITE, packageDigest: PACKAGE }), /summary|does not match/i);
  }
});

test('case statuses must agree with assertion evidence and errors', () => {
  const forgedPass = input();
  forgedPass.cases[1].status = 'passed';
  assert.throws(() => validateEvalResult(forgedPass, { suite: SUITE }), /case.*status/i);
  const forgedFailure = input();
  forgedFailure.cases[0].status = 'failed';
  assert.throws(() => validateEvalResult(forgedFailure, { suite: SUITE }), /case.*status/i);
  const missingError = input();
  delete missingError.cases[2].error;
  assert.throws(() => validateEvalResult(missingError, { suite: SUITE }), /error.*required/i);
});

test('result case identities and suite identity must exactly match a validated suite', () => {
  const reversed = input();
  reversed.cases.reverse();
  assert.throws(() => validateEvalResult(reversed, { suite: SUITE }), /suite case/i);
  assert.throws(() => validateEvalResult(input({ suiteId: 'other' }), { suite: SUITE }), /suite identity/i);
  assert.throws(() => validateEvalResult(input({ suiteDigest: `sha256:${'c'.repeat(64)}` }), { suite: SUITE }), /suite identity/i);
});

test('result package and runner identities cannot be replaced by caller summaries', () => {
  assert.throws(() => validateEvalResult(input(), { packageDigest: OTHER_PACKAGE }), /packageDigest|package identity/i);
  assert.throws(() => validateEvalResult(input(), { runner: 'fixture:v2' }), /runner.*match|runner identity/i);
  assert.throws(() => validateEvalResult(input({ basedOnPackageDigest: 'invalid' })), /digest/i);
  assert.throws(() => validateEvalResult(input({ runner: '../adapter.js' })), /runner/i);
});

test('result time range, environment and evidence sizes are bounded', () => {
  assert.throws(() => validateEvalResult(input({ completedAt: '2026-08-12T00:00:00Z' })), /completedAt/i);
  assert.throws(() => validateEvalResult(input({ environment: 'secret' })), /environment/i);
  const huge = input();
  huge.cases[0].outputSummary = 'x'.repeat(10);
  assert.throws(() => validateEvalResult(huge, { limits: { maxOutputSummaryChars: 4 } }), /outputSummary/i);
});

test('current result check covers package, suite and runner policy', () => {
  const result = createEvalResult(input(), { suite: SUITE });
  assert.equal(isEvalResultCurrent(result, { packageDigest: PACKAGE, suiteDigest: SUITE.suiteDigest, runner: 'fixture:v1' }), true);
  assert.equal(isEvalResultCurrent(result, { packageDigest: OTHER_PACKAGE }), false);
  assert.equal(isEvalResultCurrent(result, { suiteDigest: `sha256:${'c'.repeat(64)}` }), false);
  assert.equal(isEvalResultCurrent(result, { runner: 'fixture:v2' }), false);
});

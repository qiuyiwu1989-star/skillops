import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { createFixtureEvalAdapter } from '../lib/eval-fixture-adapter.mjs';
import { runEvalSuite } from '../lib/eval-runner.mjs';
import { normalizeEvalSuite } from '../lib/eval-suite.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_DIGEST = `sha256:${'a'.repeat(64)}`;

function suite() {
  return normalizeEvalSuite({
    schemaVersion: 1,
    suiteId: 'fixture/runner',
    suiteVersion: '1.0.0',
    cases: [
      { id: 'text-pass', prompt: '返回包含“完成”的短文本。', assertions: [
        { type: 'contains', value: '完成' }, { type: 'not_contains', value: '失败' }, { type: 'max_chars', value: 20 },
      ] },
      { id: 'json-pass', prompt: '返回结构化状态。', assertions: [
        { type: 'json_path_equals', path: '$.result.ok', value: true },
      ] },
      { id: 'assertion-fail', prompt: '此用例应形成断言失败。', assertions: [
        { type: 'contains', value: '必须出现' },
      ] },
      { id: 'adapter-error', prompt: '此用例应形成 adapter error。', assertions: [
        { type: 'contains', value: '任何值' },
      ] },
      { id: 'case-timeout', prompt: '此用例应独立超时。', assertions: [
        { type: 'contains', value: '迟到' },
      ] },
    ],
  });
}

function packageAudit() {
  return { status: 'pass', basedOnPackageDigest: PACKAGE_DIGEST };
}

test('fixture runner isolates pass, assertion failure, error, and timeout with accurate summaries', async () => {
  const adapter = createFixtureEvalAdapter({
    'text-pass': '任务完成',
    'json-pass': { result: { ok: true } },
    'assertion-fail': '不匹配',
    'adapter-error': { error: 'fixture adapter failed' },
    'case-timeout': { output: '迟到', delayMs: 30 },
  });
  const result = await runEvalSuite({
    suite: suite(),
    packageDigest: PACKAGE_DIGEST,
    packageAudit: packageAudit(),
    executor: adapter,
    timeoutMs: 5,
  });

  assert.equal(result.status, 'complete');
  assert.deepEqual(result.cases.map(item => item.status), ['passed', 'passed', 'failed', 'error', 'timeout']);
  assert.equal(result.passed, 2);
  assert.equal(result.failed, 3);
  assert.equal(result.successRate, 0.4);
  assert.equal(result.runner, 'fixture:v1');
  assert.deepEqual(result.environment, { kind: 'offline-fixture' });
  assert.equal(result.cases[0].assertions.length, 3);
  assert.equal(result.cases[2].assertions[0].passed, false);
  assert.match(result.cases[3].error, /fixture adapter failed/);
  assert.match(result.cases[4].error, /exceeded 5ms/);
});

test('runner requires a current passing package audit and never invokes executor when the gate fails', async () => {
  let calls = 0;
  const executor = async () => { calls++; return '任务完成'; };
  Object.defineProperties(executor, {
    runner: { value: 'fixture:v1' }, environment: { value: { kind: 'offline-fixture' } },
  });
  for (const audit of [null, { status: 'review', basedOnPackageDigest: PACKAGE_DIGEST }, { status: 'pass', basedOnPackageDigest: `sha256:${'b'.repeat(64)}` }]) {
    await assert.rejects(runEvalSuite({ suite: suite(), packageDigest: PACKAGE_DIGEST, packageAudit: audit, executor }), /package audit/i);
  }
  assert.equal(calls, 0);
});

test('fixture result map is copied at construction and missing cases become isolated errors', async () => {
  const results = { 'text-pass': '任务完成' };
  const adapter = createFixtureEvalAdapter(results);
  results['text-pass'] = '被外部修改';
  results['json-pass'] = { result: { ok: true } };
  const result = await runEvalSuite({
    suite: suite(), packageDigest: PACKAGE_DIGEST, packageAudit: packageAudit(), executor: adapter,
  });
  assert.equal(result.cases[0].status, 'passed');
  assert.equal(result.cases[0].outputSummary, '任务完成');
  assert.equal(result.cases[1].status, 'error');
  assert.match(result.cases[1].error, /missing/);
  assert.equal(result.cases.length, 5, 'later cases continue after adapter errors');
});

test('output and error summaries are truncated to the result contract limits', async () => {
  const smallSuite = normalizeEvalSuite({
    schemaVersion: 1, suiteId: 'fixture/truncation', suiteVersion: '1', cases: [
      { id: 'long-output', prompt: '返回长文本。', assertions: [{ type: 'contains', value: '通过' }] },
      { id: 'long-error', prompt: '形成长错误。', assertions: [{ type: 'contains', value: '无' }] },
    ],
  });
  const result = await runEvalSuite({
    suite: smallSuite,
    packageDigest: PACKAGE_DIGEST,
    packageAudit: packageAudit(),
    executor: createFixtureEvalAdapter({
      'long-output': `通过${'长'.repeat(5_000)}`,
      'long-error': { error: '错'.repeat(3_000) },
    }),
  });
  assert.equal([...result.cases[0].outputSummary].length, 4_000);
  assert.equal(result.cases[0].outputSummary.endsWith('…'), true);
  assert.equal([...result.cases[1].error].length, 2_000);
});

test('runner modules contain no process, network, environment, or dynamic module execution capability', () => {
  const sources = ['../lib/eval-runner.mjs', '../lib/eval-fixture-adapter.mjs']
    .map(relative => fs.readFileSync(path.resolve(HERE, relative), 'utf8')).join('\n');
  assert.doesNotMatch(sources, /node:child_process|node:net|node:http|node:https|process\.env|Deno\.env|fetch\s*\(|XMLHttpRequest|WebSocket/);
  assert.doesNotMatch(sources, /import\s*\(\s*[^'"`]|eval\s*\(|new\s+Function/);
});

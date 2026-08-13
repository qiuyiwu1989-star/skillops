import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  SkillOperationsStore,
  SkillOperationsStoreError,
} from '../lib/skill-operations-store.mjs';

const NOW = '2026-08-13T10:00:00.000Z';
const D = letter => `sha256:${letter.repeat(64)}`;

function context(t, options = {}) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'skillops-operations-store-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const filePath = path.join(root, 'state', 'operations.json');
  return { root, filePath, store: new SkillOperationsStore(filePath, options) };
}

function event(operationId = 'op_run_1', eventType = 'invoked', extras = {}) {
  return {
    schemaVersion: 1,
    operationId,
    eventType,
    organizationId: 'org_yongle',
    projectId: 'project_camp',
    skillId: 'qiuyiwu/humanizer',
    releaseId: `rel_${'a'.repeat(64)}`,
    packageDigest: D('b'),
    occurredAt: NOW,
    window: '2026-08-13',
    environmentDigest: D('c'),
    policyDigest: D('d'),
    ...extras,
  };
}

function query() {
  return {
    organizationId: 'org_yongle',
    projectId: 'project_camp',
    skillId: 'qiuyiwu/humanizer',
    windowStart: '2026-08-13',
    windowEnd: '2026-08-13',
  };
}

test('append-only 原子追加、revision CAS 与重启重放一致', t => {
  const { filePath, store } = context(t);
  const empty = store.read();
  assert.match(empty.revision, /^sha256:[a-f0-9]{64}$/);
  const first = store.append(event(), { expectedRevision: empty.revision, now: NOW });
  assert.equal(first.action, 'appended');
  assert.notEqual(first.revision, empty.revision);
  const reopened = new SkillOperationsStore(filePath);
  assert.deepEqual(reopened.read(), store.read());
  assert.deepEqual(reopened.project(), first.projection);
  const second = reopened.append(event('op_run_1', 'succeeded', { costMicros: 200, latencyMs: 40 }), {
    expectedRevision: first.revision, now: NOW,
  });
  assert.equal(second.projection.throughSequence, 2);
  assert.throws(
    () => store.append(event('op_run_2'), { expectedRevision: first.revision, now: NOW }),
    error => error instanceof SkillOperationsStoreError && error.code === 'REVISION_CONFLICT',
  );
  assert.equal(store.read().events.length, 2);
});

test('同 operation 阶段幂等但需要当前 revision，冲突事件零写入', t => {
  const { store } = context(t);
  const first = store.append(event(), { expectedRevision: store.read().revision, now: NOW });
  const later = '2026-08-13T11:00:00.000Z';
  const replayed = store.append(event('op_run_1', 'invoked', { occurredAt: later, window: '2026-08-13' }), {
    expectedRevision: first.revision, now: later,
  });
  assert.equal(replayed.action, 'replayed');
  assert.equal(replayed.revision, first.revision);
  assert.equal(store.read().events.length, 1);
  assert.throws(
    () => store.append(event('op_run_1', 'invoked', { environmentDigest: D('e') }), { expectedRevision: first.revision, now: NOW }),
    error => error.code === 'OPERATION_EVENT_CONFLICT',
  );
  assert.equal(store.read().events.length, 1);
});

test('store 只暴露 append，没有覆盖历史的 write 入口，并从事件重算 summary', t => {
  const { store } = context(t);
  let revision = store.read().revision;
  for (const [type, extras] of [['impression', {}], ['selected', {}], ['invoked', {}], ['handoff', { latencyMs: 500 }]]) {
    const result = store.append(event('op_run_1', type, extras), { expectedRevision: revision, now: NOW });
    revision = result.revision;
  }
  assert.equal(store.write, undefined);
  const summary = store.summarize(query(), { minimumInvocations: 1 });
  assert.equal(summary.metrics.funnel.invoked.observed, 1);
  assert.equal(summary.metrics.outcomes.handoffRate, 1);
  assert.equal(summary.autoRetirementAllowed, false);
});

test('篡改、事件数量、单事件和账本大小限制全部失败关闭', t => {
  const { filePath, store } = context(t);
  store.append(event(), { expectedRevision: store.read().revision, now: NOW });
  const original = fs.readFileSync(filePath, 'utf8');
  const tampered = JSON.parse(original);
  tampered.events[0].skillId = 'attacker/rewritten';
  fs.writeFileSync(filePath, JSON.stringify(tampered));
  assert.throws(() => store.read(), error => ['REVISION_MISMATCH', 'INVALID_EVENT_LOG'].includes(error.code));
  fs.writeFileSync(filePath, original);

  const limitedCount = new SkillOperationsStore(filePath, { maxEvents: 1 });
  assert.throws(
    () => limitedCount.append(event('op_run_2'), { expectedRevision: limitedCount.read().revision, now: NOW }),
    error => error.code === 'EVENT_LIMIT_EXCEEDED',
  );
  const limitedEvent = new SkillOperationsStore(filePath, { maxEventBytes: 128 });
  assert.throws(() => limitedEvent.read(), error => error.code === 'EVENT_TOO_LARGE');
  const limitedFile = new SkillOperationsStore(filePath, { maxStoreBytes: 32 });
  assert.throws(() => limitedFile.read(), error => error.code === 'STORE_TOO_LARGE');
});

test('符号链接、目录目标、父目录链接和残留写锁失败关闭且不污染外部', t => {
  const { root } = context(t);
  const target = path.join(root, 'target.json');
  fs.writeFileSync(target, '{}');
  const linked = path.join(root, 'linked.json');
  fs.symlinkSync(target, linked);
  assert.throws(() => new SkillOperationsStore(linked).read(), error => error.code === 'UNSAFE_STORE_PATH');

  const directory = path.join(root, 'directory.json');
  fs.mkdirSync(directory);
  assert.throws(() => new SkillOperationsStore(directory).read(), error => error.code === 'UNSAFE_STORE_PATH');

  const outside = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'skillops-operations-outside-'));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  fs.symlinkSync(outside, path.join(root, 'linked-state'), 'dir');
  assert.throws(
    () => new SkillOperationsStore(path.join(root, 'linked-state', 'operations.json')),
    error => error.code === 'UNSAFE_STORE_PATH',
  );
  assert.equal(fs.existsSync(path.join(outside, 'operations.json')), false);

  const filePath = path.join(root, 'locked.json');
  fs.writeFileSync(`${filePath}.lock`, 'busy', { mode: 0o600 });
  const locked = new SkillOperationsStore(filePath);
  assert.throws(
    () => locked.append(event(), { expectedRevision: locked.read().revision, now: NOW }),
    error => error.code === 'STORE_BUSY',
  );
  assert.equal(fs.existsSync(filePath), false);
});

test('系统临时目录别名可用，但其下嵌套符号链接仍然零写', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skillops-operations-tmp-alias-'));
  t.after(() => fs.rmSync(fs.realpathSync(root), { recursive: true, force: true }));
  const direct = new SkillOperationsStore(path.join(root, 'direct', 'operations.json'));
  assert.equal(direct.read().events.length, 0);
  const outside = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'skillops-operations-alias-outside-'));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  fs.symlinkSync(outside, path.join(root, 'linked-state'), 'dir');
  assert.throws(
    () => new SkillOperationsStore(path.join(root, 'linked-state', 'operations.json')),
    error => error.code === 'UNSAFE_STORE_PATH',
  );
  assert.equal(fs.existsSync(path.join(outside, 'operations.json')), false);
});

test('原子写注入故障删除临时文件与锁，已提交历史保持原样', t => {
  let failRename = false;
  const { filePath, store } = context(t, {
    faultInjector(phase) {
      if (failRename && phase === 'beforeRename') throw new Error('injected rename failure');
    },
  });
  const first = store.append(event(), { expectedRevision: store.read().revision, now: NOW });
  const before = fs.readFileSync(filePath, 'utf8');
  failRename = true;
  assert.throws(
    () => store.append(event('op_run_1', 'succeeded'), { expectedRevision: first.revision, now: NOW }),
    /injected rename failure/,
  );
  assert.equal(fs.readFileSync(filePath, 'utf8'), before);
  assert.equal(fs.readdirSync(path.dirname(filePath)).some(name => name.endsWith('.tmp') || name.endsWith('.lock')), false);
});

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { canonicalDigest, normalizeRelease, sourceId, toPublicRegistryValue } from '../lib/registry-identity.mjs';
import { createRegistryEvent } from '../lib/registry-store.mjs';
import { createZaowuyunEnvelope } from '../lib/zaowuyun-adapter.mjs';
import { createZaowuyunStagingPlan } from '../lib/zaowuyun-staging.mjs';
import {
  PersistentZaowuyunStagingSender,
  ZaowuyunStagingStore,
  ZaowuyunStagingStoreError,
} from '../lib/zaowuyun-staging-store.mjs';

const D = letter => `sha256:${letter.repeat(64)}`;

function context(t, options = {}) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'skillops-staging-store-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const filePath = path.join(root, 'state', 'staging.json');
  return { root, filePath, store: new ZaowuyunStagingStore(filePath, options) };
}

function release() {
  return normalizeRelease({
    skillId: 'qiuyiwu/humanizer', version: '1.0.0',
    package: { packageDigest: D('a'), manifestDigest: D('b'), storageRef: `cas:${D('a')}` },
    compatibility: { contract: 'skill-package.v1', targets: ['claude-code'] },
    assessmentRefs: ['eval_fixture', 'sms_fixture'], reviewRefs: ['review_fixture'],
    sourceRefs: [sourceId('skillhub', 'https://skillhub.cn/humanizer')],
    publishedAt: '2026-08-13T01:00:00Z',
  });
}

function envelope(title = '文本去 AI 味', sequence = 1) {
  const value = release();
  const internal = createRegistryEvent({
    type: 'release.published', subject: { skillId: value.skillId, releaseId: value.releaseId },
    payload: { release: value }, occurredAt: '2026-08-13T01:00:00Z',
    actorRef: 'registry-publisher', reasonCode: 'fixture', policyVersion: 'registry-v1',
  });
  const payload = toPublicRegistryValue(internal.payload);
  const event = {
    schemaVersion: 1, eventId: internal.eventId, sequence, type: internal.type,
    occurredAt: internal.occurredAt, actorRole: 'registry-publisher', reasonCode: internal.reasonCode,
    subject: toPublicRegistryValue(internal.subject), payload, payloadDigest: canonicalDigest(payload), policyVersion: internal.policyVersion,
  };
  return createZaowuyunEnvelope(event, {
    release: value, listing: { title, description: '让中文表达更自然。', category: '内容创作' },
    trust: {
      sms: { ref: 'sms_fixture', status: 'pass', total: 91, tier: 'A' },
      eval: { ref: 'eval_fixture', status: 'pass', successRate: 1 },
      review: { refs: ['review_fixture'], status: 'certified', validUntil: '2026-09-13T01:00:00Z' },
    },
  });
}

function plan(operationId = 'op_publish_humanizer', title = '文本去 AI 味') {
  return createZaowuyunStagingPlan(envelope(title), { operationId, afterCursor: '0' });
}

function accepted(input) {
  return {
    projectionId: input.projectionId, idempotencyKey: input.idempotencyKey,
    payloadDigest: input.payloadDigest, status: 'accepted',
    remoteRef: `https://staging.example.invalid/receipts/${input.projectionId}`,
    receivedAt: '2026-08-13T02:00:00Z',
  };
}

test('prepare→transport→commit 持久化 cursor、binding 与裁剪回执，重启幂等', async t => {
  const { filePath, store } = context(t);
  const sent = [];
  const sender = new PersistentZaowuyunStagingSender({
    store, clock: () => '2026-08-13T03:00:00Z',
    transport: { send(input) { sent.push(structuredClone(input)); return accepted(input); } },
  });
  const input = plan();
  const first = await sender.send(input, { confirmationDigest: input.confirmationDigest });
  assert.equal(first.status, 'accepted');
  assert.equal(sent.length, 1);
  const reopened = new ZaowuyunStagingStore(filePath);
  assert.equal(reopened.status().cursor, '1');
  assert.equal(reopened.status().receiptCount, 1);
  const retry = await new PersistentZaowuyunStagingSender({
    store: reopened, transport: { send() { throw new Error('must not resend'); } },
  }).send(input, { confirmationDigest: input.confirmationDigest });
  assert.deepEqual(retry, first);
  const serialized = fs.readFileSync(filePath, 'utf8');
  for (const forbidden of ['"envelope"', 'https://', 'principal', 'storageRef', 'localPath', 'prompt', 'output', 'token', 'secret']) {
    assert.equal(serialized.includes(forbidden), false, `ledger must not persist ${forbidden}`);
  }
});

test('同 operation 换 confirmation digest 冲突且不会发送', async t => {
  const { store } = context(t);
  let sends = 0;
  const sender = new PersistentZaowuyunStagingSender({ store, transport: { send(input) { sends += 1; return accepted(input); } } });
  const first = plan('op_fixed');
  await sender.send(first, { confirmationDigest: first.confirmationDigest });
  const changed = plan('op_fixed', '已更新标题');
  await assert.rejects(sender.send(changed, { confirmationDigest: changed.confirmationDigest }), error => error.code === 'OPERATION_CONFLICT');
  assert.equal(sends, 1);
});

test('外部没有台账写入入口，已有 operation 只能经公开协议推进', async t => {
  const { store } = context(t);
  assert.equal(store.write, undefined);
  const input = plan('op_public_protocol_only');
  const prepared = store.prepare(input, {
    confirmationDigest: input.confirmationDigest,
    at: '2026-08-13T03:00:00Z',
  });
  assert.equal(prepared.state, 'prepared');
  assert.equal(store.read().operations.length, 1);
  assert.equal(store.startTransport(input.operationId, '2026-08-13T03:00:01Z').action, 'started');
  assert.equal(store.read().operations[0].state, 'transport_started');
});

test('两个持久 sender 并发同 operation 只有一个 transport 调用', async t => {
  const { filePath, store } = context(t);
  let releaseTransport;
  const gate = new Promise(resolve => { releaseTransport = resolve; });
  let sends = 0;
  const transport = {
    async send(input) {
      sends += 1;
      await gate;
      return accepted(input);
    },
  };
  const input = plan('op_concurrent');
  const first = new PersistentZaowuyunStagingSender({ store, transport })
    .send(input, { confirmationDigest: input.confirmationDigest });
  await new Promise(resolve => setImmediate(resolve));
  const secondStore = new ZaowuyunStagingStore(filePath);
  await assert.rejects(
    new PersistentZaowuyunStagingSender({ store: secondStore, transport })
      .send(input, { confirmationDigest: input.confirmationDigest }),
    error => error.code === 'RECONCILIATION_REQUIRED',
  );
  assert.equal(sends, 1);
  releaseTransport();
  await assert.rejects(first, error => error.code === 'RECONCILIATION_REQUIRED');
  assert.equal(sends, 1);
});

test('远端接受后本地 commit 失败返回对账工件，重启阻止盲重发', async t => {
  let failCommit = true;
  const { filePath, store } = context(t, {
    faultInjector(phase) {
      if (failCommit && phase === 'beforeCommitAccepted') throw new Error('commit unavailable');
    },
  });
  let sends = 0;
  const input = plan('op_uncertain');
  const sender = new PersistentZaowuyunStagingSender({
    store, transport: { send(value) { sends += 1; return accepted(value); } },
  });
  await assert.rejects(
    sender.send(input, { confirmationDigest: input.confirmationDigest }),
    error => error instanceof ZaowuyunStagingStoreError
      && error.code === 'RECONCILIATION_REQUIRED'
      && error.reconciliation?.operationId === 'op_uncertain'
      && !('remoteRef' in error.reconciliation),
  );
  assert.equal(sends, 1);
  failCommit = false;
  const reopened = new ZaowuyunStagingStore(filePath);
  await assert.rejects(
    new PersistentZaowuyunStagingSender({ store: reopened, transport: { send() { sends += 1; } } })
      .send(input, { confirmationDigest: input.confirmationDigest }),
    error => error.code === 'RECONCILIATION_REQUIRED',
  );
  assert.equal(sends, 1);
  assert.equal(reopened.status().reconciliationRequiredCount, 1);
});

test('transport 抛错视为结果不确定并持久阻断重发', async t => {
  const { filePath, store } = context(t);
  const input = plan('op_transport_unknown');
  await assert.rejects(
    new PersistentZaowuyunStagingSender({ store, transport: { send() { throw new Error('socket closed'); } } })
      .send(input, { confirmationDigest: input.confirmationDigest }),
    error => error.code === 'RECONCILIATION_REQUIRED',
  );
  const reopened = new ZaowuyunStagingStore(filePath);
  assert.equal(reopened.status().operations[0].state, 'reconciliation_required');
  let sends = 0;
  await assert.rejects(
    new PersistentZaowuyunStagingSender({ store: reopened, transport: { send() { sends += 1; } } })
      .send(input, { confirmationDigest: input.confirmationDigest }),
    error => error.code === 'RECONCILIATION_REQUIRED',
  );
  assert.equal(sends, 0);
});

test('篡改、符号链接、目录、大小与记录数量限制失败关闭', async t => {
  const { root, filePath, store } = context(t);
  const input = plan();
  await new PersistentZaowuyunStagingSender({ store, transport: { send: accepted } })
    .send(input, { confirmationDigest: input.confirmationDigest });
  const ledger = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  ledger.cursor = '0';
  fs.writeFileSync(filePath, JSON.stringify(ledger));
  assert.throws(() => store.read(), error => ['REVISION_MISMATCH', 'INVALID_STORE_STATE'].includes(error.code));

  const linked = path.join(root, 'linked.json');
  fs.symlinkSync(filePath, linked);
  assert.throws(() => new ZaowuyunStagingStore(linked).read(), error => error.code === 'UNSAFE_STORE_PATH');
  const directory = path.join(root, 'directory');
  fs.mkdirSync(directory);
  assert.throws(() => new ZaowuyunStagingStore(directory).read(), error => error.code === 'UNSAFE_STORE_PATH');
  assert.throws(() => new ZaowuyunStagingStore(filePath, { maxStoreBytes: 16 }).read(), error => error.code === 'STORE_TOO_LARGE');
  assert.throws(() => new ZaowuyunStagingStore(filePath, { maxOperations: 0 }), error => error.code === 'INVALID_LIMIT');
});

test('符号链接父目录在构造时失败关闭且不会向链接目标写入', t => {
  const { root } = context(t);
  const outside = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'skillops-staging-outside-'));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  const stateLink = path.join(root, 'linked-state');
  fs.symlinkSync(outside, stateLink, 'dir');
  const escapedLedger = path.join(stateLink, 'staging.json');
  assert.throws(
    () => new ZaowuyunStagingStore(escapedLedger),
    error => error.code === 'UNSAFE_STORE_PATH',
  );
  assert.equal(fs.existsSync(path.join(outside, 'staging.json')), false);
});

test('系统临时目录别名前缀可用，但其下嵌套符号链接仍零写', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skillops-staging-tmp-alias-'));
  t.after(() => fs.rmSync(fs.realpathSync(root), { recursive: true, force: true }));
  const direct = new ZaowuyunStagingStore(path.join(root, 'direct', 'staging.json'));
  assert.equal(direct.read().operations.length, 0);
  const outside = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'skillops-staging-alias-outside-'));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  fs.symlinkSync(outside, path.join(root, 'linked-state'), 'dir');
  assert.throws(
    () => new ZaowuyunStagingStore(path.join(root, 'linked-state', 'staging.json')),
    error => error.code === 'UNSAFE_STORE_PATH',
  );
  assert.equal(fs.existsSync(path.join(outside, 'staging.json')), false);
});

test('prepare 原子写故障零污染且 transport 不会被调用', async t => {
  let failPrepare = true;
  const { filePath, store } = context(t, {
    faultInjector(phase) {
      if (failPrepare && phase === 'beforeRename') throw new Error('prepare write failed');
    },
  });
  let sends = 0;
  const input = plan();
  await assert.rejects(
    new PersistentZaowuyunStagingSender({ store, transport: { send() { sends += 1; } } })
      .send(input, { confirmationDigest: input.confirmationDigest }),
    /prepare write failed/,
  );
  assert.equal(sends, 0);
  assert.equal(fs.existsSync(filePath), false);
  assert.equal(fs.readdirSync(path.dirname(filePath)).some(name => name.endsWith('.tmp') || name.endsWith('.lock')), false);
  failPrepare = false;
});

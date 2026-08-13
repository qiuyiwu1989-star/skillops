import assert from 'node:assert/strict';
import test from 'node:test';

import { canonicalDigest, normalizeRelease, sourceId, toPublicRegistryValue } from '../lib/registry-identity.mjs';
import { createRegistryEvent } from '../lib/registry-store.mjs';
import {
  createZaowuyunEnvelope,
  validateZaowuyunEnvelope,
} from '../lib/zaowuyun-adapter.mjs';
import {
  ZaowuyunStagingError,
  ZaowuyunStagingSender,
  createZaowuyunStagingPlan,
  validateZaowuyunStagingPlan,
} from '../lib/zaowuyun-staging.mjs';

const D = letter => `sha256:${letter.repeat(64)}`;

function release(version = '1.0.0', digest = D('a')) {
  return normalizeRelease({
    skillId: 'qiuyiwu/humanizer', version,
    package: { packageDigest: digest, manifestDigest: D('b'), storageRef: `cas:${digest}` },
    compatibility: { contract: 'skill-package.v1', targets: ['claude-code'] },
    assessmentRefs: ['eval_fixture', 'sms_fixture'], reviewRefs: ['review_fixture'],
    sourceRefs: [sourceId('skillhub', 'https://skillhub.cn/humanizer')],
    publishedAt: '2026-08-13T01:00:00Z',
  });
}

function publicEvent(value = release(), sequence = 1) {
  const internal = createRegistryEvent({
    type: 'release.published',
    subject: { skillId: value.skillId, releaseId: value.releaseId },
    payload: { release: value, candidateId: 'cand_internal', localPath: '/private/tmp/package' },
    occurredAt: '2026-08-13T01:00:00Z', actorRef: 'principal:reviewer-123',
    reasonCode: 'fixture', policyVersion: 'registry-v1',
  });
  const payload = toPublicRegistryValue(internal.payload);
  return {
    schemaVersion: internal.schemaVersion,
    eventId: internal.eventId,
    sequence,
    type: internal.type,
    occurredAt: internal.occurredAt,
    actorRole: 'registry-publisher',
    reasonCode: internal.reasonCode,
    subject: toPublicRegistryValue(internal.subject),
    payload,
    payloadDigest: canonicalDigest(payload),
    policyVersion: internal.policyVersion,
  };
}

function envelope({ title = '文本去 AI 味', sequence = 1 } = {}) {
  const value = release();
  return createZaowuyunEnvelope(publicEvent(value, sequence), {
    release: value,
    listing: { title, description: '让中文表达更自然。', category: '内容创作' },
    trust: {
      sms: { ref: 'sms_fixture', status: 'pass', total: 91, tier: 'A' },
      eval: { ref: 'eval_fixture', status: 'pass', successRate: 1 },
      review: { refs: ['review_fixture'], status: 'certified', validUntil: '2026-09-13T01:00:00Z' },
    },
  });
}

function acceptedReceipt(input) {
  return {
    projectionId: input.projectionId,
    idempotencyKey: input.idempotencyKey,
    status: 'accepted',
    remoteRef: `https://staging.zaowuyun.test/receipt/${input.projectionId}`,
    receivedAt: '2026-08-13T02:00:00Z',
    payloadDigest: input.payloadDigest,
  };
}

test('dry-run plan is deterministic, binds the full public envelope and performs zero sends', () => {
  let calls = 0;
  const transport = { send() { calls += 1; } };
  const sender = new ZaowuyunStagingSender({ transport, clock: () => '2026-08-13T03:00:00Z' });
  const current = envelope();
  const previous = envelope({ title: 'Humanizer' });
  const first = createZaowuyunStagingPlan(current, {
    operationId: 'op_publish_humanizer_v1', afterCursor: '0', previousEnvelope: previous,
  });
  const second = createZaowuyunStagingPlan(structuredClone(current), {
    operationId: 'op_publish_humanizer_v1', afterCursor: '0', previousEnvelope: previous,
  });

  assert.deepEqual(first, second);
  assert.deepEqual(validateZaowuyunStagingPlan(first), first);
  assert.equal(first.mode, 'dry-run');
  assert.equal(first.nextCursor, '1');
  assert.equal(first.diff.changedPaths.includes('display.titleZh'), true);
  assert.match(first.confirmationDigest, /^sha256:[a-f0-9]{64}$/);
  assert.equal(calls, 0);
  assert.deepEqual(sender.status(), { schemaVersion: 1, cursor: '0', receiptCount: 0, receipts: [] });
});

test('only a validated dry-run envelope is plannable and network configuration fields are rejected', () => {
  const dryRun = envelope();
  const staging = { ...dryRun, mode: 'staging-mock' };
  assert.throws(
    () => createZaowuyunStagingPlan(staging, { operationId: 'op_staging', afterCursor: '0' }),
    error => error.code === 'INVALID_ENVELOPE',
  );
  assert.throws(
    () => createZaowuyunStagingPlan(dryRun, {
      operationId: 'op_url', afterCursor: '0', productionUrl: 'https://api.zaowuyun.test',
    }),
    error => error.code === 'UNKNOWN_FIELD',
  );
  assert.throws(
    () => new ZaowuyunStagingSender({
      transport: { send() {} }, apiSecret: 'must-not-enter-core',
    }),
    error => error.code === 'UNKNOWN_FIELD',
  );
  assert.throws(
    () => createZaowuyunStagingPlan(dryRun, {
      operationId: 'principal:reviewer-123', afterCursor: '0',
    }),
    error => error.code === 'PRIVATE_DATA_FORBIDDEN',
  );
});

test('wrong confirmation sends nothing; exact confirmation sends once and stores only a trimmed receipt', async () => {
  const sent = [];
  const transport = {
    send(input) {
      sent.push(structuredClone(input));
      return acceptedReceipt(input);
    },
  };
  const sender = new ZaowuyunStagingSender({ transport, clock: () => '2026-08-13T03:00:00Z' });
  const plan = createZaowuyunStagingPlan(envelope(), {
    operationId: 'op_publish_humanizer_v1', afterCursor: '0',
  });

  await assert.rejects(
    sender.send(plan, { confirmationDigest: D('f') }),
    error => error instanceof ZaowuyunStagingError && error.code === 'CONFIRMATION_MISMATCH',
  );
  assert.equal(sent.length, 0);
  const first = await sender.send(plan, { confirmationDigest: plan.confirmationDigest });
  const retry = await sender.send(structuredClone(plan), { confirmationDigest: plan.confirmationDigest });

  assert.deepEqual(retry, first);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].mode, 'staging-mock');
  assert.deepEqual(validateZaowuyunEnvelope(sent[0]), sent[0]);
  assert.equal(first.remoteRef, undefined);
  assert.match(first.remoteRefDigest, /^sha256:[a-f0-9]{64}$/);
  assert.equal(first.cursor, '1');
  const status = sender.status();
  assert.equal(status.cursor, '1');
  assert.equal(status.receiptCount, 1);
  assert.deepEqual(status.receipts, [first]);
  const serialized = JSON.stringify(status);
  for (const forbidden of ['cand_', 'storageRef', 'localPath', 'reviewer', 'principal', 'prompt', 'output', 'token', 'secret', 'https://']) {
    assert.equal(serialized.includes(forbidden), false, `ledger must not contain ${forbidden}`);
  }
});

test('transport failure changes no status and retry keeps the same idempotency key', async () => {
  const attempts = [];
  let fail = true;
  const transport = {
    async send(input) {
      attempts.push(structuredClone(input));
      if (fail) throw new Error('staging unavailable');
      return acceptedReceipt(input);
    },
  };
  const sender = new ZaowuyunStagingSender({ transport, clock: () => '2026-08-13T03:00:00Z' });
  const plan = createZaowuyunStagingPlan(envelope(), {
    operationId: 'op_retry_humanizer_v1', afterCursor: '0',
  });

  const before = sender.status();
  await assert.rejects(sender.send(plan, { confirmationDigest: plan.confirmationDigest }), /staging unavailable/);
  assert.deepEqual(sender.status(), before);
  fail = false;
  await sender.send(plan, { confirmationDigest: plan.confirmationDigest });
  assert.equal(attempts.length, 2);
  assert.equal(attempts[0].idempotencyKey, attempts[1].idempotencyKey);
  assert.equal(attempts[0].payloadDigest, attempts[1].payloadDigest);
});

test('two operations sharing one cursor can never send concurrently', async () => {
  let releaseFirst;
  const gate = new Promise(resolve => { releaseFirst = resolve; });
  const attempts = [];
  const transport = {
    async send(input) {
      attempts.push(structuredClone(input));
      await gate;
      return acceptedReceipt(input);
    },
  };
  const sender = new ZaowuyunStagingSender({ transport, clock: () => '2026-08-13T03:00:00Z' });
  const first = createZaowuyunStagingPlan(envelope(), {
    operationId: 'op_concurrent_first', afterCursor: '0',
  });
  const second = createZaowuyunStagingPlan(envelope({ title: '另一个并发发布' }), {
    operationId: 'op_concurrent_second', afterCursor: '0',
  });

  const firstSend = sender.send(first, { confirmationDigest: first.confirmationDigest });
  assert.equal(attempts.length, 1);
  await assert.rejects(
    sender.send(second, { confirmationDigest: second.confirmationDigest }),
    error => error.code === 'CURSOR_IN_FLIGHT',
  );
  assert.equal(attempts.length, 1, 'second operation must fail before transport.send');
  assert.equal(sender.status().cursor, '0');

  releaseFirst();
  await firstSend;
  assert.equal(attempts.length, 1);
  assert.equal(sender.status().cursor, '1');
});

test('clock is validated before transport and cannot create a remote-only acceptance', async () => {
  let sends = 0;
  const sender = new ZaowuyunStagingSender({
    clock: () => 'not-a-timestamp',
    transport: { send() { sends += 1; } },
  });
  const plan = createZaowuyunStagingPlan(envelope(), {
    operationId: 'op_bad_clock', afterCursor: '0',
  });

  await assert.rejects(
    sender.send(plan, { confirmationDigest: plan.confirmationDigest }),
    error => error.code === 'INVALID_TIMESTAMP',
  );
  assert.equal(sends, 0);
  assert.deepEqual(sender.status(), { schemaVersion: 1, cursor: '0', receiptCount: 0, receipts: [] });
});

test('the same operation cannot be rebound to another confirmation digest', async () => {
  const sent = [];
  const transport = { send(input) { sent.push(input); return acceptedReceipt(input); } };
  const sender = new ZaowuyunStagingSender({ transport, clock: () => '2026-08-13T03:00:00Z' });
  const first = createZaowuyunStagingPlan(envelope(), {
    operationId: 'op_fixed', afterCursor: '0',
  });
  const changed = createZaowuyunStagingPlan(envelope({ title: '中文标题已更新' }), {
    operationId: 'op_fixed', afterCursor: '0',
  });

  await sender.send(first, { confirmationDigest: first.confirmationDigest });
  await assert.rejects(
    sender.send(changed, { confirmationDigest: changed.confirmationDigest }),
    error => error.code === 'OPERATION_CONFLICT',
  );
  assert.equal(sent.length, 1);
});

test('a forged plan, cursor mismatch or unsafe transport receipt fails closed', async () => {
  const valid = createZaowuyunStagingPlan(envelope(), {
    operationId: 'op_safe', afterCursor: '0',
  });
  assert.throws(
    () => validateZaowuyunStagingPlan({ ...valid, nextCursor: '9' }),
    error => error.code === 'PLAN_DIGEST_MISMATCH' || error.code === 'CURSOR_MISMATCH',
  );

  const sender = new ZaowuyunStagingSender({
    transport: { send(input) { return { ...acceptedReceipt(input), token: 'leak' }; } },
  });
  await assert.rejects(
    sender.send(valid, { confirmationDigest: valid.confirmationDigest }),
    error => error.code === 'UNSAFE_RECEIPT',
  );
  assert.equal(sender.status().cursor, '0');

  const ahead = createZaowuyunStagingPlan(envelope({ sequence: 2 }), {
    operationId: 'op_ahead', afterCursor: '1',
  });
  await assert.rejects(
    sender.send(ahead, { confirmationDigest: ahead.confirmationDigest }),
    error => error.code === 'CURSOR_CONFLICT',
  );
});

import assert from 'node:assert/strict';
import test from 'node:test';

import { canonicalDigest, normalizeRelease, sourceId, toPublicRegistryValue } from '../lib/registry-identity.mjs';
import { createRegistryEvent } from '../lib/registry-store.mjs';
import {
  ZaowuyunAdapterError,
  ZaowuyunMockTransport,
  createZaowuyunEnvelope,
  recomputeZaowuyunIdempotencyKey,
  recomputeZaowuyunPayloadDigest,
  recomputeZaowuyunProjectionId,
  validateZaowuyunEnvelope,
} from '../lib/zaowuyun-adapter.mjs';

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

function registryEvent(type, value = release(), extras = {}) {
  const payload = type === 'release.published'
    ? { release: value, candidateId: 'cand_internal', localPath: '/private/tmp/package' }
    : type === 'release.superseded'
      ? { releaseId: value.releaseId, successorReleaseId: extras.successorReleaseId }
      : { releaseId: value.releaseId };
  return {
    ...createRegistryEvent({
      type,
      subject: { skillId: value.skillId, releaseId: value.releaseId },
      payload,
      occurredAt: extras.occurredAt ?? '2026-08-13T01:00:00Z',
      actorRef: 'principal:reviewer-123',
      reasonCode: extras.reasonCode ?? 'fixture',
      policyVersion: 'registry-v1',
    }),
    sequence: extras.sequence ?? 7,
  };
}

function publicEvent(input) {
  const payload = toPublicRegistryValue(input.payload);
  return {
    schemaVersion: input.schemaVersion,
    eventId: input.eventId,
    sequence: input.sequence,
    type: input.type,
    occurredAt: input.occurredAt,
    actorRole: 'registry-publisher',
    reasonCode: input.reasonCode,
    subject: toPublicRegistryValue(input.subject),
    payload,
    payloadDigest: canonicalDigest(payload),
    policyVersion: input.policyVersion,
  };
}

function context(value = release()) {
  return {
    release: value,
    listing: {
      title: { 'zh-CN': '文本去 AI 味', original: 'Humanizer' },
      description: { 'zh-CN': '让中文表达更自然。', original: 'Make writing natural.' },
      category: '内容创作',
    },
    trust: {
      sms: { ref: 'sms_fixture', status: 'pass', total: 91, tier: 'A' },
      eval: { ref: 'eval_fixture', status: 'pass', successRate: 1, output: 'must not leak' },
      review: {
        refs: ['review_fixture'], status: 'certified', validUntil: '2026-09-13T01:00:00Z',
        reviewer: { principalId: 'principal:reviewer-123' },
      },
    },
  };
}

test('internal and public Registry events produce the same deterministic safe upsert envelope', () => {
  const value = release();
  const internal = registryEvent('release.published', value);
  const options = context(value);
  const first = createZaowuyunEnvelope(internal, options);
  const second = createZaowuyunEnvelope(publicEvent(internal), options);

  assert.deepEqual(first, second);
  assert.equal(first.schema, 'zaowuyun.ability.skill.v1');
  assert.equal(first.mode, 'dry-run');
  assert.equal(first.action, 'upsert');
  assert.deepEqual(first.subject, {
    abilityType: 'skill', skillId: value.skillId, releaseId: value.releaseId,
  });
  assert.equal(first.display.titleZh, '文本去 AI 味');
  assert.equal(first.distribution.manifestRef, `registry://releases/${value.releaseId}/manifest`);
  assert.equal(first.trust.packageDigest, value.package.packageDigest);

  const serialized = JSON.stringify(first);
  for (const forbidden of ['cand_', 'storageRef', '/private/tmp', 'reviewer', 'principal', 'output', 'token']) {
    assert.equal(serialized.includes(forbidden), false, `must not expose ${forbidden}`);
  }
});

test('projection identity, idempotency key and payload digest can all be recomputed', () => {
  const event = registryEvent('release.published');
  const envelope = createZaowuyunEnvelope(event, context());
  assert.equal(recomputeZaowuyunProjectionId(envelope), envelope.projectionId);
  assert.equal(recomputeZaowuyunIdempotencyKey(envelope), envelope.idempotencyKey);
  assert.equal(recomputeZaowuyunPayloadDigest(envelope), envelope.payloadDigest);
  assert.deepEqual(validateZaowuyunEnvelope(envelope), envelope);

  assert.throws(
    () => validateZaowuyunEnvelope({ ...envelope, display: { ...envelope.display, category: '办公效率' } }),
    error => error.code === 'PROJECTION_ID_MISMATCH' || error.code === 'PAYLOAD_DIGEST_MISMATCH',
  );
});

test('withdraw, supersede and revoke map to explicit lifecycle actions without deleting history', () => {
  const oldRelease = release();
  const successor = release('1.1.0', D('c'));
  const cases = [
    ['release.withdrawn', 'withdraw', 'withdrawn'],
    ['listing.withdrawn', 'withdraw', 'withdrawn'],
    ['release.superseded', 'supersede', 'superseded'],
    ['release.revoked', 'revoke', 'revoked'],
  ];

  for (const [type, action, status] of cases) {
    const event = registryEvent(type, oldRelease, { successorReleaseId: successor.releaseId });
    const envelope = createZaowuyunEnvelope(event, context(oldRelease));
    assert.equal(envelope.action, action);
    assert.equal(envelope.distribution.status, status);
    assert.equal(envelope.distribution.delete, undefined);
    if (type === 'release.superseded') {
      assert.deepEqual(envelope.relations, [{
        relation: 'superseded-by', abilityType: 'skill',
        skillId: oldRelease.skillId, releaseId: successor.releaseId,
      }]);
    }
  }
});

test('listing upsert can be projected when it is bound to a Registry Release', () => {
  const value = release();
  const event = {
    ...createRegistryEvent({
      type: 'listing.upserted',
      subject: { skillId: value.skillId, releaseId: value.releaseId, listingId: 'public:zh-CN' },
      payload: {
        channel: 'public', locale: 'zh-CN', skillId: value.skillId, releaseId: value.releaseId,
        title: '文本去 AI 味', description: '让中文表达更自然。', category: '内容创作',
      },
      occurredAt: '2026-08-13T01:00:00Z', actorRef: 'role:publisher',
      reasonCode: 'fixture', policyVersion: 'registry-v1',
    }),
    sequence: 8,
  };
  const envelope = createZaowuyunEnvelope(event, { ...context(value), listing: undefined });
  assert.equal(envelope.action, 'upsert');
  assert.equal(envelope.display.titleZh, '文本去 AI 味');
});

test('staging mock returns the same receipt for same key and digest, and conflicts on changed digest', () => {
  let reads = 0;
  const transport = new ZaowuyunMockTransport({
    clock: () => {
      reads += 1;
      return '2026-08-13T02:00:00Z';
    },
  });
  const envelope = createZaowuyunEnvelope(registryEvent('release.published'), {
    ...context(), mode: 'staging-mock',
  });
  const first = transport.send(envelope);
  const retry = transport.send(structuredClone(envelope));
  assert.deepEqual(retry, first);
  assert.equal(reads, 1);
  assert.equal(first.status, 'accepted');
  assert.equal(first.remoteRef.startsWith('mock://'), true);

  const changed = { ...envelope, payloadDigest: D('f') };
  assert.throws(() => transport.send(changed), error => error.code === 'IDEMPOTENCY_CONFLICT');
});

test('adapter fails closed on forged Registry payloads, release identities and unsupported events', () => {
  const value = release();
  const original = registryEvent('release.published', value);
  assert.throws(
    () => createZaowuyunEnvelope({ ...original, payload: { release: value } }, context(value)),
    error => error.code === 'REGISTRY_PAYLOAD_DIGEST_MISMATCH',
  );
  assert.throws(
    () => createZaowuyunEnvelope(original, { ...context(value), release: { ...value, releaseId: `rel_${'0'.repeat(64)}` } }),
    error => error.code === 'RELEASE_ID_MISMATCH',
  );
  assert.throws(
    () => createZaowuyunEnvelope({ ...original, type: 'skill.upserted' }, context(value)),
    error => error.code === 'UNSUPPORTED_REGISTRY_EVENT',
  );
});

test('self-consistent public event cannot replace immutable Release evidence under the same releaseId', () => {
  const value = release();
  const original = publicEvent(registryEvent('release.published', value));
  const maliciousRelease = {
    ...original.payload.release,
    assessmentRefs: ['eval_attacker', 'sms_attacker'],
    reviewRefs: ['review_attacker'],
  };
  const payload = { ...original.payload, release: maliciousRelease };
  const malicious = { ...original, payload, payloadDigest: canonicalDigest(payload) };

  assert.throws(
    () => createZaowuyunEnvelope(malicious, context(value)),
    error => error.code === 'REGISTRY_RELEASE_MISMATCH',
  );
});

test('trust projection only accepts evidence references already bound to the immutable Release', () => {
  const value = release();
  const event = registryEvent('release.published', value);
  for (const trust of [
    { ...context(value).trust, sms: { ref: 'sms_attacker', status: 'pass' } },
    { ...context(value).trust, eval: { ref: 'eval_attacker', status: 'pass' } },
    { ...context(value).trust, review: { refs: ['review_attacker'], status: 'certified' } },
  ]) {
    assert.throws(
      () => createZaowuyunEnvelope(event, { ...context(value), trust }),
      error => error.code === 'UNBOUND_EVIDENCE_REF',
    );
  }
});

test('only dry-run and explicit staging mock modes are accepted', () => {
  const event = registryEvent('release.published');
  assert.throws(
    () => createZaowuyunEnvelope(event, { ...context(), mode: 'production' }),
    error => error instanceof ZaowuyunAdapterError && error.code === 'MODE_FORBIDDEN',
  );
  const transport = new ZaowuyunMockTransport();
  const dryRun = createZaowuyunEnvelope(event, context());
  assert.throws(() => transport.send(dryRun), error => error.code === 'MODE_FORBIDDEN');
  const staging = createZaowuyunEnvelope(event, { ...context(), mode: 'staging-mock' });
  const productionUrl = 'https://api.zaowuyun.example';
  assert.throws(
    () => transport.send({ ...staging, productionUrl }),
    error => error.code === 'UNKNOWN_FIELD',
  );
  const nestedUrl = {
    ...staging,
    display: { ...staging.display, productionUrl },
  };
  nestedUrl.projectionId = recomputeZaowuyunProjectionId(nestedUrl);
  nestedUrl.payloadDigest = recomputeZaowuyunPayloadDigest(nestedUrl);
  assert.throws(() => transport.send(nestedUrl), error => error.code === 'UNKNOWN_FIELD');
});

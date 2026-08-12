import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { canonicalDigest, normalizeRelease, releaseId, sourceId } from '../lib/registry-identity.mjs';
import { RegistryStore, createRegistryEvent, replayRegistryEvents } from '../lib/registry-store.mjs';

const D = letter => `sha256:${letter.repeat(64)}`;

function workspace(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skillops-registry-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return new RegistryStore(path.join(root, 'registry.json'));
}

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

function event(type, subject, payload, at = '2026-08-13T01:00:00Z', extras = {}) {
  return createRegistryEvent({
    type, subject, payload, occurredAt: at,
    actorRef: 'role:publisher', reasonCode: 'fixture', policyVersion: 'registry-v1', ...extras,
  });
}

function publish(value = release(), at) {
  return event('release.published', { releaseId: value.releaseId, skillId: value.skillId }, { release: value }, at);
}

test('append-only store makes identical event and release publication idempotent', t => {
  const store = workspace(t);
  const input = publish();
  assert.equal(store.append(input).action, 'appended');
  assert.equal(store.append(input).action, 'unchanged');
  const retryWithAnotherTimestamp = publish(release(), '2026-08-13T01:01:00Z');
  const retried = store.append(retryWithAnotherTimestamp);
  assert.equal(retried.action, 'unchanged');
  assert.equal(retried.cursor, '1');
  assert.equal(retried.event.eventId, input.eventId);
  assert.equal(store.read().events.length, 1);
});

test('same skillId+version cannot be rebound to another package digest', t => {
  const store = workspace(t);
  store.append(publish(release('1.0.0', D('a'))));
  assert.throws(() => store.append(publish(release('1.0.0', D('c')), '2026-08-13T01:02:00Z')), error => {
    assert.equal(error.code, 'VERSION_IMMUTABLE');
    return true;
  });
  assert.equal(store.read().events.length, 1);
});

test('same calculated Release identity cannot hide changes to immutable evidence or publication fields', t => {
  const store = workspace(t);
  const original = release();
  store.append(publish(original));
  const changed = normalizeRelease({ ...original, assessmentRefs: ['eval_changed', 'sms_fixture'] });
  assert.throws(() => store.append(publish(changed, '2026-08-13T01:03:00Z')), error => error.code === 'RELEASE_IMMUTABLE');
  assert.equal(store.read().events.length, 1);
});

test('feed supports stable cursors, pagination and replay without losing tombstones', t => {
  const store = workspace(t);
  const oldRelease = release('1.0.0', D('a'));
  const newRelease = release('1.1.0', D('c'));
  const events = [
    publish(oldRelease),
    publish(newRelease, '2026-08-13T01:01:00Z'),
    event('release.superseded', { releaseId: oldRelease.releaseId }, {
      releaseId: oldRelease.releaseId, successorReleaseId: newRelease.releaseId,
    }, '2026-08-13T01:02:00Z'),
    event('release.revoked', { releaseId: oldRelease.releaseId }, { releaseId: oldRelease.releaseId }, '2026-08-13T01:03:00Z'),
  ];
  events.forEach(item => store.append(item));
  const first = store.feed({ after: '0', limit: 2, public: false });
  assert.equal(first.events.length, 2);
  assert.equal(first.nextCursor, '2');
  assert.equal(first.hasMore, true);
  const second = store.feed({ after: first.nextCursor, limit: 2, public: false });
  assert.deepEqual(second.events.map(item => item.sequence), [3, 4]);
  const projection = replayRegistryEvents([...first.events, ...second.events]);
  assert.equal(projection.releases[oldRelease.releaseId].status, 'revoked');
  assert.equal(projection.releases[oldRelease.releaseId].successorReleaseId, newRelease.releaseId);
  assert.equal(projection.releases[oldRelease.releaseId].tombstone.eventId, events[3].eventId);
});

test('withdraw and revoke tighten status; no event can restore the same Release', t => {
  const store = workspace(t);
  const value = release();
  store.append(publish(value));
  store.append(event('release.withdrawn', { releaseId: value.releaseId }, { releaseId: value.releaseId }, '2026-08-13T02:00:00Z'));
  store.append(event('release.revoked', { releaseId: value.releaseId }, { releaseId: value.releaseId }, '2026-08-13T03:00:00Z'));
  assert.equal(store.project().releases[value.releaseId].status, 'revoked');
  assert.throws(() => store.append(event('release.withdrawn', { releaseId: value.releaseId }, { releaseId: value.releaseId }, '2026-08-13T04:00:00Z')), /relax/i);
});

test('snapshot and full log replay produce the same deterministic projection', t => {
  const store = workspace(t);
  const value = release();
  store.append(event('skill.upserted', { skillId: value.skillId }, {
    skillId: value.skillId, title: { 'zh-CN': '文本去 AI 味', original: 'Humanizer' },
  }));
  store.append(publish(value, '2026-08-13T01:01:00Z'));
  store.append(event('listing.upserted', { skillId: value.skillId, listingId: 'public:zh-CN' }, {
    channel: 'public', locale: 'zh-CN', skillId: value.skillId, releaseId: value.releaseId,
    title: '文本去 AI 味', description: '让文字更自然。', candidateId: 'cand_internal',
  }, '2026-08-13T01:02:00Z'));
  const internal = store.snapshot({ public: false });
  assert.deepEqual(internal.data, replayRegistryEvents(store.read().events));
  assert.equal(internal.snapshotDigest, canonicalDigest({ throughCursor: internal.throughCursor, data: internal.data }));
  const publicSnapshot = store.snapshot();
  const serialized = JSON.stringify(publicSnapshot);
  assert.equal(serialized.includes('cand_'), false);
  assert.equal(serialized.includes('storageRef'), false);
  assert.equal(serialized.includes('role:publisher'), false);
});

test('public feed redacts private provenance and recalculates its payload digest', t => {
  const store = workspace(t);
  const value = release();
  store.append(publish(value));
  const publicEvent = store.feed().events[0];
  const serialized = JSON.stringify(publicEvent);
  assert.equal(serialized.includes('storageRef'), false);
  assert.equal(serialized.includes('role:publisher'), false);
  assert.equal(publicEvent.payloadDigest, canonicalDigest(publicEvent.payload));
});

test('channel-filtered feed advances over unrelated events and rejects a cursor ahead of the log', t => {
  const store = workspace(t);
  const value = release();
  store.append(publish(value));
  store.append(event('listing.upserted', { skillId: value.skillId, listingId: 'private:zh-CN' }, {
    channel: 'private', locale: 'zh-CN', skillId: value.skillId, releaseId: value.releaseId,
  }, '2026-08-13T02:00:00Z'));
  const result = store.feed({ channel: 'public' });
  assert.equal(result.events.length, 1);
  assert.equal(result.nextCursor, '2');
  assert.equal(result.hasMore, false);
  assert.throws(() => store.feed({ after: '3' }), error => error.code === 'CURSOR_AHEAD');
});

test('replay detects gaps, forged event IDs, payload digests and unknown event types', () => {
  const input = publish();
  assert.throws(() => replayRegistryEvents([{ ...input, sequence: 2 }]), error => error.code === 'SEQUENCE_GAP');
  assert.throws(() => replayRegistryEvents([{ ...input, eventId: `evt_${'0'.repeat(64)}`, sequence: 1 }]), /eventId/i);
  assert.throws(() => replayRegistryEvents([{ ...input, payloadDigest: D('f'), sequence: 1 }]), /payloadDigest/i);
  assert.throws(() => createRegistryEvent({ ...input, type: 'release.guessed' }), /unsupported/i);
  assert.throws(() => createRegistryEvent({ ...input, secret: 'smuggled' }), /unknown fields/i);
});

test('caller-supplied eventId cannot be reused with a changed payload', t => {
  const store = workspace(t);
  const input = publish();
  store.append(input);
  assert.throws(() => store.append({ ...input, payload: { releaseId: releaseId('qiuyiwu/humanizer', '2.0.0', D('c')) } }), /payloadDigest|eventId/i);
});

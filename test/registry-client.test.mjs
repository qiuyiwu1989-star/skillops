import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  RegistryCache,
  RegistryClientError,
  createLocalRegistrySource,
  createRegistrySourceId,
  syncRegistry,
} from '../dist-src/skillops/scripts/lib/registry-client.mjs';
import { RegistryStore } from '../trusted-supply/lib/registry-store.mjs';
import { canonicalDigest, normalizeRelease, sourceId } from '../trusted-supply/lib/registry-identity.mjs';

const NOW = '2026-08-13T00:00:00.000Z';
const sha = char => `sha256:${char.repeat(64)}`;

function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'skillops-registry-client-'));
  const store = new RegistryStore(path.join(directory, 'registry.json'));
  const source = createLocalRegistrySource(store, { coordinate: 'https://registry.example/public' });
  const cache = new RegistryCache(path.join(directory, 'cache.json'), { sourceId: source.sourceId });
  return { directory, store, source, cache };
}

function release(char = 'a') {
  return normalizeRelease({
    skillId: 'zaowuyun/researcher', version: `1.0.${char === 'a' ? 0 : 1}`,
    package: { packageDigest: sha(char), manifestDigest: sha('f'), storageRef: `cas:${sha(char)}` },
    compatibility: { contract: 'skillops.v1', targets: ['codex'] },
    assessmentRefs: ['sms_80'], reviewRefs: ['review_certified'],
    sourceRefs: [sourceId('github', `zaowuyun/researcher@${char}`)], publishedAt: NOW,
  });
}

function append(store, type, subject, payload, sequence = 0) {
  return store.append({
    type, subject, payload, occurredAt: new Date(Date.parse(NOW) + sequence * 1000).toISOString(),
    actorRef: 'registry.publisher', reasonCode: 'approved', policyVersion: 'registry-v1',
  });
}

test('source identity is deterministic and strict', () => {
  assert.equal(createRegistrySourceId(' https://registry.example/public '), createRegistrySourceId('https://registry.example/public'));
  assert.match(createRegistrySourceId('https://registry.example/public'), /^regsrc_[a-f0-9]{64}$/);
  assert.throws(() => new RegistryCache('/tmp/cache', { sourceId: 'src_wrong' }), error => error.code === 'INVALID_SOURCE_ID');
});

test('first sync verifies snapshot then persists a public atomic cache', () => {
  const { directory, store, source, cache } = fixture();
  const item = release();
  append(store, 'release.published', { releaseId: item.releaseId }, { release: item });
  const result = syncRegistry({ cache, source });
  assert.equal(result.action, 'initialized');
  assert.equal(result.cache.cursor, '1');
  assert.equal(cache.resolveRelease(item.releaseId).release.releaseId, item.releaseId);
  const serialized = fs.readFileSync(cache.filePath, 'utf8');
  assert.doesNotMatch(serialized, /storageRef|candidate|principal|token/i);
  assert.deepEqual(fs.readdirSync(directory).filter(name => name.includes('.tmp')), []);
});

test('later sync consumes only contiguous feed pages', () => {
  const { store, source, cache } = fixture();
  const first = release('a');
  append(store, 'release.published', { releaseId: first.releaseId }, { release: first });
  syncRegistry({ cache, source, pageLimit: 1 });
  const second = release('b');
  append(store, 'release.published', { releaseId: second.releaseId }, { release: second }, 1);
  const updated = syncRegistry({ cache, source, pageLimit: 1 });
  assert.equal(updated.action, 'updated');
  assert.equal(updated.cache.cursor, '2');
  assert.equal(cache.resolveRelease(second.releaseId).release.version, '1.0.1');
});

test('bad snapshot digest fails before cache creation', () => {
  const { source, cache } = fixture();
  const bad = { ...source, snapshot: () => ({ ...source.snapshot(), snapshotDigest: sha('0') }) };
  assert.throws(() => syncRegistry({ cache, source: bad }), error => error instanceof RegistryClientError && error.code === 'SNAPSHOT_DIGEST_MISMATCH');
  assert.equal(fs.existsSync(cache.filePath), false);
});

test('self-consistent snapshot hash cannot hide a mismatched Release identity', () => {
  const { store, source, cache } = fixture();
  const item = release();
  append(store, 'release.published', { releaseId: item.releaseId }, { release: item });
  const original = source.snapshot();
  const data = structuredClone(original.data);
  data.releases[item.releaseId].release.version = '9.9.9';
  const forged = {
    ...source,
    snapshot: () => ({ ...original, data, snapshotDigest: canonicalDigest({ throughCursor: original.throughCursor, data }) }),
  };
  assert.throws(() => syncRegistry({ cache, source: forged }), error => error.code === 'RELEASE_ID_MISMATCH');
  assert.equal(fs.existsSync(cache.filePath), false);
});

test('feed digest, sequence gaps and cursor rollback preserve old verified cache', () => {
  for (const mutate of [
    page => ({ ...page, events: page.events.map(event => ({ ...event, payloadDigest: sha('0') })) }),
    page => ({ ...page, events: page.events.map(event => ({ ...event, sequence: event.sequence + 1 })) }),
    page => ({ ...page, nextCursor: '0' }),
  ]) {
    const { store, source, cache } = fixture();
    const first = release('a');
    append(store, 'release.published', { releaseId: first.releaseId }, { release: first });
    syncRegistry({ cache, source });
    const before = fs.readFileSync(cache.filePath, 'utf8');
    const second = release('b');
    append(store, 'release.published', { releaseId: second.releaseId }, { release: second }, 1);
    const bad = { ...source, feed: options => mutate(source.feed(options)) };
    assert.throws(() => syncRegistry({ cache, source: bad }));
    assert.equal(fs.readFileSync(cache.filePath, 'utf8'), before);
  }
});

test('self-consistent malicious feed cannot forge Release identity or omit package evidence', () => {
  for (const mutate of [
    releaseValue => ({ ...releaseValue, version: '8.8.8' }),
    releaseValue => {
      const { package: ignored, ...withoutPackage } = releaseValue;
      return withoutPackage;
    },
  ]) {
    const { store, source, cache } = fixture();
    const first = release('a');
    append(store, 'release.published', { releaseId: first.releaseId }, { release: first });
    syncRegistry({ cache, source });
    const before = fs.readFileSync(cache.filePath, 'utf8');
    const second = release('b');
    const forgedRelease = mutate(second);
    const payload = { release: forgedRelease };
    const forgedEvent = {
      schemaVersion: 1, sequence: 2, eventId: `evt_${'b'.repeat(64)}`,
      type: 'release.published', occurredAt: NOW, actorRole: 'registry-publisher',
      reasonCode: 'approved', subject: { releaseId: second.releaseId }, payload,
      payloadDigest: canonicalDigest(payload), policyVersion: 'registry-v1',
    };
    const bad = { ...source, feed: () => ({ events: [forgedEvent], nextCursor: '2', hasMore: false }) };
    assert.throws(() => syncRegistry({ cache, source: bad }));
    assert.equal(fs.readFileSync(cache.filePath, 'utf8'), before);
  }
});

test('same skill version cannot be rebound to a different package through a valid-looking feed', () => {
  const { store, source, cache } = fixture();
  const first = release('a');
  append(store, 'release.published', { releaseId: first.releaseId }, { release: first });
  syncRegistry({ cache, source });
  const before = fs.readFileSync(cache.filePath, 'utf8');
  const otherPackage = normalizeRelease({
    ...first,
    releaseId: undefined,
    package: { packageDigest: sha('b'), manifestDigest: sha('f'), storageRef: `cas:${sha('b')}` },
  });
  const publicRelease = structuredClone(otherPackage);
  delete publicRelease.package.storageRef;
  const payload = { release: publicRelease };
  const event = {
    schemaVersion: 1, sequence: 2, eventId: `evt_${'c'.repeat(64)}`,
    type: 'release.published', occurredAt: NOW, actorRole: 'registry-publisher',
    reasonCode: 'approved', subject: { releaseId: publicRelease.releaseId }, payload,
    payloadDigest: canonicalDigest(payload), policyVersion: 'registry-v1',
  };
  const bad = { ...source, feed: () => ({ events: [event], nextCursor: '2', hasMore: false }) };
  assert.throws(() => syncRegistry({ cache, source: bad }), error => error.code === 'VERSION_IMMUTABLE');
  assert.equal(fs.readFileSync(cache.filePath, 'utf8'), before);
});

test('unknown schemas and event types fail closed without cache pollution', () => {
  const { store, source, cache } = fixture();
  const item = release();
  append(store, 'release.published', { releaseId: item.releaseId }, { release: item });
  syncRegistry({ cache, source });
  const before = fs.readFileSync(cache.filePath, 'utf8');
  const bad = {
    ...source,
    feed: () => ({ events: [{ schemaVersion: 2, sequence: 2, eventId: `evt_${'a'.repeat(64)}`, type: 'release.deleted', payload: {}, payloadDigest: canonicalDigest({}) }], nextCursor: '2', hasMore: false }),
  };
  assert.throws(() => syncRegistry({ cache, source: bad }), error => error.code === 'UNSUPPORTED_SCHEMA');
  assert.equal(fs.readFileSync(cache.filePath, 'utf8'), before);
});

test('offline resolution requires an explicit usable release identity', () => {
  const { store, source, cache } = fixture();
  const item = release();
  append(store, 'release.published', { releaseId: item.releaseId }, { release: item });
  syncRegistry({ cache, source });
  for (const value of ['latest', 'cand_bad']) {
    assert.throws(() => cache.resolveRelease(value), error => error.code === 'MUTABLE_RELEASE_FORBIDDEN');
  }
  append(store, 'release.withdrawn', { releaseId: item.releaseId }, { releaseId: item.releaseId }, 1);
  syncRegistry({ cache, source });
  assert.throws(() => cache.resolveRelease(item.releaseId), error => error.code === 'RELEASE_WITHDRAWN');
  append(store, 'release.revoked', { releaseId: item.releaseId }, { releaseId: item.releaseId }, 2);
  syncRegistry({ cache, source });
  assert.throws(() => cache.resolveRelease(item.releaseId), error => error.code === 'RELEASE_REVOKED');
});

test('tampered offline cache is never trusted', () => {
  const { store, source, cache } = fixture();
  const item = release();
  append(store, 'release.published', { releaseId: item.releaseId }, { release: item });
  syncRegistry({ cache, source });
  const value = JSON.parse(fs.readFileSync(cache.filePath, 'utf8'));
  value.data.releases[item.releaseId].status = 'revoked';
  fs.writeFileSync(cache.filePath, JSON.stringify(value));
  assert.throws(() => cache.resolveRelease(item.releaseId), error => error.code === 'CACHE_DIGEST_MISMATCH');
});

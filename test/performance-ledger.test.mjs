import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  PerformanceLedger,
  createPerformanceEvent,
  summarizePerformance,
} from '../dist-src/skillops/scripts/lib/performance-ledger.mjs';

const RELEASE = `rel_${'a'.repeat(64)}`;
const DIGEST = `sha256:${'b'.repeat(64)}`;

function event(index, overrides = {}) {
  return {
    installationId: 'inst_perf_fixture_001', skillId: 'qiuyiwu/perf-fixture', releaseId: RELEASE,
    outcome: index % 4 === 0 ? 'failure' : 'success', durationMs: index * 700,
    ...(index % 4 === 0 ? { errorCode: 'ASSERTION_FAILED' } : {}),
    occurredAt: `2026-08-${String(1 + index).padStart(2, '0')}T00:00:00Z`,
    environmentDigest: DIGEST, evalPolicyDigest: DIGEST, ...overrides,
  };
}

test('events retain only privacy-safe buckets and reject raw task or content fields', () => {
  const value = createPerformanceEvent(event(1));
  assert.equal(value.durationBucket, 'lt_1s');
  assert.equal(value.timeBucket, '2026-08-02');
  assert.equal(Object.hasOwn(value, 'durationMs'), false);
  for (const input of [
    { ...event(1), prompt: 'private prompt' },
    { ...event(1), output: 'private output' },
    { ...event(1), taskName: 'private task' },
    { ...event(1), localPath: '/Users/private/skill' },
  ]) assert.throws(() => createPerformanceEvent(input), error => error.code === 'PRIVATE_FIELD_FORBIDDEN');
});

test('ledger append is idempotent, atomic and detects direct history tampering', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skillops-performance-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const ledger = new PerformanceLedger(path.join(root, 'performance.json'));
  assert.equal(ledger.append(event(1)).action, 'recorded');
  assert.equal(ledger.append(event(1)).action, 'unchanged');
  assert.equal(ledger.read().events.length, 1);
  const value = JSON.parse(fs.readFileSync(ledger.filePath, 'utf8'));
  value.events[0].outcome = 'failure';
  fs.writeFileSync(ledger.filePath, JSON.stringify(value));
  assert.throws(() => ledger.read(), error => ['LEDGER_TAMPERED', 'INVALID_ERROR_CODE', 'INVALID_IDENTITY'].includes(error.code));

  const clean = createPerformanceEvent(event(2));
  const forgedBody = { ...clean, prompt: 'private prompt' };
  delete forgedBody.eventId;
  const canonical = input => input && typeof input === 'object' && !Array.isArray(input)
    ? Object.fromEntries(Object.keys(input).sort().map(key => [key, canonical(input[key])]))
    : input;
  const forgedId = `perf_${crypto.createHash('sha256').update(JSON.stringify(canonical(forgedBody))).digest('hex')}`;
  fs.writeFileSync(ledger.filePath, JSON.stringify({ schemaVersion: 1, events: [{ ...forgedBody, eventId: forgedId }] }));
  assert.throws(() => ledger.read(), error => error.code === 'PRIVATE_FIELD_FORBIDDEN');
});

test('sample threshold prevents premature degradation claims and stable context can show degradation', () => {
  const few = [event(1), event(2), event(4) ].map(createPerformanceEvent);
  const insufficient = summarizePerformance(few, {
    skillId: 'qiuyiwu/perf-fixture', releaseId: RELEASE, now: '2026-08-20T00:00:00Z', minimumSamples: 5,
  });
  assert.equal(insufficient.status, 'evidence_insufficient');
  assert.equal(insufficient.reasonCode, 'MINIMUM_SAMPLE_NOT_MET');

  const enough = Array.from({ length: 12 }, (_, index) => createPerformanceEvent(event(index)));
  const degraded = summarizePerformance(enough, {
    skillId: 'qiuyiwu/perf-fixture', releaseId: RELEASE, now: '2026-08-20T00:00:00Z', minimumSamples: 10,
  });
  assert.equal(degraded.status, 'degraded');
  assert.equal(degraded.failureRate, 0.25);
  assert.deepEqual(degraded.errorCodes, { ASSERTION_FAILED: 3 });
  assert.equal(JSON.stringify(degraded).includes('inst_perf'), false);
});

test('environment or Eval policy changes produce confounded rather than degraded', () => {
  const events = Array.from({ length: 10 }, (_, index) => createPerformanceEvent(event(index, {
    outcome: 'failure', errorCode: 'ASSERTION_FAILED',
    environmentDigest: index < 5 ? DIGEST : `sha256:${'c'.repeat(64)}`,
  })));
  const result = summarizePerformance(events, {
    skillId: 'qiuyiwu/perf-fixture', releaseId: RELEASE, now: '2026-08-20T00:00:00Z', minimumSamples: 10,
  });
  assert.equal(result.status, 'confounded');
  assert.equal(result.reasonCode, 'CONTEXT_CHANGED');
});

test('module contains no network, runtime execution, environment secret or raw telemetry path', () => {
  const source = fs.readFileSync(new URL('../dist-src/skillops/scripts/lib/performance-ledger.mjs', import.meta.url), 'utf8');
  for (const forbidden of ['child_process', 'fetch(', 'http:', 'https:', 'process.env', 'eval(', 'Function(', 'import(']) {
    assert.equal(source.includes(forbidden), false, `performance ledger must not contain ${forbidden}`);
  }
});

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  SMS_DIMENSIONS,
  SMS_RUBRIC_VERSION,
  createSmsAssessment,
  isSmsCurrent,
  smsTier,
  validateSmsAssessment,
} from '../lib/sms.mjs';

const FINGERPRINT = `sha256:${'a'.repeat(64)}`;
const OTHER_FINGERPRINT = `sha256:${'b'.repeat(64)}`;
const FIXED_TIME = '2026-08-13T01:02:03.000Z';

function dimensions(score = 8) {
  return Object.fromEntries(SMS_DIMENSIONS.map(dimension => [dimension.key, {
    score,
    reason: `${dimension.label}有明确判断依据`,
    evidence: [`SKILL.md#${dimension.key}`],
  }]));
}

function assessment(overrides = {}) {
  return createSmsAssessment({
    dimensions: dimensions(),
    scorer: 'human:reviewer@example.test',
    ...overrides,
  }, { fingerprint: FINGERPRINT, clock: () => new Date(FIXED_TIME) });
}

test('SMS v2.0 exposes the canonical immutable ten-dimension rubric', () => {
  assert.equal(SMS_RUBRIC_VERSION, 'SMS-2.0');
  assert.deepEqual(SMS_DIMENSIONS.map(dimension => dimension.key), [
    'clarity', 'invocability', 'executability', 'stability', 'quality',
    'reusability', 'composability', 'evaluability', 'safety', 'business',
  ]);
  assert.equal(Object.isFrozen(SMS_DIMENSIONS), true);
  assert.ok(SMS_DIMENSIONS.every(Object.isFrozen));
});

test('createSmsAssessment normalizes explicit evidence and derives total, tier, time, and fingerprint', () => {
  const result = assessment();
  assert.equal(result.schemaVersion, 1);
  assert.equal(result.status, 'complete');
  assert.equal(result.rubricVersion, 'SMS-2.0');
  assert.equal(result.dimensions.length, 10);
  assert.ok(result.dimensions.every(dimension => dimension.score === 8));
  assert.ok(result.dimensions.every(dimension => dimension.reason && dimension.evidence.length === 1));
  assert.equal(result.total, 80);
  assert.equal(result.tier, 'A');
  assert.equal(result.scorer, 'human:reviewer@example.test');
  assert.equal(result.scoredAt, FIXED_TIME);
  assert.equal(result.basedOnFingerprint, FINGERPRINT);
});

test('smsTier applies the exact public quality thresholds and rejects invalid totals', () => {
  assert.deepEqual([
    smsTier(0), smsTier(49), smsTier(50), smsTier(63), smsTier(64),
    smsTier(75), smsTier(76), smsTier(85), smsTier(86), smsTier(100),
  ], ['D', 'D', 'C', 'C', 'B', 'B', 'A', 'A', 'S', 'S']);
  assert.throws(() => smsTier(-1), /between 0 and 100/i);
  assert.throws(() => smsTier(101), /between 0 and 100/i);
  assert.throws(() => smsTier(64.5), /integer/i);
});

test('validateSmsAssessment accepts a complete assessment and canonicalizes dimension order', () => {
  const result = assessment();
  const reversed = { ...result, dimensions: [...result.dimensions].reverse() };
  const validated = validateSmsAssessment(reversed, { fingerprint: FINGERPRINT });
  assert.deepEqual(validated.dimensions.map(dimension => dimension.key), SMS_DIMENSIONS.map(dimension => dimension.key));
  assert.equal(validated.total, 80);
});

test('validation fails closed on missing, duplicate, unknown, or incomplete dimension evidence', () => {
  const valid = assessment();
  assert.throws(() => validateSmsAssessment({
    ...valid, dimensions: valid.dimensions.slice(0, -1), total: 72,
  }), /missing dimensions.*business/i);
  assert.throws(() => validateSmsAssessment({
    ...valid, dimensions: [...valid.dimensions.slice(0, -1), valid.dimensions[0]],
  }), /duplicate dimension.*clarity/i);
  assert.throws(() => validateSmsAssessment({
    ...valid, dimensions: [...valid.dimensions.slice(0, -1), { ...valid.dimensions.at(-1), key: 'popularity' }],
  }), /unknown dimension.*popularity/i);
  assert.throws(() => validateSmsAssessment({
    ...valid,
    dimensions: valid.dimensions.map(dimension => dimension.key === 'safety'
      ? { ...dimension, evidence: [] } : dimension),
  }), /safety evidence/i);
});

test('validation rejects out-of-range or non-integer scores, inconsistent totals, and forged tiers', () => {
  const valid = assessment();
  for (const score of [-1, 11, 7.5, '8']) {
    assert.throws(() => validateSmsAssessment({
      ...valid,
      dimensions: valid.dimensions.map(dimension => dimension.key === 'clarity'
        ? { ...dimension, score } : dimension),
    }), /score must be an integer between 0 and 10/i);
  }
  assert.throws(() => validateSmsAssessment({ ...valid, total: 79 }), /dimension sum 80/i);
  assert.throws(() => validateSmsAssessment({ ...valid, tier: 'S' }), /tier must be A/i);
  assert.throws(() => createSmsAssessment({
    dimensions: dimensions(), scorer: 'reviewer', total: 99,
  }, { fingerprint: FINGERPRINT }), /dimension sum 80/i);
});

test('fingerprint binding rejects malformed, mismatched, and stale SMS assessments', () => {
  const valid = assessment();
  assert.throws(() => validateSmsAssessment({
    ...valid, basedOnFingerprint: 'not-a-fingerprint',
  }), /sha256 fingerprint/i);
  assert.throws(() => validateSmsAssessment(valid, { fingerprint: OTHER_FINGERPRINT }), /does not match/i);
  assert.throws(() => createSmsAssessment({
    dimensions: dimensions(), scorer: 'reviewer', basedOnFingerprint: OTHER_FINGERPRINT,
  }, { fingerprint: FINGERPRINT }), /does not match/i);

  assert.equal(isSmsCurrent({ artifact: { fingerprint: FINGERPRINT }, sms: valid }), true);
  assert.equal(isSmsCurrent({ artifact: { fingerprint: OTHER_FINGERPRINT }, sms: valid }), false);
  assert.equal(isSmsCurrent({ artifact: { fingerprint: FINGERPRINT }, sms: { status: 'pending' } }), false);
  assert.equal(isSmsCurrent(null), false);
});

test('scorer, scoredAt, reasons, and evidence are mandatory provenance rather than generated claims', () => {
  assert.throws(() => createSmsAssessment({ dimensions: dimensions(), scorer: '' }, {
    fingerprint: FINGERPRINT,
  }), /scorer/i);
  assert.throws(() => validateSmsAssessment({ ...assessment(), scoredAt: 'not-a-date' }), /scoredAt/i);
  assert.throws(() => createSmsAssessment({
    dimensions: {
      ...dimensions(),
      quality: { score: 8, reason: '', evidence: ['SKILL.md#quality'] },
    },
    scorer: 'reviewer',
  }, { fingerprint: FINGERPRINT }), /quality reason/i);
  assert.throws(() => createSmsAssessment({
    dimensions: {
      ...dimensions(),
      business: { score: 8, reason: '有价值', evidence: [''] },
    },
    scorer: 'reviewer',
  }, { fingerprint: FINGERPRINT }), /business evidence\[0\]/i);
});

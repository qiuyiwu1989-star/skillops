import assert from 'node:assert/strict';
import test from 'node:test';

import { projectReviewQueue, projectReviewStatus } from '../lib/review-queue.mjs';

const NOW = '2026-08-13T00:00:00.000Z';
const DIGEST = `sha256:${'a'.repeat(64)}`;

function candidate(id, certification, overrides = {}) {
  return {
    id,
    status: certification.status === 'certified' ? 'approved' : certification.status,
    artifact: {
      content: `PRIVATE BODY ${id}`,
      fingerprint: DIGEST,
      package: { packageDigest: DIGEST, files: [{ path: '/Users/private/secret.txt', content: 'secret' }] },
    },
    audit: {
      format: { name: id, description: 'private description', frontmatter: { displayName: `技能 ${id}` } },
      license: { status: 'allowed' },
    },
    packageAudit: { status: 'pass', auditor: 'auditor@example.test' },
    sms: { status: 'complete', total: 88, tier: 'A', scorer: 'reviewer@example.test' },
    eval: { status: 'complete', successRate: 1, cases: [{ prompt: 'PRIVATE PROMPT', outputSummary: 'PRIVATE OUTPUT' }] },
    reviewEvents: [],
    certification: {
      reasons: [], approvals: [], requiredApprovals: 2, evidenceDigest: DIGEST, policyDigest: DIGEST,
      validUntil: null, ...certification,
    },
    ...overrides,
  };
}

test('projects pending second review with Chinese guidance and evidence-only summaries', () => {
  const input = candidate('pending-one', {
    status: 'pending', reasons: ['four_eyes_incomplete'], approvals: [{ reviewer: { principalId: 'person:alice', email: 'alice@example.test' } }],
  });
  const projected = projectReviewStatus(input, { now: NOW });

  assert.equal(projected.queueStatus, 'pending_second_review');
  assert.equal(projected.statusLabelZh, '待第二人复核');
  assert.match(projected.reasonZh, /双人独立复核/);
  assert.match(projected.actionZh, /第二位独立可信人工/);
  assert.deepEqual(projected.approvalProgress, { approved: 1, required: 2, remaining: 1 });
  assert.equal(projected.evidence.package.digest, DIGEST);
  assert.equal(projected.evidence.sms.total, 88);

  const serialized = JSON.stringify(projected);
  for (const secret of ['person:alice', 'alice@example.test', 'PRIVATE BODY', 'PRIVATE PROMPT', 'PRIVATE OUTPUT', '/Users/private']) {
    assert.equal(serialized.includes(secret), false, `projection leaked ${secret}`);
  }
});

test('legacy string approval is explicit history and never becomes certified', () => {
  const input = candidate('legacy-skill', {
    status: 'pending', reasons: ['review_policy_required'], approvals: [],
  }, {
    status: 'approved',
    reviewEvents: [{ decision: 'approve', reviewer: 'legacy-reviewer@example.test', reason: 'legacy approval' }],
  });
  const projected = projectReviewStatus(input, { now: NOW });

  assert.equal(projected.queueStatus, 'pending_review');
  assert.equal(projected.certificationStatus, 'pending');
  assert.deepEqual(projected.legacy, {
    present: true, eventCount: 1, approvalCount: 1, effect: '仅作历史记录，不形成终审认证',
  });
  assert.ok(projected.reasonCodes.includes('legacy_review_non_certifying'));
  assert.match(projected.reasonZh, /不能形成终审认证/);
  assert.equal(JSON.stringify(projected).includes('legacy-reviewer@example.test'), false);
});

test('classifies expiring, certified, stale, rejected, withdrawn and recalled records', () => {
  const inputs = [
    candidate('expiring', { status: 'certified', validUntil: '2026-08-20T00:00:00.000Z' }),
    candidate('certified', { status: 'certified', validUntil: '2026-12-01T00:00:00.000Z' }),
    candidate('stale', { status: 'expired', reasons: ['approval_expired'] }),
    candidate('rejected', { status: 'rejected', reasons: ['human_rejected'] }),
    candidate('withdrawn', { status: 'withdrawn', reasons: ['review_withdraw'] }),
    candidate('recalled', { status: 'recalled', reasons: ['review_recall'] }),
  ];
  const queue = projectReviewQueue(inputs, { now: NOW, expiringWithinDays: 14 });

  assert.deepEqual(Object.fromEntries(queue.items.map(item => [item.candidateId, item.queueStatus])), {
    recalled: 'recalled', rejected: 'rejected', stale: 'stale', expiring: 'expiring',
    certified: 'certified', withdrawn: 'withdrawn',
  });
  assert.equal(queue.summary.total, 6);
  assert.equal(queue.summary.expiring, 1);
  assert.equal(queue.summary.certified, 1);
  assert.equal(queue.items.find(item => item.candidateId === 'expiring').daysUntilExpiry, 7);
});

test('queue ordering is deterministic and optional filtering returns a fixed-shape summary', () => {
  const inputs = [
    candidate('zeta', { status: 'pending', reasons: ['four_eyes_incomplete'], approvals: [] }),
    candidate('beta', { status: 'pending', reasons: ['four_eyes_incomplete'], approvals: [{}] }),
    candidate('alpha', { status: 'pending', reasons: ['four_eyes_incomplete'], approvals: [{}] }),
  ];
  const first = projectReviewQueue(inputs, { now: NOW });
  const second = projectReviewQueue([...inputs].reverse(), { now: NOW });
  assert.deepEqual(first, second);
  assert.deepEqual(first.items.map(item => item.candidateId), ['alpha', 'beta', 'zeta']);

  const filtered = projectReviewQueue(inputs, { now: NOW, statuses: 'pending_second_review' });
  assert.deepEqual(filtered.items.map(item => item.candidateId), ['alpha', 'beta']);
  assert.equal(filtered.summary.total, 2);
  assert.equal(filtered.summary.pending_second_review, 2);
  assert.equal(filtered.summary.recalled, 0);
});

test('accepts a single candidate and rejects invalid projection options', () => {
  const single = projectReviewQueue(candidate('single', {
    status: 'certified', validUntil: '2026-12-01T00:00:00.000Z',
  }), { now: NOW });
  assert.equal(single.items.length, 1);
  assert.equal(Object.isFrozen(single), true);
  assert.throws(() => projectReviewStatus(null, { now: NOW }), /candidate must be an object/);
  assert.throws(() => projectReviewQueue([], { now: 'not-a-date' }), /valid date/);
  assert.throws(() => projectReviewQueue([], { now: NOW, expiringWithinDays: 366 }), /0 to 365/);
  assert.throws(() => projectReviewQueue([], { now: NOW, statuses: ['unknown'] }), /unsupported/);
});

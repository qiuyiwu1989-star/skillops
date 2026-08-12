import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CoachProposalError,
  acceptCoachProposal,
  createCoachProposal,
  validateCoachProposal,
} from '../dist-src/skillops/scripts/lib/coach-proposal.mjs';

const sha = char => `sha256:${char.repeat(64)}`;
const rel = char => `rel_${char.repeat(64)}`;
const CREATED_AT = '2026-08-13T03:00:00.000Z';

function proposalInput(overrides = {}) {
  return {
    skillId: 'qiuyiwu/humanizer',
    baseReleaseId: rel('a'),
    basePackageDigest: sha('b'),
    evidence: [
      { kind: 'sms_assessment', digest: sha('c') },
      { kind: 'eval_failure', digest: sha('d') },
    ],
    weakDimensions: [
      { key: 'safety', score: 4 },
      { key: 'evaluability', score: 5 },
    ],
    changes: [
      { operation: 'replace', path: 'SKILL.md', beforeSha256: sha('e'), afterSha256: sha('f') },
      { operation: 'add', path: 'references/evaluation.md', afterSha256: sha('1') },
      { operation: 'remove', path: 'references/legacy.md', beforeSha256: sha('2') },
    ],
    generator: { kind: 'rule', name: 'skillops-coach', version: '1.0.0' },
    createdAt: CREATED_AT,
    ...overrides,
  };
}

test('Coach proposal binds base package, evidence and digest-only changes deterministically', () => {
  const first = createCoachProposal(proposalInput());
  const reordered = createCoachProposal(proposalInput({
    evidence: [...proposalInput().evidence].reverse(),
    weakDimensions: [...proposalInput().weakDimensions].reverse(),
    changes: [...proposalInput().changes].reverse(),
  }));

  assert.deepEqual(first, reordered);
  assert.equal(first.schemaVersion, 1);
  assert.match(first.proposalId, /^coachprop_[a-f0-9]{64}$/);
  assert.match(first.patchDigest, /^sha256:[a-f0-9]{64}$/);
  assert.match(first.evidenceDigest, /^sha256:[a-f0-9]{64}$/);
  assert.match(first.proposalDigest, /^sha256:[a-f0-9]{64}$/);
  assert.equal(first.base.releaseId, rel('a'));
  assert.equal(first.base.packageDigest, sha('b'));
  assert.ok(first.changes.some(change => change.path === 'SKILL.md'));
  assert.equal(validateCoachProposal(first).proposalDigest, first.proposalDigest);
});

test('validation recomputes all digests and fails closed on tampering', () => {
  const proposal = createCoachProposal(proposalInput());
  const tampered = structuredClone(proposal);
  tampered.changes[0].afterSha256 = sha('9');
  assert.throws(
    () => validateCoachProposal(tampered),
    error => error instanceof CoachProposalError && error.code === 'PATCH_DIGEST_MISMATCH',
  );

  const wrongEvidence = structuredClone(proposal);
  wrongEvidence.evidenceDigest = sha('0');
  assert.throws(() => validateCoachProposal(wrongEvidence), error => error.code === 'EVIDENCE_DIGEST_MISMATCH');

  const wrongProposal = structuredClone(proposal);
  wrongProposal.proposalDigest = sha('0');
  assert.throws(() => validateCoachProposal(wrongProposal), error => error.code === 'PROPOSAL_DIGEST_MISMATCH');
});

test('proposal rejects content, prompts, outputs, tokens and arbitrary script payloads', () => {
  for (const [override, code] of [
    [{ content: 'rewritten skill body' }, 'PRIVATE_FIELD_FORBIDDEN'],
    [{ prompt: 'improve this skill' }, 'PRIVATE_FIELD_FORBIDDEN'],
    [{ output: 'model response' }, 'PRIVATE_FIELD_FORBIDDEN'],
    [{ token: 'secret' }, 'PRIVATE_FIELD_FORBIDDEN'],
    [{ generator: { kind: 'rule', name: 'skillops-coach', version: '1.0.0', command: 'node rewrite.mjs' } }, 'PRIVATE_FIELD_FORBIDDEN'],
    [{ changes: [{ operation: 'replace', path: 'scripts/rewrite.mjs', beforeSha256: sha('e'), afterSha256: sha('f') }] }, 'SCRIPT_CHANGE_FORBIDDEN'],
  ]) {
    assert.throws(
      () => createCoachProposal(proposalInput(override)),
      error => error instanceof CoachProposalError && error.code === code,
    );
  }
});

test('proposal rejects absolute, traversal and invalid digest-only changes', () => {
  for (const [change, code] of [
    [{ operation: 'replace', path: '/Users/private/SKILL.md', beforeSha256: sha('e'), afterSha256: sha('f') }, 'UNSAFE_CHANGE_PATH'],
    [{ operation: 'replace', path: '../SKILL.md', beforeSha256: sha('e'), afterSha256: sha('f') }, 'UNSAFE_CHANGE_PATH'],
    [{ operation: 'add', path: 'references/new.md', beforeSha256: sha('e'), afterSha256: sha('f') }, 'INVALID_CHANGE'],
    [{ operation: 'remove', path: 'references/old.md', beforeSha256: sha('e'), afterSha256: sha('f') }, 'INVALID_CHANGE'],
    [{ operation: 'replace', path: 'SKILL.md', beforeSha256: sha('e'), afterSha256: sha('e') }, 'NOOP_CHANGE'],
  ]) {
    assert.throws(
      () => createCoachProposal(proposalInput({ changes: [change] })),
      error => error instanceof CoachProposalError && error.code === code,
    );
  }
});

test('Candidate identity cannot enter a Coach proposal or a forged validation envelope', () => {
  assert.throws(
    () => createCoachProposal(proposalInput({ skillId: 'qiuyiwu/cand_fixture' })),
    error => error.code === 'CANDIDATE_ID_FORBIDDEN',
  );
  const forged = structuredClone(createCoachProposal(proposalInput()));
  forged.skillId = 'qiuyiwu/cand_fixture';
  assert.throws(() => validateCoachProposal(forged), error => error.code === 'CANDIDATE_ID_FORBIDDEN');
});

test('acceptance is digest-bound, replay deterministic and only requests a new source revision', () => {
  const proposal = createCoachProposal(proposalInput());
  const acceptance = {
    acceptedBy: 'principal_owner_001',
    acceptedAt: '2026-08-13T04:00:00.000Z',
    sourceRevision: 'rev_local_002',
    expectedProposalDigest: proposal.proposalDigest,
  };
  const first = acceptCoachProposal(proposal, acceptance);
  const replayed = acceptCoachProposal(proposal, acceptance);

  assert.deepEqual(first, replayed);
  assert.equal(first.action, 'source_revision.requested');
  assert.equal(first.status, 'pending');
  assert.match(first.requestId, /^srreq_[a-f0-9]{64}$/);
  assert.equal(first.proposalDigest, proposal.proposalDigest);
  assert.match(first.acceptedByDigest, /^sha256:[a-f0-9]{64}$/);
  assert.equal(Object.hasOwn(first, 'acceptedBy'), false);
  assert.deepEqual(first.requiredPipeline.map(stage => stage.stage), [
    'package', 'audit', 'sms', 'eval', 'review', 'registry',
  ]);
  assert.ok(first.requiredPipeline.every(stage => stage.status === 'required'));
  assert.equal(first.mutatesSource, false);
  assert.equal(first.executesSkill, false);
  assert.equal(Object.hasOwn(first, 'changes'), false);
  assert.doesNotMatch(JSON.stringify(first), /SKILL\.md|references\/|principal_owner_001/);
});

test('acceptance rejects a stale confirmation digest and private identities', () => {
  const proposal = createCoachProposal(proposalInput());
  assert.throws(
    () => acceptCoachProposal(proposal, {
      acceptedBy: 'principal_owner_001', acceptedAt: CREATED_AT,
      sourceRevision: 'rev_local_002', expectedProposalDigest: sha('0'),
    }),
    error => error.code === 'PROPOSAL_CONFIRMATION_MISMATCH',
  );
  assert.throws(
    () => acceptCoachProposal(proposal, {
      acceptedBy: 'owner@example.com', acceptedAt: CREATED_AT,
      sourceRevision: 'rev_local_002', expectedProposalDigest: proposal.proposalDigest,
    }),
    error => error.code === 'INVALID_REFERENCE',
  );
});

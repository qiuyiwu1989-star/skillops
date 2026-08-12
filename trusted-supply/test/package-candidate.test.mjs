import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  applyAudit,
  createCandidate,
  recordPackageAudit,
  refreshCandidate,
  reviewCandidate,
  toListing,
} from '../lib/candidate.mjs';
import { CandidateStore } from '../lib/store.mjs';
import { createPackageArtifact } from '../lib/package.mjs';
import { completeSmsInput } from './sms-fixture.mjs';

const CONTENT = `---
name: package-fixture
description: A complete package fixture for candidate lifecycle tests.
---

Follow the package fixture workflow and return a concise report.
`;

function packageArtifact(reference = 'v1', extra = '') {
  return createPackageArtifact({
    sourceVersion: reference,
    collectedAt: '2026-08-13T10:00:00.000Z',
    files: [
      { path: 'SKILL.md', content: CONTENT, mediaType: 'text/markdown' },
      { path: 'references/guide.md', content: `Guide ${extra}\n`, mediaType: 'text/markdown' },
    ],
  });
}

function input(overrides = {}) {
  return {
    source: {
      kind: 'fixture',
      repo: 'acme/package-fixture',
      url: 'https://example.test/acme/package-fixture',
      path: 'SKILL.md',
      commit: 'v1',
      license: 'MIT',
    },
    content: CONTENT,
    license: 'MIT',
    sms: completeSmsInput(82),
    eval: { status: 'pending' },
    package: packageArtifact(),
    catalog: { packageComplete: true, category: 'dev-programming' },
    ...overrides,
  };
}

function approvedCandidate(overrides = {}) {
  let candidate = applyAudit(createCandidate(input(overrides)));
  candidate = recordPackageAudit(candidate, {
    status: 'pass',
    auditor: 'fixture-package-auditor',
    findings: [],
  }, { clock: () => new Date('2026-08-13T10:10:00.000Z') });
  return reviewCandidate(candidate, {
    decision: 'approve',
    reviewer: 'fixture-human',
    reason: 'Content and complete package passed the current trust gates.',
  }, { clock: () => new Date('2026-08-13T10:20:00.000Z') });
}

test('candidate normalizes a complete package and binds package audit and review evidence to its digest', () => {
  const approved = approvedCandidate();
  const digest = approved.artifact.package.packageDigest;

  assert.match(digest, /^sha256:[a-f0-9]{64}$/);
  assert.equal(approved.packageAudit.status, 'pass');
  assert.equal(approved.packageAudit.basedOnPackageDigest, digest);
  assert.match(approved.packageAudit.basedOnPackageManifestFingerprint, /^sha256:[a-f0-9]{64}$/);
  assert.equal(approved.packageAuditEvents.length, 1);
  assert.equal(approved.reviewedPackageDigest, digest);
  assert.equal(approved.reviewEvents.at(-1).basedOnPackageDigest, digest);
});

test('a manifest metadata change invalidates approval even when the package digest stays equal', () => {
  const approved = approvedCandidate();
  const nextPackage = structuredClone(approved.artifact.package);
  nextPackage.manifest.find(entry => entry.path === 'references/guide.md').mediaType = 'text/plain';

  assert.equal(nextPackage.packageDigest, approved.artifact.package.packageDigest);
  const refreshed = refreshCandidate(approved, {
    content: approved.artifact.content,
    package: nextPackage,
  });

  assert.equal(refreshed.status, 'stale');
  assert.equal(refreshed.packageAudit, null);
  assert.deepEqual(refreshed.sms, { status: 'pending' });
  assert.deepEqual(refreshed.eval, { status: 'pending' });
  assert.equal(refreshed.reviewEvents.length, 1);
  assert.equal(refreshed.packageAuditEvents.length, 1);
});

test('changing only a package attachment invalidates all current evidence while preserving history', () => {
  const approved = approvedCandidate();
  const nextPackage = packageArtifact('v2', 'changed attachment');
  const refreshed = refreshCandidate(approved, {
    content: approved.artifact.content,
    package: nextPackage,
    source: { ...approved.source, commit: 'v2' },
  });

  assert.equal(refreshed.status, 'stale');
  assert.notEqual(refreshed.artifact.package.packageDigest, approved.artifact.package.packageDigest);
  assert.equal(refreshed.audit, null);
  assert.deepEqual(refreshed.sms, { status: 'pending' });
  assert.deepEqual(refreshed.eval, { status: 'pending' });
  assert.equal(refreshed.packageAudit, null);
  assert.equal(refreshed.reviewedFingerprint, null);
  assert.equal(refreshed.reviewedPackageDigest, null);
  assert.equal(refreshed.reviewEvents.length, 1);
  assert.equal(refreshed.packageAuditEvents.length, 1);
  assert.throws(() => toListing(refreshed), /only approved/i);
});

test('re-ingesting the same package digest is idempotent and keeps current approval evidence', () => {
  const approved = approvedCandidate();
  const refreshed = refreshCandidate(approved, {
    content: approved.artifact.content,
    package: structuredClone(approved.artifact.package),
    catalog: { ...approved.catalog, shelf: 'featured' },
  });

  assert.equal(refreshed.status, 'approved');
  assert.equal(refreshed.packageAudit.status, 'pass');
  assert.equal(refreshed.reviewedPackageDigest, approved.reviewedPackageDigest);
  assert.equal(refreshed.sms.status, 'complete');
  assert.equal(refreshed.eval.status, 'pending');
});

test('listing installation requires a complete package and a current passing package audit', () => {
  const approved = approvedCandidate();
  const listing = toListing(approved);

  assert.equal(listing.distribution, 'content');
  assert.equal(listing.install.status, 'eligible');
  assert.equal(listing.install.packageComplete, true);
  assert.equal(listing.package.packageDigest, approved.artifact.package.packageDigest);
  assert.equal(listing.package.audit.status, 'pass');
  assert.equal(Object.hasOwn(listing.package, 'storageRef'), false);
  assert.equal(listing.package.manifest.every(entry => !Object.hasOwn(entry, 'content')), true);

  const missingAudit = structuredClone(approved);
  missingAudit.packageAudit = null;
  const unavailable = toListing(missingAudit);
  assert.equal(unavailable.install.status, 'source_required');
  assert.equal(unavailable.install.reason, 'package_audit_required');

  const incomplete = approvedCandidate({ catalog: { packageComplete: false } });
  assert.equal(toListing(incomplete).install.reason, 'collector_snapshot_is_not_a_complete_package');
});

test('complete package cannot be approved without a current passing full-package audit', () => {
  const candidate = applyAudit(createCandidate(input()));
  assert.throws(() => reviewCandidate(candidate, {
    decision: 'approve', reviewer: 'fixture-human', reason: 'Attempt to bypass package audit.',
  }), /package hard trust gate/i);

  const blocked = recordPackageAudit(candidate, {
    status: 'block', auditor: 'fixture-security',
    findings: [{ path: 'scripts/run.sh', severity: 'block', rule: 'remote_pipe_execution' }],
  });
  assert.throws(() => reviewCandidate(blocked, {
    decision: 'approve', reviewer: 'fixture-human', reason: 'Attempt to override block.',
  }), /package hard trust gate/i);
});

test('legacy candidates without a package remain distributable by license but cannot be installed', () => {
  const legacyInput = input();
  delete legacyInput.package;
  legacyInput.eval = { status: 'pending' };
  let legacy = applyAudit(createCandidate(legacyInput));
  legacy = reviewCandidate(legacy, {
    decision: 'approve', reviewer: 'fixture-human', reason: 'Approve the redistributable SKILL.md only.',
  });
  const listing = toListing(legacy);

  assert.equal(listing.distribution, 'content');
  assert.equal(listing.install.status, 'source_required');
  assert.equal(listing.install.packageComplete, false);
  assert.equal(listing.install.reason, 'complete_package_missing');
  assert.equal(Object.hasOwn(listing, 'package'), false);
});

test('store persists append-only package audit history and rejects an audit for the wrong digest', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'skillops-package-candidate-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const store = new CandidateStore(path.join(directory, 'candidates.json'));
  const candidate = store.ingest(input());

  assert.throws(() => store.auditPackage(candidate.id, {
    status: 'pass',
    basedOnPackageDigest: `sha256:${'0'.repeat(64)}`,
    findings: [],
  }), /current package digest/i);

  const audited = store.auditPackage(candidate.id, {
    status: 'review',
    auditor: 'fixture-auditor',
    findings: [{ rule: 'executable_present', severity: 'review', path: 'scripts/run.sh' }],
  });
  assert.equal(audited.packageAuditEvents.length, 1);
  assert.equal(audited.packageAudit.status, 'review');

  assert.throws(() => store.update(candidate.id, value => ({ ...value, packageAuditEvents: [] })), /append-only/i);
});

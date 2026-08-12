import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  CandidateStore,
  applyAudit,
  auditFormat,
  classifyLicense,
  createCandidate,
  findDuplicateRelations,
  refreshCandidate,
  reviewCandidate,
  scanSecurity,
  toListing,
} from '../lib/index.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.resolve(HERE, '../fixtures');
const CLI = path.resolve(HERE, '../cli.mjs');
const FIXTURE_REPOS = ['healthy-pack', 'risky-pack', 'unlicensed-pack'];
const FIXED_REVIEW_TIME = new Date('2026-08-12T09:30:00.000Z');

function skillPaths(repoName) {
  const root = path.join(FIXTURES, repoName, 'skills');
  return fs.readdirSync(root, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => path.join(root, entry.name, 'SKILL.md'))
    .filter(file => fs.existsSync(file))
    .sort();
}

function licenseFor(repoName) {
  if (repoName === 'healthy-pack') return 'MIT';
  if (repoName === 'risky-pack') return 'Apache-2.0';
  return null;
}

function fixtureInput(repoName, file, overrides = {}) {
  const relativePath = path.relative(path.join(FIXTURES, repoName), file);
  return {
    source: {
      kind: 'github_snapshot',
      repo: `fixtures/${repoName}`,
      url: `https://github.example/fixtures/${repoName}`,
      path: relativePath,
      commit: `${repoName}-commit-001`,
      license: licenseFor(repoName),
    },
    content: fs.readFileSync(file, 'utf8'),
    license: licenseFor(repoName),
    sms: { status: 'complete', total: 82 },
    ...overrides,
  };
}

function fixtureByName(repoName, name, overrides) {
  return fixtureInput(repoName, path.join(FIXTURES, repoName, 'skills', name, 'SKILL.md'), overrides);
}

function makeStore(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'skillops-supply-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return new CandidateStore(path.join(directory, 'candidates.json'));
}

function runCli(args) {
  const result = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' });
  const json = result.stdout.trim() ? JSON.parse(result.stdout) : null;
  return { ...result, json };
}

test('fixtures provide three repositories and at least ten discoverable candidates', () => {
  assert.equal(FIXTURE_REPOS.length, 3);
  const allSkills = FIXTURE_REPOS.flatMap(skillPaths);
  assert.ok(allSkills.length >= 10, `expected >=10 fixture skills, got ${allSkills.length}`);
  for (const file of allSkills) assert.equal(path.basename(file), 'SKILL.md');
});

test('format and license gates distinguish valid, invalid, redistributable, and index-only skills', () => {
  const valid = auditFormat(fixtureByName('healthy-pack', 'summarize-notes').content);
  assert.equal(valid.status, 'pass');
  assert.equal(valid.name, 'summarize-notes');

  const invalid = auditFormat(fixtureByName('unlicensed-pack', 'broken-metadata').content);
  assert.equal(invalid.status, 'fail');
  assert.ok(invalid.issues.includes('missing_description'));

  assert.deepEqual(classifyLicense('MIT'), {
    status: 'allowed', spdx: 'MIT', reason: 'recognized_spdx', redistributable: true,
  });
  assert.equal(classifyLicense(null).status, 'index_only');
  assert.equal(classifyLicense(null).redistributable, false);
  assert.deepEqual(classifyLicense('GPL-3.0'), {
    status: 'index_only', spdx: 'GPL-3.0', reason: 'copyleft_obligations_not_implemented', redistributable: false,
  });
  assert.equal(classifyLicense('All rights reserved').status, 'blocked');
});

test('security gate blocks remote shell execution, credential exfiltration, and destructive commands', () => {
  const cases = [
    ['remote-bootstrap', 'remote_pipe_shell'],
    ['credential-uploader', 'credential_exfiltration'],
    ['destructive-cleanup', 'destructive_delete'],
  ];
  for (const [name, expectedRule] of cases) {
    const result = scanSecurity(fixtureByName('risky-pack', name).content);
    assert.equal(result.status, 'block', `${name} must be blocked`);
    assert.ok(result.findings.some(finding => finding.rule === expectedRule), `${name} missing ${expectedRule}`);
  }
  assert.equal(scanSecurity(fixtureByName('risky-pack', 'safe-translator').content).status, 'pass');
});

test('store ingests all fixtures and preserves exact duplicate source lineage', t => {
  const store = makeStore(t);
  for (const repoName of FIXTURE_REPOS) {
    for (const file of skillPaths(repoName)) store.ingest(fixtureInput(repoName, file));
  }
  assert.ok(store.list().length >= 10);

  const healthy = store.list().find(candidate =>
    candidate.source.repo === 'fixtures/healthy-pack' && candidate.source.path.endsWith('duplicate-guide/SKILL.md'));
  const unlicensed = store.list().find(candidate =>
    candidate.source.repo === 'fixtures/unlicensed-pack' && candidate.source.path.endsWith('duplicate-guide/SKILL.md'));
  assert.ok(healthy && unlicensed);
  assert.equal(healthy.artifact.fingerprint, unlicensed.artifact.fingerprint);
  assert.ok(healthy.duplicates.some(relation =>
    relation.type === 'exact_content' && relation.candidateId === unlicensed.id));
  assert.ok(unlicensed.duplicates.some(relation => relation.candidateId === healthy.id));

  const directRelations = findDuplicateRelations(healthy, store.list());
  assert.ok(directRelations.some(relation => relation.sourceIdentity === unlicensed.source.identity));
});

test('unreviewed candidates cannot produce listings', () => {
  const discovered = createCandidate(fixtureByName('healthy-pack', 'customer-brief'));
  assert.throws(() => toListing(discovered), /only approved/i);
  const audited = applyAudit(discovered);
  assert.equal(audited.status, 'review');
  assert.throws(() => toListing(audited), /only approved/i);
});

test('approval records immutable evidence and produces a complete market card', () => {
  const discovered = createCandidate(fixtureByName('healthy-pack', 'release-checklist'));
  const audited = applyAudit(discovered);
  const approved = reviewCandidate(audited, {
    decision: 'approve',
    reviewer: 'operator@example.test',
    reason: 'License, safety, provenance, and SMS gates passed.',
  }, { clock: () => FIXED_REVIEW_TIME });

  assert.equal(approved.status, 'approved');
  assert.equal(approved.reviewEvents.length, 1);
  assert.equal(approved.reviewEvents[0].reviewer, 'operator@example.test');
  assert.equal(approved.reviewEvents[0].reason, 'License, safety, provenance, and SMS gates passed.');
  assert.equal(approved.reviewEvents[0].at, FIXED_REVIEW_TIME.toISOString());
  assert.equal(approved.reviewEvents[0].basedOnFingerprint, approved.artifact.fingerprint);
  assert.ok(Object.isFrozen(approved.reviewEvents[0]));

  const listing = toListing(approved);
  assert.equal(listing.verification.status, 'approved');
  assert.equal(listing.version.commit, 'healthy-pack-commit-001');
  assert.equal(listing.license.status, 'allowed');
  assert.equal(listing.security.status, 'pass');
  assert.equal(listing.sms.total, 82);
  assert.equal(listing.eval.status, 'pending');
  assert.equal(listing.distribution, 'content');
  assert.equal(listing.content, approved.artifact.content);
  assert.equal(listing.source.repo, 'fixtures/healthy-pack');
});

test('missing license can only generate a source-link listing without copied content', () => {
  const candidate = createCandidate(fixtureByName('unlicensed-pack', 'market-research'));
  const audited = applyAudit(candidate);
  assert.equal(audited.audit.license.status, 'index_only');
  assert.equal(audited.audit.eligibleForReview, true);
  const approved = reviewCandidate(audited, {
    decision: 'approve', reviewer: 'legal-reviewer', reason: 'Index metadata and source link only.',
  });
  const listing = toListing(approved);
  assert.equal(listing.distribution, 'source_link_only');
  assert.equal(Object.hasOwn(listing, 'content'), false);
  assert.equal(listing.license.redistributable, false);
});

test('security hard blocks quarantine candidates and cannot be waived by reviewer or high SMS', () => {
  const candidate = createCandidate(fixtureByName('risky-pack', 'remote-bootstrap', {
    sms: { status: 'complete', total: 100 },
  }));
  const audited = applyAudit(candidate);
  assert.equal(audited.status, 'quarantined');
  assert.ok(audited.audit.hardBlocks.includes('security'));
  assert.throws(() => reviewCandidate(audited, {
    decision: 'approve', reviewer: 'operator', reason: 'Attempted override', smsWaiver: true,
  }), /hard trust gate failed/i);
  assert.throws(() => toListing(audited), /only approved/i);
});

test('pending or low SMS requires an explicit, auditable human waiver', () => {
  const pending = applyAudit(createCandidate(fixtureByName('healthy-pack', 'summarize-notes', {
    sms: { status: 'pending' },
  })));
  assert.throws(() => reviewCandidate(pending, {
    decision: 'approve', reviewer: 'operator', reason: 'No score yet',
  }), /smsWaiver/i);

  const approved = reviewCandidate(pending, {
    decision: 'approve', reviewer: 'operator', reason: 'Time-limited manual acceptance', smsWaiver: true,
  });
  assert.equal(approved.reviewEvents.at(-1).smsWaiver, true);
});

test('content changes invalidate approval, clear audit evidence, and prevent stale listing', () => {
  const original = applyAudit(createCandidate(fixtureByName('healthy-pack', 'customer-brief')));
  const approved = reviewCandidate(original, {
    decision: 'approve', reviewer: 'operator', reason: 'Initial version passed.',
  });
  const refreshed = refreshCandidate(approved, {
    content: `${approved.artifact.content}\n\nNew behavior requiring reassessment.\n`,
    commit: 'healthy-pack-commit-002',
  });
  assert.equal(refreshed.status, 'stale');
  assert.notEqual(refreshed.artifact.fingerprint, approved.artifact.fingerprint);
  assert.equal(refreshed.reviewedFingerprint, null);
  assert.equal(refreshed.audit, null);
  assert.equal(refreshed.reviewEvents.length, 1, 'prior review remains as immutable history');
  assert.throws(() => toListing(refreshed), /only approved/i);
});

test('listing recomputes the content fingerprint and rejects tampered approved content', () => {
  const audited = applyAudit(createCandidate(fixtureByName('healthy-pack', 'customer-brief')));
  const approved = reviewCandidate(audited, {
    decision: 'approve', reviewer: 'operator', reason: 'Initial version passed.',
  });
  const tampered = structuredClone(approved);
  tampered.artifact.content += '\nRun an unreviewed behavior.\n';

  assert.throws(() => toListing(tampered), /fingerprint/i);
  const reaudit = applyAudit(tampered);
  assert.equal(reaudit.audit.provenance.status, 'fail');
  assert.ok(reaudit.audit.provenance.issues.includes('content_fingerprint_mismatch'));
});

test('license changes invalidate an existing approval even when content is unchanged', () => {
  const audited = applyAudit(createCandidate(fixtureByName('healthy-pack', 'release-checklist')));
  const approved = reviewCandidate(audited, {
    decision: 'approve', reviewer: 'operator', reason: 'MIT release accepted.',
  });
  const refreshed = refreshCandidate(approved, {
    content: approved.artifact.content,
    license: 'All rights reserved',
  });

  assert.equal(refreshed.status, 'stale');
  assert.equal(refreshed.audit, null);
  assert.equal(refreshed.reviewedFingerprint, null);
  assert.equal(refreshed.artifact.license, 'All rights reserved');
  assert.throws(() => toListing(refreshed), /only approved/i);
});

test('store persists review history and exposes only approved listings', t => {
  const store = makeStore(t);
  const approvedInput = fixtureByName('healthy-pack', 'summarize-notes');
  const pendingInput = fixtureByName('healthy-pack', 'customer-brief');
  const approvedCandidate = store.ingest(approvedInput);
  store.ingest(pendingInput);
  store.audit(approvedCandidate.id);
  store.review(approvedCandidate.id, {
    decision: 'approve', reviewer: 'market-operator', reason: 'All gates passed.',
  }, { clock: () => FIXED_REVIEW_TIME });

  const listings = store.listListings();
  assert.equal(listings.length, 1);
  assert.equal(listings[0].verification.lastReview.reviewer, 'market-operator');

  const reloaded = new CandidateStore(store.filePath);
  assert.equal(reloaded.get(approvedCandidate.id).reviewEvents.length, 1);
  assert.equal(reloaded.list({ status: 'approved' }).length, 1);
});

test('CLI performs an offline ingest-audit-review-listing flow with explicit human approval', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'skillops-supply-cli-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const storePath = path.join(directory, 'supply.json');
  const skillPath = path.join(FIXTURES, 'healthy-pack', 'skills', 'customer-brief', 'SKILL.md');

  const ingested = runCli([
    'ingest', skillPath, '--store', storePath,
    '--source-url', 'https://github.example/acme/skills', '--repo', 'acme/skills',
    '--path', 'skills/customer-brief/SKILL.md', '--commit', 'abc123',
    '--license', 'MIT', '--sms-total', '80',
  ]);
  assert.equal(ingested.status, 0, ingested.stderr);
  assert.equal(ingested.json.status, 'discovered');

  const prematureListing = runCli(['listing', ingested.json.id, '--store', storePath]);
  assert.equal(prematureListing.status, 1);
  assert.match(prematureListing.stderr, /only approved/i);

  const audited = runCli(['audit', ingested.json.id, '--store', storePath]);
  assert.equal(audited.status, 0, audited.stderr);
  assert.equal(audited.json.status, 'review');

  const reviewed = runCli([
    'review', ingested.json.id, '--store', storePath,
    '--decision', 'approve', '--reviewer', 'cli-tester', '--reason', 'verified fixture',
  ]);
  assert.equal(reviewed.status, 0, reviewed.stderr);
  assert.equal(reviewed.json.status, 'approved');
  assert.equal(reviewed.json.reviewEvents.at(-1).reviewer, 'cli-tester');

  const listing = runCli(['listing', ingested.json.id, '--store', storePath]);
  assert.equal(listing.status, 0, listing.stderr);
  assert.equal(listing.json.name, 'customer-brief');
  assert.equal(listing.json.verification.status, 'approved');
  assert.equal(listing.json.distribution, 'content');
});

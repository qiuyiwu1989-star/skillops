import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { buildApprovedListings } from '../build.mjs';
import { createPackageArtifact } from '../../trusted-supply/lib/package.mjs';
import { CandidateStore } from '../../trusted-supply/lib/store.mjs';
import { completeSmsInput } from '../../trusted-supply/test/sms-fixture.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DETAIL_JS = fs.readFileSync(path.resolve(HERE, '../detail.js'), 'utf8');
const CONTENT = `---
name: market-package-evidence
description: Show verified package evidence in the market detail page.
---

Follow references/guide.md and return a concise result.
`;

function workspace(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skillops-v35-market-package-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return {
    root,
    store: new CandidateStore(path.join(root, 'candidates.json')),
    preview: path.join(root, 'preview'),
  };
}

function baseInput({ packageArtifact, packageComplete }) {
  return {
    source: {
      kind: 'fixture', repo: 'fixture/market-package-evidence', path: 'SKILL.md',
      url: 'https://example.test/fixture/market-package-evidence', commit: 'fixture@1', version: '1.0.0', license: 'MIT',
    },
    content: CONTENT,
    license: 'MIT',
    package: packageArtifact,
    sms: completeSmsInput(82, 'fixture-market-sms'),
    eval: { status: 'pending' },
    catalog: { packageComplete, packageFileCount: packageArtifact?.fileCount || 1, category: 'dev-programming' },
  };
}

function approve(store, input, { packagePass = false } = {}) {
  const initial = store.ingest(input);
  if (packagePass) store.auditPackage(initial.id, {
    status: 'pass', auditor: 'fixture-package-auditor', findings: [],
  });
  store.audit(initial.id);
  return store.review(initial.id, {
    decision: 'approve', reviewer: 'fixture-human', reviewerType: 'human', reason: '完整证据已经独立复核。',
  });
}

test('legacy-approved package evidence survives market build but requires current human certification to install', t => {
  const site = workspace(t);
  const packageArtifact = createPackageArtifact({
    sourceVersion: 'fixture@1',
    collectedAt: '2026-08-13T12:00:00.000Z',
    files: [
      { path: 'SKILL.md', content: CONTENT, mediaType: 'text/markdown' },
      { path: 'references/guide.md', content: '# Guide\n', mediaType: 'text/markdown' },
      { path: 'scripts/run.mjs', content: 'export default true;\n', mediaType: 'text/javascript' },
    ],
  });
  const approved = approve(site.store, baseInput({ packageArtifact, packageComplete: true }), { packagePass: true });
  const output = path.join(site.preview, 'data', 'listings.json');
  buildApprovedListings({ storePath: site.store.filePath, outPath: output });
  const payload = JSON.parse(fs.readFileSync(path.join(site.preview, 'data', 'skills', `${approved.id}.json`), 'utf8'));
  const listing = payload.listing;

  assert.equal(listing.install.status, 'source_required');
  assert.equal(listing.install.reason, 'human_certification_required');
  assert.equal(listing.package.packageDigest, packageArtifact.packageDigest);
  assert.equal(listing.package.fileCount, 3);
  assert.deepEqual(listing.package.manifest.map(file => file.path), ['SKILL.md', 'references/guide.md', 'scripts/run.mjs']);
  assert.equal(listing.package.audit.status, 'pass');
  assert.equal(listing.package.audit.basedOnPackageDigest, listing.package.packageDigest);
  assert.equal(Object.hasOwn(listing.package, 'storageRef'), false);
});
test('detail renderer reads the canonical listing.package.audit and renders package evidence', () => {
  assert.match(DETAIL_JS, /packageRecord\.packageDigest/);
  assert.match(DETAIL_JS, /packageRecord\.manifest/);
  assert.match(DETAIL_JS, /packageRecord\.fileCount/);
  assert.match(DETAIL_JS, /packageRecord\.audit/);
  assert.match(DETAIL_JS, /文件清单/);
  assert.match(DETAIL_JS, /manifest\.slice\(0, 20\)/);
});

test('market build keeps an approved legacy listing non-installable and without invented package evidence', t => {
  const site = workspace(t);
  const approved = approve(site.store, baseInput({ packageArtifact: undefined, packageComplete: false }));
  const output = path.join(site.preview, 'data', 'listings.json');
  buildApprovedListings({ storePath: site.store.filePath, outPath: output });
  const payload = JSON.parse(fs.readFileSync(path.join(site.preview, 'data', 'skills', `${approved.id}.json`), 'utf8'));

  assert.equal(payload.listing.install.status, 'source_required');
  assert.equal(payload.listing.install.packageComplete, false);
  assert.equal(payload.listing.install.reason, 'complete_package_missing');
  assert.equal(Object.hasOwn(payload.listing, 'package'), false);
});

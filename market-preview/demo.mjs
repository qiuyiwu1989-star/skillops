#!/usr/bin/env node

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { CandidateStore } from '../trusted-supply/lib/store.mjs';
import { buildApprovedListings } from './build.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..');
const FIXTURES = path.join(REPO_ROOT, 'trusted-supply', 'fixtures');
const CURRENT_COMMIT = readCurrentCommit();

function readCurrentCommit() {
  const head = fs.readFileSync(path.join(REPO_ROOT, '.git', 'HEAD'), 'utf8').trim();
  if (!head.startsWith('ref: ')) return head;
  return fs.readFileSync(path.join(REPO_ROOT, '.git', head.slice(5)), 'utf8').trim();
}

function fixtureInput(pack, name, license, smsTotal) {
  const relative = path.join('skills', name, 'SKILL.md');
  return {
    source: {
      kind: 'github_snapshot',
      repo: 'qiuyiwu1989-star/skillops',
      url: 'https://github.com/qiuyiwu1989-star/skillops',
      path: path.posix.join('trusted-supply', 'fixtures', pack, relative),
      commit: CURRENT_COMMIT,
      license,
    },
    content: fs.readFileSync(path.join(FIXTURES, pack, relative), 'utf8'),
    license,
    sms: { status: 'complete', total: smsTotal },
    eval: { status: 'pending' },
  };
}

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'skillops-market-preview-'));
try {
  const store = new CandidateStore(path.join(temporary, 'demo-candidates.json'));
  const samples = [
    fixtureInput('healthy-pack', 'customer-brief', 'MIT', 86),
    fixtureInput('healthy-pack', 'release-checklist', 'MIT', 82),
    fixtureInput('healthy-pack', 'summarize-notes', 'MIT', 78),
    fixtureInput('unlicensed-pack', 'market-research', null, 74),
  ];

  for (const input of samples) {
    const candidate = store.ingest(input);
    store.audit(candidate.id);
    store.review(candidate.id, {
      decision: 'approve',
      reviewer: 'local-preview',
      reason: 'Fixture accepted for local interface preview.',
    });
  }

  const output = path.join(HERE, 'data', 'listings.json');
  const artifact = buildApprovedListings({ storePath: store.filePath, outPath: output });
  process.stdout.write(`${JSON.stringify({ ok: true, output, count: artifact.count }, null, 2)}\n`);
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}

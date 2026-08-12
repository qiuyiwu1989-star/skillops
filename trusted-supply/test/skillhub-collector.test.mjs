import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { collectSkillHub, resolveSkillHubOptions } from '../lib/skillhub-collector.mjs';
import { CandidateStore } from '../lib/store.mjs';
import { completeSmsInput } from './sms-fixture.mjs';

function sha256(value) {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

function temporaryStore(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skillops-skillhub-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, storePath: path.join(root, 'store.json'), reportPath: path.join(root, 'report.json') };
}

function skill(name, license) {
  return `---\nname: ${name}\ndescription: ${name} test skill${license ? `\nlicense: ${license}` : ''}\n---\n\nComplete the requested work safely.\n`;
}

function json(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
}

function text(value, status = 200) {
  return new Response(value, { status, headers: { 'content-type': 'text/plain' } });
}

function fixtureFetch(items, definitions) {
  return async input => {
    const url = new URL(input);
    assert.equal(url.origin, 'https://api.skillhub.cn');
    const shelf = url.pathname.match(/^\/api\/v1\/showcase\/(recommended|trending|hot|newest)$/)?.[1];
    if (shelf) return json({ section: shelf, skills: items.filter(item => item.shelf === shelf) });
    const match = url.pathname.match(/^\/api\/v1\/skills\/([^/]+)(?:\/(files|file))?$/);
    const signature = url.pathname.match(/^\/api\/v1\/open\/skills\/([^/]+)\/versions\/([^/]+)\/signature$/);
    if (signature) {
      const value = definitions[decodeURIComponent(signature[1])];
      return value ? json({ signed: value.signed !== false, skill_slug: signature[1], skill_version: signature[2], key_id: 'fixture-key', content_hash: value.contentHash || sha256(value.content) }) : json({}, 404);
    }
    if (!match) return json({ error: 'not found' }, 404);
    const slug = decodeURIComponent(match[1]);
    const operation = match[2];
    const value = definitions[slug];
    if (!value) return json({ error: 'not found' }, 404);
    if (!operation) return json({
      latestVersion: { version: value.version },
      securityReports: value.securityReports ?? { keen: { status: 'benign' }, sanbu: { status: 'benign' } },
      skill: {
        slug,
        category: value.category,
        labels: { requires_api_key: String(Boolean(value.requiresApiKey)) },
        source: 'community',
        sourceUrl: `https://example.test/${slug}`,
        stats: { downloads: 100, installs: 10, stars: 4 },
      },
    });
    if (operation === 'files') {
      const files = [{ path: 'SKILL.md', size: Buffer.byteLength(value.content), sha256: value.skillHash || sha256(value.content) }];
      if (value.license) files.push({ path: 'LICENSE', size: Buffer.byteLength(value.license), sha256: sha256(value.license) });
      return json({ files });
    }
    if (operation === 'file') {
      if (url.searchParams.get('path') === 'SKILL.md') return text(value.content);
      if (url.searchParams.get('path') === 'LICENSE' && value.license) return text(value.license);
      return text('not found', 404);
    }
    return json({ error: 'not found' }, 404);
  };
}

test('options restrict shelves and enforce bounded collection sizes', () => {
  assert.deepEqual(resolveSkillHubOptions({}).shelves, ['recommended', 'trending']);
  assert.throws(() => resolveSkillHubOptions({ shelves: ['unknown'] }), /shelves/i);
  assert.throws(() => resolveSkillHubOptions({ limit: 51 }), /limit/i);
});

test('sync ingests signed, externally benign candidates without auto approval', async t => {
  const workspace = temporaryStore(t);
  const mit = 'MIT License\n\nPermission is hereby granted, free of charge, to any person obtaining a copy.\n';
  const content = skill('brief-writer');
  const apiKeyContent = skill('secret-research');
  const items = [
    { shelf: 'recommended', slug: 'brief-writer', namespace: { handle: 'maker' }, category: 'content-creation' },
    { shelf: 'recommended', slug: 'secret-research', namespace: { handle: 'maker' }, category: 'data-analysis' },
  ];
  const fetchImpl = fixtureFetch(items, {
    'brief-writer': { version: '1.2.0', category: 'content-creation', content, license: mit },
    'secret-research': { version: '1.0.0', category: 'data-analysis', content: apiKeyContent, license: mit, requiresApiKey: true },
  });

  const report = await collectSkillHub({
    storePath: workspace.storePath,
    reportPath: workspace.reportPath,
    shelves: ['recommended'],
    limit: 3,
    scanLimit: 5,
    audit: true,
    fetchImpl,
    clock: () => new Date('2026-08-13T00:00:00.000Z'),
  });
  const candidates = new CandidateStore(workspace.storePath).list();

  assert.equal(report.stats.discovered, 2);
  assert.equal(report.stats.ingested, 1);
  assert.equal(report.stats.audited, 1);
  assert.equal(report.stats.rejectedByPolicy, 1);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].status, 'review');
  assert.equal(candidates[0].source.kind, 'skillhub');
  assert.equal(candidates[0].source.version, '1.2.0');
  assert.equal(candidates[0].source.integrity.signed, true);
  assert.equal(candidates[0].catalog.coordinate, '@maker/brief-writer');
  assert.equal(candidates[0].catalog.externalSecurity.providers.length, 2);
  assert.equal(candidates[0].audit.license.status, 'allowed');
  assert.equal(candidates[0].reviewEvents.length, 0);
  assert.equal(JSON.parse(fs.readFileSync(workspace.reportPath, 'utf8')).policy.autoApprove, false);

  const supply = new CandidateStore(workspace.storePath);
  supply.assessSms(candidates[0].id, completeSmsInput(78));
  supply.audit(candidates[0].id);
  const approved = supply.review(candidates[0].id, {
    decision: 'approve',
    reviewer: 'fixture-reviewer',
    reason: 'Verified signed package, license, and safety evidence.',
  });
  const listing = new CandidateStore(workspace.storePath).listing(approved.id);
  assert.equal(listing.source.version, '1.2.0');
  assert.equal(listing.source.integrity.signed, true);
  assert.equal(listing.catalog.coordinate, '@maker/brief-writer');
});

test('one unavailable shelf does not prevent another shelf from syncing', async t => {
  const workspace = temporaryStore(t);
  const content = skill('survivor', 'MIT');
  const baseFetch = fixtureFetch([
    { shelf: 'trending', slug: 'survivor', namespace: { handle: 'maker' }, category: 'dev-programming' },
  ], {
    survivor: { version: '1.0.0', category: 'dev-programming', content },
  });
  const fetchImpl = input => new URL(input).pathname.endsWith('/recommended')
    ? json({ error: 'temporary failure' }, 503)
    : baseFetch(input);

  const report = await collectSkillHub({
    storePath: workspace.storePath,
    shelves: ['recommended', 'trending'],
    limit: 1,
    scanLimit: 2,
    fetchImpl,
  });

  assert.equal(report.stats.shelves, 1);
  assert.equal(report.stats.failed, 1);
  assert.equal(report.stats.ingested, 1);
  assert.ok(report.errors.some(error => error.shelf === 'recommended'));
});

test('missing license remains index-only while a hash mismatch is isolated', async t => {
  const workspace = temporaryStore(t);
  const noLicense = skill('source-index');
  const tampered = skill('tampered');
  const items = [
    { shelf: 'trending', slug: 'source-index', namespace: { handle: 'reader' }, category: 'knowledge-management' },
    { shelf: 'trending', slug: 'tampered', namespace: { handle: 'reader' }, category: 'dev-programming' },
  ];
  const fetchImpl = fixtureFetch(items, {
    'source-index': { version: '2.0.0', category: 'knowledge-management', content: noLicense },
    tampered: { version: '1.0.0', category: 'dev-programming', content: tampered, skillHash: '0'.repeat(64) },
  });

  const report = await collectSkillHub({
    storePath: workspace.storePath,
    shelves: ['trending'],
    limit: 3,
    scanLimit: 5,
    audit: true,
    fetchImpl,
  });
  const candidates = new CandidateStore(workspace.storePath).list();

  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].audit.license.status, 'index_only');
  assert.equal(candidates[0].status, 'review');
  assert.equal(report.stats.failed, 1);
  assert.ok(report.errors.some(error => error.skill === '@reader/tampered' && error.code === 'integrity_mismatch'));
});

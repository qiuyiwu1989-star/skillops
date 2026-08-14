import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createPackageArtifact } from '../lib/package.mjs';
import { CandidateStore } from '../lib/store.mjs';
import { attachFirstPartyLaunch, syncFirstPartyLaunch, validateFirstPartyLaunchProjection } from '../lib/first-party-launch.mjs';

const KEYS = ['skillops', 'ai-xiezuo-qiyue', 'creator-education', 'panduanku-jiagou', 'shengchan-shigu-kuaizhen', 'xuqiu-jianbao'];

function fixture(t) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'skillops-v411-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const agents = path.join(root, 'agents');
  fs.mkdirSync(agents);
  const items = KEYS.map((key, index) => {
    const directory = path.join(agents, key);
    fs.mkdirSync(directory);
    fs.writeFileSync(path.join(directory, 'SKILL.md'), `---\nname: ${key}\ndescription: ${key} handles a clear enterprise task with explicit boundaries.\n---\n\n# 使用场景\n\n触发任务并按步骤执行。\n\n# 流程\n\n1. 检查输入。\n2. 输出结果。\n\n# 安全边界\n\n不得执行未授权操作。\n`);
    if (index === 2) fs.writeFileSync(path.join(directory, 'guide.md'), '# Guide\n');
    return { key, sourceRoot: 'agents', relativePath: `${key}/SKILL.md`, sourceCoordinate: `zaowuyun/${key}`, titleZh: `${key} 中文`, summaryZh: '中文说明', category: 'operations', tags: ['首发'], featured: true };
  });
  const suites = Object.fromEntries(KEYS.map(key => [key, {
    schemaVersion: 1, suiteId: `zaowuyun/${key}/launch`, suiteVersion: '1.0.0',
    cases: [
      { id: 'one', prompt: '完成任务并说明边界。', assertions: [{ type: 'contains', value: '任务' }] },
      { id: 'two', prompt: '给出执行步骤。', assertions: [{ type: 'contains', value: '步骤' }] },
      { id: 'three', prompt: '说明不能做什么。', assertions: [{ type: 'contains', value: '不能' }] },
    ],
  }]));
  const evalSuitesPath = path.join(root, 'suites.json');
  fs.writeFileSync(evalSuitesPath, JSON.stringify({ schemaVersion: 1, suites }));
  return { root, agents, seeds: { schemaVersion: 1, items }, evalSuitesPath };
}

test('sync imports six complete first-party packages and produces honest launch lanes', t => {
  const x = fixture(t);
  const candidateStorePath = path.join(x.root, 'candidates.json');
  const result = syncFirstPartyLaunch({
    seeds: x.seeds, sourceRoots: { agents: x.agents }, candidateStorePath,
    packageStorePath: path.join(x.root, 'packages'), evalSuitesPath: x.evalSuitesPath,
    smsDraftDirectory: path.join(x.root, 'drafts'), readinessPath: path.join(x.root, 'readiness.json'),
    clock: () => new Date('2026-08-15T08:00:00.000Z'),
  });
  const candidates = new CandidateStore(candidateStorePath).list();
  assert.equal(candidates.length, 6);
  assert.ok(candidates.every(item => item.artifact.package.fileCount >= 1));
  assert.ok(candidates.every(item => item.packageAudit.status === 'pass'));
  assert.ok(candidates.every(item => item.sms.status === 'pending'));
  assert.ok(result.projection.items.every(item => item.lane === 'sms_confirmation_required'));
  assert.ok(result.projection.items.every(item => item.evidence.smsStatus === 'draft_ready'));
  assert.ok(KEYS.every(key => fs.existsSync(path.join(x.root, 'drafts', `${key}.json`))));
  assert.equal(result.projection.summary.releaseReady, 0);
});

test('public launch projection and attached listings never expose candidate identity, content, or paths', t => {
  const x = fixture(t);
  const result = syncFirstPartyLaunch({
    seeds: x.seeds, sourceRoots: { agents: x.agents }, candidateStorePath: path.join(x.root, 'candidates.json'),
    packageStorePath: path.join(x.root, 'packages'), evalSuitesPath: x.evalSuitesPath,
    clock: () => new Date('2026-08-15T08:00:00.000Z'),
  });
  const listing = { id: `cand_${'a'.repeat(20)}`, catalog: { coordinate: 'zaowuyun/skillops' }, sms: { status: 'pending' } };
  const attached = attachFirstPartyLaunch([listing], result.projection);
  const serialized = JSON.stringify(result.projection);
  assert.equal(attached[0].catalog.launchReadiness.key, 'skillops');
  assert.doesNotMatch(serialized, /cand_|SKILL\.md|Users\/|storageRef|prompt|output/i);
  assert.doesNotThrow(() => validateFirstPartyLaunchProjection(result.projection));
});

test('a stale pre-existing content fingerprint cannot inherit package or SMS evidence', t => {
  const x = fixture(t);
  const storePath = path.join(x.root, 'candidates.json');
  const store = new CandidateStore(storePath);
  const content = fs.readFileSync(path.join(x.agents, 'skillops', 'SKILL.md'), 'utf8');
  const staleContent = `${content}\n旧版附注。\n`;
  store.ingest({
    source: { kind: 'local_first_party', repo: 'zaowuyun/skillops', path: 'SKILL.md', commit: 'old' },
    content: staleContent,
    package: createPackageArtifact({ sourceVersion: 'old', files: [{ path: 'SKILL.md', content: staleContent }] }),
    sms: { status: 'pending' }, eval: { status: 'pending' }, catalog: { packageComplete: true },
  });
  const result = syncFirstPartyLaunch({
    seeds: x.seeds, sourceRoots: { agents: x.agents }, candidateStorePath: storePath,
    packageStorePath: path.join(x.root, 'packages'), evalSuitesPath: x.evalSuitesPath,
    clock: () => new Date('2026-08-15T08:00:00.000Z'),
  });
  const candidates = new CandidateStore(storePath).list();
  assert.equal(candidates.length, 6);
  assert.ok(candidates.some(item => item.source.repo === 'zaowuyun/skillops'
    && item.artifact.content === content && item.sms.status === 'pending'));
  assert.equal(result.projection.items.find(item => item.key === 'skillops').lane, 'sms_confirmation_required');
});

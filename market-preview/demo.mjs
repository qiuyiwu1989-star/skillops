#!/usr/bin/env node

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { CandidateStore } from '../trusted-supply/lib/store.mjs';
import { syncFirstPartyLaunch } from '../trusted-supply/lib/first-party-launch.mjs';
import { buildApprovedListings } from './build.mjs';
import { readCatalogSeeds, syncPreviewCatalog } from './catalog-pipeline.mjs';
import { completeSmsInput } from '../trusted-supply/test/sms-fixture.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..');
const FIXTURES = path.join(REPO_ROOT, 'trusted-supply', 'fixtures');
const CURRENT_COMMIT = readCurrentCommit();

function readCurrentCommit() {
  const head = fs.readFileSync(path.join(REPO_ROOT, '.git', 'HEAD'), 'utf8').trim();
  if (!head.startsWith('ref: ')) return head;
  return fs.readFileSync(path.join(REPO_ROOT, '.git', head.slice(5)), 'utf8').trim();
}

const DEMO_MERCHANDISING = {
  'customer-brief': {
    category: 'communication', tags: ['客户洞察', '商业简报'], featured: true,
    offer: { status: 'demo', pricing: { model: 'free', currency: 'CNY', amountMinor: 0, labelZh: '免费体验' }, rightsLabelZh: '在线体验与评估', acquisitionLabelZh: '获取企业授权后调用', noteZh: '演示报价，不形成授权' },
  },
  'release-checklist': {
    category: 'operations', tags: ['发布管理', '质量检查'], featured: true,
    offer: { status: 'demo', pricing: { model: 'one_time', currency: 'CNY', amountMinor: 9900, labelZh: '¥99 / 组织' }, rightsLabelZh: '企业内调用', acquisitionLabelZh: '提交企业采购', noteZh: '演示报价，不形成授权' },
  },
  'summarize-notes': {
    category: 'knowledge-management', tags: ['会议纪要', '知识整理'], featured: false,
    offer: { status: 'demo', pricing: { model: 'subscription', currency: 'CNY', amountMinor: 2900, labelZh: '¥29 / 月' }, rightsLabelZh: '企业内调用', acquisitionLabelZh: '选择组织订阅', noteZh: '演示报价，不形成授权' },
  },
  'market-research': {
    category: 'research', tags: ['市场研究', '机会洞察'], featured: false,
    offer: { status: 'demo', pricing: { model: 'contact', currency: 'CNY', amountMinor: 0, labelZh: '联系授权' }, rightsLabelZh: '仅查看来源', acquisitionLabelZh: '联系创作者确认', noteZh: '演示报价，不形成授权' },
  },
};

function fixtureInput(pack, name, license, smsTotal) {
  const relative = path.join('skills', name, 'SKILL.md');
  const merchandising = DEMO_MERCHANDISING[name];
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
    sms: completeSmsInput(smsTotal, 'local-preview'),
    eval: { status: 'pending' },
    catalog: {
      category: merchandising.category,
      tags: merchandising.tags,
      featured: merchandising.featured,
      requiresApiKey: false,
      publisher: {
        displayNameZh: '造物云 SkillOps',
        handle: 'qiuyiwu1989-star',
        kind: 'organization',
        verificationLabelZh: '来源已核验',
        creatorUrl: './creator.html',
      },
      offer: merchandising.offer,
    },
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

  const approvedOutput = path.join(temporary, 'approved-preview', 'data', 'listings.json');
  const approved = buildApprovedListings({ storePath: store.filePath, outPath: approvedOutput });
  const launch = syncFirstPartyLaunch({
    seeds: readCatalogSeeds(),
    sourceRoots: { agents: path.join(os.homedir(), '.agents', 'skills'), project: REPO_ROOT },
    candidateStorePath: path.join(REPO_ROOT, '.skillops', 'first-party-candidates.json'),
    packageStorePath: path.join(REPO_ROOT, '.skillops', 'first-party-packages'),
    evalSuitesPath: path.join(REPO_ROOT, 'trusted-supply', 'fixtures', 'v411-first-party-eval-suites.json'),
    smsDraftDirectory: path.join(REPO_ROOT, '.skillops', 'launch-sms-drafts'),
    readinessPath: path.join(REPO_ROOT, '.skillops', 'launch-readiness.json'),
  });
  const output = path.join(HERE, 'data', 'listings.json');
  const result = syncPreviewCatalog({ approvedListings: approved.listings, launchProjection: launch.projection, outPath: output });
  process.stdout.write(`${JSON.stringify({ ok: true, output, ...result.report }, null, 2)}\n`);
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}

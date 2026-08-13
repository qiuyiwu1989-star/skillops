import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { createDemandCatalogProjection } from '../lib/demand/demand-catalog.mjs';
import { projectEnterpriseLibrary } from '../lib/demand/enterprise-library.mjs';
import { AcquisitionLedger } from '../lib/demand/free-acquisition.mjs';
import { createSkillStewardPlan } from '../lib/demand/skill-steward.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const read = relative => fs.readFileSync(path.join(ROOT, relative), 'utf8');
const PRODUCT = `prod_${'a'.repeat(64)}`;
const RELEASE = `rel_${'b'.repeat(64)}`;

test('all four caller-controlled trust boundaries fail closed when their trusted capability is absent', () => {
  assert.throws(() => createDemandCatalogProjection({
    marketCatalog: {}, publicationProjection: {}, organizationId: 'org_acme', generatedAt: '2026-08-14T00:00:00Z',
  }), error => error.code === 'MARKET_CATALOG_RESOLVER_REQUIRED');

  assert.throws(() => projectEnterpriseLibrary({
    orders: {}, entitlements: {}, entitlementLifecycle: {},
  }, {
    organizationAuthorizer: () => ({ decision: 'allow', organizationId: 'org_acme' }),
    publicationResolver: { resolveAccessRelease: () => null }, now: () => '2026-08-14T00:00:00Z',
  }), error => error.code === 'MARKET_PROJECTION_ANCHOR_REQUIRED');

  const file = path.join(fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'skillops-v45-review-')), 'ledger.json');
  const ledger = new AcquisitionLedger(file);
  assert.throws(() => ledger.acquire({
    organizationId: 'org_acme', productId: PRODUCT, releaseIds: [RELEASE],
    offerRevisionId: `offrev_${'c'.repeat(64)}`, idempotencyKey: 'review:no-org-authorizer',
  }, {}), error => error.code === 'ORGANIZATION_AUTHORIZER_REQUIRED');
  assert.equal(fs.existsSync(file), false);

  assert.throws(() => createSkillStewardPlan({
    task: { summaryZh: '起草正式项目通知', intentTags: ['公文'] },
    context: {
      organizationId: 'org_acme', projectId: 'project_alpha', environment: 'staging',
      allowedPermissions: [], requiredRights: ['invoke'],
    },
  }, {
    catalogProjection: {}, libraryProjection: {}, accessDecisionResolver: () => null,
    now: '2026-08-14T00:00:00Z',
  }), error => error.code === 'CATALOG_VALIDATOR_REQUIRED');
});

test('demand modules have no execution, model or outbound-network adapter', () => {
  const source = [
    'trusted-supply/lib/demand/demand-catalog.mjs',
    'trusted-supply/lib/demand/free-acquisition.mjs',
    'trusted-supply/lib/demand/enterprise-library.mjs',
    'trusted-supply/lib/demand/skill-steward.mjs',
  ].map(read).join('\n');
  assert.doesNotMatch(source, /node:(?:child_process|http|https|net|tls|dgram|worker_threads)/);
  assert.doesNotMatch(source, /\b(?:fetch|WebSocket|EventSource|XMLHttpRequest|eval|Function)\s*\(/);
  assert.match(source, /nonExecutable:\s*true/);
  assert.match(source, /rights:\s*\[\.\.\.item\.grantedRights\]/);
  assert.match(source, /grantedRights:\s*status === 'ready' \? \[\.\.\.context\.requiredRights\]/);
});

test('Chinese local preview is loadable and covers all acquisition outcomes without a write control', async () => {
  const html = read('market-preview/demand.html');
  const index = read('market-preview/index.html');
  const script = read('market-preview/demand.js');
  const fixturePath = path.join(ROOT, 'market-preview/demand.fixture.json');
  assert.equal(fs.existsSync(fixturePath), true);
  assert.match(index, /href="\.\/demand\.html"[^>]*>技能管家</);
  assert.doesNotMatch(html, /<form|<button|<input|<textarea|contenteditable/i);
  assert.doesNotMatch(html, /https?:\/\//i);
  assert.doesNotMatch(script, /innerHTML|outerHTML|insertAdjacentHTML|document\.write|WebSocket|EventSource|method\s*:\s*['"]POST/i);

  const { normalizeDemandWorkbench } = await import(pathToFileURL(path.join(ROOT, 'market-preview/demand.js')));
  const normalized = normalizeDemandWorkbench(JSON.parse(fs.readFileSync(fixturePath, 'utf8')));
  assert.deepEqual(
    [...new Set(normalized.plan.recommendations.map(item => item.acquisitionState))].sort(),
    ['entitled', 'free_available', 'purchase_required', 'unavailable'],
  );
  assert.equal(normalized.plan.workOrderDraft.nonExecutable, true);
  assert.equal(normalized.plan.workOrderDraft.adapter, 'code.zaowuyun.future.v1');
  assert.doesNotMatch(JSON.stringify(normalized), /candidate|storageRef|localPath|prompt|output|token|secret|receipt|subjectDigest|principalId/i);
});

test('hard resource limits and atomic persistence guards remain explicit', () => {
  const acquisition = read('trusted-supply/lib/demand/free-acquisition.mjs');
  const catalog = read('trusted-supply/lib/demand/demand-catalog.mjs');
  assert.match(acquisition, /MAX_OPERATIONS\s*=\s*100_000/);
  assert.match(acquisition, /MAX_BYTES\s*=\s*32 \* 1024 \* 1024/);
  assert.match(acquisition, /fs\.renameSync\(temporary, this\.filePath\)/);
  assert.match(acquisition, /isSymbolicLink\(\)/);
  assert.match(catalog, /items\.length > 10_000/);
  assert.match(catalog, /dependency\.requirement === 'required'/);
  assert.match(catalog, /DEPENDENCY_NOT_CURRENTLY_PUBLISHED/);
});

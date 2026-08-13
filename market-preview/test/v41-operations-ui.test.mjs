import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const read = name => fs.readFileSync(path.resolve(HERE, '..', name), 'utf8');
const APP = read('app.js');
const DETAIL = read('detail.js');
const DETAIL_CSS = read('detail.css');
const OPS_HTML = read('ops.html');
const OPS_JS = read('ops.js');
const OPS_CSS = read('ops.css');
const { normalizePublicOps } = await import(pathToFileURL(path.resolve(HERE, '../ops.js')));

function operationsProjection() {
  return {
    schemaVersion: 1,
    projectionDigest: `sha256:${'a'.repeat(64)}`,
    skill: {
      skillId: 'zaowuyun/writer', releaseId: `rel_${'b'.repeat(64)}`, version: '1.0.0', packageDigest: `sha256:${'c'.repeat(64)}`,
      titleZh: '中文写作', descriptionZh: '将材料整理为中文文章。', intentTags: ['中文写作', '内容创作'],
      permissions: { required: ['read:public-summary'], optional: [], prohibited: ['shell:execute'] },
      compatibility: { contract: 'skill-package.v1', targets: ['codex'] },
    },
    routing: { total: 84, maxTotal: 100, limitations: ['static_routing_quality_only'], dimensions: [], whenToUse: ['需要撰写文章'], whenNotToUse: ['只需要搜索资料'] },
    composition: {
      status: 'ready', taskIntent: { intentTags: ['中文写作'], requirements: [] },
      steps: [{ position: 1, skillId: 'zaowuyun/writer', releaseId: `rel_${'b'.repeat(64)}`, titleZh: '中文写作', reasonZh: '匹配中文写作' }],
      relatedSkills: [{ skillId: 'zaowuyun/review', releaseId: `rel_${'d'.repeat(64)}`, titleZh: '文章复核', reasonZh: '写作后复核' }], blockers: [],
    },
    operations: {
      status: 'degrading', reasonCode: 'SUCCESS_RATE_DEGRADED', healthLabelZh: '表现退化', healthReasonZh: '相邻窗口成功率下降。',
      sample: { observedOperations: 12, observedEvents: 53 },
      funnel: {
        impression: { observed: 12, numerator: 12, denominator: 12, rate: 1 }, selected: { observed: 10, numerator: 10, denominator: 12, rate: 10 / 12 },
        invoked: { observed: 8, numerator: 8, denominator: 10, rate: .8 }, succeeded: { observed: 5, numerator: 5, denominator: 8, rate: .625 },
        reused: { observed: 2, numerator: 2, denominator: 5, rate: .4 },
      },
      outcomes: { samples: 8, denominator: 8, successes: 5, failures: 2, handoffs: 1, successRate: .625, handoffRate: .125 },
      cost: { samples: 8, totalMicros: 16_000, averageMicros: 2_000 }, latency: { samples: 8, p50Ms: 430, p95Ms: 1_200 },
      failureCategories: { timeout: 2 }, trend: { comparable: true, reasonCode: 'SUCCESS_RATE_DEGRADED', successRateDelta: -.25 },
      suggestedAction: 'review_for_coach', coachReasonZh: '相邻窗口成功率下降。', governanceAction: 'none',
    },
  };
}

function payload() {
  return {
    schemaVersion: 1,
    organizationProjection: {
      throughSequence: 1, organization: { organizationId: 'org_demo', name: '演示组织', status: 'active' },
      projects: {}, establishments: {}, enrollments: {}, roleSummary: {}, auditEvents: [],
    },
    stagingStatus: { cursor: '0', receiptCount: 0, reconciliationRequiredCount: 0, operations: [] },
    operationsIntelligence: { items: [operationsProjection()] },
  };
}

test('market searches structured intent tags and explains recommendations and composition', () => {
  for (const token of ['function intentTags', 'recommendationFor', '任务意图匹配', '推荐依据', '可组合']) assert.match(APP, new RegExp(token));
  assert.match(APP, /projection\?\.routing\?\.whenToUse/);
  assert.match(APP, /projection\?\.routing\?\.whenNotToUse/);
  assert.doesNotMatch(APP, /下载榜|五星|评论数/);
});

test('detail separates static Routing from Eval and shows boundaries, permission, compatibility and composition', () => {
  for (const copy of ['何时使用', '何时不要使用', 'Routing 与 Eval 分开判断', '必需权限', '禁止权限', '兼容环境', '可组合技能']) {
    assert.match(DETAIL, new RegExp(copy));
  }
  assert.match(DETAIL, /static_routing_quality_only|不是运行成功率/);
  assert.match(DETAIL, /composition\.relatedSkills/);
  assert.match(DETAIL_CSS, /routing-boundaries/);
  assert.match(DETAIL_CSS, /composition-steps/);
});

test('operations page exposes funnel numerators, denominators, samples, cost, latency, handoff, health and Coach only as read-only judgement', () => {
  for (const copy of ['技能运营智能', '漏斗显示分子、分母与样本量', 'Coach 复核', '平均成本', '运行时延', '人工接管']) {
    assert.match(OPS_HTML + OPS_JS, new RegExp(copy));
  }
  assert.match(OPS_JS, /stage\.numerator/);
  assert.match(OPS_JS, /stage\.denominator/);
  assert.match(OPS_JS, /latency\.samples/);
  assert.match(OPS_JS, /suggestedAction === 'review_for_coach'/);
  assert.match(OPS_JS, /不自动发布、撤回或退役/);
  assert.doesNotMatch(OPS_HTML + OPS_JS, /立即发布|批准入编|执行退役|提交治理/);
});

test('operations normalizer accepts only the fixed public projection and preserves real sample denominators', () => {
  const normalized = normalizePublicOps(payload());
  assert.equal(normalized.skillOperations.length, 1);
  const item = normalized.skillOperations[0];
  assert.equal(item.titleZh, '中文写作');
  assert.equal(item.operations.funnel.invoked.numerator, 8);
  assert.equal(item.operations.funnel.invoked.denominator, 10);
  assert.equal(item.operations.latency.samples, 8);
  assert.equal(item.operations.suggestedAction, 'review_for_coach');
});

test('V4.1 surfaces keep Rams, responsive, dark-mode, focus and low-motion contracts', () => {
  for (const css of [DETAIL_CSS, OPS_CSS]) {
    assert.match(css, /--bg:\s*#fbfaf6/);
    assert.match(css, /--accent:\s*#e2522a/);
    assert.match(css, /@media \(max-width: 640px\)/);
    assert.match(css, /@media \(prefers-color-scheme: dark\)/);
    assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
    assert.doesNotMatch(css, /box-shadow\s*:/);
  }
});

test('V4.1 visible Chinese copy avoids em dash and public pages expose no governance write controls', () => {
  const visibleSources = APP.replace(/replace\(\/\[[^\n]+/, '') + DETAIL.replace(/replace\(\/\[[^\n]+/, '') + OPS_HTML + OPS_JS;
  assert.doesNotMatch(visibleSources, /[—–]/);
  assert.doesNotMatch(OPS_HTML, /<form|<button/);
});


import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HTML_PATH = path.resolve(HERE, '../ops.html');
const CSS_PATH = path.resolve(HERE, '../ops.css');
const JS_PATH = path.resolve(HERE, '../ops.js');
const HTML = fs.readFileSync(HTML_PATH, 'utf8');
const CSS = fs.readFileSync(CSS_PATH, 'utf8');
const JS = fs.readFileSync(JS_PATH, 'utf8');
const { normalizePublicOps } = await import(pathToFileURL(JS_PATH));

function fixture() {
  return {
    schemaVersion: 1,
    generatedAt: '2026-08-13T09:00:00Z',
    organizationProjection: {
      schemaVersion: 1,
      throughSequence: 6,
      organization: { organizationId: 'org_yongle', name: '永乐教育训练营', status: 'active' },
      projects: {
        project_pilot: { projectId: 'project_pilot', name: '首批技能试点', status: 'active' },
      },
      establishments: {
        est_content: { establishmentId: 'est_content', projectId: 'project_pilot', name: '内容能力编制', capacity: 3, status: 'active' },
      },
      enrollments: {
        enrollment_writer: {
          enrollmentId: 'enrollment_writer', establishmentId: 'est_content', skillId: 'maker/writer',
          releaseId: `rel_${'a'.repeat(64)}`, status: 'active',
        },
      },
      roleSummary: { viewer: 2, member: 5, reviewer: 2, operator: 1, org_admin: 1 },
      auditEvents: [
        { auditEventId: 'audit_1', sequence: 6, type: 'enrollment.created', occurredAt: '2026-08-13T08:00:00Z', actorRole: 'org_admin' },
      ],
    },
    stagingStatus: {
      schemaVersion: 1,
      cursor: '1',
      revision: 2,
      receiptCount: 1,
      reconciliationRequiredCount: 0,
      operations: [{
        operationId: 'op_publish_1', state: 'accepted', updatedAt: '2026-08-13T08:30:00Z',
        receipt: { operationId: 'op_publish_1', status: 'accepted', receivedAt: '2026-08-13T08:30:00Z', cursor: '1' },
      }],
    },
  };
}

test('page is a Chinese read-only operations information architecture', () => {
  for (const copy of ['组织能力运营', '组织与项目', '能力编制', '技能入编', '角色分布', '造物云 Staging', '审计时间线']) {
    assert.match(HTML, new RegExp(copy));
  }
  assert.match(HTML, /本地只读/);
  assert.match(HTML, /aria-live="polite"/);
  assert.match(HTML, /class="zy-skip-link/);
  assert.doesNotMatch(HTML, /https?:\/\/|preconnect|fonts\.googleapis|fonts\.gstatic/);
  assert.doesNotMatch(HTML, /<form|<button|保存|提交治理|连接生产|生产环境/);
});

test('loader supports one injected public payload or one configured data URL', () => {
  assert.match(JS, /SKILLOPS_PUBLIC_OPS/);
  assert.match(JS, /skillops:ops-url/);
  assert.match(JS, /dataset\.opsUrl/);
  assert.match(JS, /response\.json\(\)/);
  assert.match(JS, /normalizePublicOps/);
  assert.doesNotMatch(JS, /innerHTML|insertAdjacentHTML|eval\(|new Function/);
});

test('normalizer accepts public governance and staging shapes without inventing metrics', () => {
  const normalized = normalizePublicOps(fixture());
  assert.equal(normalized.organization.name, '永乐教育训练营');
  assert.equal(normalized.projects.length, 1);
  assert.equal(normalized.establishments[0].capacity, 3);
  assert.equal(normalized.enrollments[0].skillId, 'maker/writer');
  assert.equal(normalized.roles.member, 5);
  assert.equal(normalized.auditEvents[0].type, 'enrollment.created');
  assert.equal(normalized.staging.cursor, '1');
  assert.equal(normalized.staging.accepted, 1);
  assert.equal(normalized.staging.receipts[0].operationId, 'op_publish_1');
  assert.equal(normalized.staging.reconciliationCount, 0);
  assert.equal(normalized.staging.reconciliation.length, 0);
});

test('persistent staging operations expose accepted receipts and reconciliation without private transport data', () => {
  const payload = fixture();
  payload.stagingStatus.cursor = '1';
  payload.stagingStatus.receiptCount = 1;
  payload.stagingStatus.reconciliationRequiredCount = 1;
  payload.stagingStatus.operations.push({
    operationId: 'op_uncertain_2', state: 'reconciliation_required', updatedAt: '2026-08-13T08:45:00Z',
    reconciliation: { operationId: 'op_uncertain_2', state: 'reconciliation_required', reasonCode: 'commit_uncertain', recordedAt: '2026-08-13T08:45:00Z' },
  });
  const normalized = normalizePublicOps(payload);
  assert.equal(normalized.staging.accepted, 1);
  assert.equal(normalized.staging.reconciliationCount, 1);
  assert.equal(normalized.staging.reconciliation[0].operationId, 'op_uncertain_2');
});

test('private or execution data fails closed before it reaches the DOM', () => {
  const forbiddenCases = [
    { organizationProjection: { organization: { name: '泄漏', principalId: 'person:private' } } },
    { stagingStatus: { cursor: '0', receipts: [{ localPath: '/private/package' }] } },
    { stagingStatus: { cursor: '0', receipts: [{ storageRef: 'cas:private' }] } },
    { stagingStatus: { cursor: '0', receipts: [{ prompt: 'private prompt' }] } },
    { stagingStatus: { cursor: '0', receipts: [{ output: 'private output' }] } },
    { stagingStatus: { cursor: '0', receipts: [{ token: 'private-token' }] } },
    { stagingStatus: { cursor: '0', receipts: [{ secret: 'private-secret' }] } },
  ];
  for (const value of forbiddenCases) {
    assert.throws(() => normalizePublicOps({ schemaVersion: 1, ...value }), /PUBLIC_DATA_REQUIRED/);
  }
});

test('Rams tokens, responsive layout, dark mode, keyboard focus and low motion remain explicit', () => {
  assert.match(CSS, /--bg:\s*#fbfaf6/);
  assert.match(CSS, /--accent:\s*#e2522a/);
  assert.match(CSS, /--max:\s*1120px/);
  assert.match(CSS, /@media \(max-width: 640px\)/);
  assert.match(CSS, /@media \(prefers-color-scheme: dark\)/);
  assert.match(CSS, /:focus-visible/);
  assert.match(CSS, /@media \(prefers-reduced-motion: reduce\)/);
  assert.doesNotMatch(CSS, /box-shadow\s*:/);
});

test('visible copy avoids em dash, vanity metrics and governance actions', () => {
  assert.doesNotMatch(HTML, /[—–]/);
  assert.doesNotMatch(HTML + JS, /下载量|五星|评论数|立即发布|批准入编|退役技能/);
});

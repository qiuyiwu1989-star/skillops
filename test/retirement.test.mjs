import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  RetirementStore,
  planRetirement,
} from '../dist-src/skillops/scripts/lib/retirement.mjs';

const SKILL = 'qiuyiwu/legacy-writer';
const RELEASE = `rel_${'a'.repeat(64)}`;
const NOW = '2026-08-13T08:00:00.000Z';

function dependencies(overrides = {}) {
  return {
    deployments: [], compositions: [], projects: [], organizationRefs: [], ...overrides,
  };
}

function plan(overrides = {}) {
  return planRetirement({
    skillId: SKILL, releaseIds: [RELEASE], dependencies: dependencies(),
    replacementSkillId: 'qiuyiwu/new-writer', reason: '能力已由新版技能替代', ...overrides,
  }, { now: NOW });
}

function storeContext(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skillops-retirement-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return new RetirementStore(path.join(root, 'retirement.json'));
}

test('缺少任一依赖域或依赖状态未知时阻断，且不产生确认摘要', () => {
  const missing = planRetirement({
    skillId: SKILL, releaseIds: [RELEASE], reason: '准备退役',
    dependencies: { deployments: [], compositions: [], projects: [] },
  }, { now: NOW });
  assert.equal(missing.status, 'blocked');
  assert.equal(missing.planDigest, null);
  assert.deepEqual(missing.requiredConfirmations, []);
  assert.ok(missing.reasons.some(item => item.code === 'DEPENDENCY_SCOPE_UNKNOWN' && item.dependencyKind === 'organizationRefs'));

  const unknown = plan({ dependencies: dependencies({ projects: [{ ref: 'project:alpha', status: 'unknown' }] }) });
  assert.equal(unknown.status, 'blocked');
  assert.ok(unknown.reasons.some(item => item.code === 'DEPENDENCY_STATE_UNKNOWN'));
});

test('活动依赖阻断退役；四域明确后计划摘要稳定且绑定确认', () => {
  const blocked = plan({ dependencies: dependencies({ deployments: [{ ref: 'deployment:prod', status: 'blocking' }] }) });
  assert.equal(blocked.status, 'blocked');
  assert.equal(blocked.planDigest, null);

  const first = plan({ releaseIds: [RELEASE, `rel_${'b'.repeat(64)}`] });
  const reordered = plan({ releaseIds: [`rel_${'b'.repeat(64)}`, RELEASE] });
  assert.equal(first.status, 'ready');
  assert.equal(first.planDigest, reordered.planDigest);
  assert.deepEqual(first.requiredConfirmations, [{ kind: 'plan_digest', value: first.planDigest, messageZh: '退役确认必须绑定本计划摘要' }]);
  assert.equal(first.lifecycleBoundary.releaseStatusUnchanged, true);
  assert.equal(JSON.stringify(first).includes('withdraw'), false);
  assert.equal(JSON.stringify(first).includes('revoke'), false);
});

test('退役必须确认摘要，成功后阻断新部署但保留已有 Lock 解释', t => {
  const store = storeContext(t);
  const ready = plan();
  assert.throws(
    () => store.retire(ready, { confirmPlanDigest: `sha256:${'0'.repeat(64)}`, actor: 'principal_reviewer_01', at: NOW }),
    error => error.code === 'CONFIRMATION_MISMATCH',
  );
  const result = store.retire(ready, { confirmPlanDigest: ready.planDigest, actor: 'principal_reviewer_01', at: NOW });
  assert.equal(result.action, 'retired');
  assert.equal(result.status.state, 'retired');
  assert.equal(result.status.allowsNewDeployments, false);
  assert.equal(result.status.existingLocks, 'preserved_for_explanation');
  assert.equal(result.status.releaseLifecycle, 'unchanged');
  assert.deepEqual(result.status.releaseIds, [RELEASE]);
  assert.equal(JSON.stringify(result).includes('principal_reviewer_01'), false, 'actor 只保存不可逆摘要');
});

test('重复退役幂等，不同计划冲突', t => {
  const store = storeContext(t);
  const ready = plan();
  store.retire(ready, { confirmPlanDigest: ready.planDigest, actor: 'reviewer_01', at: NOW });
  assert.equal(store.retire(ready, { confirmPlanDigest: ready.planDigest, actor: 'reviewer_01', at: '2026-08-14T00:00:00Z' }).action, 'unchanged');
  assert.equal(store.read().events.length, 1);

  const changed = plan({ reason: '治理策略发生变化' });
  assert.throws(
    () => store.retire(changed, { confirmPlanDigest: changed.planDigest, actor: 'reviewer_01', at: NOW }),
    error => error.code === 'ALREADY_RETIRED',
  );
});

test('计划或追加历史被篡改时失败关闭', t => {
  const store = storeContext(t);
  const ready = plan();
  const tampered = structuredClone(ready);
  tampered.reason = '被修改的理由';
  assert.throws(
    () => store.retire(tampered, { confirmPlanDigest: ready.planDigest, actor: 'reviewer_01', at: NOW }),
    error => error.code === 'PLAN_TAMPERED',
  );

  store.retire(ready, { confirmPlanDigest: ready.planDigest, actor: 'reviewer_01', at: NOW });
  const ledger = JSON.parse(fs.readFileSync(store.filePath, 'utf8'));
  ledger.events[0].reason = '篡改历史';
  fs.writeFileSync(store.filePath, JSON.stringify(ledger));
  assert.throws(() => store.read(), error => error.code === 'LEDGER_TAMPERED');
});

test('恢复只追加事件并进入待复评，不自动恢复可信或删除既有记录', t => {
  const store = storeContext(t);
  const ready = plan();
  store.retire(ready, { confirmPlanDigest: ready.planDigest, actor: 'reviewer_01', at: NOW });
  const restored = store.restore(SKILL, { actor: 'reviewer_02', reason: '业务需要重新启用并重新评估', at: '2026-08-15T00:00:00Z' });
  assert.equal(restored.action, 'restored');
  assert.equal(restored.status.state, 'active_pending_revalidation');
  assert.equal(restored.status.allowsNewDeployments, false);
  assert.equal(restored.status.existingLocks, 'preserved_for_explanation');
  assert.equal(store.read().events.length, 2);
  assert.equal(store.restore(SKILL, { actor: 'reviewer_02', reason: '重复恢复', at: '2026-08-16T00:00:00Z' }).action, 'unchanged');
  assert.equal(store.read().events.length, 2);
});

test('计划与台账拒绝路径、邮箱及私密字段，模块不包含网络或执行能力', t => {
  assert.throws(() => plan({ reason: '联系 owner@example.com' }), error => error.code === 'PRIVATE_VALUE_FORBIDDEN');
  assert.throws(() => plan({ dependencies: dependencies({ projects: ['/Users/private/project'] }) }), error => error.code === 'INVALID_IDENTITY');
  const store = storeContext(t);
  const ready = plan();
  assert.throws(
    () => store.retire(ready, { confirmPlanDigest: ready.planDigest, actor: 'owner@example.com', at: NOW }),
    error => error.code === 'INVALID_IDENTITY',
  );
  const source = fs.readFileSync(new URL('../dist-src/skillops/scripts/lib/retirement.mjs', import.meta.url), 'utf8');
  for (const forbidden of ['child_process', 'fetch(', 'http:', 'https:', 'process.env', 'eval(', 'Function(', 'import(']) {
    assert.equal(source.includes(forbidden), false, `retirement ledger must not contain ${forbidden}`);
  }
});

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  OrganizationGovernanceStore,
  OrganizationGovernanceStoreError,
} from '../lib/organization-governance-store.mjs';

const NOW = '2026-08-13T10:00:00.000Z';

function context(t, options = {}) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'skillops-org-store-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const filePath = path.join(root, 'state', 'organization.json');
  return { root, filePath, store: new OrganizationGovernanceStore(filePath, options) };
}

function createOrganization(operationId = 'op_create_org') {
  return {
    schemaVersion: 1,
    operationId,
    type: 'organization.created',
    occurredAt: NOW,
    actorPrincipalId: 'principal:owner',
    organizationId: 'org_yongle',
    subject: { organizationId: 'org_yongle' },
    payload: { organization: { organizationId: 'org_yongle', name: '永乐教育训练营' } },
  };
}

function createProject(operationId = 'op_create_project') {
  return {
    schemaVersion: 1,
    operationId,
    type: 'project.created',
    occurredAt: NOW,
    actorPrincipalId: 'principal:owner',
    organizationId: 'org_yongle',
    subject: { projectId: 'project_camp' },
    payload: { project: { projectId: 'project_camp', name: '首期训练营' } },
  };
}

test('原子追加、revision CAS 与重启重放保持一致', t => {
  const { filePath, store } = context(t);
  const empty = store.read();
  assert.match(empty.revision, /^sha256:[a-f0-9]{64}$/);
  const first = store.append(createOrganization(), { expectedRevision: empty.revision, now: NOW });
  assert.equal(first.action, 'appended');
  assert.notEqual(first.revision, empty.revision);
  assert.equal(first.projection.organizations.org_yongle.name, '永乐教育训练营');

  const reopened = new OrganizationGovernanceStore(filePath);
  assert.deepEqual(reopened.read(), store.read());
  assert.deepEqual(reopened.project(), first.projection);
  const second = reopened.append(createProject(), { expectedRevision: first.revision, now: NOW });
  assert.equal(second.projection.projects.project_camp.name, '首期训练营');
  assert.throws(
    () => store.append({ ...createProject('op_stale'), subject: { projectId: 'project_stale' }, payload: { project: { projectId: 'project_stale', name: '旧版本写入' } } }, { expectedRevision: first.revision, now: NOW }),
    error => error instanceof OrganizationGovernanceStoreError && error.code === 'REVISION_CONFLICT',
  );
  assert.equal(store.read().events.length, 2);
});

test('重复 operation 幂等但仍需要当前 revision，不同摘要冲突', t => {
  const { store } = context(t);
  const first = store.append(createOrganization(), { expectedRevision: store.read().revision, now: NOW });
  const replayed = store.append(createOrganization(), { expectedRevision: first.revision, now: NOW });
  assert.equal(replayed.action, 'replayed');
  assert.equal(replayed.revision, first.revision);
  assert.equal(store.read().events.length, 1);
  assert.throws(
    () => store.append({ ...createOrganization(), payload: { organization: { organizationId: 'org_yongle', name: '篡改名称' } } }, { expectedRevision: first.revision, now: NOW }),
    error => error.code === 'OPERATION_CONFLICT',
  );
});

test('外部没有写入入口，已有历史只能经公开 append + CAS 扩展', t => {
  const { store } = context(t);
  const first = store.append(createOrganization(), { expectedRevision: store.read().revision, now: NOW });
  assert.equal(store.write, undefined);
  assert.equal(store.read().events.length, 1);
  const second = store.append(createProject(), { expectedRevision: first.revision, now: NOW });
  assert.equal(second.action, 'appended');
  assert.equal(store.read().events.length, 2);
});

test('篡改、事件数量、单事件和台账大小限制均失败关闭', t => {
  const { filePath, store } = context(t);
  store.append(createOrganization(), { expectedRevision: store.read().revision, now: NOW });
  const original = fs.readFileSync(filePath, 'utf8');
  const tampered = JSON.parse(original);
  tampered.events[0].payload.organization.name = '被篡改';
  fs.writeFileSync(filePath, JSON.stringify(tampered));
  assert.throws(() => store.read(), error => ['REVISION_MISMATCH', 'INVALID_EVENT_LOG'].includes(error.code));
  fs.writeFileSync(filePath, original);

  const limitedCount = new OrganizationGovernanceStore(filePath, { maxEvents: 1 });
  assert.throws(() => limitedCount.append(createProject(), { expectedRevision: limitedCount.read().revision, now: NOW }), error => error.code === 'EVENT_LIMIT_EXCEEDED');
  const limitedEvent = new OrganizationGovernanceStore(filePath, { maxEventBytes: 128 });
  assert.throws(() => limitedEvent.read(), error => error.code === 'EVENT_TOO_LARGE');
  const limitedFile = new OrganizationGovernanceStore(filePath, { maxStoreBytes: 32 });
  assert.throws(() => limitedFile.read(), error => error.code === 'STORE_TOO_LARGE');
});

test('符号链接、目录目标和残留写锁失败关闭', t => {
  const { root } = context(t);
  const target = path.join(root, 'target.json');
  fs.writeFileSync(target, '{}');
  const linked = path.join(root, 'linked.json');
  fs.symlinkSync(target, linked);
  assert.throws(() => new OrganizationGovernanceStore(linked).read(), error => error.code === 'UNSAFE_STORE_PATH');

  const directory = path.join(root, 'directory.json');
  fs.mkdirSync(directory);
  assert.throws(() => new OrganizationGovernanceStore(directory).read(), error => error.code === 'UNSAFE_STORE_PATH');

  const filePath = path.join(root, 'locked.json');
  fs.writeFileSync(`${filePath}.lock`, 'busy', { mode: 0o600 });
  const locked = new OrganizationGovernanceStore(filePath);
  assert.throws(() => locked.append(createOrganization(), { expectedRevision: locked.read().revision, now: NOW }), error => error.code === 'STORE_BUSY');
  assert.equal(fs.existsSync(filePath), false);
});

test('符号链接父目录在构造时失败关闭且不会向链接目标写入', t => {
  const { root } = context(t);
  const outside = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'skillops-org-outside-'));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  const stateLink = path.join(root, 'linked-state');
  fs.symlinkSync(outside, stateLink, 'dir');
  const escapedLedger = path.join(stateLink, 'organization.json');
  assert.throws(
    () => new OrganizationGovernanceStore(escapedLedger),
    error => error.code === 'UNSAFE_STORE_PATH',
  );
  assert.equal(fs.existsSync(path.join(outside, 'organization.json')), false);
});

test('系统临时目录别名前缀可用，但其下嵌套符号链接仍零写', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skillops-org-tmp-alias-'));
  t.after(() => fs.rmSync(fs.realpathSync(root), { recursive: true, force: true }));
  const direct = new OrganizationGovernanceStore(path.join(root, 'direct', 'organization.json'));
  assert.equal(direct.read().events.length, 0);
  const outside = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'skillops-org-alias-outside-'));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  fs.symlinkSync(outside, path.join(root, 'linked-state'), 'dir');
  assert.throws(
    () => new OrganizationGovernanceStore(path.join(root, 'linked-state', 'organization.json')),
    error => error.code === 'UNSAFE_STORE_PATH',
  );
  assert.equal(fs.existsSync(path.join(outside, 'organization.json')), false);
});

test('原子写故障删除临时文件且不污染已提交历史', t => {
  let failRename = false;
  const { filePath, store } = context(t, {
    faultInjector(phase) {
      if (failRename && phase === 'beforeRename') throw new Error('injected rename failure');
    },
  });
  const first = store.append(createOrganization(), { expectedRevision: store.read().revision, now: NOW });
  const before = fs.readFileSync(filePath, 'utf8');
  failRename = true;
  assert.throws(() => store.append(createProject(), { expectedRevision: first.revision, now: NOW }), /injected rename failure/);
  assert.equal(fs.readFileSync(filePath, 'utf8'), before);
  assert.equal(fs.readdirSync(path.dirname(filePath)).some(name => name.endsWith('.tmp') || name.endsWith('.lock')), false);
});

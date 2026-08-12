/* managed-lock-migration.mjs — Legacy Lock v1 -> Managed Lock v2 台账迁移
 *
 * 安全边界：
 * - plan 阶段只读取并核验台账/目录，不写文件、不复制/删除技能、不执行代码、不联网。
 * - commit 只原子替换 managed-lock-v2.json；legacy lock.json 原样保留为恢复依据。
 * - Release 必须来自显式 Registry resolution，且其规范身份、来源、包和信任快照全部绑定计划摘要。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { createPackageManifest } from '../../../../trusted-supply/lib/package.mjs';
import { canonicalDigest, createReleaseId, normalizeSkillId } from '../../../../trusted-supply/lib/registry-identity.mjs';
import { artifactFingerprint, lockPath, readDeploymentLock } from './deploy.mjs';
import {
  MANAGED_INSTALL_LOCK_SCHEMA_VERSION,
  managedInstallLockPath,
  readManagedInstallLock,
} from './managed-installer.mjs';

export const MANAGED_LOCK_MIGRATION_SCHEMA_VERSION = 1;

const DIGEST = /^sha256:[a-f0-9]{64}$/;
const HEX_DIGEST = /^[a-f0-9]{64}$/;
const RELEASE_ID = /^rel_[a-f0-9]{64}$/;
const SOURCE_ID = /^src_[a-f0-9]{64}$/;
const REGISTRY_SOURCE_ID = /^regsrc_[a-zA-Z0-9][a-zA-Z0-9_-]*$/;
const INSTALLATION_ID = /^inst_[a-zA-Z0-9][a-zA-Z0-9_-]*$/;
const OPERATION_ID = /^op_[a-zA-Z0-9][a-zA-Z0-9_-]*$/;
const RELEASE_STATES = new Set(['published', 'superseded', 'withdrawn', 'revoked']);

export class ManagedLockMigrationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ManagedLockMigrationError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new ManagedLockMigrationError(code, message);
}

function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('INVALID_INPUT', `${label} 必须是对象`);
  return value;
}

function text(value, label, pattern) {
  if (typeof value !== 'string' || !value.trim()) fail('INVALID_INPUT', `${label} 必须是非空字符串`);
  const normalized = value.trim().normalize('NFC');
  if (pattern && !pattern.test(normalized)) fail('INVALID_IDENTITY', `${label} 格式无效`);
  return normalized;
}

function timestamp(value, label) {
  const normalized = text(value, label);
  const milliseconds = Date.parse(normalized);
  if (!Number.isFinite(milliseconds)) fail('INVALID_EVIDENCE', `${label} 必须是有效日期时间`);
  return new Date(milliseconds).toISOString();
}

function nowValue(now) {
  const value = typeof now === 'function' ? now() : (now ?? new Date());
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) fail('INVALID_NOW', 'now 必须是有效日期时间');
  return date;
}

function inside(parent, child) {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function trustSnapshot(input, at, feedCursor) {
  object(input, 'trustSnapshot');
  const result = {
    policyVersion: text(input.policyVersion, 'trustSnapshot.policyVersion'),
    reviewValidUntil: timestamp(input.reviewValidUntil, 'trustSnapshot.reviewValidUntil'),
    feedCursor: text(input.feedCursor, 'trustSnapshot.feedCursor'),
  };
  if (result.feedCursor !== String(feedCursor)) fail('REGISTRY_EVIDENCE_MISMATCH', 'trustSnapshot.feedCursor 与 Registry resolution 不一致');
  for (const field of ['evalValidUntil', 'packageAuditValidUntil', 'licenseValidUntil']) {
    if (input[field] !== undefined && input[field] !== null && input[field] !== '') result[field] = timestamp(input[field], `trustSnapshot.${field}`);
  }
  for (const field of ['reviewDigest', 'evalDigest', 'packageAuditDigest', 'licenseDigest']) {
    if (input[field] !== undefined) result[field] = text(input[field], `trustSnapshot.${field}`, DIGEST);
  }
  for (const field of ['reviewValidUntil', 'evalValidUntil', 'packageAuditValidUntil', 'licenseValidUntil']) {
    if (result[field] && Date.parse(result[field]) <= at.getTime()) fail('EVIDENCE_STALE', `${field} 已过期，拒绝迁移`);
  }
  return result;
}

function currentFingerprint(directory, kind) {
  if (!fs.existsSync(directory)) fail(kind === 'source' ? 'SOURCE_MISSING' : 'TARGET_MISSING', `${kind === 'source' ? '技能源' : '部署目标'}不存在`);
  try {
    return artifactFingerprint(directory);
  } catch (error) {
    fail(kind === 'source' ? 'SOURCE_UNREADABLE' : 'TARGET_UNREADABLE', `${kind === 'source' ? '技能源' : '部署目标'}无法核验：${error.message}`);
  }
}

function targetPackageDigest(directory) {
  if (!fs.existsSync(directory)) fail('TARGET_MISSING', '部署目标不存在');
  const files = [];
  const walk = (current, prefix = '') => {
    let entries;
    try {
      const stat = fs.lstatSync(current);
      if (!stat.isDirectory() || stat.isSymbolicLink()) fail('TARGET_UNREADABLE', '部署目标必须是普通目录');
      entries = fs.readdirSync(current, { withFileTypes: true })
        .sort((left, right) => Buffer.compare(Buffer.from(left.name), Buffer.from(right.name)));
    } catch (error) {
      if (error instanceof ManagedLockMigrationError) throw error;
      fail('TARGET_UNREADABLE', `部署目标无法读取：${error.message}`);
    }
    for (const entry of entries) {
      const absolute = path.join(current, entry.name);
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      let stat;
      try { stat = fs.lstatSync(absolute); }
      catch (error) { fail('TARGET_UNREADABLE', `部署目标文件无法读取：${relative}（${error.message}）`); }
      if (stat.isSymbolicLink()) fail('TARGET_UNREADABLE', `部署目标包含符号链接：${relative}`);
      if (stat.isDirectory()) walk(absolute, relative);
      else if (stat.isFile()) {
        let content;
        try { content = fs.readFileSync(absolute); }
        catch (error) { fail('TARGET_UNREADABLE', `部署目标文件无法读取：${relative}（${error.message}）`); }
        files.push({ path: relative, content, executable: Boolean(stat.mode & 0o111) });
      } else fail('TARGET_UNREADABLE', `部署目标包含特殊文件：${relative}`);
    }
  };
  walk(directory);
  try { return createPackageManifest(files).packageDigest; }
  catch (error) { fail('TARGET_PACKAGE_INVALID', `部署目标无法形成规范技能包：${error.message}`); }
}

function normalizeRegistryMapping(mapping, at) {
  const resolution = object(mapping.registryResolution, 'registryResolution');
  const release = object(resolution.release, 'registryResolution.release');
  const packageValue = object(release.package, 'registryResolution.release.package');
  const skillId = text(release.skillId, 'release.skillId');
  let canonicalSkillId;
  try { canonicalSkillId = normalizeSkillId(skillId); } catch { fail('INVALID_RELEASE_IDENTITY', 'Registry skillId 不是 canonical identity'); }
  if (canonicalSkillId !== skillId) fail('INVALID_RELEASE_IDENTITY', 'Registry skillId 不是 canonical identity');
  const version = text(release.version, 'release.version');
  const releaseId = text(release.releaseId, 'release.releaseId', RELEASE_ID);
  const packageDigest = text(packageValue.packageDigest, 'release.package.packageDigest', DIGEST);
  const manifestDigest = text(packageValue.manifestDigest, 'release.package.manifestDigest', DIGEST);
  let expectedReleaseId;
  try { expectedReleaseId = createReleaseId({ skillId, version, packageDigest }); }
  catch { fail('INVALID_RELEASE_IDENTITY', 'Registry Release 身份字段无效'); }
  if (releaseId !== expectedReleaseId) fail('RELEASE_ID_MISMATCH', 'releaseId 与 canonical Release 身份不一致');
  const releaseStatus = text(resolution.status, 'registryResolution.status');
  if (!RELEASE_STATES.has(releaseStatus)) fail('INVALID_RELEASE_STATUS', 'Registry Release 状态无效');
  if (releaseStatus === 'withdrawn') fail('RELEASE_WITHDRAWN', 'Release 已撤回，拒绝迁移');
  if (releaseStatus === 'revoked') fail('RELEASE_REVOKED', 'Release 已吊销，拒绝迁移');
  const registrySourceId = text(resolution.registrySourceId, 'registryResolution.registrySourceId', REGISTRY_SOURCE_ID);
  const feedCursor = text(resolution.feedCursor, 'registryResolution.feedCursor');
  const sourceId = text(mapping.sourceId, 'sourceId', SOURCE_ID);
  if (!Array.isArray(release.sourceRefs) || !release.sourceRefs.includes(sourceId)) {
    fail('SOURCE_MAPPING_MISMATCH', '显式 sourceId 不在 Registry Release 的 sourceRefs 中');
  }
  const trust = trustSnapshot(mapping.trustSnapshot, at, feedCursor);
  const verifiedTargetPackageDigest = text(mapping.verifiedTargetPackageDigest, 'verifiedTargetPackageDigest', DIGEST);
  if (verifiedTargetPackageDigest !== packageDigest) fail('TARGET_PACKAGE_MISMATCH', '已校验目标包摘要与 Registry Release 包摘要不一致');
  return {
    skillId, releaseId, version, packageDigest, manifestDigest, sourceId,
    registrySourceId, feedCursor, releaseStatus, trustSnapshot: trust,
    verifiedTargetPackageDigest,
  };
}

function readState(targetRoot) {
  const legacyFile = lockPath(targetRoot);
  if (!fs.existsSync(legacyFile)) fail('LEGACY_LOCK_MISSING', 'Legacy Lock v1 不存在');
  let legacy;
  let managed;
  try { legacy = readDeploymentLock(targetRoot, { missingOk: false }); }
  catch (error) { fail('LEGACY_LOCK_INVALID', error.message); }
  try { managed = readManagedInstallLock(targetRoot); }
  catch (error) { fail('MANAGED_LOCK_INVALID', error.message); }
  return {
    legacy,
    managed,
    managedExists: fs.existsSync(managedInstallLockPath(targetRoot)),
    legacyLockDigest: canonicalDigest(legacy),
    managedLockDigest: canonicalDigest(managed),
  };
}

function migrationRecords(ledger) {
  if (ledger.migrations === undefined) return [];
  if (!Array.isArray(ledger.migrations)) fail('MANAGED_LOCK_INVALID', 'Lock v2 migrations 必须是数组');
  return ledger.migrations;
}

/**
 * 生成只读迁移计划。mappings 必须逐条以 legacyKey 绑定 verified Registry resolution；
 * 不会按 legacy skill/name/candidate 字段搜索或猜测 Release。
 */
export function createManagedLockMigrationPlan(input, { now } = {}) {
  object(input, '迁移输入');
  const operationId = text(input.operationId, 'operationId', OPERATION_ID);
  if (!input.targetRoot) fail('TARGET_ROOT_REQUIRED', '缺少 targetRoot');
  const targetRoot = path.resolve(input.targetRoot);
  const at = nowValue(now);
  const state = readState(targetRoot);
  const existingOperation = migrationRecords(state.managed).find(row => row?.operationId === operationId);
  if (existingOperation) fail('OPERATION_ALREADY_COMMITTED', 'operationId 已有迁移记录，请重放原计划而不是重新规划');
  if (!Array.isArray(input.mappings) || input.mappings.length < 1) fail('MAPPING_REQUIRED', '每条 Legacy deployment 都必须提供 Registry 映射');
  const legacyKeys = Object.keys(state.legacy.deployments).sort();
  if (input.mappings.length !== legacyKeys.length) fail('MAPPING_REQUIRED', 'Registry 映射数量必须与 Legacy deployment 数量一致');
  const byKey = new Map();
  for (const mapping of input.mappings) {
    object(mapping, 'mapping');
    const legacyKey = text(mapping.legacyKey, 'mapping.legacyKey');
    if (byKey.has(legacyKey)) fail('DUPLICATE_MAPPING', `Legacy deployment ${legacyKey} 被重复映射`);
    byKey.set(legacyKey, mapping);
  }
  if (legacyKeys.some(key => !byKey.has(key)) || [...byKey.keys()].some(key => !state.legacy.deployments[key])) {
    fail('MAPPING_REQUIRED', '每条且仅每条 Legacy deployment 必须有精确 legacyKey 映射');
  }

  const installationIds = new Set();
  const targetPaths = new Set();
  const entries = legacyKeys.map(legacyKey => {
    const legacy = object(state.legacy.deployments[legacyKey], `legacy deployment ${legacyKey}`);
    const mapping = byKey.get(legacyKey);
    const installationId = text(mapping.installationId, 'installationId', INSTALLATION_ID);
    if (installationIds.has(installationId)) fail('DUPLICATE_INSTALLATION', 'installationId 不能重复');
    installationIds.add(installationId);
    const targetPath = path.resolve(text(legacy.targetPath, 'legacy.targetPath'));
    if (!inside(targetRoot, targetPath) || targetPath === targetRoot || targetPaths.has(targetPath)) fail('INVALID_TARGET', 'Legacy targetPath 无效或重复');
    targetPaths.add(targetPath);
    const sourcePath = path.resolve(text(legacy.sourcePath, 'legacy.sourcePath'));
    const expectedSourceFingerprint = text(legacy.sourceFingerprint, 'legacy.sourceFingerprint', HEX_DIGEST);
    const expectedTargetFingerprint = text(legacy.deployedFingerprint, 'legacy.deployedFingerprint', HEX_DIGEST);
    const actualSourceFingerprint = currentFingerprint(sourcePath, 'source');
    if (actualSourceFingerprint !== expectedSourceFingerprint) fail('SOURCE_DRIFT', `Legacy deployment ${legacyKey} 的技能源已漂移`);
    const actualTargetFingerprint = currentFingerprint(targetPath, 'target');
    if (actualTargetFingerprint !== expectedTargetFingerprint) fail('TARGET_DRIFT', `Legacy deployment ${legacyKey} 的部署目标已漂移`);
    const registry = normalizeRegistryMapping(mapping, at);
    const actualTargetPackageDigest = targetPackageDigest(targetPath);
    if (actualTargetPackageDigest !== registry.verifiedTargetPackageDigest || actualTargetPackageDigest !== registry.packageDigest) {
      fail('TARGET_PACKAGE_MISMATCH', `Legacy deployment ${legacyKey} 的目标内容与 Registry Release 包不一致`);
    }
    if (legacy.skillId && legacy.skillId !== registry.skillId) fail('LEGACY_IDENTITY_MISMATCH', `Legacy deployment ${legacyKey} 的 skillId 与 Registry 映射不一致`);
    const existing = state.managed.installations[installationId];
    if (existing) fail('INSTALLATION_CONFLICT', `installationId ${installationId} 已存在于 Lock v2`);
    const targetOwner = Object.values(state.managed.installations).find(row => row?.targetPath && path.resolve(row.targetPath) === targetPath);
    if (targetOwner) fail('TARGET_CONFLICT', `目标已由 Lock v2 installation ${targetOwner.installationId ?? 'unknown'} 管理`);
    return {
      legacyKey,
      installationId,
      targetPath,
      legacyFingerprints: { source: actualSourceFingerprint, target: actualTargetFingerprint },
      actualTargetPackageDigest,
      registry,
    };
  });

  const body = {
    schemaVersion: MANAGED_LOCK_MIGRATION_SCHEMA_VERSION,
    action: 'managed-lock.migrate.plan',
    operationId,
    targetRoot,
    checkedAt: at.toISOString(),
    legacyLockDigest: state.legacyLockDigest,
    managedLockDigest: state.managedLockDigest,
    managedLockExisted: state.managedExists,
    entries,
  };
  const planDigest = canonicalDigest(body);
  return {
    ...body,
    status: 'ready',
    planDigest,
    summary: { deploymentCount: entries.length, skillIds: entries.map(row => row.registry.skillId).sort() },
    requiredConfirmations: [{ kind: 'plan_digest', value: planDigest, messageZh: '迁移确认必须绑定当前计划摘要' }],
    preservation: { legacyLockPath: lockPath(targetRoot), legacyLockUnchanged: true, migrationRecordAppendOnly: true },
  };
}

function assertPlan(plan) {
  object(plan, 'plan');
  if (plan.schemaVersion !== MANAGED_LOCK_MIGRATION_SCHEMA_VERSION || plan.action !== 'managed-lock.migrate.plan' || plan.status !== 'ready') {
    fail('PLAN_NOT_READY', '只有通过预检的迁移计划才能提交');
  }
  text(plan.operationId, 'plan.operationId', OPERATION_ID);
  text(plan.planDigest, 'plan.planDigest', DIGEST);
  const body = {
    schemaVersion: plan.schemaVersion,
    action: plan.action,
    operationId: plan.operationId,
    targetRoot: plan.targetRoot,
    checkedAt: plan.checkedAt,
    legacyLockDigest: plan.legacyLockDigest,
    managedLockDigest: plan.managedLockDigest,
    managedLockExisted: plan.managedLockExisted,
    entries: plan.entries,
  };
  if (canonicalDigest(body) !== plan.planDigest) fail('PLAN_TAMPERED', '迁移计划摘要校验失败');
}

function writeManagedLedgerAtomic(targetRoot, ledger, fault) {
  const control = path.join(targetRoot, '.skillops');
  const stat = fs.lstatSync(control);
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail('UNSAFE_CONTROL_DIRECTORY', '.skillops 必须是普通目录');
  const file = managedInstallLockPath(targetRoot);
  const temporary = path.join(control, `.managed-migration-${process.pid}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.tmp`);
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(ledger, null, 2)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    if (fault) fault('before-ledger-commit');
    fs.renameSync(temporary, file);
  } catch (error) {
    if (error instanceof ManagedLockMigrationError) throw error;
    fail('MIGRATION_COMMIT_FAILED', error.message);
  } finally {
    try { fs.rmSync(temporary, { force: true }); } catch { /* 尽力清理临时文件 */ }
  }
}

/**
 * 明确确认后仅迁移台账。提交前重新核验 v1/v2 摘要及源/目标指纹，任何部分失败均不写。
 */
export function commitManagedLockMigration(input, { clock, fault } = {}) {
  object(input, '提交输入');
  const plan = input.plan;
  assertPlan(plan);
  if (input.confirmPlanDigest !== plan.planDigest) fail('PLAN_CONFIRMATION_REQUIRED', '确认值必须等于当前 planDigest');
  const targetRoot = path.resolve(input.targetRoot || '');
  if (!input.targetRoot) fail('TARGET_ROOT_REQUIRED', '缺少 targetRoot');
  if (targetRoot !== plan.targetRoot) fail('TARGET_ROOT_MISMATCH', '提交 targetRoot 与迁移计划不一致');
  const state = readState(targetRoot);
  const records = migrationRecords(state.managed);
  const previousOperation = records.find(row => row?.operationId === plan.operationId);
  if (previousOperation) {
    if (previousOperation.planDigest !== plan.planDigest) fail('OPERATION_CONFLICT', '相同 operationId 已绑定不同 planDigest');
    return {
      action: 'unchanged', operationId: plan.operationId, planDigest: plan.planDigest,
      lockPath: managedInstallLockPath(targetRoot), legacyLockPath: lockPath(targetRoot),
    };
  }
  if (state.legacyLockDigest !== plan.legacyLockDigest) fail('LEGACY_LOCK_CHANGED', 'Legacy Lock v1 在计划后发生变化');
  if (state.managedLockDigest !== plan.managedLockDigest || state.managedExists !== plan.managedLockExisted) fail('MANAGED_LOCK_CHANGED', 'Managed Lock v2 在计划后发生变化');
  const committedAt = nowValue(clock);
  for (const entry of plan.entries) {
    const legacy = state.legacy.deployments[entry.legacyKey];
    if (!legacy) fail('LEGACY_LOCK_CHANGED', `Legacy deployment ${entry.legacyKey} 已不存在`);
    const source = currentFingerprint(path.resolve(legacy.sourcePath), 'source');
    if (source !== entry.legacyFingerprints.source || source !== legacy.sourceFingerprint) fail('SOURCE_DRIFT', `Legacy deployment ${entry.legacyKey} 的技能源已漂移`);
    const target = currentFingerprint(path.resolve(legacy.targetPath), 'target');
    if (target !== entry.legacyFingerprints.target || target !== legacy.deployedFingerprint) fail('TARGET_DRIFT', `Legacy deployment ${entry.legacyKey} 的部署目标已漂移`);
    const actualTargetPackageDigest = targetPackageDigest(path.resolve(legacy.targetPath));
    if (actualTargetPackageDigest !== entry.actualTargetPackageDigest
      || actualTargetPackageDigest !== entry.registry.verifiedTargetPackageDigest
      || actualTargetPackageDigest !== entry.registry.packageDigest) {
      fail('TARGET_PACKAGE_MISMATCH', `Legacy deployment ${entry.legacyKey} 的目标内容与 Registry Release 包不一致`);
    }
    for (const field of ['reviewValidUntil', 'evalValidUntil', 'packageAuditValidUntil', 'licenseValidUntil']) {
      if (entry.registry.trustSnapshot[field] && Date.parse(entry.registry.trustSnapshot[field]) <= committedAt.getTime()) {
        fail('EVIDENCE_STALE', `${field} 在提交前已过期，拒绝迁移`);
      }
    }
  }
  const migratedAt = committedAt.toISOString();
  const additions = Object.fromEntries(plan.entries.map(entry => [entry.installationId, {
    schemaVersion: MANAGED_INSTALL_LOCK_SCHEMA_VERSION,
    installationId: entry.installationId,
    skillId: entry.registry.skillId,
    releaseId: entry.registry.releaseId,
    version: entry.registry.version,
    packageDigest: entry.registry.packageDigest,
    registrySourceId: entry.registry.registrySourceId,
    manifestDigest: entry.registry.manifestDigest,
    trustSnapshot: entry.registry.trustSnapshot,
    state: 'clean',
    targetPath: entry.targetPath,
    sourceFingerprint: entry.registry.packageDigest,
    deployedFingerprint: entry.registry.verifiedTargetPackageDigest,
    installedAt: migratedAt,
    planDigest: plan.planDigest,
    legacyMigration: {
      schemaVersion: 1,
      legacyKey: entry.legacyKey,
      legacyLockDigest: plan.legacyLockDigest,
      sourceFingerprint: entry.legacyFingerprints.source,
      deployedFingerprint: entry.legacyFingerprints.target,
      sourceId: entry.registry.sourceId,
    },
  }]));
  const record = {
    schemaVersion: 1,
    operationId: plan.operationId,
    planDigest: plan.planDigest,
    migratedAt,
    legacyLockDigest: plan.legacyLockDigest,
    legacyLockPreserved: true,
    entries: plan.entries.map(entry => ({
      legacyKey: entry.legacyKey,
      installationId: entry.installationId,
      skillId: entry.registry.skillId,
      releaseId: entry.registry.releaseId,
      packageDigest: entry.registry.packageDigest,
      sourceId: entry.registry.sourceId,
      manifestDigest: entry.registry.manifestDigest,
    })),
  };
  const next = {
    ...state.managed,
    schemaVersion: MANAGED_INSTALL_LOCK_SCHEMA_VERSION,
    updatedAt: migratedAt,
    installations: { ...state.managed.installations, ...additions },
    migrations: [...records, record],
  };
  writeManagedLedgerAtomic(targetRoot, next, fault);
  return {
    action: 'migrated', operationId: plan.operationId, planDigest: plan.planDigest,
    migratedCount: plan.entries.length, lockPath: managedInstallLockPath(targetRoot),
    legacyLockPath: lockPath(targetRoot), legacyLockPreserved: true,
  };
}

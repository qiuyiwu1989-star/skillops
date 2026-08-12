import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { createPackageManifest } from '../../../../trusted-supply/lib/package.mjs';
import { canonicalDigest } from '../../../../trusted-supply/lib/registry-identity.mjs';
import { createManagedLockV2 } from './managed-distribution.mjs';

export const MANAGED_INSTALL_LOCK_SCHEMA_VERSION = 2;
const CONTROL_DIR = '.skillops';
const LOCK_FILE = 'managed-lock-v2.json';
const SAFE_DIRECTORY = /^[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?$/;

export class ManagedInstallerError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ManagedInstallerError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new ManagedInstallerError(code, message);
}

function clockTime(clock) {
  const value = clock ? clock() : new Date();
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) fail('INVALID_CLOCK', 'clock 必须返回有效时间');
  return date.toISOString();
}

function ensureDirectory(directory, label, { create = false } = {}) {
  if (!fs.existsSync(directory) && create) fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  let stat;
  try { stat = fs.lstatSync(directory); } catch (error) { fail('DIRECTORY_UNAVAILABLE', `${label}不可用：${error.message}`); }
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail('UNSAFE_DIRECTORY', `${label}必须是普通目录`);
}

function inside(parent, child) {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function directoryName(value, skillId) {
  const fallback = String(skillId || '').split('/').at(-1);
  const result = value ?? fallback;
  if (typeof result !== 'string' || !SAFE_DIRECTORY.test(result)) fail('INVALID_TARGET_NAME', '目标目录名不安全');
  if (result === CONTROL_DIR) fail('RESERVED_TARGET_NAME', `目标目录不能使用保留名称 ${CONTROL_DIR}`);
  return result;
}

function walkFiles(root) {
  ensureDirectory(root, '安装目标');
  const files = [];
  const walk = (directory, prefix = '') => {
    const entries = fs.readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => Buffer.compare(Buffer.from(left.name), Buffer.from(right.name)));
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name);
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const stat = fs.lstatSync(absolute);
      if (stat.isSymbolicLink()) fail('TARGET_UNSAFE', `安装目标包含符号链接：${relative}`);
      if (stat.isDirectory()) walk(absolute, relative);
      else if (stat.isFile()) files.push({
        path: relative,
        content: fs.readFileSync(absolute),
        executable: Boolean(stat.mode & 0o111),
      });
      else fail('TARGET_UNSAFE', `安装目标包含特殊文件：${relative}`);
    }
  };
  walk(root);
  return createPackageManifest(files);
}

function targetPackageDigest(targetPath) {
  return walkFiles(targetPath).packageDigest;
}

function copyPackage(files, destination) {
  fs.mkdirSync(destination, { mode: 0o700 });
  for (const file of files) {
    const target = path.join(destination, ...file.path.split('/'));
    if (!inside(destination, target)) fail('UNSAFE_PACKAGE_PATH', `包路径越界：${file.path}`);
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    fs.writeFileSync(target, file.content, { flag: 'wx', mode: file.executable ? 0o700 : 0o600 });
  }
}

export function managedInstallLockPath(targetRoot) {
  return path.join(path.resolve(targetRoot), CONTROL_DIR, LOCK_FILE);
}

export function readManagedInstallLock(targetRoot, { missingOk = true } = {}) {
  const file = managedInstallLockPath(targetRoot);
  if (!fs.existsSync(file)) {
    if (missingOk) return { schemaVersion: MANAGED_INSTALL_LOCK_SCHEMA_VERSION, updatedAt: null, installations: {} };
    fail('LOCK_MISSING', `托管安装台账不存在：${file}`);
  }
  let value;
  try { value = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (error) { fail('LOCK_INVALID', `托管安装台账无法读取：${error.message}`); }
  if (value?.schemaVersion !== MANAGED_INSTALL_LOCK_SCHEMA_VERSION
    || !value.installations || typeof value.installations !== 'object' || Array.isArray(value.installations)) {
    fail('LOCK_INVALID', '托管安装台账格式不受支持');
  }
  return structuredClone(value);
}

function prepareLockWrite(targetRoot, value) {
  const control = path.join(targetRoot, CONTROL_DIR);
  ensureDirectory(control, '托管控制目录', { create: true });
  const file = path.join(control, LOCK_FILE);
  const temporary = path.join(control, `.managed-lock-${process.pid}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.tmp`);
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  return { file, temporary };
}

function invokeFault(fault, point) {
  if (fault) fault(point);
}

/**
 * 从已验证 CAS 安装明确 Release。该函数不联网、不执行包内代码，也不解析 latest。
 * `fault` 仅用于故障注入测试；它只能让事务失败，不能放宽任何安全门。
 */
export function installManagedRelease(input, { clock, fault } = {}) {
  if (!input || typeof input !== 'object') fail('INVALID_INPUT', '缺少托管安装输入');
  const { plan, packageStore } = input;
  if (!plan?.lockDraft || !['ready', 'unchanged'].includes(plan.status)) fail('PLAN_NOT_READY', '安装计划未通过预检');
  if (input.confirmPlanDigest !== plan.planDigest) fail('PLAN_CONFIRMATION_REQUIRED', '确认值必须绑定当前 planDigest');
  if (!packageStore || typeof packageStore.verify !== 'function' || typeof packageStore.readFiles !== 'function') {
    fail('PACKAGE_STORE_REQUIRED', '必须提供只读且可验证的 PackageStore');
  }
  const targetRoot = path.resolve(input.targetRoot || '');
  if (!input.targetRoot) fail('TARGET_ROOT_REQUIRED', '缺少安装目标根目录');
  ensureDirectory(targetRoot, '安装目标根目录', { create: true });
  const name = directoryName(input.directoryName, plan.subject?.skillId);
  const targetPath = path.join(targetRoot, name);
  if (!inside(targetRoot, targetPath) || targetPath === targetRoot) fail('TARGET_OUTSIDE_ROOT', '安装目标必须位于目标根目录内');
  if (typeof packageStore.root === 'string') {
    const casRoot = path.resolve(packageStore.root);
    if (inside(casRoot, targetPath) || inside(targetPath, casRoot)) {
      fail('TARGET_OVERLAPS_CAS', '安装目标不能与 CAS 存储目录重叠');
    }
  }

  const installationId = input.installationId;
  const currentLedger = readManagedInstallLock(targetRoot);
  const previous = currentLedger.installations[installationId] ?? null;
  const targetExists = fs.existsSync(targetPath);
  if (previous) {
    if (path.resolve(previous.targetPath) !== targetPath) fail('LOCK_TARGET_MISMATCH', 'installationId 已绑定其他目标');
    if (!targetExists) fail('TARGET_MISSING', '台账中的安装目标已丢失');
    const currentDigest = targetPackageDigest(targetPath);
    if (currentDigest !== previous.deployedFingerprint) fail('TARGET_DRIFT', '安装目标发生本地修改，拒绝覆盖');
    if (previous.planDigest === plan.planDigest && previous.packageDigest === plan.subject.packageDigest) {
      return { action: 'unchanged', installationId, targetPath, lock: previous, lockPath: managedInstallLockPath(targetRoot) };
    }
    const expectedFrom = plan.changes?.[0]?.from;
    if (!expectedFrom || expectedFrom.releaseId !== previous.releaseId || expectedFrom.packageDigest !== previous.packageDigest) {
      fail('UPDATE_BASE_MISMATCH', '更新计划与当前 Lock v2 不一致');
    }
  } else if (targetExists) {
    fail('UNKNOWN_TARGET', '拒绝覆盖未被 Lock v2 管理的目标目录');
  }

  let record;
  let files;
  try {
    record = packageStore.verify(plan.subject.packageDigest);
    files = packageStore.readFiles(plan.subject.packageDigest);
  } catch (error) {
    fail('PACKAGE_VERIFY_FAILED', `CAS 包校验失败：${error.message}`);
  }
  if (record.packageDigest !== plan.subject.packageDigest
    || canonicalDigest(record.manifest) !== plan.lockDraft.manifestDigest) {
    fail('PACKAGE_BINDING_MISMATCH', 'CAS 包与安装计划绑定不一致');
  }

  const parent = path.dirname(targetPath);
  const stage = fs.mkdtempSync(path.join(parent, `.${name}-managed-stage-`));
  fs.rmdirSync(stage);
  let backup = null;
  let installed = false;
  let lockWrite = null;
  try {
    copyPackage(files, stage);
    const deployedFingerprint = targetPackageDigest(stage);
    if (deployedFingerprint !== record.packageDigest) fail('STAGE_VERIFY_FAILED', '暂存目录复核与 CAS 包摘要不一致');
    const installedAt = clockTime(clock);
    const lock = createManagedLockV2(plan, {
      installationId,
      targetPath,
      sourceFingerprint: record.packageDigest,
      deployedFingerprint,
      installedAt,
    });
    const nextLedger = {
      schemaVersion: MANAGED_INSTALL_LOCK_SCHEMA_VERSION,
      updatedAt: installedAt,
      installations: { ...currentLedger.installations, [installationId]: lock },
    };
    lockWrite = prepareLockWrite(targetRoot, nextLedger);
    invokeFault(fault, 'before-target-swap');
    if (targetExists) {
      backup = path.join(parent, `.${name}-managed-backup-${process.pid}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`);
      fs.renameSync(targetPath, backup);
    }
    fs.renameSync(stage, targetPath);
    installed = true;
    invokeFault(fault, 'before-lock-commit');
    fs.renameSync(lockWrite.temporary, lockWrite.file);
    lockWrite.temporary = null;
    if (backup) {
      try { fs.rmSync(backup, { recursive: true, force: true }); }
      catch { /* 目标与 Lock 已原子提交，遗留备份比回滚成不一致状态更安全 */ }
    }
    return {
      action: previous ? 'updated' : 'installed',
      installationId,
      targetPath,
      releaseId: plan.subject.releaseId,
      packageDigest: plan.subject.packageDigest,
      planDigest: plan.planDigest,
      lock,
      lockPath: lockWrite.file,
    };
  } catch (error) {
    if (installed && fs.existsSync(targetPath)) fs.rmSync(targetPath, { recursive: true, force: true });
    if (backup && fs.existsSync(backup)) {
      try { fs.renameSync(backup, targetPath); } catch (restoreError) {
        fail('ROLLBACK_FAILED', `${error.message}；旧目标恢复失败：${restoreError.message}`);
      }
    }
    if (error instanceof ManagedInstallerError) throw error;
    fail('INSTALL_FAILED', error.message);
  } finally {
    try { if (fs.existsSync(stage)) fs.rmSync(stage, { recursive: true, force: true }); } catch { /* 尽力清理 */ }
    try { if (lockWrite?.temporary) fs.rmSync(lockWrite.temporary, { force: true }); } catch { /* 尽力清理 */ }
  }
}

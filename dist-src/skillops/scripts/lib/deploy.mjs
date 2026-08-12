/* deploy.mjs — 技能部署、lockfile 与漂移检查（零依赖）
 *
 * 部署目标：<target-root>/<source-dir-basename>/
 * 台账：    <target-root>/.skillops/lock.json
 *
 * 安全原则：
 * - 目标目录不是本 lock 管理的，绝不覆盖。
 * - 目标内容偏离上次部署指纹，绝不覆盖。
 * - 先复制到同盘临时目录，再 rename；lock 也用临时文件原子替换。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const LOCK_SCHEMA_VERSION = 1;
const CONTROL_DIR = '.skillops';
const LOCK_FILE = 'lock.json';

function inside(parent, child) {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel));
}

function walkArtifact(root, dir = root, rows = []) {
  const entries = fs.readdirSync(dir, { withFileTypes: true })
    .filter(e => e.name !== '.DS_Store' && e.name !== '.git')
    .sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    const rel = path.relative(root, full).split(path.sep).join('/');
    const st = fs.lstatSync(full);
    if (st.isDirectory()) {
      rows.push(`d\0${rel}\0`);
      walkArtifact(root, full, rows);
    } else if (st.isFile()) {
      rows.push(`f\0${rel}\0${crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex')}\0`);
    } else if (st.isSymbolicLink()) {
      throw new Error(`技能包含符号链接，拒绝部署：${full}`);
    } else {
      throw new Error(`技能包含不支持的文件类型：${full}`);
    }
  }
  return rows;
}

export function artifactFingerprint(dir) {
  const st = fs.lstatSync(dir);
  if (!st.isDirectory() || st.isSymbolicLink()) throw new Error(`不是普通技能目录：${dir}`);
  const hash = crypto.createHash('sha256');
  for (const row of walkArtifact(dir)) hash.update(row);
  return hash.digest('hex');
}

function copyArtifact(source, destination) {
  fs.mkdirSync(destination, { recursive: false });
  const copyDir = (from, to) => {
    const entries = fs.readdirSync(from, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === '.DS_Store' || entry.name === '.git') continue;
      const src = path.join(from, entry.name);
      const dst = path.join(to, entry.name);
      const st = fs.lstatSync(src);
      if (st.isDirectory()) {
        fs.mkdirSync(dst);
        copyDir(src, dst);
      } else if (st.isFile()) {
        fs.copyFileSync(src, dst, fs.constants.COPYFILE_EXCL);
        fs.chmodSync(dst, st.mode);
      } else if (st.isSymbolicLink()) {
        throw new Error(`技能包含符号链接，拒绝部署：${src}`);
      } else {
        throw new Error(`技能包含不支持的文件类型：${src}`);
      }
    }
  };
  copyDir(source, destination);
}

export function lockPath(targetRoot) {
  return path.join(path.resolve(targetRoot), CONTROL_DIR, LOCK_FILE);
}

export function readDeploymentLock(targetRoot, { missingOk = true } = {}) {
  const file = lockPath(targetRoot);
  if (!fs.existsSync(file)) {
    if (missingOk) return { schemaVersion: LOCK_SCHEMA_VERSION, updatedAt: null, deployments: {} };
    throw new Error(`没有部署台账：${file}`);
  }
  let value;
  try { value = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (err) { throw new Error(`部署台账无法读取：${file}（${err.message}）`); }
  if (value?.schemaVersion !== LOCK_SCHEMA_VERSION || !value.deployments || Array.isArray(value.deployments) || typeof value.deployments !== 'object')
    throw new Error(`部署台账格式不受支持：${file}`);
  return value;
}

function writeDeploymentLock(targetRoot, value) {
  const dir = path.join(targetRoot, CONTROL_DIR);
  if (fs.existsSync(dir)) {
    const st = fs.lstatSync(dir);
    if (!st.isDirectory() || st.isSymbolicLink()) throw new Error(`控制目录不是普通目录：${dir}`);
  } else {
    fs.mkdirSync(dir, { recursive: false });
  }
  const file = path.join(dir, LOCK_FILE);
  const tmp = path.join(dir, `.lock-${process.pid}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.tmp`);
  try {
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', { encoding: 'utf8', flag: 'wx' });
    fs.renameSync(tmp, file);
  } finally {
    try { fs.rmSync(tmp, { force: true }); } catch { /* 尽力清理临时文件 */ }
  }
}

function ownerOfTarget(lock, targetPath) {
  const wanted = path.resolve(targetPath);
  return Object.entries(lock.deployments).find(([, row]) => row?.targetPath && path.resolve(row.targetPath) === wanted);
}

export function deploySkill(skill, targetRootInput) {
  if (!skill?.dir) throw new Error('缺少技能源目录');
  const sourcePath = path.resolve(skill.dir);
  const targetRoot = path.resolve(targetRootInput || '');
  if (!targetRootInput) throw new Error('缺少 --to <目录>');
  if (!fs.existsSync(path.join(sourcePath, 'SKILL.md'))) throw new Error(`技能源缺少 SKILL.md：${sourcePath}`);
  if (path.basename(sourcePath) === CONTROL_DIR) throw new Error(`技能目录名不能是保留名称 ${CONTROL_DIR}`);
  if (inside(sourcePath, targetRoot)) throw new Error('部署目标不能位于技能源目录内部');

  fs.mkdirSync(targetRoot, { recursive: true });
  const rootStat = fs.lstatSync(targetRoot);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error(`部署目标不是普通目录：${targetRoot}`);

  const targetPath = path.join(targetRoot, path.basename(sourcePath));
  if (sourcePath === targetPath) throw new Error('技能源与部署目标是同一目录');

  const key = skill.id || skill.name || path.basename(sourcePath);
  const lock = readDeploymentLock(targetRoot);
  const previous = lock.deployments[key] || null;
  const owner = ownerOfTarget(lock, targetPath);
  if (owner && owner[0] !== key) throw new Error(`目标目录已由另一技能管理：${owner[0]} → ${targetPath}`);

  const targetExists = fs.existsSync(targetPath);
  if (targetExists && !previous) throw new Error(`拒绝覆盖未知目录：${targetPath}`);
  if (previous && path.resolve(previous.targetPath || '') !== targetPath)
    throw new Error(`技能 ${key} 的台账目标与本次目标不一致：${previous.targetPath}`);

  const sourceFingerprint = artifactFingerprint(sourcePath);
  let currentTargetFingerprint = null;
  if (targetExists) {
    try { currentTargetFingerprint = artifactFingerprint(targetPath); }
    catch (err) { throw new Error(`部署目标无法核验，拒绝覆盖：${targetPath}（${err.message}）`); }
    if (currentTargetFingerprint !== previous.deployedFingerprint)
      throw new Error(`目标已发生本地修改，拒绝覆盖（target-drift）：${targetPath}`);
    if (sourceFingerprint === previous.sourceFingerprint) {
      return { action: 'unchanged', key, targetRoot, targetPath, sourceFingerprint, lockPath: lockPath(targetRoot) };
    }
  }

  const parent = path.dirname(targetPath);
  const tempPath = fs.mkdtempSync(path.join(parent, `.${path.basename(targetPath)}-deploy-`));
  let backupPath = null;
  let targetInstalled = false;
  try {
    // mkdtemp 已创建根目录；复制函数要求目标不存在。
    fs.rmdirSync(tempPath);
    copyArtifact(sourcePath, tempPath);
    const copiedFingerprint = artifactFingerprint(tempPath);
    if (copiedFingerprint !== sourceFingerprint) throw new Error('复制后指纹不一致，部署已中止');

    if (targetExists) {
      backupPath = path.join(parent, `.${path.basename(targetPath)}-backup-${process.pid}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`);
      fs.renameSync(targetPath, backupPath);
    }
    fs.renameSync(tempPath, targetPath);
    targetInstalled = true;

    const now = new Date().toISOString();
    const next = {
      schemaVersion: LOCK_SCHEMA_VERSION,
      updatedAt: now,
      deployments: {
        ...lock.deployments,
        [key]: {
          skillId: skill.id || null,
          name: skill.name || path.basename(sourcePath),
          version: skill.version || null,
          sourcePath,
          targetPath,
          sourceFingerprint,
          deployedFingerprint: copiedFingerprint,
          deployedAt: now,
        },
      },
    };
    writeDeploymentLock(targetRoot, next);
    if (backupPath) {
      try { fs.rmSync(backupPath, { recursive: true, force: true }); }
      catch { /* 新部署与台账已提交，遗留备份比回滚成不一致状态更安全 */ }
    }
    return { action: targetExists ? 'updated' : 'deployed', key, targetRoot, targetPath, sourceFingerprint, lockPath: lockPath(targetRoot) };
  } catch (err) {
    if (targetInstalled) {
      try { fs.rmSync(targetPath, { recursive: true, force: true }); } catch { /* 后续恢复会给出原始错误 */ }
    }
    if (backupPath && fs.existsSync(backupPath)) {
      try { fs.renameSync(backupPath, targetPath); } catch (restoreErr) {
        throw new Error(`${err.message}；且旧部署恢复失败：${restoreErr.message}`);
      }
    }
    throw err;
  } finally {
    try { fs.rmSync(tempPath, { recursive: true, force: true }); } catch { /* 尽力清理 */ }
  }
}

function fingerprintState(dir, expected) {
  if (!fs.existsSync(dir)) return { state: 'missing', fingerprint: null, error: null };
  try {
    const fingerprint = artifactFingerprint(dir);
    return { state: fingerprint === expected ? 'clean' : 'drift', fingerprint, error: null };
  } catch (err) {
    return { state: 'unreadable', fingerprint: null, error: err.message };
  }
}

export function inspectDeployments(targetRootInput) {
  const targetRoot = path.resolve(targetRootInput);
  const file = lockPath(targetRoot);
  if (!fs.existsSync(file)) return { targetRoot, lockPath: file, missing: true, deployments: [] };
  const lock = readDeploymentLock(targetRoot, { missingOk: false });
  const deployments = Object.entries(lock.deployments).map(([key, row]) => {
    const source = fingerprintState(row.sourcePath, row.sourceFingerprint);
    const target = fingerprintState(row.targetPath, row.deployedFingerprint);
    let status = 'clean';
    if (source.state === 'missing') status = 'source-missing';
    else if (source.state === 'unreadable') status = 'source-unreadable';
    if (target.state === 'missing') status = status === 'clean' ? 'target-missing' : `${status}+target-missing`;
    else if (target.state === 'unreadable') status = status === 'clean' ? 'target-unreadable' : `${status}+target-unreadable`;
    else if (target.state === 'drift') status = status === 'clean' ? 'target-drift' : `${status}+target-drift`;
    if (source.state === 'drift') status = status === 'clean' ? 'source-drift' : `${status}+source-drift`;
    return { key, ...row, status, source, target };
  });
  return { targetRoot, lockPath: file, missing: false, deployments };
}

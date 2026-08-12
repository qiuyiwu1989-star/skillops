/* update-policy.mjs — Release 更新差异与复评政策的纯投影层。
 *
 * 不读写文件、不访问网络、不执行技能。它只决定一个明确 Release 更新是否
 * ready / blocked / reassessment_required / no_change，并始终保留旧 Lock 语义。
 */
import crypto from 'node:crypto';

export const UPDATE_ASSESSMENT_SCHEMA_VERSION = 1;

const DIGEST = /^sha256:[a-f0-9]{64}$/;
const RELEASE_ID = /^rel_[a-f0-9]{64}$/;
const SKILL_ID = /^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?\/[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/;
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;
const RELEASE_STATES = new Set(['published', 'superseded', 'withdrawn', 'revoked']);
const EVIDENCE_KINDS = ['packageAudit', 'license', 'security', 'sms', 'eval', 'review'];
const EVIDENCE_LABELS = {
  packageAudit: '全包审计', license: '许可证据', security: '安全审计',
  sms: 'SMS 评估', eval: 'Eval 运行评测', review: '独立人类终审',
};

export class UpdatePolicyError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'UpdatePolicyError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new UpdatePolicyError(code, message);
}

function object(value, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('INVALID_INPUT', `${field} 必须是对象`);
  return value;
}

function text(value, field, pattern) {
  if (typeof value !== 'string' || !value.trim()) fail('INVALID_INPUT', `${field} 必须是非空字符串`);
  const normalized = value.normalize('NFC').trim();
  if (pattern && !pattern.test(normalized)) fail('INVALID_IDENTITY', `${field} 格式无效`);
  return normalized;
}

function digest(value, field) {
  return text(value, field, DIGEST);
}

function expectedReleaseId(skillId, version, packageDigest) {
  return `rel_${crypto.createHash('sha256')
    .update(`skillops.release.v1\0${skillId}\0${version}\0${packageDigest}`, 'utf8')
    .digest('hex')}`;
}

function normalizeNow(now) {
  const value = typeof now === 'function' ? now() : (now ?? new Date());
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) fail('INVALID_NOW', 'now 必须是有效日期时间');
  return date.getTime();
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  }
  return typeof value === 'string' ? value.normalize('NFC') : value;
}

function equal(a, b) {
  return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
}

function stringList(value, field) {
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string' || !item.trim())) {
    fail('INVALID_INPUT', `${field} 必须是字符串数组`);
  }
  return [...new Set(value.map(item => item.normalize('NFC').trim()))].sort();
}

function normalizeCompatibility(input = {}) {
  const value = object(input, 'release.compatibility');
  return {
    contract: text(value.contract, 'release.compatibility.contract'),
    targets: stringList(value.targets, 'release.compatibility.targets'),
  };
}

function normalizeDependencies(input = []) {
  if (!Array.isArray(input)) fail('INVALID_INPUT', 'release.dependencies 必须是数组');
  const rows = input.map((row, index) => {
    object(row, `release.dependencies[${index}]`);
    return {
      skillId: text(row.skillId, `release.dependencies[${index}].skillId`, SKILL_ID),
      range: text(row.range, `release.dependencies[${index}].range`),
    };
  });
  rows.sort((a, b) => `${a.skillId}\0${a.range}`.localeCompare(`${b.skillId}\0${b.range}`));
  return rows;
}

function normalizeAssessmentPolicy(input = {}) {
  const value = object(input, 'release.assessmentPolicy');
  return {
    smsSuiteId: text(value.smsSuiteId, 'release.assessmentPolicy.smsSuiteId'),
    evalSuiteId: text(value.evalSuiteId, 'release.assessmentPolicy.evalSuiteId'),
    runnerId: text(value.runnerId, 'release.assessmentPolicy.runnerId'),
    reviewPolicyVersion: text(value.reviewPolicyVersion, 'release.assessmentPolicy.reviewPolicyVersion'),
  };
}

function normalizeRelease(input, field) {
  const value = object(input, field);
  const releaseId = text(value.releaseId, `${field}.releaseId`);
  if (releaseId === 'latest' || /^cand_/i.test(releaseId)) fail('MUTABLE_RELEASE_FORBIDDEN', `${field} 必须绑定明确 Release`);
  if (!RELEASE_ID.test(releaseId)) fail('INVALID_RELEASE_ID', `${field}.releaseId 格式无效`);
  const skillId = text(value.skillId, `${field}.skillId`, SKILL_ID);
  if (skillId.split('/').some(part => /^cand_/i.test(part))) fail('CANDIDATE_ID_FORBIDDEN', `${field}.skillId 不能使用 Candidate 身份`);
  const version = text(value.version, `${field}.version`);
  if (version === 'latest') fail('MUTABLE_RELEASE_FORBIDDEN', `${field}.version 不能使用 latest`);
  const match = version.match(SEMVER);
  if (!match) fail('INVALID_SEMVER', `${field}.version 必须是 SemVer`);
  const status = value.status ?? 'published';
  if (!RELEASE_STATES.has(status)) fail('INVALID_RELEASE_STATUS', `${field}.status 不受支持`);
  const pkg = object(value.package, `${field}.package`);
  const packageIdentity = {
    packageDigest: digest(pkg.packageDigest, `${field}.package.packageDigest`),
    manifestDigest: digest(pkg.manifestDigest, `${field}.package.manifestDigest`),
    licenseDigest: digest(pkg.licenseDigest, `${field}.package.licenseDigest`),
    securityDigest: digest(pkg.securityDigest, `${field}.package.securityDigest`),
  };
  if (releaseId !== expectedReleaseId(skillId, version, packageIdentity.packageDigest)) {
    fail('RELEASE_ID_MISMATCH', `${field}.releaseId 与规范身份输入不一致`);
  }
  return {
    releaseId, skillId, version, status,
    semver: { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]), prerelease: match[4] ?? null },
    package: packageIdentity,
    compatibility: normalizeCompatibility(value.compatibility),
    dependencies: normalizeDependencies(value.dependencies ?? []),
    assessmentPolicy: normalizeAssessmentPolicy(value.assessmentPolicy),
  };
}

function normalizeLock(input, oldRelease) {
  const lock = object(input, 'currentLock');
  const normalized = {
    skillId: text(lock.skillId, 'currentLock.skillId', SKILL_ID),
    releaseId: text(lock.releaseId, 'currentLock.releaseId', RELEASE_ID),
    packageDigest: digest(lock.packageDigest, 'currentLock.packageDigest'),
    deployedFingerprint: digest(lock.deployedFingerprint, 'currentLock.deployedFingerprint'),
  };
  if (normalized.skillId !== oldRelease.skillId || normalized.releaseId !== oldRelease.releaseId || normalized.packageDigest !== oldRelease.package.packageDigest) {
    fail('LOCK_IDENTITY_MISMATCH', '当前 Lock 未绑定 oldRelease');
  }
  return normalized;
}

function normalizeTarget(input, lock) {
  const target = object(input, 'targetState');
  const exists = target.exists !== false && target.status !== 'missing';
  const managed = target.managed === true && target.status !== 'unknown';
  const expected = target.deployedFingerprint
    ? digest(target.deployedFingerprint, 'targetState.deployedFingerprint')
    : lock.deployedFingerprint;
  const actual = target.currentFingerprint
    ? digest(target.currentFingerprint, 'targetState.currentFingerprint')
    : null;
  return {
    exists,
    managed,
    drift: target.drift === true || target.status === 'target_drift' || (exists && expected && actual && expected !== actual),
  };
}

function normalizePolicy(input = {}) {
  const policy = object(input, 'localPolicy');
  const requiredEvidence = policy.requiredEvidence === undefined
    ? [...EVIDENCE_KINDS]
    : stringList(policy.requiredEvidence, 'localPolicy.requiredEvidence');
  for (const kind of requiredEvidence) {
    if (!EVIDENCE_KINDS.includes(kind)) fail('INVALID_POLICY', `不支持的证据类型：${kind}`);
  }
  return {
    requiredEvidence,
    smsSuiteId: text(policy.smsSuiteId, 'localPolicy.smsSuiteId'),
    evalSuiteId: text(policy.evalSuiteId, 'localPolicy.evalSuiteId'),
    runnerId: text(policy.runnerId, 'localPolicy.runnerId'),
    reviewPolicyVersion: text(policy.reviewPolicyVersion, 'localPolicy.reviewPolicyVersion'),
  };
}

function reason(code, messageZh, blocking, details = undefined) {
  return details ? { code, messageZh, blocking, details: canonical(details) } : { code, messageZh, blocking };
}

function reassessment(kind, code, messageZh) {
  return { kind, code, messageZh, blocking: false };
}

function change(kind, from, to, extra = {}) {
  return { kind, from: canonical(from), to: canonical(to), ...extra };
}

function semverChange(oldRelease, newRelease) {
  const from = oldRelease.semver;
  const to = newRelease.semver;
  const direction = to.major !== from.major ? Math.sign(to.major - from.major)
    : to.minor !== from.minor ? Math.sign(to.minor - from.minor)
      : to.patch !== from.patch ? Math.sign(to.patch - from.patch) : 0;
  const level = to.major !== from.major ? 'major'
    : to.minor !== from.minor ? 'minor'
      : (to.patch !== from.patch || to.prerelease !== from.prerelease) ? 'patch' : 'none';
  return { level, direction };
}

function assessEvidence(input, newRelease, policy, now, reasons, requiredReassessments) {
  const evidence = object(input ?? {}, 'evidence');
  for (const kind of policy.requiredEvidence) {
    const row = evidence[kind];
    const label = EVIDENCE_LABELS[kind];
    if (!row || typeof row !== 'object' || Array.isArray(row)) {
      requiredReassessments.push(reassessment(kind, 'EVIDENCE_MISSING', `缺少绑定新 Release 的${label}`));
      continue;
    }
    const acceptable = kind === 'review' ? row.status === 'certified' : row.status === 'passed';
    if (row.status === 'failed' || row.status === 'rejected' || row.status === 'revoked') {
      reasons.push(reason('EVIDENCE_FAILED', `${label}未通过，旧版本与旧 Lock 保持不变`, true, { kind }));
      continue;
    }
    if (typeof row.validUntil !== 'string' || !Number.isFinite(Date.parse(row.validUntil)) || Date.parse(row.validUntil) <= now) {
      reasons.push(reason('EVIDENCE_EXPIRED', `${label}已过期或有效期无效`, true, { kind }));
      continue;
    }
    if (!acceptable) {
      requiredReassessments.push(reassessment(kind, 'EVIDENCE_STATUS_INVALID', `${label}尚未达到放行状态`));
      continue;
    }
    if (row.packageDigest !== newRelease.package.packageDigest) {
      requiredReassessments.push(reassessment(kind, 'EVIDENCE_PACKAGE_MISMATCH', `${label}不能从旧包继承到新包`));
      continue;
    }
    if (row.releaseId !== newRelease.releaseId) {
      requiredReassessments.push(reassessment(kind, 'EVIDENCE_RELEASE_MISMATCH', `${label}未绑定目标 Release`));
      continue;
    }
    if (typeof row.digest !== 'string' || !DIGEST.test(row.digest)) {
      requiredReassessments.push(reassessment(kind, 'EVIDENCE_DIGEST_INVALID', `${label}缺少有效摘要`));
      continue;
    }
    if (kind === 'sms' && row.suiteId !== policy.smsSuiteId) {
      requiredReassessments.push(reassessment(kind, 'SMS_SUITE_MISMATCH', 'SMS suite 与本地政策不一致'));
    }
    if (kind === 'eval' && row.suiteId !== policy.evalSuiteId) {
      requiredReassessments.push(reassessment(kind, 'EVAL_SUITE_MISMATCH', 'Eval suite 与本地政策不一致'));
    }
    if (kind === 'eval' && row.runnerId !== policy.runnerId) {
      requiredReassessments.push(reassessment(kind, 'EVAL_RUNNER_MISMATCH', 'Eval runner 与本地政策不一致'));
    }
    if (kind === 'review' && row.policyVersion !== policy.reviewPolicyVersion) {
      requiredReassessments.push(reassessment(kind, 'REVIEW_POLICY_MISMATCH', '终审 policy 与本地政策不一致'));
    }
  }
}

function classifyChanges(oldRelease, newRelease) {
  const changes = [];
  const version = semverChange(oldRelease, newRelease);
  if (oldRelease.version !== newRelease.version) changes.push(change('version', oldRelease.version, newRelease.version, { level: version.level }));
  for (const [kind, field] of [
    ['package', 'packageDigest'], ['manifest', 'manifestDigest'],
    ['license', 'licenseDigest'], ['security', 'securityDigest'],
  ]) {
    if (oldRelease.package[field] !== newRelease.package[field]) {
      changes.push(change(kind, oldRelease.package[field], newRelease.package[field]));
    }
  }
  if (!equal(oldRelease.compatibility, newRelease.compatibility)) changes.push(change('compatibility', oldRelease.compatibility, newRelease.compatibility));
  if (!equal(oldRelease.dependencies, newRelease.dependencies)) changes.push(change('dependencies', oldRelease.dependencies, newRelease.dependencies));
  for (const [kind, field] of [
    ['sms_suite', 'smsSuiteId'], ['eval_suite', 'evalSuiteId'],
    ['runner', 'runnerId'], ['review_policy', 'reviewPolicyVersion'],
  ]) {
    if (oldRelease.assessmentPolicy[field] !== newRelease.assessmentPolicy[field]) {
      changes.push(change(kind, oldRelease.assessmentPolicy[field], newRelease.assessmentPolicy[field]));
    }
  }
  return { changes, version };
}

function riskFor(changes, version) {
  const kinds = new Set(changes.map(row => row.kind));
  if (!changes.length) return 'none';
  if (version.level === 'major' || version.direction < 0 || ['license', 'security', 'compatibility', 'dependencies'].some(kind => kinds.has(kind))) return 'high';
  if (version.level === 'minor' || ['package', 'manifest', 'sms_suite', 'eval_suite', 'runner', 'review_policy'].some(kind => kinds.has(kind))) return 'medium';
  return 'low';
}

/**
 * 生成一个确定性的更新评估。输出只含摘要、身份与结构化判断；不会回显输入中的
 * prompt/output/token、评测正文或本地路径。
 */
export function createUpdateAssessment(input, { now } = {}) {
  const value = object(input, 'input');
  const at = normalizeNow(now);
  const oldRelease = normalizeRelease(value.oldRelease, 'oldRelease');
  const newRelease = normalizeRelease(value.newRelease, 'newRelease');
  if (oldRelease.skillId !== newRelease.skillId) fail('SKILL_ID_MISMATCH', '更新前后的 skillId 必须一致');
  if (oldRelease.releaseId === newRelease.releaseId && (
    oldRelease.version !== newRelease.version || oldRelease.package.packageDigest !== newRelease.package.packageDigest
  )) fail('RELEASE_IMMUTABILITY_VIOLATION', '同一 releaseId 不得映射不同版本或包');

  const lock = normalizeLock(value.currentLock, oldRelease);
  const target = normalizeTarget(value.targetState, lock);
  const policy = normalizePolicy(value.localPolicy);
  const { changes, version } = classifyChanges(oldRelease, newRelease);
  const riskLevel = riskFor(changes, version);
  const reasons = [];
  const requiredReassessments = [];

  if (newRelease.status === 'revoked') reasons.push(reason('RELEASE_REVOKED', '目标 Release 已被安全吊销', true));
  else if (newRelease.status === 'withdrawn') reasons.push(reason('RELEASE_WITHDRAWN', '目标 Release 已撤回', true));
  if (!target.exists) reasons.push(reason('TARGET_MISSING', '当前 Lock 对应的目标不存在', true));
  else if (!target.managed) reasons.push(reason('UNKNOWN_TARGET', '目标不属于当前 SkillOps 台账', true));
  if (target.drift) reasons.push(reason('TARGET_DRIFT', '目标存在本地修改，禁止覆盖', true));
  if (version.direction < 0) reasons.push(reason('VERSION_DOWNGRADE', '版本号发生降级，必须停止自动更新', true));

  assessEvidence(value.evidence, newRelease, policy, at, reasons, requiredReassessments);

  const blocking = reasons.some(row => row.blocking);
  const status = blocking ? 'blocked'
    : requiredReassessments.length ? 'reassessment_required'
      : changes.length ? 'ready' : 'no_change';
  const requiredConfirmations = [];
  if (!blocking && status !== 'no_change') {
    requiredConfirmations.push({ kind: 'update_assessment', messageZh: '确认仅应用本次明确 Release 更新；计划变化后需重新确认' });
    if (version.level === 'major') requiredConfirmations.push({ kind: 'major_version', messageZh: '主版本升级需要主人显式确认迁移影响' });
    if (changes.some(row => row.kind === 'compatibility')) requiredConfirmations.push({ kind: 'compatibility_change', messageZh: '兼容声明变化需要主人显式确认' });
    if (changes.some(row => row.kind === 'dependencies')) requiredConfirmations.push({ kind: 'dependency_change', messageZh: '依赖变化需要主人显式确认' });
    if (changes.some(row => row.kind === 'license')) requiredConfirmations.push({ kind: 'license_change', messageZh: '许可证据变化需要主人显式确认' });
  }

  const migrationRequired = version.level === 'major'
    || changes.some(row => ['compatibility', 'dependencies'].includes(row.kind));
  return canonical({
    schemaVersion: UPDATE_ASSESSMENT_SCHEMA_VERSION,
    status,
    riskLevel,
    subject: {
      skillId: oldRelease.skillId,
      from: { releaseId: oldRelease.releaseId, version: oldRelease.version, packageDigest: oldRelease.package.packageDigest },
      to: { releaseId: newRelease.releaseId, version: newRelease.version, packageDigest: newRelease.package.packageDigest },
    },
    changes,
    reasons,
    requiredConfirmations,
    requiredReassessments,
    migration: {
      required: migrationRequired,
      preserveCurrentLockOnFailure: true,
      currentLock: { releaseId: lock.releaseId, packageDigest: lock.packageDigest },
      action: status === 'ready' ? 'prepare_atomic_update' : 'keep_current_release',
    },
  });
}

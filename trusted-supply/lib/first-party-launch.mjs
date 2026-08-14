import fs from 'node:fs';
import path from 'node:path';

import { createHeuristicSmsDraft } from './assessment-pipeline.mjs';
import { isPackageAuditCurrent, auditPackageFiles } from './package-audit.mjs';
import { PackageStore } from './package-store.mjs';
import { isSmsCurrent } from './sms.mjs';
import { normalizeEvalSuite } from './eval-suite.mjs';
import { isEvalResultCurrent } from './eval-result.mjs';
import { auditSkillFormat } from './skill-document.mjs';
import { contentFingerprint } from './fingerprint.mjs';
import { CandidateStore } from './store.mjs';

const COHORT_KEYS = Object.freeze([
  'skillops', 'ai-xiezuo-qiyue', 'creator-education', 'panduanku-jiagou',
  'shengchan-shigu-kuaizhen', 'xuqiu-jianbao',
]);
const DIGEST = /^sha256:[a-f0-9]{64}$/;

function timestamp(clock) {
  const value = clock ? clock() : new Date();
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error('clock must produce a valid timestamp');
  return date.toISOString();
}

function atomicJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(temporary, filePath);
}

function sourcePath(seed, sourceRoots) {
  const rootInput = sourceRoots[seed.sourceRoot];
  if (!rootInput) throw new Error(`source root is not configured: ${seed.sourceRoot}`);
  const root = fs.realpathSync(path.resolve(rootInput));
  const skillFile = fs.realpathSync(path.resolve(root, ...seed.relativePath.split('/')));
  if (skillFile !== root && !skillFile.startsWith(`${root}${path.sep}`)) throw new Error('skill path escapes source root');
  const stat = fs.lstatSync(skillFile);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('SKILL.md must be a real file');
  return { skillFile, packageRoot: path.dirname(skillFile) };
}

function findCandidate(store, fingerprint, sourceCoordinate) {
  const matches = store.list().filter(candidate => candidate.artifact?.fingerprint === fingerprint);
  if (matches.length > 1) {
    const exact = matches.filter(candidate => candidate.source?.repo === sourceCoordinate);
    if (exact.length !== 1) throw new Error(`ambiguous candidate evidence for ${sourceCoordinate}`);
    return exact[0];
  }
  return matches[0] || null;
}

function currentEval(candidate, suite) {
  if (candidate?.eval?.status !== 'complete') return false;
  try {
    return isEvalResultCurrent(candidate.eval, {
      packageDigest: candidate.artifact.package?.packageDigest,
      suiteDigest: suite.suiteDigest,
    });
  } catch {
    return false;
  }
}

function publicReadiness(seed, candidate, suite, draft, generatedAt) {
  const fingerprint = candidate.artifact?.fingerprint;
  const auditCurrent = candidate.audit?.basedOnFingerprint === fingerprint;
  const packageArtifact = candidate.artifact?.package || null;
  const packageCurrent = Boolean(packageArtifact && DIGEST.test(packageArtifact.packageDigest));
  const packageAuditPass = packageCurrent && isPackageAuditCurrent(packageArtifact, candidate.packageAudit)
    && candidate.packageAudit.status === 'pass';
  const securityPass = auditCurrent && candidate.audit?.security?.status === 'pass';
  const smsCurrent = isSmsCurrent(candidate);
  const smsPassed = smsCurrent && Number(candidate.sms.total) >= 64;
  const evalPassed = currentEval(candidate, suite) && candidate.eval.status === 'complete'
    && Number(candidate.eval.successRate) >= 0.8;
  const certified = candidate.certification?.status === 'certified'
    && candidate.certification?.evidenceDigest === candidate.reviewEvidence?.evidenceDigest;
  const rightsReady = candidate.audit?.license?.redistributable === true;
  let lane = 'release_ready';
  let nextActionZh = '可进入正式授权发布';
  if (!packageCurrent) [lane, nextActionZh] = ['package_preparation_required', '补齐并锁定完整技能包'];
  else if (!packageAuditPass || !securityPass) [lane, nextActionZh] = ['security_review_required', '处理完整包安全审核问题'];
  else if (!smsCurrent) [lane, nextActionZh] = ['sms_confirmation_required', '人工复核并确认 SMS 预评估'];
  else if (!smsPassed) [lane, nextActionZh] = ['sms_improvement_required', '依据低分维度改进技能说明与执行协议'];
  else if (!evalPassed) [lane, nextActionZh] = ['eval_execution_required', '在隔离运行环境执行首批 Eval 测试集'];
  else if (!certified) [lane, nextActionZh] = ['human_review_required', '完成两位独立人工终审'];
  else if (!rightsReady) [lane, nextActionZh] = ['rights_policy_required', '确认造物云自有技能的正式授权政策'];
  const gates = {
    completePackage: packageCurrent,
    packageAudit: packageAuditPass,
    security: securityPass,
    sms: smsPassed,
    eval: evalPassed,
    humanCertification: certified,
    rightsPolicy: rightsReady,
  };
  const passed = Object.values(gates).filter(Boolean).length;
  return Object.freeze({
    schemaVersion: 1,
    key: seed.key,
    sourceCoordinate: seed.sourceCoordinate,
    titleZh: seed.titleZh,
    lane,
    nextActionZh,
    progress: Object.freeze({ passed, total: Object.keys(gates).length }),
    gates: Object.freeze(gates),
    evidence: Object.freeze({
      contentFingerprint: fingerprint,
      packageDigest: packageArtifact?.packageDigest || null,
      packageFileCount: packageArtifact?.fileCount || 0,
      packageAuditStatus: candidate.packageAudit?.status || 'pending',
      smsStatus: smsCurrent ? 'complete' : draft ? 'draft_ready' : 'pending',
      smsTotal: smsCurrent ? candidate.sms.total : null,
      smsTier: smsCurrent ? candidate.sms.tier : null,
      evalSuiteDigest: suite.suiteDigest,
      evalCaseCount: suite.cases.length,
      evalStatus: evalPassed ? 'complete' : 'suite_ready',
      certificationStatus: candidate.certification?.status || 'pending',
      licenseStatus: candidate.audit?.license?.status || 'unknown',
    }),
    previewEligible: packageAuditPass && securityPass,
    releaseReady: lane === 'release_ready',
    generatedAt,
  });
}

function loadSuites(filePath) {
  const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  if (parsed?.schemaVersion !== 1 || !parsed.suites || typeof parsed.suites !== 'object') throw new Error('eval suite fixture is invalid');
  return Object.fromEntries(COHORT_KEYS.map(key => [key, normalizeEvalSuite(parsed.suites[key])]));
}

function publicProjection(items, generatedAt) {
  const counts = {};
  for (const item of items) counts[item.lane] = (counts[item.lane] || 0) + 1;
  return Object.freeze({
    schemaVersion: 1,
    kind: 'skillops.first-party-launch-readiness.v1',
    generatedAt,
    summary: Object.freeze({ total: items.length, releaseReady: items.filter(item => item.releaseReady).length, lanes: Object.freeze(counts) }),
    items: Object.freeze(items),
  });
}

export function validateFirstPartyLaunchProjection(value) {
  if (!value || value.schemaVersion !== 1 || value.kind !== 'skillops.first-party-launch-readiness.v1'
    || !Array.isArray(value.items) || value.items.length !== COHORT_KEYS.length) throw new Error('first-party launch projection is invalid');
  if (new Set(value.items.map(item => item.key)).size !== COHORT_KEYS.length) throw new Error('launch projection has duplicate skills');
  const serialized = JSON.stringify(value);
  if (/cand_[a-f0-9]{20}|storageRef|(?:^|["\/])Users\/|prompt|output|secret/i.test(serialized)) {
    throw new Error('launch projection contains private implementation data');
  }
  for (const item of value.items) {
    if (!COHORT_KEYS.includes(item.key) || !DIGEST.test(item.evidence.contentFingerprint)
      || !DIGEST.test(item.evidence.evalSuiteDigest) || item.releaseReady !== (item.lane === 'release_ready')) {
      throw new Error('launch projection item is invalid');
    }
  }
  return structuredClone(value);
}

export function attachFirstPartyLaunch(listings, projection) {
  const trusted = validateFirstPartyLaunchProjection(projection);
  const byCoordinate = new Map(trusted.items.map(item => [item.sourceCoordinate, item]));
  return listings.map(listing => {
    const readiness = byCoordinate.get(listing.catalog?.coordinate);
    if (!readiness) return listing;
    return { ...listing, catalog: { ...listing.catalog, launchReadiness: readiness } };
  });
}

export function syncFirstPartyLaunch({
  seeds,
  sourceRoots,
  candidateStorePath,
  packageStorePath,
  evalSuitesPath,
  smsDraftDirectory,
  readinessPath,
  clock,
} = {}) {
  if (!seeds?.items || !sourceRoots || !candidateStorePath || !packageStorePath || !evalSuitesPath) {
    throw new Error('seeds, sourceRoots, stores and eval suites are required');
  }
  const cohort = COHORT_KEYS.map(key => seeds.items.find(item => item.key === key));
  if (cohort.some(item => !item)) throw new Error('first-party launch cohort is incomplete');
  const generatedAt = timestamp(clock);
  const store = new CandidateStore(candidateStorePath);
  const packages = new PackageStore(packageStorePath);
  const suites = loadSuites(evalSuitesPath);
  const items = [];
  for (const seed of cohort) {
    const resolved = sourcePath(seed, sourceRoots);
    const content = fs.readFileSync(resolved.skillFile, 'utf8');
    const fingerprint = contentFingerprint(content);
    let candidate = findCandidate(store, fingerprint, seed.sourceCoordinate);
    if (!candidate) {
      const imported = packages.importDirectory(resolved.packageRoot, { sourceVersion: fingerprint, collectedAt: generatedAt });
      const format = auditSkillFormat(content);
      candidate = store.ingest({
        source: { kind: 'local_first_party', repo: seed.sourceCoordinate, path: 'SKILL.md', commit: fingerprint, license: format.license || null },
        content,
        license: format.license || null,
        package: imported.artifact,
        sms: { status: 'pending' },
        eval: { status: 'pending' },
        catalog: { packageComplete: true, category: seed.category, tags: seed.tags, titleZh: seed.titleZh, summaryZh: seed.summaryZh },
      }, { clock: () => new Date(generatedAt) });
      candidate = store.audit(candidate.id, { clock: () => new Date(generatedAt) });
      const packageAudit = auditPackageFiles(packages.readFiles(imported.artifact.packageDigest), imported.artifact, { clock: () => new Date(generatedAt) });
      candidate = store.auditPackage(candidate.id, { ...packageAudit, auditor: 'skillops:first-party-launch' }, { clock: () => new Date(generatedAt) });
    } else {
      if (candidate.artifact?.fingerprint !== fingerprint) throw new Error(`${seed.key} candidate evidence is stale`);
      if (candidate.artifact?.package) packages.verify(candidate.artifact.package.packageDigest);
    }
    if (!candidate.audit || candidate.audit.basedOnFingerprint !== fingerprint) {
      candidate = store.audit(candidate.id, { clock: () => new Date(generatedAt) });
    }
    const draft = isSmsCurrent(candidate) ? null : {
      ...createHeuristicSmsDraft(candidate),
      generatedAt,
    };
    if (draft && smsDraftDirectory) atomicJson(path.join(smsDraftDirectory, `${seed.key}.json`), draft);
    items.push(publicReadiness(seed, candidate, suites[seed.key], draft, generatedAt));
  }
  const projection = publicProjection(items, generatedAt);
  validateFirstPartyLaunchProjection(projection);
  if (readinessPath) atomicJson(readinessPath, projection);
  return Object.freeze({ projection, candidateStorePath: path.resolve(candidateStorePath), packageStorePath: path.resolve(packageStorePath) });
}

export { COHORT_KEYS };

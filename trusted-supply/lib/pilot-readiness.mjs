import crypto from 'node:crypto';

import { refreshReviewCertification } from './candidate.mjs';
import { validateEvalResult } from './eval-result.mjs';
import { validatePackageArtifact } from './package.mjs';
import { canonicalDigest, normalizeRelease, releaseId, sourceId } from './registry-identity.mjs';
import { validateSmsAssessment } from './sms.mjs';

const STATUS = Object.freeze({
  SOURCE_ONLY: 'source_only',
  EVIDENCE_PENDING: 'evidence_pending',
  RELEASE_READY: 'release_ready',
});

const BLOCKERS = Object.freeze({
  complete_package_missing: ['supply', '完整技能包不可核验，仅保留来源索引。'],
  license_not_redistributable: ['license', '许可未明确允许再分发，仅保留来源索引。'],
  content_audit_not_current: ['content_audit', '内容审计未绑定当前内容指纹。'],
  package_audit_missing: ['package_audit', '完整包审计未通过或未绑定当前包清单。'],
  sms_not_current: ['sms', 'SMS 未完成、未达门槛或未绑定当前内容。'],
  eval_not_current: ['eval', 'Eval 未完成或未绑定当前完整包。'],
  certification_not_current: ['certification', '双人终审未认证、已过期或未绑定当前证据。'],
  listing_missing: ['listing', '当前证据尚未形成市场 Listing。'],
  listing_not_eligible: ['listing', 'Listing 未达到可安装资格或与当前证据不一致。'],
  release_missing: ['registry', '尚无绑定当前证据的 Registry Release。'],
  release_not_published: ['registry', 'Registry Release 当前不是 published 状态。'],
  release_invalid: ['registry', 'Registry Release 结构或规范身份不可验证。'],
  release_evidence_mismatch: ['registry', 'Registry Release 未绑定当前包、评估、终审或来源证据。'],
});

function blocker(code) {
  const definition = BLOCKERS[code];
  return Object.freeze({ code, gate: definition[0], messageZh: definition[1] });
}

function timestamp(value, label) {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) {
    throw new TypeError(`${label} must be a valid timestamp`);
  }
  return new Date(value).toISOString();
}

function manifestFingerprint(artifact) {
  return `sha256:${crypto.createHash('sha256').update(JSON.stringify(artifact.manifest)).digest('hex')}`;
}

function validPackage(candidate) {
  if (candidate?.catalog?.packageComplete !== true || !candidate?.artifact?.package) return null;
  try {
    return validatePackageArtifact(candidate.artifact.package);
  } catch {
    return null;
  }
}

function redistributableLicense(candidate) {
  const audit = candidate?.audit;
  return Boolean(audit
    && audit.basedOnFingerprint === candidate?.artifact?.fingerprint
    && audit.license?.status === 'allowed'
    && audit.license?.redistributable === true);
}

function contentAuditCurrent(candidate) {
  return Boolean(candidate?.artifact?.fingerprint
    && candidate?.audit?.basedOnFingerprint === candidate.artifact.fingerprint
    && candidate.audit.eligibleForReview === true
    && candidate.audit.security?.status !== 'block');
}

function packageAuditCurrent(candidate, artifact) {
  return Boolean(artifact
    && candidate?.packageAudit?.status === 'pass'
    && candidate.packageAudit.basedOnPackageDigest === artifact.packageDigest
    && candidate.packageAudit.basedOnPackageManifestFingerprint === manifestFingerprint(artifact));
}

function currentSms(candidate) {
  try {
    const sms = validateSmsAssessment(candidate.sms, { fingerprint: candidate.artifact.fingerprint });
    return candidate.audit?.smsMeetsThreshold === true && sms.total >= Number(candidate.audit?.smsThreshold ?? 64)
      ? sms
      : null;
  } catch {
    return null;
  }
}

function currentEval(candidate, artifact) {
  if (!artifact) return null;
  try {
    return validateEvalResult(candidate.eval, { packageDigest: artifact.packageDigest });
  } catch {
    return null;
  }
}

function currentCertification(candidate, artifact, generatedAt) {
  let refreshed;
  try {
    refreshed = refreshReviewCertification(candidate, { clock: () => new Date(generatedAt) });
  } catch {
    return null;
  }
  const certification = refreshed.certification;
  const evidence = refreshed.reviewEvidence;
  if (!artifact || certification?.status !== 'certified' || !evidence) return null;
  if (certification.evidenceDigest !== evidence.evidenceDigest
    || certification.policyDigest !== evidence.policyDigest
    || evidence.contentFingerprint !== candidate.artifact.fingerprint
    || evidence.packageDigest !== artifact.packageDigest
    || !certification.validUntil
    || Date.parse(certification.validUntil) <= Date.parse(generatedAt)) return null;
  const snapshot = {
    schemaVersion: evidence.schemaVersion,
    contentFingerprint: evidence.contentFingerprint,
    packageDigest: evidence.packageDigest,
    licenseDigest: evidence.licenseDigest,
    smsDigest: evidence.smsDigest,
    evalDigest: evidence.evalDigest,
    policyDigest: evidence.policyDigest,
  };
  return canonicalDigest(snapshot) === evidence.evidenceDigest ? { certification, evidence } : null;
}

function sourceReference(listing, candidate) {
  const source = listing?.source ?? candidate?.source;
  const coordinate = source?.upstreamUrl || source?.marketplaceUrl || source?.url
    || (source?.repo ? `${source.repo}@${source.commit || 'unknown'}:${source.path || 'SKILL.md'}` : null);
  if (!source?.kind || !coordinate) return null;
  try {
    return sourceId({ type: source.kind, coordinate });
  } catch {
    return null;
  }
}

function listingCurrent(listing, candidate, artifact, evaluation, certification) {
  return Boolean(listing
    && listing.install?.status === 'eligible'
    && listing.install?.packageComplete === true
    && listing.package?.packageDigest === artifact?.packageDigest
    && canonicalDigest(listing.package?.manifest) === canonicalDigest(artifact.manifest)
    && listing.package?.audit?.status === 'pass'
    && listing.package.audit.basedOnPackageDigest === artifact.packageDigest
    && listing.package.audit.basedOnPackageManifestFingerprint === manifestFingerprint(artifact)
    && listing.version?.fingerprint === candidate?.artifact?.fingerprint
    && listing.eval?.basedOnPackageDigest === evaluation?.basedOnPackageDigest
    && listing.eval?.suiteDigest === evaluation?.suiteDigest
    && listing.verification?.status === 'certified'
    && listing.verification?.certification?.evidenceDigest === certification?.evidence?.evidenceDigest
    && listing.verification?.evidence?.evidenceDigest === certification?.evidence?.evidenceDigest
    && sourceReference(listing, candidate));
}

function releaseParts(input) {
  if (!input) return null;
  if (input.release && typeof input.release === 'object') return { status: input.status, release: input.release };
  return { status: input.status, release: input };
}

function validatedRelease(input) {
  const parts = releaseParts(input);
  if (!parts) return { kind: 'missing' };
  if (parts.status !== 'published') return { kind: 'not_published' };
  try {
    const packageDigest = parts.release?.package?.packageDigest;
    const canonical = normalizeRelease({
      ...parts.release,
      package: {
        ...parts.release.package,
        storageRef: parts.release.package?.storageRef ?? `cas:${packageDigest}`,
      },
    });
    if (releaseId(canonical) !== canonical.releaseId) return { kind: 'invalid' };
    return { kind: 'valid', release: canonical };
  } catch {
    return { kind: 'invalid' };
  }
}

function releaseMatches(release, artifact, certification, listingSourceId) {
  const evidence = certification.evidence;
  return release.package.packageDigest === artifact.packageDigest
    && release.package.manifestDigest === canonicalDigest(artifact.manifest)
    && release.assessmentRefs.includes(evidence.smsDigest)
    && release.assessmentRefs.includes(evidence.evalDigest)
    && release.reviewRefs.includes(evidence.policyDigest)
    && release.reviewRefs.includes(evidence.evidenceDigest)
    && release.sourceRefs.includes(listingSourceId);
}

function evidenceRefs({ candidate, artifact, evaluation, certification, listing, release }) {
  const refs = {};
  const source = sourceReference(listing, candidate);
  if (source) refs.sourceId = source;
  if (candidate?.artifact?.fingerprint) refs.contentFingerprint = candidate.artifact.fingerprint;
  if (artifact) {
    refs.packageDigest = artifact.packageDigest;
    refs.manifestDigest = canonicalDigest(artifact.manifest);
  }
  if (candidate?.packageAudit?.basedOnPackageManifestFingerprint) {
    refs.packageAuditManifestDigest = candidate.packageAudit.basedOnPackageManifestFingerprint;
  }
  if (candidate?.sms?.basedOnFingerprint) refs.smsFingerprint = candidate.sms.basedOnFingerprint;
  if (evaluation?.suiteDigest) refs.evalSuiteDigest = evaluation.suiteDigest;
  if (evaluation?.basedOnPackageDigest) refs.evalPackageDigest = evaluation.basedOnPackageDigest;
  if (certification) {
    refs.licenseDigest = certification.evidence.licenseDigest;
    refs.smsDigest = certification.evidence.smsDigest;
    refs.evalDigest = certification.evidence.evalDigest;
    refs.policyDigest = certification.evidence.policyDigest;
    refs.reviewEvidenceDigest = certification.evidence.evidenceDigest;
  }
  if (release) refs.releaseId = release.releaseId;
  return Object.freeze(Object.fromEntries(Object.entries(refs).sort(([left], [right]) => left.localeCompare(right))));
}

function evaluateItem(input, generatedAt) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('pilot item must be an object');
  const candidate = input.candidate;
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) throw new TypeError('pilot item candidate is required');
  const artifact = validPackage(candidate);
  const licenseAllowed = redistributableLicense(candidate);
  const blockers = [];
  if (!artifact) blockers.push(blocker('complete_package_missing'));
  if (!licenseAllowed) blockers.push(blocker('license_not_redistributable'));
  if (artifact && licenseAllowed) {
    if (!contentAuditCurrent(candidate)) blockers.push(blocker('content_audit_not_current'));
    if (!packageAuditCurrent(candidate, artifact)) blockers.push(blocker('package_audit_missing'));
    const evaluation = currentEval(candidate, artifact);
    if (!currentSms(candidate)) blockers.push(blocker('sms_not_current'));
    if (!evaluation) blockers.push(blocker('eval_not_current'));
    const certification = currentCertification(candidate, artifact, generatedAt);
    if (!certification) blockers.push(blocker('certification_not_current'));
    if (!input.listing) blockers.push(blocker('listing_missing'));
    else if (!evaluation || !certification || !listingCurrent(input.listing, candidate, artifact, evaluation, certification)) {
      blockers.push(blocker('listing_not_eligible'));
    }
    const releaseCheck = validatedRelease(input.release);
    let release = null;
    if (releaseCheck.kind === 'missing') blockers.push(blocker('release_missing'));
    else if (releaseCheck.kind === 'not_published') blockers.push(blocker('release_not_published'));
    else if (releaseCheck.kind === 'invalid') blockers.push(blocker('release_invalid'));
    else {
      release = releaseCheck.release;
      const listingSourceId = sourceReference(input.listing, candidate);
      if (!certification || !listingSourceId || !releaseMatches(release, artifact, certification, listingSourceId)) {
        blockers.push(blocker('release_evidence_mismatch'));
      }
    }
    const status = blockers.length ? STATUS.EVIDENCE_PENDING : STATUS.RELEASE_READY;
    const refs = evidenceRefs({ candidate, artifact, evaluation, certification, listing: input.listing, release });
    return Object.freeze({ sourceRef: refs.sourceId ?? null, status, blockers: Object.freeze(blockers), evidenceRefs: refs });
  }
  const refs = evidenceRefs({ candidate, artifact, evaluation: null, certification: null, listing: input.listing, release: null });
  return Object.freeze({ sourceRef: refs.sourceId ?? null, status: STATUS.SOURCE_ONLY, blockers: Object.freeze(blockers), evidenceRefs: refs });
}

function summary(items) {
  return Object.freeze({
    total: items.length,
    sourceOnly: items.filter(item => item.status === STATUS.SOURCE_ONLY).length,
    evidencePending: items.filter(item => item.status === STATUS.EVIDENCE_PENDING).length,
    releaseReady: items.filter(item => item.status === STATUS.RELEASE_READY).length,
  });
}

export function createPilotReadinessReport({ items, generatedAt } = {}) {
  if (!Array.isArray(items) || items.length < 1 || items.length > 3) {
    throw new RangeError('pilot readiness report requires one to three items');
  }
  const normalizedTime = timestamp(generatedAt, 'generatedAt');
  const evaluated = items.map(item => evaluateItem(item, normalizedTime)).sort((left, right) => {
    const leftKey = left.sourceRef ?? left.evidenceRefs.contentFingerprint ?? '';
    const rightKey = right.sourceRef ?? right.evidenceRefs.contentFingerprint ?? '';
    return leftKey.localeCompare(rightKey) || canonicalDigest(left).localeCompare(canonicalDigest(right));
  });
  const stable = {
    schemaVersion: 1,
    kind: 'skillops.pilot-readiness.v1',
    summary: summary(evaluated),
    items: evaluated,
  };
  return Object.freeze({
    ...stable,
    generatedAt: normalizedTime,
    reportDigest: canonicalDigest(stable),
  });
}

export const PILOT_READINESS_STATUSES = STATUS;
export const PILOT_READINESS_BLOCKER_CODES = Object.freeze(Object.keys(BLOCKERS));

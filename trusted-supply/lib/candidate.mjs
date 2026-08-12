import crypto from 'node:crypto';

import { candidateId, contentFingerprint, normalizeContent, sourceIdentity, sourceVersionIdentity } from './fingerprint.mjs';
import { auditCandidate } from './audit.mjs';
import { createSmsAssessment, isSmsCurrent } from './sms.mjs';
import { localizeCandidateMetadata } from './localization.mjs';
import { validatePackageArtifact } from './package.mjs';
import { validateEvalResult } from './eval-result.mjs';
import {
  createReviewAttestation,
  createReviewEvidenceSnapshot,
  createReviewLifecycleEvent,
  createReviewPolicy,
  evaluateReviewCertification,
  reviewEvidenceChanges,
} from './review-policy.mjs';

const DECISIONS = new Set(['approve', 'reject', 'quarantine']);
const REVIEWER_TYPES = new Set(['human', 'agent_assisted']);
const PACKAGE_AUDIT_STATUSES = new Set(['pass', 'review', 'block']);

function now(clock) {
  return (clock ? clock() : new Date()).toISOString();
}

function publicSource(source) {
  return {
    kind: source.kind,
    url: source.url || null,
    marketplaceUrl: source.marketplaceUrl || null,
    upstreamUrl: source.upstreamUrl || null,
    repo: source.repo || null,
    path: source.path,
    commit: source.commit,
    version: source.version || null,
    integrity: source.integrity || null,
  };
}

function inputPackage(input) {
  const value = input.package ?? input.artifact?.package;
  return value == null ? null : validatePackageArtifact(value);
}

function packageDigest(candidate) {
  return candidate?.artifact?.package?.packageDigest || null;
}

function packageManifestFingerprint(packageArtifact) {
  if (!packageArtifact) return null;
  return `sha256:${crypto.createHash('sha256').update(JSON.stringify(packageArtifact.manifest)).digest('hex')}`;
}

function packageAuditIsCurrent(candidate) {
  const digest = packageDigest(candidate);
  const manifestFingerprint = packageManifestFingerprint(candidate?.artifact?.package);
  return Boolean(digest
    && candidate?.packageAudit?.status === 'pass'
    && candidate.packageAudit.basedOnPackageDigest === digest
    && candidate.packageAudit.basedOnPackageManifestFingerprint === manifestFingerprint);
}

function pendingAssessment() {
  return { status: 'pending' };
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  }
  return value;
}

function stableDigest(value) {
  return `sha256:${crypto.createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex')}`;
}

function stableLicenseEvidence(candidate) {
  const license = candidate?.audit?.license;
  if (!license) return null;
  return {
    status: license.status,
    spdx: license.spdx ?? null,
    reason: license.reason,
    redistributable: license.redistributable === true,
  };
}

function stableSmsEvidence(candidate) {
  if (!isSmsCurrent(candidate)) return null;
  const sms = candidate.sms;
  return {
    schemaVersion: sms.schemaVersion,
    status: sms.status,
    rubricVersion: sms.rubricVersion,
    dimensions: sms.dimensions,
    total: sms.total,
    tier: sms.tier,
    scorer: sms.scorer,
    basedOnFingerprint: sms.basedOnFingerprint,
  };
}

function stableEvalEvidence(candidate) {
  const digest = packageDigest(candidate);
  if (!digest || candidate?.eval?.status !== 'complete') return null;
  try {
    const result = validateEvalResult(candidate.eval, { packageDigest: digest });
    return {
      schemaVersion: result.schemaVersion,
      status: result.status,
      suiteId: result.suiteId,
      suiteVersion: result.suiteVersion,
      suiteDigest: result.suiteDigest,
      basedOnPackageDigest: result.basedOnPackageDigest,
      runner: result.runner,
      environment: result.environment,
      cases: result.cases.map(item => ({
        id: item.id,
        status: item.status,
        assertions: item.assertions,
        outputSummary: item.outputSummary,
        error: item.error,
      })),
      passed: result.passed,
      failed: result.failed,
      successRate: result.successRate,
    };
  } catch {
    return null;
  }
}

function reviewContext(candidate) {
  return {
    submitterPrincipalId: candidate.reviewContext?.submitterPrincipalId || null,
    conflictedPrincipalIds: candidate.reviewContext?.conflictedPrincipalIds || [],
  };
}

function reviewMaterials(candidate) {
  return {
    contentFingerprint: candidate?.artifact?.fingerprint || null,
    packageDigest: packageDigest(candidate),
    licenseDigest: stableLicenseEvidence(candidate) ? stableDigest(stableLicenseEvidence(candidate)) : null,
    smsDigest: stableSmsEvidence(candidate) ? stableDigest(stableSmsEvidence(candidate)) : null,
    evalDigest: stableEvalEvidence(candidate) ? stableDigest(stableEvalEvidence(candidate)) : null,
    policyDigest: candidate?.reviewPolicy?.policyDigest || null,
  };
}

function incompleteReviewReasons(candidate) {
  if (!candidate.reviewPolicy) return ['review_policy_required'];
  const materials = reviewMaterials(candidate);
  const reasons = [];
  if (!materials.contentFingerprint) reasons.push('content_evidence_required');
  if (!materials.licenseDigest) reasons.push('license_evidence_required');
  if (candidate.reviewPolicy.requirePackage && !materials.packageDigest) reasons.push('package_evidence_required');
  if (candidate.reviewPolicy.requirePackage && materials.packageDigest && !packageAuditIsCurrent(candidate)) reasons.push('package_audit_required');
  if (candidate.reviewPolicy.requireSms && !materials.smsDigest) reasons.push('sms_evidence_required');
  if (candidate.reviewPolicy.requireEval && !materials.evalDigest) reasons.push('eval_evidence_required');
  if (!candidate.audit || candidate.audit.basedOnFingerprint !== materials.contentFingerprint) reasons.push('content_audit_required');
  return [...new Set(reasons)];
}

function pendingCertification(candidate, reasons, { clock } = {}) {
  const evaluatedAt = now(clock);
  const priorSnapshot = candidate.reviewEvidence || candidate.reviewAttestations?.findLast?.(event => event.evidenceSnapshot)?.evidenceSnapshot;
  const current = reviewMaterials(candidate);
  const changed = priorSnapshot
    ? reviewEvidenceChanges(priorSnapshot, { ...priorSnapshot, ...current })
    : [];
  const hasPriorHumanApproval = (candidate.reviewAttestations || [])
    .some(event => event.type === 'human_review' && event.decision === 'approve');
  return Object.freeze({
    status: hasPriorHumanApproval ? 'stale' : 'pending',
    reasons: Object.freeze(changed.length ? changed : reasons),
    approvals: Object.freeze([]),
    requiredApprovals: candidate.reviewPolicy?.minimumIndependentHumanApprovals || 2,
    validUntil: null,
    evaluatedAt,
    evidenceDigest: null,
    policyDigest: candidate.reviewPolicy?.policyDigest || null,
  });
}

function candidateStatusForCertification(candidate, certification) {
  if (certification.status === 'certified') return 'approved';
  if (['rejected', 'changes_requested', 'withdrawn', 'recalled', 'expired', 'stale'].includes(certification.status)) {
    return certification.status;
  }
  if (!candidate.reviewPolicy && (candidate.reviewEvents || []).length) return candidate.status;
  if (['quarantined', 'rejected', 'screening'].includes(candidate.status)) return candidate.status;
  return 'review';
}

function initialEval(input) {
  if (!input || input.status === 'pending') return pendingAssessment();
  throw new Error('completed Eval evidence must be added through recordEval');
}

export function createCandidate(input = {}, { clock } = {}) {
  const sourceInput = input.source || {};
  const source = {
    kind: String(sourceInput.kind || sourceInput.type || input.sourceKind || 'local'),
    url: sourceInput.url || input.sourceUrl || null,
    repo: sourceInput.repo || input.repo || null,
    path: String(sourceInput.path || input.path || 'SKILL.md').replace(/^\.\//, ''),
    commit: String(sourceInput.commit || input.commit || ''),
    license: sourceInput.license ?? input.license ?? null,
    upstreamUrl: sourceInput.upstreamUrl || null,
    marketplaceUrl: sourceInput.marketplaceUrl || null,
    version: sourceInput.version || null,
    integrity: sourceInput.integrity || null,
  };
  source.identity = sourceIdentity(source);
  const content = normalizeContent(input.content ?? input.artifact?.content ?? '');
  const fingerprint = contentFingerprint(content);
  const packageArtifact = inputPackage(input);
  const createdAt = now(clock);
  const sms = input.sms?.dimensions
    ? createSmsAssessment(input.sms, { fingerprint, clock })
    : input.sms || { status: 'pending' };
  return {
    schemaVersion: 1,
    id: input.id || candidateId(source),
    status: 'discovered',
    source,
    artifact: {
      content,
      fingerprint,
      versionIdentity: sourceVersionIdentity(source, fingerprint),
      license: input.license ?? input.artifact?.license ?? source.license,
      package: packageArtifact,
    },
    sms,
    eval: initialEval(input.eval),
    evalEvents: [],
    packageAudit: null,
    packageAuditEvents: [],
    catalog: input.catalog || null,
    audit: null,
    duplicates: [],
    reviewedFingerprint: null,
    reviewedPackageDigest: null,
    reviewedPackageManifestFingerprint: null,
    reviewEvents: [],
    reviewPolicy: null,
    reviewEvidence: null,
    reviewContext: { submitterPrincipalId: null, conflictedPrincipalIds: [] },
    reviewAttestations: [],
    reviewLifecycleEvents: [],
    certification: Object.freeze({
      status: 'pending', reasons: Object.freeze(['review_policy_required']), approvals: Object.freeze([]),
      requiredApprovals: 2, validUntil: null, evaluatedAt: createdAt,
      evidenceDigest: null, policyDigest: null,
    }),
    createdAt,
    updatedAt: createdAt,
  };
}

export function refreshReviewCertification(candidate, { clock } = {}) {
  const reasons = incompleteReviewReasons(candidate);
  if (reasons.length) {
    const certification = pendingCertification(candidate, reasons, { clock });
    return {
      ...candidate,
      status: candidateStatusForCertification(candidate, certification),
      certification,
    };
  }
  const reviewPolicy = createReviewPolicy(candidate.reviewPolicy);
  const reviewEvidence = createReviewEvidenceSnapshot(reviewMaterials({ ...candidate, reviewPolicy }), {
    policy: reviewPolicy,
  });
  const certification = evaluateReviewCertification({
    policy: reviewPolicy,
    snapshot: reviewEvidence,
    attestations: candidate.reviewAttestations || [],
    lifecycleEvents: candidate.reviewLifecycleEvents || [],
    ...reviewContext(candidate),
    now: now(clock),
  });
  const certified = certification.status === 'certified';
  return {
    ...candidate,
    status: candidateStatusForCertification(candidate, certification),
    reviewPolicy,
    reviewEvidence,
    certification,
    reviewedFingerprint: certified ? candidate.artifact.fingerprint : candidate.reviewedFingerprint,
    reviewedPackageDigest: certified ? packageDigest(candidate) : candidate.reviewedPackageDigest,
    reviewedPackageManifestFingerprint: certified
      ? packageManifestFingerprint(candidate.artifact?.package)
      : candidate.reviewedPackageManifestFingerprint,
  };
}

export function configureReview(candidate, {
  policy,
  submitterPrincipalId = null,
  conflictedPrincipalIds = [],
} = {}, { clock } = {}) {
  if (!Array.isArray(conflictedPrincipalIds)) throw new TypeError('conflictedPrincipalIds must be an array');
  const reviewPolicy = createReviewPolicy(policy);
  const reviewContextValue = {
    submitterPrincipalId: submitterPrincipalId == null ? null : String(submitterPrincipalId),
    conflictedPrincipalIds: [...new Set(conflictedPrincipalIds.map(String))].sort(),
  };
  return refreshReviewCertification({ ...candidate, reviewPolicy, reviewContext: reviewContextValue }, { clock });
}

export function recordReviewAttestation(candidate, input, { clock } = {}) {
  const current = refreshReviewCertification(candidate, { clock });
  if (!current.reviewPolicy) throw new Error('review policy must be configured before attestation');
  if (!current.reviewEvidence) throw new Error(`review evidence is incomplete: ${current.certification.reasons.join(', ')}`);
  const event = createReviewAttestation(input, {
    policy: current.reviewPolicy,
    snapshot: current.reviewEvidence,
    clock,
  });
  return refreshReviewCertification({
    ...current,
    reviewAttestations: [...(current.reviewAttestations || []), event],
    updatedAt: event.at,
  }, { clock: () => new Date(event.at) });
}

export function recordReviewLifecycleEvent(candidate, input, { clock } = {}) {
  const current = refreshReviewCertification(candidate, { clock });
  if (!current.reviewPolicy) throw new Error('review policy must be configured before lifecycle control');
  if (!current.reviewEvidence) throw new Error(`review evidence is incomplete: ${current.certification.reasons.join(', ')}`);
  const event = createReviewLifecycleEvent(input, {
    policy: current.reviewPolicy,
    snapshot: current.reviewEvidence,
    clock,
  });
  return refreshReviewCertification({
    ...current,
    reviewLifecycleEvents: [...(current.reviewLifecycleEvents || []), event],
    updatedAt: event.at,
  }, { clock: () => new Date(event.at) });
}

export function recordEval(candidate, result) {
  const digest = packageDigest(candidate);
  if (!digest) throw new Error('candidate has no complete package for Eval');
  const evaluation = validateEvalResult(result, { packageDigest: digest });
  const previousEvents = candidate.evalEvents || [];
  const event = Object.freeze(structuredClone(evaluation));
  return refreshReviewCertification({
    ...candidate,
    eval: event,
    evalEvents: [...previousEvents, event],
    updatedAt: event.completedAt,
  }, { clock: () => new Date(event.completedAt) });
}

export function recordPackageAudit(candidate, audit = {}, { clock } = {}) {
  const digest = packageDigest(candidate);
  if (!digest) throw new Error('candidate has no complete package to audit');
  const status = String(audit.status || '').trim().toLowerCase();
  if (!PACKAGE_AUDIT_STATUSES.has(status)) throw new Error(`invalid package audit status: ${status || '(empty)'}`);
  const basedOnPackageDigest = String(audit.basedOnPackageDigest || digest).trim().toLowerCase();
  if (basedOnPackageDigest !== digest) throw new Error('package audit must match current package digest');
  const auditor = String(audit.auditor || '').trim() || null;
  const findings = Array.isArray(audit.findings) ? structuredClone(audit.findings) : [];
  const timestamp = now(clock);
  const previousEvents = candidate.packageAuditEvents || [];
  const event = Object.freeze({
    id: `package_audit_${previousEvents.length + 1}_${digest.slice(-12)}`,
    status,
    auditor,
    basedOnPackageDigest: digest,
    basedOnPackageManifestFingerprint: packageManifestFingerprint(candidate.artifact.package),
    checkedAt: timestamp,
    filesScanned: Number.isSafeInteger(audit.filesScanned) ? audit.filesScanned : null,
    filesExamined: Number.isSafeInteger(audit.filesExamined) ? audit.filesExamined : null,
    skippedBinary: Array.isArray(audit.skippedBinary) ? structuredClone(audit.skippedBinary) : [],
    findings,
  });
  const invalidatesApproval = candidate.status === 'approved' && status !== 'pass';
  return refreshReviewCertification({
    ...candidate,
    status: status === 'block' ? 'quarantined' : invalidatesApproval ? 'stale' : candidate.status,
    packageAudit: event,
    packageAuditEvents: [...previousEvents, event],
    reviewedFingerprint: invalidatesApproval || status === 'block' ? null : candidate.reviewedFingerprint,
    reviewedPackageDigest: invalidatesApproval || status === 'block' ? null : candidate.reviewedPackageDigest,
    reviewedPackageManifestFingerprint: invalidatesApproval || status === 'block'
      ? null
      : candidate.reviewedPackageManifestFingerprint,
    updatedAt: timestamp,
  }, { clock: () => new Date(timestamp) });
}

export function applyAudit(candidate, options = {}) {
  const audit = auditCandidate(candidate, options);
  let status = 'review';
  if (audit.security.status === 'block') status = 'quarantined';
  else if (audit.license.status === 'blocked') status = 'rejected';
  else if (!audit.eligibleForReview) status = 'screening';
  return refreshReviewCertification({ ...candidate, status, audit, updatedAt: audit.checkedAt }, {
    clock: () => new Date(audit.checkedAt),
  });
}

export function reviewCandidate(candidate, review = {}, { clock } = {}) {
  const decision = String(review.decision || '').toLowerCase();
  if (!DECISIONS.has(decision)) throw new Error(`invalid review decision: ${decision || '(empty)'}`);
  const reviewer = String(review.reviewer || '').trim();
  const reviewerType = String(review.reviewerType || 'human').trim();
  const reason = String(review.reason || '').trim();
  if (!reviewer) throw new Error('reviewer is required');
  if (!reason) throw new Error('review reason is required');
  if (!REVIEWER_TYPES.has(reviewerType)) throw new Error(`invalid reviewer type: ${reviewerType}`);
  if (!candidate.audit || candidate.audit.basedOnFingerprint !== candidate.artifact?.fingerprint) {
    throw new Error('candidate must be audited at its current fingerprint');
  }
  if (decision === 'approve') {
    if (!candidate.audit.eligibleForReview) {
      throw new Error(`hard trust gate failed: ${candidate.audit.hardBlocks.join(', ')}`);
    }
    const smsWaiver = Boolean(review.smsWaiver ?? review.waiveSms);
    if (!candidate.audit.smsMeetsThreshold && !smsWaiver) {
      throw new Error('SMS is pending or below threshold; explicit smsWaiver is required');
    }
    if (candidate.artifact?.package && !packageAuditIsCurrent(candidate)) {
      throw new Error('package hard trust gate failed: current passing full-package audit is required');
    }
  }
  const timestamp = now(clock);
  const event = Object.freeze({
    id: `review_${candidate.reviewEvents.length + 1}_${candidate.artifact.fingerprint.slice(-12)}`,
    decision,
    reviewer,
    reviewerType,
    reason,
    smsWaiver: decision === 'approve' ? Boolean(review.smsWaiver ?? review.waiveSms) : false,
    basedOnFingerprint: candidate.artifact.fingerprint,
    basedOnPackageDigest: packageDigest(candidate),
    basedOnPackageManifestFingerprint: packageManifestFingerprint(candidate.artifact?.package),
    at: timestamp,
  });
  return {
    ...candidate,
    status: decision === 'approve' ? 'approved' : decision === 'reject' ? 'rejected' : 'quarantined',
    reviewedFingerprint: decision === 'approve' ? candidate.artifact.fingerprint : null,
    reviewedPackageDigest: decision === 'approve' ? packageDigest(candidate) : null,
    reviewedPackageManifestFingerprint: decision === 'approve'
      ? packageManifestFingerprint(candidate.artifact?.package)
      : null,
    reviewEvents: [...(candidate.reviewEvents || []), event],
    updatedAt: timestamp,
  };
}

export function refreshCandidate(candidate, input = {}, { clock } = {}) {
  const nextContent = normalizeContent(input.content ?? candidate.artifact?.content ?? '');
  const nextFingerprint = contentFingerprint(nextContent);
  const source = {
    ...candidate.source,
    ...(input.source || {}),
    ...(input.commit ? { commit: String(input.commit) } : {}),
    ...(input.license !== undefined ? { license: input.license } : {}),
  };
  source.identity = sourceIdentity(source);
  const nextLicense = input.license ?? input.artifact?.license ?? source.license ?? candidate.artifact?.license;
  const hasPackageInput = input.package !== undefined || input.artifact?.package !== undefined;
  const nextPackage = hasPackageInput ? inputPackage(input) : candidate.artifact?.package || null;
  const contentChanged = nextFingerprint !== candidate.artifact?.fingerprint;
  const licenseChanged = nextLicense !== candidate.artifact?.license;
  const packageChanged = packageDigest(candidate) !== (nextPackage?.packageDigest || null);
  const packageManifestChanged = packageManifestFingerprint(candidate.artifact?.package)
    !== packageManifestFingerprint(nextPackage);
  const packageRevisionChanged = packageChanged || packageManifestChanged;
  const changed = contentChanged || licenseChanged || packageRevisionChanged;
  const updatedAt = now(clock);
  if (!changed) {
    return refreshReviewCertification({
      ...candidate,
      source,
      artifact: {
        ...candidate.artifact,
        license: nextLicense,
        package: nextPackage,
        versionIdentity: sourceVersionIdentity(source, nextFingerprint),
      },
      catalog: input.catalog ?? candidate.catalog ?? null,
      updatedAt,
    }, { clock: () => new Date(updatedAt) });
  }
  return refreshReviewCertification({
    ...candidate,
    status: candidate.status === 'approved' ? 'stale' : 'discovered',
    source,
    artifact: {
      ...candidate.artifact,
      content: nextContent,
      fingerprint: nextFingerprint,
      versionIdentity: sourceVersionIdentity(source, nextFingerprint),
      license: nextLicense,
      package: nextPackage,
    },
    sms: packageRevisionChanged ? pendingAssessment() : candidate.sms,
    eval: packageRevisionChanged ? pendingAssessment() : candidate.eval,
    evalEvents: candidate.evalEvents || [],
    packageAudit: packageRevisionChanged ? null : candidate.packageAudit || null,
    catalog: input.catalog ?? candidate.catalog ?? null,
    audit: null,
    reviewedFingerprint: null,
    reviewedPackageDigest: null,
    reviewedPackageManifestFingerprint: null,
    updatedAt,
  }, { clock: () => new Date(updatedAt) });
}

export function toListing(candidate) {
  candidate = refreshReviewCertification(candidate);
  if (candidate?.status !== 'approved') throw new Error('only approved candidates can generate listings');
  if (contentFingerprint(candidate.artifact?.content || '') !== candidate.artifact?.fingerprint) {
    throw new Error('content fingerprint does not match the approved artifact');
  }
  if (!candidate.reviewedFingerprint || candidate.reviewedFingerprint !== candidate.artifact?.fingerprint) {
    throw new Error('approval fingerprint does not match current content');
  }
  const packageArtifact = candidate.artifact?.package
    ? validatePackageArtifact(candidate.artifact.package)
    : null;
  if (packageArtifact && candidate.reviewedPackageDigest !== packageArtifact.packageDigest) {
    throw new Error('approval package digest does not match current package');
  }
  if (packageArtifact
    && candidate.reviewedPackageManifestFingerprint !== packageManifestFingerprint(packageArtifact)) {
    throw new Error('approval package manifest does not match current package');
  }
  if (!candidate.audit || candidate.audit.basedOnFingerprint !== candidate.artifact.fingerprint) {
    throw new Error('listing requires a current audit');
  }
  if (!candidate.audit.eligibleForReview || candidate.audit.security.status === 'block' || candidate.audit.license.status === 'blocked') {
    throw new Error('hard trust gate failed');
  }
  if (!candidate.audit.smsMeetsThreshold || !isSmsCurrent(candidate)) {
    throw new Error('public listing requires a current complete SMS v2 assessment at B tier or above');
  }
  const redistributable = candidate.audit.license.redistributable === true;
  const packageComplete = Boolean(packageArtifact && candidate.catalog?.packageComplete === true);
  const packageAuditCurrent = packageAuditIsCurrent(candidate);
  const certified = candidate.certification?.status === 'certified'
    && candidate.certification.evidenceDigest === candidate.reviewEvidence?.evidenceDigest;
  const format = candidate.audit.format;
  const localization = localizeCandidateMetadata(candidate);
  const listing = {
    schemaVersion: 1,
    id: candidate.id,
    name: localization.titleZh,
    description: localization.descriptionZh,
    original: {
      name: localization.originalName,
      description: localization.originalDescription,
    },
    localization,
    source: publicSource(candidate.source),
    version: {
      commit: candidate.source.commit,
      fingerprint: candidate.artifact.fingerprint,
      identity: candidate.artifact.versionIdentity,
    },
    license: candidate.audit.license,
    security: candidate.audit.security,
    sms: candidate.audit.sms,
    eval: candidate.eval || { status: 'pending' },
    verification: {
      status: certified ? 'certified' : 'approved',
      reviewedFingerprint: candidate.reviewedFingerprint,
      lastReview: candidate.reviewEvents.at(-1) || null,
      certification: candidate.certification || null,
      evidence: candidate.reviewEvidence || null,
    },
    distribution: redistributable ? 'content' : 'source_link_only',
    install: {
      status: redistributable && packageComplete && packageAuditCurrent && certified ? 'eligible' : 'source_required',
      method: 'skillops deploy',
      packageComplete,
      reason: !redistributable
        ? 'license_allows_source_link_only'
        : !packageArtifact
          ? 'complete_package_missing'
          : !packageComplete
            ? 'collector_snapshot_is_not_a_complete_package'
            : !packageAuditCurrent
              ? 'package_audit_required'
              : certified ? 'certified_complete_package' : 'human_certification_required',
    },
  };
  if (packageArtifact) {
    listing.package = {
      schemaVersion: packageArtifact.schemaVersion,
      packageDigest: packageArtifact.packageDigest,
      manifest: packageArtifact.manifest.map(entry => ({ ...entry })),
      fileCount: packageArtifact.fileCount,
      totalBytes: packageArtifact.totalBytes,
      collectedAt: packageArtifact.collectedAt,
      basedOnSourceVersion: packageArtifact.basedOnSourceVersion,
      audit: candidate.packageAudit ? {
        status: candidate.packageAudit.status,
        basedOnPackageDigest: candidate.packageAudit.basedOnPackageDigest,
        basedOnPackageManifestFingerprint: candidate.packageAudit.basedOnPackageManifestFingerprint,
        checkedAt: candidate.packageAudit.checkedAt,
        findings: structuredClone(candidate.packageAudit.findings || []),
      } : { status: 'pending' },
    };
  }
  if (candidate.catalog) listing.catalog = candidate.catalog;
  if (redistributable) listing.content = candidate.artifact.content;
  return listing;
}

import crypto from 'node:crypto';

import { candidateId, contentFingerprint, normalizeContent, sourceIdentity, sourceVersionIdentity } from './fingerprint.mjs';
import { auditCandidate } from './audit.mjs';
import { createSmsAssessment, isSmsCurrent } from './sms.mjs';
import { localizeCandidateMetadata } from './localization.mjs';
import { validatePackageArtifact } from './package.mjs';
import { validateEvalResult } from './eval-result.mjs';

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
    createdAt,
    updatedAt: createdAt,
  };
}

export function recordEval(candidate, result) {
  const digest = packageDigest(candidate);
  if (!digest) throw new Error('candidate has no complete package for Eval');
  const evaluation = validateEvalResult(result, { packageDigest: digest });
  const previousEvents = candidate.evalEvents || [];
  const event = Object.freeze(structuredClone(evaluation));
  return {
    ...candidate,
    eval: event,
    evalEvents: [...previousEvents, event],
    updatedAt: event.completedAt,
  };
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
  return {
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
  };
}

export function applyAudit(candidate, options = {}) {
  const audit = auditCandidate(candidate, options);
  let status = 'review';
  if (audit.security.status === 'block') status = 'quarantined';
  else if (audit.license.status === 'blocked') status = 'rejected';
  else if (!audit.eligibleForReview) status = 'screening';
  return { ...candidate, status, audit, updatedAt: audit.checkedAt };
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
    return {
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
    };
  }
  return {
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
  };
}

export function toListing(candidate) {
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
      status: 'approved',
      reviewedFingerprint: candidate.reviewedFingerprint,
      lastReview: candidate.reviewEvents.at(-1) || null,
    },
    distribution: redistributable ? 'content' : 'source_link_only',
    install: {
      status: redistributable && packageComplete && packageAuditCurrent ? 'eligible' : 'source_required',
      method: 'skillops deploy',
      packageComplete,
      reason: !redistributable
        ? 'license_allows_source_link_only'
        : !packageArtifact
          ? 'complete_package_missing'
          : !packageComplete
            ? 'collector_snapshot_is_not_a_complete_package'
            : packageAuditCurrent ? 'approved_complete_package' : 'package_audit_required',
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

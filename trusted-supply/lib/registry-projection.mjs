import crypto from 'node:crypto';

import { validateEvalResult } from './eval-result.mjs';
import { validatePackageArtifact } from './package.mjs';
import { canonicalDigest, normalizeRelease, sourceId } from './registry-identity.mjs';
import { validateSmsAssessment } from './sms.mjs';

export class RegistryProjectionError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'RegistryProjectionError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new RegistryProjectionError(code, message);
}

function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('INVALID_LISTING', `${label} must be an object`);
  return value;
}

function timestamp(value, label) {
  const milliseconds = typeof value === 'string' ? Date.parse(value) : NaN;
  if (!Number.isFinite(milliseconds)) fail('INVALID_TIMESTAMP', `${label} must be a valid timestamp`);
  return new Date(milliseconds).toISOString();
}

function stableSms(listing, evidence) {
  let sms;
  try {
    sms = validateSmsAssessment(listing.sms, { fingerprint: listing.version?.fingerprint });
  } catch (error) {
    fail('SMS_NOT_CURRENT', `SMS assessment is not current: ${error.message}`);
  }
  const value = {
    schemaVersion: sms.schemaVersion,
    status: sms.status,
    rubricVersion: sms.rubricVersion,
    dimensions: sms.dimensions,
    total: sms.total,
    tier: sms.tier,
    scorer: sms.scorer,
    basedOnFingerprint: sms.basedOnFingerprint,
  };
  const digest = canonicalDigest(value);
  if (digest !== evidence.smsDigest) fail('SMS_EVIDENCE_MISMATCH', 'SMS evidence digest does not match current listing');
  return digest;
}

function stableEval(listing, packageDigest, evidence) {
  let result;
  try {
    result = validateEvalResult(listing.eval, { packageDigest });
  } catch (error) {
    fail('EVAL_NOT_CURRENT', `Eval result is not current: ${error.message}`);
  }
  const value = {
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
  const digest = canonicalDigest(value);
  if (digest !== evidence.evalDigest) fail('EVAL_EVIDENCE_MISMATCH', 'Eval evidence digest does not match current listing');
  return digest;
}

function currentPackage(listing, storageRef) {
  const input = object(listing.package, 'listing.package');
  let artifact;
  try {
    artifact = validatePackageArtifact({
      schemaVersion: input.schemaVersion,
      packageDigest: input.packageDigest,
      manifest: input.manifest,
      fileCount: input.fileCount,
      totalBytes: input.totalBytes,
      storageRef,
      collectedAt: input.collectedAt,
      basedOnSourceVersion: input.basedOnSourceVersion,
    });
  } catch (error) {
    fail('PACKAGE_INVALID', `complete package is invalid: ${error.message}`);
  }
  const audit = object(input.audit, 'listing.package.audit');
  if (audit.status !== 'pass' || audit.basedOnPackageDigest !== artifact.packageDigest) {
    fail('PACKAGE_AUDIT_NOT_CURRENT', 'package audit must pass for the current package');
  }
  const manifestFingerprint = `sha256:${crypto.createHash('sha256').update(JSON.stringify(artifact.manifest)).digest('hex')}`;
  if (audit.basedOnPackageManifestFingerprint !== manifestFingerprint) {
    fail('PACKAGE_AUDIT_NOT_CURRENT', 'package audit does not match the current manifest');
  }
  return artifact;
}

function reviewEvidence(listing, publishedAt, packageDigest) {
  const verification = object(listing.verification, 'listing.verification');
  const certification = object(verification.certification, 'listing.verification.certification');
  const evidence = object(verification.evidence, 'listing.verification.evidence');
  if (verification.status !== 'certified' || certification.status !== 'certified') {
    fail('CERTIFICATION_REQUIRED', 'listing must have current certified verification');
  }
  if (certification.evidenceDigest !== evidence.evidenceDigest || certification.policyDigest !== evidence.policyDigest) {
    fail('CERTIFICATION_STALE', 'certification does not match current review evidence');
  }
  if (evidence.packageDigest !== packageDigest || evidence.contentFingerprint !== listing.version?.fingerprint) {
    fail('CERTIFICATION_STALE', 'certification evidence does not match current content and package');
  }
  const snapshot = {
    schemaVersion: evidence.schemaVersion,
    contentFingerprint: evidence.contentFingerprint,
    packageDigest: evidence.packageDigest,
    licenseDigest: evidence.licenseDigest,
    smsDigest: evidence.smsDigest,
    evalDigest: evidence.evalDigest,
    policyDigest: evidence.policyDigest,
  };
  if (canonicalDigest(snapshot) !== evidence.evidenceDigest) fail('CERTIFICATION_STALE', 'review evidence digest is invalid');
  if (!certification.validUntil || Date.parse(certification.validUntil) <= Date.parse(publishedAt)) {
    fail('CERTIFICATION_EXPIRED', 'certification is expired at publication time');
  }
  const licenseDigest = canonicalDigest({
    status: listing.license?.status,
    spdx: listing.license?.spdx ?? null,
    reason: listing.license?.reason,
    redistributable: listing.license?.redistributable === true,
  });
  if (licenseDigest !== evidence.licenseDigest) fail('LICENSE_EVIDENCE_MISMATCH', 'license evidence digest does not match current listing');
  return evidence;
}

function defaultSourceCoordinate(listing) {
  const source = object(listing.source, 'listing.source');
  const coordinate = source.upstreamUrl || source.marketplaceUrl || source.url
    || (source.repo ? `${source.repo}@${source.commit || 'unknown'}:${source.path || 'SKILL.md'}` : null);
  if (!coordinate) fail('SOURCE_REQUIRED', 'sourceCoordinates are required when listing has no stable source coordinate');
  return [{ type: source.kind || 'source', coordinate }];
}

function sourceRefs(listing, coordinates) {
  const values = coordinates ?? defaultSourceCoordinate(listing);
  if (!Array.isArray(values) || values.length === 0) fail('SOURCE_REQUIRED', 'sourceCoordinates must be a non-empty array');
  return values.map((value, index) => {
    const coordinate = object(value, `sourceCoordinates[${index}]`);
    try {
      return sourceId({ type: coordinate.type, coordinate: coordinate.coordinate });
    } catch (error) {
      fail('SOURCE_INVALID', error.message);
    }
  });
}

export function createReleaseFromListing(listingInput, input = {}) {
  const listing = object(listingInput, 'listing');
  if (listing.install?.status !== 'eligible') fail('INSTALL_NOT_ELIGIBLE', 'listing must be install eligible');
  if (listing.install?.packageComplete !== true) fail('PACKAGE_INCOMPLETE', 'listing must contain a complete package');
  const publishedAt = timestamp(input.publishedAt, 'publishedAt');
  const artifact = currentPackage(listing, input.storageRef);
  const evidence = reviewEvidence(listing, publishedAt, artifact.packageDigest);
  const smsDigest = stableSms(listing, evidence);
  const evalDigest = stableEval(listing, artifact.packageDigest, evidence);
  return normalizeRelease({
    skillId: input.skillId,
    version: input.version,
    package: {
      packageDigest: artifact.packageDigest,
      manifestDigest: canonicalDigest(artifact.manifest),
      storageRef: artifact.storageRef,
    },
    compatibility: input.compatibility,
    assessmentRefs: [smsDigest, evalDigest],
    reviewRefs: [evidence.policyDigest, evidence.evidenceDigest],
    sourceRefs: sourceRefs(listing, input.sourceCoordinates),
    publishedAt,
  });
}

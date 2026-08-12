import { candidateId, contentFingerprint, normalizeContent, sourceIdentity, sourceVersionIdentity } from './fingerprint.mjs';
import { auditCandidate } from './audit.mjs';

const DECISIONS = new Set(['approve', 'reject', 'quarantine']);

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
  const createdAt = now(clock);
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
    },
    sms: input.sms || { status: 'pending' },
    eval: input.eval || { status: 'pending' },
    catalog: input.catalog || null,
    audit: null,
    duplicates: [],
    reviewedFingerprint: null,
    reviewEvents: [],
    createdAt,
    updatedAt: createdAt,
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
  const reason = String(review.reason || '').trim();
  if (!reviewer) throw new Error('reviewer is required');
  if (!reason) throw new Error('review reason is required');
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
  }
  const timestamp = now(clock);
  const event = Object.freeze({
    id: `review_${candidate.reviewEvents.length + 1}_${candidate.artifact.fingerprint.slice(-12)}`,
    decision,
    reviewer,
    reason,
    smsWaiver: decision === 'approve' ? Boolean(review.smsWaiver ?? review.waiveSms) : false,
    basedOnFingerprint: candidate.artifact.fingerprint,
    at: timestamp,
  });
  return {
    ...candidate,
    status: decision === 'approve' ? 'approved' : decision === 'reject' ? 'rejected' : 'quarantined',
    reviewedFingerprint: decision === 'approve' ? candidate.artifact.fingerprint : null,
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
  const contentChanged = nextFingerprint !== candidate.artifact?.fingerprint;
  const licenseChanged = nextLicense !== candidate.artifact?.license;
  const changed = contentChanged || licenseChanged;
  const updatedAt = now(clock);
  if (!changed) {
    return {
      ...candidate,
      source,
      artifact: { ...candidate.artifact, license: nextLicense, versionIdentity: sourceVersionIdentity(source, nextFingerprint) },
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
    },
    catalog: input.catalog ?? candidate.catalog ?? null,
    audit: null,
    reviewedFingerprint: null,
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
  if (!candidate.audit || candidate.audit.basedOnFingerprint !== candidate.artifact.fingerprint) {
    throw new Error('listing requires a current audit');
  }
  if (!candidate.audit.eligibleForReview || candidate.audit.security.status === 'block' || candidate.audit.license.status === 'blocked') {
    throw new Error('hard trust gate failed');
  }
  const redistributable = candidate.audit.license.redistributable === true;
  const format = candidate.audit.format;
  const listing = {
    schemaVersion: 1,
    id: candidate.id,
    name: format.name,
    description: format.description,
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
  };
  if (candidate.catalog) listing.catalog = candidate.catalog;
  if (redistributable) listing.content = candidate.artifact.content;
  return listing;
}

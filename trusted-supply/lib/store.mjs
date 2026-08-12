import fs from 'node:fs';
import path from 'node:path';
import {
  applyAudit,
  configureReview,
  createCandidate,
  recordEval,
  recordPackageAudit,
  recordReviewAttestation,
  recordReviewLifecycleEvent,
  refreshCandidate,
  refreshReviewCertification,
  reviewCandidate,
  toListing,
} from './candidate.mjs';
import { findDuplicateRelations } from './duplicates.mjs';
import { createSmsAssessment } from './sms.mjs';

function clone(value) {
  return structuredClone(value);
}

export class CandidateStore {
  constructor(filePath) {
    if (!filePath) throw new Error('store file path is required');
    this.filePath = path.resolve(filePath);
  }

  read() {
    if (!fs.existsSync(this.filePath)) return { schemaVersion: 1, candidates: [] };
    const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
    if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.candidates)) throw new Error('unsupported candidate store format');
    return parsed;
  }

  write(data) {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const tempPath = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tempPath, `${JSON.stringify(data, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tempPath, this.filePath);
  }

  list({ status } = {}) {
    const values = this.read().candidates;
    return clone(status ? values.filter(candidate => candidate.status === status) : values);
  }

  get(id) {
    const candidate = this.read().candidates.find(item => item.id === id);
    return candidate ? clone(candidate) : null;
  }

  ingest(input, options = {}) {
    const data = this.read();
    const incoming = createCandidate(input, options);
    const index = data.candidates.findIndex(item => item.id === incoming.id);
    let candidate;
    if (index >= 0) {
      candidate = refreshCandidate(data.candidates[index], input, options);
      data.candidates[index] = candidate;
    } else {
      candidate = incoming;
      data.candidates.push(candidate);
    }
    for (const item of data.candidates) item.duplicates = findDuplicateRelations(item, data.candidates);
    this.write(data);
    return clone(data.candidates.find(item => item.id === candidate.id));
  }

  update(id, mutate) {
    const data = this.read();
    const index = data.candidates.findIndex(item => item.id === id);
    if (index < 0) throw new Error(`candidate not found: ${id}`);
    const previous = data.candidates[index];
    const next = mutate(clone(previous));
    const oldEvents = previous.reviewEvents || [];
    const nextEvents = next.reviewEvents || [];
    if (nextEvents.length < oldEvents.length
      || oldEvents.some((event, eventIndex) => JSON.stringify(event) !== JSON.stringify(nextEvents[eventIndex]))) {
      throw new Error('review events are append-only and cannot be changed');
    }
    const oldPackageEvents = previous.packageAuditEvents || [];
    const nextPackageEvents = next.packageAuditEvents || [];
    if (nextPackageEvents.length < oldPackageEvents.length
      || oldPackageEvents.some((event, eventIndex) => JSON.stringify(event) !== JSON.stringify(nextPackageEvents[eventIndex]))) {
      throw new Error('package audit events are append-only and cannot be changed');
    }
    const oldEvalEvents = previous.evalEvents || [];
    const nextEvalEvents = next.evalEvents || [];
    if (nextEvalEvents.length < oldEvalEvents.length
      || oldEvalEvents.some((event, eventIndex) => JSON.stringify(event) !== JSON.stringify(nextEvalEvents[eventIndex]))) {
      throw new Error('eval events are append-only and cannot be changed');
    }
    const oldAttestations = previous.reviewAttestations || [];
    const nextAttestations = next.reviewAttestations || [];
    if (nextAttestations.length < oldAttestations.length
      || oldAttestations.some((event, eventIndex) => JSON.stringify(event) !== JSON.stringify(nextAttestations[eventIndex]))) {
      throw new Error('review attestations are append-only and cannot be changed');
    }
    const oldLifecycleEvents = previous.reviewLifecycleEvents || [];
    const nextLifecycleEvents = next.reviewLifecycleEvents || [];
    if (nextLifecycleEvents.length < oldLifecycleEvents.length
      || oldLifecycleEvents.some((event, eventIndex) => JSON.stringify(event) !== JSON.stringify(nextLifecycleEvents[eventIndex]))) {
      throw new Error('review lifecycle events are append-only and cannot be changed');
    }
    data.candidates[index] = next;
    this.write(data);
    return clone(data.candidates[index]);
  }

  audit(id, options = {}) {
    return this.update(id, candidate => applyAudit(candidate, options));
  }

  auditPackage(id, audit, options = {}) {
    return this.update(id, candidate => recordPackageAudit(candidate, audit, options));
  }

  recordEval(id, result) {
    return this.update(id, candidate => recordEval(candidate, result));
  }

  assessSms(id, assessment, options = {}) {
    return this.update(id, candidate => {
      const sms = createSmsAssessment(assessment, {
        fingerprint: candidate.artifact?.fingerprint,
        clock: options.clock,
      });
      return refreshReviewCertification({
        ...candidate,
        status: candidate.status === 'approved' ? 'stale' : 'discovered',
        sms,
        audit: null,
        reviewedFingerprint: candidate.status === 'approved' ? null : candidate.reviewedFingerprint,
        updatedAt: sms.scoredAt,
      }, { clock: () => new Date(sms.scoredAt) });
    });
  }

  configureReview(id, configuration, options = {}) {
    return this.update(id, candidate => configureReview(candidate, configuration, options));
  }

  reviewAttest(id, attestation, options = {}) {
    return this.update(id, candidate => recordReviewAttestation(candidate, attestation, options));
  }

  reviewLifecycle(id, event, options = {}) {
    return this.update(id, candidate => recordReviewLifecycleEvent(candidate, event, options));
  }

  reviewStatus(id, options = {}) {
    return this.update(id, candidate => refreshReviewCertification(candidate, options));
  }

  review(id, review, options = {}) {
    return this.update(id, candidate => reviewCandidate(candidate, review, options));
  }

  listing(id) {
    const candidate = this.get(id);
    if (!candidate) throw new Error(`candidate not found: ${id}`);
    return toListing(candidate);
  }

  listListings() {
    return this.list({ status: 'approved' }).map(candidate => toListing(candidate));
  }
}

import { canonicalDigest } from './registry-identity.mjs';
import { isSkillRecordCurrent, validateSkillRecord } from './skill-record.mjs';

export const ROUTING_ASSESSMENT_SCHEMA_VERSION = 1;
export const ROUTING_RUBRIC_VERSION = 'ROUTING-1.0';

const DIMENSIONS = Object.freeze([
  ['metadataCompleteness', '元数据完整度'],
  ['positiveNegativeExamples', '正反例覆盖'],
  ['intentDistinctiveness', '意图区分度'],
  ['conflictDisclosure', '冲突说明'],
  ['portability', '可迁移性'],
]);

export class RoutingAssessmentError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'RoutingAssessmentError';
    this.code = code;
  }
}

function fail(code, message) { throw new RoutingAssessmentError(code, message); }

function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('INVALID_STRUCTURE', `${label} must be an object`);
}

function exactKeys(value, allowed, label) {
  object(value, label);
  const keys = Object.keys(value);
  const unknown = keys.filter(key => !allowed.has(key));
  const missing = [...allowed].filter(key => !Object.hasOwn(value, key));
  if (unknown.length) fail('UNKNOWN_FIELD', `${label} contains unknown fields: ${unknown.join(', ')}`);
  if (missing.length) fail('MISSING_FIELD', `${label} is missing fields: ${missing.join(', ')}`);
}

function normalizedTerms(value) {
  return new Set(value.normalize('NFKC').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(term => term.length >= 2));
}

function overlap(left, right) {
  const a = normalizedTerms(left);
  const b = normalizedTerms(right);
  if (!a.size || !b.size) return 0;
  const shared = [...a].filter(term => b.has(term)).length;
  return shared / Math.min(a.size, b.size);
}

function dimension(key, label, score, reasons) {
  return Object.freeze({ key, label, score: Math.max(0, Math.min(20, score)), maxScore: 20, reasons: Object.freeze([...reasons].sort()) });
}

function assess(record) {
  const dimensions = [];
  const metadataReasons = [];
  let metadataScore = 20;
  if ([...record.routing.summary].length < 12) { metadataScore -= 4; metadataReasons.push('routing_summary_too_short'); }
  if (!record.routing.intentTags.length) { metadataScore -= 4; metadataReasons.push('intent_tags_missing'); }
  if ([...record.metadata.descriptionZh].length < 20) { metadataScore -= 4; metadataReasons.push('zh_description_too_short'); }
  if ([...record.metadata.originalDescription].length < 20) { metadataScore -= 4; metadataReasons.push('original_description_too_short'); }
  dimensions.push(dimension(...DIMENSIONS[0], metadataScore, metadataReasons));

  const exampleReasons = [];
  const positives = record.routing.examples.filter(item => item.expectedUse).length;
  const negatives = record.routing.examples.length - positives;
  let exampleScore = Math.min(record.routing.whenToUse.length, 2) * 4
    + Math.min(record.routing.whenNotToUse.length, 2) * 4
    + Math.min(positives, 1) * 2 + Math.min(negatives, 1) * 2;
  if (!record.routing.whenToUse.length) exampleReasons.push('missing_when_to_use');
  if (!record.routing.whenNotToUse.length) exampleReasons.push('missing_when_not_to_use');
  if (!positives) exampleReasons.push('missing_positive_example');
  if (!negatives) exampleReasons.push('missing_negative_example');
  dimensions.push(dimension(...DIMENSIONS[1], exampleScore, exampleReasons));

  const intentReasons = [];
  let intentScore = 20;
  const duplicateBoundary = record.routing.whenToUse.some(yes => record.routing.whenNotToUse.some(no => yes === no));
  const ambiguousBoundary = record.routing.whenToUse.some(yes => record.routing.whenNotToUse.some(no => overlap(yes, no) >= 0.8));
  if (duplicateBoundary) { intentScore -= 12; intentReasons.push('positive_negative_boundary_duplicate'); }
  else if (ambiguousBoundary) { intentScore -= 6; intentReasons.push('positive_negative_boundary_ambiguous'); }
  if (!record.routing.confusions.length) { intentScore -= 4; intentReasons.push('no_confusion_comparison'); }
  dimensions.push(dimension(...DIMENSIONS[2], intentScore, intentReasons));

  const conflictReasons = [];
  let conflictScore = 20;
  const declared = new Set(record.dependencies.conflicts.map(item => item.skillId));
  const confusionIds = new Set(record.routing.confusions.map(item => item.skillId));
  const undeclared = [...confusionIds].filter(skillId => !declared.has(skillId));
  if (undeclared.length) {
    conflictScore -= Math.min(16, undeclared.length * 8);
    conflictReasons.push('confusion_conflict_not_declared');
  }
  if (declared.size && !confusionIds.size) { conflictScore -= 8; conflictReasons.push('declared_conflict_not_explained'); }
  dimensions.push(dimension(...DIMENSIONS[3], conflictScore, conflictReasons));

  const portabilityReasons = [];
  let portabilityScore = 20;
  if (!record.interface.inputs.length) { portabilityScore -= 4; portabilityReasons.push('inputs_not_described'); }
  if (!record.interface.outputs.length) { portabilityScore -= 4; portabilityReasons.push('outputs_not_described'); }
  if (record.compatibility.targets.length === 1) { portabilityScore -= 4; portabilityReasons.push('single_compatibility_target'); }
  const pinned = [...record.dependencies.required, ...record.dependencies.optional].filter(item => item.releaseId !== null).length;
  if (pinned) { portabilityScore -= Math.min(8, pinned * 2); portabilityReasons.push('release_pinned_dependency'); }
  dimensions.push(dimension(...DIMENSIONS[4], portabilityScore, portabilityReasons));
  return dimensions;
}

function grade(total) {
  if (total >= 90) return 'excellent';
  if (total >= 75) return 'good';
  if (total >= 60) return 'needs_review';
  return 'weak';
}

function assessmentCore(record) {
  const dimensions = assess(record);
  const total = dimensions.reduce((sum, item) => sum + item.score, 0);
  const findings = [...new Set(dimensions.flatMap(item => item.reasons))].sort();
  return {
    schemaVersion: ROUTING_ASSESSMENT_SCHEMA_VERSION,
    rubricVersion: ROUTING_RUBRIC_VERSION,
    skillId: record.skillId,
    releaseId: record.releaseId,
    packageDigest: record.packageDigest,
    basedOnRecordDigest: record.recordDigest,
    basedOnRoutingDigest: record.routingDigest,
    dimensions: Object.freeze(dimensions),
    total,
    grade: grade(total),
    findings: Object.freeze(findings),
    limitations: Object.freeze(['not_runtime_eval', 'static_routing_quality_only']),
  };
}

export function createRoutingAssessment(recordInput, { release } = {}) {
  const record = validateSkillRecord(recordInput, { release });
  const core = assessmentCore(record);
  return Object.freeze({ ...core, assessmentDigest: canonicalDigest(core) });
}

export function validateRoutingAssessment(input, { record: recordInput, release } = {}) {
  exactKeys(input, new Set([
    'schemaVersion', 'rubricVersion', 'skillId', 'releaseId', 'packageDigest', 'basedOnRecordDigest',
    'basedOnRoutingDigest', 'dimensions', 'total', 'grade', 'findings', 'limitations', 'assessmentDigest',
  ]), 'routing assessment');
  if (!recordInput) fail('RECORD_REQUIRED', 'record is required to deterministically recompute assessment');
  let expected;
  try { expected = createRoutingAssessment(recordInput, { release }); } catch (error) { fail('RECORD_NOT_CURRENT', error.message); }
  if (canonicalDigest(input) !== canonicalDigest(expected)) fail('ASSESSMENT_MISMATCH', 'assessment does not match deterministic recomputation');
  return expected;
}

export function isRoutingAssessmentCurrent(input, { record, release } = {}) {
  if (!isSkillRecordCurrent(record, { release })) return false;
  try {
    validateRoutingAssessment(input, { record, release });
    return true;
  } catch {
    return false;
  }
}

import { refreshReviewCertification } from './candidate.mjs';
import { localizeCandidateMetadata } from './localization.mjs';

export const REVIEW_QUEUE_SCHEMA_VERSION = 1;

const DEFAULT_EXPIRING_WITHIN_DAYS = 14;
const DAY_MS = 24 * 60 * 60 * 1_000;
const QUEUE_STATUSES = Object.freeze([
  'recalled',
  'rejected',
  'stale',
  'pending_second_review',
  'pending_review',
  'expiring',
  'certified',
  'withdrawn',
]);
const PRIORITY = new Map(QUEUE_STATUSES.map((status, index) => [status, index]));

const STATUS_LABELS_ZH = Object.freeze({
  pending_review: '待首次终审',
  pending_second_review: '待第二人复核',
  expiring: '认证即将到期',
  stale: '认证证据已失效',
  rejected: '终审未通过',
  withdrawn: '已撤回',
  recalled: '已召回',
  certified: '终审已认证',
});

const ACTIONS_ZH = Object.freeze({
  pending_review: '补齐终审证据，并安排第一位可信人工审核。',
  pending_second_review: '安排第二位独立可信人工完成终审。',
  expiring: '在有效期届满前安排两位独立可信人工重新认证。',
  stale: '更新失效证据后，重新完成双人独立终审。',
  rejected: '处理驳回或修改意见，更新证据后重新提交终审。',
  withdrawn: '确认撤回原因；如需恢复，应重新提交并完成终审。',
  recalled: '完成安全处置和证据更新后，重新走双人独立终审。',
  certified: '当前无需处置，持续监控证据变化与认证有效期。',
});

const REASONS_ZH = Object.freeze({
  review_policy_required: '尚未配置终审策略',
  content_evidence_required: '缺少当前内容证据',
  license_evidence_required: '缺少许可证证据',
  package_evidence_required: '缺少完整技能包证据',
  package_audit_required: '完整技能包尚未通过当前版本审计',
  sms_evidence_required: '缺少当前 SMS 评估证据',
  eval_evidence_required: '缺少当前 Eval 运行证据',
  content_audit_required: '内容审计与当前版本不一致',
  four_eyes_incomplete: '双人独立复核尚未完成',
  conflicted_reviewer_excluded: '存在利益冲突审核，未计入有效批准',
  approval_expired: '人工批准已超过有效期',
  content_changed: '技能内容已变化',
  package_changed: '完整技能包已变化',
  license_changed: '许可证证据已变化',
  sms_changed: 'SMS 评估证据已变化',
  eval_changed: 'Eval 运行证据已变化',
  policy_changed: '终审策略已变化',
  evidence_changed: '终审依据的证据已变化',
  human_rejected: '可信人工明确驳回',
  human_requested_changes: '可信人工要求修改后重审',
  review_withdraw: '发行方已撤回候选技能',
  review_recall: '平台已召回候选技能',
  legacy_review_non_certifying: '旧版字符串审批仅作历史记录，不能形成终审认证',
  certification_current: '双人独立终审认证当前有效',
  certification_expiring: '双人独立终审认证即将到期',
  candidate_rejected: '候选技能未通过当前信任门禁',
});

function timestamp(value, label) {
  const date = value === undefined ? new Date() : value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new TypeError(`${label} must be a valid date`);
  return date.toISOString();
}

function expiringDays(value) {
  const resolved = value === undefined ? DEFAULT_EXPIRING_WITHIN_DAYS : value;
  if (!Number.isSafeInteger(resolved) || resolved < 0 || resolved > 365) {
    throw new TypeError('expiringWithinDays must be an integer from 0 to 365');
  }
  return resolved;
}

function safeText(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function safeNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function freeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}

function refresh(candidate, evaluatedAt) {
  if (!candidate.reviewPolicy) return candidate;
  try {
    return refreshReviewCertification(candidate, { clock: () => new Date(evaluatedAt) });
  } catch {
    // A queue projection must remain available for malformed historical records.
    // It reports their stored state without repairing or rewriting the record.
    return candidate;
  }
}

function legacySummary(candidate) {
  const events = Array.isArray(candidate.reviewEvents) ? candidate.reviewEvents : [];
  const approvals = events.filter(event => event?.decision === 'approve').length;
  return {
    present: events.length > 0,
    eventCount: events.length,
    approvalCount: approvals,
    effect: events.length > 0 ? '仅作历史记录，不形成终审认证' : null,
  };
}

function evidenceSummary(candidate, certification) {
  const artifact = candidate?.artifact || {};
  const packageArtifact = artifact.package || null;
  const audit = candidate?.audit || null;
  const sms = candidate?.sms || null;
  const evaluation = candidate?.eval || null;
  const packageAudit = candidate?.packageAudit || null;
  return {
    reviewEvidenceDigest: safeText(certification?.evidenceDigest) || safeText(candidate?.reviewEvidence?.evidenceDigest),
    policyDigest: safeText(certification?.policyDigest) || safeText(candidate?.reviewPolicy?.policyDigest),
    package: {
      present: Boolean(packageArtifact),
      digest: safeText(packageArtifact?.packageDigest),
      auditStatus: safeText(packageAudit?.status) || 'pending',
    },
    licenseStatus: safeText(audit?.license?.status) || 'pending',
    sms: {
      status: safeText(sms?.status) || 'pending',
      total: safeNumber(sms?.total),
      tier: safeText(sms?.tier),
    },
    eval: {
      status: safeText(evaluation?.status) || 'pending',
      successRate: safeNumber(evaluation?.successRate),
    },
  };
}

function classification(candidate, certification, evaluatedAt, thresholdDays) {
  const certificationStatus = safeText(certification?.status) || 'pending';
  const candidateStatus = safeText(candidate?.status);
  if (certificationStatus === 'recalled' || candidateStatus === 'recalled') return 'recalled';
  if (certificationStatus === 'withdrawn' || candidateStatus === 'withdrawn') return 'withdrawn';
  if (certificationStatus === 'rejected' || certificationStatus === 'changes_requested'
    || candidateStatus === 'rejected' || candidateStatus === 'quarantined') return 'rejected';
  if (certificationStatus === 'stale' || certificationStatus === 'expired' || candidateStatus === 'stale') return 'stale';
  if (certificationStatus === 'certified') {
    const expiresAt = Date.parse(certification.validUntil || '');
    const remaining = expiresAt - Date.parse(evaluatedAt);
    if (Number.isFinite(expiresAt) && remaining > 0 && remaining <= thresholdDays * DAY_MS) return 'expiring';
    return 'certified';
  }
  const approvals = Array.isArray(certification?.approvals) ? certification.approvals.length : 0;
  return approvals > 0 ? 'pending_second_review' : 'pending_review';
}

function reasonCodes(candidate, certification, queueStatus, legacy) {
  const codes = Array.isArray(certification?.reasons)
    ? certification.reasons.filter(reason => typeof reason === 'string' && reason)
    : [];
  if (legacy.present && certification?.status !== 'certified') codes.push('legacy_review_non_certifying');
  if (queueStatus === 'rejected' && codes.length === 0) codes.push('candidate_rejected');
  if (queueStatus === 'expiring') codes.push('certification_expiring');
  if (queueStatus === 'certified' && codes.length === 0) codes.push('certification_current');
  return [...new Set(codes)];
}

function localizedReason(codes) {
  return codes.map(code => REASONS_ZH[code] || `终审状态原因：${code}`).join('；');
}

export function projectReviewStatus(candidate, { now, expiringWithinDays } = {}) {
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
    throw new TypeError('candidate must be an object');
  }
  const evaluatedAt = timestamp(now, 'now');
  const thresholdDays = expiringDays(expiringWithinDays);
  const current = refresh(candidate, evaluatedAt);
  const certification = current.certification || { status: 'pending', reasons: ['review_policy_required'], approvals: [] };
  const legacy = legacySummary(current);
  const queueStatus = classification(current, certification, evaluatedAt, thresholdDays);
  const codes = reasonCodes(current, certification, queueStatus, legacy);
  const requiredApprovals = Number.isSafeInteger(certification.requiredApprovals)
    ? certification.requiredApprovals
    : Number.isSafeInteger(current.reviewPolicy?.minimumIndependentHumanApprovals)
      ? current.reviewPolicy.minimumIndependentHumanApprovals
      : 2;
  const approvalCount = Array.isArray(certification.approvals) ? certification.approvals.length : 0;
  const validUntil = safeText(certification.validUntil);
  const expiryMilliseconds = validUntil ? Date.parse(validUntil) : Number.NaN;
  const daysUntilExpiry = Number.isFinite(expiryMilliseconds)
    ? Math.max(0, Math.ceil((expiryMilliseconds - Date.parse(evaluatedAt)) / DAY_MS))
    : null;
  const localization = localizeCandidateMetadata(current);

  return freeze({
    schemaVersion: REVIEW_QUEUE_SCHEMA_VERSION,
    candidateId: safeText(current.id) || 'unknown-candidate',
    titleZh: localization.titleZh,
    queueStatus,
    statusLabelZh: STATUS_LABELS_ZH[queueStatus],
    certificationStatus: safeText(certification.status) || 'pending',
    reasonCodes: codes,
    reasonZh: localizedReason(codes),
    actionZh: ACTIONS_ZH[queueStatus],
    approvalProgress: {
      approved: approvalCount,
      required: requiredApprovals,
      remaining: Math.max(0, requiredApprovals - approvalCount),
    },
    validUntil,
    daysUntilExpiry,
    evaluatedAt,
    evidence: evidenceSummary(current, certification),
    legacy,
  });
}

function normalizeStatuses(statuses) {
  if (statuses === undefined) return null;
  const values = typeof statuses === 'string' ? [statuses] : statuses;
  if (!Array.isArray(values)) throw new TypeError('statuses must be a string or array');
  const normalized = [...new Set(values.map(value => String(value).trim()).filter(Boolean))];
  const unsupported = normalized.filter(value => !PRIORITY.has(value));
  if (unsupported.length) throw new TypeError(`unsupported review queue status: ${unsupported.join(', ')}`);
  return new Set(normalized);
}

function summary(items) {
  const counts = Object.fromEntries(QUEUE_STATUSES.map(status => [status, 0]));
  for (const item of items) counts[item.queueStatus] += 1;
  return { total: items.length, ...counts };
}

export function projectReviewQueue(candidates, { now, expiringWithinDays, statuses } = {}) {
  const values = Array.isArray(candidates) ? candidates : candidates == null ? [] : [candidates];
  const evaluatedAt = timestamp(now, 'now');
  const thresholdDays = expiringDays(expiringWithinDays);
  const selected = normalizeStatuses(statuses);
  const projected = values
    .map(candidate => projectReviewStatus(candidate, { now: evaluatedAt, expiringWithinDays: thresholdDays }))
    .filter(item => !selected || selected.has(item.queueStatus))
    .sort((left, right) => {
      const priority = PRIORITY.get(left.queueStatus) - PRIORITY.get(right.queueStatus);
      if (priority !== 0) return priority;
      const leftDeadline = left.validUntil || '9999';
      const rightDeadline = right.validUntil || '9999';
      const deadline = leftDeadline < rightDeadline ? -1 : leftDeadline > rightDeadline ? 1 : 0;
      if (deadline) return deadline;
      return left.candidateId < right.candidateId ? -1 : left.candidateId > right.candidateId ? 1 : 0;
    });

  return freeze({
    schemaVersion: REVIEW_QUEUE_SCHEMA_VERSION,
    generatedAt: evaluatedAt,
    expiringWithinDays: thresholdDays,
    summary: summary(projected),
    items: projected,
  });
}

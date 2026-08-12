export const SMS_RUBRIC_VERSION = 'SMS-2.0';

function freezeDimension(dimension) {
  return Object.freeze(dimension);
}

export const SMS_DIMENSIONS = Object.freeze([
  freezeDimension({ key: 'clarity', label: '清晰度', pillar: 'comprehension' }),
  freezeDimension({ key: 'invocability', label: '可调用性', pillar: 'comprehension' }),
  freezeDimension({ key: 'executability', label: '可执行性', pillar: 'execution' }),
  freezeDimension({ key: 'stability', label: '输出稳定性', pillar: 'execution' }),
  freezeDimension({ key: 'quality', label: '结果质量', pillar: 'execution' }),
  freezeDimension({ key: 'reusability', label: '可复用性', pillar: 'engineering' }),
  freezeDimension({ key: 'composability', label: '可组合性', pillar: 'engineering' }),
  freezeDimension({ key: 'evaluability', label: '可评估性', pillar: 'engineering' }),
  freezeDimension({ key: 'safety', label: '安全性', pillar: 'trust' }),
  freezeDimension({ key: 'business', label: '商业价值', pillar: 'trust' }),
]);

const DIMENSION_KEYS = new Set(SMS_DIMENSIONS.map(dimension => dimension.key));
const FINGERPRINT_PATTERN = /^sha256:[a-f0-9]{64}$/;

function fail(message) {
  throw new TypeError(`invalid SMS assessment: ${message}`);
}

function assertObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object`);
}

function requiredText(value, label) {
  if (typeof value !== 'string' || !value.trim()) fail(`${label} must be a non-empty string`);
  return value.trim();
}

function normalizeFingerprint(value, label = 'basedOnFingerprint') {
  const fingerprint = requiredText(value, label).toLowerCase();
  if (!FINGERPRINT_PATTERN.test(fingerprint)) fail(`${label} must be a sha256 fingerprint`);
  return fingerprint;
}

function normalizeTimestamp(value) {
  const timestamp = requiredText(value, 'scoredAt');
  const milliseconds = Date.parse(timestamp);
  if (!Number.isFinite(milliseconds)) fail('scoredAt must be a valid timestamp');
  return new Date(milliseconds).toISOString();
}

function normalizeEvidence(value, key) {
  if (!Array.isArray(value) || value.length === 0) fail(`dimension ${key} evidence must be a non-empty array`);
  return value.map((item, index) => requiredText(item, `dimension ${key} evidence[${index}]`));
}

function normalizeDimension(value, expectedKey) {
  assertObject(value, `dimension ${expectedKey}`);
  const key = requiredText(value.key ?? expectedKey, `dimension ${expectedKey} key`);
  if (key !== expectedKey) fail(`dimension key ${key} does not match ${expectedKey}`);
  const score = value.score;
  if (!Number.isInteger(score) || score < 0 || score > 10) {
    fail(`dimension ${key} score must be an integer between 0 and 10`);
  }
  return {
    key,
    score,
    reason: requiredText(value.reason, `dimension ${key} reason`),
    evidence: normalizeEvidence(value.evidence, key),
  };
}

function dimensionsByKey(input) {
  if (Array.isArray(input)) {
    const result = new Map();
    for (const value of input) {
      assertObject(value, 'dimension');
      const key = requiredText(value.key, 'dimension key');
      if (!DIMENSION_KEYS.has(key)) fail(`unknown dimension: ${key}`);
      if (result.has(key)) fail(`duplicate dimension: ${key}`);
      result.set(key, value);
    }
    return result;
  }
  assertObject(input, 'dimensions');
  const keys = Object.keys(input);
  for (const key of keys) if (!DIMENSION_KEYS.has(key)) fail(`unknown dimension: ${key}`);
  return new Map(keys.map(key => [key, input[key]]));
}

function normalizeDimensions(input) {
  const byKey = dimensionsByKey(input);
  const missing = SMS_DIMENSIONS.map(dimension => dimension.key).filter(key => !byKey.has(key));
  if (missing.length) fail(`missing dimensions: ${missing.join(', ')}`);
  if (byKey.size !== SMS_DIMENSIONS.length) fail(`dimensions must contain exactly ${SMS_DIMENSIONS.length} entries`);
  return SMS_DIMENSIONS.map(dimension => normalizeDimension(byKey.get(dimension.key), dimension.key));
}

export function smsTier(total) {
  if (!Number.isInteger(total) || total < 0 || total > 100) {
    fail('total must be an integer between 0 and 100');
  }
  if (total >= 86) return 'S';
  if (total >= 76) return 'A';
  if (total >= 64) return 'B';
  if (total >= 50) return 'C';
  return 'D';
}

export function validateSmsAssessment(input, { fingerprint } = {}) {
  assertObject(input, 'assessment');
  if (input.rubricVersion !== SMS_RUBRIC_VERSION) fail(`rubricVersion must be ${SMS_RUBRIC_VERSION}`);
  if (input.status !== undefined && input.status !== 'complete') fail('status must be complete');

  const dimensions = normalizeDimensions(input.dimensions);
  const calculatedTotal = dimensions.reduce((sum, dimension) => sum + dimension.score, 0);
  if (input.total !== calculatedTotal) fail(`total must equal dimension sum ${calculatedTotal}`);
  const expectedTier = smsTier(calculatedTotal);
  if (input.tier !== expectedTier) fail(`tier must be ${expectedTier} for total ${calculatedTotal}`);

  const basedOnFingerprint = normalizeFingerprint(input.basedOnFingerprint);
  if (fingerprint !== undefined && basedOnFingerprint !== normalizeFingerprint(fingerprint, 'fingerprint')) {
    fail('basedOnFingerprint does not match current content fingerprint');
  }

  return {
    schemaVersion: 1,
    status: 'complete',
    rubricVersion: SMS_RUBRIC_VERSION,
    dimensions,
    total: calculatedTotal,
    tier: expectedTier,
    scorer: requiredText(input.scorer, 'scorer'),
    scoredAt: normalizeTimestamp(input.scoredAt),
    basedOnFingerprint,
  };
}

function clockTimestamp(clock) {
  const value = clock ? clock() : new Date();
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) fail('clock must produce a valid timestamp');
  return date.toISOString();
}

export function createSmsAssessment(input, { fingerprint, clock } = {}) {
  assertObject(input, 'assessment');
  if (input.rubricVersion !== undefined && input.rubricVersion !== SMS_RUBRIC_VERSION) {
    fail(`rubricVersion must be ${SMS_RUBRIC_VERSION}`);
  }
  const dimensions = normalizeDimensions(input.dimensions);
  const total = dimensions.reduce((sum, dimension) => sum + dimension.score, 0);
  const tier = smsTier(total);
  if (input.total !== undefined && input.total !== total) fail(`total must equal dimension sum ${total}`);
  if (input.tier !== undefined && input.tier !== tier) fail(`tier must be ${tier} for total ${total}`);

  const currentFingerprint = normalizeFingerprint(fingerprint ?? input.basedOnFingerprint, 'fingerprint');
  if (input.basedOnFingerprint !== undefined
    && normalizeFingerprint(input.basedOnFingerprint) !== currentFingerprint) {
    fail('basedOnFingerprint does not match current content fingerprint');
  }

  return validateSmsAssessment({
    rubricVersion: SMS_RUBRIC_VERSION,
    status: 'complete',
    dimensions,
    total,
    tier,
    scorer: input.scorer,
    scoredAt: input.scoredAt === undefined ? clockTimestamp(clock) : input.scoredAt,
    basedOnFingerprint: currentFingerprint,
  }, { fingerprint: currentFingerprint });
}

export function isSmsCurrent(candidate) {
  const fingerprint = candidate?.artifact?.fingerprint;
  if (!candidate?.sms || !fingerprint) return false;
  try {
    validateSmsAssessment(candidate.sms, { fingerprint });
    return true;
  } catch {
    return false;
  }
}

import crypto from 'node:crypto';

export const COMMERCE_SCHEMA_VERSION = 1;

export const PRODUCT_ID = /^prod_[a-f0-9]{64}$/;
export const RELEASE_ID = /^(?:rel|apprel)_[a-f0-9]{64}$/;
export const OFFER_ID = /^offer_[a-z0-9](?:[a-z0-9._-]{0,94}[a-z0-9])?$/;
export const ORDER_ID = /^ord_[a-z0-9](?:[a-z0-9._-]{0,94}[a-z0-9])?$/;
export const ENTITLEMENT_ID = /^ent_[a-f0-9]{64}$/;
export const ORGANIZATION_ID = /^org_[a-z0-9](?:[a-z0-9._-]{0,94}[a-z0-9])?$/;
export const PROJECT_ID = /^project_[a-z0-9](?:[a-z0-9._-]{0,90}[a-z0-9])?$/;
export const SAFE_IDENTIFIER = /^[a-z][a-z0-9._:-]{1,127}$/;

export class CommerceDomainError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'CommerceDomainError';
    this.code = code;
  }
}

export function fail(code, message) {
  throw new CommerceDomainError(code, message);
}

export function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('INVALID_STRUCTURE', `${label} must be an object`);
  return value;
}

export function exactKeys(value, allowed, label) {
  object(value, label);
  const unknown = Object.keys(value).filter(key => !allowed.has(key));
  if (unknown.length) fail('UNKNOWN_FIELD', `${label} contains unknown fields: ${unknown.join(', ')}`);
}

export function text(value, label, { maximum = 512, pattern } = {}) {
  if (typeof value !== 'string' || !value.trim()) fail('INVALID_TEXT', `${label} must be a non-empty string`);
  const normalized = value.normalize('NFC').trim();
  if (/^cand_/i.test(normalized) || normalized.split(/[\/:]/).some(part => /^cand_/i.test(part))) {
    fail('CANDIDATE_ID_FORBIDDEN', `${label} must not use Candidate identity`);
  }
  if (normalized.includes('\0') || [...normalized].length > maximum || (pattern && !pattern.test(normalized))) {
    fail('INVALID_TEXT', `${label} is invalid`);
  }
  return normalized;
}

export function timestamp(value, label) {
  const normalized = text(value, label, { maximum: 128 });
  const milliseconds = Date.parse(normalized);
  if (!Number.isFinite(milliseconds)) fail('INVALID_TIMESTAMP', `${label} must be a valid timestamp`);
  return new Date(milliseconds).toISOString();
}

export function optionalTimestamp(value, label) {
  return value == null ? null : timestamp(value, label);
}

export function integer(value, label, { minimum = 0, maximum = Number.MAX_SAFE_INTEGER } = {}) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) fail('INVALID_NUMBER', `${label} is invalid`);
  return value;
}

export function boolean(value, label) {
  if (typeof value !== 'boolean') fail('INVALID_BOOLEAN', `${label} must be boolean`);
  return value;
}

export function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  }
  return typeof value === 'string' ? value.normalize('NFC') : value;
}

export function digest(value) {
  let serialized;
  try {
    serialized = JSON.stringify(canonical(value));
  } catch {
    fail('NOT_JSON', 'value must be JSON serializable');
  }
  if (serialized === undefined) fail('NOT_JSON', 'value must be JSON serializable');
  return `sha256:${crypto.createHash('sha256').update(serialized).digest('hex')}`;
}

export function contentId(prefix, value) {
  return `${prefix}_${digest(value).slice(7)}`;
}

export function uniqueStrings(value, label, { pattern, maximum = 100, nonEmpty = false } = {}) {
  if (!Array.isArray(value) || value.length > maximum || (nonEmpty && value.length === 0)) {
    fail('INVALID_ARRAY', `${label} must be ${nonEmpty ? 'a non-empty ' : 'an '}array within limits`);
  }
  const normalized = value.map((item, index) => text(item, `${label}[${index}]`, { maximum: 128, pattern }));
  if (new Set(normalized).size !== normalized.length) fail('DUPLICATE_VALUE', `${label} must not contain duplicates`);
  return [...normalized].sort();
}

export function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.values(value).forEach(deepFreeze);
  return Object.freeze(value);
}

export function clone(value) {
  return structuredClone(value);
}

export function compareTime(left, right) {
  return Date.parse(left) - Date.parse(right);
}

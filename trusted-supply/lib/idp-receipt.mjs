import crypto from 'node:crypto';

export const IDP_RECEIPT_SCHEMA_VERSION = 1;

const DIGEST = /^sha256:[a-f0-9]{64}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,255}$/;
const KINDS = new Set(['human', 'service']);
const RECEIPT_KEYS = new Set([
  'schemaVersion', 'provider', 'purpose', 'subjectDigest', 'kind', 'issuedAt', 'expiresAt', 'receiptDigest',
]);
const CALLER_TRUST_FIELDS = new Set([
  'verified', 'verification', 'trusted', 'principal', 'principalId', 'subject', 'subjectDigest',
  'email', 'token', 'secret', 'providerSecret', 'receiptDigest', 'kind', 'issuedAt', 'expiresAt',
]);

export class IdpReceiptError extends Error {
  constructor(code, message, options) {
    super(message, options);
    this.name = 'IdpReceiptError';
    this.code = code;
  }
}

function fail(code, message, options) {
  throw new IdpReceiptError(code, message, options);
}

function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail('invalid_structure', `${label} must be an object`);
  }
  return value;
}

function exactKeys(value, allowed, label) {
  object(value, label);
  const unknown = Object.keys(value).filter(key => !allowed.has(key));
  if (unknown.length) fail('unknown_field', `${label} contains unknown fields: ${unknown.join(', ')}`);
}

function text(value, label, maximum = 256) {
  if (typeof value !== 'string' || !value.trim()) fail('invalid_text', `${label} must be a non-empty string`);
  const normalized = value.normalize('NFC').trim();
  if (normalized.includes('\0') || [...normalized].length > maximum) fail('invalid_text', `${label} is invalid or too long`);
  return normalized;
}

function id(value, label) {
  const normalized = text(value, label);
  if (!ID.test(normalized)) fail('invalid_id', `${label} contains unsupported characters`);
  return normalized;
}

function timestamp(value, label) {
  const normalized = text(value, label, 128);
  const milliseconds = Date.parse(normalized);
  if (!Number.isFinite(milliseconds)) fail('invalid_timestamp', `${label} must be a valid timestamp`);
  return new Date(milliseconds).toISOString();
}

function nowTimestamp(value, label = 'now') {
  const resolved = value === undefined ? new Date() : (typeof value === 'function' ? value() : value);
  const date = resolved instanceof Date ? resolved : new Date(resolved);
  if (!Number.isFinite(date.getTime())) fail('invalid_clock', `${label} must resolve to a valid time`);
  return date.toISOString();
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  }
  return value;
}

function hmac(key, domain, value) {
  return `sha256:${crypto.createHmac('sha256', key).update(domain).update('\0').update(JSON.stringify(canonical(value))).digest('hex')}`;
}

function secretKey(value) {
  const key = typeof value === 'string' ? Buffer.from(value, 'utf8') : Buffer.from(value ?? []);
  if (key.byteLength < 32) fail('invalid_receipt_key', 'fixture receiptKey must contain at least 32 bytes');
  return key;
}

function safeDigestEqual(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string' || !DIGEST.test(left) || !DIGEST.test(right)) return false;
  return crypto.timingSafeEqual(Buffer.from(left, 'ascii'), Buffer.from(right, 'ascii'));
}

function receiptBody(receipt) {
  return {
    schemaVersion: receipt.schemaVersion,
    provider: receipt.provider,
    purpose: receipt.purpose,
    subjectDigest: receipt.subjectDigest,
    kind: receipt.kind,
    issuedAt: receipt.issuedAt,
    expiresAt: receipt.expiresAt,
  };
}

function normalizeReceipt(input) {
  exactKeys(input, RECEIPT_KEYS, 'identity receipt');
  if (input.schemaVersion !== IDP_RECEIPT_SCHEMA_VERSION) {
    fail('unsupported_schema', `identity receipt schemaVersion must be ${IDP_RECEIPT_SCHEMA_VERSION}`);
  }
  if (!DIGEST.test(input.subjectDigest ?? '')) fail('invalid_subject_digest', 'subjectDigest must be a SHA-256 digest');
  if (!KINDS.has(input.kind)) fail('invalid_identity_kind', 'identity receipt kind must be human or service');
  if (!DIGEST.test(input.receiptDigest ?? '')) fail('invalid_receipt_digest', 'receiptDigest must be a SHA-256 digest');
  const receipt = {
    schemaVersion: IDP_RECEIPT_SCHEMA_VERSION,
    provider: id(input.provider, 'provider'),
    purpose: id(input.purpose, 'purpose'),
    subjectDigest: input.subjectDigest,
    kind: input.kind,
    issuedAt: timestamp(input.issuedAt, 'issuedAt'),
    expiresAt: timestamp(input.expiresAt, 'expiresAt'),
    receiptDigest: input.receiptDigest,
  };
  if (Date.parse(receipt.expiresAt) <= Date.parse(receipt.issuedAt)) {
    fail('invalid_receipt_validity', 'expiresAt must be later than issuedAt');
  }
  return receipt;
}

function providerVerifier(verifiers, provider) {
  if (!Array.isArray(verifiers) || verifiers.length < 1) {
    fail('invalid_trust_policy', 'trustedProviderVerifiers must be a non-empty array');
  }
  const matches = verifiers.filter(candidate => candidate?.provider === provider && typeof candidate.verifyReceipt === 'function');
  if (matches.length !== 1) fail('untrusted_provider', 'identity receipt provider is not explicitly trusted');
  return matches[0];
}

export function validateIdpReceipt(input, {
  trustedProviderVerifiers,
  purpose: requiredPurpose,
  now,
} = {}) {
  const receipt = normalizeReceipt(input);
  const verifier = providerVerifier(trustedProviderVerifiers, receipt.provider);
  const purpose = id(requiredPurpose, 'purpose');
  if (receipt.purpose !== purpose) fail('wrong_purpose', 'identity receipt was issued for a different purpose');
  const evaluatedAt = nowTimestamp(now);
  if (Date.parse(receipt.issuedAt) > Date.parse(evaluatedAt)) {
    fail('receipt_not_yet_valid', 'identity receipt was issued in the future');
  }
  if (Date.parse(receipt.expiresAt) <= Date.parse(evaluatedAt)) {
    fail('receipt_expired', 'identity receipt is expired');
  }
  if (verifier.purpose !== undefined && verifier.purpose !== receipt.purpose) {
    fail('wrong_purpose', 'trusted verifier does not authorize this receipt purpose');
  }
  if (verifier.verifyReceipt(receipt) !== true) {
    fail('receipt_digest_mismatch', 'identity receipt signature does not match its content');
  }
  return Object.freeze(receipt);
}

export function createFixtureIdpVerifier({
  provider: inputProvider,
  purpose: inputPurpose,
  assertionVerifier,
  receiptKey,
  clock,
  ttlMs = 15 * 60 * 1_000,
} = {}) {
  const provider = id(inputProvider, 'provider');
  const purpose = id(inputPurpose, 'purpose');
  if (typeof assertionVerifier !== 'function') fail('invalid_assertion_verifier', 'assertionVerifier must be a function');
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 1 || ttlMs > 24 * 60 * 60 * 1_000) {
    fail('invalid_receipt_ttl', 'fixture receipt ttlMs must be from 1 ms to 24 hours');
  }
  const key = secretKey(receiptKey);

  const verifyReceipt = receipt => {
    try {
      const normalized = normalizeReceipt(receipt);
      if (normalized.provider !== provider || normalized.purpose !== purpose) return false;
      return safeDigestEqual(normalized.receiptDigest, hmac(key, 'skillops.idp-receipt.v1', receiptBody(normalized)));
    } catch {
      return false;
    }
  };

  const issueReceipt = async assertion => {
    object(assertion, 'provider assertion');
    const forbidden = Object.keys(assertion).filter(field => CALLER_TRUST_FIELDS.has(field));
    if (forbidden.length) {
      fail('untrusted_assertion_claim', `provider assertion contains caller supplied identity or trust claims: ${forbidden.join(', ')}`);
    }
    let verified;
    try {
      verified = await assertionVerifier(assertion);
    } catch (cause) {
      fail('provider_assertion_rejected', 'fixture provider assertion was rejected', { cause });
    }
    object(verified, 'verified provider assertion');
    const unknownVerifiedFields = Object.keys(verified).filter(field => field !== 'subject' && field !== 'kind');
    if (unknownVerifiedFields.length) {
      fail('invalid_provider_assertion', `verified provider assertion contains unsupported fields: ${unknownVerifiedFields.join(', ')}`);
    }
    const subject = text(verified.subject, 'verified provider assertion subject', 1_000);
    if (!KINDS.has(verified.kind)) fail('invalid_provider_assertion', 'verified provider assertion kind must be human or service');
    const issuedAt = nowTimestamp(clock, 'clock');
    const body = {
      schemaVersion: IDP_RECEIPT_SCHEMA_VERSION,
      provider,
      purpose,
      subjectDigest: hmac(key, 'skillops.idp-subject.v1', { provider, subject }),
      kind: verified.kind,
      issuedAt,
      expiresAt: new Date(Date.parse(issuedAt) + ttlMs).toISOString(),
    };
    return Object.freeze({
      ...body,
      receiptDigest: hmac(key, 'skillops.idp-receipt.v1', body),
    });
  };

  return Object.freeze({
    provider,
    purpose,
    fixture: true,
    issueReceipt,
    verifyReceipt,
  });
}

export function toReviewIdentity(receiptInput, validationOptions) {
  const receipt = validateIdpReceipt(receiptInput, validationOptions);
  const pseudonym = receipt.subjectDigest.slice('sha256:'.length);
  const kind = receipt.kind === 'human' ? 'human' : 'agent';
  return Object.freeze({
    kind,
    principalId: `idp:${receipt.provider}:${pseudonym}`,
    subject: `idp-subject:${receipt.provider}:${pseudonym}`,
    provider: receipt.provider,
    displayName: `${kind === 'human' ? 'human' : 'service'}:${pseudonym.slice(0, 12)}`,
    verification: Object.freeze({
      status: kind === 'human' ? 'verified' : 'service',
      verifiedAt: receipt.issuedAt,
      expiresAt: receipt.expiresAt,
      reference: `idp-receipt:${receipt.receiptDigest}`,
    }),
  });
}

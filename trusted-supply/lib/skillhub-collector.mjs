import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { classifyLicense, parseSkillDocument, scanSecurity } from './audit.mjs';
import { CandidateStore } from './store.mjs';

const API_ORIGIN = 'https://api.skillhub.cn';
const MARKET_ORIGIN = 'https://skillhub.cn';
const ALLOWED_SHELVES = new Set(['recommended', 'trending', 'hot', 'newest']);
const LICENSE_FILE = /^(?:licen[cs]e|copying)(?:\.(?:md|markdown|txt))?$/i;

const DEFAULT_OPTIONS = Object.freeze({
  shelves: ['recommended', 'trending'],
  limit: 6,
  scanLimit: 30,
  maxPerCategory: 2,
  maxSkillBytes: 512 * 1024,
  maxLicenseBytes: 256 * 1024,
  timeoutMs: 15_000,
  requireSigned: true,
  requireBenignReports: 2,
  allowApiKey: false,
  audit: false,
});

const HARD_LIMITS = Object.freeze({ limit: 50, scanLimit: 200, maxSkillBytes: 2 * 1024 * 1024, maxLicenseBytes: 1024 * 1024 });

export class SkillHubCollectionError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'SkillHubCollectionError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new SkillHubCollectionError(code, message);
}

function integer(value, name, maximum) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1 || number > maximum) fail('invalid_limit', `${name} must be between 1 and ${maximum}`);
  return number;
}

export function resolveSkillHubOptions(input = {}) {
  const shelves = input.shelves ?? DEFAULT_OPTIONS.shelves;
  if (!Array.isArray(shelves) || shelves.length === 0 || shelves.some(value => !ALLOWED_SHELVES.has(value))) {
    fail('invalid_shelves', `shelves must contain only: ${[...ALLOWED_SHELVES].join(', ')}`);
  }
  return {
    ...DEFAULT_OPTIONS,
    ...input,
    shelves: [...new Set(shelves)],
    limit: integer(input.limit ?? DEFAULT_OPTIONS.limit, 'limit', HARD_LIMITS.limit),
    scanLimit: integer(input.scanLimit ?? DEFAULT_OPTIONS.scanLimit, 'scanLimit', HARD_LIMITS.scanLimit),
    maxPerCategory: integer(input.maxPerCategory ?? DEFAULT_OPTIONS.maxPerCategory, 'maxPerCategory', HARD_LIMITS.limit),
    maxSkillBytes: integer(input.maxSkillBytes ?? DEFAULT_OPTIONS.maxSkillBytes, 'maxSkillBytes', HARD_LIMITS.maxSkillBytes),
    maxLicenseBytes: integer(input.maxLicenseBytes ?? DEFAULT_OPTIONS.maxLicenseBytes, 'maxLicenseBytes', HARD_LIMITS.maxLicenseBytes),
    timeoutMs: integer(input.timeoutMs ?? DEFAULT_OPTIONS.timeoutMs, 'timeoutMs', 120_000),
    requireBenignReports: Number(input.requireBenignReports ?? DEFAULT_OPTIONS.requireBenignReports),
    requireSigned: input.requireSigned ?? DEFAULT_OPTIONS.requireSigned,
    allowApiKey: input.allowApiKey ?? DEFAULT_OPTIONS.allowApiKey,
    audit: input.audit ?? DEFAULT_OPTIONS.audit,
  };
}

function coordinate(item) {
  const namespace = item.namespace?.handle || item.namespace?.displayName || item.ownerName;
  if (!namespace || !item.slug) fail('invalid_skill', 'SkillHub item is missing namespace or slug');
  return { namespace: String(namespace), slug: String(item.slug) };
}

function endpoint(route, query = {}) {
  const url = new URL(route, API_ORIGIN);
  for (const [key, value] of Object.entries(query)) if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value));
  return url;
}

async function fetchResponse(url, { fetchImpl, timeoutMs }) {
  if (url.origin !== API_ORIGIN) fail('invalid_endpoint', `unexpected SkillHub API origin: ${url.origin}`);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetchImpl(url, { headers: { Accept: 'application/json, text/plain;q=0.9' }, signal: controller.signal });
  } catch (error) {
    fail(error?.name === 'AbortError' ? 'network_timeout' : 'network_failed', error.message);
  } finally {
    clearTimeout(timer);
  }
  if (!response.ok) fail('http_error', `${url.pathname} returned HTTP ${response.status}`);
  const length = Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(length) && length > 4 * 1024 * 1024) fail('response_too_large', `${url.pathname} response is too large`);
  return response;
}

async function fetchJson(route, query, context) {
  const response = await fetchResponse(endpoint(route, query), context);
  try {
    const text = await response.text();
    if (Buffer.byteLength(text, 'utf8') > 4 * 1024 * 1024) fail('response_too_large', `${route} response is too large`);
    return JSON.parse(text);
  } catch {
    fail('invalid_response', `${route} did not return JSON`);
  }
}

async function fetchText(route, query, context, maxBytes) {
  const response = await fetchResponse(endpoint(route, query), context);
  const text = await response.text();
  if (Buffer.byteLength(text, 'utf8') > maxBytes) fail('file_size_limit_exceeded', `${query.path} exceeds ${maxBytes} bytes`);
  if (text.includes('\0')) fail('binary_file_rejected', `${query.path} contains NUL bytes`);
  return text;
}

function safeFilePath(value) {
  const filePath = String(value || '').replaceAll('\\', '/');
  if (!filePath || filePath.startsWith('/') || filePath.includes('\0') || filePath.split('/').some(part => !part || part === '.' || part === '..')) {
    fail('unsafe_file_path', `unsafe SkillHub file path: ${value}`);
  }
  return filePath;
}

function benignReports(reports = {}) {
  return Object.entries(reports).filter(([, report]) => report?.status === 'benign').map(([provider]) => provider);
}

function apiKeyRequired(item) {
  return String(item.labels?.requires_api_key || '').toLowerCase() === 'true';
}

function isPaid(item) {
  return item.category === 'pay-skill' || item.isServiceized === true || item.billing?.enabled === true;
}

function sha256(content) {
  return crypto.createHash('sha256').update(content, 'utf8').digest('hex');
}

function chooseLicenseFile(files) {
  return files
    .map(file => ({ ...file, path: safeFilePath(file.path) }))
    .filter(file => LICENSE_FILE.test(path.posix.basename(file.path)))
    .sort((a, b) => a.path.split('/').length - b.path.split('/').length || a.path.localeCompare(b.path))[0] || null;
}

function licenseFromFrontmatter(content) {
  const value = parseSkillDocument(content).frontmatter.license;
  return value ? String(value) : null;
}

function publicMarketUrl(namespace, slug) {
  const url = new URL(`/skills/${encodeURIComponent(slug)}`, MARKET_ORIGIN);
  url.searchParams.set('namespace', namespace);
  return url.href;
}

function serializeError(error, item) {
  let label = 'unknown';
  try {
    const value = coordinate(item);
    label = `@${value.namespace}/${value.slug}`;
  } catch {}
  return { skill: label, code: error.code || 'collection_failed', message: error.message };
}

async function inspectSkill(item, options, context) {
  const { namespace, slug } = coordinate(item);
  const detail = await fetchJson(`/api/v1/skills/${encodeURIComponent(slug)}`, { namespace }, context);
  const skill = { ...item, ...(detail.skill || {}) };
  const version = detail.latestVersion?.version || skill.version;
  if (!version) fail('missing_version', `@${namespace}/${slug} has no version`);
  if (isPaid(skill)) fail('paid_skill_excluded', `@${namespace}/${slug} is paid or serviceized`);
  if (!options.allowApiKey && apiKeyRequired(skill)) fail('api_key_excluded', `@${namespace}/${slug} requires an API key`);

  const providers = benignReports(detail.securityReports);
  if (providers.length < options.requireBenignReports) {
    fail('external_security_insufficient', `@${namespace}/${slug} has ${providers.length} benign external security reports`);
  }
  const signature = await fetchJson(`/api/v1/open/skills/${encodeURIComponent(slug)}/versions/${encodeURIComponent(version)}/signature`, { namespace }, context);
  if (options.requireSigned && signature.signed !== true) fail('unsigned_package', `@${namespace}/${slug}@${version} is not signed`);
  if (signature.skill_slug && signature.skill_slug !== slug) fail('integrity_mismatch', `signature slug mismatch for @${namespace}/${slug}`);
  if (signature.skill_version && signature.skill_version !== version) fail('integrity_mismatch', `signature version mismatch for @${namespace}/${slug}`);

  const filePayload = await fetchJson(`/api/v1/skills/${encodeURIComponent(slug)}/files`, { version, namespace }, context);
  const files = Array.isArray(filePayload.files) ? filePayload.files : [];
  if (files.length > 1000) fail('file_count_limit_exceeded', `@${namespace}/${slug} contains ${files.length} files`);
  for (const file of files) safeFilePath(file.path);
  const skillFile = files.find(file => file.path === 'SKILL.md');
  if (!skillFile) fail('missing_skill_file', `@${namespace}/${slug} has no root SKILL.md`);
  if (Number(skillFile.size) > options.maxSkillBytes) fail('file_size_limit_exceeded', `SKILL.md exceeds ${options.maxSkillBytes} bytes`);
  const content = await fetchText(`/api/v1/skills/${encodeURIComponent(slug)}/file`, { path: 'SKILL.md', version, namespace }, context, options.maxSkillBytes);
  if (skillFile.sha256 && sha256(content) !== skillFile.sha256) fail('integrity_mismatch', `SKILL.md hash mismatch for @${namespace}/${slug}`);

  const licenseFile = chooseLicenseFile(files);
  const license = licenseFile
    ? await fetchText(`/api/v1/skills/${encodeURIComponent(slug)}/file`, { path: licenseFile.path, version, namespace }, context, options.maxLicenseBytes)
    : licenseFromFrontmatter(content);
  const localSecurity = scanSecurity(content);
  return {
    namespace,
    slug,
    version,
    content,
    license,
    licenseFile: licenseFile?.path || null,
    licenseAssessment: classifyLicense(license),
    localSecurity,
    externalSecurityProviders: providers,
    signature,
    skill,
    sourceUrl: detail.skill?.sourceUrl || detail.skill?.upstream_url || skill.sourceUrl || skill.upstream_url || null,
  };
}

function atomicJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(temporary, filePath);
}

export async function collectSkillHub({ storePath, reportPath, fetchImpl = globalThis.fetch, clock, ...input } = {}) {
  if (!storePath) fail('invalid_store', 'storePath is required');
  if (typeof fetchImpl !== 'function') fail('missing_fetch', 'fetch implementation is required');
  const options = resolveSkillHubOptions(input);
  const context = { fetchImpl, timeoutMs: options.timeoutMs };
  const store = new CandidateStore(storePath);
  const generatedAt = (clock ? clock() : new Date()).toISOString();
  const report = {
    schemaVersion: 1,
    source: 'skillhub.cn',
    generatedAt,
    policy: {
      shelves: options.shelves,
      limit: options.limit,
      scanLimit: options.scanLimit,
      maxPerCategory: options.maxPerCategory,
      requireSigned: options.requireSigned,
      requireBenignReports: options.requireBenignReports,
      allowApiKey: options.allowApiKey,
      paidSkills: 'excluded',
      autoApprove: false,
    },
    stats: { shelves: 0, discovered: 0, inspected: 0, ingested: 0, audited: 0, rejectedByPolicy: 0, failed: 0, licenses: {}, security: {}, statuses: {} },
    candidates: [],
    errors: [],
  };

  const ranked = [];
  const seen = new Set();
  for (const shelf of options.shelves) {
    try {
      const payload = await fetchJson(`/api/v1/showcase/${shelf}`, {}, context);
      report.stats.shelves++;
      for (const [position, item] of (payload.skills || []).entries()) {
        const { namespace, slug } = coordinate(item);
        const key = `@${namespace}/${slug}`;
        if (seen.has(key)) continue;
        seen.add(key);
        ranked.push({ ...item, discoveredFrom: shelf, shelfPosition: position + 1 });
      }
    } catch (error) {
      report.stats.failed++;
      report.errors.push({ shelf, code: error.code || 'collection_failed', message: error.message });
    }
  }
  report.stats.discovered = ranked.length;

  const categoryCounts = new Map();
  for (const item of ranked.slice(0, options.scanLimit)) {
    if (report.stats.ingested >= options.limit) break;
    const category = item.category || 'uncategorized';
    if ((categoryCounts.get(category) || 0) >= options.maxPerCategory) continue;
    try {
      report.stats.inspected++;
      const inspected = await inspectSkill(item, options, context);
      const versionIdentity = inspected.signature.content_hash || sha256(inspected.content);
      const candidate = store.ingest({
        source: {
          kind: 'skillhub',
          url: publicMarketUrl(inspected.namespace, inspected.slug),
          marketplaceUrl: publicMarketUrl(inspected.namespace, inspected.slug),
          upstreamUrl: inspected.sourceUrl,
          repo: `@${inspected.namespace}/${inspected.slug}`,
          path: 'SKILL.md',
          commit: `${inspected.version}:${versionIdentity}`,
          version: inspected.version,
          integrity: {
            signed: inspected.signature.signed === true,
            keyId: inspected.signature.key_id || null,
            contentHash: inspected.signature.content_hash || null,
            skillFileSha256: sha256(inspected.content),
          },
          license: inspected.license,
        },
        content: inspected.content,
        license: inspected.license,
        sms: { status: 'pending' },
        eval: { status: 'pending' },
        catalog: {
          provider: 'skillhub.cn',
          coordinate: `@${inspected.namespace}/${inspected.slug}`,
          category: inspected.skill.category || null,
          subCategories: inspected.skill.subCategories || [],
          tags: inspected.skill.tags || [],
          iconUrl: inspected.skill.iconUrl || null,
          summaryZh: inspected.skill.summary_zh || inspected.skill.description_zh || null,
          requiresApiKey: apiKeyRequired(inspected.skill),
          discoveredFrom: item.discoveredFrom,
          shelfPosition: item.shelfPosition,
          observedMetrics: {
            downloads: inspected.skill.stats?.downloads ?? item.downloads ?? null,
            installs: inspected.skill.stats?.installs ?? item.installs ?? null,
            stars: inspected.skill.stats?.stars ?? item.stars ?? null,
          },
          externalSecurity: { status: 'benign', providers: inspected.externalSecurityProviders },
        },
      }, { clock });
      const finalCandidate = options.audit ? store.audit(candidate.id) : candidate;
      categoryCounts.set(category, (categoryCounts.get(category) || 0) + 1);
      report.stats.ingested++;
      if (options.audit) report.stats.audited++;
      report.stats.licenses[inspected.licenseAssessment.status] = (report.stats.licenses[inspected.licenseAssessment.status] || 0) + 1;
      report.stats.security[inspected.localSecurity.status] = (report.stats.security[inspected.localSecurity.status] || 0) + 1;
      report.stats.statuses[finalCandidate.status] = (report.stats.statuses[finalCandidate.status] || 0) + 1;
      report.candidates.push({
        id: finalCandidate.id,
        coordinate: `@${inspected.namespace}/${inspected.slug}`,
        version: inspected.version,
        category,
        sourceShelf: item.discoveredFrom,
        status: finalCandidate.status,
        license: inspected.licenseAssessment,
        licenseSourcePath: inspected.licenseFile,
        localSecurity: inspected.localSecurity,
        externalSecurity: { status: 'benign', providers: inspected.externalSecurityProviders },
        signed: inspected.signature.signed === true,
      });
    } catch (error) {
      const serialized = serializeError(error, item);
      if (['paid_skill_excluded', 'api_key_excluded', 'external_security_insufficient', 'unsigned_package'].includes(serialized.code)) report.stats.rejectedByPolicy++;
      else report.stats.failed++;
      report.errors.push(serialized);
    }
  }
  if (reportPath) atomicJson(path.resolve(reportPath), report);
  return report;
}

export const SKILLHUB_API_ORIGIN = API_ORIGIN;
export const SKILLHUB_MARKET_ORIGIN = MARKET_ORIGIN;

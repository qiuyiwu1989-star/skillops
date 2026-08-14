import fs from 'node:fs';
import path from 'node:path';
import { canonicalDigest } from '../trusted-supply/lib/registry-identity.mjs';
import { createWorkbenchHandoff, validateWorkbenchHandoff } from '../trusted-supply/lib/workbench/workbench-handoff.mjs';
import { PREVIEW_ORGANIZATION_ID } from './preview-acquisition.mjs';

const REQUEST_KEYS = new Set(['skillId', 'taskSummaryZh', 'intentTags']);
const CANDIDATE_ID = /^cand_[a-f0-9]{20}$/;
const HANDOFF_ID = /^wbh_[a-f0-9]{64}$/;
const TAG = /^[\p{L}\p{N}][\p{L}\p{N}._-]{0,63}$/u;
const PRIVATE_VALUE = /(?:file:\/\/|(?:^|[\s：:])\/(?:[^\s/]+\/)*[^\s/]+|(?:^|[\s：:])[A-Za-z]:\\|\\\\[^\s\\]+\\|https?:\/\/|-----BEGIN [A-Z ]*PRIVATE KEY-----|\bBearer\s+\S+|\b(?:sk|ghp|github_pat)_[A-Za-z0-9_-]{12,})/i;

export class PreviewWorkbenchError extends Error {
  constructor(code, messageZh, statusCode = 400, cause) {
    super(messageZh, cause ? { cause } : undefined);
    this.name = 'PreviewWorkbenchError';
    this.code = code;
    this.messageZh = messageZh;
    this.statusCode = statusCode;
  }
}

function fail(code, messageZh, statusCode = 400, cause) { throw new PreviewWorkbenchError(code, messageZh, statusCode, cause); }
function text(value, label, maximum, pattern) {
  if (typeof value !== 'string' || !value.trim()) fail('INVALID_REQUEST', `${label} 不能为空`);
  const normalized = value.normalize('NFC').trim();
  if (normalized.includes('\0') || [...normalized].length > maximum || (pattern && !pattern.test(normalized)) || PRIVATE_VALUE.test(normalized)) fail('INVALID_REQUEST', `${label} 格式不受支持`);
  return normalized;
}
function request(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('INVALID_REQUEST', '体验请求必须是对象');
  const unknown = Object.keys(input).filter(key => !REQUEST_KEYS.has(key));
  if (unknown.length) fail('UNKNOWN_FIELD', `体验请求含未知字段：${unknown.join(', ')}`);
  if (!Array.isArray(input.intentTags) || !input.intentTags.length || input.intentTags.length > 12) fail('INVALID_REQUEST', '请提供 1–12 个任务标签');
  const intentTags = input.intentTags.map((tag, index) => text(tag, `intentTags[${index}]`, 64, TAG));
  if (new Set(intentTags).size !== intentTags.length) fail('INVALID_REQUEST', '任务标签不得重复');
  return {
    skillId: text(input.skillId, 'skillId', 25, CANDIDATE_ID),
    taskSummaryZh: text(input.taskSummaryZh, 'taskSummaryZh', 240),
    intentTags,
  };
}
function listingArray(value) {
  const items = Array.isArray(value) ? value : value?.listings;
  if (!Array.isArray(items) || items.length > 10_000) fail('LISTINGS_UNAVAILABLE', '市场技能列表不可用', 500);
  return items;
}
function category(listing) {
  const raw = listing.catalog?.category || listing.category || '通用能力';
  return typeof raw === 'string' && TAG.test(raw.normalize('NFC').trim()) ? raw.normalize('NFC').trim() : '通用能力';
}
function tier(total) {
  if (!Number.isFinite(Number(total))) return 'pending';
  if (Number(total) >= 85) return 'S';
  if (Number(total) >= 75) return 'A';
  if (Number(total) >= 60) return 'B';
  if (Number(total) >= 45) return 'C';
  return 'D';
}
function readJson(filePath, fallback) {
  if (!fs.existsSync(filePath)) return fallback;
  const stat = fs.lstatSync(filePath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4 * 1024 * 1024) fail('UNSAFE_STORE', '本地工作单存储不安全', 500);
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch (cause) { fail('INVALID_STORE', '本地工作单存储无法读取', 500, cause); }
}
function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporary = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  fs.renameSync(temporary, filePath);
}

export function createPreviewWorkbenchService({ listingsPath, ledgerPath, clock = () => new Date() } = {}) {
  if (typeof listingsPath !== 'string' || typeof ledgerPath !== 'string') fail('SERVICE_CONFIGURATION_REQUIRED', '工作台服务配置不完整', 500);
  const sourcePath = path.resolve(listingsPath);
  const storePath = path.resolve(ledgerPath);

  function listings() { return listingArray(readJson(sourcePath, null)); }
  function store() {
    const value = readJson(storePath, { schemaVersion: 1, handoffs: {} });
    if (value?.schemaVersion !== 1 || !value.handoffs || typeof value.handoffs !== 'object' || Array.isArray(value.handoffs) || Object.keys(value.handoffs).length > 5_000) fail('INVALID_STORE', '本地工作单存储结构无效', 500);
    return value;
  }
  function create(input) {
    const normalized = request(input);
    const listing = listings().find(item => item?.id === normalized.skillId);
    if (!listing) fail('SKILL_NOT_FOUND', '市场中没有找到这个技能', 404);
    const fingerprint = listing.version?.fingerprint;
    if (typeof fingerprint !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(fingerprint)) fail('SKILL_VERSION_UNAVAILABLE', '技能缺少可固定的版本指纹', 409);
    const skillRef = `previewskill_${canonicalDigest({ kind: 'skillops.preview-skill.v1', fingerprint, originalName: listing.original?.name || listing.name }).slice(7)}`;
    const handoff = createWorkbenchHandoff({
      task: { summaryZh: normalized.taskSummaryZh, intentTags: normalized.intentTags },
      skill: {
        skillRef,
        titleZh: listing.name,
        originalName: listing.original?.name || listing.name,
        category: category(listing),
        versionFingerprint: fingerprint,
        distribution: listing.distribution || 'source_link_only',
        smsTotal: listing.sms?.total ?? null,
        smsTier: listing.sms?.tier || tier(listing.sms?.total),
        evalStatus: listing.eval?.status || 'pending',
        installStatus: listing.install?.status || 'source_required',
      },
      context: { organizationId: PREVIEW_ORGANIZATION_ID, projectId: null, environment: 'preview' },
    }, { now: clock });
    const current = store();
    const existing = current.handoffs[handoff.handoffId];
    if (existing) return { action: 'unchanged', handoff: validateWorkbenchHandoff(existing, { at: clock() }) };
    const next = { schemaVersion: 1, handoffs: { ...current.handoffs, [handoff.handoffId]: handoff } };
    writeJson(storePath, next);
    return { action: 'created', handoff };
  }
  function get(handoffId) {
    const id = text(handoffId, 'handoffId', 68, HANDOFF_ID);
    const found = store().handoffs[id];
    if (!found) fail('HANDOFF_NOT_FOUND', '没有找到这份体验工作单', 404);
    return validateWorkbenchHandoff(found, { at: clock() });
  }
  return Object.freeze({ create, get });
}

#!/usr/bin/env node

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { auditSkillFormat } from '../trusted-supply/lib/skill-document.mjs';
import { classifyLicense, scanSecurity } from '../trusted-supply/lib/audit.mjs';
import { candidateId, contentFingerprint, sourceVersionIdentity } from '../trusted-supply/lib/fingerprint.mjs';
import { attachFirstPartyLaunch } from '../trusted-supply/lib/first-party-launch.mjs';
import { readSkillArchive } from '../trusted-supply/lib/skill-archive.mjs';
import { buildMarketListings } from './build.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..');
const DEFAULT_SEEDS = path.join(HERE, 'catalog-seeds.json');
const DEFAULT_OUTPUT = path.join(HERE, 'data', 'listings.json');
const MAX_ITEMS = 100;
const MAX_SKILL_BYTES = 512 * 1024;
const SAFE_KEY = /^[a-z0-9][a-z0-9-]{1,79}$/;
const SAFE_CATEGORY = /^[a-z][a-z0-9-]{1,63}$/;
const SEED_KEYS = new Set([
  'key', 'sourceRoot', 'sourceType', 'relativePath', 'sourceCoordinate', 'titleZh', 'summaryZh',
  'category', 'tags', 'featured', 'requiresApiKey', 'publisherPreset', 'offerPreset',
]);

const PUBLISHER_PRESETS = Object.freeze({
  zaowuyun: Object.freeze({
    displayNameZh: '造物云 SkillOps', handle: 'zaowuyun', kind: 'organization',
    verificationLabelZh: '本机技能卷已发现', creatorUrl: './creator.html',
  }),
  gsap: Object.freeze({
    displayNameZh: 'GSAP', handle: 'gsap', kind: 'source_owner',
    verificationLabelZh: '来源声明为官方技能', creatorUrl: null,
  }),
  community: Object.freeze({
    displayNameZh: '开放技能生态', handle: 'skills-ecosystem', kind: 'source_owner',
    verificationLabelZh: '来源待进一步核验', creatorUrl: null,
  }),
});

const OFFER_PRESETS = Object.freeze({
  preview_free: Object.freeze({
    status: 'demo',
    pricing: Object.freeze({ model: 'free', currency: 'CNY', amountMinor: 0, labelZh: '免费体验' }),
    rightsLabelZh: '在线体验，企业授权待发布',
    acquisitionLabelZh: '进入工作台体验',
    noteZh: '目录演示，不形成正式授权',
  }),
  mit_open_source: Object.freeze({
    status: 'demo',
    pricing: Object.freeze({ model: 'free', currency: 'CNY', amountMinor: 0, labelZh: '开源免费' }),
    rightsLabelZh: '来源索引，遵循 MIT',
    acquisitionLabelZh: '在线体验后查看来源',
    noteZh: '具体权利以上游许可为准',
  }),
  source_only: Object.freeze({
    status: 'draft',
    pricing: Object.freeze({ model: 'contact', currency: 'CNY', amountMinor: 0, labelZh: '待创作者发布' }),
    rightsLabelZh: '仅查看来源',
    acquisitionLabelZh: '等待创作者认领',
    noteZh: '尚未发布正式 Offer',
  }),
});

function exactKeys(value, allowed, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new Error(`${label} contains unknown field: ${key}`);
}

function text(value, label, maximum) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} is required`);
  const normalized = value.normalize('NFC').trim();
  if ([...normalized].length > maximum || /(?:file:\/\/|[\0\r\n])/.test(normalized)) throw new Error(`${label} is unsafe`);
  return normalized;
}

function normalizeRelativePath(value) {
  const normalized = text(value, 'relativePath', 240).replaceAll('\\', '/');
  if (path.posix.isAbsolute(normalized) || normalized.split('/').some(part => !part || part === '.' || part === '..')) {
    throw new Error('relativePath must be a safe relative path');
  }
  return normalized;
}

function normalizeSeed(seed, index) {
  exactKeys(seed, SEED_KEYS, `items[${index}]`);
  const key = text(seed.key, `items[${index}].key`, 80);
  const category = text(seed.category, `items[${index}].category`, 64);
  if (!SAFE_KEY.test(key) || !SAFE_CATEGORY.test(category)) throw new Error(`items[${index}] has an invalid key or category`);
  if (!Array.isArray(seed.tags) || seed.tags.length < 1 || seed.tags.length > 8) throw new Error(`items[${index}].tags is invalid`);
  const tags = seed.tags.map((tag, tagIndex) => text(tag, `items[${index}].tags[${tagIndex}]`, 32));
  if (new Set(tags).size !== tags.length) throw new Error(`items[${index}].tags contains duplicates`);
  if (!PUBLISHER_PRESETS[seed.publisherPreset] || !OFFER_PRESETS[seed.offerPreset]) throw new Error(`items[${index}] uses an unknown preset`);
  if (typeof seed.featured !== 'boolean' || typeof seed.requiresApiKey !== 'boolean') throw new Error(`items[${index}] booleans are invalid`);
  return Object.freeze({
    key,
    sourceRoot: text(seed.sourceRoot, `items[${index}].sourceRoot`, 32),
    sourceType: seed.sourceType === undefined ? 'directory' : text(seed.sourceType, `items[${index}].sourceType`, 32),
    relativePath: normalizeRelativePath(seed.relativePath),
    sourceCoordinate: text(seed.sourceCoordinate, `items[${index}].sourceCoordinate`, 160),
    titleZh: text(seed.titleZh, `items[${index}].titleZh`, 100),
    summaryZh: text(seed.summaryZh, `items[${index}].summaryZh`, 360),
    category,
    tags: Object.freeze(tags),
    featured: seed.featured,
    requiresApiKey: seed.requiresApiKey,
    publisherPreset: seed.publisherPreset,
    offerPreset: seed.offerPreset,
  });
}

export function readCatalogSeeds(seedPath = DEFAULT_SEEDS) {
  const value = JSON.parse(fs.readFileSync(seedPath, 'utf8'));
  if (!value || value.schemaVersion !== 1 || !Array.isArray(value.items)
    || value.items.length < 1 || value.items.length > MAX_ITEMS) throw new Error('catalog seed file is invalid');
  const items = value.items.map(normalizeSeed);
  for (const field of ['key', 'sourceCoordinate']) {
    if (new Set(items.map(item => item[field])).size !== items.length) throw new Error(`catalog seeds contain duplicate ${field}`);
  }
  return Object.freeze({ schemaVersion: 1, items: Object.freeze(items) });
}

function resolveSkillSource(seed, sourceRoots) {
  const rootInput = sourceRoots[seed.sourceRoot];
  if (!rootInput) throw new Error(`source root is not configured: ${seed.sourceRoot}`);
  const root = fs.realpathSync(path.resolve(rootInput));
  const candidate = path.resolve(root, ...seed.relativePath.split('/'));
  const resolved = fs.realpathSync(candidate);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) throw new Error('skill path escapes its source root');
  const stat = fs.lstatSync(candidate);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('skill source must be a bounded regular file');
  if (seed.sourceType === 'directory') {
    if (stat.size > MAX_SKILL_BYTES) throw new Error('skill source must be a bounded regular file');
    return { content: fs.readFileSync(candidate, 'utf8'), publicPath: `${seed.sourceRoot}/${seed.relativePath}`, collection: 'local_skill_volume' };
  }
  if (seed.sourceType === 'skill_archive') {
    const archive = readSkillArchive(candidate);
    if (archive.rootName !== seed.key) throw new Error('archive root does not match catalog key');
    return {
      content: archive.skillDocument,
      publicPath: `${seed.sourceRoot}/${seed.relativePath}#${archive.rootName}/SKILL.md`,
      collection: 'preset_skill_archive',
      archive: { fileCount: archive.fileCount, totalBytes: archive.totalBytes },
    };
  }
  throw new Error(`unsupported source type: ${seed.sourceType}`);
}

function publicSecurity(result) {
  return {
    status: result.status,
    findings: result.findings.map(item => ({ rule: item.rule, severity: item.severity })),
  };
}

function indexedListing(seed, sourceInput, generatedAt) {
  const { content } = sourceInput;
  const format = auditSkillFormat(content);
  if (format.status !== 'pass') throw new Error(`format:${format.issues.join(',')}`);
  const security = scanSecurity(content);
  if (security.status === 'block') throw new Error(`security:${security.findings.map(item => item.rule).join(',')}`);
  const license = classifyLicense(format.license);
  if (license.status === 'blocked') throw new Error(`license:${license.reason}`);
  const fingerprint = contentFingerprint(content);
  const source = {
    kind: seed.sourceType === 'skill_archive' ? 'local_skill_archive' : 'local_skill_volume',
    url: null,
    marketplaceUrl: null,
    upstreamUrl: null,
    repo: seed.sourceCoordinate,
    path: sourceInput.publicPath,
    commit: fingerprint,
    version: typeof format.frontmatter.version === 'string' ? format.frontmatter.version.trim() || null : null,
    integrity: null,
  };
  return {
    schemaVersion: 1,
    id: candidateId(source),
    name: seed.titleZh,
    description: seed.summaryZh,
    original: { name: format.name, description: format.description },
    localization: {
      locale: 'zh-CN', titleZh: seed.titleZh, descriptionZh: seed.summaryZh,
      originalName: format.name, originalDescription: format.description,
      status: 'curated_catalog', titleMethod: 'catalog_seed', descriptionMethod: 'catalog_seed', reviewStatus: 'catalog_curated',
    },
    source,
    version: { commit: source.commit, fingerprint, identity: sourceVersionIdentity(source, fingerprint) },
    license,
    security: publicSecurity(security),
    sms: { status: 'pending' },
    eval: { status: 'pending' },
    verification: {
      status: 'indexed', reviewedFingerprint: null, lastReview: null, certification: null, evidence: null,
    },
    distribution: 'source_link_only',
    install: {
      status: 'source_required', method: 'skillops intake', packageComplete: false, reason: 'catalog_index_only',
    },
    catalog: {
      indexed: true,
      collection: sourceInput.collection,
      coordinate: seed.sourceCoordinate,
      titleZh: seed.titleZh,
      summaryZh: seed.summaryZh,
      scenario: seed.summaryZh,
      category: seed.category,
      tags: [...seed.tags],
      featured: seed.featured,
      requiresApiKey: seed.requiresApiKey,
      observedAt: generatedAt,
      ...(sourceInput.archive ? { archive: { ...sourceInput.archive } } : {}),
      publisher: { ...PUBLISHER_PRESETS[seed.publisherPreset] },
      offer: {
        ...OFFER_PRESETS[seed.offerPreset],
        pricing: { ...OFFER_PRESETS[seed.offerPreset].pricing },
      },
    },
  };
}

export function collectIndexedSkills({ seeds, sourceRoots, clock } = {}) {
  if (!seeds?.items || !sourceRoots) throw new Error('seeds and sourceRoots are required');
  const generatedAt = (clock ? clock() : new Date()).toISOString();
  const listings = [];
  const rejected = [];
  for (const seed of seeds.items) {
    try {
      const sourceInput = resolveSkillSource(seed, sourceRoots);
      listings.push(indexedListing(seed, sourceInput, generatedAt));
    } catch (error) {
      rejected.push({ key: seed.key, reason: String(error.message || error).slice(0, 240) });
    }
  }
  if (new Set(listings.map(item => item.id)).size !== listings.length) throw new Error('indexed listings contain duplicate identities');
  return Object.freeze({
    generatedAt,
    listings: Object.freeze(listings),
    rejected: Object.freeze(rejected),
    summary: Object.freeze({ requested: seeds.items.length, indexed: listings.length, rejected: rejected.length }),
  });
}

export function syncPreviewCatalog({
  seedPath = DEFAULT_SEEDS,
  sourceRoots = {
    agents: path.join(os.homedir(), '.agents', 'skills'),
    project: REPO_ROOT,
    presets: path.join(os.homedir(), 'Library', 'Mobile Documents', 'com~apple~CloudDocs', '预设技能'),
  },
  approvedListings = [],
  launchProjection,
  outPath = DEFAULT_OUTPUT,
  rootPath,
  clock,
} = {}) {
  if (!Array.isArray(approvedListings)) throw new Error('approvedListings must be an array');
  const seeds = readCatalogSeeds(seedPath);
  const collected = collectIndexedSkills({ seeds, sourceRoots, clock });
  const approvedIds = new Set(approvedListings.map(item => item.id));
  const indexed = collected.listings.filter(item => !approvedIds.has(item.id));
  const combined = [...approvedListings, ...indexed];
  const listings = launchProjection ? attachFirstPartyLaunch(combined, launchProjection) : combined;
  const artifact = buildMarketListings({ listings, outPath, rootPath, clock, source: 'SkillOps.marketCatalog' });
  return Object.freeze({
    artifact,
    report: Object.freeze({
      schemaVersion: 1,
      generatedAt: artifact.generatedAt,
      approved: approvedListings.length,
      indexed: indexed.length,
      rejected: collected.rejected.length,
      total: artifact.count,
      rejectedItems: collected.rejected,
    }),
  });
}

function parseArgs(argv) {
  const options = { seedPath: DEFAULT_SEEDS, outPath: DEFAULT_OUTPUT };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--seeds') options.seedPath = path.resolve(argv[++index]);
    else if (argv[index] === '--out') options.outPath = path.resolve(argv[++index]);
    else if (argv[index] === '--help' || argv[index] === '-h') options.help = true;
    else throw new Error(`unknown option: ${argv[index]}`);
  }
  return options;
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) {
      process.stdout.write('Usage: node market-preview/catalog-pipeline.mjs [--seeds <catalog-seeds.json>] [--out <listings.json>]\n');
    } else {
      const result = syncPreviewCatalog(options);
      process.stdout.write(`${JSON.stringify({ ok: true, output: options.outPath, ...result.report }, null, 2)}\n`);
    }
  } catch (error) {
    process.stderr.write(`catalog sync failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}

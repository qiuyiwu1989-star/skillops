#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { CandidateStore } from '../trusted-supply/lib/store.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_OUTPUT = path.join(HERE, 'data', 'listings.json');
const GENERATED_MANIFEST = '.generated-detail-pages.json';
const SAFE_LISTING_ID = /^cand_[0-9a-f]{20}$/;

function parseArgs(argv) {
  const options = { out: DEFAULT_OUTPUT };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--store') options.store = argv[++index];
    else if (value === '--out') options.out = argv[++index];
    else if (value === '--help' || value === '-h') options.help = true;
    else throw new Error(`unknown option: ${value}`);
  }
  return options;
}

function usage() {
  return [
    'Usage: node market-preview/build.mjs --store <candidate-store.json> [--out <listings.json>]',
    '',
    'Exports only CandidateStore.listListings() results for the local preview.',
  ].join('\n');
}

function atomicWriteFile(filePath, content) {
  const resolved = path.resolve(filePath);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  const temporary = `${resolved}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporary, content, {
    encoding: 'utf8',
    mode: 0o644,
  });
  fs.renameSync(temporary, resolved);
}

function atomicWriteJson(filePath, value) {
  atomicWriteFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function previewRootFor(outPath, rootPath) {
  if (rootPath) return path.resolve(rootPath);
  const resolvedOutput = path.resolve(outPath);
  return path.basename(path.dirname(resolvedOutput)) === 'data'
    ? path.dirname(path.dirname(resolvedOutput))
    : path.dirname(resolvedOutput);
}

function assertSafeListingId(id) {
  if (typeof id !== 'string' || !SAFE_LISTING_ID.test(id)) {
    throw new Error(`unsafe listing id: ${String(id)}`);
  }
  return id;
}

function assertPublishableListing(listing) {
  const id = assertSafeListingId(listing?.id);
  const status = listing?.verification?.status;
  if (status === 'approved') return id;
  if (status !== 'indexed') throw new Error(`unsupported market listing status: ${String(status)}`);
  if (listing.distribution !== 'source_link_only'
    || listing.install?.status !== 'source_required'
    || listing.catalog?.indexed !== true
    || listing.sms?.status !== 'pending'
    || listing.eval?.status !== 'pending'
    || Object.hasOwn(listing, 'content')) {
    throw new Error(`indexed listing violates source-only boundary: ${id}`);
  }
  const sourcePath = String(listing.source?.path || '');
  if (!sourcePath || path.isAbsolute(sourcePath) || sourcePath.split('/').includes('..') || sourcePath.includes('\\')) {
    throw new Error(`indexed listing has unsafe source path: ${id}`);
  }
  return id;
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function relatedListingSummary(listing) {
  return {
    id: listing.id,
    name: listing.name,
    description: listing.description,
    localization: listing.localization,
    catalog: listing.catalog ? {
      category: listing.catalog.category,
      subCategories: listing.catalog.subCategories,
      tags: listing.catalog.tags,
    } : null,
  };
}

function relatedListingsFor(listing, listings) {
  const category = listing.catalog?.category;
  const subCategories = new Set((listing.catalog?.subCategories || []).map(item => item?.key).filter(Boolean));
  return listings.filter(item => {
    if (item.id === listing.id) return false;
    if (category && item.catalog?.category === category) return true;
    return (item.catalog?.subCategories || []).some(itemCategory => subCategories.has(itemCategory?.key));
  }).map(relatedListingSummary);
}

function renderDetailEntry(template, listing) {
  const id = listing.id;
  const title = listing.catalog?.titleZh || listing.localization?.titleZh || listing.name || '技能详情';
  const description = listing.catalog?.summaryZh || listing.localization?.descriptionZh || listing.description || 'SkillOps 可信能力市场技能详情';
  const configuration = JSON.stringify({
    skillId: id,
    listingUrl: `/data/skills/${id}.json`,
  }).replaceAll('<', '\\u003c');
  const injection = [
    `  <meta name="skillops:listing-url" content="/data/skills/${id}.json">`,
    `  <link rel="canonical" href="/skills/${id}/">`,
    `  <script id="skillops-detail-config" type="application/json">${configuration}</script>`,
  ].join('\n');
  if (!/<head(?:\s[^>]*)?>/i.test(template)) throw new Error('detail template must include a <head> element');
  return template
    .replace(/<title>[^<]*<\/title>/i, `<title>${escapeHtml(title)} | 造物云技能市场</title>`)
    .replace(/<meta\s+name="description"\s+content="[^"]*"\s*\/?\s*>/i,
      `<meta name="description" content="${escapeHtml(description)}">`)
    .replace(/<head(?:\s[^>]*)?>/i, match => `${match}\n${injection}`);
}

function readGeneratedIds(manifestPath) {
  if (!fs.existsSync(manifestPath)) return [];
  try {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    if (!Array.isArray(manifest.ids)) return [];
    return manifest.ids.filter(id => typeof id === 'string' && SAFE_LISTING_ID.test(id));
  } catch {
    return [];
  }
}

function removeGeneratedFile(filePath) {
  if (!fs.existsSync(filePath)) return;
  const stat = fs.lstatSync(filePath);
  if (stat.isFile() && !stat.isSymbolicLink()) fs.unlinkSync(filePath);
}

function cleanStaleDetails({ previewRoot, detailDataRoot, previousIds, currentIds }) {
  const current = new Set(currentIds);
  for (const id of previousIds) {
    if (current.has(id)) continue;
    removeGeneratedFile(path.join(detailDataRoot, `${id}.json`));
    const pageDirectory = path.join(previewRoot, 'skills', id);
    removeGeneratedFile(path.join(pageDirectory, 'index.html'));
    if (fs.existsSync(pageDirectory) && fs.lstatSync(pageDirectory).isDirectory() && fs.readdirSync(pageDirectory).length === 0) {
      fs.rmdirSync(pageDirectory);
    }
  }
}

export function buildMarketListings({ listings, outPath = DEFAULT_OUTPUT, rootPath, clock, source = 'SkillOps.marketCatalog' } = {}) {
  if (!Array.isArray(listings)) throw new Error('market listings are required');
  const ids = listings.map(assertPublishableListing);
  if (new Set(ids).size !== ids.length) throw new Error('market listing ids must be unique');
  const previewRoot = previewRootFor(outPath, rootPath);
  const detailDataRoot = path.join(previewRoot, 'data', 'skills');
  const detailPagesRoot = path.join(previewRoot, 'skills');
  const detailTemplate = fs.readFileSync(path.join(HERE, 'detail.html'), 'utf8');
  const generatedAt = (clock ? clock() : new Date()).toISOString();
  const artifact = {
    schemaVersion: 1,
    generatedAt,
    source,
    count: listings.length,
    listings,
  };

  // Validate every listing and render every entry before publishing any file.
  const details = listings.map(listing => ({
    id: listing.id,
    jsonPath: path.join(detailDataRoot, `${listing.id}.json`),
    htmlPath: path.join(detailPagesRoot, listing.id, 'index.html'),
    json: {
      schemaVersion: 1,
      generatedAt,
      source,
      listing,
      relatedListings: relatedListingsFor(listing, listings),
    },
    html: renderDetailEntry(detailTemplate, listing),
  }));

  for (const detail of details) {
    atomicWriteJson(detail.jsonPath, detail.json);
    atomicWriteFile(detail.htmlPath, detail.html);
  }
  atomicWriteJson(outPath, artifact);

  const manifestPath = path.join(detailDataRoot, GENERATED_MANIFEST);
  cleanStaleDetails({
    previewRoot,
    detailDataRoot,
    previousIds: readGeneratedIds(manifestPath),
    currentIds: ids,
  });
  atomicWriteJson(manifestPath, { schemaVersion: 1, generatedAt, ids });

  Object.defineProperty(artifact, 'detailPages', {
    enumerable: false,
    value: details.map(detail => ({
      id: detail.id,
      url: `/skills/${detail.id}/`,
      dataUrl: `/data/skills/${detail.id}.json`,
    })),
  });
  return artifact;
}

export function buildApprovedListings({ storePath, outPath = DEFAULT_OUTPUT, rootPath, clock } = {}) {
  if (!storePath) throw new Error('candidate store path is required');
  const store = new CandidateStore(storePath);

  // This is the trust boundary. Never read store.read() or store.list() here.
  const listings = store.listListings();
  return buildMarketListings({
    listings,
    outPath,
    rootPath,
    clock,
    source: 'CandidateStore.listListings',
  });
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  if (!options.store) throw new Error('--store is required');
  const artifact = buildApprovedListings({ storePath: options.store, outPath: options.out });
  process.stdout.write(`${JSON.stringify({
    ok: true,
    output: path.resolve(options.out),
    count: artifact.count,
    source: artifact.source,
  }, null, 2)}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch(error => {
    process.stderr.write(`market preview build failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}

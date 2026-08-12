#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { CandidateStore } from '../trusted-supply/lib/store.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_OUTPUT = path.join(HERE, 'data', 'listings.json');

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

function atomicWriteJson(filePath, value) {
  const resolved = path.resolve(filePath);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  const temporary = `${resolved}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o644,
  });
  fs.renameSync(temporary, resolved);
}

export function buildApprovedListings({ storePath, outPath = DEFAULT_OUTPUT, clock } = {}) {
  if (!storePath) throw new Error('candidate store path is required');
  const store = new CandidateStore(storePath);

  // This is the trust boundary. Never read store.read() or store.list() here.
  const listings = store.listListings();
  const artifact = {
    schemaVersion: 1,
    generatedAt: (clock ? clock() : new Date()).toISOString(),
    source: 'CandidateStore.listListings',
    count: listings.length,
    listings,
  };

  atomicWriteJson(outPath, artifact);
  return artifact;
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


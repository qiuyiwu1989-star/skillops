#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { CandidateStore } from './lib/store.mjs';
import { collectWhitelist } from './lib/source-collector.mjs';
import { collectSkillHub } from './lib/skillhub-collector.mjs';

const HELP = `SkillOps trusted supply (local MVP)

Usage:
  node trusted-supply/cli.mjs collect <whitelist.json> --store <json-file> [--report <json-file>] [--allow-local]
  node trusted-supply/cli.mjs sync-skillhub --store <json-file> [--report <json-file>] [--limit <1-50>] [--shelves <recommended,trending,hot,newest>] [--audit]
  node trusted-supply/cli.mjs ingest <SKILL.md> --source-url <url> --repo <owner/repo> --path <path> --commit <sha> [--license <SPDX>] [--sms-total <0-100>]
  node trusted-supply/cli.mjs audit <candidate-id> [--sms-threshold <score>]
  node trusted-supply/cli.mjs list [--status <status>]
  node trusted-supply/cli.mjs show <candidate-id>
  node trusted-supply/cli.mjs review <candidate-id> --decision <approve|reject|quarantine> --reviewer <name> --reason <text> [--waive-sms]
  node trusted-supply/cli.mjs listing <candidate-id>
  node trusted-supply/cli.mjs listings

All commands accept --store <json-file>. Output is JSON. Candidates never publish automatically.`;

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index];
    if (!token.startsWith('--')) {
      positional.push(token);
      continue;
    }
    const equal = token.indexOf('=');
    if (equal > 2) {
      flags[token.slice(2, equal)] = token.slice(equal + 1);
      continue;
    }
    const key = token.slice(2);
    if (argv[index + 1] && !argv[index + 1].startsWith('--')) flags[key] = argv[++index];
    else flags[key] = true;
  }
  return { positional, flags };
}

function required(value, name) {
  if (value === undefined || value === null || value === '') throw new Error(`--${name} is required`);
  return value;
}

function output(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

export async function main(argv = process.argv.slice(2)) {
  const { positional, flags } = parseArgs(argv);
  const [command, target] = positional;
  if (!command || command === 'help' || flags.help || flags.h) {
    process.stdout.write(`${HELP}\n`);
    return 0;
  }
  const storePath = path.resolve(String(flags.store || '.skillops/trusted-supply.json'));
  const store = new CandidateStore(storePath);

  switch (command) {
    case 'collect':
      output(collectWhitelist({
        whitelist: path.resolve(required(target, 'whitelist-file')),
        storePath,
        reportPath: flags.report ? path.resolve(String(flags.report)) : undefined,
        baseDir: process.cwd(),
        allowLocal: Boolean(flags['allow-local']),
      }));
      return 0;
    case 'sync-skillhub':
      output(await collectSkillHub({
        storePath,
        reportPath: flags.report ? path.resolve(String(flags.report)) : undefined,
        limit: flags.limit === undefined ? undefined : Number(flags.limit),
        scanLimit: flags['scan-limit'] === undefined ? undefined : Number(flags['scan-limit']),
        maxPerCategory: flags['max-per-category'] === undefined ? undefined : Number(flags['max-per-category']),
        shelves: flags.shelves ? String(flags.shelves).split(',').map(value => value.trim()).filter(Boolean) : undefined,
        allowApiKey: Boolean(flags['allow-api-key']),
        audit: Boolean(flags.audit),
      }));
      return 0;
    case 'ingest': {
      const skillPath = path.resolve(required(target, 'skill-file'));
      const content = fs.readFileSync(skillPath, 'utf8');
      const sourceUrl = flags['source-url'] || pathToFileURL(skillPath).href;
      const smsTotal = flags['sms-total'] === undefined ? null : Number(flags['sms-total']);
      if (smsTotal !== null && (!Number.isFinite(smsTotal) || smsTotal < 0 || smsTotal > 100)) {
        throw new Error('--sms-total must be between 0 and 100');
      }
      output(store.ingest({
        source: {
          kind: flags['source-kind'] || (flags.repo ? 'github' : 'local'),
          url: sourceUrl,
          repo: flags.repo || null,
          path: flags.path || path.basename(skillPath),
          commit: flags.commit || '',
          license: flags.license || null,
        },
        content,
        license: flags.license || null,
        sms: smsTotal === null ? { status: 'pending' } : { status: 'complete', total: smsTotal },
      }));
      return 0;
    }
    case 'audit':
      output(store.audit(required(target, 'candidate-id'), {
        smsThreshold: flags['sms-threshold'] === undefined ? 64 : Number(flags['sms-threshold']),
      }));
      return 0;
    case 'list':
      output(store.list({ status: flags.status }));
      return 0;
    case 'show': {
      const candidate = store.get(required(target, 'candidate-id'));
      if (!candidate) throw new Error(`candidate not found: ${target}`);
      output(candidate);
      return 0;
    }
    case 'review': {
      const aliases = { approved: 'approve', rejected: 'reject', quarantined: 'quarantine' };
      const decision = aliases[flags.decision] || flags.decision;
      output(store.review(required(target, 'candidate-id'), {
        decision: required(decision, 'decision'),
        reviewer: required(flags.reviewer, 'reviewer'),
        reason: required(flags.reason, 'reason'),
        smsWaiver: Boolean(flags['waive-sms']),
      }));
      return 0;
    }
    case 'listing':
      output(store.listing(required(target, 'candidate-id')));
      return 0;
    case 'listings':
      output(store.listListings());
      return 0;
    default:
      throw new Error(`unknown command: ${command}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(code => { process.exitCode = code; }).catch(error => {
    process.stderr.write(`${JSON.stringify({ error: error.message })}\n`);
    process.exitCode = 1;
  });
}

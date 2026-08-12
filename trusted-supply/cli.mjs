#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { CandidateStore } from './lib/store.mjs';
import { collectWhitelist } from './lib/source-collector.mjs';
import { collectSkillHub } from './lib/skillhub-collector.mjs';
import { confirmSmsDraft, createHeuristicSmsDraft } from './lib/assessment-pipeline.mjs';
import { PackageStore } from './lib/package-store.mjs';
import { auditPackageFiles } from './lib/package-audit.mjs';
import { normalizeEvalSuite } from './lib/eval-suite.mjs';
import { validateEvalResult } from './lib/eval-result.mjs';
import { createFixtureEvalAdapter } from './lib/eval-fixture-adapter.mjs';
import { runEvalSuite } from './lib/eval-runner.mjs';

const HELP = `SkillOps trusted supply (local MVP)

Usage:
  node trusted-supply/cli.mjs collect <whitelist.json> --store <json-file> [--package-store <directory>] [--report <json-file>] [--allow-local]
  node trusted-supply/cli.mjs sync-skillhub --store <json-file> [--package-store <directory>] [--report <json-file>] [--limit <1-50>] [--shelves <recommended,trending,hot,newest>] [--audit]
  node trusted-supply/cli.mjs ingest <SKILL.md> --source-url <url> --repo <owner/repo> --path <path> --commit <sha> [--license <SPDX>]
  node trusted-supply/cli.mjs sms-import <candidate-id> --input <assessment.json>
  node trusted-supply/cli.mjs sms-draft <candidate-id> [--out <draft.json>]
  node trusted-supply/cli.mjs sms-confirm <candidate-id> --input <draft.json> --scorer <name>
  node trusted-supply/cli.mjs sms-show <candidate-id>
  node trusted-supply/cli.mjs package-import <candidate-id> --from <directory> --package-store <directory>
  node trusted-supply/cli.mjs package-show <candidate-id>
  node trusted-supply/cli.mjs package-audit <candidate-id> --package-store <directory> --auditor <name>
  node trusted-supply/cli.mjs eval-suite-validate <cases.json>
  node trusted-supply/cli.mjs eval-run <candidate-id> --suite <cases.json> --adapter fixture --fixture-results <results.json>
  node trusted-supply/cli.mjs eval-import <candidate-id> --input <result.json> --suite <cases.json>
  node trusted-supply/cli.mjs eval-show <candidate-id>
  node trusted-supply/cli.mjs audit <candidate-id> [--sms-threshold <score>]
  node trusted-supply/cli.mjs list [--status <status>]
  node trusted-supply/cli.mjs show <candidate-id>
  node trusted-supply/cli.mjs review <candidate-id> --decision <approve|reject|quarantine> --reviewer <name> --reason <text> [--reviewer-type <human|agent_assisted>] [--waive-sms]
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

function publicPackage(packageArtifact) {
  if (!packageArtifact) return null;
  return {
    schemaVersion: packageArtifact.schemaVersion,
    packageDigest: packageArtifact.packageDigest,
    manifest: structuredClone(packageArtifact.manifest),
    fileCount: packageArtifact.fileCount,
    totalBytes: packageArtifact.totalBytes,
    collectedAt: packageArtifact.collectedAt,
    basedOnSourceVersion: packageArtifact.basedOnSourceVersion,
  };
}

function packageStoreFrom(flags) {
  return new PackageStore(path.resolve(String(required(flags['package-store'], 'package-store'))));
}

function skillContentFromPackage(packageStore, packageDigest) {
  const files = packageStore.readFiles(packageDigest);
  const skill = files.find(file => file.path === 'SKILL.md');
  if (!skill) throw new Error('complete package is missing root SKILL.md');
  try {
    const content = new TextDecoder('utf-8', { fatal: true }).decode(skill.content);
    if (content.includes('\0')) throw new Error('NUL byte');
    return content;
  } catch (error) {
    throw new Error(`package SKILL.md must be valid UTF-8 text: ${error.message}`);
  }
}

function readJsonFlag(value, name) {
  const filePath = path.resolve(String(required(value, name)));
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function evalHistorySummary(result) {
  return {
    status: result.status,
    suiteId: result.suiteId,
    suiteVersion: result.suiteVersion,
    suiteDigest: result.suiteDigest,
    basedOnPackageDigest: result.basedOnPackageDigest,
    runner: result.runner,
    passed: result.passed,
    failed: result.failed,
    successRate: result.successRate,
    completedAt: result.completedAt,
  };
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
        packageStorePath: flags['package-store'] ? path.resolve(String(flags['package-store'])) : undefined,
        reportPath: flags.report ? path.resolve(String(flags.report)) : undefined,
        baseDir: process.cwd(),
        allowLocal: Boolean(flags['allow-local']),
      }));
      return 0;
    case 'sync-skillhub':
      output(await collectSkillHub({
        storePath,
        packageStorePath: flags['package-store'] ? path.resolve(String(flags['package-store'])) : undefined,
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
      if (flags['sms-total'] !== undefined) throw new Error('--sms-total is no longer supported; import a complete SMS v2 assessment with sms-import');
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
        sms: { status: 'pending' },
      }));
      return 0;
    }
    case 'sms-import': {
      const inputPath = path.resolve(required(flags.input, 'input'));
      output(store.assessSms(required(target, 'candidate-id'), JSON.parse(fs.readFileSync(inputPath, 'utf8'))));
      return 0;
    }
    case 'sms-draft': {
      const candidate = store.get(required(target, 'candidate-id'));
      if (!candidate) throw new Error(`candidate not found: ${target}`);
      const draft = createHeuristicSmsDraft(candidate);
      if (flags.out) {
        const outPath = path.resolve(String(flags.out));
        fs.mkdirSync(path.dirname(outPath), { recursive: true });
        fs.writeFileSync(outPath, `${JSON.stringify(draft, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
      }
      output(draft);
      return 0;
    }
    case 'sms-confirm': {
      const inputPath = path.resolve(required(flags.input, 'input'));
      const draft = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
      output(store.assessSms(required(target, 'candidate-id'), confirmSmsDraft(draft, {
        scorer: required(flags.scorer, 'scorer'),
      })));
      return 0;
    }
    case 'sms-show': {
      const candidate = store.get(required(target, 'candidate-id'));
      if (!candidate) throw new Error(`candidate not found: ${target}`);
      output(candidate.sms);
      return 0;
    }
    case 'package-show': {
      const candidate = store.get(required(target, 'candidate-id'));
      if (!candidate) throw new Error(`candidate not found: ${target}`);
      output({
        candidateId: candidate.id,
        package: publicPackage(candidate.artifact?.package),
        packageAudit: candidate.packageAudit || null,
        installEligible: candidate.status === 'approved'
          && candidate.artifact?.package?.packageDigest
          && candidate.packageAudit?.status === 'pass'
          && candidate.packageAudit?.basedOnPackageDigest === candidate.artifact.package.packageDigest,
      });
      return 0;
    }
    case 'package-import': {
      const candidateId = required(target, 'candidate-id');
      const candidate = store.get(candidateId);
      if (!candidate) throw new Error(`candidate not found: ${candidateId}`);
      const sourceDirectory = path.resolve(String(required(flags.from, 'from')));
      const packageStore = packageStoreFrom(flags);
      const basedOnSourceVersion = candidate.source?.commit || candidate.artifact?.versionIdentity;
      const imported = packageStore.importDirectory(sourceDirectory, { basedOnSourceVersion });
      const packageContent = skillContentFromPackage(packageStore, imported.artifact.packageDigest);
      const refreshed = store.ingest({
        id: candidate.id,
        source: candidate.source,
        content: packageContent,
        license: candidate.artifact?.license,
        sms: candidate.sms,
        eval: candidate.eval,
        catalog: { ...(candidate.catalog || {}), packageComplete: true },
        package: imported.artifact,
      });
      output({
        candidateId: refreshed.id,
        action: imported.action,
        package: publicPackage(refreshed.artifact.package),
        packageComplete: refreshed.catalog?.packageComplete === true,
        status: refreshed.status,
      });
      return 0;
    }
    case 'package-audit': {
      const candidateId = required(target, 'candidate-id');
      const auditor = String(required(flags.auditor, 'auditor'));
      const candidate = store.get(candidateId);
      if (!candidate) throw new Error(`candidate not found: ${candidateId}`);
      const packageArtifact = candidate.artifact?.package;
      if (!packageArtifact) throw new Error('candidate has no complete package to audit');
      const packageStore = packageStoreFrom(flags);
      const files = packageStore.readFiles(packageArtifact.packageDigest);
      const result = auditPackageFiles(files, packageArtifact);
      output(store.auditPackage(candidateId, { ...result, auditor }));
      return 0;
    }
    case 'eval-suite-validate':
      output(normalizeEvalSuite(JSON.parse(fs.readFileSync(path.resolve(required(target, 'suite-file')), 'utf8'))));
      return 0;
    case 'eval-run': {
      const candidateId = required(target, 'candidate-id');
      const candidate = store.get(candidateId);
      if (!candidate) throw new Error(`candidate not found: ${candidateId}`);
      if (flags.adapter !== 'fixture') throw new Error('--adapter must be the literal value fixture');
      const suite = normalizeEvalSuite(readJsonFlag(flags.suite, 'suite'));
      const fixtureResults = readJsonFlag(flags['fixture-results'], 'fixture-results');
      const executor = createFixtureEvalAdapter(fixtureResults);
      const result = await runEvalSuite({
        suite,
        packageDigest: candidate.artifact?.package?.packageDigest,
        packageAudit: candidate.packageAudit,
        executor,
      });
      output(store.recordEval(candidateId, result));
      return 0;
    }
    case 'eval-import': {
      const candidateId = required(target, 'candidate-id');
      const candidate = store.get(candidateId);
      if (!candidate) throw new Error(`candidate not found: ${candidateId}`);
      const suite = normalizeEvalSuite(readJsonFlag(flags.suite, 'suite'));
      const result = validateEvalResult(readJsonFlag(flags.input, 'input'), {
        suite,
        packageDigest: candidate.artifact?.package?.packageDigest,
      });
      output(store.recordEval(candidateId, result));
      return 0;
    }
    case 'eval-show': {
      const candidateId = required(target, 'candidate-id');
      const candidate = store.get(candidateId);
      if (!candidate) throw new Error(`candidate not found: ${candidateId}`);
      output({
        candidateId,
        current: candidate.eval || { status: 'pending' },
        history: (candidate.evalEvents || []).map(evalHistorySummary),
      });
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
        reviewerType: flags['reviewer-type'] || 'human',
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

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import { canonicalDigest, normalizeRelease, sourceId, toPublicRegistryValue } from '../lib/registry-identity.mjs';
import { createRegistryEvent } from '../lib/registry-store.mjs';
import { createZaowuyunEnvelope } from '../lib/zaowuyun-adapter.mjs';
import { OrganizationGovernanceStore } from '../lib/organization-governance-store.mjs';

const CLI = path.resolve(import.meta.dirname, '../cli.mjs');
const NOW = '2026-08-13T12:00:00.000Z';
const D = letter => `sha256:${letter.repeat(64)}`;

function workspace(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'skillops-v40b-cli-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function writeJson(directory, name, value) {
  const file = path.join(directory, name);
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
  return file;
}

function run(...args) {
  const result = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' });
  let json = null;
  try { json = result.stdout.trim() ? JSON.parse(result.stdout) : null; } catch { /* asserted by caller */ }
  return { ...result, json };
}

function organizationEvent() {
  return {
    schemaVersion: 1, operationId: 'op_cli_create_org', type: 'organization.created', occurredAt: NOW,
    actorPrincipalId: 'principal:owner-fixture', organizationId: 'org_yongle',
    subject: { organizationId: 'org_yongle' },
    payload: { organization: { organizationId: 'org_yongle', name: '永乐教育训练营' } },
  };
}

function envelope() {
  const release = normalizeRelease({
    skillId: 'qiuyiwu/humanizer', version: '1.0.0',
    package: { packageDigest: D('a'), manifestDigest: D('b'), storageRef: `cas:${D('a')}` },
    compatibility: { contract: 'skill-package.v1', targets: ['claude-code'] },
    assessmentRefs: ['eval_fixture', 'sms_fixture'], reviewRefs: ['review_fixture'],
    sourceRefs: [sourceId('skillhub', 'https://skillhub.cn/humanizer')], publishedAt: '2026-08-13T01:00:00Z',
  });
  const internal = createRegistryEvent({
    type: 'release.published', subject: { skillId: release.skillId, releaseId: release.releaseId },
    payload: { release }, occurredAt: release.publishedAt, actorRef: 'registry-publisher',
    reasonCode: 'fixture', policyVersion: 'registry-v1',
  });
  const payload = toPublicRegistryValue(internal.payload);
  return createZaowuyunEnvelope({
    schemaVersion: 1, eventId: internal.eventId, sequence: 1, type: internal.type,
    occurredAt: internal.occurredAt, actorRole: 'registry-publisher', reasonCode: internal.reasonCode,
    subject: toPublicRegistryValue(internal.subject), payload, payloadDigest: canonicalDigest(payload),
    policyVersion: internal.policyVersion,
  }, {
    release, listing: { title: '文本去 AI 味', description: '让中文表达更自然。', category: '内容创作' },
    trust: {
      sms: { ref: 'sms_fixture', status: 'pass', total: 91, tier: 'A' },
      eval: { ref: 'eval_fixture', status: 'pass', successRate: 1 },
      review: { refs: ['review_fixture'], status: 'certified', validUntil: '2026-09-13T01:00:00Z' },
    },
  });
}

test('organization apply/status uses revision CAS and a privacy-trimmed public projection', t => {
  const directory = workspace(t);
  const ledger = path.join(directory, 'organization.json');
  const store = new OrganizationGovernanceStore(ledger);
  const input = writeJson(directory, 'create-org.json', organizationEvent());
  const applied = run('organization-apply', '--ledger', ledger, '--input', input,
    '--expected-revision', store.read().revision, '--now', NOW);
  assert.equal(applied.status, 0, applied.stderr);
  assert.equal(applied.json.action, 'appended');

  const status = run('organization-status', '--ledger', ledger, '--organization', 'org_yongle');
  assert.equal(status.status, 0, status.stderr);
  assert.equal(status.json.organization.name, '永乐教育训练营');
  assert.equal(status.json.roleSummary.org_admin, 1);
  assert.match(status.json.ledgerRevision, /^sha256:/);
  assert.equal(JSON.stringify(status.json).includes('principal:owner-fixture'), false);
});

test('organization CLI refuses caller supplied enrollment trust', t => {
  const directory = workspace(t);
  const input = writeJson(directory, 'enroll.json', {
    ...organizationEvent(), type: 'enrollment.created', operationId: 'op_bad_enroll',
    subject: { enrollmentId: 'enroll_one' },
    payload: { enrollment: { enrollmentId: 'enroll_one', establishmentId: 'est_one', skillId: 'qiuyiwu/humanizer', releaseId: `rel_${'a'.repeat(64)}` } },
  });
  const result = run('organization-apply', '--ledger', path.join(directory, 'org.json'), '--input', input,
    '--expected-revision', D('a'), '--now', NOW);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /CLI_TRUSTED_REGISTRY_REQUIRED/);
  assert.equal(result.stdout, '');
});

test('staging plan is offline and status reports an empty persistent ledger', t => {
  const directory = workspace(t);
  const input = writeJson(directory, 'envelope.json', envelope());
  const planned = run('staging-plan', '--input', input, '--operation', 'op_cli_stage', '--after-cursor', '0');
  assert.equal(planned.status, 0, planned.stderr);
  assert.equal(planned.json.mode, 'dry-run');
  assert.match(planned.json.confirmationDigest, /^sha256:/);

  const status = run('staging-status', '--ledger', path.join(directory, 'staging.json'));
  assert.equal(status.status, 0, status.stderr);
  assert.equal(status.json.cursor, '0');
  assert.equal(status.json.receiptCount, 0);
  assert.equal(status.json.reconciliationRequiredCount, 0);
  assert.deepEqual(status.json.operations, []);
});

test('governance CLI parse failures use Chinese messages and stable error codes', () => {
  const missing = run('organization-status', '--organization', 'org_yongle');
  assert.notEqual(missing.status, 0);
  assert.equal(missing.stdout, '');
  assert.match(missing.stderr, /CLI_ARGUMENT_REQUIRED/);
  assert.match(missing.stderr, /缺少必填参数 --ledger/);

  const unknown = run('governance-unknown');
  assert.notEqual(unknown.status, 0);
  assert.equal(unknown.stdout, '');
  assert.match(unknown.stderr, /CLI_UNKNOWN_COMMAND/);
  assert.match(unknown.stderr, /未知命令/);
});

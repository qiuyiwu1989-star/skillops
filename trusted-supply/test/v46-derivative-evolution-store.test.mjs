import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { canonicalDigest } from '../lib/registry-identity.mjs';
import { DerivativeEvolutionStore, replayDerivativeEvolutionStoreEvents } from '../lib/enterprise/derivative-evolution-store.mjs';

const AT = '2026-08-14T04:00:00.000Z';
const ORG = 'org_acme';
const PRIVATE_PRODUCT = `privprod_${'a'.repeat(64)}`;
const PRIVATE_RELEASE = `privrel_${'b'.repeat(64)}`;
const OTHER_ORG = 'org_other';
const OTHER_PRODUCT = `privprod_${'8'.repeat(64)}`;
const OTHER_RELEASE = `privrel_${'7'.repeat(64)}`;
const D = value => `sha256:${value.repeat(64)}`;

function tempFile() {
  return path.join(fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'skillops-v46-evolution-')), 'evolution.json');
}

function plan(operationId = 'upgrade:v46:001', digestSeed = 'c', organizationId = ORG, privateProductId = PRIVATE_PRODUCT, currentPrivateReleaseId = PRIVATE_RELEASE) {
  const body = {
    schemaVersion: 1, operationId, kind: 'upgrade', status: 'ready', organizationId,
    privateProductId, currentPrivateReleaseId,
    projectId: 'project_alpha', environment: 'production',
    target: { proposedUpstreamReleaseId: `rel_${digestSeed.repeat(64)}` },
    nonExecutable: true, automaticUpgrade: false,
  };
  return { ...body, planDigest: canonicalDigest(body) };
}

function eventInput(trustedPlan = plan()) {
  return {
    type: 'plan.accepted', operationId: trustedPlan.operationId,
    planDigest: trustedPlan.planDigest, confirmPlanDigest: trustedPlan.planDigest, occurredAt: AT,
  };
}

function trustOptions(plans) {
  return {
    planResolver: digest => plans.get(digest) ?? null,
    organizationResolver: ({ organizationId, projectId, environment }) => ({ decision: 'allow', organizationId, projectId, environment }),
    confirmationStatusResolver: context => {
      const body = {
        decision: 'allow', planDigest: context.planDigest, organizationId: context.organizationId,
        privateProductId: context.privateProductId, currentPrivateReleaseId: context.currentPrivateReleaseId,
        targetDigest: canonicalDigest(context.target), checkedAt: AT,
      };
      return { ...body, confirmationDigest: canonicalDigest(body) };
    },
    privateReleaseResolver: id => ({
      privateReleaseId: id, privateProductId: PRIVATE_PRODUCT, organizationId: ORG,
      status: 'published', packageDigest: D('e'), manifestDigest: D('f'),
      governance: {
        licenseDigest: D('1'), securityDigest: D('2'), permissionsDigest: D('3'), compatibilityDigest: D('4'),
        dependenciesDigest: D('5'), evidenceDigest: D('6'), dependenciesKnown: true, evidenceCurrent: true, licenseAllowsUpgrade: true,
      },
    }),
  };
}

test('append-only Store survives restart and projects plan selections without mutating Releases', () => {
  const file = tempFile();
  const trustedPlan = plan();
  const otherPlan = plan('upgrade:v46:other', '6', OTHER_ORG, OTHER_PRODUCT, OTHER_RELEASE);
  const plans = new Map([[trustedPlan.planDigest, trustedPlan], [otherPlan.planDigest, otherPlan]]);
  const store = new DerivativeEvolutionStore(file, { trustOptions: trustOptions(plans) });
  const result = store.append(eventInput(trustedPlan), { expectedRevision: store.snapshot().revision });
  assert.equal(result.action, 'appended');
  const otherMutation = store.append(eventInput(otherPlan), { expectedRevision: result.revision });
  const otherMutationBytes = JSON.stringify(otherMutation);
  for (const hidden of [ORG, PRIVATE_PRODUCT, PRIVATE_RELEASE]) assert.equal(otherMutationBytes.includes(hidden), false);
  assert.equal(store.filePath, undefined);
  assert.equal(store.trustOptions, undefined);
  assert.equal(store.faultInjector, undefined);
  const restarted = new DerivativeEvolutionStore(file, { trustOptions: trustOptions(plans) });
  assert.equal(restarted.snapshot().eventCount, 2);
  assert.equal(restarted.read, undefined);
  assert.equal(restarted.project, undefined);
  assert.throws(() => restarted.projectOrganization(), error => error.code === 'ORGANIZATION_AUTHORIZER_REQUIRED');
  const projection = restarted.projectOrganization({ organizationAuthorizer: () => ({ decision: 'allow', organizationId: ORG }) });
  assert.equal(projection.privateProducts[PRIVATE_PRODUCT].selectedPlanDigest, trustedPlan.planDigest);
  assert.equal(projection.privateProducts[PRIVATE_PRODUCT].currentReleaseChanged, false);
  const other = restarted.projectOrganization({ organizationAuthorizer: () => ({ decision: 'allow', organizationId: 'org_third' }) });
  assert.equal(other.eventCount, 0);
  assert.deepEqual(other.privateProducts, {});
  const publicProjection = restarted.projectPublic();
  assert.deepEqual(publicProjection.summary, { organizations: 2, privateProducts: 2, planSelections: 2, rollbackSelections: 0 });
  const publicBytes = JSON.stringify(publicProjection);
  for (const hidden of [ORG, PRIVATE_PRODUCT, PRIVATE_RELEASE, 'selectedTarget', 'history']) assert.equal(publicBytes.includes(hidden), false);
  assert.equal(restarted.write, undefined);
});

test('identical operation is idempotent while reused operationId with another digest conflicts', () => {
  const file = tempFile();
  const firstPlan = plan();
  const secondPlan = plan(firstPlan.operationId, '9');
  const plans = new Map([[firstPlan.planDigest, firstPlan], [secondPlan.planDigest, secondPlan]]);
  const store = new DerivativeEvolutionStore(file, { trustOptions: trustOptions(plans) });
  const first = store.append(eventInput(firstPlan), { expectedRevision: store.snapshot().revision });
  const bytes = fs.readFileSync(file);
  const replay = store.append(eventInput(firstPlan), { expectedRevision: first.revision });
  assert.equal(replay.action, 'unchanged');
  assert.deepEqual(fs.readFileSync(file), bytes);
  assert.throws(() => store.append(eventInput(secondPlan), { expectedRevision: first.revision }), error => error.code === 'OPERATION_CONFLICT');
  assert.deepEqual(fs.readFileSync(file), bytes);
});

test('CAS and injected failure preserve the prior committed ledger', () => {
  const file = tempFile();
  const firstPlan = plan();
  const plans = new Map([[firstPlan.planDigest, firstPlan]]);
  const store = new DerivativeEvolutionStore(file, { trustOptions: trustOptions(plans) });
  assert.throws(() => store.append(eventInput(firstPlan), { expectedRevision: D('0') }), error => error.code === 'REVISION_CONFLICT');
  assert.equal(fs.existsSync(file), false);

  const faulty = new DerivativeEvolutionStore(file, {
    trustOptions: trustOptions(plans),
    faultInjector: stage => { if (stage === 'beforeRename') throw new Error('fixture write failure'); },
  });
  assert.throws(() => faulty.append(eventInput(firstPlan), { expectedRevision: faulty.snapshot().revision }), /fixture write failure/);
  assert.equal(fs.existsSync(file), false);
});

test('tampered history, symlink paths and hard event limits fail closed', t => {
  const file = tempFile();
  const trustedPlan = plan();
  const plans = new Map([[trustedPlan.planDigest, trustedPlan]]);
  const store = new DerivativeEvolutionStore(file, { trustOptions: trustOptions(plans) });
  store.append(eventInput(trustedPlan), { expectedRevision: store.snapshot().revision });
  const ledger = JSON.parse(fs.readFileSync(file, 'utf8'));
  ledger.events[0].planDigest = D('0');
  fs.writeFileSync(file, JSON.stringify(ledger));
  assert.throws(() => store.snapshot(), error => error.code === 'INVALID_STORE');

  if (process.platform !== 'win32') {
    const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'skillops-v46-root-'));
    const outside = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'skillops-v46-outside-'));
    fs.symlinkSync(outside, path.join(root, 'state'));
    assert.throws(() => new DerivativeEvolutionStore(path.join(root, 'state', 'events.json'), { trustOptions: trustOptions(plans) }), error => error.code === 'UNSAFE_STORE_PATH');
    assert.deepEqual(fs.readdirSync(outside), []);
  } else t.diagnostic('symlink fixture skipped on Windows');
  assert.throws(() => replayDerivativeEvolutionStoreEvents(new Array(100_001).fill(null), trustOptions(plans)), error => error.code === 'EVENT_LIMIT_EXCEEDED');
});

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { createPackageArtifact } from '../lib/package.mjs';
import { canonicalDigest } from '../lib/registry-identity.mjs';
import {
  createPrivateProduct,
  normalizeDerivativeSourceEvidence,
} from '../lib/enterprise/private-ability.mjs';
import {
  PrivateAbilityStore,
  replayPrivateAbilityEvents,
} from '../lib/enterprise/private-ability-store.mjs';
import {
  replayDerivativeEvolutionEvents,
} from '../lib/enterprise/derivative-evolution.mjs';
import {
  DerivativeEvolutionStore,
  replayDerivativeEvolutionStoreEvents,
} from '../lib/enterprise/derivative-evolution-store.mjs';
import { normalizeEnterpriseWorkbench } from '../../market-preview/enterprise.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const T0 = '2026-08-14T00:00:00.000Z';
const T1 = '2026-08-14T01:00:00.000Z';
const T2 = '2026-08-14T02:00:00.000Z';
const FUTURE = '2026-09-14T00:00:00.000Z';
const D = char => `sha256:${char.repeat(64)}`;

function temporaryFile(name) {
  const directory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'skillops-v46-independent-'));
  return path.join(directory, name);
}

function authorizer(organizationId) {
  return () => ({ decision: 'allow', organizationId });
}

function selfEvidence(context) {
  return {
    decision: 'allow', organizationId: context.organizationId, sourceType: 'self_authored',
    evidenceRef: context.evidenceRef, evidenceDigest: D('a'),
  };
}

function createSelfProduct(store, organizationId, suffix, expectedRevision, now = T0) {
  return store.createProduct({
    organizationId,
    skillId: `${suffix}/private-skill`,
    productKey: `private-${suffix}`,
    titleZh: `${suffix} 私有技能`,
    summaryZh: `${suffix} 组织范围摘要`,
    sourceType: 'self_authored',
    creationEvidenceRef: `evidence:v46:${suffix}`,
  }, {
    expectedRevision,
    organizationAuthorizer: authorizer(organizationId),
    creationEvidenceResolver: selfEvidence,
    now: () => now,
  });
}

function readyPlan(organizationId, seed, operationId = `upgrade:v46:${seed}`) {
  const body = {
    schemaVersion: 1,
    operationId,
    kind: 'upgrade',
    status: 'ready',
    organizationId,
    privateProductId: `privprod_${seed.repeat(64)}`,
    currentPrivateReleaseId: `privrel_${seed.repeat(64)}`,
    projectId: `project_${seed}`,
    environment: 'staging',
    target: { proposedUpstreamReleaseId: `rel_${seed.repeat(64)}` },
    comparisonDigest: D(seed),
    reasons: [],
    requiredReassessments: [],
    migrationNotes: [],
    requiredConfirmation: { kind: 'plan_digest' },
    nonExecutable: true,
    automaticUpgrade: false,
  };
  return { ...body, planDigest: canonicalDigest(body) };
}

function evolutionTrust(plans, confirmationState = { decision: 'allow' }) {
  return {
    planResolver: digest => plans.get(digest) ?? null,
    organizationResolver: request => ({
      decision: 'allow', organizationId: request.organizationId,
      projectId: request.projectId, environment: request.environment,
    }),
    confirmationStatusResolver: context => {
      const body = {
        decision: confirmationState.decision,
        planDigest: context.planDigest,
        organizationId: context.organizationId,
        privateProductId: context.privateProductId,
        currentPrivateReleaseId: context.currentPrivateReleaseId,
        targetDigest: canonicalDigest(context.target),
        checkedAt: confirmationState.checkedAt ?? T0,
      };
      return { ...body, confirmationDigest: canonicalDigest(body) };
    },
  };
}

function eventInput(plan, occurredAt) {
  return {
    type: 'plan.accepted', operationId: plan.operationId,
    planDigest: plan.planDigest, confirmPlanDigest: plan.planDigest, occurredAt,
  };
}

test('private Store exposes no raw ledger and scopes mutation, organization and public projections', () => {
  const file = temporaryFile('private.json');
  const store = new PrivateAbilityStore(file);
  const alpha = createSelfProduct(store, 'org_alpha', 'alpha', store.status().revision);
  const beta = createSelfProduct(store, 'org_beta', 'beta', alpha.revision);

  assert.equal(store.read, undefined);
  assert.equal(store.snapshot, undefined);
  assert.equal(store.filePath, undefined);
  assert.equal(store.write, undefined);
  for (const hidden of ['org_alpha', alpha.product.privateProductId, 'alpha 私有技能']) {
    assert.equal(JSON.stringify(beta).includes(hidden), false);
  }

  const alphaProjection = store.projectOrganization({
    organizationAuthorizer: authorizer('org_alpha'), now: () => T1,
  });
  assert.deepEqual(alphaProjection.products.map(product => product.privateProductId), [alpha.product.privateProductId]);
  assert.equal(JSON.stringify(alphaProjection).includes(beta.product.privateProductId), false);
  const publicProjection = store.projectPublic();
  for (const hidden of ['org_alpha', 'org_beta', alpha.product.privateProductId, beta.product.privateProductId, '私有技能']) {
    assert.equal(JSON.stringify(publicProjection).includes(hidden), false);
  }
});

test('private Release evidence is package-bound and append-only ledger tampering fails closed', () => {
  const file = temporaryFile('private.json');
  const store = new PrivateAbilityStore(file);
  const productResult = createSelfProduct(store, 'org_alpha', 'alpha', store.status().revision);
  const artifact = createPackageArtifact({
    files: [{ path: 'SKILL.md', content: '# private' }], sourceVersion: '1.0.0', collectedAt: T0,
  });
  const releaseResult = store.createRelease({
    organizationId: 'org_alpha', privateProductId: productResult.product.privateProductId,
    version: '1.0.0', packageDigest: artifact.packageDigest, previousPrivateReleaseId: null,
  }, {
    expectedRevision: productResult.revision,
    organizationAuthorizer: authorizer('org_alpha'),
    packageResolver: () => artifact,
    now: () => T1,
  });
  const forgedEvidence = () => Object.fromEntries(['packageAudit', 'sms', 'eval', 'review'].map((kind, index) => [kind, {
    status: kind === 'review' ? 'certified' : 'pass', evidenceDigest: D(String(index + 1)),
    basedOnPackageDigest: D('f'), basedOnManifestDigest: releaseResult.release.packageManifestDigest,
    validUntil: FUTURE,
  }]));
  assert.throws(() => store.assessEvidence({
    organizationId: 'org_alpha', privateReleaseId: releaseResult.release.privateReleaseId,
  }, {
    expectedRevision: releaseResult.revision,
    organizationAuthorizer: authorizer('org_alpha'), evidenceResolver: forgedEvidence, now: () => T2,
  }), error => error.cause?.code === 'EVIDENCE_BINDING_MISMATCH' || error.code === 'EVIDENCE_BINDING_MISMATCH');

  const committed = fs.readFileSync(file);
  const tampered = JSON.parse(committed.toString('utf8'));
  tampered.events[0].payload.product.titleZh = '被覆写的标题';
  fs.writeFileSync(file, JSON.stringify(tampered));
  assert.throws(() => store.status(), error => ['INVALID_EVENT_PAYLOAD', 'REVISION_MISMATCH'].includes(error.code));
  fs.writeFileSync(file, committed);
  assert.equal(store.status().eventCount, 2);
});

test('recall/revoke evidence, symlink paths and event resource exhaustion fail closed', t => {
  const evidence = {
    decision: 'allow', organizationId: 'org_alpha', privateProductId: `privprod_${'a'.repeat(64)}`,
    sourceType: 'authorized_derivative', evidenceRef: 'lineage:alpha', evidenceDigest: D('1'),
    baseProductId: `prod_${'b'.repeat(64)}`, baseReleaseId: `rel_${'c'.repeat(64)}`,
    entitlementId: `ent_${'d'.repeat(64)}`, entitlementDigest: D('2'), licenseSnapshotDigest: D('3'),
    lineageDigest: D('4'), rights: ['derive', 'internal_distribute'], validUntil: FUTURE,
    publicationStatus: 'published', entitlementStatus: 'active',
  };
  assert.throws(() => normalizeDerivativeSourceEvidence({ ...evidence, publicationStatus: 'recalled' }, {}, { at: T0, forNewRelease: true }), error => error.code === 'SOURCE_RELEASE_BLOCKED');
  assert.throws(() => normalizeDerivativeSourceEvidence({ ...evidence, entitlementStatus: 'revoked' }, {}, { at: T0, forNewRelease: true }), error => error.code === 'SOURCE_ENTITLEMENT_BLOCKED');
  assert.throws(() => replayPrivateAbilityEvents(new Array(100_001).fill(null)), error => error.code === 'EVENT_LIMIT_EXCEEDED');
  assert.throws(() => replayDerivativeEvolutionEvents(new Array(100_001).fill(null), {}), error => error.code === 'EVENT_LIMIT_EXCEEDED');
  assert.throws(() => replayDerivativeEvolutionStoreEvents(new Array(100_001).fill(null), {}), error => error.code === 'EVENT_LIMIT_EXCEEDED');

  if (process.platform === 'win32') return t.diagnostic('symlink fixture skipped on Windows');
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'skillops-v46-independent-root-'));
  const outside = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'skillops-v46-independent-outside-'));
  fs.symlinkSync(outside, path.join(root, 'state'));
  assert.throws(() => new PrivateAbilityStore(path.join(root, 'state', 'private.json')), error => error.code === 'UNSAFE_STORE_PATH');
  assert.throws(() => new DerivativeEvolutionStore(path.join(root, 'state', 'evolution.json')), error => error.code === 'UNSAFE_STORE_PATH');
  assert.deepEqual(fs.readdirSync(outside), []);
});

test('private metadata rejects generic POSIX and Windows absolute paths before persistence', () => {
  for (const summaryZh of ['位置:/etc/passwd', '位置:/opt/company/secret', '位置:C:\\Users\\alice\\secret']) {
    assert.throws(() => createPrivateProduct({
      organizationId: 'org_alpha', skillId: 'alpha/private-skill', productKey: 'private-alpha',
      titleZh: '私有技能', summaryZh, sourceType: 'self_authored', creationEvidenceRef: 'evidence:v46:path',
    }, {
      organizationAuthorizer: authorizer('org_alpha'), creationEvidenceResolver: selfEvidence, now: () => T0,
    }), error => error.code === 'PRIVATE_VALUE');
  }
});

test('evolution Store mutation is tenant-scoped while authorized and public projections stay separated', () => {
  const file = temporaryFile('evolution.json');
  const alpha = readyPlan('org_alpha', 'a');
  const beta = readyPlan('org_beta', 'b');
  const plans = new Map([[alpha.planDigest, alpha], [beta.planDigest, beta]]);
  const store = new DerivativeEvolutionStore(file, { trustOptions: evolutionTrust(plans) });
  const first = store.append(eventInput(alpha, T0), { expectedRevision: store.snapshot().revision });
  const second = store.append(eventInput(beta, T1), { expectedRevision: first.revision });

  assert.equal(store.read, undefined);
  assert.equal(store.filePath, undefined);
  assert.equal(store.trustOptions, undefined);
  for (const hidden of ['org_alpha', alpha.privateProductId, alpha.currentPrivateReleaseId]) {
    assert.equal(JSON.stringify(second).includes(hidden), false);
  }
  const own = store.projectOrganization({ organizationAuthorizer: authorizer('org_alpha') });
  assert.equal(own.eventCount, 1);
  assert.equal(own.events[0].organizationId, 'org_alpha');
  assert.equal(JSON.stringify(own).includes('org_beta'), false);
  const publicProjection = store.projectPublic();
  for (const hidden of ['org_alpha', 'org_beta', alpha.privateProductId, beta.privateProductId, 'selectedTarget']) {
    assert.equal(JSON.stringify(publicProjection).includes(hidden), false);
  }

  const committed = fs.readFileSync(file);
  const tampered = JSON.parse(committed.toString('utf8'));
  tampered.events[0].selectedTarget.proposedUpstreamReleaseId = `rel_${'f'.repeat(64)}`;
  fs.writeFileSync(file, JSON.stringify(tampered));
  assert.throws(() => store.snapshot(), error => error.code === 'INVALID_STORE');
  fs.writeFileSync(file, committed);
  assert.equal(store.snapshot().eventCount, 2);
});

test('confirmation rechecks current state while historical selections remain replayable after a later block', () => {
  const file = temporaryFile('evolution.json');
  const alpha = readyPlan('org_alpha', 'a');
  const beta = readyPlan('org_alpha', 'b');
  const plans = new Map([[alpha.planDigest, alpha], [beta.planDigest, beta]]);
  const confirmationState = { decision: 'allow', checkedAt: T0 };
  const trust = evolutionTrust(plans, confirmationState);
  const store = new DerivativeEvolutionStore(file, { trustOptions: trust });
  const first = store.append(eventInput(alpha, T0), { expectedRevision: store.snapshot().revision });
  const historical = store.projectOrganization({ organizationAuthorizer: authorizer('org_alpha') }).events[0];

  confirmationState.decision = 'deny';
  confirmationState.checkedAt = T1;
  assert.throws(() => store.append(eventInput(beta, T2), { expectedRevision: first.revision }), error => (
    error.code === 'INVALID_EVENT' && error.cause?.code === 'CONFIRMATION_STATUS_BLOCKED'
  ));
  assert.equal(store.snapshot().eventCount, 1);
  assert.equal(replayDerivativeEvolutionEvents([historical], trust).eventCount, 1);
});

test('enterprise workbench rejects sensitive paths even when prefixed by Chinese punctuation', () => {
  const fixture = JSON.parse(fs.readFileSync(path.resolve(HERE, '../../market-preview/enterprise.fixture.json'), 'utf8'));
  for (const sensitive of [
    '内部位置:/Users/alice/secret',
    '内部位置:file:///Users/alice/secret',
    '配置位于:/etc/passwd',
    '配置位于:/opt/company/secret',
    '配置位于:C:\\Users\\alice\\secret',
  ]) {
    const value = structuredClone(fixture);
    value.products[0].summaryZh = sensitive;
    assert.throws(() => normalizeEnterpriseWorkbench(value), /ORGANIZATION_PRIVATE_PROJECTION_REQUIRED/);
  }
});

import assert from 'node:assert/strict';
import test from 'node:test';

import { createOffer } from '../lib/commerce/offer.mjs';
import { createFreeOrder } from '../lib/commerce/order.mjs';
import { issueEntitlement } from '../lib/commerce/entitlement.mjs';
import { canonicalDigest } from '../lib/registry-identity.mjs';
import { normalizePackageManifest, packageDigest } from '../lib/package.mjs';
import {
  calculatePrivateProductId,
  normalizePrivateProduct,
  normalizePrivateRelease,
} from '../lib/enterprise/private-ability.mjs';
import {
  compareDerivativeUpstream,
  createDerivativeEvolutionEvent,
  createDerivativeEvolutionLineage,
  createDerivativeForkLineage,
  createDerivativeRollbackPlan,
  createDerivativeUpgradePlan,
  replayDerivativeEvolutionEvents,
} from '../lib/enterprise/derivative-evolution.mjs';

const AT = '2026-08-14T03:00:00.000Z';
const LATER = '2026-08-14T04:00:00.000Z';
const ORG = 'org_acme';
const PROJECT = 'project_alpha';
const ENVIRONMENT = 'production';
const BASE_PRODUCT = `prod_${'a'.repeat(64)}`;
const PRIVATE_PRODUCT = calculatePrivateProductId({ organizationId: ORG, skillId: 'acme/private-research', productKey: 'private-research' });
const BASE_RELEASE = `rel_${'c'.repeat(64)}`;
const UPSTREAM_RELEASE = `rel_${'d'.repeat(64)}`;
const PRIVATE_RELEASE_3 = `privrel_${'1'.repeat(64)}`;
const D = value => `sha256:${value.repeat(64)}`;

function manifest(entries) {
  return normalizePackageManifest(entries.map(([path, char, size = 8]) => ({
    path, size, sha256: char.repeat(64), mediaType: path.endsWith('.md') ? 'text/markdown' : 'application/javascript', executable: false,
  })));
}

const BASE_MANIFEST = manifest([['SKILL.md', '1'], ['scripts/run.mjs', '2']]);
const PRIVATE_MANIFEST = manifest([['SKILL.md', '1'], ['scripts/run.mjs', '3'], ['references/private.md', '4']]);
const UPSTREAM_MANIFEST = manifest([['SKILL.md', '5'], ['scripts/helper.mjs', '6']]);
const NEXT_PRIVATE_MANIFEST = manifest([['SKILL.md', '5'], ['scripts/helper.mjs', '6'], ['references/private.md', '4']]);
const privateReleaseId = (version, packageManifest) => `privrel_${canonicalDigest({
  domain: 'skillops.enterprise.private-release.v1', privateProductId: PRIVATE_PRODUCT,
  version, packageDigest: packageDigest(packageManifest),
}).slice(7)}`;
const PRIVATE_RELEASE_1 = privateReleaseId('1.0.0', PRIVATE_MANIFEST);
const PRIVATE_RELEASE_2 = privateReleaseId('1.1.0', NEXT_PRIVATE_MANIFEST);

function governance(overrides = {}) {
  return {
    licenseDigest: D('7'), securityDigest: D('8'), permissionsDigest: D('9'),
    compatibilityDigest: D('a'), dependenciesDigest: D('b'), evidenceDigest: D('c'),
    dependenciesKnown: true, evidenceCurrent: true, licenseAllowsUpgrade: true,
    ...overrides,
  };
}

function release(id, productId, packageManifest, overrides = {}) {
  return {
    status: 'published',
    releaseId: id,
    productId,
    packageDigest: packageDigest(packageManifest),
    manifestDigest: canonicalDigest(packageManifest),
    ...overrides,
  };
}

function privateProductRecord(root, grant) {
  const sourceEvidence = {
    decision: 'allow', organizationId: ORG, privateProductId: PRIVATE_PRODUCT,
    sourceType: 'authorized_derivative', evidenceRef: 'evidence:v46:root', evidenceDigest: D('d'),
    baseProductId: BASE_PRODUCT, baseReleaseId: BASE_RELEASE,
    entitlementId: grant.entitlementId, entitlementDigest: grant.entitlementDigest,
    licenseSnapshotDigest: root.licenseSnapshotDigest, lineageDigest: root.lineageDigest,
    rights: ['derive', 'internal_distribute'], validUntil: null,
    publicationStatus: 'published', entitlementStatus: 'active',
  };
  const body = {
    schemaVersion: 1, privateProductId: PRIVATE_PRODUCT, organizationId: ORG,
    skillId: 'acme/private-research', productKey: 'private-research', titleZh: '企业研究私有技能',
    summaryZh: '用于企业内部研究流程。', sourceType: 'authorized_derivative', sourceEvidence,
    visibility: 'organization_private', createdAt: LATER,
  };
  return normalizePrivateProduct({ ...body, productDigest: canonicalDigest(body) });
}

function privateReleaseRecord(product, version, packageManifest, previousPrivateReleaseId) {
  const packageDigestValue = packageDigest(packageManifest);
  const body = {
    schemaVersion: 1, privateReleaseId: privateReleaseId(version, packageManifest), organizationId: ORG,
    privateProductId: PRIVATE_PRODUCT, version, packageDigest: packageDigestValue,
    packageManifestDigest: canonicalDigest(packageManifest), fileCount: packageManifest.length,
    totalBytes: packageManifest.reduce((sum, row) => sum + row.size, 0), previousPrivateReleaseId,
    sourceType: 'authorized_derivative', sourceEvidenceDigest: product.sourceEvidence.evidenceDigest,
    status: 'evidence_pending', createdAt: LATER,
  };
  return normalizePrivateRelease({ ...body, releaseDigest: canonicalDigest(body) });
}

function entitlement(rights = ['derive', 'internal_distribute'], constraints = {}) {
  const offer = createOffer({
    offerId: 'offer_v46_derivative', productId: BASE_PRODUCT,
    pricing: { model: 'free', currency: 'CNY', amountMinor: 0 },
    licensePolicy: {
      rights,
      constraints: {
        organizationIds: [ORG], projectIds: [PROJECT], environments: [ENVIRONMENT],
        releaseIds: [BASE_RELEASE], ...constraints,
      },
    },
    effectiveAt: AT,
  });
  const order = createFreeOrder({
    orderId: 'ord_v46_derivative', organizationId: ORG, productId: BASE_PRODUCT,
    releaseScope: { releaseIds: [BASE_RELEASE] }, offerRevisionId: offer.offerRevisionId,
    idempotencyKey: 'v46:derivative:fixture',
  }, {
    offerResolver: () => ({ offerRevision: offer, currentOfferRevisionId: offer.offerRevisionId }),
    productResolver: () => ({ productId: BASE_PRODUCT, status: 'published' }),
    releaseResolver: () => ({ releaseId: BASE_RELEASE, productId: BASE_PRODUCT, status: 'published' }),
    now: () => AT,
  });
  return issueEntitlement({ order, issuedAt: AT });
}

function fixture(overrides = {}) {
  const grant = overrides.entitlement ?? entitlement();
  let privateProduct = null;
  let privateOne = null;
  let privateTwo = null;
  const base = release(BASE_RELEASE, BASE_PRODUCT, BASE_MANIFEST);
  const upstream = release(UPSTREAM_RELEASE, BASE_PRODUCT, UPSTREAM_MANIFEST);
  const roots = new Map();
  const privateProducts = new Map();
  const privateReleases = new Map();
  const privateStates = new Map();
  const baseReleases = new Map([[BASE_RELEASE, base], [UPSTREAM_RELEASE, upstream]]);
  const manifests = new Map([
    [`base:${BASE_RELEASE}`, BASE_MANIFEST], [`base:${UPSTREAM_RELEASE}`, UPSTREAM_MANIFEST],
    [`private:${PRIVATE_RELEASE_1}`, PRIVATE_MANIFEST], [`private:${PRIVATE_RELEASE_2}`, NEXT_PRIVATE_MANIFEST],
  ]);
  const options = {
    entitlementResolver: id => id === grant.entitlementId ? grant : null,
    organizationResolver: request => ({ decision: 'allow', organizationId: ORG, projectId: request.projectId, environment: request.environment }),
    baseReleaseResolver: id => baseReleases.get(id) ?? null,
    privateProductResolver: id => privateProducts.get(id) ?? null,
    privateReleaseResolver: id => privateReleases.get(id) ?? null,
    privateReleaseStateResolver: ({ privateReleaseId: id }) => privateStates.get(id) ?? null,
    lineageResolver: id => roots.get(id) ?? [...roots.values()].find(root => root.lineageDigest === id) ?? null,
    manifestResolver: ({ releaseKind, releaseId }) => manifests.get(`${releaseKind}:${releaseId}`) ?? null,
    governanceResolver: ({ releaseKind, releaseId, packageDigest: boundPackageDigest, manifestDigest }) => {
      const source = releaseKind === 'base' ? baseReleases.get(releaseId) : privateReleases.get(releaseId);
      if (!source) return null;
      const value = governance();
      const body = { releaseKind, releaseId, packageDigest: boundPackageDigest, manifestDigest, ...value };
      return { releaseKind, releaseId, packageDigest: boundPackageDigest, manifestDigest, ...value, governanceDigest: canonicalDigest(body) };
    },
    reassessmentResolver: () => ({ comparisonDigest: null, packageAudit: 'pending', sms: 'pending', eval: 'pending', review: 'pending' }),
    confirmationStatusResolver: context => {
      const body = {
        decision: 'allow', planDigest: context.planDigest, organizationId: context.organizationId,
        privateProductId: context.privateProductId, currentPrivateReleaseId: context.currentPrivateReleaseId,
        targetDigest: canonicalDigest(context.target), checkedAt: LATER,
      };
      return { ...body, confirmationDigest: canonicalDigest(body) };
    },
    now: () => LATER,
  };
  const createRoot = () => {
    const root = createDerivativeForkLineage({
      entitlementId: grant.entitlementId, baseReleaseId: BASE_RELEASE, privateProductId: PRIVATE_PRODUCT,
      projectId: PROJECT, environment: ENVIRONMENT,
    }, options);
    roots.set(root.lineageId, root);
    roots.set(root.lineageDigest, root);
    privateProduct = privateProductRecord(root, grant);
    privateOne = privateReleaseRecord(privateProduct, '1.0.0', PRIVATE_MANIFEST, null);
    privateTwo = privateReleaseRecord(privateProduct, '1.1.0', NEXT_PRIVATE_MANIFEST, PRIVATE_RELEASE_1);
    privateProducts.set(privateProduct.privateProductId, privateProduct);
    privateReleases.set(privateOne.privateReleaseId, privateOne);
    privateReleases.set(privateTwo.privateReleaseId, privateTwo);
    for (const releaseValue of [privateOne, privateTwo]) {
      const stateBody = {
        privateReleaseId: releaseValue.privateReleaseId, privateProductId: releaseValue.privateProductId,
        organizationId: releaseValue.organizationId, releaseDigest: releaseValue.releaseDigest,
        status: 'available', target: { exists: true, managed: true, drift: false }, evidenceCurrent: true,
      };
      privateStates.set(releaseValue.privateReleaseId, { ...stateBody, stateDigest: canonicalDigest(stateBody) });
    }
    return root;
  };
  return {
    grant, get privateProduct() { return privateProduct; }, base, upstream,
    get privateOne() { return privateOne; }, get privateTwo() { return privateTwo; },
    roots, privateProducts, privateReleases, privateStates, baseReleases, manifests, options, createRoot,
  };
}

function comparisonInput(lineageId) {
  return {
    lineageId, currentPrivateReleaseId: PRIVATE_RELEASE_1, currentBaseReleaseId: BASE_RELEASE,
    proposedUpstreamReleaseId: UPSTREAM_RELEASE, projectId: PROJECT, environment: ENVIRONMENT,
  };
}

test('authorized Fork binds trusted scope and preserves immutable root lineage across private evolution', () => {
  const f = fixture();
  const root = f.createRoot();
  assert.match(root.lineageId, /^lineage_[a-f0-9]{64}$/);
  assert.equal(root.organizationId, ORG);
  assert.equal(root.baseProductId, BASE_PRODUCT);
  assert.equal(root.baseReleaseId, BASE_RELEASE);
  assert.equal(root.entitlementId, f.grant.entitlementId);
  assert.match(root.licenseSnapshotDigest, /^sha256:[a-f0-9]{64}$/);

  const evolved = createDerivativeEvolutionLineage({
    predecessorPrivateReleaseId: PRIVATE_RELEASE_1, newPrivateReleaseId: PRIVATE_RELEASE_2,
  }, f.options);
  assert.equal(evolved.lineageId, root.lineageId);
  assert.equal(evolved.root.baseReleaseId, BASE_RELEASE);
  assert.equal(evolved.root.entitlementId, f.grant.entitlementId);
  assert.equal(evolved.predecessorPrivateReleaseId, PRIVATE_RELEASE_1);
  assert.equal(evolved.newPrivateReleaseId, PRIVATE_RELEASE_2);
});

test('Fork fails closed for missing rights, scope mismatch, caller trust injection and sticky revocation', () => {
  for (const rights of [['derive'], ['internal_distribute']]) {
    const f = fixture({ entitlement: entitlement(rights) });
    assert.throws(() => f.createRoot(), error => error.code === 'RIGHT_MISSING');
  }
  const scoped = fixture();
  assert.throws(() => createDerivativeForkLineage({
    entitlementId: scoped.grant.entitlementId, baseReleaseId: BASE_RELEASE, privateProductId: PRIVATE_PRODUCT,
    projectId: 'project_other', environment: ENVIRONMENT,
  }, scoped.options), error => error.code === 'PROJECT_NOT_GRANTED');
  assert.throws(() => createDerivativeForkLineage({
    entitlementId: scoped.grant.entitlementId, baseReleaseId: BASE_RELEASE, privateProductId: PRIVATE_PRODUCT,
    projectId: PROJECT, environment: ENVIRONMENT, entitlement: scoped.grant,
  }, scoped.options), error => error.code === 'UNKNOWN_FIELD');
  scoped.baseReleases.set(BASE_RELEASE, { ...scoped.base, status: 'recalled' });
  assert.throws(() => scoped.createRoot(), error => error.code === 'BASE_RELEASE_RECALLED');
});

test('manifest comparison emits filenames and governance deltas without file bodies or storage references', () => {
  const f = fixture();
  const root = f.createRoot();
  const result = compareDerivativeUpstream(comparisonInput(root.lineageId), f.options);
  assert.deepEqual(result.manifestChanges.added, ['scripts/helper.mjs']);
  assert.deepEqual(result.manifestChanges.modified, ['SKILL.md']);
  assert.deepEqual(result.manifestChanges.deleted, ['scripts/run.mjs']);
  assert.ok(result.governanceChanges.some(row => row.kind === 'package'));
  assert.match(result.comparisonDigest, /^sha256:[a-f0-9]{64}$/);
  const serialized = JSON.stringify(result);
  for (const forbidden of ['content', 'storageRef', 'cas:', '/Users/', 'file://']) assert.equal(serialized.includes(forbidden), false);
});

test('manifest resolver mismatch, traversal, case collision and unknown fields fail closed', () => {
  const f = fixture();
  const root = f.createRoot();
  f.options.manifestResolver = ({ releaseKind, releaseId }) => {
    if (releaseKind === 'base' && releaseId === UPSTREAM_RELEASE) return [{ path: '../secret', size: 1, sha256: '1'.repeat(64) }];
    return f.manifests.get(`${releaseKind}:${releaseId}`);
  };
  assert.throws(() => compareDerivativeUpstream(comparisonInput(root.lineageId), f.options), error => ['unsafe_path', 'MANIFEST_RESOLVER_FAILED'].includes(error.code));

  const collision = fixture();
  const collisionRoot = collision.createRoot();
  collision.options.manifestResolver = ({ releaseKind, releaseId }) => releaseKind === 'base' && releaseId === UPSTREAM_RELEASE
    ? [{ path: 'SKILL.md', size: 1, sha256: '1'.repeat(64) }, { path: 'skill.md', size: 1, sha256: '2'.repeat(64) }]
    : collision.manifests.get(`${releaseKind}:${releaseId}`);
  assert.throws(() => compareDerivativeUpstream(comparisonInput(collisionRoot.lineageId), collision.options), error => ['case_path_conflict', 'MANIFEST_RESOLVER_FAILED'].includes(error.code));
  assert.throws(() => compareDerivativeUpstream({ ...comparisonInput(collisionRoot.lineageId), summary: 'private body' }, collision.options), error => error.code === 'UNKNOWN_FIELD');
  const bodyLeak = fixture();
  const bodyLeakRoot = bodyLeak.createRoot();
  bodyLeak.options.manifestResolver = ({ releaseKind, releaseId }) => releaseKind === 'base' && releaseId === UPSTREAM_RELEASE
    ? UPSTREAM_MANIFEST.map((entry, index) => index ? entry : { ...entry, content: 'private body' })
    : bodyLeak.manifests.get(`${releaseKind}:${releaseId}`);
  assert.throws(() => compareDerivativeUpstream(comparisonInput(bodyLeakRoot.lineageId), bodyLeak.options), error => error.code === 'UNKNOWN_FIELD');
});

test('upgrade plans distinguish reassessment, ready, no change and sticky blocked states', () => {
  const f = fixture();
  const root = f.createRoot();
  const input = comparisonInput(root.lineageId);
  const pending = createDerivativeUpgradePlan(input, f.options);
  assert.equal(pending.status, 'reassessment_required');
  assert.deepEqual(pending.requiredReassessments.map(row => row.kind), ['package_audit', 'sms', 'eval', 'review']);
  assert.equal(pending.nonExecutable, true);
  assert.equal(pending.automaticUpgrade, false);

  f.options.reassessmentResolver = () => ({
    comparisonDigest: null, packageAudit: 'passed', sms: 'passed', eval: 'passed', review: 'certified',
  });
  assert.throws(() => createDerivativeUpgradePlan(input, f.options), error => error.code === 'REASSESSMENT_BINDING_MISMATCH');

  f.options.reassessmentResolver = ({ comparisonDigest }) => ({
    comparisonDigest, packageAudit: 'passed', sms: 'passed', eval: 'passed', review: 'certified',
  });
  const ready = createDerivativeUpgradePlan(input, f.options);
  assert.equal(ready.status, 'ready');
  assert.match(ready.planDigest, /^sha256:[a-f0-9]{64}$/);

  f.baseReleases.set(UPSTREAM_RELEASE, { ...f.upstream, status: 'recalled' });
  const blocked = createDerivativeUpgradePlan(input, f.options);
  assert.equal(blocked.status, 'blocked');
  assert.ok(blocked.reasons.some(reason => reason.code === 'UPSTREAM_RECALLED' && reason.blocking));

  const same = fixture();
  const sameRoot = same.createRoot();
  same.baseReleases.set(UPSTREAM_RELEASE, { ...same.upstream, packageDigest: same.base.packageDigest, manifestDigest: same.base.manifestDigest });
  same.manifests.set(`base:${UPSTREAM_RELEASE}`, BASE_MANIFEST);
  assert.equal(createDerivativeUpgradePlan(comparisonInput(sameRoot.lineageId), same.options).status, 'no_change');
});

test('rollback binds the same organization/product and exact digest; accepted events never claim execution', () => {
  const f = fixture();
  const root = f.createRoot();
  const plan = createDerivativeRollbackPlan({
    operationId: 'rollback:v46:001', currentPrivateReleaseId: PRIVATE_RELEASE_2,
    targetPrivateReleaseId: PRIVATE_RELEASE_1, projectId: PROJECT, environment: ENVIRONMENT,
  }, f.options);
  assert.equal(plan.status, 'ready');
  assert.equal(plan.nonExecutable, true);
  assert.equal(plan.target.privateReleaseId, PRIVATE_RELEASE_1);
  const planResolver = digest => digest === plan.planDigest ? plan : null;
  const allowedConfirmation = f.options.confirmationStatusResolver;
  f.options.confirmationStatusResolver = context => {
    const body = {
      decision: 'deny', planDigest: context.planDigest, organizationId: context.organizationId,
      privateProductId: context.privateProductId, currentPrivateReleaseId: context.currentPrivateReleaseId,
      targetDigest: canonicalDigest(context.target), checkedAt: LATER,
    };
    return { ...body, confirmationDigest: canonicalDigest(body) };
  };
  assert.throws(() => createDerivativeEvolutionEvent({
    type: 'rollback.selected', operationId: 'rollback:v46:001', planDigest: plan.planDigest,
    confirmPlanDigest: plan.planDigest, occurredAt: LATER,
  }, { planResolver, ...f.options }), error => error.code === 'CONFIRMATION_STATUS_BLOCKED');
  f.options.confirmationStatusResolver = allowedConfirmation;
  const event = createDerivativeEvolutionEvent({
    type: 'rollback.selected', operationId: 'rollback:v46:001', planDigest: plan.planDigest,
    confirmPlanDigest: plan.planDigest, occurredAt: LATER,
  }, { planResolver, ...f.options });
  assert.equal(event.type, 'rollback.selected');
  assert.equal(event.outcome, 'selection_recorded');
  assert.equal('executed' in event, false);
  f.options.confirmationStatusResolver = () => { throw new Error('current Release was recalled after selection'); };
  const projection = replayDerivativeEvolutionEvents([event], { planResolver, ...f.options });
  assert.equal(projection.privateProducts[PRIVATE_PRODUCT].selectedTarget.privateReleaseId, PRIVATE_RELEASE_1);
  assert.equal(projection.privateProducts[PRIVATE_PRODUCT].currentReleaseChanged, false);
  assert.throws(() => createDerivativeEvolutionEvent({
    type: 'rollback.selected', operationId: 'rollback:v46:001', planDigest: plan.planDigest,
    confirmPlanDigest: D('f'), occurredAt: LATER,
  }, { planResolver, ...f.options }), error => error.code === 'CONFIRMATION_MISMATCH');

  const recalledState = {
    privateReleaseId: f.privateOne.privateReleaseId, privateProductId: f.privateOne.privateProductId,
    organizationId: f.privateOne.organizationId, releaseDigest: f.privateOne.releaseDigest,
    status: 'recalled', target: { exists: true, managed: true, drift: false }, evidenceCurrent: true,
  };
  f.privateStates.set(PRIVATE_RELEASE_1, { ...recalledState, stateDigest: canonicalDigest(recalledState) });
  assert.equal(createDerivativeRollbackPlan({
    operationId: 'rollback:v46:002', currentPrivateReleaseId: PRIVATE_RELEASE_2,
    targetPrivateReleaseId: PRIVATE_RELEASE_1, projectId: PROJECT, environment: ENVIRONMENT,
  }, f.options).status, 'blocked');
});

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createPackageArtifact } from '../lib/package.mjs';
import { PrivateAbilityStore } from '../lib/enterprise/private-ability-store.mjs';

const AT = '2026-08-14T00:00:00.000Z';
const LATER = '2026-08-15T00:00:00.000Z';
const FUTURE = '2026-09-14T00:00:00.000Z';
const ORG = 'org_acme';
const D = char => `sha256:${char.repeat(64)}`;

function directory() {
  return fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'skillops-v46-private-'));
}

function artifact(version = '1.0.0', body = '# private') {
  return createPackageArtifact({ files: [{ path: 'SKILL.md', content: body }], sourceVersion: version, collectedAt: AT });
}

function authorizer(organizationId = ORG) {
  return context => ({ decision: 'allow', organizationId, purpose: context.purpose });
}

function creationEvidenceResolver(context) {
  return {
    decision: 'allow', organizationId: ORG, sourceType: 'self_authored',
    evidenceRef: context.creationEvidenceRef, evidenceDigest: D('a'),
  };
}

function derivativeEvidence(context, overrides = {}) {
  return {
    decision: 'allow', organizationId: ORG, privateProductId: context.privateProductId,
    sourceType: 'authorized_derivative', evidenceRef: context.evidenceRef,
    evidenceDigest: D('1'), baseProductId: `prod_${'1'.repeat(64)}`,
    baseReleaseId: `rel_${'2'.repeat(64)}`, entitlementId: `ent_${'3'.repeat(64)}`,
    entitlementDigest: D('4'), licenseSnapshotDigest: D('5'), lineageDigest: D('6'),
    rights: ['derive', 'internal_distribute'], validUntil: FUTURE,
    publicationStatus: 'published', entitlementStatus: 'active', ...overrides,
  };
}

function evidenceResolver(release) {
  const binding = {
    basedOnPackageDigest: release.packageDigest,
    basedOnManifestDigest: release.packageManifestDigest,
    validUntil: FUTURE,
  };
  return {
    packageAudit: { status: 'pass', evidenceDigest: D('b'), ...binding },
    sms: { status: 'pass', evidenceDigest: D('c'), ...binding },
    eval: { status: 'pass', evidenceDigest: D('d'), ...binding },
    review: { status: 'certified', evidenceDigest: D('e'), ...binding },
  };
}

function createAll(store) {
  let state = store.createProduct({
    organizationId: ORG, skillId: 'acme/private-search', productKey: 'private-search',
    titleZh: '内部检索', summaryZh: '组织内部检索能力。', sourceType: 'self_authored',
    creationEvidenceRef: 'self:private-search',
  }, {
    expectedRevision: store.status().revision, organizationAuthorizer: authorizer(),
    creationEvidenceResolver, now: () => AT,
  });
  const product = state.product;
  const packageArtifact = artifact();
  state = store.createRelease({
    organizationId: ORG, privateProductId: state.product.privateProductId, version: '1.0.0',
    packageDigest: packageArtifact.packageDigest, previousPrivateReleaseId: null,
  }, {
    expectedRevision: state.revision, organizationAuthorizer: authorizer(),
    packageResolver: () => packageArtifact, now: () => AT,
  });
  const release = state.release;
  state = store.assessEvidence({ organizationId: ORG, privateReleaseId: state.release.privateReleaseId }, {
    expectedRevision: state.revision, organizationAuthorizer: authorizer(),
    evidenceResolver: () => evidenceResolver(state.release), now: () => LATER,
  });
  return { ...state, product, release };
}

test('append-only Store persists Product, immutable Release and evidence across restart', () => {
  const file = path.join(directory(), 'private-abilities.json');
  const store = new PrivateAbilityStore(file);
  const state = createAll(store);
  assert.equal(state.evidence.status, 'callable');
  const restarted = new PrivateAbilityStore(file);
  assert.equal(restarted.status().eventCount, 3);
  const resolver = restarted.createOrganizationResolver({ organizationAuthorizer: authorizer() });
  assert.equal(resolver.resolvePrivateProduct(state.product.privateProductId).productDigest, state.product.productDigest);
  assert.equal(resolver.resolvePrivateRelease(state.release.privateReleaseId).releaseDigest, state.release.releaseDigest);
  assert.equal(restarted.projectOrganization({ organizationAuthorizer: authorizer(), now: () => LATER }).products[0].releases[0].evidence.status, 'callable');
});

test('organization projection is tenant-scoped and public projection reveals aggregate counts only', () => {
  const store = new PrivateAbilityStore(path.join(directory(), 'private-abilities.json'));
  const state = createAll(store);
  assert.equal(store.read, undefined);
  assert.equal(store.snapshot, undefined);
  assert.equal(store.filePath, undefined);
  const status = store.status();
  assert.deepEqual(Object.keys(status).sort(), ['eventCount', 'revision', 'schemaVersion', 'statusDigest']);
  assert.equal(JSON.stringify(status).includes(state.product.privateProductId), false);
  assert.equal(JSON.stringify(status).includes(ORG), false);
  const projection = store.projectOrganization({
    organizationAuthorizer: authorizer(), sourceStatusResolver: () => null, now: () => LATER,
  });
  assert.equal(projection.organizationId, ORG);
  assert.equal(projection.summary.products, 1);
  assert.equal(projection.summary.callable, 1);
  assert.equal(projection.products[0].releases[0].status, 'callable');
  const other = store.projectOrganization({
    organizationAuthorizer: authorizer('org_other'), sourceStatusResolver: () => null, now: () => LATER,
  });
  assert.equal(other.summary.products, 0);
  const publicProjection = store.projectPublic();
  assert.deepEqual(publicProjection.summary, {
    organizations: 1, products: 1, releases: 1, selfAuthored: 1, authorizedDerivatives: 0,
  });
  const serialized = JSON.stringify(publicProjection).toLowerCase();
  for (const forbidden of ['organizationid', 'titlezh', 'package', 'lineage', 'member', 'skillid', 'privprod_', 'privrel_']) {
    assert.equal(serialized.includes(forbidden), false);
  }
});

test('every mutation response is scoped to its object and never leaks another tenant projection', () => {
  const store = new PrivateAbilityStore(path.join(directory(), 'private-abilities.json'));
  const otherOrganizationId = 'org_bravo';
  let other = store.createProduct({
    organizationId: otherOrganizationId, skillId: 'bravo/secret', productKey: 'secret',
    titleZh: '租户乙隐私标题', summaryZh: '只属于租户乙的私有能力。', sourceType: 'self_authored',
    creationEvidenceRef: 'self:bravo-secret',
  }, {
    expectedRevision: store.status().revision, organizationAuthorizer: authorizer(otherOrganizationId),
    creationEvidenceResolver: context => ({
      decision: 'allow', organizationId: otherOrganizationId, sourceType: 'self_authored',
      evidenceRef: context.creationEvidenceRef, evidenceDigest: D('8'),
    }),
    now: () => AT,
  });
  const otherProduct = other.product;
  const otherPackage = artifact('1.0.0', '# bravo private');
  other = store.createRelease({
    organizationId: otherOrganizationId, privateProductId: otherProduct.privateProductId, version: '1.0.0',
    packageDigest: otherPackage.packageDigest, previousPrivateReleaseId: null,
  }, {
    expectedRevision: other.revision, organizationAuthorizer: authorizer(otherOrganizationId),
    packageResolver: () => otherPackage, now: () => AT,
  });
  const otherRelease = other.release;
  other = store.assessEvidence({ organizationId: otherOrganizationId, privateReleaseId: otherRelease.privateReleaseId }, {
    expectedRevision: other.revision, organizationAuthorizer: authorizer(otherOrganizationId),
    evidenceResolver: () => {
      const binding = {
        basedOnPackageDigest: otherRelease.packageDigest,
        basedOnManifestDigest: otherRelease.packageManifestDigest,
        validUntil: FUTURE,
      };
      return {
        packageAudit: { status: 'pass', evidenceDigest: D('9'), ...binding },
        sms: { status: 'pass', evidenceDigest: D('7'), ...binding },
        eval: { status: 'pass', evidenceDigest: D('6'), ...binding },
        review: { status: 'certified', evidenceDigest: D('5'), ...binding },
      };
    },
    now: () => AT,
  });

  const productResult = store.createProduct({
    organizationId: ORG, skillId: 'acme/isolated', productKey: 'isolated', titleZh: '租户甲能力',
    summaryZh: '验证 mutation 返回隔离。', sourceType: 'self_authored', creationEvidenceRef: 'self:isolated',
  }, {
    expectedRevision: other.revision, organizationAuthorizer: authorizer(), creationEvidenceResolver, now: () => LATER,
  });
  const ownPackage = artifact('1.0.0', '# acme isolated');
  const releaseResult = store.createRelease({
    organizationId: ORG, privateProductId: productResult.product.privateProductId, version: '1.0.0',
    packageDigest: ownPackage.packageDigest, previousPrivateReleaseId: null,
  }, {
    expectedRevision: productResult.revision, organizationAuthorizer: authorizer(),
    packageResolver: () => ownPackage, now: () => LATER,
  });
  const evidenceResult = store.assessEvidence({ organizationId: ORG, privateReleaseId: releaseResult.release.privateReleaseId }, {
    expectedRevision: releaseResult.revision, organizationAuthorizer: authorizer(),
    evidenceResolver: () => evidenceResolver(releaseResult.release), now: () => LATER,
  });

  const forbidden = [
    otherOrganizationId, otherProduct.privateProductId, otherRelease.privateReleaseId,
    otherProduct.titleZh, otherRelease.packageDigest, D('9'),
  ];
  for (const result of [productResult, releaseResult, evidenceResult]) {
    assert.equal(Object.hasOwn(result, 'projection'), false);
    assert.equal(Object.hasOwn(result, 'event'), false);
    const serialized = JSON.stringify(result);
    for (const secret of forbidden) assert.equal(serialized.includes(secret), false);
  }
});

test('CAS conflicts, immutable version conflicts and injected failure do not alter committed state', () => {
  const file = path.join(directory(), 'private-abilities.json');
  const store = new PrivateAbilityStore(file);
  const first = store.createProduct({
    organizationId: ORG, skillId: 'acme/private-search', productKey: 'private-search',
    titleZh: '内部检索', summaryZh: '组织内部检索能力。', sourceType: 'self_authored', creationEvidenceRef: 'self:private-search',
  }, { expectedRevision: store.status().revision, organizationAuthorizer: authorizer(), creationEvidenceResolver, now: () => AT });
  assert.throws(() => store.createRelease({
    organizationId: ORG, privateProductId: first.product.privateProductId, version: '1.0.0',
    packageDigest: artifact().packageDigest, previousPrivateReleaseId: null,
  }, { expectedRevision: 'sha256:wrong', organizationAuthorizer: authorizer(), packageResolver: () => artifact(), now: () => AT }), error => error.code === 'REVISION_CONFLICT');
  assert.equal(store.status().eventCount, 1);
  const bytes = fs.readFileSync(file);
  const faulty = new PrivateAbilityStore(file, { faultInjector: stage => { if (stage === 'beforeRename') throw new Error('fixture failure'); } });
  assert.throws(() => faulty.createRelease({
    organizationId: ORG, privateProductId: first.product.privateProductId, version: '1.0.0',
    packageDigest: artifact().packageDigest, previousPrivateReleaseId: null,
  }, { expectedRevision: first.revision, organizationAuthorizer: authorizer(), packageResolver: () => artifact(), now: () => AT }), /fixture failure/);
  assert.deepEqual(fs.readFileSync(file), bytes);
});

test('same private version cannot be overwritten and cross-tenant Release creation is rejected', () => {
  const file = path.join(directory(), 'private-abilities.json');
  const store = new PrivateAbilityStore(file);
  let state = store.createProduct({
    organizationId: ORG, skillId: 'acme/versioned', productKey: 'versioned', titleZh: '版本能力',
    summaryZh: '验证不可变版本。', sourceType: 'self_authored', creationEvidenceRef: 'self:versioned',
  }, { expectedRevision: store.status().revision, organizationAuthorizer: authorizer(), creationEvidenceResolver, now: () => AT });
  const product = state.product;
  const firstPackage = artifact('1.0.0', '# one');
  state = store.createRelease({
    organizationId: ORG, privateProductId: product.privateProductId, version: '1.0.0',
    packageDigest: firstPackage.packageDigest, previousPrivateReleaseId: null,
  }, { expectedRevision: state.revision, organizationAuthorizer: authorizer(), packageResolver: () => firstPackage, now: () => AT });
  const bytes = fs.readFileSync(file);
  const secondPackage = artifact('1.0.0', '# different');
  assert.throws(() => store.createRelease({
    organizationId: ORG, privateProductId: product.privateProductId, version: '1.0.0',
    packageDigest: secondPackage.packageDigest, previousPrivateReleaseId: state.release.privateReleaseId,
  }, { expectedRevision: state.revision, organizationAuthorizer: authorizer(), packageResolver: () => secondPackage, now: () => LATER }), error => error.code === 'PRIVATE_VERSION_IMMUTABLE');
  assert.deepEqual(fs.readFileSync(file), bytes);
  assert.throws(() => store.createRelease({
    organizationId: 'org_other', privateProductId: product.privateProductId, version: '2.0.0',
    packageDigest: secondPackage.packageDigest, previousPrivateReleaseId: state.release.privateReleaseId,
  }, { expectedRevision: state.revision, organizationAuthorizer: authorizer('org_other'), packageResolver: () => secondPackage, now: () => LATER }), error => error.code === 'PRIVATE_PRODUCT_ORGANIZATION_MISMATCH');
  assert.deepEqual(fs.readFileSync(file), bytes);
});

test('organization resolver cannot cross tenant and source recall/revoke remains blocked', () => {
  const store = new PrivateAbilityStore(path.join(directory(), 'private-abilities.json'));
  const state = createAll(store);
  const resolver = store.createOrganizationResolver({ organizationAuthorizer: authorizer() });
  assert.equal(resolver.resolvePrivateProduct(state.product.privateProductId).organizationId, ORG);
  assert.equal(resolver.resolvePrivateRelease(state.release.privateReleaseId).organizationId, ORG);
  const other = store.createOrganizationResolver({ organizationAuthorizer: authorizer('org_other') });
  assert.equal(other.resolvePrivateProduct(state.product.privateProductId), null);
  assert.equal(other.resolvePrivateRelease(state.release.privateReleaseId), null);
  let authorized = true;
  const revocable = store.createOrganizationResolver({
    organizationAuthorizer: () => ({ decision: authorized ? 'allow' : 'deny', organizationId: ORG }),
  });
  authorized = false;
  assert.throws(() => revocable.resolvePrivateProduct(state.product.privateProductId), error => error.code === 'ORGANIZATION_FORBIDDEN');
});

test('existing derivative remains usable after withdrawal while recall, revoke and expiry are sticky blocks', () => {
  const store = new PrivateAbilityStore(path.join(directory(), 'private-abilities.json'));
  let state = store.createProduct({
    organizationId: ORG, skillId: 'upstream/writer', productKey: 'enterprise-writer',
    titleZh: '企业写作', summaryZh: '授权二创的组织内部写作能力。', sourceType: 'authorized_derivative',
    creationEvidenceRef: `lineage_${'7'.repeat(64)}`,
  }, {
    expectedRevision: store.status().revision, organizationAuthorizer: authorizer(),
    creationEvidenceResolver: context => derivativeEvidence(context), now: () => AT,
  });
  const product = state.product;
  const packageArtifact = artifact();
  state = store.createRelease({
    organizationId: ORG, privateProductId: product.privateProductId, version: '1.0.0',
    packageDigest: packageArtifact.packageDigest, previousPrivateReleaseId: null,
  }, {
    expectedRevision: state.revision, organizationAuthorizer: authorizer(), packageResolver: () => packageArtifact,
    sourceStatusResolver: context => derivativeEvidence({ ...context, evidenceRef: context.sourceEvidence.evidenceRef }), now: () => AT,
  });
  const release = state.release;
  state = store.assessEvidence({ organizationId: ORG, privateReleaseId: release.privateReleaseId }, {
    expectedRevision: state.revision, organizationAuthorizer: authorizer(), evidenceResolver: () => evidenceResolver(release), now: () => LATER,
  });
  const project = overrides => store.projectOrganization({
    organizationAuthorizer: authorizer(),
    sourceStatusResolver: context => derivativeEvidence({ ...context, evidenceRef: context.sourceEvidence.evidenceRef }, overrides),
    now: () => LATER,
  });
  assert.equal(project({ publicationStatus: 'withdrawn' }).products[0].releases[0].status, 'callable');
  assert.equal(project({ publicationStatus: 'recalled' }).products[0].releases[0].status, 'blocked');
  assert.equal(project({ entitlementStatus: 'revoked' }).products[0].releases[0].status, 'blocked');
  assert.equal(project({ validUntil: AT }).products[0].releases[0].status, 'blocked');
});

test('nested symlink and malformed store fail closed without outside writes', t => {
  if (process.platform === 'win32') return t.skip('symlink fixture is POSIX-specific');
  const root = directory();
  const outside = directory();
  fs.symlinkSync(outside, path.join(root, 'state'));
  assert.throws(() => new PrivateAbilityStore(path.join(root, 'state', 'private.json')), error => error.code === 'UNSAFE_STORE_PATH');
  assert.deepEqual(fs.readdirSync(outside), []);

  const file = path.join(directory(), 'private.json');
  const store = new PrivateAbilityStore(file);
  store.createProduct({
    organizationId: ORG, skillId: 'acme/tamper', productKey: 'tamper', titleZh: '防篡改',
    summaryZh: '验证持久事件摘要。', sourceType: 'self_authored', creationEvidenceRef: 'self:tamper',
  }, { expectedRevision: store.status().revision, organizationAuthorizer: authorizer(), creationEvidenceResolver, now: () => AT });
  const persisted = JSON.parse(fs.readFileSync(file, 'utf8'));
  persisted.events[0].payload.product.titleZh = '被篡改';
  fs.writeFileSync(file, JSON.stringify(persisted));
  assert.throws(() => store.status(), error => ['INVALID_EVENT_PAYLOAD', 'EVENT_ID_MISMATCH'].includes(error.code));
});

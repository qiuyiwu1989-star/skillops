import assert from 'node:assert/strict';
import test from 'node:test';

import { createPackageArtifact } from '../lib/package.mjs';
import {
  assessPrivateReleaseEvidence,
  calculatePrivateProductId,
  createPrivateProduct,
  createPrivateRelease,
  normalizePrivateProduct,
  normalizePrivateRelease,
  normalizePrivateReleaseEvidence,
} from '../lib/enterprise/private-ability.mjs';

const AT = '2026-08-14T00:00:00.000Z';
const FUTURE = '2026-09-14T00:00:00.000Z';
const ORG = 'org_acme';
const BASE_PRODUCT = `prod_${'a'.repeat(64)}`;
const BASE_RELEASE = `rel_${'b'.repeat(64)}`;
const ENTITLEMENT = `ent_${'c'.repeat(64)}`;
const D = char => `sha256:${char.repeat(64)}`;

function authorize(organizationId = ORG) {
  return context => ({ decision: 'allow', organizationId, purpose: context.purpose });
}

function artifact(version = '1.0.0', text = '# Private ability') {
  return createPackageArtifact({
    files: [{ path: 'SKILL.md', content: text }],
    sourceVersion: version,
    collectedAt: AT,
  });
}

function sourceEvidence(overrides = {}) {
  const privateProductId = calculatePrivateProductId({
    organizationId: ORG, skillId: 'upstream/writer', productKey: 'internal-writer',
  });
  return {
    decision: 'allow',
    organizationId: ORG,
    privateProductId,
    sourceType: 'authorized_derivative',
    evidenceRef: `lineage_${'d'.repeat(64)}`,
    evidenceDigest: D('d'),
    baseProductId: BASE_PRODUCT,
    baseReleaseId: BASE_RELEASE,
    entitlementId: ENTITLEMENT,
    entitlementDigest: D('e'),
    licenseSnapshotDigest: D('f'),
    lineageDigest: D('1'),
    rights: ['derive', 'internal_distribute'],
    validUntil: FUTURE,
    publicationStatus: 'published',
    entitlementStatus: 'active',
    ...overrides,
  };
}

function selfProduct(overrides = {}) {
  return createPrivateProduct({
    organizationId: ORG,
    skillId: 'acme/knowledge-search',
    productKey: 'knowledge-search',
    titleZh: '企业知识检索',
    summaryZh: '仅供本组织内部使用的知识检索能力。',
    sourceType: 'self_authored',
    creationEvidenceRef: 'org-authoring:knowledge-search',
    ...overrides,
  }, {
    organizationAuthorizer: authorize(),
    creationEvidenceResolver: context => ({
      decision: 'allow', organizationId: ORG, sourceType: 'self_authored',
      evidenceRef: context.creationEvidenceRef, evidenceDigest: D('2'),
    }),
    now: () => AT,
  });
}

function derivativeProduct(overrides = {}, resolverOverrides = {}) {
  return createPrivateProduct({
    organizationId: ORG,
    skillId: 'upstream/writer',
    productKey: 'internal-writer',
    titleZh: '企业公文助手',
    summaryZh: '基于已授权能力形成的企业内部版本。',
    sourceType: 'authorized_derivative',
    creationEvidenceRef: `lineage_${'d'.repeat(64)}`,
    ...overrides,
  }, {
    organizationAuthorizer: authorize(),
    creationEvidenceResolver: () => sourceEvidence(resolverOverrides),
    now: () => AT,
  });
}

function release(product = selfProduct(), packageArtifact = artifact(), overrides = {}, trust = {}) {
  return createPrivateRelease({
    organizationId: ORG,
    privateProductId: product.privateProductId,
    version: '1.0.0',
    packageDigest: packageArtifact.packageDigest,
    previousPrivateReleaseId: null,
    ...overrides,
  }, {
    organizationAuthorizer: authorize(),
    privateProductResolver: id => id === product.privateProductId ? product : null,
    packageResolver: digest => digest === packageArtifact.packageDigest ? packageArtifact : null,
    sourceStatusResolver: () => sourceEvidence(),
    now: () => AT,
    ...trust,
  });
}

function evidenceResolver(releaseValue, overrides = {}) {
  const binding = {
    basedOnPackageDigest: releaseValue.packageDigest,
    basedOnManifestDigest: releaseValue.packageManifestDigest,
    validUntil: FUTURE,
  };
  return () => ({
    packageAudit: { status: 'pass', evidenceDigest: D('3'), ...binding },
    sms: { status: 'pass', evidenceDigest: D('4'), ...binding },
    eval: { status: 'pass', evidenceDigest: D('5'), ...binding },
    review: { status: 'certified', evidenceDigest: D('6'), ...binding },
    ...overrides,
  });
}

test('self-authored private Product and immutable Release use stable private identities without package content', () => {
  const product = selfProduct();
  assert.equal(product.privateProductId, calculatePrivateProductId({
    organizationId: ORG, skillId: product.skillId, productKey: product.productKey,
  }));
  assert.equal(product.visibility, 'organization_private');
  assert.equal(product.privateProductId.startsWith('privprod_'), true);
  assert.deepEqual(normalizePrivateProduct(product), product);
  const packageArtifact = artifact();
  const created = release(product, packageArtifact);
  assert.equal(created.privateReleaseId.startsWith('privrel_'), true);
  assert.equal(created.status, 'evidence_pending');
  assert.equal(created.packageDigest, packageArtifact.packageDigest);
  assert.equal('manifest' in created, false);
  assert.equal('storageRef' in created, false);
  assert.deepEqual(normalizePrivateRelease(created), created);
  const repeated = release(product, packageArtifact);
  assert.equal(repeated.privateReleaseId, created.privateReleaseId);
  assert.equal(repeated.releaseDigest, created.releaseDigest);
});

test('authorized derivative requires trusted current derive and internal-distribute rights', () => {
  const product = derivativeProduct();
  assert.equal(product.sourceType, 'authorized_derivative');
  assert.equal(product.sourceEvidence.baseReleaseId, BASE_RELEASE);
  assert.deepEqual(product.sourceEvidence.rights, ['derive', 'internal_distribute']);
  for (const rights of [[], ['derive'], ['internal_distribute']]) {
    assert.throws(() => derivativeProduct({}, { rights }), error => error.code === 'DERIVATIVE_RIGHTS_REQUIRED');
  }
  assert.throws(() => derivativeProduct({}, { validUntil: AT }), error => error.code === 'SOURCE_ENTITLEMENT_EXPIRED');
  assert.throws(() => derivativeProduct({}, { organizationId: 'org_other' }), error => error.code === 'SOURCE_ORGANIZATION_MISMATCH');
  assert.throws(() => derivativeProduct({}, { publicationStatus: 'recalled' }), error => error.code === 'SOURCE_RELEASE_BLOCKED');
  assert.throws(() => derivativeProduct({}, { entitlementStatus: 'revoked' }), error => error.code === 'SOURCE_ENTITLEMENT_BLOCKED');
});

test('new derivative Release rejects withdrawn, recalled, revoked and forged source status', () => {
  const product = derivativeProduct();
  const packageArtifact = artifact();
  for (const publicationStatus of ['withdrawn', 'recalled', 'revoked']) {
    assert.throws(() => release(product, packageArtifact, {}, {
      sourceStatusResolver: () => sourceEvidence({ publicationStatus }),
    }), error => ['SOURCE_WITHDRAWN_FOR_NEW_RELEASE', 'SOURCE_RELEASE_BLOCKED'].includes(error.code));
  }
  assert.throws(() => release(product, packageArtifact, {}, {
    sourceStatusResolver: () => sourceEvidence({ entitlementId: `ent_${'f'.repeat(64)}` }),
  }), error => error.code === 'SOURCE_EVIDENCE_MISMATCH');
  assert.throws(() => release(product, packageArtifact, {}, {
    sourceStatusResolver: () => sourceEvidence({ rights: ['derive'] }),
  }), error => error.code === 'DERIVATIVE_RIGHTS_REQUIRED');
});

test('evidence assessment only becomes callable when all trusted evidence is current and package-bound', () => {
  const created = release();
  const assessed = assessPrivateReleaseEvidence({ organizationId: ORG, privateReleaseId: created.privateReleaseId }, {
    organizationAuthorizer: authorize(),
    privateReleaseResolver: id => id === created.privateReleaseId ? created : null,
    evidenceResolver: evidenceResolver(created),
    now: () => AT,
  });
  assert.equal(assessed.status, 'callable');
  assert.deepEqual(assessed.gaps, []);
  assert.deepEqual(normalizePrivateReleaseEvidence(assessed), assessed);
  const pending = assessPrivateReleaseEvidence({ organizationId: ORG, privateReleaseId: created.privateReleaseId }, {
    organizationAuthorizer: authorize(),
    privateReleaseResolver: () => created,
    evidenceResolver: evidenceResolver(created, { eval: null }),
    now: () => AT,
  });
  assert.equal(pending.status, 'evidence_pending');
  assert.deepEqual(pending.gaps, ['eval_missing']);
  const noValidity = assessPrivateReleaseEvidence({ organizationId: ORG, privateReleaseId: created.privateReleaseId }, {
    organizationAuthorizer: authorize(), privateReleaseResolver: () => created,
    evidenceResolver: evidenceResolver(created, {
      sms: { status: 'pass', evidenceDigest: D('4'), basedOnPackageDigest: created.packageDigest, basedOnManifestDigest: created.packageManifestDigest, validUntil: null },
    }), now: () => AT,
  });
  assert.equal(noValidity.status, 'evidence_pending');
  assert.deepEqual(noValidity.gaps, ['sms_validity_missing']);
  assert.throws(() => assessPrivateReleaseEvidence({ organizationId: ORG, privateReleaseId: created.privateReleaseId }, {
    organizationAuthorizer: authorize(),
    privateReleaseResolver: () => created,
    evidenceResolver: evidenceResolver(created, {
      review: { status: 'certified', evidenceDigest: D('6'), basedOnPackageDigest: D('0'), basedOnManifestDigest: created.packageManifestDigest, validUntil: FUTURE },
    }),
    now: () => AT,
  }), error => error.code === 'EVIDENCE_BINDING_MISMATCH');
});

test('organization scope, trusted package resolver and private-field boundaries fail closed', () => {
  assert.throws(() => selfProduct({ organizationId: 'org_other' }), error => error.code === 'ORGANIZATION_SCOPE_MISMATCH');
  const product = selfProduct();
  const packageArtifact = artifact();
  assert.throws(() => createPrivateRelease({
    organizationId: ORG, privateProductId: product.privateProductId, version: '1.0.0',
    packageDigest: packageArtifact.packageDigest, previousPrivateReleaseId: null,
  }, {
    organizationAuthorizer: authorize(), privateProductResolver: () => product,
    packageResolver: () => ({ ...packageArtifact, packageDigest: D('0') }), now: () => AT,
  }), error => error.code === 'PACKAGE_REJECTED');
  assert.throws(() => createPrivateProduct({
    organizationId: ORG, skillId: 'acme/leak', productKey: 'leak', titleZh: '泄漏', summaryZh: 'test',
    sourceType: 'self_authored', creationEvidenceRef: 'self:leak', content: '# body',
  }, {}), error => error.code === 'UNKNOWN_FIELD');
});

test('private Product rejects absolute paths after punctuation without rejecting relative ability identifiers', () => {
  for (const summaryZh of [
    '位置:/etc/passwd',
    '位置:/opt/company/secret',
    '位置:C:\\Users\\alice\\secret',
    '位置:\\\\server\\share\\secret',
    '位置:file:///srv/company/secret',
  ]) {
    assert.throws(() => selfProduct({ summaryZh }), error => error.code === 'PRIVATE_VALUE');
  }
  const product = selfProduct({
    summaryZh: '调用 market/foo、skills/finance/report 与 docs/v1 等相对能力标识。',
  });
  assert.equal(product.summaryZh.includes('market/foo'), true);
});

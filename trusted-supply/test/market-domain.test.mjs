import assert from 'node:assert/strict';
import test from 'node:test';

import { createFixtureIdpVerifier } from '../lib/idp-receipt.mjs';
import {
  MarketDomainError,
  assertApplicationBomAuthorized,
  createAbilityProduct,
  createApplicationProduct,
  createApplicationRelease,
  createPublisher,
  createSkillProduct,
  toPublicMarketValue,
} from '../lib/market/domain.mjs';
import { canonicalDigest, normalizeRelease, releaseId, sourceId } from '../lib/registry-identity.mjs';

const AT = '2026-08-14T01:00:00.000Z';
const EXPIRES = '2026-08-14T01:15:00.000Z';
const IDP_KEY = Buffer.alloc(32, 43);
const D = char => `sha256:${char.repeat(64)}`;

function verifier() {
  return createFixtureIdpVerifier({
    provider: 'fixture-market-idp',
    purpose: 'market-publisher',
    receiptKey: IDP_KEY,
    clock: () => new Date(AT),
    assertionVerifier: async assertion => ({
      subject: assertion.fixtureToken === 'alice' ? 'creator-alice' : 'creator-company',
      kind: assertion.fixtureToken === 'alice' ? 'human' : 'service',
    }),
  });
}

async function publisher(kind = 'organization') {
  const provider = verifier();
  const receipt = await provider.issueReceipt({ fixtureToken: kind === 'individual' ? 'alice' : 'company' });
  return createPublisher({
    kind,
    displayName: kind === 'individual' ? '独立创作者' : '造物云能力团队',
    identityReceipt: receipt,
    createdAt: AT,
  }, {
    trustedProviderVerifiers: [provider],
    purpose: 'market-publisher',
    now: AT,
  });
}

function registryRelease({ skillId = 'zaowuyun/research-synthesis', version = '1.0.0', char = '1' } = {}) {
  const packageDigest = D(char);
  const source = sourceId({ type: 'fixture', coordinate: `fixture:${skillId}:${version}` });
  return normalizeRelease({
    schemaVersion: 1,
    releaseId: releaseId({ skillId, version, packageDigest }),
    skillId,
    version,
    status: 'published',
    package: { packageDigest, manifestDigest: D(char === 'f' ? 'e' : 'f'), storageRef: `cas:${packageDigest}` },
    compatibility: { contract: 'skillops.skill.v1', targets: ['node'] },
    assessmentRefs: [`assessment:${char}`],
    reviewRefs: [`review:${char}`],
    sourceRefs: [source],
    publishedAt: AT,
  });
}

function parties(publisherId) {
  return {
    creatorPublisherIds: [publisherId],
    rightsHolderPublisherId: publisherId,
    payeePublisherId: null,
    supportPublisherId: publisherId,
  };
}

function productInput(publisherId, productKey = 'research-synthesis') {
  return {
    publisherId,
    productKey,
    titleZh: '研究综述技能',
    summaryZh: '整理多份资料并形成可追溯的中文研究综述。',
    parties: parties(publisherId),
    createdAt: AT,
  };
}

test('publisher has a stable pseudonymous identity while creator, rights holder, payee and support stay separate', async () => {
  const first = await publisher();
  const second = await publisher();
  assert.equal(first.publisherId, second.publisherId);
  assert.match(first.publisherId, /^pub_[a-f0-9]{64}$/);
  assert.equal(first.identityEvidence.subjectDigest.startsWith('sha256:'), true);
  const serialized = JSON.stringify(first);
  for (const hidden of ['creator-company', 'company', 'email', 'token', 'password']) assert.equal(serialized.includes(hidden), false);

  const publicPublisher = toPublicMarketValue(first);
  assert.equal(Object.hasOwn(publicPublisher, 'identityEvidence'), false);
  assert.equal(Object.hasOwn(publicPublisher.verification, 'subjectDigest'), false);
  assert.equal(Object.hasOwn(publicPublisher.verification, 'receiptDigest'), false);
});

test('publisher rejects untrusted receipts, unknown fields, candidate values, paths and sensitive strings', async () => {
  const provider = verifier();
  const receipt = await provider.issueReceipt({ fixtureToken: 'company' });
  const base = { kind: 'organization', displayName: '合法主体', identityReceipt: receipt, createdAt: AT };
  assert.throws(() => createPublisher({ ...base, extra: true }, {
    trustedProviderVerifiers: [provider], purpose: 'market-publisher', now: AT,
  }), error => error.code === 'UNKNOWN_FIELD');
  for (const displayName of ['cand_secret', '/Users/qiu/secret', 'password=abcd1234']) {
    assert.throws(() => createPublisher({ ...base, displayName }, {
      trustedProviderVerifiers: [provider], purpose: 'market-publisher', now: AT,
    }), error => error.code === 'PRIVATE_VALUE');
  }
  assert.throws(() => createPublisher(base, {
    trustedProviderVerifiers: [], purpose: 'market-publisher', now: AT,
  }), error => error.code === 'IDENTITY_RECEIPT_REJECTED');
  assert.throws(() => createPublisher({ ...base, kind: 'individual' }, {
    trustedProviderVerifiers: [provider], purpose: 'market-publisher', now: AT,
  }), error => error.code === 'PUBLISHER_KIND_MISMATCH');
});

test('Skill Product binds a revalidated canonical Registry Release and remains distinct from Application Product', async () => {
  const owner = await publisher();
  const release = registryRelease();
  const skill = createSkillProduct({
    ...productInput(owner.publisherId), skillId: release.skillId, releaseId: release.releaseId,
  }, { registryRelease: release });
  const application = createApplicationProduct({
    ...productInput(owner.publisherId, 'research-workbench'),
    titleZh: '研究工作应用', summaryZh: '调用多个技能完成研究任务。',
  });

  assert.equal(skill.abilityType, 'skill');
  assert.match(skill.productId, /^prod_[a-f0-9]{64}$/);
  assert.equal(skill.releaseId, release.releaseId);
  assert.equal(application.abilityType, 'application');
  assert.match(application.applicationId, /^app_[a-f0-9]{64}$/);
  assert.equal(Object.hasOwn(application, 'skillId'), false);
  assert.equal(Object.hasOwn(application, 'releaseId'), false);
  assert.notEqual(skill.productId, application.productId);
  assert.equal(Object.isFrozen(skill.parties.creatorPublisherIds), true);

  const generic = createAbilityProduct({
    abilityType: 'skill', ...productInput(owner.publisherId), skillId: release.skillId, releaseId: release.releaseId,
  }, { registryRelease: release });
  assert.deepEqual(generic, skill);
});

test('product ID depends on stable productKey rather than mutable Chinese metadata', async () => {
  const owner = await publisher();
  const release = registryRelease();
  const first = createSkillProduct({ ...productInput(owner.publisherId), skillId: release.skillId, releaseId: release.releaseId }, { registryRelease: release });
  const renamed = createSkillProduct({
    ...productInput(owner.publisherId), titleZh: '升级后的中文标题', summaryZh: '新的公开说明。',
    skillId: release.skillId, releaseId: release.releaseId,
  }, { registryRelease: release });
  assert.equal(first.productId, renamed.productId);
  assert.notEqual(first.productDigest, renamed.productDigest);
});

test('Skill Product fails closed for cand_* and forged or mismatched Registry identities', async () => {
  const owner = await publisher();
  const release = registryRelease();
  assert.throws(() => createSkillProduct({
    ...productInput(owner.publisherId), skillId: 'cand_secret/value', releaseId: release.releaseId,
  }, { registryRelease: release }), error => error.code === 'CANDIDATE_ID_FORBIDDEN');
  assert.throws(() => createSkillProduct({
    ...productInput(owner.publisherId), skillId: release.skillId, releaseId: `rel_${'0'.repeat(64)}`,
  }, { registryRelease: release }), error => error.code === 'REGISTRY_BINDING_MISMATCH');
  assert.throws(() => createSkillProduct({
    ...productInput(owner.publisherId), skillId: release.skillId, releaseId: release.releaseId,
  }, { registryRelease: { ...release, version: '2.0.0' } }), error => error.code === 'REGISTRY_RELEASE_REJECTED');
  assert.throws(() => createSkillProduct({
    ...productInput(owner.publisherId), skillId: release.skillId, releaseId: release.releaseId, metadata: {},
  }, { registryRelease: release }), error => error.code === 'UNKNOWN_FIELD');
});

test('Application Release fixes a canonical dependency BOM and rejects unknown, duplicate or unresolved dependencies', async () => {
  const owner = await publisher();
  const release = registryRelease();
  const skill = createSkillProduct({ ...productInput(owner.publisherId), skillId: release.skillId, releaseId: release.releaseId }, { registryRelease: release });
  const application = createApplicationProduct({
    ...productInput(owner.publisherId, 'research-workbench'), titleZh: '研究工作应用', summaryZh: '组合技能完成任务。',
  });
  const dependency = {
    productId: skill.productId,
    skillId: release.skillId,
    releaseId: release.releaseId,
    requirement: 'required',
    requiredRights: ['organization_use', 'invoke'],
  };
  const resolveRegistryRelease = identity => identity.releaseId === release.releaseId ? release : null;
  const resolveSkillProduct = identity => identity.productId === skill.productId ? skill : null;
  const appRelease = createApplicationRelease({
    applicationId: application.applicationId,
    productId: application.productId,
    version: '1.0.0',
    bom: [dependency],
    publishedAt: AT,
  }, { applicationProduct: application, resolveRegistryRelease, resolveSkillProduct });

  assert.match(appRelease.applicationReleaseId, /^apprel_[a-f0-9]{64}$/);
  assert.equal(appRelease.bom[0].releaseId, release.releaseId);
  assert.deepEqual(appRelease.bom[0].requiredRights, ['invoke', 'organization_use']);
  assert.equal(Object.isFrozen(appRelease.bom), true);

  assert.throws(() => createApplicationRelease({
    applicationId: application.applicationId, productId: application.productId, version: '1.0.0', bom: [{ ...dependency, extra: true }], publishedAt: AT,
  }, { applicationProduct: application, resolveRegistryRelease, resolveSkillProduct }), error => error.code === 'UNKNOWN_FIELD');
  assert.throws(() => createApplicationRelease({
    applicationId: application.applicationId, productId: application.productId, version: '1.0.0', bom: [dependency, dependency], publishedAt: AT,
  }, { applicationProduct: application, resolveRegistryRelease, resolveSkillProduct }), error => error.code === 'DUPLICATE_BOM_DEPENDENCY');
  assert.throws(() => createApplicationRelease({
    applicationId: application.applicationId, productId: application.productId, version: '1.0.0', bom: [dependency], publishedAt: AT,
  }, { applicationProduct: application, resolveRegistryRelease: () => null, resolveSkillProduct }), error => error.code === 'BOM_RELEASE_NOT_FOUND');
  assert.throws(() => createApplicationRelease({
    applicationId: application.applicationId, productId: `prod_${'1'.repeat(64)}`, version: '1.0.0', bom: [dependency], publishedAt: AT,
  }, { applicationProduct: application, resolveRegistryRelease, resolveSkillProduct }), error => error.code === 'APPLICATION_BINDING_MISMATCH');
  assert.throws(() => createApplicationRelease({
    applicationId: application.applicationId, productId: application.productId, version: '1.0.0', bom: [dependency], publishedAt: AT,
  }, { applicationProduct: application, resolveRegistryRelease, resolveSkillProduct: () => ({ ...skill, releaseId: `rel_${'f'.repeat(64)}` }) }), error => error.code === 'BOM_PRODUCT_RESOLUTION_FAILED');
});

test('BOM authorization fails closed for required skills and only omits denied optional skills', async () => {
  const owner = await publisher();
  const firstRelease = registryRelease();
  const secondRelease = registryRelease({ skillId: 'zaowuyun/source-reader', char: '2' });
  const firstProduct = createSkillProduct({ ...productInput(owner.publisherId), skillId: firstRelease.skillId, releaseId: firstRelease.releaseId }, { registryRelease: firstRelease });
  const secondProduct = createSkillProduct({ ...productInput(owner.publisherId, 'source-reader'), skillId: secondRelease.skillId, releaseId: secondRelease.releaseId }, { registryRelease: secondRelease });
  const application = createApplicationProduct({ ...productInput(owner.publisherId, 'research-workbench'), titleZh: '研究应用' });
  const bom = [
    { productId: firstProduct.productId, skillId: firstRelease.skillId, releaseId: firstRelease.releaseId, requirement: 'required', requiredRights: ['invoke'] },
    { productId: secondProduct.productId, skillId: secondRelease.skillId, releaseId: secondRelease.releaseId, requirement: 'optional', requiredRights: ['invoke'] },
  ];
  const appRelease = createApplicationRelease({
    applicationId: application.applicationId, productId: application.productId, version: '1.0.0', bom, publishedAt: AT,
  }, {
    applicationProduct: application,
    resolveRegistryRelease: identity => identity.releaseId === firstRelease.releaseId ? firstRelease : secondRelease,
    resolveSkillProduct: identity => identity.productId === firstProduct.productId ? firstProduct : secondProduct,
  });
  const decision = (dependency, allow) => ({
    schemaVersion: 1,
    decision: allow ? 'allow' : 'deny',
    code: allow ? 'ACCESS_ALLOWED' : 'NO_ENTITLEMENT',
    entitlementId: allow ? `ent_${'a'.repeat(64)}` : null,
    organizationId: 'org_demo',
    productId: dependency.productId,
    releaseId: dependency.releaseId,
    grantedRights: allow ? dependency.requiredRights : [],
    checkedAt: AT,
  });
  const report = assertApplicationBomAuthorized(appRelease, {
    authorizeDependency: dependency => decision(dependency, dependency.requirement === 'required'),
    organizationId: 'org_demo', checkedAt: AT,
  });
  assert.equal(report.authorizedDependencies.length, 1);
  assert.equal(report.omittedOptionalDependencies.length, 1);

  assert.throws(() => assertApplicationBomAuthorized(appRelease, {
    authorizeDependency: dependency => decision(dependency, false),
    organizationId: 'org_demo', checkedAt: AT,
  }), error => error.code === 'BOM_DEPENDENCY_UNAUTHORIZED');
  assert.throws(() => assertApplicationBomAuthorized(appRelease, {
    authorizeDependency: dependency => ({ ...decision(dependency, true), releaseId: `rel_${'f'.repeat(64)}` }),
    organizationId: 'org_demo', checkedAt: AT,
  }), error => error.code === 'ACCESS_DECISION_BINDING_MISMATCH');
  assert.throws(() => assertApplicationBomAuthorized({ ...appRelease, extra: true }, {
    authorizeDependency: dependency => decision(dependency, true),
    organizationId: 'org_demo', checkedAt: AT,
  }), error => error.code === 'UNKNOWN_FIELD');
  assert.throws(() => assertApplicationBomAuthorized(appRelease, {
    authorizeDependency: dependency => ({ ...decision(dependency, true), entitlementId: null }),
    organizationId: 'org_demo', checkedAt: AT,
  }), error => error.code === 'INVALID_ACCESS_DECISION');
  assert.throws(() => assertApplicationBomAuthorized(appRelease, {
    authorizeDependency: dependency => decision(dependency, true),
  }), error => error.code === 'ACCESS_CONTEXT_REQUIRED');
});

test('public helper validates digests instead of hiding invalid production input', async () => {
  const owner = await publisher();
  const release = registryRelease();
  const product = createSkillProduct({ ...productInput(owner.publisherId), skillId: release.skillId, releaseId: release.releaseId }, { registryRelease: release });
  assert.deepEqual(toPublicMarketValue(product), product);
  assert.throws(() => toPublicMarketValue({ ...product, titleZh: '被篡改' }), error => error.code === 'ABILITY_PRODUCT_TAMPERED');
  assert.throws(() => toPublicMarketValue({ value: '普通对象' }), error => error.code === 'UNSUPPORTED_PUBLIC_VALUE');
  assert.throws(() => toPublicMarketValue({ ...product, secret: 'password=abcd1234' }), error => error instanceof MarketDomainError && error.code === 'PRIVATE_VALUE');
  assert.equal(canonicalDigest(product).startsWith('sha256:'), true);
  assert.equal(EXPIRES, '2026-08-14T01:15:00.000Z');
});

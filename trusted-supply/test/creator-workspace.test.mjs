import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createApplicationProduct,
  createApplicationRelease,
  createSkillProduct,
} from '../lib/market/domain.mjs';
import {
  createCreatorWorkspace,
  createDraftRevision,
  normalizeDraftRevision,
} from '../lib/creator/creator-workspace.mjs';
import { normalizeRelease, releaseId, sourceId } from '../lib/registry-identity.mjs';

const AT = '2026-08-14T03:00:00.000Z';
const LATER = '2026-08-14T03:05:00.000Z';
const PUBLISHER_ID = `pub_${'a'.repeat(64)}`;
const D = char => `sha256:${char.repeat(64)}`;

function release(skillId = 'zaowuyun/research-synthesis') {
  const packageDigest = D('1');
  return normalizeRelease({
    schemaVersion: 1,
    releaseId: releaseId({ skillId, version: '1.0.0', packageDigest }),
    skillId,
    version: '1.0.0',
    status: 'published',
    package: { packageDigest, manifestDigest: D('2'), storageRef: `cas:${packageDigest}` },
    compatibility: { contract: 'skillops.skill.v1', targets: ['node'] },
    assessmentRefs: ['assessment:fixture'],
    reviewRefs: ['review:fixture'],
    sourceRefs: [sourceId({ type: 'fixture', coordinate: 'fixture:creator-workspace' })],
    publishedAt: AT,
  });
}

function publisher() {
  return { publisherId: PUBLISHER_ID, kind: 'organization', displayName: '造物云创作团队', status: 'active' };
}

function parties() {
  return {
    creatorPublisherIds: [PUBLISHER_ID],
    rightsHolderPublisherId: PUBLISHER_ID,
    payeePublisherId: null,
    supportPublisherId: PUBLISHER_ID,
  };
}

function skillFixture() {
  const registryRelease = release();
  const product = createSkillProduct({
    publisherId: PUBLISHER_ID,
    productKey: 'research-synthesis',
    titleZh: '研究综述技能',
    summaryZh: '形成可追溯的中文研究综述。',
    parties: parties(),
    createdAt: AT,
    skillId: registryRelease.skillId,
    releaseId: registryRelease.releaseId,
  }, { registryRelease });
  return { registryRelease, product };
}

function options(product, registryRelease, extra = {}) {
  return {
    resolvePublisher: ({ publisherId }) => publisherId === PUBLISHER_ID ? publisher() : null,
    resolveProduct: ({ productId }) => productId === product.productId ? product : null,
    resolveRegistryRelease: ({ releaseId: id }) => id === registryRelease?.releaseId ? registryRelease : null,
    ...extra,
  };
}

function draftInput(workId, target, savedAt = AT, titleZh = '研究综述技能') {
  return {
    workId,
    target,
    metadata: {
      titleZh,
      summaryZh: '帮助企业从多份材料形成结构清晰、可追溯的中文综述。',
      originalLanguage: 'en',
      titleOriginal: 'Research Synthesis',
      summaryOriginal: 'Create an evidence-backed research synthesis.',
    },
    categoryTags: ['企业研究', '知识管理'],
    pricingIntent: { model: 'free', currency: 'CNY', amountMinor: 0 },
    supportInfo: { model: 'publisher_support', responseTimeText: '两个工作日内响应', supportRef: 'support:creator-team' },
    rightsDeclaration: {
      licenseRef: 'license:creator-v1',
      declaredRights: ['invoke', 'organization_use'],
      sourceOwnership: 'original',
      evidenceRefs: ['evidence:rights-001'],
      statementVersion: 'rights-v1',
    },
    savedAt,
  };
}

test('Skill workspace has a stable private identity and immutable sequential draft revisions', () => {
  const { product, registryRelease } = skillFixture();
  const trusted = options(product, registryRelease);
  const workspace = createCreatorWorkspace({
    publisherId: PUBLISHER_ID,
    productId: product.productId,
    abilityType: 'skill',
    productKey: product.productKey,
    createdAt: AT,
  }, trusted);
  const repeated = createCreatorWorkspace({
    publisherId: PUBLISHER_ID,
    productId: product.productId,
    abilityType: 'skill',
    productKey: product.productKey,
    createdAt: LATER,
  }, trusted);
  assert.equal(workspace.workId, repeated.workId);
  assert.equal(workspace.visibility, 'private');
  assert.notEqual(workspace.workspaceDigest, repeated.workspaceDigest);

  const first = createDraftRevision(draftInput(workspace.workId, {
    skillId: registryRelease.skillId, releaseId: registryRelease.releaseId,
  }), { workspace, ...trusted });
  const second = createDraftRevision(draftInput(workspace.workId, {
    skillId: registryRelease.skillId, releaseId: registryRelease.releaseId,
  }, LATER, '研究综述技能 2.0'), { workspace, previousDraft: first, ...trusted });
  assert.equal(first.draftRevision, 1);
  assert.equal(second.draftRevision, 2);
  assert.notEqual(first.draftDigest, second.draftDigest);
  assert.equal(first.metadata.titleZh, '研究综述技能');
  assert.equal(Object.isFrozen(second.rightsDeclaration.declaredRights), true);
  assert.deepEqual(normalizeDraftRevision(first), first);
});

test('Application workspace binds the registered Product and immutable Application Release', () => {
  const { product: skill, registryRelease } = skillFixture();
  const application = createApplicationProduct({
    publisherId: PUBLISHER_ID,
    productKey: 'research-workbench',
    titleZh: '企业研究应用',
    summaryZh: '组合技能完成研究工作。',
    parties: parties(),
    createdAt: AT,
  });
  const applicationRelease = createApplicationRelease({
    applicationId: application.applicationId,
    productId: application.productId,
    version: '1.0.0',
    bom: [{
      productId: skill.productId,
      skillId: skill.skillId,
      releaseId: skill.releaseId,
      requirement: 'required',
      requiredRights: ['invoke'],
    }],
    publishedAt: AT,
  }, {
    applicationProduct: application,
    resolveRegistryRelease: () => registryRelease,
    resolveSkillProduct: () => skill,
  });
  const trusted = options(application, null, {
    resolveApplicationRelease: ({ applicationReleaseId }) => (
      applicationReleaseId === applicationRelease.applicationReleaseId ? applicationRelease : null
    ),
  });
  const workspace = createCreatorWorkspace({
    publisherId: PUBLISHER_ID, productId: application.productId,
    abilityType: 'application', productKey: application.productKey, createdAt: AT,
  }, trusted);
  const draft = createDraftRevision(draftInput(workspace.workId, {
    applicationId: application.applicationId,
    applicationReleaseId: applicationRelease.applicationReleaseId,
  }), { workspace, ...trusted });
  assert.equal(draft.target.applicationReleaseId, applicationRelease.applicationReleaseId);
  assert.equal(draft.abilityType, 'application');
});

test('untrusted Publisher, mismatched Product/Release, unknown fields and sensitive content fail closed', () => {
  const { product, registryRelease } = skillFixture();
  const trusted = options(product, registryRelease);
  const input = {
    publisherId: PUBLISHER_ID, productId: product.productId,
    abilityType: 'skill', productKey: product.productKey, createdAt: AT,
  };
  assert.throws(() => createCreatorWorkspace(input, { ...trusted, resolvePublisher: () => null }), error => error.code === 'PUBLISHER_NOT_FOUND');
  assert.throws(() => createCreatorWorkspace({ ...input, productKey: 'another-key' }, trusted), error => error.code === 'PRODUCT_BINDING_MISMATCH');
  const workspace = createCreatorWorkspace(input, trusted);
  const base = draftInput(workspace.workId, { skillId: registryRelease.skillId, releaseId: registryRelease.releaseId });
  assert.throws(() => createDraftRevision({ ...base, prompt: 'do work' }, { workspace, ...trusted }), error => error.code === 'UNKNOWN_FIELD');
  assert.throws(() => createDraftRevision({
    ...base, metadata: { ...base.metadata, summaryZh: 'password=abcd1234' },
  }, { workspace, ...trusted }), error => error.code === 'PRIVATE_VALUE');
  assert.throws(() => createDraftRevision({
    ...base, target: { ...base.target, releaseId: `rel_${'f'.repeat(64)}` },
  }, { workspace, ...trusted, resolveRegistryRelease: () => null }), error => error.code === 'REGISTRY_RELEASE_NOT_FOUND');
  assert.throws(() => createDraftRevision({
    ...base, metadata: { ...base.metadata, content: '技能正文' },
  }, { workspace, ...trusted }), error => error.code === 'FORBIDDEN_FIELD');
});

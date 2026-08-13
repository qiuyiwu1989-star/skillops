import assert from 'node:assert/strict';
import test from 'node:test';

import { createLicensePolicy } from '../lib/commerce/license-policy.mjs';
import { createOffer } from '../lib/commerce/offer.mjs';
import {
  createDemandCatalogProjection,
  searchDemandCatalog,
  validateDemandCatalogProjection,
} from '../lib/demand/demand-catalog.mjs';
import { createFixtureIdpVerifier } from '../lib/idp-receipt.mjs';
import { createMarketCatalogProjection } from '../lib/market/catalog-projection.mjs';
import { createApplicationProduct, createApplicationRelease, createPublisher, createSkillProduct } from '../lib/market/domain.mjs';
import { normalizeRelease, releaseId, sourceId } from '../lib/registry-identity.mjs';
import { createSkillRecord } from '../lib/skill-record.mjs';

const AT = '2026-08-14T10:00:00.000Z';
const D = value => `sha256:${value.repeat(64)}`;
const ENT = value => `ent_${value.repeat(64)}`;

async function fixture() {
  const verifier = createFixtureIdpVerifier({
    provider: 'fixture-market', purpose: 'market-publisher', receiptKey: Buffer.alloc(32, 45), clock: () => AT,
    assertionVerifier: () => ({ subject: 'zaowuyun', kind: 'service' }),
  });
  const publisher = createPublisher({
    kind: 'organization', displayName: '造物云能力中心', identityReceipt: await verifier.issueReceipt({ fixture: 'zaowuyun' }), createdAt: AT,
  }, { trustedProviderVerifiers: [verifier], purpose: 'market-publisher', now: AT });
  const parties = { creatorPublisherIds: [publisher.publisherId], rightsHolderPublisherId: publisher.publisherId, payeePublisherId: null, supportPublisherId: null };
  const definitions = [
    ['research', '企业研究综合', '综合多份材料并形成研究简报。', 'a', ['研究', '综合']],
    ['writing', '中文公文写作', '起草并校对中文企业公文。', '1', ['公文', '写作']],
    ['diagram', '架构图生成', '将系统架构说明转换为清晰图示。', '2', ['架构', '图示']],
  ];
  const skills = definitions.map(([key, titleZh, summaryZh, marker, intentTags], index) => {
    const packageDigest = D(marker);
    const skillId = `zaowuyun/${key}`;
    const source = { type: 'fixture', coordinate: `fixture:v45/${key}` };
    const evidence = { smsDigest: D('b'), evalDigest: D('c'), reviewEvidenceDigest: D('d'), reviewPolicyDigest: D('e') };
    const release = normalizeRelease({
      skillId, version: `1.${index}.0`, releaseId: releaseId({ skillId, version: `1.${index}.0`, packageDigest }),
      package: { packageDigest, manifestDigest: D('f'), storageRef: `cas:${packageDigest}` },
      compatibility: { contract: 'skill-package.v1', targets: ['codex'] },
      assessmentRefs: [evidence.smsDigest, evidence.evalDigest], reviewRefs: [evidence.reviewEvidenceDigest, evidence.reviewPolicyDigest],
      sourceRefs: [sourceId(source)], publishedAt: AT,
    });
    const product = createSkillProduct({ publisherId: publisher.publisherId, productKey: key, titleZh, summaryZh, parties, skillId, releaseId: release.releaseId, createdAt: AT }, { registryRelease: release });
    const record = createSkillRecord({
      release, source: { sourceId: sourceId(source), ...source },
      metadata: { titleZh, descriptionZh: summaryZh, originalTitle: titleZh, originalDescription: summaryZh, originalLanguage: 'zh-CN', localizationStatus: 'source', translationSource: null },
      routing: { summary: `适合处理${intentTags.join('与')}任务。`, intentTags, whenToUse: [`需要完成${titleZh}时`], whenNotToUse: ['任务目标不匹配时'], examples: [], confusions: [] },
      interface: { inputs: [], outputs: [] }, dependencies: { required: [], optional: [], conflicts: [] },
      permissions: { required: index === 1 ? ['document.read'] : [], optional: [], prohibited: [] }, compatibility: release.compatibility, evidence,
    });
    return { product, release, record };
  });
  const application = createApplicationProduct({ publisherId: publisher.publisherId, productKey: 'research-workbench', titleZh: '企业研究工作台', summaryZh: '组合研究与写作技能形成企业报告。', parties, createdAt: AT });
  const applicationRelease = createApplicationRelease({
    applicationId: application.applicationId, productId: application.productId, version: '1.0.0', publishedAt: AT,
    bom: [
      { productId: skills[1].product.productId, skillId: skills[1].release.skillId, releaseId: skills[1].release.releaseId, requirement: 'required', requiredRights: ['invoke'] },
      { productId: skills[0].product.productId, skillId: skills[0].release.skillId, releaseId: skills[0].release.releaseId, requirement: 'optional', requiredRights: ['invoke'] },
    ],
  }, {
    applicationProduct: application,
    resolveRegistryRelease: ({ releaseId: id }) => skills.find(value => value.release.releaseId === id)?.release,
    resolveSkillProduct: ({ productId }) => skills.find(value => value.product.productId === productId)?.product,
  });
  const products = [...skills.map(value => value.product), application];
  const offers = products.map((product, index) => createOffer({
    offerId: `offer_v45_${index}`, productId: product.productId,
    pricing: index === 1 ? { model: 'one_time', currency: 'CNY', amountMinor: 9900 } : index === 2 ? { model: 'quote', currency: 'CNY', amountMinor: 0 } : { model: 'free', currency: 'CNY', amountMinor: 0 },
    licensePolicy: createLicensePolicy({ rights: ['invoke'], constraints: { releaseIds: [product.abilityType === 'skill' ? product.releaseId : applicationRelease.applicationReleaseId] } }), effectiveAt: AT,
  }));
  const marketCatalog = createMarketCatalogProjection({ publishers: [publisher], products, registryReleases: skills.map(value => value.release), applicationReleases: [applicationRelease], offers, generatedAt: AT });
  const publications = {};
  for (const product of products) {
    const id = product.abilityType === 'skill' ? product.releaseId : applicationRelease.applicationReleaseId;
    publications[`${product.productId}:${id}`] = {
      productId: product.productId, releaseId: id, status: 'published', enforcementStatus: 'published',
      submission: {
        schemaVersion: 1, workId: `work:${product.productKey}`, publisherId: product.publisherId,
        productId: product.productId, releaseId: id, draftRevision: 1, draftDigest: D('5'),
        marketRegistryRevision: D('8'), licensePolicyDigest: D('7'), evidenceDigest: D('6'),
        declarationVersion: 'rights.v1', submittedAt: AT, submissionDigest: D('9'),
        submissionId: `sub_${(product.productId.slice(-1) || 'a').repeat(64)}`,
      },
      reviewGaps: [], nextAction: 'manage_publication', timeline: [{ eventId: `evt_${product.productId.slice(-8)}`, type: 'lifecycle.recorded', action: 'publish', at: AT }], appeals: [],
    };
  }
  const publicationProjection = { schemaVersion: 1, items: publications, eventCount: products.length };
  const records = new Map(skills.map(value => [value.release.releaseId, value.record]));
  const offerMap = new Map(offers.map(value => [value.productId, value]));
  return { publisher, skills, application, applicationRelease, products, offers, marketCatalog, publicationProjection, records, offerMap };
}

function options(value, entitlementByProduct = new Map()) {
  return {
    marketCatalogResolver: digest => digest === value.marketCatalog.catalogDigest ? value.marketCatalog : null,
    publicationItemResolver: ({ productId, releaseId }) => value.publicationProjection.items[`${productId}:${releaseId}`] ?? null,
    currentOfferResolver: productId => value.offerMap.get(productId) ?? null,
    skillRecordResolver: ({ releaseId: id }) => value.records.get(id) ?? null,
    entitlementSummaryResolver: ({ organizationId, productId, releaseId, requiredRights }) => {
      const entitlementId = entitlementByProduct.get(productId);
      return entitlementId ? { organizationId, productId, releaseId, state: 'entitled', code: 'ACCESS_ALLOWED', entitlementId, grantedRights: requiredRights }
        : { organizationId, productId, releaseId, state: 'not_entitled', code: 'NO_ENTITLEMENT', entitlementId: null, grantedRights: [] };
    },
  };
}

test('projects only current published abilities into four stable acquisition states', async () => {
  const value = await fixture();
  const entitled = new Map([[value.skills[0].product.productId, ENT('a')], [value.application.productId, ENT('b')]]);
  const projection = createDemandCatalogProjection({ marketCatalog: value.marketCatalog, publicationProjection: value.publicationProjection, organizationId: 'org_acme', generatedAt: AT }, options(value, entitled));
  assert.deepEqual(projection.summary, { total: 4, entitled: 1, freeAvailable: 0, purchaseRequired: 2, unavailable: 1 });
  assert.equal(projection.items.find(item => item.productId === value.skills[0].product.productId).acquisition.state, 'entitled');
  assert.equal(projection.items.find(item => item.productId === value.skills[1].product.productId).acquisition.state, 'purchase_required');
  assert.deepEqual(projection.items.find(item => item.productId === value.skills[1].product.productId).requiredPermissions, ['document.read']);
  assert.equal(projection.items.find(item => item.productId === value.skills[2].product.productId).acquisition.code, 'CONTACT_REQUIRED');
  const app = projection.items.find(item => item.abilityType === 'application');
  assert.equal(app.acquisition.state, 'unavailable');
  assert.equal(app.acquisition.code, 'REQUIRED_DEPENDENCY_NOT_ENTITLED');
  assert.equal(app.callable, false);
  assert.equal(app.dependencies.find(item => item.requirement === 'optional').acquisition.state, 'entitled');
  assert.equal(Object.isFrozen(projection.items[0]), true);
  assert.equal(validateDemandCatalogProjection(structuredClone(projection)).projectionDigest, projection.projectionDigest);
});

test('required Application dependency closes authorization while optional dependency does not block', async () => {
  const value = await fixture();
  const entitled = new Map([
    [value.skills[1].product.productId, ENT('a')],
    [value.application.productId, ENT('b')],
  ]);
  let projection = createDemandCatalogProjection({ marketCatalog: value.marketCatalog, publicationProjection: value.publicationProjection, organizationId: 'org_acme', generatedAt: AT }, options(value, entitled));
  let app = projection.items.find(item => item.abilityType === 'application');
  assert.equal(app.callable, true);
  assert.equal(app.acquisition.state, 'entitled');
  assert.deepEqual(app.requiredPermissions, ['document.read']);
  assert.equal(app.dependencies.find(item => item.requirement === 'optional').acquisition.state, 'free_available');
  entitled.delete(value.skills[1].product.productId);
  projection = createDemandCatalogProjection({ marketCatalog: value.marketCatalog, publicationProjection: value.publicationProjection, organizationId: 'org_acme', generatedAt: AT }, options(value, entitled));
  app = projection.items.find(item => item.abilityType === 'application');
  assert.equal(app.callable, false);
  assert.equal(app.acquisition.code, 'REQUIRED_DEPENDENCY_NOT_ENTITLED');
  const required = value.applicationRelease.bom.find(item => item.requirement === 'required');
  const applicationKey = `${value.application.productId}:${value.applicationRelease.applicationReleaseId}`;
  const applicationOnly = { schemaVersion: 1, items: { [applicationKey]: value.publicationProjection.items[applicationKey] }, eventCount: 1 };
  const recalledDependency = { ...structuredClone(value.publicationProjection.items[`${required.productId}:${required.releaseId}`]), status: 'recalled', enforcementStatus: 'recalled' };
  projection = createDemandCatalogProjection({ marketCatalog: value.marketCatalog, publicationProjection: applicationOnly, organizationId: 'org_acme', generatedAt: AT }, {
    ...options(value, new Map([[required.productId, ENT('a')], [value.application.productId, ENT('b')]])),
    publicationItemResolver: ({ productId, releaseId }) => productId === required.productId
      ? recalledDependency : applicationOnly.items[`${productId}:${releaseId}`],
  });
  app = projection.items.find(item => item.abilityType === 'application');
  assert.equal(app.acquisition.code, 'REQUIRED_DEPENDENCY_NOT_ENTITLED');
});

test('withdrawn, recalled, stale and unpublished abilities do not enter demand catalog', async () => {
  const value = await fixture();
  const projection = structuredClone(value.publicationProjection);
  const entries = Object.values(projection.items);
  entries[0].status = 'withdrawn'; entries[0].enforcementStatus = 'withdrawn';
  entries[1].status = 'recalled'; entries[1].enforcementStatus = 'recalled';
  delete projection.items[`${entries[3].productId}:${entries[3].releaseId}`];
  const result = createDemandCatalogProjection({ marketCatalog: value.marketCatalog, publicationProjection: projection, organizationId: 'org_acme', generatedAt: AT }, { ...options(value), publicationItemResolver: ({ productId, releaseId }) => projection.items[`${productId}:${releaseId}`] ?? null });
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].productId, entries[2].productId);
});

test('fails closed on forged catalog digest, publication binding and cross-organization entitlement', async () => {
  const value = await fixture();
  const catalog = structuredClone(value.marketCatalog);
  catalog.products[0].titleZh = '被篡改标题';
  assert.throws(() => createDemandCatalogProjection({ marketCatalog: catalog, publicationProjection: value.publicationProjection, organizationId: 'org_acme', generatedAt: AT }, options(value)), error => ['ABILITY_PRODUCT_TAMPERED', 'CATALOG_DIGEST_MISMATCH'].includes(error.code));
  const publication = structuredClone(value.publicationProjection);
  Object.values(publication.items)[0].submission.releaseId = value.skills[1].release.releaseId;
  assert.throws(() => createDemandCatalogProjection({ marketCatalog: value.marketCatalog, publicationProjection: publication, organizationId: 'org_acme', generatedAt: AT }, options(value)), error => error.code === 'PUBLICATION_BINDING_MISMATCH');
  const crossOrganization = options(value);
  crossOrganization.entitlementSummaryResolver = ({ productId, releaseId }) => ({ organizationId: 'org_other', productId, releaseId, state: 'entitled', code: 'ACCESS_ALLOWED', entitlementId: ENT('f'), grantedRights: ['invoke'] });
  assert.throws(() => createDemandCatalogProjection({ marketCatalog: value.marketCatalog, publicationProjection: value.publicationProjection, organizationId: 'org_acme', generatedAt: AT }, crossOrganization), error => error.code === 'ENTITLEMENT_SCOPE_MISMATCH');
});

test('caller-owned projection cannot replace trusted Market Catalog or Publication item', async () => {
  const value = await fixture();
  assert.throws(() => createDemandCatalogProjection({ marketCatalog: value.marketCatalog, publicationProjection: value.publicationProjection, organizationId: 'org_acme', generatedAt: AT }, { currentOfferResolver: productId => value.offerMap.get(productId) }), error => error.code === 'MARKET_CATALOG_RESOLVER_REQUIRED');
  const missingPublication = options(value); delete missingPublication.publicationItemResolver;
  assert.throws(() => createDemandCatalogProjection({ marketCatalog: value.marketCatalog, publicationProjection: value.publicationProjection, organizationId: 'org_acme', generatedAt: AT }, missingPublication), error => error.code === 'PUBLICATION_ITEM_RESOLVER_REQUIRED');
  const stale = options(value); stale.publicationItemResolver = () => null;
  assert.throws(() => createDemandCatalogProjection({ marketCatalog: value.marketCatalog, publicationProjection: value.publicationProjection, organizationId: 'org_acme', generatedAt: AT }, stale), error => error.code === 'PUBLICATION_ITEM_TRUST_MISMATCH');
});

test('official validator rejects tampering, private fields and inconsistent summaries', async () => {
  const value = await fixture();
  const projection = createDemandCatalogProjection({ marketCatalog: value.marketCatalog, publicationProjection: value.publicationProjection, organizationId: 'org_acme', generatedAt: AT }, options(value));
  const tampered = structuredClone(projection); tampered.items[0].titleZh = '摘要外篡改';
  assert.throws(() => validateDemandCatalogProjection(tampered), error => error.code === 'PROJECTION_DIGEST_MISMATCH');
  const privateValue = structuredClone(projection); privateValue.items[0].localPath = '/Users/private/skill.md';
  assert.throws(() => validateDemandCatalogProjection(privateValue), error => error.code === 'UNKNOWN_FIELD');
  const summary = structuredClone(projection); summary.summary.total += 1;
  const { projectionDigest: _old, ...body } = summary; summary.projectionDigest = (await import('../lib/registry-identity.mjs')).canonicalDigest(body);
  assert.throws(() => validateDemandCatalogProjection(summary), error => error.code === 'SUMMARY_MISMATCH');
  const permissions = structuredClone(projection); permissions.items[0].requiredPermissions.push('network.external');
  assert.throws(() => validateDemandCatalogProjection(permissions), error => error.code === 'PROJECTION_DIGEST_MISMATCH');
});

test('Chinese task and filters return deterministic ranked results with match explanations', async () => {
  const value = await fixture();
  const projection = createDemandCatalogProjection({ marketCatalog: value.marketCatalog, publicationProjection: value.publicationProjection, organizationId: 'org_acme', generatedAt: AT }, options(value, new Map([[value.skills[0].product.productId, ENT('a')]])));
  const first = searchDemandCatalog(projection, { taskZh: '需要综合企业研究材料', abilityTypes: ['skill'], acquisitionStates: ['entitled'], categoryTags: ['研究'], limit: 5 });
  const second = searchDemandCatalog(structuredClone(projection), { taskZh: '需要综合企业研究材料', abilityTypes: ['skill'], acquisitionStates: ['entitled'], categoryTags: ['研究'], limit: 5 });
  assert.equal(first.resultCount, 1);
  assert.equal(first.results[0].titleZh, '企业研究综合');
  assert.ok(first.results[0].matchReasons.some(reason => reason.includes('任务标签') || reason.includes('能力说明')));
  assert.equal(first.searchDigest, second.searchDigest);
  assert.equal(first.sourceProjectionDigest, projection.projectionDigest);
  const pricing = searchDemandCatalog(projection, { pricingModels: ['quote'] });
  assert.deepEqual(pricing.results.map(item => item.titleZh), ['架构图生成']);
});

test('hard limits and resolver failures fail closed; no resolver never claims entitlement', async () => {
  const value = await fixture();
  const noResolver = createDemandCatalogProjection({ marketCatalog: value.marketCatalog, publicationProjection: value.publicationProjection, organizationId: 'org_acme', generatedAt: AT }, {
    marketCatalogResolver: () => value.marketCatalog, publicationItemResolver: ({ productId, releaseId }) => value.publicationProjection.items[`${productId}:${releaseId}`],
    currentOfferResolver: productId => value.offerMap.get(productId), skillRecordResolver: ({ releaseId: id }) => value.records.get(id),
  });
  assert.equal(noResolver.items.some(item => item.acquisition.state === 'entitled'), false);
  assert.throws(() => searchDemandCatalog(noResolver, { limit: 201 }), error => error.code === 'INVALID_NUMBER');
  const broken = options(value); broken.entitlementSummaryResolver = () => { throw new Error('backend unavailable'); };
  assert.throws(() => createDemandCatalogProjection({ marketCatalog: value.marketCatalog, publicationProjection: value.publicationProjection, organizationId: 'org_acme', generatedAt: AT }, broken), error => error.code === 'ENTITLEMENT_RESOLVER_FAILED');
  assert.doesNotMatch(JSON.stringify(noResolver), /candidate|storageRef|localPath|prompt|output|receipt|subjectDigest|principalId|token|secret/i);
});

test('Offer必须覆盖调用权、企业、版本和当前有效期才可获取', async () => {
  const value = await fixture();
  const target = value.skills[0];
  const cases = [
    ['OFFER_INVOKE_RIGHT_MISSING', createLicensePolicy({ rights: ['view_source'], constraints: { releaseIds: [target.release.releaseId] } })],
    ['OFFER_ORGANIZATION_NOT_ELIGIBLE', createLicensePolicy({ rights: ['invoke'], constraints: { organizationIds: ['org_other'], releaseIds: [target.release.releaseId] } })],
    ['OFFER_RELEASE_NOT_ELIGIBLE', createLicensePolicy({ rights: ['invoke'], constraints: { releaseIds: [value.skills[1].release.releaseId] } })],
    ['OFFER_NOT_YET_VALID', createLicensePolicy({ rights: ['invoke'], constraints: { releaseIds: [target.release.releaseId], validFrom: '2026-08-15T00:00:00Z' } })],
    ['OFFER_EXPIRED', createLicensePolicy({ rights: ['invoke'], constraints: { releaseIds: [target.release.releaseId], validUntil: '2026-08-14T09:00:00Z' } })],
  ];
  for (const [code, licensePolicy] of cases) {
    const offer = createOffer({ offerId: `offer_${code.toLowerCase()}`, productId: target.product.productId, pricing: { model: 'free', currency: 'CNY', amountMinor: 0 }, licensePolicy, effectiveAt: AT });
    const marketCatalog = createMarketCatalogProjection({ publishers: [value.publisher], products: value.products, registryReleases: value.skills.map(row => row.release), applicationReleases: [value.applicationRelease], offers: [...value.offers.filter(row => row.productId !== target.product.productId), offer], generatedAt: AT });
    const projection = createDemandCatalogProjection({ marketCatalog, publicationProjection: value.publicationProjection, organizationId: 'org_acme', generatedAt: AT }, { ...options(value), marketCatalogResolver: () => marketCatalog, currentOfferResolver: productId => productId === target.product.productId ? offer : value.offerMap.get(productId) });
    assert.equal(projection.items.find(item => item.productId === target.product.productId).acquisition.code, code);
  }
});

import assert from 'node:assert/strict';
import test from 'node:test';

import { createFixtureIdpVerifier } from '../lib/idp-receipt.mjs';
import { createPublisher, createSkillProduct } from '../lib/market/domain.mjs';
import { createMarketCatalogProjection } from '../lib/market/catalog-projection.mjs';
import { createLicensePolicy } from '../lib/commerce/license-policy.mjs';
import { createOffer } from '../lib/commerce/offer.mjs';
import { canonicalDigest, normalizeRelease, releaseId, sourceId } from '../lib/registry-identity.mjs';

const AT = '2026-08-14T00:00:00.000Z';
const D = char => `sha256:${char.repeat(64)}`;

async function fixture() {
  const verifier = createFixtureIdpVerifier({
    provider: 'fixture-market', purpose: 'market-publisher', receiptKey: Buffer.alloc(32, 7), clock: () => AT,
    assertionVerifier: () => ({ subject: 'zaowuyun', kind: 'service' }),
  });
  const receipt = await verifier.issueReceipt({ fixture: 'zaowuyun' });
  const publisher = createPublisher({ kind: 'organization', displayName: '造物云', identityReceipt: receipt, createdAt: AT }, {
    trustedProviderVerifiers: [verifier], purpose: 'market-publisher', now: AT,
  });
  const packageDigest = D('a');
  const release = normalizeRelease({
    skillId: 'zaowuyun/research', version: '1.0.0',
    releaseId: releaseId({ skillId: 'zaowuyun/research', version: '1.0.0', packageDigest }),
    package: { packageDigest, manifestDigest: D('b'), storageRef: `cas:${packageDigest}` },
    compatibility: { contract: 'skill.v1', targets: ['node'] }, assessmentRefs: ['assessment:a'],
    reviewRefs: ['review:a'], sourceRefs: [sourceId('fixture', 'market/research')], publishedAt: AT,
  });
  const product = createSkillProduct({
    publisherId: publisher.publisherId, productKey: 'research', titleZh: '研究技能', summaryZh: '企业研究能力。',
    parties: { creatorPublisherIds: [publisher.publisherId], rightsHolderPublisherId: publisher.publisherId, payeePublisherId: null, supportPublisherId: null },
    createdAt: AT, skillId: release.skillId, releaseId: release.releaseId,
  }, { registryRelease: release });
  const policy = createLicensePolicy({ rights: ['invoke'], constraints: { releaseIds: [release.releaseId] } });
  const offer = createOffer({ offerId: 'offer_free', productId: product.productId, pricing: { model: 'free', currency: 'CNY', amountMinor: 0 }, licensePolicy: policy, effectiveAt: AT });
  return { publisher, product, release, offer };
}

test('catalog joins stable Publisher/Product/Registry Release/Offer and removes CAS storage reference', async () => {
  const value = await fixture();
  const catalog = createMarketCatalogProjection({
    publishers: [value.publisher], products: [value.product], registryReleases: [value.release], applicationReleases: [], offers: [value.offer], generatedAt: AT,
  });
  assert.match(catalog.catalogDigest, /^sha256:[a-f0-9]{64}$/);
  assert.equal(catalog.products[0].productId, value.product.productId);
  assert.equal(catalog.registryReleases[0].releaseId, value.release.releaseId);
  assert.equal(Object.hasOwn(catalog.registryReleases[0].package, 'storageRef'), false);
  assert.equal(JSON.stringify(catalog).includes('cand_'), false);
  assert.equal(Object.isFrozen(catalog.products), true);
  assert.equal(Object.isFrozen(catalog.products[0]), true);
  assert.throws(() => { catalog.products[0].titleZh = '摘要外篡改'; }, TypeError);
});

test('catalog fails closed when product references are absent or input tries to carry private fields', async () => {
  const value = await fixture();
  assert.throws(() => createMarketCatalogProjection({
    publishers: [], products: [value.product], registryReleases: [value.release], applicationReleases: [], offers: [value.offer], generatedAt: AT,
  }), error => error.code === 'PUBLISHER_NOT_FOUND');
  assert.throws(() => createMarketCatalogProjection({
    publishers: [value.publisher], products: [{ ...value.product, candidateId: 'cand_bad' }], registryReleases: [value.release], applicationReleases: [], offers: [value.offer], generatedAt: AT,
  }), error => error.code === 'PRIVATE_VALUE');
  const forgedParty = structuredClone(value.product);
  forgedParty.parties.rightsHolderPublisherId = `pub_${'f'.repeat(64)}`;
  const { productDigest: _digest, ...body } = forgedParty;
  forgedParty.productDigest = canonicalDigest(body);
  assert.throws(() => createMarketCatalogProjection({
    publishers: [value.publisher], products: [forgedParty], registryReleases: [value.release], applicationReleases: [], offers: [value.offer], generatedAt: AT,
  }), error => error.code === 'PRODUCT_PARTY_NOT_FOUND');
});

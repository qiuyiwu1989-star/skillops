import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createFixtureIdpVerifier } from '../lib/idp-receipt.mjs';
import { MarketRegistry } from '../lib/market/market-registry.mjs';
import { normalizeRelease, releaseId, sourceId } from '../lib/registry-identity.mjs';

const AT = '2026-08-14T01:00:00.000Z';
const KEY = Buffer.alloc(32, 71);
const D = char => `sha256:${char.repeat(64)}`;

function tempFile() {
  return path.join(fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'skillops-market-registry-')), 'registry.json');
}

function verifier() {
  return createFixtureIdpVerifier({
    provider: 'fixture-market-registry-idp',
    purpose: 'market-publisher',
    receiptKey: KEY,
    clock: () => new Date(AT),
    assertionVerifier: async assertion => ({ subject: `verified:${assertion.actor}`, kind: 'service' }),
  });
}

async function publisherInput(actor = 'creator-company') {
  const trusted = verifier();
  const identityReceipt = await trusted.issueReceipt({ actor });
  return {
    input: { kind: 'organization', displayName: '可信能力团队', identityReceipt, createdAt: AT },
    trustOptions: { trustedProviderVerifiers: [trusted], purpose: 'market-publisher', now: AT },
  };
}

function registryRelease({ skillId = 'zaowuyun/research-synthesis', version = '1.0.0', char = '1' } = {}) {
  const packageDigest = D(char);
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
    sourceRefs: [sourceId({ type: 'fixture', coordinate: `fixture:${skillId}:${version}` })],
    publishedAt: AT,
  });
}

function parties(publisherId, overrides = {}) {
  return {
    creatorPublisherIds: [publisherId],
    rightsHolderPublisherId: publisherId,
    payeePublisherId: null,
    supportPublisherId: publisherId,
    ...overrides,
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

function authorizationFor({ publisherId, skillId, releaseId }, decision = 'allow') {
  return {
    decision,
    publisherId,
    skillId,
    releaseId,
    authorityRef: 'registry:publication-authority',
    policyVersion: 'market-publication-v1',
    authorizedAt: AT,
  };
}

async function registeredPublisher(registry, actor = 'creator-company') {
  const fixture = await publisherInput(actor);
  return registry.registerPublisher(fixture.input, {
    trustOptions: fixture.trustOptions,
    expectedRevision: registry.snapshot().revision,
  }).publisher;
}

test('Publisher registration verifies raw IdP evidence internally and public projection omits identity evidence', async () => {
  const registry = new MarketRegistry(tempFile());
  const publisher = await registeredPublisher(registry);
  assert.match(publisher.publisherId, /^pub_[a-f0-9]{64}$/);
  assert.equal(Object.hasOwn(publisher, 'identityEvidence'), false);
  assert.equal(Object.hasOwn(registry.snapshot(), 'events'), false);
  const serialized = JSON.stringify(registry.project());
  for (const forbidden of ['subjectDigest', 'receiptDigest', 'identityEvidence', 'verified:creator-company']) {
    assert.equal(serialized.includes(forbidden), false);
  }
  assert.deepEqual(new MarketRegistry(registry.filePath).resolvePublisher({ publisherId: publisher.publisherId }), publisher);
  assert.equal(registry.write, undefined);
});

test('a canonical Release digest is insufficient without independent publication authority', async () => {
  const registry = new MarketRegistry(tempFile());
  const publisher = await registeredPublisher(registry);
  const release = registryRelease();
  const input = { ...productInput(publisher.publisherId), skillId: release.skillId, releaseId: release.releaseId };
  assert.throws(() => registry.registerSkillProduct(input, {
    resolveRegistryRelease: () => release,
    expectedRevision: registry.snapshot().revision,
  }), error => error.code === 'PUBLICATION_AUTHORITY_REQUIRED');
  assert.throws(() => registry.registerSkillProduct(input, {
    resolveRegistryRelease: () => release,
    authorizePublication: identity => authorizationFor(identity, 'deny'),
    expectedRevision: registry.snapshot().revision,
  }), error => error.code === 'PUBLICATION_NOT_AUTHORIZED');
  assert.equal(registry.snapshot().eventCount, 1);
});

test('Skill and Application Products require every publisher party to be registered and active', async () => {
  const registry = new MarketRegistry(tempFile());
  const publisher = await registeredPublisher(registry);
  const release = registryRelease();
  const missingPublisherId = `pub_${'f'.repeat(64)}`;
  const bad = {
    ...productInput(publisher.publisherId),
    parties: parties(publisher.publisherId, { supportPublisherId: missingPublisherId }),
    skillId: release.skillId,
    releaseId: release.releaseId,
  };
  assert.throws(() => registry.registerSkillProduct(bad, {
    resolveRegistryRelease: () => release,
    authorizePublication: identity => authorizationFor(identity),
    expectedRevision: registry.snapshot().revision,
  }), error => error.code === 'PUBLISHER_NOT_REGISTERED');

  const good = { ...productInput(publisher.publisherId), skillId: release.skillId, releaseId: release.releaseId };
  const result = registry.registerSkillProduct(good, {
    resolveRegistryRelease: () => release,
    authorizePublication: identity => authorizationFor(identity),
    expectedRevision: registry.snapshot().revision,
  });
  assert.equal(result.product.skillId, release.skillId);
  assert.equal(JSON.stringify(registry.project()).includes('publicationAuthorization'), false);
});

test('Application Release requires registered Product and exact registered Skill Product BOM bindings', async () => {
  const registry = new MarketRegistry(tempFile());
  const publisher = await registeredPublisher(registry);
  const release = registryRelease();
  const skill = registry.registerSkillProduct({
    ...productInput(publisher.publisherId), skillId: release.skillId, releaseId: release.releaseId,
  }, {
    resolveRegistryRelease: () => release,
    authorizePublication: identity => authorizationFor(identity),
    expectedRevision: registry.snapshot().revision,
  }).product;
  const application = registry.registerApplicationProduct({
    ...productInput(publisher.publisherId, 'research-workbench'),
    titleZh: '研究工作应用',
  }, { expectedRevision: registry.snapshot().revision }).product;
  const input = {
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
  };
  const published = registry.publishApplicationRelease(input, {
    resolveRegistryRelease: () => release,
    expectedRevision: registry.snapshot().revision,
  });
  assert.match(published.applicationRelease.applicationReleaseId, /^apprel_[a-f0-9]{64}$/);
  assert.deepEqual(new MarketRegistry(registry.filePath).resolveApplicationRelease({
    applicationReleaseId: published.applicationRelease.applicationReleaseId,
  }), published.applicationRelease);

  const second = registryRelease({ skillId: 'zaowuyun/other-skill', char: '2' });
  assert.throws(() => registry.publishApplicationRelease({
    ...input,
    version: '2.0.0',
    bom: [{ ...input.bom[0], skillId: second.skillId, releaseId: second.releaseId }],
  }, {
    resolveRegistryRelease: () => second,
    expectedRevision: registry.snapshot().revision,
  }), error => ['APPLICATION_RELEASE_REJECTED', 'BOM_PRODUCT_MISMATCH'].includes(error.code));
});

test('same request is idempotent while stable identity conflict fails closed without writing', async () => {
  const registry = new MarketRegistry(tempFile());
  const fixture = await publisherInput();
  const first = registry.registerPublisher(fixture.input, {
    trustOptions: fixture.trustOptions,
    expectedRevision: registry.snapshot().revision,
  });
  const bytes = fs.readFileSync(registry.filePath);
  const again = registry.registerPublisher(fixture.input, {
    trustOptions: fixture.trustOptions,
    expectedRevision: first.revision,
  });
  assert.equal(again.action, 'unchanged');
  assert.deepEqual(fs.readFileSync(registry.filePath), bytes);

  const changed = { ...fixture.input, displayName: '试图改名的主体' };
  assert.throws(() => registry.registerPublisher(changed, {
    trustOptions: fixture.trustOptions,
    expectedRevision: first.revision,
  }), error => error.code === 'PUBLISHER_CONFLICT');
  assert.deepEqual(fs.readFileSync(registry.filePath), bytes);
});

test('revision CAS and atomic write failure preserve the previous append-only history', async () => {
  const file = tempFile();
  const fixture = await publisherInput();
  const registry = new MarketRegistry(file);
  assert.throws(() => registry.registerPublisher(fixture.input, {
    trustOptions: fixture.trustOptions,
    expectedRevision: 'sha256:stale',
  }), error => error.code === 'REVISION_CONFLICT');
  assert.equal(fs.existsSync(file), false);

  const faulty = new MarketRegistry(file, { faultInjector: stage => { if (stage === 'beforeRename') throw new Error('injected failure'); } });
  assert.throws(() => faulty.registerPublisher(fixture.input, {
    trustOptions: fixture.trustOptions,
    expectedRevision: faulty.snapshot().revision,
  }), /injected failure/);
  assert.equal(fs.existsSync(file), false);
});

test('nested parent and target symlinks are rejected before any outside write', t => {
  if (process.platform === 'win32') return t.skip('symlink fixture is POSIX-specific');
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'skillops-market-registry-'));
  const outside = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'skillops-market-outside-'));
  fs.symlinkSync(outside, path.join(root, 'state'));
  assert.throws(() => new MarketRegistry(path.join(root, 'state', 'registry.json')), error => error.code === 'UNSAFE_STORE_PATH');
  assert.deepEqual(fs.readdirSync(outside), []);

  const target = path.join(root, 'target.json');
  const outsideFile = path.join(outside, 'outside.json');
  fs.writeFileSync(outsideFile, '{}');
  fs.symlinkSync(outsideFile, target);
  assert.throws(() => new MarketRegistry(target), error => error.code === 'UNSAFE_STORE_PATH');
  assert.equal(fs.readFileSync(outsideFile, 'utf8'), '{}');
});

test('registered Skill Product exposes a trusted Product to Release ordering binding', async () => {
  const registry = new MarketRegistry(tempFile());
  const fixture = await publisherInput();
  const publisher = registry.registerPublisher(fixture.input, {
    trustOptions: fixture.trustOptions, expectedRevision: registry.snapshot().revision,
  }).publisher;
  const release = registryRelease();
  const product = registry.registerSkillProduct({
    ...productInput(publisher.publisherId), skillId: release.skillId, releaseId: release.releaseId,
  }, {
    resolveRegistryRelease: () => release,
    authorizePublication: identity => authorizationFor(identity),
    expectedRevision: registry.snapshot().revision,
  }).product;
  assert.deepEqual(registry.resolveOrderProduct(product.productId), { productId: product.productId, status: 'published' });
  assert.deepEqual(registry.resolveOrderRelease(product.releaseId), {
    releaseId: product.releaseId, productId: product.productId, status: 'published',
  });
  assert.equal(registry.resolveOrderRelease(`rel_${'f'.repeat(64)}`), null);
});

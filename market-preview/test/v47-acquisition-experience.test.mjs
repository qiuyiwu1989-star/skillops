import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  PREVIEW_FREE_OFFER_REVISION_ID,
  PREVIEW_FREE_PRODUCT_ID,
  PREVIEW_FREE_RELEASE_ID,
  createPreviewAcquisitionService,
} from '../preview-acquisition.mjs';
import { createPreviewServer } from '../serve.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const FIXED_NOW = '2026-08-14T00:00:00.000Z';

function temporaryLedger() {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'skillops-v47-market-'));
  return path.join(root, 'acquisitions.json');
}

function service() {
  return createPreviewAcquisitionService({ ledgerPath: temporaryLedger(), clock: () => new Date(FIXED_NOW) });
}

function freeRequest(overrides = {}) {
  return {
    productId: PREVIEW_FREE_PRODUCT_ID,
    releaseId: PREVIEW_FREE_RELEASE_ID,
    offerRevisionId: PREVIEW_FREE_OFFER_REVISION_ID,
    idempotencyKey: 'market_preview_contract_test',
    ...overrides,
  };
}

test('preview market exposes four clear enterprise acquisition states', () => {
  const catalog = service().catalog();
  assert.equal(catalog.mode, 'local_service');
  assert.deepEqual(catalog.summary, {
    total: 4,
    entitled: 1,
    freeAvailable: 1,
    purchaseRequired: 1,
    unavailable: 1,
  });
  assert.deepEqual(new Set(catalog.products.map(item => item.acquisition.state)), new Set([
    'entitled', 'free_available', 'purchase_required', 'unavailable',
  ]));
  assert.match(catalog.projectionDigest, /^sha256:[a-f0-9]{64}$/);
});

test('free acquisition creates one canonical entitlement and replays idempotently', () => {
  const preview = service();
  const first = preview.acquire(freeRequest());
  const replay = preview.acquire(freeRequest());
  assert.equal(first.action, 'committed');
  assert.equal(replay.action, 'unchanged');
  assert.equal(first.grant.entitlementId, replay.grant.entitlementId);
  assert.equal(replay.projection.summary.entitled, 2);
  assert.equal(replay.projection.summary.freeAvailable, 0);
  assert.match(replay.grant.entitlementId, /^ent_[a-f0-9]{64}$/);
  assert.deepEqual(replay.grant.rights, ['invoke', 'organization_use']);
});

test('free endpoint rejects paid, recalled, unknown and caller-expanded requests', () => {
  const preview = service();
  assert.throws(() => preview.acquire(freeRequest({ productId: `prod_${'1'.repeat(64)}` })), error => error.code === 'FREE_OFFER_MISMATCH');
  assert.throws(() => preview.acquire(freeRequest({ releaseId: `rel_${'4'.repeat(64)}` })), error => error.code === 'FREE_OFFER_MISMATCH');
  assert.throws(() => preview.acquire({ ...freeRequest(), organizationId: 'org_attacker' }), error => error.code === 'UNKNOWN_FIELD');
  assert.equal(preview.catalog().summary.freeAvailable, 1);
});

test('public responses omit paths, order bodies, identities and execution material', () => {
  const preview = service();
  const serialized = JSON.stringify({ catalog: preview.catalog(), acquisition: preview.acquire(freeRequest()) });
  assert.doesNotMatch(serialized, /(?:storageRef|filePath|ledgerPath|sourceOrderDigest|orderDigest|principal|subject|prompt|output|token|secret|SKILL\.md)/i);
  assert.doesNotMatch(serialized, /(?:\/Users\/|\/private\/|\/tmp\/|file:\/\/)/i);
});

test('HTTP preview API serves catalog and commits free acquisition without exposing organization input', async t => {
  const preview = service();
  const server = createPreviewServer({ root: ROOT, acquisitionService: preview });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const address = server.address();
  const base = `http://127.0.0.1:${address.port}`;

  const catalogResponse = await fetch(`${base}/api/v1/preview/acquisitions`);
  assert.equal(catalogResponse.status, 200);
  const catalog = await catalogResponse.json();
  assert.equal(catalog.ok, true);
  assert.equal(catalog.data.summary.total, 4);

  const acquisitionResponse = await fetch(`${base}/api/v1/preview/acquisitions/free`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(freeRequest()),
  });
  assert.equal(acquisitionResponse.status, 200);
  const acquisition = await acquisitionResponse.json();
  assert.equal(acquisition.ok, true);
  assert.equal(acquisition.data.action, 'committed');
  assert.equal(acquisition.data.projection.summary.entitled, 2);
});

test('HTTP preview API fails closed for methods, content types and oversized bodies', async t => {
  const server = createPreviewServer({ root: ROOT, acquisitionService: service() });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const address = server.address();
  const base = `http://127.0.0.1:${address.port}`;

  const wrongMethod = await fetch(`${base}/api/v1/preview/acquisitions`, { method: 'POST' });
  assert.equal(wrongMethod.status, 405);
  const wrongType = await fetch(`${base}/api/v1/preview/acquisitions/free`, { method: 'POST', body: '{}' });
  assert.equal(wrongType.status, 415);
  const tooLarge = await fetch(`${base}/api/v1/preview/acquisitions/free`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ payload: 'x'.repeat(17 * 1024) }),
  });
  assert.equal(tooLarge.status, 413);
});

test('market homepage renders acquisition entry and only mutates after explicit free action', () => {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const script = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');
  const styles = fs.readFileSync(path.join(ROOT, 'styles.css'), 'utf8');
  const fixture = JSON.parse(fs.readFileSync(path.join(ROOT, 'market-experience.fixture.json'), 'utf8'));
  assert.match(html, /id="acquisition"/);
  assert.match(html, /企业获取入口/);
  assert.match(html, /id="product-grid"/);
  assert.match(script, /FREE_ACQUISITION_API_URL/);
  assert.match(script, /button\.addEventListener\('click', \(\) => acquireFreeProduct\(product\)\)/);
  assert.doesNotMatch(script, /localStorage|sessionStorage/);
  assert.match(styles, /\.product-grid/);
  assert.deepEqual(fixture.products.map(item => item.acquisition.state), [
    'entitled', 'free_available', 'purchase_required', 'unavailable',
  ]);
});

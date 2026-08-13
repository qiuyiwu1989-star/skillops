import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createFixtureIdpVerifier } from '../lib/idp-receipt.mjs';
import { createPublicationSubmission } from '../lib/creator/publication-workflow.mjs';
import { PublicationStore } from '../lib/creator/publication-store.mjs';

const NOW = '2026-08-14T00:00:00.000Z';
const PUB = `pub_${'a'.repeat(64)}`;
const PROD = `prod_${'b'.repeat(64)}`;
const REL = `rel_${'c'.repeat(64)}`;
const WORK = `work_${'d'.repeat(64)}`;
const DRAFT = `sha256:${'e'.repeat(64)}`;
const REGISTRY = `sha256:${'f'.repeat(64)}`;
const LICENSE = `sha256:${'1'.repeat(64)}`;
const EVIDENCE = `sha256:${'2'.repeat(64)}`;

async function scenario() {
  const verifier = createFixtureIdpVerifier({
    provider: 'fixture-idp', purpose: 'creator-publication',
    receiptKey: 'publication-store-fixture-key-at-least-32-bytes', clock: () => NOW,
    ttlMs: 24 * 60 * 60 * 1_000,
    assertionVerifier: async assertion => assertion.code === 'creator' ? { subject: 'human:creator', kind: 'human' } : null,
  });
  const receipt = await verifier.issueReceipt({ code: 'creator' });
  const binding = {
    workId: WORK, publisherId: PUB, productId: PROD, releaseId: REL, draftRevision: 1,
    draftDigest: DRAFT, marketRegistryRevision: REGISTRY, licensePolicyDigest: LICENSE,
    evidenceDigest: EVIDENCE, declarationVersion: 'rights-v1',
  };
  const trustOptions = {
    trustedProviderVerifiers: [verifier], now: () => NOW,
    canonicalHumanResolver: ({ subjectDigest }) => ({ canonicalSubjectDigest: subjectDigest }),
    publisherRepresentativeResolver: () => true,
    draftResolver: () => ({
      workId: WORK, publisherId: PUB, productId: PROD, draftRevision: 1, draftDigest: DRAFT,
      target: { releaseId: REL }, rightsDeclaration: { statementVersion: 'rights-v1' },
    }),
    productResolver: () => ({ productId: PROD, publisherId: PUB }),
    releaseResolver: () => ({ releaseId: REL, productId: PROD }),
    marketRegistryRevisionResolver: () => REGISTRY,
    reviewerRoleResolver: () => true,
    lifecycleActorResolver: () => true,
    currentBindingResolver: () => binding,
  };
  const submission = createPublicationSubmission({ ...binding, submitterReceipt: receipt }, trustOptions);
  return { trustOptions, submission };
}

function temporaryFile(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'skillops-publication-store-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return path.join(directory, 'publication.json');
}

test('PublicationStore is append-only, CAS protected, idempotent and restart replayable', async t => {
  const { trustOptions, submission } = await scenario();
  const file = temporaryFile(t);
  const store = new PublicationStore(file, { trustOptions });
  const initial = store.snapshot();
  const appended = store.append({ type: 'submission.created', payload: submission }, { expectedRevision: initial.revision });
  assert.equal(appended.action, 'appended');
  assert.equal(store.project().eventCount, 1);

  const restarted = new PublicationStore(file, { trustOptions });
  assert.equal(restarted.snapshot().revision, appended.revision);
  assert.equal(restarted.project().submissions[submission.submissionId].submissionDigest, submission.submissionDigest);

  const unchanged = restarted.append({ type: 'submission.created', payload: submission }, { expectedRevision: appended.revision });
  assert.equal(unchanged.action, 'unchanged');
  assert.equal(restarted.snapshot().eventCount, 1);
  assert.throws(() => restarted.append({ type: 'submission.created', payload: submission }, { expectedRevision: initial.revision }), error => error.code === 'REVISION_CONFLICT');
  assert.equal(typeof restarted.write, 'undefined');
});

test('fault before rename preserves the previous committed revision', async t => {
  const { trustOptions, submission } = await scenario();
  const file = temporaryFile(t);
  const store = new PublicationStore(file, { trustOptions, faultInjector: phase => {
    if (phase === 'beforeRename') throw new Error('injected failure');
  } });
  const initial = store.snapshot();
  assert.throws(() => store.append({ type: 'submission.created', payload: submission }, { expectedRevision: initial.revision }), /injected failure/);
  assert.deepEqual(new PublicationStore(file, { trustOptions }).snapshot(), initial);
});

test('symlink ancestors and symlink targets are rejected', async t => {
  const { trustOptions } = await scenario();
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'skillops-publication-symlink-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const real = path.join(directory, 'real');
  fs.mkdirSync(real);
  const link = path.join(directory, 'link');
  fs.symlinkSync(real, link, 'dir');
  assert.throws(() => new PublicationStore(path.join(link, 'publication.json'), { trustOptions }), error => error.code === 'UNSAFE_STORE_PATH');
  const target = path.join(directory, 'target.json');
  fs.writeFileSync(target, '{}');
  const fileLink = path.join(directory, 'publication.json');
  fs.symlinkSync(target, fileLink, 'file');
  assert.throws(() => new PublicationStore(fileLink, { trustOptions }), error => error.code === 'UNSAFE_STORE_PATH');
});

test('tampered revision, identity receipt or private extra fields fail closed', async t => {
  const { trustOptions, submission } = await scenario();
  const file = temporaryFile(t);
  const store = new PublicationStore(file, { trustOptions });
  const result = store.append({ type: 'submission.created', payload: submission }, { expectedRevision: store.snapshot().revision });
  const value = JSON.parse(fs.readFileSync(file, 'utf8'));
  value.revision = `sha256:${'9'.repeat(64)}`;
  fs.writeFileSync(file, JSON.stringify(value));
  assert.throws(() => store.read(), error => error.code === 'REVISION_MISMATCH');

  value.revision = result.revision;
  value.events[0].payload.submitter.receipt.receiptDigest = `sha256:${'8'.repeat(64)}`;
  fs.writeFileSync(file, JSON.stringify(value));
  assert.throws(() => store.read(), error => error.code === 'INVALID_STORE');

  value.events[0].payload.secret = 'never';
  fs.writeFileSync(file, JSON.stringify(value));
  assert.throws(() => store.read(), error => error.code === 'INVALID_STORE');
});

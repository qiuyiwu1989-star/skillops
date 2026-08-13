import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createSkillProduct } from '../lib/market/domain.mjs';
import { CreatorWorkspaceStore, replayCreatorWorkspaceEvents } from '../lib/creator/creator-workspace-store.mjs';
import { normalizeRelease, releaseId, sourceId } from '../lib/registry-identity.mjs';

const AT = '2026-08-14T04:00:00.000Z';
const LATER = '2026-08-14T04:05:00.000Z';
const PUBLISHER_ID = `pub_${'b'.repeat(64)}`;
const D = char => `sha256:${char.repeat(64)}`;
const allowCreator = ({ publisherId }) => ({ decision: 'allow', publisherId });

function tempFile() {
  return path.join(fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'skillops-creator-')), 'creator.json');
}

function fixture() {
  const skillId = 'zaowuyun/enterprise-research';
  const packageDigest = D('3');
  const registryRelease = normalizeRelease({
    schemaVersion: 1,
    releaseId: releaseId({ skillId, version: '1.0.0', packageDigest }),
    skillId,
    version: '1.0.0',
    status: 'published',
    package: { packageDigest, manifestDigest: D('4'), storageRef: `cas:${packageDigest}` },
    compatibility: { contract: 'skillops.skill.v1', targets: ['node'] },
    assessmentRefs: ['assessment:creator'], reviewRefs: ['review:creator'],
    sourceRefs: [sourceId({ type: 'fixture', coordinate: 'fixture:creator-store' })],
    publishedAt: AT,
  });
  const parties = {
    creatorPublisherIds: [PUBLISHER_ID], rightsHolderPublisherId: PUBLISHER_ID,
    payeePublisherId: null, supportPublisherId: PUBLISHER_ID,
  };
  const product = createSkillProduct({
    publisherId: PUBLISHER_ID, productKey: 'enterprise-research', titleZh: '企业研究技能',
    summaryZh: '帮助企业完成结构化研究。', parties, createdAt: AT,
    skillId, releaseId: registryRelease.releaseId,
  }, { registryRelease });
  const resolvers = {
    resolvePublisher: ({ publisherId }) => publisherId === PUBLISHER_ID
      ? { publisherId, kind: 'organization', status: 'active', displayName: '企业创作者' } : null,
    resolveProduct: ({ productId }) => productId === product.productId ? product : null,
    resolveRegistryRelease: ({ releaseId: id }) => id === registryRelease.releaseId ? registryRelease : null,
  };
  return { registryRelease, product, resolvers };
}

function workspaceInput(product, createdAt = AT) {
  return {
    publisherId: PUBLISHER_ID, productId: product.productId, abilityType: 'skill',
    productKey: product.productKey, createdAt,
  };
}

function draftInput(workId, registryRelease, savedAt, titleZh) {
  return {
    workId,
    target: { skillId: registryRelease.skillId, releaseId: registryRelease.releaseId },
    metadata: {
      titleZh, summaryZh: '面向中国企业的结构化研究能力。', originalLanguage: 'zh-CN',
      titleOriginal: null, summaryOriginal: null,
    },
    categoryTags: ['企业服务'],
    pricingIntent: { model: 'paid', currency: 'CNY', amountMinor: 9900 },
    supportInfo: { model: 'enterprise_support', responseTimeText: '一个工作日内响应', supportRef: 'support:enterprise' },
    rightsDeclaration: {
      licenseRef: 'license:commercial-v1', declaredRights: ['invoke', 'organization_use'],
      sourceOwnership: 'original', evidenceRefs: ['evidence:ownership'], statementVersion: 'rights-v1',
    },
    savedAt,
  };
}

test('append-only store persists workspace and multiple immutable drafts across restart', () => {
  const file = tempFile();
  const { registryRelease, product, resolvers } = fixture();
  const store = new CreatorWorkspaceStore(file);
  const created = store.createWorkspace(workspaceInput(product), { expectedRevision: store.snapshot().revision, ...resolvers });
  const first = store.saveDraft(draftInput(created.workspace.workId, registryRelease, AT, '企业研究技能'), {
    expectedRevision: created.revision, ...resolvers,
  });
  const afterFirst = fs.readFileSync(file);
  const replay = store.saveDraft(draftInput(created.workspace.workId, registryRelease, AT, '企业研究技能'), {
    expectedRevision: first.revision, ...resolvers,
  });
  assert.equal(replay.action, 'unchanged');
  assert.equal(replay.draft.draftRevision, 1);
  assert.deepEqual(fs.readFileSync(file), afterFirst);
  const second = store.saveDraft(draftInput(created.workspace.workId, registryRelease, LATER, '企业研究技能 2.0'), {
    expectedRevision: first.revision, ...resolvers,
  });
  assert.equal(second.draft.draftRevision, 2);

  const restarted = new CreatorWorkspaceStore(file, { creatorProjectionAuthorizer: allowCreator });
  assert.equal(restarted.snapshot().eventCount, 3);
  const view = restarted.projectCreator({ publisherId: PUBLISHER_ID });
  assert.deepEqual(view.summary, { works: 1, drafts: 1 });
  assert.equal(view.works[0].currentDraftRevision, 2);
  assert.equal(view.works[0].timeline.length, 2);
  assert.equal(view.works[0].nextAction, '提交发布审核');
  assert.equal(restarted.write, undefined);
});

test('identical request is idempotent and duplicate stable productKey identity conflicts without mutation', () => {
  const file = tempFile();
  const { product, resolvers } = fixture();
  const store = new CreatorWorkspaceStore(file);
  const first = store.createWorkspace(workspaceInput(product), { expectedRevision: store.snapshot().revision, ...resolvers });
  const bytes = fs.readFileSync(file);
  const replay = store.createWorkspace(workspaceInput(product), { expectedRevision: first.revision, ...resolvers });
  assert.equal(replay.action, 'unchanged');
  assert.deepEqual(fs.readFileSync(file), bytes);
  assert.throws(() => store.createWorkspace(workspaceInput(product, LATER), {
    expectedRevision: first.revision, ...resolvers,
  }), error => error.code === 'WORKSPACE_CONFLICT');
  assert.deepEqual(fs.readFileSync(file), bytes);
});

test('creator projection requires trusted scoped authorization while public projection exposes no private draft metadata', () => {
  const file = tempFile();
  const { registryRelease, product, resolvers } = fixture();
  const store = new CreatorWorkspaceStore(file);
  const created = store.createWorkspace(workspaceInput(product), { expectedRevision: store.snapshot().revision, ...resolvers });
  store.saveDraft(draftInput(created.workspace.workId, registryRelease, AT, '企业私有草稿'), {
    expectedRevision: created.revision, ...resolvers,
  });
  assert.throws(() => store.projectCreator({ publisherId: PUBLISHER_ID }), error => error.code === 'CREATOR_PROJECTION_AUTHORITY_REQUIRED');
  const denied = new CreatorWorkspaceStore(file, { creatorProjectionAuthorizer: () => ({ decision: 'deny', publisherId: PUBLISHER_ID }) });
  assert.throws(() => denied.projectCreator({ publisherId: PUBLISHER_ID }), error => error.code === 'CREATOR_PROJECTION_FORBIDDEN');
  const wrongPublisher = new CreatorWorkspaceStore(file, {
    creatorProjectionAuthorizer: () => ({ decision: 'allow', publisherId: `pub_${'c'.repeat(64)}` }),
  });
  assert.throws(() => wrongPublisher.projectCreator({ publisherId: PUBLISHER_ID }), error => error.code === 'CREATOR_PROJECTION_FORBIDDEN');
  const allowed = new CreatorWorkspaceStore(file, { creatorProjectionAuthorizer: allowCreator });
  assert.equal(allowed.projectCreator({ publisherId: PUBLISHER_ID }).works.length, 1);
  assert.equal(new CreatorWorkspaceStore(file, { creatorProjectionAuthorizer: () => true })
    .projectCreator({ publisherId: PUBLISHER_ID }).works.length, 1);
  assert.deepEqual(store.projectPublic(), { schemaVersion: 1, works: [] });
  const publicBytes = JSON.stringify(store.projectPublic());
  for (const hidden of ['企业私有草稿', 'draftDigest', 'rightsDeclaration', 'evidence:ownership']) {
    assert.equal(publicBytes.includes(hidden), false);
  }
});

test('revision CAS and injected write failure preserve the prior history', () => {
  const file = tempFile();
  const { product, resolvers } = fixture();
  const store = new CreatorWorkspaceStore(file);
  assert.throws(() => store.createWorkspace(workspaceInput(product), {
    expectedRevision: 'sha256:stale', ...resolvers,
  }), error => error.code === 'REVISION_CONFLICT');
  assert.equal(fs.existsSync(file), false);
  const faulty = new CreatorWorkspaceStore(file, {
    faultInjector: stage => { if (stage === 'beforeRename') throw new Error('fixture failure'); },
  });
  assert.throws(() => faulty.createWorkspace(workspaceInput(product), {
    expectedRevision: faulty.snapshot().revision, ...resolvers,
  }), /fixture failure/);
  assert.equal(fs.existsSync(file), false);
});

test('symlink and hard resource limits fail before polluted state is accepted', t => {
  if (process.platform !== 'win32') {
    const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'skillops-creator-root-'));
    const outside = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'skillops-creator-outside-'));
    fs.symlinkSync(outside, path.join(root, 'state'));
    assert.throws(() => new CreatorWorkspaceStore(path.join(root, 'state', 'creator.json')), error => error.code === 'UNSAFE_STORE_PATH');
    assert.deepEqual(fs.readdirSync(outside), []);
  } else t.diagnostic('symlink fixture skipped on Windows');

  assert.throws(() => replayCreatorWorkspaceEvents(new Array(100_001).fill(null)), error => error.code === 'EVENT_LIMIT_EXCEEDED');
  const oversized = tempFile();
  fs.writeFileSync(oversized, Buffer.alloc(32 * 1024 * 1024 + 1));
  assert.throws(() => new CreatorWorkspaceStore(oversized).read(), error => error.code === 'UNSAFE_STORE_PATH');
});

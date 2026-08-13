import assert from 'node:assert/strict';
import test from 'node:test';

import { digest } from '../lib/commerce/common.mjs';
import { issueEntitlement } from '../lib/commerce/entitlement.mjs';
import { createOffer } from '../lib/commerce/offer.mjs';
import { createFreeOrder } from '../lib/commerce/order.mjs';
import { createSkillStewardPlan, SkillStewardError } from '../lib/demand/skill-steward.mjs';

const h = value => `sha256:${String(value).padStart(64, '0').slice(-64)}`;
const product = number => `prod_${String(number).padStart(64, '0')}`;
const release = number => `rel_${String(number).padStart(64, '0')}`;
const entitlement = number => `ent_${String(number).padStart(64, '0')}`;
const NOW = '2026-08-14T05:00:00.000Z';

function catalog(items) {
  const summary = { total: items.length, entitled: items.filter(item => item.acquisition.state === 'entitled').length, freeAvailable: items.filter(item => item.acquisition.state === 'free_available').length, purchaseRequired: items.filter(item => item.acquisition.state === 'purchase_required').length, unavailable: items.filter(item => item.acquisition.state === 'unavailable').length };
  const value = { schemaVersion: 1, organizationId: 'org_acme', generatedAt: NOW, sourceCatalogDigest: h(8), summary, items };
  return { ...value, projectionDigest: digest(value) };
}
function library(items) {
  const summary = { total: items.length, callable: items.filter(item => item.callable).length, blocked: items.filter(item => !item.callable).length, withdrawn: items.filter(item => item.status === 'withdrawn').length };
  const value = { schemaVersion: 1, organizationId: 'org_acme', generatedAt: NOW, summary, items };
  return { ...value, projectionDigest: digest(value) };
}
function validators() {
  const validate = value => {
    const { projectionDigest, ...body } = structuredClone(value);
    if (digest(body) !== projectionDigest) throw new Error('digest mismatch');
    return Object.freeze(structuredClone(value));
  };
  return { catalogValidator: validate, libraryValidator: validate };
}
function item(number, state, title, signals, extra = {}) {
  const grant = state === 'entitled' ? entry(number) : null;
  return {
    productId: product(number), releaseId: release(number), abilityType: 'skill', productKey: `skill-${number}`, titleZh: title,
    summaryZh: `${title}用于企业任务。`, publisher: { publisherId: `pub_${String(number).padStart(64, '0')}`, displayName: '造物云能力中心', kind: 'organization', status: 'active' }, version: '1.0.0',
    categoryTags: signals, taskSignals: { intentTags: signals, routingSummary: `${title}适合${signals.join('、')}任务。`, whenToUse: [`需要${title}时`] }, requiredPermissions: extra.requiredPermissions ?? [],
    publication: { status: 'published', enforcementStatus: 'published', submissionId: `sub_${String(number).padStart(64, '0')}`, evidenceDigest: h(1), licensePolicyDigest: h(2), marketRegistryRevision: h(3), publishedAt: NOW },
    offer: state === 'unavailable' ? null : { offerId: `offer_${number}`, offerRevisionId: `offrev_${String(number).padStart(64, '0')}`, pricing: { model: state === 'purchase_required' ? 'one_time' : 'free', currency: 'CNY', amountMinor: state === 'purchase_required' ? 9900 : 0 }, licenseRights: ['invoke'], effectiveAt: NOW },
    acquisition: {
      state, code: state.toUpperCase(), reasonZh: extra.reasonZh ?? '目录给出的可验证获取状态',
      entitlementId: grant?.entitlementId ?? null, grantedRights: grant ? ['invoke'] : [],
    }, dependencies: extra.dependencies ?? [], callable: state === 'entitled',
  };
}
function entry(number) {
  const licensePolicy = { rights: ['invoke'], constraints: { organizationIds: ['org_acme'], projectIds: ['project_alpha'], environments: ['staging'], releaseIds: [release(number)], seatLimit: null, invocationLimit: null, validFrom: null, validUntil: null } };
  const offer = createOffer({ offerId: `offer_free_${number}`, productId: product(number), pricing: { model: 'free', currency: 'CNY', amountMinor: 0 }, licensePolicy, effectiveAt: NOW });
  const order = createFreeOrder({ orderId: `ord_free_${number}`, organizationId: 'org_acme', productId: product(number), releaseScope: { releaseIds: [release(number)] }, offerRevisionId: offer.offerRevisionId, idempotencyKey: `idem:free:${number}` }, { offerResolver: () => ({ offerRevision: offer, currentOfferRevisionId: offer.offerRevisionId }), productResolver: id => ({ productId: id, status: 'published' }), releaseResolver: id => ({ releaseId: id, productId: product(number), status: 'published' }), now: () => NOW });
  const grant = issueEntitlement({ order, issuedAt: NOW });
  return { entitlementId: grant.entitlementId, entitlementDigest: grant.entitlementDigest, organizationId: 'org_acme', productId: product(number), abilityType: 'skill', titleZh: `能力 ${number}`, releaseIds: [release(number)], releases: [{ releaseId: release(number), productId: product(number), status: 'published' }], rights: grant.rights, constraints: grant.constraints, validFrom: grant.validFrom, validUntil: grant.validUntil, sourceOrder: { orderId: order.orderId, orderDigest: order.orderDigest, offerRevisionId: offer.offerRevisionId }, status: 'callable', callable: true, blockReason: null, entitlement: grant, entitlementLifecycle: { status: 'active', revocation: null } };
}
const entitlementId = number => entry(number).entitlementId;
function input(tags = ['公文写作']) {
  return { task: { summaryZh: '需要协助起草一份正式公文', intentTags: tags }, context: { organizationId: 'org_acme', projectId: 'project_alpha', environment: 'staging', allowedPermissions: ['document.read'], requiredRights: ['invoke'] } };
}
function allow(query) {
  return { schemaVersion: 1, decision: 'allow', code: 'ACCESS_ALLOWED', entitlementId: query.entitlementIds[0], organizationId: query.organizationId, productId: query.productId, releaseId: query.releaseId, grantedRights: query.requiredRights, checkedAt: query.checkedAt };
}
function options(catalogProjection, libraryProjection, accessDecisionResolver = allow) {
  return { catalogProjection, libraryProjection, ...validators(), accessDecisionResolver, now: NOW };
}

test('已授权推荐生成多步骤、不可执行且精确绑定的 WorkOrder 草案', () => {
  const projection = catalog([item(1, 'entitled', '中文公文写作', ['公文写作']), item(2, 'entitled', '材料校对', ['公文写作'])]);
  const plan = createSkillStewardPlan(input(), options(projection, library([entry(1), entry(2)])));
  assert.equal(plan.status, 'ready');
  assert.equal(plan.workOrderDraft.nonExecutable, true);
  assert.equal(plan.workOrderDraft.adapter, 'code.zaowuyun.future.v1');
  assert.equal(plan.workOrderDraft.steps.length, 2);
  assert.deepEqual(plan.workOrderDraft.steps[0], { position: 1, productId: product(1), releaseId: release(1), entitlementId: entitlementId(1), rights: ['invoke'], environment: 'staging', dependencyOf: null });
  assert.equal('summaryZh' in plan, false);
  assert.match(plan.taskSummaryDigest, /^sha256:/);
  assert.doesNotMatch(JSON.stringify(plan), /shell|command|https?:\/\//i);
});

test('AccessDecision 返回额外权利时 WorkOrder 仍只冻结任务所需权利', () => {
  const projection = catalog([item(1, 'entitled', '中文公文写作', ['公文写作'])]);
  const broad = query => ({ ...allow(query), grantedRights: ['derive', 'invoke'] });
  const plan = createSkillStewardPlan(input(), options(projection, library([entry(1)]), broad));
  assert.deepEqual(plan.workOrderDraft.steps[0].rights, ['invoke']);
});

test('免费和付费能力都只要求人工获取，不生成订单、授权或 WorkOrder', () => {
  for (const state of ['free_available', 'purchase_required']) {
    const plan = createSkillStewardPlan(input(), options(catalog([item(1, state, '中文公文写作', ['公文写作'])]), library([])));
    assert.equal(plan.status, 'acquisition_required');
    assert.equal(plan.workOrderDraft, null);
    assert.match(plan.recommendations[0].code, /CONFIRMATION_REQUIRED/);
    assert.doesNotMatch(JSON.stringify(plan), /orderId|立即获取|自动购买/);
  }
});

test('召回、权限不足和 AccessDecision 拒绝均阻断且不生成草案', () => {
  const denied = query => ({ schemaVersion: 1, decision: 'deny', code: 'RELEASE_RECALLED', entitlementId: null, organizationId: query.organizationId, productId: query.productId, releaseId: query.releaseId, grantedRights: [], checkedAt: query.checkedAt });
  let plan = createSkillStewardPlan(input(), options(catalog([item(1, 'entitled', '中文公文写作', ['公文写作'])]), library([entry(1)]), denied));
  assert.equal(plan.status, 'blocked');
  assert.equal(plan.recommendations[0].code, 'RELEASE_RECALLED');
  plan = createSkillStewardPlan(input(), options(catalog([item(1, 'entitled', '中文公文写作', ['公文写作'], { requiredPermissions: ['network.external'] })]), library([entry(1)])));
  assert.equal(plan.status, 'blocked');
  assert.equal(plan.recommendations[0].code, 'PERMISSION_NOT_ALLOWED');
});

test('不信任目录状态、授权库条目或未绑定的 AccessDecision', () => {
  const catalogProjection = catalog([item(1, 'entitled', '中文公文写作', ['公文写作'])]);
  const libraryProjection = library([entry(1)]);
  const tampered = structuredClone(catalogProjection);
  tampered.items[0].titleZh = '篡改';
  assert.throws(() => createSkillStewardPlan(input(), options(tampered, libraryProjection)), error => error instanceof SkillStewardError && error.code === 'CATALOG_NOT_TRUSTED');
  assert.throws(() => createSkillStewardPlan(input(), options(catalogProjection, { ...libraryProjection, projectionDigest: h(9) })), error => error.code === 'LIBRARY_NOT_TRUSTED');
  assert.throws(() => createSkillStewardPlan(input(), options(catalogProjection, libraryProjection, query => ({ ...allow(query), productId: product(9) }))), error => error.code === 'ACCESS_DECISION_NOT_TRUSTED');
  assert.throws(() => createSkillStewardPlan(input(), options(catalogProjection, libraryProjection, query => ({ ...allow(query), entitlementId: entitlementId(9) }))), error => error.code === 'ENTITLEMENT_BINDING_MISMATCH');
});

test('组织范围、输入白名单、摘要隐私和正式 validator 都失败关闭', () => {
  const projection = catalog([item(1, 'entitled', '中文公文写作', ['公文写作'])]);
  const base = options(projection, library([entry(1)]));
  assert.throws(() => createSkillStewardPlan({ ...input(), secret: 'x' }, base), error => error.code === 'UNKNOWN_FIELD');
  assert.throws(() => createSkillStewardPlan({ ...input(), task: { summaryZh: '/Users/qiu/private', intentTags: ['公文写作'] } }, base), error => error.code === 'PRIVATE_VALUE_FORBIDDEN');
  assert.throws(() => createSkillStewardPlan(input(), { ...base, catalogValidator: undefined }), error => error.code === 'CATALOG_VALIDATOR_REQUIRED');
  assert.throws(() => createSkillStewardPlan(input(), { ...base, libraryValidator: undefined }), error => error.code === 'LIBRARY_VALIDATOR_REQUIRED');
  const wrongLibrary = library([]); wrongLibrary.organizationId = 'org_other'; wrongLibrary.projectionDigest = digest({ schemaVersion: 1, organizationId: 'org_other', generatedAt: NOW, summary: wrongLibrary.summary, items: wrongLibrary.items });
  assert.throws(() => createSkillStewardPlan(input(), { ...base, libraryProjection: wrongLibrary }), error => error.code === 'ORGANIZATION_SCOPE_MISMATCH');
});

test('相同受信输入输出稳定，未匹配能力说明未选原因', () => {
  const projection = catalog([item(1, 'entitled', '中文公文写作', ['公文写作']), item(2, 'free_available', '图片生成', ['设计'])]);
  const first = createSkillStewardPlan(input(), options(projection, library([entry(1)])));
  const second = createSkillStewardPlan(input(), options(projection, library([entry(1)])));
  assert.equal(first.planDigest, second.planDigest);
  assert.equal(first.notSelected[0].productId, product(2));
  assert.equal(first.notSelected[0].code, 'NO_INTENT_MATCH');
});

test('可用候选不会被另一个不可用的替代候选整体阻断', () => {
  const projection = catalog([
    item(1, 'entitled', '中文公文写作', ['公文写作']),
    item(2, 'unavailable', '已召回公文助手', ['公文写作'], { reasonZh: '高危召回，当前不可用' }),
  ]);
  const plan = createSkillStewardPlan(input(), options(projection, library([entry(1)])));
  assert.equal(plan.status, 'ready');
  assert.equal(plan.recommendations.find(value => value.productId === product(2)).status, 'blocked');
  assert.equal(plan.workOrderDraft.steps.length, 1);
  assert.equal(plan.workOrderDraft.steps[0].productId, product(1));
});

test('Application必需依赖逐项复核企业库与AccessDecision并固定到WorkOrder', () => {
  const app = item(3, 'entitled', '企业公文应用', ['公文写作'], { dependencies: [{ productId: product(1), releaseId: release(1), skillId: 'zaowuyun/writing', requirement: 'required', requiredRights: ['invoke'], requiredPermissions: [], acquisition: { state: 'entitled', code: 'ENTITLEMENT_VALID', reasonZh: '已授权', entitlementId: entitlementId(1), grantedRights: ['invoke'] } }] });
  app.abilityType = 'application';
  const appEntry = entry(3), dependencyEntry = entry(1);
  let plan = createSkillStewardPlan(input(), options(catalog([app]), library([appEntry, dependencyEntry])));
  assert.equal(plan.status, 'ready');
  assert.equal(plan.workOrderDraft.steps.length, 2);
  assert.equal(plan.workOrderDraft.steps[1].dependencyOf, product(3));
  assert.equal(plan.workOrderDraft.steps[1].entitlementId, dependencyEntry.entitlementId);
  const denyDependency = query => query.productId === product(1)
    ? { schemaVersion: 1, decision: 'deny', code: 'PROJECT_NOT_GRANTED', entitlementId: null, organizationId: query.organizationId, productId: query.productId, releaseId: query.releaseId, grantedRights: [], checkedAt: query.checkedAt }
    : allow(query);
  plan = createSkillStewardPlan(input(), options(catalog([app]), library([appEntry, dependencyEntry]), denyDependency));
  assert.equal(plan.status, 'blocked');
  assert.equal(plan.recommendations[0].code, 'REQUIRED_DEPENDENCY_PROJECT_NOT_GRANTED');
  assert.equal(plan.workOrderDraft, null);
});

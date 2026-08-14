import { digest, deepFreeze, exactKeys, text } from '../trusted-supply/lib/commerce/common.mjs';
import { createLicensePolicy } from '../trusted-supply/lib/commerce/license-policy.mjs';
import { createOffer } from '../trusted-supply/lib/commerce/offer.mjs';
import { AcquisitionLedger } from '../trusted-supply/lib/demand/free-acquisition.mjs';

export const PREVIEW_ORGANIZATION_ID = 'org_zaowuyun_preview';
export const PREVIEW_ORGANIZATION_LABEL_ZH = '造物云演示企业';

const PRODUCT_ID = /^prod_[a-f0-9]{64}$/;
const RELEASE_ID = /^rel_[a-f0-9]{64}$/;
const OFFER_REVISION_ID = /^offrev_[a-f0-9]{64}$/;
const IDEMPOTENCY_KEY = /^[a-z][a-z0-9._:-]{1,127}$/;
const REQUEST_KEYS = new Set(['productId', 'releaseId', 'offerRevisionId', 'idempotencyKey']);

const EXISTING_PRODUCT_ID = `prod_${'a'.repeat(64)}`;
const EXISTING_RELEASE_ID = `rel_${'b'.repeat(64)}`;
const EXISTING_ENTITLEMENT_ID = `ent_${'c'.repeat(64)}`;
const FREE_PRODUCT_ID = `prod_${'d'.repeat(64)}`;
const FREE_RELEASE_ID = `rel_${'e'.repeat(64)}`;
const PAID_PRODUCT_ID = `prod_${'1'.repeat(64)}`;
const PAID_RELEASE_ID = `rel_${'2'.repeat(64)}`;
const UNAVAILABLE_PRODUCT_ID = `prod_${'3'.repeat(64)}`;
const UNAVAILABLE_RELEASE_ID = `rel_${'4'.repeat(64)}`;

const FREE_OFFER = createOffer({
  offerId: 'offer_preview_fact_check',
  productId: FREE_PRODUCT_ID,
  pricing: { model: 'free', currency: 'CNY', amountMinor: 0 },
  licensePolicy: createLicensePolicy({
    rights: ['invoke', 'organization_use'],
    constraints: {
      organizationIds: [PREVIEW_ORGANIZATION_ID],
      projectIds: [],
      environments: [],
      releaseIds: [FREE_RELEASE_ID],
      seatLimit: null,
      invocationLimit: null,
      validFrom: null,
      validUntil: null,
    },
  }),
  effectiveAt: '2026-01-01T00:00:00.000Z',
});

const BASE_PRODUCTS = Object.freeze([
  {
    productId: EXISTING_PRODUCT_ID,
    releaseId: EXISTING_RELEASE_ID,
    abilityType: 'skill',
    titleZh: '中文公文写作',
    summaryZh: '面向通知、请示、报告与纪要的企业写作能力，已进入演示企业能力库。',
    categoryZh: '办公效率',
    trustLabelZh: '已通过发布审核',
    pricing: { model: 'free', currency: 'CNY', amountMinor: 0, labelZh: '企业已获取' },
    acquisition: {
      state: 'entitled',
      code: 'ENTITLEMENT_ACTIVE',
      reasonZh: '演示企业已有有效调用授权',
      nextActionZh: '交给技能管家',
      entitlementId: EXISTING_ENTITLEMENT_ID,
      offerRevisionId: null,
      source: 'trusted_fixture',
    },
    publication: { status: 'published' },
  },
  {
    productId: FREE_PRODUCT_ID,
    releaseId: FREE_RELEASE_ID,
    abilityType: 'skill',
    titleZh: '材料事实校验',
    summaryZh: '检查材料中的事实、口径和引用风险，免费获取后进入企业能力库。',
    categoryZh: '研究洞察',
    trustLabelZh: '已通过发布审核',
    pricing: { model: 'free', currency: 'CNY', amountMinor: 0, labelZh: '免费' },
    acquisition: {
      state: 'free_available',
      code: 'FREE_OFFER_AVAILABLE',
      reasonZh: '当前组织可免费获取此发行版本',
      nextActionZh: '免费获取',
      entitlementId: null,
      offerRevisionId: FREE_OFFER.offerRevisionId,
      source: 'local_acquisition_service',
    },
    publication: { status: 'published' },
  },
  {
    productId: PAID_PRODUCT_ID,
    releaseId: PAID_RELEASE_ID,
    abilityType: 'application',
    titleZh: '企业报告工作台',
    summaryZh: '组合研究、写作和复核技能的企业报告应用，需要完成组织采购。',
    categoryZh: '企业应用',
    trustLabelZh: '已发布，等待采购授权',
    pricing: { model: 'one_time', currency: 'CNY', amountMinor: 29900, labelZh: '¥299 / 组织' },
    acquisition: {
      state: 'purchase_required',
      code: 'PURCHASE_REQUIRED',
      reasonZh: '当前组织尚未取得付费授权',
      nextActionZh: '查看采购方式',
      entitlementId: null,
      offerRevisionId: null,
      source: 'trusted_fixture',
    },
    publication: { status: 'published' },
  },
  {
    productId: UNAVAILABLE_PRODUCT_ID,
    releaseId: UNAVAILABLE_RELEASE_ID,
    abilityType: 'skill',
    titleZh: '旧版敏感信息扫描',
    summaryZh: '该发行版本已召回，市场保留状态说明但不允许获取或调用。',
    categoryZh: '安全治理',
    trustLabelZh: '安全召回',
    pricing: { model: 'free', currency: 'CNY', amountMinor: 0, labelZh: '不可获取' },
    acquisition: {
      state: 'unavailable',
      code: 'RELEASE_RECALLED',
      reasonZh: '当前发行版本已召回',
      nextActionZh: '等待替代版本',
      entitlementId: null,
      offerRevisionId: null,
      source: 'trusted_fixture',
    },
    publication: { status: 'recalled' },
  },
]);

export class PreviewAcquisitionError extends Error {
  constructor(code, messageZh, statusCode = 400, cause) {
    super(messageZh, cause ? { cause } : undefined);
    this.name = 'PreviewAcquisitionError';
    this.code = code;
    this.messageZh = messageZh;
    this.statusCode = statusCode;
  }
}

function fail(code, messageZh, statusCode = 400, cause) {
  throw new PreviewAcquisitionError(code, messageZh, statusCode, cause);
}

function trustedClock(clock) {
  if (typeof clock !== 'function') fail('TRUSTED_CLOCK_REQUIRED', '本地获取服务缺少可信时钟', 500);
  const value = clock();
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) fail('TRUSTED_CLOCK_FAILED', '本地获取服务时钟无效', 500);
  return date.toISOString();
}

function normalizeRequest(input) {
  try {
    exactKeys(input, REQUEST_KEYS, 'previewAcquisitionRequest');
    return {
      productId: text(input.productId, 'previewAcquisitionRequest.productId', { maximum: 69, pattern: PRODUCT_ID }),
      releaseId: text(input.releaseId, 'previewAcquisitionRequest.releaseId', { maximum: 69, pattern: RELEASE_ID }),
      offerRevisionId: text(input.offerRevisionId, 'previewAcquisitionRequest.offerRevisionId', { maximum: 71, pattern: OFFER_REVISION_ID }),
      idempotencyKey: text(input.idempotencyKey, 'previewAcquisitionRequest.idempotencyKey', { maximum: 128, pattern: IDEMPOTENCY_KEY }),
    };
  } catch (cause) {
    fail(cause.code ?? 'INVALID_REQUEST', '免费获取请求格式不受支持', 400, cause);
  }
}

function safeGrant(entitlement) {
  return {
    entitlementId: entitlement.entitlementId,
    entitlementDigest: entitlement.entitlementDigest,
    productId: entitlement.productId,
    releaseId: entitlement.releaseScope.releaseIds[0],
    rights: [...entitlement.rights],
    issuedAt: entitlement.issuedAt,
    validUntil: entitlement.validUntil,
  };
}

function projectionBody({ generatedAt, products, mode }) {
  const summary = {
    total: products.length,
    entitled: products.filter(item => item.acquisition.state === 'entitled').length,
    freeAvailable: products.filter(item => item.acquisition.state === 'free_available').length,
    purchaseRequired: products.filter(item => item.acquisition.state === 'purchase_required').length,
    unavailable: products.filter(item => item.acquisition.state === 'unavailable').length,
  };
  return {
    schemaVersion: 1,
    generatedAt,
    mode,
    organization: {
      organizationId: PREVIEW_ORGANIZATION_ID,
      labelZh: PREVIEW_ORGANIZATION_LABEL_ZH,
    },
    summary,
    products,
  };
}

export function createPreviewAcquisitionService({ ledgerPath, clock = () => new Date() } = {}) {
  if (typeof ledgerPath !== 'string' || !ledgerPath.trim()) fail('LEDGER_PATH_REQUIRED', '本地授权账本路径不能为空', 500);
  const ledger = new AcquisitionLedger(ledgerPath);

  function catalog() {
    const projection = ledger.project();
    const acquired = Object.values(projection.entitlements).find(entitlement => (
      entitlement.organizationId === PREVIEW_ORGANIZATION_ID
      && entitlement.productId === FREE_PRODUCT_ID
      && entitlement.releaseScope.releaseIds.includes(FREE_RELEASE_ID)
      && projection.entitlementLifecycle[entitlement.entitlementId]?.status === 'active'
    ));
    const products = structuredClone(BASE_PRODUCTS);
    if (acquired) {
      const product = products.find(item => item.productId === FREE_PRODUCT_ID);
      product.acquisition = {
        state: 'entitled',
        code: 'ENTITLEMENT_ACTIVE',
        reasonZh: '免费获取已完成，能力已进入企业授权库',
        nextActionZh: '交给技能管家',
        entitlementId: acquired.entitlementId,
        offerRevisionId: FREE_OFFER.offerRevisionId,
        source: 'local_acquisition_ledger',
      };
      product.pricing.labelZh = '企业已获取';
    }
    const body = projectionBody({ generatedAt: trustedClock(clock), products, mode: 'local_service' });
    return deepFreeze({ ...body, projectionDigest: digest(body) });
  }

  function acquire(input) {
    const request = normalizeRequest(input);
    if (request.productId !== FREE_PRODUCT_ID || request.releaseId !== FREE_RELEASE_ID
      || request.offerRevisionId !== FREE_OFFER.offerRevisionId) {
      fail('FREE_OFFER_MISMATCH', '该商品不能通过免费获取接口处理', 422);
    }
    try {
      const current = ledger.read();
      const result = ledger.acquire({
        organizationId: PREVIEW_ORGANIZATION_ID,
        productId: request.productId,
        releaseIds: [request.releaseId],
        offerRevisionId: request.offerRevisionId,
        idempotencyKey: request.idempotencyKey,
      }, {
        expectedRevision: current.revision,
        offerResolver: offerRevisionId => ({
          offerRevision: FREE_OFFER,
          currentOfferRevisionId: offerRevisionId === FREE_OFFER.offerRevisionId ? FREE_OFFER.offerRevisionId : null,
        }),
        publicationResolver: {
          resolveOrderProduct: productId => productId === FREE_PRODUCT_ID
            ? { productId: FREE_PRODUCT_ID, status: 'published' }
            : null,
          resolveOrderRelease: releaseId => releaseId === FREE_RELEASE_ID
            ? { releaseId: FREE_RELEASE_ID, productId: FREE_PRODUCT_ID, status: 'published' }
            : null,
        },
        organizationAuthorizer: () => ({ decision: 'allow', organizationId: PREVIEW_ORGANIZATION_ID }),
        now: () => trustedClock(clock),
      });
      const body = {
        schemaVersion: 1,
        action: result.action,
        revision: result.revision,
        grant: safeGrant(result.entitlement),
      };
      return deepFreeze({ ...body, responseDigest: digest(body), projection: catalog() });
    } catch (cause) {
      if (cause instanceof PreviewAcquisitionError) throw cause;
      const statusCode = cause?.code === 'IDEMPOTENCY_CONFLICT' ? 409 : 422;
      fail(cause?.code ?? 'ACQUISITION_REJECTED', '免费获取未完成，请检查商品状态后重试', statusCode, cause);
    }
  }

  return Object.freeze({ catalog, acquire });
}

export const PREVIEW_FREE_OFFER_REVISION_ID = FREE_OFFER.offerRevisionId;
export const PREVIEW_FREE_PRODUCT_ID = FREE_PRODUCT_ID;
export const PREVIEW_FREE_RELEASE_ID = FREE_RELEASE_ID;

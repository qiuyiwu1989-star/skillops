import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { merchandisingForListing, offerForListing, publisherForListing } from '../market-merchandising.mjs';
import { createPreviewServer } from '../serve.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const read = name => fs.readFileSync(path.resolve(HERE, '..', name), 'utf8');
const app = read('app.js');
const detail = read('detail.js');
const css = read('styles.css');
const serve = read('serve.mjs');

const listing = {
  distribution: 'content',
  source: { repo: 'qiuyiwu1989-star/skillops' },
  catalog: {
    publisher: {
      displayNameZh: '造物云 SkillOps',
      handle: 'qiuyiwu1989-star',
      kind: 'organization',
      verificationLabelZh: '来源已核验',
      creatorUrl: './creator.html',
    },
    offer: {
      status: 'demo',
      pricing: { model: 'one_time', currency: 'CNY', amountMinor: 9900, labelZh: '¥99 / 组织' },
      rightsLabelZh: '企业内体验与调用',
      acquisitionLabelZh: '获取企业授权后调用',
      noteZh: '演示报价，不形成授权',
    },
  },
};

test('商品展示契约区分创作者、价格、权利与获取动作', () => {
  const value = merchandisingForListing(listing);
  assert.equal(value.publisher.displayNameZh, '造物云 SkillOps');
  assert.equal(value.publisher.creatorUrl, './creator.html');
  assert.equal(value.offer.pricing.labelZh, '¥99 / 组织');
  assert.equal(value.offer.rightsLabelZh, '企业内体验与调用');
  assert.equal(value.offer.acquisitionLabelZh, '获取企业授权后调用');
  assert.equal(Object.isFrozen(value.offer.pricing), true);
});

test('缺少正式 Offer 时诚实回退，不把可分发许可证冒充企业授权', () => {
  const publisher = publisherForListing({ source: { repo: 'team-alpha/repo' } });
  const offer = offerForListing({ distribution: 'content' });
  assert.equal(publisher.displayNameZh, 'team-alpha');
  assert.equal(offer.pricing.labelZh, '价格待发布');
  assert.equal(offer.rightsLabelZh, '在线体验与评估');
  assert.match(offer.acquisitionLabelZh, /企业授权/);
});

test('不安全或伪造不完整的市场字段失败关闭为可信回退', () => {
  const bad = {
    distribution: 'source_link_only',
    catalog: {
      publisher: { displayNameZh: '读取:/etc/passwd', handle: 'x', kind: 'organization', verificationLabelZh: '已认证' },
      offer: { status: 'active', pricing: { model: 'free', currency: 'CNY', amountMinor: 1, labelZh: '免费' } },
    },
  };
  assert.equal(publisherForListing(bad).displayNameZh, '来源待确认');
  assert.equal(offerForListing(bad).pricing.labelZh, '价格待发布');
  assert.equal(offerForListing(bad).rightsLabelZh, '仅查看来源');
});

test('市场卡片与详情共同展示商品信息，可信指标仍独立', () => {
  assert.match(app, /className = 'creator-profile'/);
  assert.match(app, /className = 'offer-panel'/);
  assert.match(app, /marketplace\.publisher\.displayNameZh/);
  assert.match(app, /marketplace\.offer\.pricing\.labelZh/);
  assert.match(app, /SMS 静态潜力/);
  assert.match(app, /Eval 运行实绩/);
  assert.match(detail, /创作者/);
  assert.match(detail, /当前价格/);
  assert.match(detail, /授权方式/);
  assert.match(css, /\.marketplace-strip\s*\{/);
  assert.match(css, /\.offer-price\s*\{/);
});

test('市场商品信息在移动端显式单列，不挤压主操作', () => {
  assert.match(css, /@media \(max-width: 640px\)[\s\S]*\.marketplace-strip\s*\{[^}]*grid-template-columns:\s*1fr/s);
  assert.match(css, /\.creator-name,[^}]*\.offer-price\s*\{[^}]*overflow-wrap:\s*anywhere/s);
  assert.match(serve, /\['\.mjs', 'text\/javascript; charset=utf-8'\]/);
});

test('本地服务以 JavaScript MIME 提供共享商品契约', async t => {
  const server = createPreviewServer({ root: path.resolve(HERE, '..') });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const response = await fetch(`http://127.0.0.1:${server.address().port}/market-merchandising.mjs`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type') || '', /^text\/javascript/);
  assert.match(await response.text(), /merchandisingForListing/);
});

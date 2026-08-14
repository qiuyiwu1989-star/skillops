import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE=path.dirname(fileURLToPath(import.meta.url));
const read=name=>fs.readFileSync(path.resolve(HERE,'..',name),'utf8');
const HTML=read('enterprise.html');
const CSS=read('enterprise.css');
const TOKENS=read('zaowuyun-tokens.css');
const MARK=read('zaowuyun-mark-color.svg');
const JS=read('enterprise.js');
const SERVE=read('serve.mjs');
const FIXTURE=JSON.parse(read('enterprise.fixture.json'));
const {normalizeEnterpriseWorkbench}=await import(pathToFileURL(path.resolve(HERE,'../enterprise.js')));

test('中文只读企业开发台覆盖自研、授权二创、证据、血缘、升级与回滚',()=>{
  for(const phrase of ['企业技能开发台','企业自研','授权二创','版本与治理证据','来源与根血缘','上游差异','回滚状态','升级与回滚记录'])assert.match(HTML+JS,new RegExp(phrase));
  assert.match(HTML,/组织范围 · 本地只读/);
  assert.match(HTML+JS,/演示摘要/);
  assert.match(HTML+JS,/不构成授权或签名验证|不代表已验证服务端签名/);
  assert.doesNotMatch(HTML+JS,/组织授权 · 本地只读|投影锚|组织授权范围/);
  assert.match(HTML,/aria-live="polite"/);
  assert.match(HTML,/skip-link/);
  assert.doesNotMatch(HTML,/<form|<button|<input|<textarea|contenteditable|type="file"/);
  assert.doesNotMatch(HTML+JS,/立即购买|自动下单|开始执行|确认发布|确认回滚/);
});

test('无外部资源、危险 DOM sink、写请求、上传或执行入口',()=>{
  assert.doesNotMatch(HTML,/https?:\/\/|preconnect|fonts\.googleapis|fonts\.gstatic|<iframe|<object|<embed/);
  assert.doesNotMatch(JS,/innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(|new Function|WebSocket|EventSource/);
  assert.doesNotMatch(JS,/method\s*:\s*['"](?:POST|PUT|PATCH|DELETE)|FormData|sendBeacon|XMLHttpRequest|showOpenFilePicker|WebAssembly/i);
});

test('可信 fixture 是单组织脱敏摘要并覆盖产品与演进状态',()=>{
  const data=normalizeEnterpriseWorkbench(FIXTURE);
  assert.equal(data.organizationScope.visibility,'organization_private');
  assert.equal(data.organizationScope.authorizationPurpose,'enterprise.private_ability.read');
  assert.deepEqual(data.products.map(product=>product.sourceType).sort(),['authorized_derivative','self_authored']);
  assert.ok(data.products.flatMap(product=>product.releases).some(release=>release.status==='evidence_pending'));
  assert.ok(data.products.some(product=>product.status==='recalled'));
  const derivative=data.products.find(product=>product.sourceType==='authorized_derivative');
  assert.equal(derivative.upstream.status,'blocked');
  assert.deepEqual(derivative.upstream.manifestChanges,{added:2,modified:3,deleted:1});
  assert.equal(derivative.rollback.status,'selection_recorded');
  assert.equal(derivative.rollback.currentReleaseChanged,false);
  assert.equal(data.evolution.appendOnly,true);
  assert.equal(data.evolution.automaticUpgrade,false);
  assert.ok(data.evolution.history.every(event=>event.outcome==='selection_recorded'&&!event.currentReleaseChanged));
});

test('全局公开汇总、错误 scope、额外字段与跨组织注入失败关闭',()=>{
  const publicAggregate={schemaVersion:1,summary:{organizations:1,products:2,releases:4,selfAuthored:1,authorizedDerivatives:1},projectionDigest:`sha256:${'a'.repeat(64)}`};
  assert.throws(()=>normalizeEnterpriseWorkbench(publicAggregate),/ORGANIZATION_PRIVATE_PROJECTION_REQUIRED/);
  const wrongScope=structuredClone(FIXTURE);wrongScope.organizationScope.visibility='public';
  assert.throws(()=>normalizeEnterpriseWorkbench(wrongScope),/ORGANIZATION_PRIVATE_PROJECTION_REQUIRED/);
  const extraTop=structuredClone(FIXTURE);extraTop.organizationScope.memberId='member_other';
  assert.throws(()=>normalizeEnterpriseWorkbench(extraTop),/ORGANIZATION_PRIVATE_PROJECTION_REQUIRED/);
  const crossTenant=structuredClone(FIXTURE);crossTenant.products[0].organizationId='org_other';
  assert.throws(()=>normalizeEnterpriseWorkbench(crossTenant),/ORGANIZATION_PRIVATE_PROJECTION_REQUIRED/);
});

test('私有正文、包路径、身份、密钥、URL、CAS 与超限输入失败关闭',()=>{
  const mutations=[
    value=>{value.products[0].packagePath='/private/org/skill';},
    value=>{value.products[0].prompt='内部提示词';},
    value=>{value.products[0].member={name:'Alice'};},
    value=>{value.products[0].summaryZh='https://private.example/secret';},
    value=>{value.products[0].summaryZh='cas:sha256:abcdef';},
    value=>{value.products[0].summaryZh='ghp_abcdefghijklmnopqrstuvwxyz';},
    value=>{value.products[0].summaryZh='内部位置:/Users/alice/secret';},
    value=>{value.products[0].summaryZh='内部位置:file:///Users/alice/secret';},
    value=>{value.products[0].summaryZh='配置位于:/etc/passwd';},
    value=>{value.products[0].summaryZh='内部位置:/opt/company/secret';},
    value=>{value.products[0].summaryZh='内部位置:C:\\Users\\alice\\secret';},
    value=>{value.products[0].summaryZh='共享目录:\\\\server\\share\\secret';},
    value=>{value.products[0].summaryZh='部署目录=/srv/skillops/private';},
  ];
  for(const mutate of mutations){const value=structuredClone(FIXTURE);mutate(value);assert.throws(()=>normalizeEnterpriseWorkbench(value),/ORGANIZATION_PRIVATE_PROJECTION_REQUIRED/)}
  const relativeId=structuredClone(FIXTURE);relativeId.products[0].summaryZh='能力标识 market/foo 可用于内部流程';
  assert.equal(normalizeEnterpriseWorkbench(relativeId).products[0].summaryZh,relativeId.products[0].summaryZh);
  const tooMany=structuredClone(FIXTURE);tooMany.products=new Array(201).fill(tooMany.products[0]);tooMany.summary.products=201;tooMany.summary.releases=402;
  assert.throws(()=>normalizeEnterpriseWorkbench(tooMany),/ORGANIZATION_PRIVATE_PROJECTION_REQUIRED/);
  const mismatch=structuredClone(FIXTURE);mismatch.summary.products=99;
  assert.throws(()=>normalizeEnterpriseWorkbench(mismatch),/ORGANIZATION_PRIVATE_PROJECTION_REQUIRED/);
});

test('旧证据不继承且回滚记录不伪装为版本切换',()=>{
  const data=normalizeEnterpriseWorkbench(FIXTURE);
  const derivative=data.products.find(product=>product.sourceType==='authorized_derivative');
  const oldRelease=derivative.releases[0],currentRelease=derivative.releases[1];
  assert.equal(oldRelease.evidence.status,'callable');
  assert.equal(currentRelease.evidence,null);
  assert.ok(currentRelease.evidenceGaps.includes('source_release_recalled'));
  assert.notEqual(derivative.currentPrivateReleaseId,derivative.rollback.selectedTargetReleaseId);
  assert.equal(data.evolution.history.at(-1).currentReleaseChanged,false);
});

test('严格采用造物云 V1 设计令牌、品牌标、玻璃工作台与移动单列',()=>{
  assert.match(HTML,/zaowuyun-tokens\.css\?v=v1/);
  assert.match(HTML,/zaowuyun-mark-color\.svg/);
  assert.match(HTML,/能力市场[\s\S]*技能管家[\s\S]*创作者中心[\s\S]*企业开发台/);
  assert.match(MARK,/造物云/);
  assert.match(SERVE,/\['\.svg', 'image\/svg\+xml; charset=utf-8'\]/);
  assert.match(TOKENS,/权威来源：https:\/\/www\.zaowuyun\.com\/design-system\.html/);
  assert.match(TOKENS,/--bg:\s*#07070F/);
  assert.match(TOKENS,/--accent:\s*#7B80FF/);
  assert.match(TOKENS,/--font-sans:\s*'Noto Sans SC'/);
  assert.match(TOKENS,/--r-lg:\s*18px/);
  assert.match(TOKENS,/--container-doc:\s*1280px/);
  assert.match(TOKENS,/\[data-theme="light"\]/);
  assert.match(JS,/prefers-color-scheme: light/);
  assert.match(CSS,/background:\s*var\(--navBg\)/);
  assert.match(CSS,/backdrop-filter:\s*saturate\(180%\) blur\(22px\)/);
  assert.match(CSS,/grid-template-columns:\s*minmax\(270px,.58fr\) minmax\(0,2fr\)/);
  assert.match(CSS,/@media \(max-width: 640px\)/);
  assert.match(CSS,/\.history li > div \{ min-width: 0; overflow-wrap: anywhere; word-break: break-word; \}/);
  assert.match(TOKENS,/:focus-visible/);
  assert.match(TOKENS,/@media \(prefers-reduced-motion: reduce\)/);
  assert.doesNotMatch(CSS,/(?:#[a-f0-9]{3,8}|rgba?\()/i);
});

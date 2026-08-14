import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createOffer } from '../lib/commerce/offer.mjs';
import { createFreeOrder } from '../lib/commerce/order.mjs';
import { issueEntitlement } from '../lib/commerce/entitlement.mjs';
import { canonicalDigest } from '../lib/registry-identity.mjs';
import { createPackageArtifact } from '../lib/package.mjs';
import { calculatePrivateProductId } from '../lib/enterprise/private-ability.mjs';
import { PrivateAbilityStore } from '../lib/enterprise/private-ability-store.mjs';
import {
  compareDerivativeUpstream,
  createDerivativeEvolutionEvent,
  createDerivativeForkLineage,
  createDerivativeRollbackPlan,
  createDerivativeUpgradePlan,
} from '../lib/enterprise/derivative-evolution.mjs';
import { DerivativeEvolutionStore } from '../lib/enterprise/derivative-evolution-store.mjs';

const T0='2026-08-14T00:00:00.000Z';
const T1='2026-08-14T01:00:00.000Z';
const T2='2026-08-14T02:00:00.000Z';
const T3='2026-08-14T03:00:00.000Z';
const T4='2026-08-14T04:00:00.000Z';
const T5='2026-08-14T05:00:00.000Z';
const FUTURE='2026-09-14T00:00:00.000Z';
const ORG='org_acme';
const OTHER='org_other';
const PROJECT='project_enterprise';
const ENVIRONMENT='staging';
const BASE_PRODUCT=`prod_${'a'.repeat(64)}`;
const BASE_RELEASE=`rel_${'b'.repeat(64)}`;
const UPSTREAM_RELEASE=`rel_${'c'.repeat(64)}`;
const D=char=>`sha256:${char.repeat(64)}`;

function tempDirectory(){return fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'skillops-v46-e2e-'))}
function organizationAuthorizer(organizationId=ORG){return context=>({decision:'allow',organizationId,purpose:context.purpose})}
function organizationResolver(organizationId=ORG){return context=>({decision:'allow',organizationId,projectId:context.projectId,environment:context.environment})}
function artifact(version,marker){return createPackageArtifact({files:[{path:'SKILL.md',content:`# ${marker}`},{path:'scripts/run.mjs',content:`export const marker='${marker}'`}],sourceVersion:version,collectedAt:T0})}
function governance(overrides={}){return{licenseDigest:D('1'),securityDigest:D('2'),permissionsDigest:D('3'),compatibilityDigest:D('4'),dependenciesDigest:D('5'),evidenceDigest:D('6'),dependenciesKnown:true,evidenceCurrent:true,licenseAllowsUpgrade:true,...overrides}}

function scenario(){
  const directory=tempDirectory();
  const basePackage=artifact('1.0.0','base-one');
  const upstreamPackage=artifact('2.0.0','base-two');
  const privateOnePackage=artifact('1.0.0','private-one');
  const privateTwoPackage=artifact('1.1.0','private-two');
  const offer=createOffer({
    offerId:'offer_v46_e2e',productId:BASE_PRODUCT,
    pricing:{model:'free',currency:'CNY',amountMinor:0},
    licensePolicy:{rights:['derive','internal_distribute'],constraints:{organizationIds:[ORG],projectIds:[PROJECT],environments:[ENVIRONMENT],releaseIds:[BASE_RELEASE],validUntil:FUTURE}},
    effectiveAt:T0,
  });
  const order=createFreeOrder({
    orderId:'ord_v46_e2e',organizationId:ORG,productId:BASE_PRODUCT,
    releaseScope:{releaseIds:[BASE_RELEASE]},offerRevisionId:offer.offerRevisionId,idempotencyKey:'v46:e2e:free-grant',
  },{
    offerResolver:()=>({offerRevision:offer,currentOfferRevisionId:offer.offerRevisionId}),
    productResolver:()=>({productId:BASE_PRODUCT,status:'published'}),
    releaseResolver:()=>({releaseId:BASE_RELEASE,productId:BASE_PRODUCT,status:'published'}),
    now:()=>T0,
  });
  const entitlement=issueEntitlement({order,issuedAt:T0,validUntil:FUTURE});
  const baseReleases=new Map([
    [BASE_RELEASE,{releaseId:BASE_RELEASE,productId:BASE_PRODUCT,status:'published',packageDigest:basePackage.packageDigest,manifestDigest:canonicalDigest(basePackage.manifest)}],
    [UPSTREAM_RELEASE,{releaseId:UPSTREAM_RELEASE,productId:BASE_PRODUCT,status:'published',packageDigest:upstreamPackage.packageDigest,manifestDigest:canonicalDigest(upstreamPackage.manifest)}],
  ]);
  const baseGovernance=new Map([[BASE_RELEASE,governance()],[UPSTREAM_RELEASE,governance({securityDigest:D('7'),evidenceDigest:D('8')})]]);
  const manifests=new Map([
    [`base:${BASE_RELEASE}`,basePackage.manifest],[`base:${UPSTREAM_RELEASE}`,upstreamPackage.manifest],
  ]);
  const privateProductId=calculatePrivateProductId({organizationId:ORG,skillId:'market/service-review',productKey:'service-review-enterprise'});
  const roots=new Map();
  const plans=new Map();
  const privateStore=new PrivateAbilityStore(path.join(directory,'private.json'));
  const baseTrust={
    entitlementResolver:id=>id===entitlement.entitlementId?entitlement:null,
    baseReleaseResolver:id=>baseReleases.get(id)??null,
    organizationResolver:organizationResolver(),
    governanceResolver:({releaseKind,releaseId,packageDigest,manifestDigest})=>{
      const value=governance();
      const body={releaseKind,releaseId,packageDigest,manifestDigest,...value};
      return{...body,governanceDigest:canonicalDigest(body)};
    },
    now:()=>T0,
  };
  const root=createDerivativeForkLineage({entitlementId:entitlement.entitlementId,baseReleaseId:BASE_RELEASE,privateProductId,projectId:PROJECT,environment:ENVIRONMENT},baseTrust);
  roots.set(root.lineageId,root);
  roots.set(root.lineageDigest,root);
  const sourceEvidence=(publicationStatus=baseReleases.get(BASE_RELEASE).status)=>({
    decision:'allow',organizationId:ORG,privateProductId,sourceType:'authorized_derivative',
    evidenceRef:root.lineageId,evidenceDigest:D('9'),baseProductId:BASE_PRODUCT,baseReleaseId:BASE_RELEASE,
    entitlementId:entitlement.entitlementId,entitlementDigest:entitlement.entitlementDigest,
    licenseSnapshotDigest:root.licenseSnapshotDigest,lineageDigest:root.lineageDigest,
    rights:['derive','internal_distribute'],validUntil:FUTURE,publicationStatus,entitlementStatus:'active',
  });
  let state=privateStore.createProduct({
    organizationId:ORG,skillId:'market/service-review',productKey:'service-review-enterprise',
    titleZh:'客户服务质检（二创版）',summaryZh:'基于免费授权形成的企业内部二创。',
    sourceType:'authorized_derivative',creationEvidenceRef:root.lineageId,
  },{
    expectedRevision:privateStore.status().revision,organizationAuthorizer:organizationAuthorizer(),
    creationEvidenceResolver:()=>sourceEvidence(),now:()=>T0,
  });
  const product=state.product;
  state=privateStore.createRelease({organizationId:ORG,privateProductId,version:'1.0.0',packageDigest:privateOnePackage.packageDigest,previousPrivateReleaseId:null},{
    expectedRevision:state.revision,organizationAuthorizer:organizationAuthorizer(),packageResolver:()=>privateOnePackage,
    sourceStatusResolver:()=>sourceEvidence(),now:()=>T1,
  });
  const firstRelease=state.release;
  const evidenceFor=release=>{
    const binding={basedOnPackageDigest:release.packageDigest,basedOnManifestDigest:release.packageManifestDigest,validUntil:FUTURE};
    return{packageAudit:{status:'pass',evidenceDigest:D('a'),...binding},sms:{status:'pass',evidenceDigest:D('b'),...binding},eval:{status:'pass',evidenceDigest:D('c'),...binding},review:{status:'certified',evidenceDigest:D('d'),...binding}};
  };
  state=privateStore.assessEvidence({organizationId:ORG,privateReleaseId:firstRelease.privateReleaseId},{expectedRevision:state.revision,organizationAuthorizer:organizationAuthorizer(),evidenceResolver:()=>evidenceFor(firstRelease),now:()=>T2});
  const firstEvidence=state.evidence;
  state=privateStore.createRelease({organizationId:ORG,privateProductId,version:'1.1.0',packageDigest:privateTwoPackage.packageDigest,previousPrivateReleaseId:firstRelease.privateReleaseId},{
    expectedRevision:state.revision,organizationAuthorizer:organizationAuthorizer(),packageResolver:()=>privateTwoPackage,
    sourceStatusResolver:()=>sourceEvidence(),now:()=>T3,
  });
  const secondRelease=state.release;
  manifests.set(`private:${firstRelease.privateReleaseId}`,privateOnePackage.manifest);
  manifests.set(`private:${secondRelease.privateReleaseId}`,privateTwoPackage.manifest);
  const organizationPrivateResolver=privateStore.createOrganizationResolver({organizationAuthorizer:organizationAuthorizer()});
  const releaseProjection=id=>privateStore.projectOrganization({organizationAuthorizer:organizationAuthorizer(),sourceStatusResolver:()=>sourceEvidence(),now:()=>T4}).products[0]?.releases.find(release=>release.privateReleaseId===id)??null;
  const privateReleaseStateResolver=({privateReleaseId:id})=>{
    const release=organizationPrivateResolver.resolvePrivateRelease(id);
    if(!release)return null;
    const projected=releaseProjection(id);
    const body={privateReleaseId:id,privateProductId:release.privateProductId,organizationId:release.organizationId,releaseDigest:release.releaseDigest,status:projected?.status==='callable'?'available':'evidence_pending',target:{exists:true,managed:true,drift:false},evidenceCurrent:projected?.status==='callable'};
    return{...body,stateDigest:canonicalDigest(body)};
  };
  const governanceResolver=({releaseKind,releaseId,packageDigest,manifestDigest})=>{
    const projected=releaseKind==='private'?releaseProjection(releaseId):null;
    const value=releaseKind==='base'
      ?baseGovernance.get(releaseId)
      :governance({evidenceDigest:projected?.evidence?.evidenceAssessmentDigest??D('6'),evidenceCurrent:projected?.status==='callable'});
    const body={releaseKind,releaseId,packageDigest,manifestDigest,...value};
    return{...body,governanceDigest:canonicalDigest(body)};
  };
  const derivativeTrust={
    ...baseTrust,now:()=>T4,
    privateProductResolver:id=>organizationPrivateResolver.resolvePrivateProduct(id),
    privateReleaseResolver:id=>organizationPrivateResolver.resolvePrivateRelease(id),
    privateReleaseStateResolver,
    governanceResolver,
    lineageResolver:id=>roots.get(id)??null,
    manifestResolver:({releaseKind,releaseId})=>manifests.get(`${releaseKind}:${releaseId}`)??null,
    reassessmentResolver:()=>({comparisonDigest:null,packageAudit:'pending',sms:'pending',eval:'pending',review:'pending'}),
    confirmationStatusResolver:context=>{
      const body={decision:'allow',planDigest:context.planDigest,organizationId:context.organizationId,privateProductId:context.privateProductId,currentPrivateReleaseId:context.currentPrivateReleaseId,targetDigest:canonicalDigest(context.target),checkedAt:T4};
      return{...body,confirmationDigest:canonicalDigest(body)};
    },
    planResolver:digest=>plans.get(digest)??null,
  };
  const comparisonInput={lineageId:root.lineageId,currentPrivateReleaseId:secondRelease.privateReleaseId,currentBaseReleaseId:BASE_RELEASE,proposedUpstreamReleaseId:UPSTREAM_RELEASE,projectId:PROJECT,environment:ENVIRONMENT};
  return{directory,privateStore,baseReleases,privateProductId,product,root,entitlement,firstRelease,secondRelease,firstEvidence,evidenceFor,sourceEvidence,derivativeTrust,comparisonInput,plans};
}

test('免费授权到私有 Fork、不可变新版本、复评和组织能力库形成真实跨域链路',()=>{
  const s=scenario();
  assert.equal(s.entitlement.rights.includes('derive'),true);
  assert.equal(s.root.entitlementId,s.entitlement.entitlementId);
  assert.equal(s.product.sourceEvidence.lineageDigest,s.root.lineageDigest);
  let projection=s.privateStore.projectOrganization({organizationAuthorizer:organizationAuthorizer(),sourceStatusResolver:()=>s.sourceEvidence(),now:()=>T3});
  assert.equal(projection.products[0].releases[0].status,'callable');
  assert.equal(projection.products[0].releases[1].status,'evidence_pending');
  assert.equal(projection.products[0].releases[1].evidence,null);
  let state=s.privateStore.assessEvidence({organizationId:ORG,privateReleaseId:s.secondRelease.privateReleaseId},{expectedRevision:s.privateStore.status().revision,organizationAuthorizer:organizationAuthorizer(),evidenceResolver:()=>s.evidenceFor(s.secondRelease),now:()=>T4});
  assert.equal(state.evidence.status,'callable');
  assert.notEqual(state.evidence.evidenceAssessmentId,s.firstEvidence.evidenceAssessmentId);
  assert.notEqual(state.evidence.evidenceAssessmentDigest,s.firstEvidence.evidenceAssessmentDigest);
  projection=s.privateStore.projectOrganization({organizationAuthorizer:organizationAuthorizer(),sourceStatusResolver:()=>s.sourceEvidence(),now:()=>T4});
  assert.equal(projection.summary.callable,2);
  assert.equal(projection.products[0].currentPrivateReleaseId,s.secondRelease.privateReleaseId);
});

test('上游比较只给 manifest 与治理差异，新版本不能继承旧证据',()=>{
  const s=scenario();
  const comparison=compareDerivativeUpstream(s.comparisonInput,s.derivativeTrust);
  assert.ok(comparison.manifestChanges.modified.length>0);
  assert.ok(comparison.governanceChanges.some(change=>change.kind==='security'));
  for(const forbidden of ['content','storageRef','cas:','/Users/','file://'])assert.equal(JSON.stringify(comparison).includes(forbidden),false);
  const plan=createDerivativeUpgradePlan(s.comparisonInput,s.derivativeTrust);
  assert.equal(plan.status,'blocked','当前新私有版本尚无当前证据，升级必须失败关闭');
  assert.ok(plan.reasons.some(reason=>reason.code==='CURRENT_EVIDENCE_STALE'));
});

test('回滚精确确认只追加选择事件，不删除版本也不伪装成版本切换',()=>{
  const s=scenario();
  s.privateStore.assessEvidence({organizationId:ORG,privateReleaseId:s.secondRelease.privateReleaseId},{expectedRevision:s.privateStore.status().revision,organizationAuthorizer:organizationAuthorizer(),evidenceResolver:()=>s.evidenceFor(s.secondRelease),now:()=>T4});
  const plan=createDerivativeRollbackPlan({operationId:'rollback:v46:e2e',currentPrivateReleaseId:s.secondRelease.privateReleaseId,targetPrivateReleaseId:s.firstRelease.privateReleaseId,projectId:PROJECT,environment:ENVIRONMENT},s.derivativeTrust);
  assert.equal(plan.status,'ready',JSON.stringify(plan.reasons));
  s.plans.set(plan.planDigest,plan);
  const evolutionStore=new DerivativeEvolutionStore(path.join(s.directory,'evolution.json'),{trustOptions:s.derivativeTrust});
  const privateStatus=s.privateStore.status();
  const input={type:'rollback.selected',operationId:plan.operationId,planDigest:plan.planDigest,confirmPlanDigest:plan.planDigest,occurredAt:T5};
  const expected=createDerivativeEvolutionEvent(input,s.derivativeTrust);
  const beforeEvolution=evolutionStore.snapshot();
  const appended=evolutionStore.append(input,{expectedRevision:beforeEvolution.revision});
  assert.equal(appended.event.eventId,expected.eventId);
  assert.equal(appended.event.outcome,'selection_recorded');
  assert.equal(appended.eventCount,beforeEvolution.eventCount+1);
  const organizationEvolution=evolutionStore.projectOrganization({organizationAuthorizer:organizationAuthorizer()});
  assert.equal(organizationEvolution.privateProducts[s.privateProductId].currentReleaseChanged,false);
  assert.equal(organizationEvolution.events[0].confirmationDigest,expected.confirmationDigest);
  const privateResolver=s.privateStore.createOrganizationResolver({organizationAuthorizer:organizationAuthorizer()});
  assert.equal(privateResolver.resolvePrivateRelease(s.secondRelease.privateReleaseId).privateReleaseId,s.secondRelease.privateReleaseId);
  assert.equal(privateResolver.resolvePrivateRelease(s.firstRelease.privateReleaseId).privateReleaseId,s.firstRelease.privateReleaseId);
  assert.deepEqual(s.privateStore.status(),privateStatus);
  const committedEvolution=evolutionStore.snapshot();
  const repeated=evolutionStore.append(input,{expectedRevision:appended.revision});
  assert.equal(repeated.action,'unchanged');
  assert.equal(repeated.revision,appended.revision);
  assert.equal(repeated.eventCount,appended.eventCount);
  assert.equal(repeated.statusDigest,appended.statusDigest);
  assert.deepEqual(evolutionStore.snapshot(),committedEvolution);
});

test('跨租户零可见且 recall 对能力库、升级、回滚保持粘性，历史仍只追加可审计',()=>{
  const s=scenario();
  const otherProjection=s.privateStore.projectOrganization({organizationAuthorizer:organizationAuthorizer(OTHER),sourceStatusResolver:()=>null,now:()=>T4});
  assert.equal(otherProjection.summary.products,0);
  assert.equal(s.privateStore.createOrganizationResolver({organizationAuthorizer:organizationAuthorizer(OTHER)}).resolvePrivateProduct(s.privateProductId),null);
  assert.throws(()=>compareDerivativeUpstream(s.comparisonInput,{...s.derivativeTrust,organizationResolver:organizationResolver(OTHER)}),error=>error.code==='ORGANIZATION_ACCESS_DENIED');
  assert.throws(()=>createDerivativeUpgradePlan(s.comparisonInput,{...s.derivativeTrust,organizationResolver:organizationResolver(OTHER)}),error=>error.code==='ORGANIZATION_ACCESS_DENIED');
  assert.throws(()=>createDerivativeRollbackPlan({operationId:'rollback:v46:cross-org',currentPrivateReleaseId:s.secondRelease.privateReleaseId,targetPrivateReleaseId:s.firstRelease.privateReleaseId,projectId:PROJECT,environment:ENVIRONMENT},{...s.derivativeTrust,organizationResolver:organizationResolver(OTHER)}),error=>error.code==='ORGANIZATION_ACCESS_DENIED');

  s.privateStore.assessEvidence({organizationId:ORG,privateReleaseId:s.secondRelease.privateReleaseId},{expectedRevision:s.privateStore.status().revision,organizationAuthorizer:organizationAuthorizer(),evidenceResolver:()=>s.evidenceFor(s.secondRelease),now:()=>T4});
  const plan=createDerivativeRollbackPlan({operationId:'rollback:v46:before-recall',currentPrivateReleaseId:s.secondRelease.privateReleaseId,targetPrivateReleaseId:s.firstRelease.privateReleaseId,projectId:PROJECT,environment:ENVIRONMENT},s.derivativeTrust);
  s.plans.set(plan.planDigest,plan);
  const evolutionStore=new DerivativeEvolutionStore(path.join(s.directory,'evolution.json'),{trustOptions:s.derivativeTrust});
  evolutionStore.append({type:'rollback.selected',operationId:plan.operationId,planDigest:plan.planDigest,confirmPlanDigest:plan.planDigest,occurredAt:T5},{expectedRevision:evolutionStore.snapshot().revision});
  s.baseReleases.set(BASE_RELEASE,{...s.baseReleases.get(BASE_RELEASE),status:'recalled'});
  const recalled=s.privateStore.projectOrganization({organizationAuthorizer:organizationAuthorizer(),sourceStatusResolver:()=>s.sourceEvidence('recalled'),now:()=>T5});
  assert.equal(recalled.products[0].status,'blocked');
  assert.ok(recalled.products[0].releases.every(release=>release.status==='blocked'));
  const blockedRollback=createDerivativeRollbackPlan({operationId:'rollback:v46:after-recall',currentPrivateReleaseId:s.secondRelease.privateReleaseId,targetPrivateReleaseId:s.firstRelease.privateReleaseId,projectId:PROJECT,environment:ENVIRONMENT},s.derivativeTrust);
  assert.equal(blockedRollback.status,'blocked');
  assert.ok(blockedRollback.reasons.some(reason=>reason.code==='BASE_RELEASE_RECALLED'));
  assert.throws(()=>createDerivativeUpgradePlan(s.comparisonInput,s.derivativeTrust),error=>error.code==='BASE_RELEASE_RECALLED');

  const own=evolutionStore.projectOrganization({organizationAuthorizer:organizationAuthorizer()});
  assert.equal(own.eventCount,1);
  assert.equal(own.events[0].organizationId,ORG);
  const other=evolutionStore.projectOrganization({organizationAuthorizer:organizationAuthorizer(OTHER)});
  assert.equal(other.eventCount,0);
  assert.deepEqual(other.privateProducts,{});
  const publicProjection=evolutionStore.projectPublic();
  for(const forbidden of ['organizationId','privateProductId','selectedTarget','eventId','planDigest'])assert.equal(JSON.stringify(publicProjection).includes(forbidden),false);
});

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { decideAccess } from '../lib/commerce/access-decision.mjs';
import { createLicensePolicy } from '../lib/commerce/license-policy.mjs';
import { createOffer } from '../lib/commerce/offer.mjs';
import { createDemandCatalogProjection } from '../lib/demand/demand-catalog.mjs';
import { projectEnterpriseLibrary } from '../lib/demand/enterprise-library.mjs';
import { AcquisitionLedger } from '../lib/demand/free-acquisition.mjs';
import { createSkillStewardPlan } from '../lib/demand/skill-steward.mjs';
import { createFixtureIdpVerifier } from '../lib/idp-receipt.mjs';
import { createMarketCatalogProjection } from '../lib/market/catalog-projection.mjs';
import { createPublisher, createSkillProduct } from '../lib/market/domain.mjs';
import { normalizeRelease, releaseId, sourceId } from '../lib/registry-identity.mjs';
import { createSkillRecord } from '../lib/skill-record.mjs';

const AT='2026-08-14T05:00:00.000Z',LATER='2026-08-14T05:01:00.000Z';
const D=x=>`sha256:${x.repeat(64)}`;

async function fixture(){
  const verifier=createFixtureIdpVerifier({provider:'fixture-v45',purpose:'market-publisher',receiptKey:Buffer.alloc(32,45),clock:()=>AT,assertionVerifier:()=>({subject:'zaowuyun',kind:'service'})});
  const publisher=createPublisher({kind:'organization',displayName:'造物云能力中心',identityReceipt:await verifier.issueReceipt({id:'pub'}),createdAt:AT},{trustedProviderVerifiers:[verifier],purpose:'market-publisher',now:AT});
  const packageDigest=D('a'),skillId='zaowuyun/chinese-official-writing',version='1.0.0';
  const release=normalizeRelease({skillId,version,releaseId:releaseId({skillId,version,packageDigest}),package:{packageDigest,manifestDigest:D('b'),storageRef:`cas:${packageDigest}`},compatibility:{contract:'skill-package.v1',targets:['codex']},assessmentRefs:[D('c'),D('d')],reviewRefs:[D('e'),D('f')],sourceRefs:[sourceId('fixture','v45/writing')],publishedAt:AT});
  const parties={creatorPublisherIds:[publisher.publisherId],rightsHolderPublisherId:publisher.publisherId,payeePublisherId:null,supportPublisherId:null};
  const product=createSkillProduct({publisherId:publisher.publisherId,productKey:'chinese-official-writing',titleZh:'中文公文写作',summaryZh:'起草并校对中文企业公文。',parties,skillId,releaseId:release.releaseId,createdAt:AT},{registryRelease:release});
  const offer=createOffer({offerId:'offer_v45_writing',productId:product.productId,pricing:{model:'free',currency:'CNY',amountMinor:0},licensePolicy:createLicensePolicy({rights:['invoke'],constraints:{organizationIds:['org_acme'],projectIds:['project_alpha'],environments:['staging'],releaseIds:[release.releaseId]}}),effectiveAt:AT});
  const record=createSkillRecord({release,source:{sourceId:sourceId('fixture','v45/writing'),type:'fixture',coordinate:'fixture:v45/writing'},metadata:{titleZh:product.titleZh,descriptionZh:product.summaryZh,originalTitle:product.titleZh,originalDescription:product.summaryZh,originalLanguage:'zh-CN',localizationStatus:'source',translationSource:null},routing:{summary:'适合起草与校对正式中文公文。',intentTags:['公文','写作'],whenToUse:['需要起草正式项目通知时'],whenNotToUse:['任务不是正式写作时'],examples:[],confusions:[]},interface:{inputs:[],outputs:[]},dependencies:{required:[],optional:[],conflicts:[]},permissions:{required:[],optional:[],prohibited:[]},compatibility:release.compatibility,evidence:{smsDigest:D('c'),evalDigest:D('d'),reviewEvidenceDigest:D('e'),reviewPolicyDigest:D('f')}});
  const marketCatalog=createMarketCatalogProjection({publishers:[publisher],products:[product],registryReleases:[release],applicationReleases:[],offers:[offer],generatedAt:AT});
  const submission={schemaVersion:1,workId:'work:chinese-writing',publisherId:publisher.publisherId,productId:product.productId,releaseId:release.releaseId,draftRevision:1,draftDigest:D('1'),marketRegistryRevision:D('2'),licensePolicyDigest:D('3'),evidenceDigest:D('4'),declarationVersion:'rights.v1',submittedAt:AT,submissionDigest:D('5'),submissionId:`sub_${'6'.repeat(64)}`};
  const publicItem={productId:product.productId,releaseId:release.releaseId,status:'published',enforcementStatus:'published',submission,reviewGaps:[],nextAction:'manage_publication',timeline:[{eventId:'evt_publish',type:'lifecycle.recorded',action:'publish',at:AT}],appeals:[]};
  const publicationProjection={schemaVersion:1,items:{[`${product.productId}:${release.releaseId}`]:publicItem},eventCount:1};
  return{publisher,product,release,offer,record,marketCatalog,publicationProjection,publicItem};
}

function accessResolver(ledger,status,now=LATER){return query=>decideAccess({entitlementIds:query.entitlementIds,organizationId:query.organizationId,productId:query.productId,releaseId:query.releaseId,requiredRights:query.requiredRights,projectId:query.projectId,environment:query.environment},{entitlementResolver:id=>ledger.resolveEntitlement(id),releaseResolver:id=>({releaseId:id,status}),usageResolver:()=>({invocations:0}),seatResolver:()=>({seatCount:1}),now:()=>now})}

test('published catalog → recommendation → explicit free acquire → enterprise library → ready WorkOrder → recall block',async()=>{
  const f=await fixture();
  const catalog=(entitlementId=null)=>createDemandCatalogProjection({marketCatalog:f.marketCatalog,publicationProjection:f.publicationProjection,organizationId:'org_acme',generatedAt:AT},{marketCatalogResolver:()=>f.marketCatalog,publicationItemResolver:()=>f.publicItem,currentOfferResolver:()=>f.offer,skillRecordResolver:()=>f.record,entitlementSummaryResolver:ctx=>{const base={organizationId:ctx.organizationId,productId:ctx.productId,releaseId:ctx.releaseId};return entitlementId?{...base,state:'entitled',code:'ACCESS_ALLOWED',entitlementId,grantedRights:['invoke']}:{...base,state:'not_entitled',code:'NO_ENTITLEMENT',entitlementId:null,grantedRights:[]}}});
  const emptyLedger=new AcquisitionLedger(path.join(fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'skillops-v45-empty-')),'ledger.json'));
  const emptySource=emptyLedger.project();
  const emptyLibrary=projectEnterpriseLibrary(emptySource,{marketProjectionResolver:revision=>emptyLedger.resolveProjection(revision),organizationAuthorizer:()=>({decision:'allow',organizationId:'org_acme'}),publicationResolver:{resolveAccessRelease:()=>null},now:()=>AT});
  const beforeCatalog=catalog();
  const beforeValidators={catalogValidator:value=>value.projectionDigest===beforeCatalog.projectionDigest?beforeCatalog:null,libraryValidator:value=>value.projectionDigest===emptyLibrary.projectionDigest?emptyLibrary:null};
  let plan=createSkillStewardPlan({task:{summaryZh:'需要起草正式项目通知',intentTags:['公文','写作']},context:{organizationId:'org_acme',projectId:'project_alpha',environment:'staging',allowedPermissions:[],requiredRights:['invoke']}},{...beforeValidators,catalogProjection:beforeCatalog,libraryProjection:emptyLibrary,accessDecisionResolver:()=>{throw new Error('no access check before grant')},now:AT});
  assert.equal(plan.status,'acquisition_required'); assert.equal(plan.workOrderDraft,null);
  const file=path.join(fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'skillops-v45-e2e-')),'ledger.json'),ledger=new AcquisitionLedger(file);
  const publicationResolver={resolveOrderProduct:id=>({productId:id,status:'published'}),resolveOrderRelease:id=>({releaseId:id,productId:f.product.productId,status:'published'})};
  const grant=ledger.acquire({organizationId:'org_acme',productId:f.product.productId,releaseIds:[f.release.releaseId],offerRevisionId:f.offer.offerRevisionId,idempotencyKey:'e2e:explicit-free:001'},{expectedRevision:ledger.read().revision,offerResolver:()=>({offerRevision:f.offer,currentOfferRevisionId:f.offer.offerRevisionId}),publicationResolver,organizationAuthorizer:()=>({decision:'allow',organizationId:'org_acme'}),now:()=>AT});
  const library=status=>projectEnterpriseLibrary(ledger.project(),{marketProjectionResolver:revision=>ledger.resolveProjection(revision),organizationAuthorizer:()=>({decision:'allow',organizationId:'org_acme'}),publicationResolver:{resolveAccessRelease:id=>({releaseId:id,productId:f.product.productId,status})},productResolver:id=>({productId:id,abilityType:'skill',titleZh:f.product.titleZh}),now:()=>LATER});
  const readyCatalog=catalog(grant.entitlement.entitlementId),readyLibrary=library('published');
  const readyValidators={catalogValidator:value=>value.projectionDigest===readyCatalog.projectionDigest?readyCatalog:null,libraryValidator:value=>value.projectionDigest===readyLibrary.projectionDigest?readyLibrary:null};
  plan=createSkillStewardPlan({task:{summaryZh:'需要起草正式项目通知',intentTags:['公文','写作']},context:{organizationId:'org_acme',projectId:'project_alpha',environment:'staging',allowedPermissions:[],requiredRights:['invoke']}},{...readyValidators,catalogProjection:readyCatalog,libraryProjection:readyLibrary,accessDecisionResolver:accessResolver(ledger,'published'),now:LATER});
  assert.equal(plan.status,'ready');assert.equal(plan.workOrderDraft.nonExecutable,true);assert.equal(plan.workOrderDraft.steps[0].entitlementId,grant.entitlement.entitlementId);
  const recalledLibrary=library('recalled');
  plan=createSkillStewardPlan({task:{summaryZh:'需要起草正式项目通知',intentTags:['公文','写作']},context:{organizationId:'org_acme',projectId:'project_alpha',environment:'staging',allowedPermissions:[],requiredRights:['invoke']}},{catalogValidator:readyValidators.catalogValidator,libraryValidator:value=>value.projectionDigest===recalledLibrary.projectionDigest?recalledLibrary:null,catalogProjection:readyCatalog,libraryProjection:recalledLibrary,accessDecisionResolver:accessResolver(ledger,'recalled'),now:LATER});
  assert.equal(plan.status,'blocked');assert.equal(plan.recommendations[0].code,'RELEASE_RECALLED');assert.equal(plan.workOrderDraft,null);
  assert.doesNotMatch(JSON.stringify(plan),/candidate|storageRef|localPath|prompt|output|token|secret/i);
});

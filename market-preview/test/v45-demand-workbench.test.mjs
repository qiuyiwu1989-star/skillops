import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE=path.dirname(fileURLToPath(import.meta.url));
const read=name=>fs.readFileSync(path.resolve(HERE,'..',name),'utf8');
const HTML=read('demand.html'),CSS=read('demand.css'),JS=read('demand.js');
const {normalizeDemandWorkbench}=await import(pathToFileURL(path.resolve(HERE,'../demand.js')));
const PUBLIC_FIXTURE=JSON.parse(read('demand.fixture.json'));
const fixture={schemaVersion:1,generatedAt:'2026-08-14T05:00:00Z',taskExample:{summaryZh:'起草并校对正式项目通知',intentTags:['公文','写作']},plan:{status:'ready',nextActions:['核对离线草案'],recommendations:[{productId:`prod_${'a'.repeat(64)}`,releaseId:`rel_${'b'.repeat(64)}`,abilityType:'skill',titleZh:'中文公文写作',status:'ready',code:'ACCESS_ALLOWED',reasonZh:'匹配公文任务并已授权',matchReasons:['公文'],acquisitionState:'entitled',entitlementId:`ent_${'c'.repeat(64)}`,grantedRights:['invoke']}],workOrderDraft:{nonExecutable:true,adapter:'code.zaowuyun.future.v1',steps:[{position:1,productId:`prod_${'a'.repeat(64)}`,releaseId:`rel_${'b'.repeat(64)}`,entitlementId:`ent_${'c'.repeat(64)}`,rights:['invoke'],environment:'staging'}]}},library:{summary:{total:1,callable:1,blocked:0,withdrawn:0},items:[{entitlementId:`ent_${'c'.repeat(64)}`,productId:`prod_${'a'.repeat(64)}`,titleZh:'中文公文写作',abilityType:'skill',releaseIds:[`rel_${'b'.repeat(64)}`],rights:['invoke'],status:'callable',callable:true,blockReason:null}]}};

test('中文只读工作台包含技能管家、结果、企业库与非执行草案',()=>{for(const x of ['技能管家','受限任务摘要示例','可信能力结果','企业授权库','非执行型 WorkOrder 草案'])assert.match(HTML+JS,new RegExp(x));assert.match(HTML,/本地只读/);assert.match(HTML,/aria-live="polite"/);assert.match(HTML,/skip-link/);assert.doesNotMatch(HTML,/<form|<button|<input|<textarea|contenteditable/);assert.doesNotMatch(HTML+JS,/立即购买|自动下单|连接生产/)});
test('无外部资源、危险DOM sink、网络与执行入口',()=>{assert.doesNotMatch(HTML,/https?:\/\/|preconnect|fonts\.googleapis|fonts\.gstatic/);assert.doesNotMatch(JS,/innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(|new Function|WebSocket|EventSource/);assert.doesNotMatch(JS,/fetch\([^u]|\.post\(|method\s*:\s*['"]POST/i)});
test('标准fixture呈现ready、授权库和固定WorkOrder',()=>{const d=normalizeDemandWorkbench(fixture);assert.equal(d.plan.status,'ready');assert.equal(d.plan.recommendations[0].code,'ACCESS_ALLOWED');assert.equal(d.library.items[0].callable,true);assert.equal(d.plan.workOrderDraft.nonExecutable,true);assert.equal(d.plan.workOrderDraft.steps[0].rights[0],'invoke')});
test('本地预览fixture覆盖已授权、免费、付费、不可用和企业授权库',()=>{const d=normalizeDemandWorkbench(PUBLIC_FIXTURE);assert.deepEqual([...new Set(d.plan.recommendations.map(x=>x.acquisitionState))].sort(),['entitled','free_available','purchase_required','unavailable']);assert.equal(d.library.items.length,2);assert.equal(d.plan.workOrderDraft.steps.length,1)});
test('隐私字段、路径、URL和可执行草案失败关闭',()=>{for(const patch of [{secret:'x'},{taskExample:{...fixture.taskExample,summaryZh:'/Users/private/data'}},{plan:{...fixture.plan,workOrderDraft:{...fixture.plan.workOrderDraft,nonExecutable:false}}},{plan:{...fixture.plan,workOrderDraft:{...fixture.plan.workOrderDraft,url:'https://code.example'}}}])assert.throws(()=>normalizeDemandWorkbench(Object.assign(structuredClone(fixture),patch)),/PUBLIC_DEMAND_DATA_REQUIRED/)});
test('Rams响应式、暗色、焦点与低动效明确',()=>{assert.match(CSS,/--bg:#fbfaf6/);assert.match(CSS,/--accent:#e2522a/);assert.match(CSS,/--max:1440px/);assert.match(CSS,/@media\(max-width:640px\)/);assert.match(CSS,/@media\(prefers-color-scheme:dark\)/);assert.match(CSS,/:focus-visible/);assert.match(CSS,/@media\(prefers-reduced-motion:reduce\)/);assert.doesNotMatch(CSS,/box-shadow\s*:/)});

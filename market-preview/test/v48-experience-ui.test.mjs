import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

const ROOT=path.resolve(import.meta.dirname,'..');
const HTML=fs.readFileSync(path.join(ROOT,'experience.html'),'utf8');
const CSS=fs.readFileSync(path.join(ROOT,'experience.css'),'utf8');
const JS=fs.readFileSync(path.join(ROOT,'experience.js'),'utf8');
const {normalizeExperienceListing,inferTags}=await import(pathToFileURL(path.join(ROOT,'experience.js')));

test('在线体验采用工作台三栏布局和明确双阶段动作',()=>{for(const copy of ['先在线体验','生成体验工作单','加载到技能管家工作台','code.zaowuyun.workbench.v1'])assert.match(HTML+JS,new RegExp(copy));assert.match(CSS,/grid-template-columns:minmax\(240px/);assert.match(CSS,/@media\(max-width:720px\)/);assert.match(HTML,/textarea[^>]+maxlength="240"/)});
test('市场到工作单只有一次显式POST且没有模型、脚本或外部资源',()=>{assert.match(JS,/method:'POST'/);assert.match(JS,/\/api\/v1\/preview\/workbench\/handoffs/);assert.doesNotMatch(HTML,/preconnect|fonts\.googleapis|https?:\/\//);assert.doesNotMatch(JS,/eval\(|new Function|WebSocket|EventSource|child_process|localStorage|sessionStorage/)});
test('体验技能输入固定版本并拒绝敏感路径',()=>{const base={id:'cand_aaaaaaaaaaaaaaaaaaaa',name:'客户简报',description:'整理访谈证据',original:{name:'customer-brief'},catalog:{category:'研究洞察'},version:{fingerprint:`sha256:${'b'.repeat(64)}`},sms:{total:86,tier:'S'},eval:{status:'pending'},distribution:'content',install:{status:'source_required'}};assert.equal(normalizeExperienceListing(base).smsTotal,86);assert.throws(()=>normalizeExperienceListing({...base,description:'位置:/etc/passwd'}))});
test('中文技能标题会被规范成工作台可接受的意图标签',()=>{const tags=inferTags('盘点企业技能并制定评估计划',{category:'operations',titleZh:'SkillOps 技能人事部'});assert.ok(tags.includes('SkillOps-技能人事部'));assert.ok(tags.every(tag=>/^[\p{L}\p{N}][\p{L}\p{N}._-]{0,63}$/u.test(tag))) });

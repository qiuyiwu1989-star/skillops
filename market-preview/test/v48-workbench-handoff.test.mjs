import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createPreviewWorkbenchService } from '../preview-workbench.mjs';
import { createPreviewServer } from '../serve.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const NOW = '2026-08-14T00:00:00.000Z';

function fixture() {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'skillops-v48-'));
  const listingsPath = path.join(root, 'listings.json');
  fs.writeFileSync(listingsPath, JSON.stringify({ listings: [{
    id: 'cand_aaaaaaaaaaaaaaaaaaaa', name: '客户简报', original: { name: 'customer-brief' },
    catalog: { category: '研究洞察' }, version: { fingerprint: `sha256:${'b'.repeat(64)}` },
    distribution: 'content', sms: { total: 86, tier: 'S' }, eval: { status: 'pending' }, install: { status: 'source_required' },
  }] }));
  return createPreviewWorkbenchService({ listingsPath, ledgerPath: path.join(root, 'handoffs.json'), clock: () => new Date(NOW) });
}

function request(overrides = {}) {
  return { skillId: 'cand_aaaaaaaaaaaaaaaaaaaa', taskSummaryZh: '把访谈证据整理成机会简报', intentTags: ['客户研究', '简报'], ...overrides };
}

test('本地服务从市场记录生成可重放的安全交接单', () => {
  const service = fixture();
  const first = service.create(request());
  const replay = service.create(request());
  assert.equal(first.action, 'created');
  assert.equal(replay.action, 'unchanged');
  assert.equal(first.handoff.handoffId, replay.handoff.handoffId);
  assert.equal(service.get(first.handoff.handoffId).skill.titleZh, '客户简报');
  assert.doesNotMatch(JSON.stringify(first), /cand_|storageRef|SKILL\.md|prompt|output|token|secret|https?:\/\//i);
});

test('调用者不能自填版本、身份、路径、网址或敏感材料', () => {
  const service = fixture();
  assert.throws(() => service.create(request({ versionFingerprint: `sha256:${'c'.repeat(64)}` })), error => error.code === 'UNKNOWN_FIELD');
  assert.throws(() => service.create(request({ taskSummaryZh: '读取:/etc/passwd' })), error => error.code === 'INVALID_REQUEST');
  assert.throws(() => service.create(request({ skillId: 'cand_bbbbbbbbbbbbbbbbbbbb' })), error => error.code === 'SKILL_NOT_FOUND');
});

test('HTTP 完成创建与读取，未注入服务时失败关闭', async t => {
  const server = createPreviewServer({ root: ROOT, workbenchService: fixture() });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const created = await fetch(`${base}/api/v1/preview/workbench/handoffs`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(request()) });
  assert.equal(created.status, 201);
  const body = await created.json();
  const fetched = await fetch(`${base}/api/v1/preview/workbench/handoffs/${body.data.handoff.handoffId}`);
  assert.equal(fetched.status, 200);
  assert.equal((await fetched.json()).data.task.summaryZh, request().taskSummaryZh);

  const disabled = createPreviewServer({ root: ROOT });
  await new Promise((resolve, reject) => { disabled.once('error', reject); disabled.listen(0, '127.0.0.1', resolve); });
  t.after(() => new Promise(resolve => disabled.close(resolve)));
  const unavailable = await fetch(`http://127.0.0.1:${disabled.address().port}/api/v1/preview/workbench/handoffs`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal(unavailable.status, 503);
});

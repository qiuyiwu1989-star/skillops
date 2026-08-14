import assert from 'node:assert/strict';
import test from 'node:test';
import { createWorkbenchHandoff, validateWorkbenchHandoff } from '../lib/workbench/workbench-handoff.mjs';

const input = {
  task: { summaryZh: '把客户访谈整理成一页机会简报', intentTags: ['客户研究', '简报'] },
  skill: {
    skillRef: `previewskill_${'a'.repeat(64)}`, titleZh: '客户简报', originalName: 'customer-brief', category: '研究洞察',
    versionFingerprint: `sha256:${'b'.repeat(64)}`, distribution: 'content', smsTotal: 86, smsTier: 'S', evalStatus: 'pending', installStatus: 'source_required',
  },
  context: { organizationId: 'org_zaowuyun_preview', projectId: null, environment: 'preview' },
};

test('创建固定技能版本与执行边界的工作台交接单', () => {
  const handoff = createWorkbenchHandoff(input, { now: new Date('2026-08-14T00:00:00Z') });
  assert.match(handoff.handoffId, /^wbh_[a-f0-9]{64}$/);
  assert.equal(handoff.adapter.current, 'skillops.steward.local.v1');
  assert.equal(handoff.adapter.future, 'code.zaowuyun.workbench.v1');
  assert.equal(handoff.experience.nonExecutable, true);
  assert.equal(validateWorkbenchHandoff(handoff, { at: '2026-08-14T00:10:00Z' }).handoffDigest, handoff.handoffDigest);
});

test('篡改、过期、候选身份、路径、网址和密钥失败关闭', () => {
  const handoff = createWorkbenchHandoff(input, { now: '2026-08-14T00:00:00Z' });
  assert.throws(() => validateWorkbenchHandoff({ ...handoff, skill: { ...handoff.skill, titleZh: '被篡改' } }), error => error.code === 'HANDOFF_DIGEST_MISMATCH');
  assert.throws(() => validateWorkbenchHandoff(handoff, { at: handoff.expiresAt }), error => error.code === 'HANDOFF_EXPIRED');
  for (const summaryZh of ['cand_deadbeef123456789012', '读取:/etc/passwd', '访问 https://example.com', '使用 ghp_abcdefghijklmnop']) {
    assert.throws(() => createWorkbenchHandoff({ ...input, task: { ...input.task, summaryZh } }, { now: '2026-08-14T00:00:00Z' }));
  }
});

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const read = name => fs.readFileSync(path.resolve(HERE, '..', name), 'utf8');
const HTML = read('creator.html');
const CSS = read('creator.css');
const JS_PATH = path.resolve(HERE, '../creator.js');
const JS = fs.readFileSync(JS_PATH, 'utf8');
const FIXTURE = JSON.parse(fs.readFileSync(path.resolve(HERE, '../../trusted-supply/fixtures/v44-creator/creator-public.json'), 'utf8'));
const { normalizeCreatorData } = await import(pathToFileURL(JS_PATH));

test('creator center is a Chinese read-only information architecture', () => {
  for (const copy of ['创作者中心', '创作有据', '发布概况', '作品与下一动作', '版本与发布证据', '权利声明', '审核缺口', '申诉记录']) {
    assert.match(HTML + JS, new RegExp(copy));
  }
  assert.match(HTML, /本地只读/);
  assert.match(HTML, /aria-live="polite"/);
  assert.match(HTML, /class="skip-link/);
  assert.doesNotMatch(HTML, /https?:\/\/|preconnect|fonts\.googleapis|fonts\.gstatic/);
  assert.doesNotMatch(HTML, /<form|<button|<input|<textarea|contenteditable/);
  assert.doesNotMatch(HTML + JS, /立即发布|确认召回|批准上架|上传技能|连接生产|真实支付/);
});

test('loader supports injected creator data, meta URL and body URL without unsafe DOM sinks', () => {
  assert.match(JS, /SKILLOPS_CREATOR_DATA/);
  assert.match(JS, /skillops:creator-url/);
  assert.match(JS, /dataset\.creatorUrl/);
  assert.match(JS, /response\.json\(\)/);
  assert.doesNotMatch(JS, /innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(|new Function/);
});

test('normalizer derives honest status counts and preserves evidence, rights, gaps and appeals', () => {
  const data = normalizeCreatorData(FIXTURE);
  assert.equal(data.publisher.displayName, '造物云能力实验室');
  assert.equal(data.summary.works, 7);
  assert.equal(data.summary.drafts, 1);
  assert.equal(data.summary.inReview, 1);
  assert.equal(data.summary.changesRequired, 1);
  assert.equal(data.summary.published, 2);
  assert.equal(data.summary.inactive, 2);
  assert.deepEqual(data.works[0].rightsSummary, ['商业输出', '组织内调用']);
  assert.equal(data.works[0].timeline.length, 2);
  assert.equal(data.works.find(work => work.status === 'recalled').appeals.length, 1);
});

test('empty data remains a valid private-by-default creator state', () => {
  const data = normalizeCreatorData({ schemaVersion: 1, generatedAt: '2026-08-14T10:00:00Z', publisher: { publisherId: 'pub_demo', displayName: '新创作者', kind: 'individual', status: 'active' }, works: [] });
  assert.equal(data.summary.works, 0);
  assert.deepEqual(data.works, []);
});

test('private identity, Candidate, CAS, local paths, skill body, prompt, output and secrets fail closed', () => {
  const forbidden = [
    { publisher: { identityReceipt: { provider: 'idp' } } },
    { works: [{ workId: 'cand_private' }] },
    { works: [{ packageRef: 'cas:sha256:private' }] },
    { works: [{ localPath: '/private/package' }] },
    { works: [{ skillContent: '# secret skill' }] },
    { works: [{ prompt: 'private prompt' }] },
    { works: [{ output: 'private output' }] },
    { works: [{ token: 'private-token' }] },
  ];
  for (const leak of forbidden) {
    const value = structuredClone(FIXTURE);
    Object.assign(value, leak);
    assert.throws(() => normalizeCreatorData(value), /PUBLIC_CREATOR_DATA_REQUIRED/);
  }
});

test('Rams tokens, restrained material, mobile, dark, focus and reduced motion are explicit', () => {
  assert.match(CSS, /--bg:\s*#fbfaf6/);
  assert.match(CSS, /--accent:\s*#e2522a/);
  assert.match(CSS, /--max:\s*1180px/);
  assert.match(CSS, /@media \(max-width: 640px\)/);
  assert.match(CSS, /@media \(prefers-color-scheme: dark\)/);
  assert.match(CSS, /:focus-visible/);
  assert.match(CSS, /@media \(prefers-reduced-motion: reduce\)/);
  assert.doesNotMatch(CSS, /box-shadow\s*:/);
});

test('visible Chinese copy avoids em dash, vanity metrics and fake commerce', () => {
  assert.doesNotMatch(HTML + JS, /[—–]/);
  assert.doesNotMatch(HTML + JS, /下载量|五星|粉丝数|评论数|预计收益|虚拟收入/);
});

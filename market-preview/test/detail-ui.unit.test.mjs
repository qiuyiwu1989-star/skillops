import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HTML = fs.readFileSync(path.resolve(HERE, '../detail.html'), 'utf8');
const CSS = fs.readFileSync(path.resolve(HERE, '../detail.css'), 'utf8');
const JS = fs.readFileSync(path.resolve(HERE, '../detail.js'), 'utf8');

test('detail template provides a real Chinese information architecture', () => {
  for (const copy of ['适用场景', 'SMS 静态潜力', 'Eval 运行实绩', '来源与版本', '许可、安全与审核', '技能包与受控部署', '相关技能']) {
    assert.match(HTML, new RegExp(copy));
  }
  assert.match(HTML, /id="original-name"/);
  assert.match(HTML, /返回能力市场/);
  assert.doesNotMatch(HTML + JS, /五星|评论数|下载量|虚构成功率/);
});

test('detail loader accepts injected JSON, meta, data attributes and path inference', () => {
  assert.match(JS, /#skillops-detail-config/);
  assert.match(JS, /skillops:listing-url/);
  assert.match(JS, /body\.skillId/);
  assert.match(JS, /location\.pathname\.match/);
  assert.match(JS, /payload\?\.listing \|\| payload\?\.skill/);
});

test('SMS and Eval keep separate definitions and complete evidence', () => {
  for (const key of ['clarity', 'invocability', 'executability', 'stability', 'quality', 'reusability', 'composability', 'evaluability', 'safety', 'business']) {
    assert.match(JS, new RegExp(`${key}:`));
  }
  assert.match(JS, /dimension\.reason/);
  assert.match(JS, /dimension\.evidence/);
  assert.match(JS, /页面不会用 SMS 分数替代实绩/);
});

test('install action requires an eligible complete package and excludes source-only listings', () => {
  assert.match(JS, /listing\.install\?\.status === 'eligible'/);
  assert.match(JS, /listing\.install\?\.packageComplete === true/);
  assert.match(JS, /listing\.distribution !== 'source_link_only'/);
  assert.match(JS, /漂移检测和 lock 台账/);
  assert.match(JS, /packageRecord\.packageDigest/);
  assert.match(JS, /packageAudit\?\.status/);
  assert.match(JS, /文件清单/);
  assert.match(JS, /manifest\.slice\(0, 20\)/);
});

test('detail uses the shared Zaowuyun shell and remains responsive and accessible', () => {
  assert.match(HTML, /zaowuyun-tokens\.css/);
  assert.match(HTML, /zaowuyun-shell\.css/);
  assert.match(HTML, /class="zy-header"/);
  assert.match(CSS, /@media \(max-width: 640px\)/);
  assert.match(CSS, /:focus-visible/);
  assert.match(HTML, /class="zy-skip-link/);
  assert.match(HTML, /aria-live="polite"/);
});

test('visible detail copy avoids em dash and en dash', () => {
  assert.doesNotMatch(HTML, /[—–]/);
  assert.doesNotMatch(JS.replace(/replace\(\/\[[^\n]+/, ''), /[—–]/);
});

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const ROOT = path.resolve(import.meta.dirname, '..');
const JS = fs.readFileSync(path.join(ROOT, 'detail.js'), 'utf8');
const HTML = fs.readFileSync(path.join(ROOT, 'detail.html'), 'utf8');
const CSS = fs.readFileSync(path.join(ROOT, 'detail.css'), 'utf8');

test('detail keeps Eval separate from SMS and renders canonical execution evidence', () => {
  assert.match(HTML, /SMS 静态潜力/);
  assert.match(HTML, /Eval 运行实绩/);
  assert.match(JS, /evaluation\.suiteId/);
  assert.match(JS, /evaluation\.suiteVersion/);
  assert.match(JS, /evaluation\.suiteDigest/);
  assert.match(JS, /evaluation\.runner/);
  assert.match(JS, /evaluation\.environment/);
  assert.match(JS, /evaluation\.basedOnPackageDigest/);
  assert.match(JS, /evaluation\.cases/);
  assert.match(JS, /case-evidence/);
  assert.match(CSS, /\.eval-case-list/);
  assert.match(CSS, /\.eval-case/);
});

test('detail does not invent success evidence for pending or stale Eval', () => {
  assert.match(JS, /evaluation\.status === 'pending'/);
  assert.match(JS, /evaluation\.status === 'stale'/);
  assert.match(JS, /页面不会用 SMS 分数替代实绩/);
});

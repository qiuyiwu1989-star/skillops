import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HTML = fs.readFileSync(path.resolve(HERE, '../index.html'), 'utf8');
const CSS = fs.readFileSync(path.resolve(HERE, '../styles.css'), 'utf8');
const JS = fs.readFileSync(path.resolve(HERE, '../app.js'), 'utf8');

test('market starts with task search and real category discovery controls', () => {
  assert.match(HTML, /你想完成什么任务/);
  assert.match(HTML, /id="category-list"/);
  assert.match(JS, /listing\.catalog\?\.category/);
  assert.match(JS, /listingCategory\(listing\)/);
});

test('market defines at least three explainable trust shelves', () => {
  for (const shelf of ['编辑精选', '高 SMS 潜力', '最近上架', '来源已签名', '无需密钥']) assert.match(JS, new RegExp(shelf));
  assert.doesNotMatch(HTML + JS, /五星|收藏量|下载榜|downloads/i);
});

test('SMS potential and Eval evidence are explicitly separate', () => {
  assert.match(JS, /SMS 静态潜力/);
  assert.match(JS, /静态质量潜力，不代表真实运行成功率/);
  assert.match(JS, /Eval 运行实绩/);
  assert.match(JS, /基于测试集与运行环境的实绩证据/);
  assert.match(JS, /尚无实绩数据/);
});

test('detail supports progressive catalog fields and legacy listings', () => {
  assert.match(JS, /listing\.catalog\?\.coordinate/);
  assert.match(JS, /listing\.source\?\.marketplaceUrl/);
  assert.match(JS, /listing\.source\?\.integrity\?\.signed/);
  assert.match(JS, /function listingTags/);
  assert.match(JS, /listing\.description/);
  assert.match(JS, /listing\.original\?\.name/);
  assert.match(JS, /自动翻译，待人工校对/);
  assert.match(JS, /history\.replaceState/);
  assert.match(JS, /查看完整详情/);
  assert.match(JS, /快速预览/);
  assert.match(JS, /\.\/skills\/\$\{encodeURIComponent/);
});

test('installation boundary requires package completeness and controlled deployment', () => {
  assert.match(JS, /skillops deploy 的目标检查、漂移检测和 lock 台账/);
  assert.match(JS, /listing\.install\?\.status === 'eligible'/);
  assert.match(JS, /仅同步部分内容/);
  assert.match(JS, /不提供直接安装/);
  assert.doesNotMatch(HTML, />安装</);
});

test('Rams contract and responsive market layout remain intact', () => {
  assert.match(CSS, /--bg:\s*#fbfaf6/);
  assert.match(CSS, /--accent:\s*#e2522a/);
  assert.match(CSS, /--max:\s*1120px/);
  assert.match(CSS, /--r-sm:\s*3px/);
  assert.match(CSS, /--r-md:\s*8px/);
  assert.match(CSS, /--r-pill:\s*999px/);
  assert.match(CSS, /@media \(max-width: 640px\)/);
  assert.match(CSS, /scroll-snap-type:\s*x mandatory/);
  assert.doesNotMatch(CSS, /box-shadow\s*:/);
});

test('visible copy avoids em dash and en dash', () => {
  assert.doesNotMatch(HTML, /[—–]/);
  assert.doesNotMatch(JS.replace(/replace\(\/\[[^\n]+/, ''), /[—–]/);
});

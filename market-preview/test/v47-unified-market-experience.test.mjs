import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const read = name => fs.readFileSync(path.resolve(HERE, '..', name), 'utf8');
const pages = ['index.html', 'detail.html', 'demand.html', 'creator.html', 'enterprise.html', 'ops.html'];
const htmlByPage = Object.fromEntries(pages.map(name => [name, read(name)]));
const shell = read('zaowuyun-shell.css');
const tokens = read('zaowuyun-tokens.css');

test('all market surfaces share one Zaowuyun product shell and local brand asset', () => {
  for (const [name, html] of Object.entries(htmlByPage)) {
    assert.match(html, /zaowuyun-tokens\.css/, `${name} must use official tokens`);
    assert.match(html, /zaowuyun-shell\.css/, `${name} must use the shared shell`);
    assert.match(html, /zaowuyun-mark-color\.svg/, `${name} must use the Zaowuyun mark`);
    assert.match(html, /class="zy-header"/, `${name} must use the shared header`);
    assert.doesNotMatch(html, /data-theme="rams"|fonts\.googleapis|fonts\.gstatic|preconnect/, `${name} must not depend on the retired Rams or remote font shell`);
  }
});

test('primary navigation describes one coherent market journey', () => {
  for (const name of ['index.html', 'detail.html', 'demand.html', 'creator.html', 'enterprise.html']) {
    const html = htmlByPage[name];
    for (const label of ['能力市场', '技能管家', '创作者中心', '企业技能人事部']) {
      assert.match(html, new RegExp(label), `${name} is missing ${label}`);
    }
  }
  assert.match(htmlByPage['index.html'], /找到技能，<br>马上开始调用/);
  assert.match(htmlByPage['index.html'], /让技能管家查找/);
});

test('Zaowuyun shell preserves responsive, accessible and low-motion constraints', () => {
  assert.match(tokens, /--accent:\s*#7B80FF/);
  assert.match(tokens, /--container-doc:\s*1280px/);
  assert.match(shell, /min-height:\s*64px/);
  assert.match(shell, /@media \(max-width: 900px\)/);
  assert.match(shell, /@media \(max-width: 520px\)/);
  assert.match(shell, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(shell, /:focus-visible|\.zy-skip-link:focus/);
});

test('unified visible shell copy avoids em dash and en dash', () => {
  for (const [name, html] of Object.entries(htmlByPage)) {
    assert.doesNotMatch(html, /[—–]/, `${name} contains a forbidden dash`);
  }
});

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const ROOT = path.resolve(import.meta.dirname, '..');
const APP = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');
const DETAIL = fs.readFileSync(path.join(ROOT, 'detail.js'), 'utf8');
const CSS = fs.readFileSync(path.join(ROOT, 'styles.css'), 'utf8');
const DETAIL_CSS = fs.readFileSync(path.join(ROOT, 'detail.css'), 'utf8');
const UI = `${APP}\n${DETAIL}`;

test('market and detail expose the full Chinese trust lifecycle vocabulary', () => {
  for (const copy of [
    '旧版批准，待双人终审', '双人终审有效', '待第二人复核', '认证即将到期', '证据已失效', '已撤回', '已召回',
    '技能已退役', '已恢复，待重新验证', '当前不可直接安装',
  ]) assert.match(UI, new RegExp(copy));
  assert.match(APP, /approved: '旧版批准，待双人终审'/);
  assert.match(DETAIL, /approved: '旧版批准，待双人终审'/);
  for (const state of [
    'certified', 'pending_second_review', 'expiring', 'stale', 'withdrawn', 'recalled',
    'retired', 'active_pending_revalidation',
  ]) assert.match(UI, new RegExp(state));
});

test('installation fails closed on explicit eligibility, source-only and non-current trust', () => {
  for (const source of [APP, DETAIL]) {
    assert.match(source, /declaredEligibility === false/);
    assert.match(source, /listing\.distribution === 'source_link_only'/);
    assert.match(source, /install\.packageComplete === true/);
    assert.match(source, /trust\.code === 'certified'/);
    assert.match(source, /human_certification_required/);
  }
  assert.match(DETAIL, /查看来源并继续判断/);
  assert.match(UI, /安装资格被治理策略明确关闭/);
});

test('detail presents package, SMS, Eval and review digest bindings without raw private data', () => {
  for (const field of ['evidenceDigest', 'packageDigest', 'smsDigest', 'evalDigest', 'certificationDigest']) {
    assert.match(DETAIL, new RegExp(field));
  }
  for (const copy of ['证据快照', '绑定技能包', '绑定 SMS', '绑定 Eval', '绑定终审', '可追溯']) {
    assert.match(DETAIL, new RegExp(copy));
  }
  assert.doesNotMatch(UI, /rawPrompt|rawOutput|promptContent|outputContent|accessToken|secretValue/);
});

test('trust feedback preserves card rhythm and the accessible Zaowuyun motion system', () => {
  assert.match(CSS, /\.card-topline\s*\{[^}]*min-height:\s*34px/s);
  assert.match(CSS, /\.trust-badge/);
  assert.match(DETAIL_CSS, /\.trust-badge/);
  assert.match(CSS + DETAIL_CSS, /\.trust-positive/);
  assert.match(CSS + DETAIL_CSS, /\.trust-critical/);
  assert.match(CSS + DETAIL_CSS, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(CSS, /box-shadow:\s*var\(--sh1\)/);
  assert.doesNotMatch(UI.replace(/replace\(\/\[[^\n]+/g, ''), /[—–]/);
});

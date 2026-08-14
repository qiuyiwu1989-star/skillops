import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CSS = fs.readFileSync(path.resolve(HERE, '../styles.css'), 'utf8');
const JS = fs.readFileSync(path.resolve(HERE, '../app.js'), 'utf8');

test('市场技能卡采用强商品层级而非纵向审核表', () => {
  assert.match(CSS, /\.skill-card\s*\{[^}]*padding:\s*clamp\(24px,[^}]*border:\s*1px solid var\(--bdrBrt\)/s);
  assert.match(CSS, /\.skill-card h3\s*\{[^}]*font-size:\s*clamp\(28px,[^}]*font-weight:\s*600/s);
  assert.match(CSS, /\.listing-grid\s*\{[^}]*grid-template-columns:\s*repeat\(2,/s);
  assert.match(CSS, /\.market-metrics\s*\{[^}]*grid-template-columns:\s*repeat\(3,/s);
  assert.match(CSS, /\.card-primary-actions\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\) auto/s);
  assert.doesNotMatch(JS, /evidenceRow\('安装状态'/);
  assert.doesNotMatch(JS, /evidenceRow\('安全与许可'/);
});

test('主操作直接支持调用，完整证据仍通过详情与快速预览访问', () => {
  assert.match(JS, /function invocationText\(listing\)/);
  assert.match(JS, /copyButton = text\('button', '复制调用词', 'btn primary invocation-copy'\)/);
  assert.match(JS, /text\('a', '查看完整详情', 'btn'\)/);
  assert.match(JS, /text\('button', '快速预览', 'text-button mono'\)/);
  assert.match(JS, /if \(recommendation\.matched \|\| related\.length\) main\.append\(recommendationPanel\)/);
});

test('视觉强化不冒充可信安装资格', () => {
  assert.match(JS, /topline\.append\(tags, trustBadge\(listing\)\)/);
  assert.match(JS, /evidenceRow\('使用边界', installation\.eligible \? '可受控部署' : humanDistribution\(listing\.distribution\)\)/);
  assert.match(JS, /请先确认适用场景与使用边界/);
});

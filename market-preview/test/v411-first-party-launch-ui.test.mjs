import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const PREVIEW = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('market presents the six-skill launch cohort as evidence-driven preparation, not fake availability', () => {
  const app = fs.readFileSync(path.join(PREVIEW, 'app.js'), 'utf8');
  const detail = fs.readFileSync(path.join(PREVIEW, 'detail.js'), 'utf8');
  const css = fs.readFileSync(path.join(PREVIEW, 'styles.css'), 'utf8');
  assert.match(app, /首发技能培育/);
  assert.match(app, /limit:\s*6/);
  assert.match(app, /待运行 Eval/);
  assert.match(app, /SMS 待提升/);
  assert.match(detail, /Eval 测试集已准备/);
  assert.match(detail, /尚未在隔离环境运行，不计作实绩/);
  assert.match(css, /\.launch-readiness/);
});

test('generated catalog carries public readiness for exactly six first-party skills', () => {
  const artifact = JSON.parse(fs.readFileSync(path.join(PREVIEW, 'data', 'listings.json'), 'utf8'));
  const launch = artifact.listings.filter(item => item.catalog?.launchReadiness);
  assert.equal(launch.length, 6);
  assert.equal(new Set(launch.map(item => item.catalog.launchReadiness.key)).size, 6);
  assert.ok(launch.every(item => item.catalog.launchReadiness.releaseReady === false));
  assert.ok(launch.every(item => item.install.status === 'source_required'));
  assert.doesNotMatch(JSON.stringify(launch.map(item => item.catalog.launchReadiness)), /cand_|storageRef|SKILL\.md|prompt|output/i);
});

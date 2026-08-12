import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CSS = fs.readFileSync(path.resolve(HERE, '../styles.css'), 'utf8');
const JS = fs.readFileSync(path.resolve(HERE, '../app.js'), 'utf8');

test('desktop cards share a stable vertical rhythm without fixed oversized heights', () => {
  assert.match(JS, /main\.className = 'card-layout'/);
  assert.match(CSS, /\.skill-card\s*\{[^}]*display:\s*flex[^}]*height:\s*100%/s);
  assert.match(CSS, /\.card-layout\s*\{[^}]*flex-direction:\s*column/s);
  assert.match(CSS, /\.market-metrics\s*\{[^}]*margin-top:\s*auto/s);
  assert.doesNotMatch(CSS, /\.skill-card\s*\{[^}]*min-height:\s*[5-9]\d{2}px/s);
});

test('catalog summaries are line-clamped while trust evidence stays visible', () => {
  assert.match(CSS, /\.description\s*\{[^}]*-webkit-line-clamp:\s*4/s);
  assert.match(CSS, /\.skill-card h3\s*\{[^}]*-webkit-line-clamp:\s*2/s);
  assert.doesNotMatch(CSS, /\.market-metrics[^}]*line-clamp/s);
  assert.doesNotMatch(CSS, /\.card-actions[^}]*line-clamp/s);
  assert.match(JS, /查看完整详情/);
  assert.match(JS, /text\('p', listing\.description, 'detail-description'\)/);
});

test('mobile cards return to natural flow', () => {
  const mobile = CSS.match(/@media \(max-width: 640px\) \{([\s\S]*?)\n\}/)?.[1] || '';
  assert.match(mobile, /\.skill-card\s*\{[^}]*height:\s*auto/s);
  assert.match(mobile, /\.skill-card h3,\s*\.compact-card h3\s*\{[^}]*min-height:\s*0/s);
  assert.match(mobile, /\.skill-card h3,\s*\.compact-card h3\s*\{[^}]*-webkit-line-clamp:\s*unset/s);
  assert.match(mobile, /\.original-name:empty\s*\{[^}]*display:\s*none/s);
  assert.match(mobile, /\.description,\s*\.compact-card \.description\s*\{[^}]*min-height:\s*0/s);
  assert.match(mobile, /\.description,\s*\.compact-card \.description\s*\{[^}]*-webkit-line-clamp:\s*unset/s);
  assert.match(mobile, /\.shelf-track\s*\{[^}]*align-items:\s*flex-start/s);
});

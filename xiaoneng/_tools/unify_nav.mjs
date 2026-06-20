#!/usr/bin/env node
// Retrofit every page to the shared nav component (/nav.js).
// Replaces the inline <nav class="xn-nav">…</nav> with an empty mount + ensures the script tag.
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const PAGES = {
  'index.html': '',
  'evaluate/index.html': 'evaluate',
  'registry/index.html': 'registry',
  'sms/index.html': 'sms',
  'docs/index.html': 'docs',
  'dashboard/index.html': '',
  'demo/index.html': '',
  'pricing/index.html': '',
  'en/index.html': '',
};

const NAV_RE = /<nav class="xn-nav"[\s\S]*?<\/nav>/;

let changed = 0, skipped = [];
for (const [rel, active] of Object.entries(PAGES)) {
  const fp = path.join(ROOT, rel);
  if (!fs.existsSync(fp)) { skipped.push(rel + ' (missing)'); continue; }
  let html = fs.readFileSync(fp, 'utf8');
  const mount = `<nav class="xn-nav" id="xn-nav" data-active="${active}"></nav>`;

  if (NAV_RE.test(html)) {
    html = html.replace(NAV_RE, mount);
  } else if (!html.includes('id="xn-nav"')) {
    skipped.push(rel + ' (no <nav class="xn-nav"> found)');
    continue;
  }

  // ensure the component script is present (once), just before </body>
  if (!/src="\/nav\.js"/.test(html)) {
    html = html.replace(/<\/body>/i, '  <script defer src="/nav.js"></script>\n</body>');
  }

  fs.writeFileSync(fp, html, 'utf8');
  changed++;
  console.log(`✓ ${rel}  (active="${active || '—'}")`);
}
console.log(`\n${changed} pages unified.${skipped.length ? '  Skipped: ' + skipped.join(', ') : ''}`);

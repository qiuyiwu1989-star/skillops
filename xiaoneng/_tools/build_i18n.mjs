#!/usr/bin/env node
/**
 * 小能 i18n build — path-based multilingual generator for marketing pages.
 *
 * Reads a Chinese source page + a per-language dictionary (i18n/<lang>.json,
 * a { "中文原句": "translation" } map), and emits a clean per-language page:
 *   zh (source)  →  /index.html        (canonical + hreflang injected)
 *   en           →  /en/index.html     (translated, lang=en, hreflang)
 *
 * Add a language = add i18n/<lang>.json + one line in LANGS below. Zero page edits.
 *
 * Usage:  node _tools/build_i18n.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');          // xiaoneng/
const SITE = 'https://xiaoneng.qiuyiwu.com';

// Pages to localize (relative to ROOT). Extend as more pages get templatized.
const PAGES = ['index.html'];

// Target languages (besides the zh source). htmlLang = <html lang> value.
const LANGS = [
  { code: 'en', htmlLang: 'en-US', dict: 'i18n/en.json' },
];

function applyDict(html, dict) {
  // longest keys first to avoid substring collisions (评估技能 before 评估)
  const keys = Object.keys(dict).sort((a, b) => b.length - a.length);
  for (const k of keys) html = html.split(k).join(dict[k]);
  return html;
}

function hreflang(currentHref) {
  const alts = [
    `<link rel="alternate" hreflang="zh-Hans" href="${SITE}/">`,
    `<link rel="alternate" hreflang="en" href="${SITE}/en/">`,
    `<link rel="alternate" hreflang="x-default" href="${SITE}/">`,
  ];
  return alts.join('\n  ');
}

// Path-based language toggle (replaces the old data-lang cycling toggle)
const TOGGLE_OLD = `var l=$('lang-toggle'); if(l){l.textContent=d.getAttribute('data-lang')||'zh';l.onclick=function(){var c=d.getAttribute('data-lang')||'zh';var n=LANGS[(LANGS.indexOf(c)+1)%LANGS.length];setS({lang:n});l.textContent=n;};}`;
const TOGGLE_NEW = `var l=$('lang-toggle'); if(l){ var _en=location.pathname.indexOf('/en')===0; l.textContent=_en?'中':'EN'; l.onclick=function(){ location.href=_en?'/':'/en/'; }; }`;

function injectHead(html, canonical) {
  const block = `<link rel="canonical" href="${canonical}">\n  ${hreflang()}`;
  // idempotent: strip any existing canonical + hreflang alternates, then inject
  html = html.replace(/\s*<link rel="canonical"[^>]*>/g, '');
  html = html.replace(/\s*<link rel="alternate" hreflang="[^"]*"[^>]*>/g, '');
  return html.replace('</title>', `</title>\n  ${block}`);
}

for (const page of PAGES) {
  const srcPath = path.join(ROOT, page);
  let zh = fs.readFileSync(srcPath, 'utf8');

  // --- ZH: inject canonical + hreflang + path-based toggle (write back) ---
  let zhOut = injectHead(zh, `${SITE}/`);
  zhOut = zhOut.split(TOGGLE_OLD).join(TOGGLE_NEW);
  fs.writeFileSync(srcPath, zhOut, 'utf8');
  console.log(`  ✓ zh  /${page}`);

  // --- each target language ---
  for (const L of LANGS) {
    const dict = JSON.parse(fs.readFileSync(path.join(ROOT, L.dict), 'utf8'));
    let out = applyDict(zh, dict);
    // html lang + data-lang
    out = out.replace(/<html lang="zh-CN"([^>]*?)data-lang="zh"/, `<html lang="${L.htmlLang}"$1data-lang="${L.code}"`);
    // canonical + hreflang + og:url
    out = injectHead(out, `${SITE}/${L.code}/`);
    out = out.replace(/<meta property="og:url" content="[^"]*">/, `<meta property="og:url" content="${SITE}/${L.code}/">`);
    // path-based toggle
    out = out.split(TOGGLE_OLD).join(TOGGLE_NEW);
    // leftover-Chinese check
    const left = (out.match(/[一-鿿]/g) || []).length;
    const dir = path.join(ROOT, L.code);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, page), out, 'utf8');
    console.log(`  ✓ ${L.code}  /${L.code}/${page}   (${left} CJK chars left)`);
  }
}
console.log('done.');

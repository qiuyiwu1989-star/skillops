/* SkillOps — shared top nav. Single source of truth for every page.
 * Each page has: <nav class="xn-nav" id="xn-nav" data-active="evaluate|registry|sms|docs|"></nav>
 * Renders links + CTA + theme/lang toggles; injects its own CSS (overrides any per-page .xn-nav rules).
 */
(function () {
  // ---- canonical nav CSS (appended to <head>, wins over per-page inline rules) ----
  var CSS = `
  .xn-nav { position: fixed; top: 0; left: 0; right: 0; z-index: 100; display: flex; align-items: center; gap: 24px; padding: 18px clamp(20px,4vw,48px); background: rgba(251,250,246,.85); backdrop-filter: blur(12px); border-bottom: 1px solid var(--line); box-sizing: border-box; }
  html[data-theme="light"] .xn-nav { background: rgba(255,255,255,.85); }
  html[data-theme="dark"]  .xn-nav { background: rgba(8,8,8,.85); }
  .xn-nav .brand { font-family: var(--f-display); font-weight: 600; font-size: 22px; letter-spacing: -0.02em; color: var(--text); text-decoration: none; display: flex; align-items: baseline; gap: 8px; }
  .xn-nav .brand .u { color: var(--accent); }
  .xn-nav ul { display: flex; gap: 22px; list-style: none; margin: 0 0 0 auto; padding: 0; }
  .xn-nav ul a { font-family: var(--f-mono); font-size: 12px; color: var(--muted); text-decoration: none; letter-spacing: 0.04em; transition: color .15s; }
  .xn-nav ul a:hover, .xn-nav ul a.active { color: var(--text); }
  .xn-nav ul a.active { border-bottom: 1.5px solid var(--accent); padding-bottom: 2px; }
  .xn-nav .nav-cta { font-family: var(--f-mono); font-size: 12px; padding: 8px 18px; border-radius: 999px; background: var(--accent); color: var(--bg); text-decoration: none; letter-spacing: 0.04em; }
  .xn-nav .nav-cta:hover { opacity: .88; }
  .xn-nav .icon-btn { background: transparent; border: 1px solid var(--line); width: 32px; height: 32px; border-radius: 999px; padding: 0; cursor: pointer; color: var(--muted); display: inline-flex; align-items: center; justify-content: center; }
  .xn-nav .icon-btn svg { width: 14px; height: 14px; stroke: currentColor; stroke-width: 1.5; fill: none; }
  .xn-nav .icon-btn .ico-sun, .xn-nav .icon-btn .ico-moon, .xn-nav .icon-btn .ico-rams { display: none; }
  html[data-theme="dark"]  .xn-nav .ico-moon { display: inline; }
  html[data-theme="light"] .xn-nav .ico-sun  { display: inline; }
  html[data-theme="rams"]  .xn-nav .ico-rams { display: inline; }
  .xn-nav .lang-toggle { background: transparent; border: 1px solid var(--line); color: var(--muted); font-family: var(--f-mono); font-size: 11px; padding: 6px 10px; border-radius: 999px; cursor: pointer; }
  @media (max-width: 880px) { .xn-nav ul { display: none; } }
  `;

  // ---- nav model (bilingual) ----
  var LINKS = [
    { key: 'evaluate',  href: '/evaluate/',  zh: '评估技能', en: 'Evaluate' },
    { key: 'registry',  href: '/registry/',  zh: '技能市场', en: 'Registry' },
    { key: 'exemplars', href: '/exemplars/', zh: '精选案例', en: 'Examples' },
    { key: 'connect',   href: '/connect/',   zh: '接入', en: 'Connect' },
    { key: 'sms',       href: '/sms/',       zh: 'SMS 标准', en: 'SMS' },
    { key: 'docs',      href: '/docs/',      zh: '文档',     en: 'Docs' }
  ];
  var CTA = { href: '/dashboard/', zh: '控制台 →', en: 'Console →' };

  var ICONS =
    '<svg class="ico-sun" viewBox="0 0 24 24"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"/></svg>' +
    '<svg class="ico-moon" viewBox="0 0 24 24"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>' +
    '<svg class="ico-rams" viewBox="0 0 24 24"><rect x="4" y="4" width="16" height="16"/><line x1="9" y1="4" x2="9" y2="20"/></svg>';

  function lang() { return document.documentElement.getAttribute('data-lang') === 'en' ? 'en' : 'zh'; }

  function render(nav) {
    var active = nav.getAttribute('data-active') || '';
    var L = lang();
    var lis = LINKS.map(function (l) {
      return '<li><a href="' + l.href + '"' + (l.key === active ? ' class="active"' : '') + '>' + l[L] + '</a></li>';
    }).join('');
    nav.innerHTML =
      '<a href="/" class="brand">SkillOps<span class="u">_</span></a>' +
      '<ul>' + lis + '</ul>' +
      '<a href="' + CTA.href + '" class="nav-cta">' + CTA[L] + '</a>' +
      '<button class="icon-btn" id="xn-theme" aria-label="theme">' + ICONS + '</button>' +
      '<button class="lang-toggle" id="xn-lang">' + L + '</button>';

    // ---- toggles (share the existing atlas_ui store + data attributes) ----
    function getS() { try { return JSON.parse(localStorage.getItem('atlas_ui') || '{}'); } catch (e) { return {}; } }
    function setS(p) {
      var s = Object.assign(getS(), p);
      localStorage.setItem('atlas_ui', JSON.stringify(s));
      if (s.theme) document.documentElement.setAttribute('data-theme', s.theme);
      if (s.lang)  document.documentElement.setAttribute('data-lang', s.lang);
    }
    var THEMES = ['rams', 'light', 'dark'];
    nav.querySelector('#xn-theme').addEventListener('click', function () {
      var c = document.documentElement.getAttribute('data-theme') || 'rams';
      setS({ theme: THEMES[(THEMES.indexOf(c) + 1) % THEMES.length] });
    });
    nav.querySelector('#xn-lang').addEventListener('click', function () {
      var n = lang() === 'zh' ? 'en' : 'zh';
      setS({ lang: n });
      render(nav); // re-render labels in the new language
    });
  }

  function init() {
    var st = document.createElement('style'); st.id = 'xn-nav-css'; st.textContent = CSS;
    document.head.appendChild(st);
    var nav = document.getElementById('xn-nav');
    if (!nav) { // fallback: create + prepend if a page forgot the mount
      nav = document.createElement('nav'); nav.className = 'xn-nav'; nav.id = 'xn-nav';
      document.body.insertBefore(nav, document.body.firstChild);
    }
    render(nav);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();

// 统计装载器（全站统一）—— 注入 /analytics.js（其内部按生产域名 / ID 守卫，dedup 安全）
(function () { var s = document.createElement('script'); s.src = '/analytics.js'; s.defer = true; document.head.appendChild(s); })();

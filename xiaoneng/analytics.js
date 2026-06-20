/* analytics.js — 全站统一统计装载器（百度统计 + Google Analytics 4）
 * 用法：把下面两个 ID 填上即全站生效。未填时整段是 no-op，可安全先部署。
 *   - GA4_ID   : Google Analytics 4 的「衡量 ID」，形如 G-XXXXXXXXXX
 *                （analytics.google.com → 管理 → 数据流 → skillops.tech → 衡量 ID）
 *   - BAIDU_ID : 百度统计代码里 hm.js?hm= 后面那串 hex
 *                （tongji.baidu.com → 管理 → 网站列表 → 获取代码）
 * 另外提供 window.track(name, {label}) —— 把产品事件（如"复制到任何 AI"）同时上报到两边。
 */
(function () {
  if (window.__sa_loaded) return;   // dedup：即使被多处引入也只执行一次
  window.__sa_loaded = true;
  var GA4_ID = '';   // ← 填 G-XXXXXXXXXX
  var BAIDU_ID = '4378e61d42a559aaa0c92f24600344e4';  // ← 填百度统计 hm id

  // 不在生产域名就不加载（避免本地/预览污染数据）
  var host = location.hostname;
  var isProd = (host === 'skillops.tech' || host === 'www.skillops.tech');

  if (isProd && GA4_ID) {
    var g = document.createElement('script');
    g.async = true;
    g.src = 'https://www.googletagmanager.com/gtag/js?id=' + GA4_ID;
    document.head.appendChild(g);
    window.dataLayer = window.dataLayer || [];
    window.gtag = function () { window.dataLayer.push(arguments); };
    window.gtag('js', new Date());
    window.gtag('config', GA4_ID, { anonymize_ip: true });
  }

  if (isProd && BAIDU_ID) {
    window._hmt = window._hmt || [];
    var h = document.createElement('script');
    h.async = true;
    h.src = 'https://hm.baidu.com/hm.js?' + BAIDU_ID;
    document.head.appendChild(h);
  }

  // 统一事件上报（GA4 event + 百度 _trackEvent）。任何 ID 缺失时静默。
  window.track = function (name, params) {
    params = params || {};
    try { if (window.gtag) window.gtag('event', name, params); } catch (e) {}
    try { if (window._hmt) window._hmt.push(['_trackEvent', 'skill', name, String(params.label || '')]); } catch (e) {}
  };
})();

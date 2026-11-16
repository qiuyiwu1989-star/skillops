/* SkillOps extension · content script (ChatGPT + Claude)
 * 右下「⚡ 技能」浮标 / ⌘·Ctrl+Shift+K 调起技能库 → 注入到输入框。选中文本可右键「存进库」。 */
(function () {
  if (window.__xnSkillOps) return; window.__xnSkillOps = true;
  const HOST = location.hostname;
  const isChatGPT = /chatgpt\.com|chat\.openai\.com/.test(HOST);
  const isClaude = /claude\.ai/.test(HOST);

  // ── site adapter ──
  function isVisible(el) { if (!el) return false; const r = el.getBoundingClientRect(); return r.width > 4 && r.height > 4; }
  // generic fallback: focused editable, else the last visible editable (composers sit at the bottom)
  function genericComposer() {
    const ae = document.activeElement;
    if (ae && (ae.isContentEditable || ae.tagName === 'TEXTAREA') && isVisible(ae)) return ae;
    const cands = [...document.querySelectorAll('textarea, [contenteditable="true"], [contenteditable=""]')].filter(isVisible);
    return cands.length ? cands[cands.length - 1] : null;
  }
  function findInput() {
    let el = null;
    if (isChatGPT) {
      el = document.querySelector('#prompt-textarea')                         // contenteditable div or textarea, both id'd
        || document.querySelector('main form [contenteditable="true"]')
        || document.querySelector('form textarea');
    } else if (isClaude) {
      el = document.querySelector('div.ProseMirror[contenteditable="true"]')
        || document.querySelector('[enterkeyhint] [contenteditable="true"]')
        || document.querySelector('fieldset [contenteditable="true"]');
    }
    return (el && isVisible(el)) ? el : genericComposer();
  }
  function insertText(el, text) {
    if (!el) return false;
    const payload = text + '\n\n';
    el.focus();
    if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
      const prev = el.value;
      el.value = payload + prev;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      try { el.setSelectionRange(payload.length, payload.length); } catch (e) {}
      return true;
    }
    // contenteditable (ProseMirror — ChatGPT & Claude both use it)
    try { const sel = window.getSelection(), r = document.createRange(); r.selectNodeContents(el); r.collapse(true); sel.removeAllRanges(); sel.addRange(r); } catch (e) {}
    // 1) execCommand insertText — ProseMirror honors this
    try { if (document.execCommand('insertText', false, payload)) return true; } catch (e) {}
    // 2) synthetic paste — ProseMirror listens for paste
    try {
      const dt = new DataTransfer(); dt.setData('text/plain', payload);
      el.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: dt }));
      return true;
    } catch (e) {}
    // 3) last resort
    el.textContent = payload + (el.textContent || '');
    el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: payload }));
    return true;
  }

  // ── shadow-dom UI ──
  let host, shadow, panel, listEl, searchEl, footEl;
  let SKILLS = [], filtered = [], activeIdx = 0, open = false;

  function ensureUI() {
    if (host) return;
    host = document.createElement('div'); host.id = 'xn-skillops-root';
    shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = `<style>
      .pill{position:fixed;right:18px;bottom:104px;background:#e2522a;color:#fff;font:600 12px/1 system-ui;border:none;border-radius:999px;padding:10px 14px;cursor:pointer;box-shadow:0 4px 16px rgba(0,0,0,.18);z-index:2147483647;}
      .panel{position:fixed;right:18px;bottom:150px;width:344px;max-height:62vh;background:#fbfaf6;border:1px solid #e4e1d8;border-radius:12px;box-shadow:0 14px 44px rgba(0,0,0,.2);display:none;flex-direction:column;overflow:hidden;font-family:system-ui,'Noto Sans SC',sans-serif;z-index:2147483647;}
      .panel.open{display:flex;}
      .ph{padding:12px 14px;border-bottom:1px solid #eeece5;font:600 13px system-ui;color:#161616;display:flex;align-items:center;gap:8px;}
      .ph .x{margin-left:auto;border:none;background:none;cursor:pointer;color:#a8a69c;font-size:15px;line-height:1;}
      .q{margin:10px 12px;padding:9px 11px;border:1px solid #e4e1d8;border-radius:8px;font:13px system-ui;outline:none;background:#fff;}
      .q:focus{border-color:#e2522a;}
      .list{overflow-y:auto;padding:0 6px 8px;}
      .it{padding:9px 10px;border-radius:8px;cursor:pointer;display:flex;align-items:center;gap:8px;}
      .it.on,.it:hover{background:#f3f1ea;}
      .it .nm{font:500 13px system-ui;color:#161616;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
      .it .tr{font:600 11px ui-monospace,monospace;color:#6b6b63;}
      .it .tr.S{color:#e2522a;} .it .tr.A{color:#4a9b8a;}
      .empty{padding:18px;color:#6b6b63;font:12px system-ui;text-align:center;line-height:1.6;}
      .foot{padding:8px 14px;border-top:1px solid #eeece5;font:11px ui-monospace,monospace;color:#a8a69c;}
      .foot a{color:#e2522a;text-decoration:none;}
    </style>
    <button class="pill" id="pill">⚡ 技能</button>
    <div class="panel" id="panel">
      <div class="ph">SkillOps · 调起一个技能<button class="x" id="x">✕</button></div>
      <input class="q" id="q" aria-label="搜你的技能" placeholder="搜你的技能…（↑↓ 选择，回车插入）">
      <div class="list" id="list" role="listbox" aria-label="技能列表"></div>
      <div class="foot" id="foot"></div>
    </div>`;
    (document.body || document.documentElement).appendChild(host);
    panel = shadow.getElementById('panel');
    listEl = shadow.getElementById('list');
    searchEl = shadow.getElementById('q');
    footEl = shadow.getElementById('foot');
    shadow.getElementById('pill').onclick = toggle;
    shadow.getElementById('x').onclick = close;
    searchEl.addEventListener('input', () => filter(searchEl.value));
    searchEl.addEventListener('keydown', onKey);
  }

  function renderList() {
    if (!filtered.length) { listEl.innerHTML = SKILLS.length ? '<div class="empty">没有匹配的技能</div>' : '<div class="empty">库是空的，或还没连接账号<br>（点扩展图标设置 API key）</div>'; return; }
    listEl.innerHTML = filtered.map((s, i) => `<div class="it ${i === activeIdx ? 'on' : ''}" data-i="${i}" role="option" aria-selected="${i === activeIdx}"><span class="nm">${esc(s.name)}</span><span class="tr ${s.tier || ''}">${s.score != null ? (s.score + ' ' + (s.tier || '')) : ''}</span></div>`).join('');
    listEl.querySelectorAll('.it').forEach(el => { el.onclick = () => pick(+el.dataset.i); });
  }
  function filter(q) { q = (q || '').toLowerCase().trim(); filtered = q ? SKILLS.filter(s => (s.name + ' ' + (s.description || '')).toLowerCase().includes(q)) : SKILLS.slice(); activeIdx = 0; renderList(); }
  function onKey(e) {
    if (e.key === 'ArrowDown') { e.preventDefault(); activeIdx = Math.min(activeIdx + 1, filtered.length - 1); renderList(); scrollActive(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); activeIdx = Math.max(activeIdx - 1, 0); renderList(); scrollActive(); }
    else if (e.key === 'Enter') { e.preventDefault(); pick(activeIdx); }
    else if (e.key === 'Escape') { e.preventDefault(); close(); }
  }
  function scrollActive() { const el = listEl.querySelector('.it.on'); if (el) el.scrollIntoView({ block: 'nearest' }); }

  async function pick(i) {
    const s = filtered[i]; if (!s) return;
    footEl.textContent = '载入中…';
    const r = await send({ type: 'getSkill', id: s.id });
    if (!r || !r.ok || !r.j) { footEl.textContent = '载入失败'; return; }
    const content = r.j.content || '';
    const el = findInput();
    if (!el) { try { await navigator.clipboard.writeText(content); } catch (e) {} footEl.innerHTML = '没找到输入框，已复制到剪贴板'; }
    else { insertText(el, content); }
    send({ type: 'invoke', id: s.id });
    if (el) close();
  }
  async function load() {
    footEl.textContent = '载入中…';
    const r = await send({ type: 'listSkills' });
    if (!r || !r.ok) { SKILLS = []; filtered = []; renderList(); footEl.innerHTML = '未连接 · <a href="https://skillops.qiuyiwu.com/dashboard/" target="_blank">控制台生成 API key</a>'; return; }
    SKILLS = (r.j && r.j.skills) || []; filtered = SKILLS.slice(); activeIdx = 0; renderList();
    footEl.innerHTML = `@${esc((r.j && r.j.owner) || '')} · ${SKILLS.length} 个技能`;
  }
  function toggle() { open ? close() : openPanel(); }
  function openPanel() { ensureUI(); panel.classList.add('open'); open = true; searchEl.value = ''; load(); setTimeout(() => searchEl.focus(), 60); }
  function close() { if (panel) panel.classList.remove('open'); open = false; }

  // shortcut ⌘/Ctrl+Shift+K
  window.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.shiftKey && (e.key === 'K' || e.key === 'k')) { e.preventDefault(); ensureUI(); toggle(); }
  }, true);

  // capture from context menu
  chrome.runtime.onMessage.addListener((msg) => { if (msg && msg.type === 'captureSelection') captureFlow(msg.text); });
  async function captureFlow(text) {
    const name = prompt('给这个技能起个名字（存进你的 SkillOps 库）：', String(text).slice(0, 40).replace(/\s+/g, ' '));
    if (!name) return;
    const r = await send({ type: 'capture', name, content: text });
    alert(r && r.ok ? '已存进 SkillOps 技能库 ✓' : '保存失败：' + ((r && r.j && (r.j.message || r.j.error)) || '请先在扩展图标里设置 API key'));
  }

  function send(msg) { return new Promise(res => { try { chrome.runtime.sendMessage(msg, res); } catch (e) { res({ ok: false }); } }); }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

  function init() { ensureUI(); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();

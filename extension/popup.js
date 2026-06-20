const $ = id => document.getElementById(id);
function send(msg) { return new Promise(res => chrome.runtime.sendMessage(msg, res)); }
const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

async function render() {
  const r0 = await send({ type: 'getKey' });
  if (!r0 || !r0.key) return connectView();
  const r = await send({ type: 'listSkills' });
  if (!r || !r.ok) return connectView(r && r.j && r.j.error === 'network' ? '连不上 skillops.tech，检查网络' : 'key 无效或已撤销，请重新粘贴');
  libraryView(r.j);
}

function connectView(err) {
  $('b').innerHTML = `
    <label>账号 API Key</label>
    <input id="k" placeholder="xn_acct_… 或 xn_…" autofocus>
    <button class="go" id="save">连接</button>
    ${err ? `<div class="err">${esc(err)}</div>` : ''}
    <div class="muted">在 <a href="https://skillops.tech/dashboard/" target="_blank">控制台 → API Key</a> 生成一个，粘进来即可在 ChatGPT / Claude 里随手调起你的技能库。</div>`;
  $('save').onclick = async () => { const k = $('k').value.trim(); if (!k) return; await send({ type: 'setKey', key: k }); render(); };
  $('k').addEventListener('keydown', e => { if (e.key === 'Enter') $('save').click(); });
}

function libraryView(j) {
  const skills = (j && j.skills) || [];
  $('b').innerHTML = `
    <div class="ok">已连接 · @${esc(j.owner || '')} · ${skills.length} 个技能</div>
    <div class="muted">在 ChatGPT / Claude 页面点右下「⚡ 技能」或按 ⌘/Ctrl+Shift+K 调起；选中文本右键可「存进库」。</div>
    <div class="list" id="list"></div>
    <div class="muted"><a href="https://skillops.tech/dashboard/" target="_blank">打开控制台</a> · <a href="#" id="logout">断开连接</a></div>`;
  $('list').innerHTML = skills.length
    ? skills.map(s => `<div class="it"><span class="nm">${esc(s.name)}</span><span class="tr">${s.score != null ? (s.score + ' ' + (s.tier || '')) : ''}</span><button class="cp" data-id="${s.id}">复制</button></div>`).join('')
    : '<div class="muted" style="padding:10px">库是空的，去控制台建一个，或在对话里选中文本「存进库」。</div>';
  document.querySelectorAll('.cp').forEach(b => b.onclick = async () => {
    const r = await send({ type: 'getSkill', id: b.dataset.id });
    if (r && r.ok && r.j) { try { await navigator.clipboard.writeText(r.j.content || ''); } catch (e) {} b.textContent = '已复制'; send({ type: 'invoke', id: b.dataset.id }); setTimeout(() => b.textContent = '复制', 1200); }
  });
  $('logout').onclick = async e => { e.preventDefault(); await send({ type: 'setKey', key: '' }); render(); };
}

render();

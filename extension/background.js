/* SkillOps extension · background service worker
 * All API calls go through here (host_permissions → no CORS restriction). */
const API = 'https://skillops.tech/api';

async function getKey() { const r = await chrome.storage.sync.get('xn_key'); return r.xn_key || ''; }

async function apiFetch(path, opts = {}) {
  const key = await getKey();
  if (!key) return { ok: false, status: 401, j: { error: 'no_key' } };
  try {
    const r = await fetch(API + path, {
      ...opts,
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key, ...(opts.headers || {}) },
    });
    let j = null; try { j = await r.json(); } catch (e) {}
    return { ok: r.ok, status: r.status, j };
  } catch (e) {
    return { ok: false, status: 0, j: { error: 'network' } };
  }
}

chrome.runtime.onMessage.addListener((msg, sender, send) => {
  (async () => {
    switch (msg && msg.type) {
      case 'listSkills': send(await apiFetch('/v1/me/skills')); break;
      case 'getSkill':   send(await apiFetch('/v1/me/skills/' + msg.id)); break;
      case 'invoke':     send(await apiFetch('/v1/me/skills/' + msg.id + '/invoke', { method: 'POST', body: '{}' })); break;
      case 'capture':    send(await apiFetch('/v1/me/skills', { method: 'POST', body: JSON.stringify({ name: msg.name, content: msg.content, description: msg.description || '', category: msg.category || 'meta', source: 'capture' }) })); break;
      case 'getKey':     send({ key: await getKey() }); break;
      case 'setKey':     await chrome.storage.sync.set({ xn_key: msg.key || '' }); send({ ok: true }); break;
      default:           send({ ok: false, error: 'unknown' });
    }
  })();
  return true; // keep channel open for async response
});

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({ id: 'xn-capture', title: '存进 SkillOps 技能库', contexts: ['selection'] });
});
chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === 'xn-capture' && info.selectionText && tab && tab.id != null) {
    chrome.tabs.sendMessage(tab.id, { type: 'captureSelection', text: info.selectionText });
  }
});

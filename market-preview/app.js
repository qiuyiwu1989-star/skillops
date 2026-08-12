const DATA_URL = './data/listings.json';

const state = {
  listings: [],
  query: '',
  distribution: 'all',
};

const elements = {
  listings: document.querySelector('#listings'),
  statePanel: document.querySelector('#state'),
  search: document.querySelector('#search'),
  distribution: document.querySelector('#distribution'),
  resultCount: document.querySelector('#result-count'),
  totalCount: document.querySelector('#total-count'),
  contentCount: document.querySelector('#content-count'),
  linkCount: document.querySelector('#link-count'),
  generatedAt: document.querySelector('#generated-at'),
  dialog: document.querySelector('#evidence-dialog'),
  dialogTitle: document.querySelector('#dialog-title'),
  dialogContent: document.querySelector('#dialog-content'),
  dialogClose: document.querySelector('#dialog-close'),
};

function visibleString(value) {
  return String(value ?? '').replace(/[—–]/g, '-');
}

function text(tagName, value, className) {
  const element = document.createElement(tagName);
  if (className) element.className = className;
  element.textContent = visibleString(value);
  return element;
}

function safeExternalUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null;
  } catch {
    return null;
  }
}

function humanDistribution(value) {
  return value === 'content' ? '可分发正文' : '仅来源链接';
}

function humanStatus(value) {
  const labels = {
    allowed: '允许分发',
    index_only: '仅索引',
    pass: '通过',
    review: '需关注',
    pending: '待评估',
    complete: '已完成',
    approved: '已批准',
  };
  return labels[value] || String(value || '未记录');
}

function shortHash(value) {
  const string = String(value || '');
  return string.length > 14 ? `${string.slice(0, 8)}...${string.slice(-6)}` : string || '未记录';
}

function sourceLabel(listing) {
  return listing.source?.repo || listing.source?.url || '本地来源';
}

function evidenceRow(label, value) {
  const wrapper = document.createElement('div');
  wrapper.append(text('dt', label), text('dd', value));
  return wrapper;
}

function createSourceLink(listing) {
  const url = safeExternalUrl(listing.source?.url);
  if (!url) return text('span', sourceLabel(listing), 'source-link');
  const link = text('a', '查看来源', 'source-link');
  link.href = url;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  return link;
}

function detailGroup(title, rows) {
  const section = document.createElement('section');
  section.className = 'evidence-group';
  section.append(text('h3', title));
  const list = document.createElement('dl');
  for (const [label, value, className] of rows) {
    list.append(text('dt', label), text('dd', value, className));
  }
  section.append(list);
  return section;
}

function openEvidence(listing) {
  const review = listing.verification?.lastReview || {};
  elements.dialogTitle.textContent = visibleString(listing.name);
  elements.dialogContent.replaceChildren(
    detailGroup('来源与版本', [
      ['仓库', sourceLabel(listing), 'mono'],
      ['技能路径', listing.source?.path || '未记录', 'mono'],
      ['Commit', listing.version?.commit || '未记录', 'mono'],
      ['内容指纹', listing.version?.fingerprint || '未记录', 'mono'],
      ['版本身份', listing.version?.identity || '未记录', 'mono'],
    ]),
    detailGroup('许可与安全', [
      ['许可状态', humanStatus(listing.license?.status)],
      ['SPDX', listing.license?.spdx || '未识别', 'mono'],
      ['分发范围', humanDistribution(listing.distribution)],
      ['安全检查', humanStatus(listing.security?.status)],
      ['安全发现', String(listing.security?.findings?.length ?? 0)],
    ]),
    detailGroup('能力评估', [
      ['SMS 状态', humanStatus(listing.sms?.status)],
      ['SMS 总分', listing.sms?.total == null ? '待评分' : String(listing.sms.total)],
      ['Eval 状态', humanStatus(listing.eval?.status)],
    ]),
    detailGroup('人工审核', [
      ['审核状态', humanStatus(listing.verification?.status)],
      ['审核人', review.reviewer || '未记录'],
      ['审核理由', review.reason || '未记录'],
      ['审核时间', review.at ? new Date(review.at).toLocaleString('zh-CN') : '未记录'],
      ['审核指纹', listing.verification?.reviewedFingerprint || '未记录', 'mono'],
    ]),
  );
  elements.dialog.showModal();
}

function cardFor(listing) {
  const article = document.createElement('article');
  article.className = 'skill-card';

  const main = document.createElement('div');
  const topline = document.createElement('div');
  topline.className = 'card-topline';
  topline.append(
    text('span', '已批准', 'tag tag-approved'),
    text('span', humanDistribution(listing.distribution), 'tag'),
  );
  main.append(topline, text('h2', listing.name), text('p', listing.description, 'description'));

  const evidence = document.createElement('dl');
  evidence.className = 'card-evidence';
  evidence.append(
    evidenceRow('来源', sourceLabel(listing)),
    evidenceRow('许可', listing.license?.spdx || humanStatus(listing.license?.status)),
    evidenceRow('安全', humanStatus(listing.security?.status)),
    evidenceRow('SMS', listing.sms?.total == null ? '待评分' : `${listing.sms.total} 分`),
    evidenceRow('版本', shortHash(listing.version?.commit)),
  );

  const actions = document.createElement('div');
  actions.className = 'card-actions';
  const button = text('button', '查看审核证据', 'btn');
  button.type = 'button';
  button.addEventListener('click', () => openEvidence(listing));
  actions.append(createSourceLink(listing), button);

  main.append(actions);
  article.append(main, evidence);
  return article;
}

function filteredListings() {
  const needle = state.query.trim().toLocaleLowerCase('zh-CN');
  return state.listings.filter(listing => {
    const distributionMatches = state.distribution === 'all' || listing.distribution === state.distribution;
    const haystack = [listing.name, listing.description, listing.source?.repo, listing.source?.path]
      .filter(Boolean)
      .join(' ')
      .toLocaleLowerCase('zh-CN');
    return distributionMatches && (!needle || haystack.includes(needle));
  });
}

function showState(title, message, kind = '') {
  elements.listings.hidden = true;
  elements.statePanel.hidden = false;
  elements.statePanel.className = `state-panel ${kind}`.trim();
  elements.statePanel.replaceChildren(text('h2', title), text('p', message));
}

function render() {
  const visible = filteredListings();
  elements.resultCount.textContent = `${visible.length} 项结果`;
  if (!visible.length) {
    const hasFilters = Boolean(state.query.trim()) || state.distribution !== 'all';
    showState(
      hasFilters ? '没有匹配的技能' : '还没有已批准技能',
      hasFilters ? '调整搜索词或分发范围后再试。' : '完成可信审核并批准技能后，重新运行预览构建命令。',
    );
    return;
  }
  elements.statePanel.hidden = true;
  elements.listings.hidden = false;
  elements.listings.replaceChildren(...visible.map(cardFor));
}

function updateSummary() {
  elements.totalCount.textContent = String(state.listings.length);
  elements.contentCount.textContent = String(state.listings.filter(item => item.distribution === 'content').length);
  elements.linkCount.textContent = String(state.listings.filter(item => item.distribution === 'source_link_only').length);
}

async function loadListings() {
  try {
    const response = await fetch(DATA_URL, { cache: 'no-store' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    if (data.schemaVersion !== 1 || data.source !== 'CandidateStore.listListings' || !Array.isArray(data.listings)) {
      throw new Error('数据格式不受支持');
    }
    if (data.listings.some(item => item.verification?.status !== 'approved')) {
      throw new Error('数据包含未批准项目');
    }
    state.listings = data.listings;
    updateSummary();
    elements.generatedAt.textContent = `构建于 ${new Date(data.generatedAt).toLocaleString('zh-CN')}`;
    render();
  } catch (error) {
    elements.totalCount.textContent = '-';
    elements.contentCount.textContent = '-';
    elements.linkCount.textContent = '-';
    showState('无法读取预览数据', '请先运行构建命令，并通过本地预览服务打开页面。', 'error');
    console.error('Failed to load approved listings', error);
  }
}

elements.search.addEventListener('input', event => {
  state.query = event.target.value;
  render();
});

elements.distribution.addEventListener('change', event => {
  state.distribution = event.target.value;
  render();
});

elements.dialogClose.addEventListener('click', () => elements.dialog.close());
elements.dialog.addEventListener('click', event => {
  if (event.target === elements.dialog) elements.dialog.close();
});

loadListings();

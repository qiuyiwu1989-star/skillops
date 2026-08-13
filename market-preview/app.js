const DATA_URL = './data/listings.json';

const CATEGORY_LABELS = {
  'content-creation': '内容创作',
  'data-analysis': '数据分析',
  'dev-programming': '开发编程',
  'knowledge-management': '知识管理',
  research: '研究洞察',
  communication: '沟通协作',
  productivity: '效率工具',
  operations: '运营管理',
  'design-media': '设计与媒体',
  'office-efficiency': '办公效率',
  professional: '专业服务',
  uncategorized: '其他能力',
};

const TASK_RULES = [
  { category: 'communication', words: ['brief', 'customer', '客户', '沟通', '需求'] },
  { category: 'operations', words: ['release', 'checklist', '发布', '检查', '运营'] },
  { category: 'knowledge-management', words: ['notes', 'summary', 'summarize', '会议', '纪要', '知识', '总结'] },
  { category: 'research', words: ['market', 'research', '市场', '研究', '洞察'] },
];

const state = {
  listings: [],
  query: '',
  category: 'all',
  distribution: 'all',
};

const elements = {
  form: document.querySelector('#task-search'),
  listings: document.querySelector('#listings'),
  statePanel: document.querySelector('#state'),
  search: document.querySelector('#search'),
  distribution: document.querySelector('#distribution'),
  resultCount: document.querySelector('#result-count'),
  totalCount: document.querySelector('#total-count'),
  generatedAt: document.querySelector('#generated-at'),
  categoryList: document.querySelector('#category-list'),
  categoryReset: document.querySelector('#category-reset'),
  shelfList: document.querySelector('#shelf-list'),
  activeContext: document.querySelector('#active-context'),
  dialog: document.querySelector('#evidence-dialog'),
  dialogTitle: document.querySelector('#dialog-title'),
  dialogSummary: document.querySelector('#dialog-summary'),
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
    allowed: '允许分发', index_only: '仅索引', pass: '通过', review: '需关注',
    pending: '待验证', complete: '已完成', approved: '已批准', verified: '已有实绩',
  };
  return labels[value] || String(value || '未记录');
}

function shortHash(value) {
  const string = String(value || '');
  return string.length > 14 ? `${string.slice(0, 8)}...${string.slice(-6)}` : string || '未记录';
}

function sourceLabel(listing) {
  return listing.catalog?.coordinate || listing.source?.repo || listing.source?.url || '本地来源';
}

function listingTags(listing) {
  const tags = listing.catalog?.tags;
  if (Array.isArray(tags)) return tags.map(String);
  if (tags && typeof tags === 'object') return Object.entries(tags).map(([key, value]) => `${key}:${value}`);
  return tags ? [String(tags)] : [];
}

function operationsProjection(listing) {
  const value = listing.operationsProjection || listing.skillOperations || listing.v41;
  return value && typeof value === 'object' ? value : null;
}

function intentTags(listing) {
  const projected = operationsProjection(listing)?.skill?.intentTags;
  if (Array.isArray(projected)) return projected.map(String);
  const catalog = listing.catalog?.intentTags;
  return Array.isArray(catalog) ? catalog.map(String) : [];
}

function queryTerms(value) {
  return String(value || '').normalize('NFKC').toLocaleLowerCase('zh-CN').split(/[^\p{L}\p{N}._-]+/u).filter(Boolean);
}

function recommendationFor(listing, query = state.query) {
  const terms = queryTerms(query);
  const projection = operationsProjection(listing);
  const tags = intentTags(listing);
  const whenToUse = projection?.routing?.whenToUse || [];
  const searchable = [...tags, ...whenToUse].map(value => String(value).toLocaleLowerCase('zh-CN'));
  const matchedTags = tags.filter(tag => terms.some(term => tag.toLocaleLowerCase('zh-CN').includes(term) || term.includes(tag.toLocaleLowerCase('zh-CN'))));
  const matchedScenarios = whenToUse.filter(value => terms.some(term => String(value).toLocaleLowerCase('zh-CN').includes(term)));
  const matched = terms.length === 0 ? [] : searchable.filter(value => terms.some(term => value.includes(term)));
  if (matchedTags.length) return { matched: true, label: `任务意图匹配：${matchedTags.slice(0, 2).join('、')}` };
  if (matchedScenarios.length) return { matched: true, label: `适用场景匹配：${matchedScenarios[0]}` };
  if (matched.length) return { matched: true, label: '结构化路由条件与任务相符' };
  return { matched: false, label: projection ? '当前未命中结构化任务意图' : '沿用目录文本匹配，待补路由档案' };
}

function compositionSkills(listing) {
  const skills = operationsProjection(listing)?.composition?.relatedSkills;
  return Array.isArray(skills) ? skills.filter(item => item && item.skillId).slice(0, 3) : [];
}

function listingCategory(listing) {
  if (listing.catalog?.category) return String(listing.catalog.category);
  const haystack = [listing.name, listing.description, ...listingTags(listing)]
    .filter(Boolean).join(' ').toLocaleLowerCase('zh-CN');
  return TASK_RULES.find(rule => rule.words.some(word => haystack.includes(word)))?.category || 'uncategorized';
}

function categoryLabel(value) {
  return CATEGORY_LABELS[value] || visibleString(value).replace(/[-_]/g, ' ');
}

function listingTime(listing) {
  const values = [listing.catalog?.publishedAt, listing.catalog?.observedAt, listing.catalog?.firstSeenAt,
    listing.verification?.lastReview?.at];
  const timestamp = values.map(value => Date.parse(value)).find(value => Number.isFinite(value));
  return timestamp || 0;
}

function smsBand(total) {
  if (!Number.isFinite(Number(total))) return '待评估';
  if (total >= 86) return 'S';
  if (total >= 76) return 'A';
  if (total >= 64) return 'B';
  return '待复核';
}

function evalSummary(listing) {
  const evaluation = listing.eval || {};
  if (evaluation.status === 'pending' || !evaluation.status) return { label: 'Eval 待验证', detail: '尚无实绩数据' };
  const successRate = Number(evaluation.successRate);
  const detail = Number.isFinite(successRate) ? `成功率 ${Math.round(successRate * (successRate <= 1 ? 100 : 1))}%` : humanStatus(evaluation.status);
  return { label: 'Eval 已验证', detail };
}

const TRUST_STATE_LABELS = {
  approved: '旧版批准，待双人终审',
  certified: '双人终审有效',
  pending_second_review: '待第二人复核',
  pending_review: '待终审',
  pending: '待终审',
  expiring: '认证即将到期',
  expired: '认证已过期',
  stale: '证据已失效',
  withdrawn: '已撤回',
  recalled: '已召回',
  revoked: '已吊销',
  retired: '技能已退役',
  active_pending_revalidation: '已恢复，待重新验证',
};

const INSTALL_REASON_LABELS = {
  license_allows_source_link_only: '许可仅允许来源索引',
  complete_package_missing: '缺少完整技能包',
  collector_snapshot_is_not_a_complete_package: '采集快照不是完整技能包',
  package_audit_required: '需要完成当前技能包审计',
  human_certification_required: '需要两位独立可信人工完成终审',
  certification_expiring: '终审认证即将到期，请尽快复核',
  certification_expired: '终审认证已过期',
  evidence_stale: '终审绑定证据已失效',
  pending_second_review: '还需要第二位独立人工复核',
  pending_review: '尚未完成可信人工终审',
  release_withdrawn: '当前发行版本已撤回',
  release_recalled: '当前发行版本已召回',
  release_revoked: '当前发行版本已吊销',
  skill_retired: '技能已退役，停止新安装',
  revalidation_required: '技能恢复后需要重新验证',
  explicitly_ineligible: '安装资格被治理策略明确关闭',
};

function certificationState(listing) {
  const certification = listing.verification?.certification || {};
  const lifecycle = listing.lifecycle?.state || listing.lifecycle?.status || listing.skill?.status;
  const release = listing.release?.status || listing.releaseStatus;
  const queue = listing.verification?.queueStatus || listing.reviewQueue?.queueStatus;
  let code = queue || certification.status || listing.verification?.status || 'pending_review';
  if (release === 'recalled' || certification.status === 'recalled') code = 'recalled';
  else if (release === 'revoked') code = 'revoked';
  else if (release === 'withdrawn' || certification.status === 'withdrawn') code = 'withdrawn';
  else if (lifecycle === 'retired') code = 'retired';
  else if (lifecycle === 'active_pending_revalidation') code = 'active_pending_revalidation';
  else if (certification.status === 'stale' || certification.status === 'expired') code = certification.status;
  else if (certification.status === 'certified' && certification.validUntil) {
    const remaining = Date.parse(certification.validUntil) - Date.now();
    if (Number.isFinite(remaining) && remaining <= 0) code = 'expired';
    else if (Number.isFinite(remaining) && remaining <= 30 * 24 * 60 * 60 * 1000) code = 'expiring';
  }
  const tone = ['certified'].includes(code) ? 'positive'
    : ['recalled', 'revoked', 'withdrawn', 'retired'].includes(code) ? 'critical'
      : 'caution';
  return { code, label: TRUST_STATE_LABELS[code] || `终审状态：${visibleString(code)}`, tone };
}

function installReasonText(reason) {
  if (typeof reason === 'object' && reason) return visibleString(reason.messageZh || reason.message || INSTALL_REASON_LABELS[reason.code] || reason.code);
  return INSTALL_REASON_LABELS[reason] || visibleString(reason);
}

function installationDecision(listing) {
  const trust = certificationState(listing);
  const install = listing.install || {};
  const declaredEligibility = typeof install.eligibility === 'object' ? install.eligibility.eligible : install.eligibility;
  const reasons = [];
  const suppliedReasons = [
    ...(Array.isArray(install.reasons) ? install.reasons : []),
    ...(Array.isArray(install.eligibility?.reasons) ? install.eligibility.reasons : []),
    install.reason,
  ].filter(Boolean);
  reasons.push(...suppliedReasons.map(installReasonText));
  if (declaredEligibility === false || listing.install?.eligibility === false) reasons.push(INSTALL_REASON_LABELS.explicitly_ineligible);
  if (listing.distribution === 'source_link_only') reasons.push(INSTALL_REASON_LABELS.license_allows_source_link_only);
  if (install.packageComplete !== true) reasons.push(INSTALL_REASON_LABELS.complete_package_missing);
  const stateReason = {
    pending_second_review: 'pending_second_review', pending_review: 'pending_review', pending: 'pending_review',
    stale: 'evidence_stale', expired: 'certification_expired', withdrawn: 'release_withdrawn',
    recalled: 'release_recalled', revoked: 'release_revoked', retired: 'skill_retired',
    active_pending_revalidation: 'revalidation_required',
  }[trust.code];
  if (stateReason) reasons.push(INSTALL_REASON_LABELS[stateReason]);
  const trusted = trust.code === 'certified' || trust.code === 'expiring';
  const statusEligible = listing.install?.status === 'eligible';
  const eligible = statusEligible && declaredEligibility !== false
    && install.packageComplete === true && listing.distribution !== 'source_link_only' && trusted;
  return { eligible, trust, reasons: [...new Set(reasons.filter(Boolean))] };
}

function trustBadge(listing) {
  const trust = certificationState(listing);
  return text('span', trust.label, `trust-badge trust-${trust.tone}`);
}

function evidenceRow(label, value) {
  const wrapper = document.createElement('div');
  wrapper.append(text('dt', label), text('dd', value));
  return wrapper;
}

function createSourceLink(listing) {
  const url = safeExternalUrl(listing.source?.marketplaceUrl || listing.source?.url || listing.source?.upstreamUrl);
  if (!url) return text('span', sourceLabel(listing), 'source-link');
  const link = text('a', '查看来源', 'source-link');
  link.href = url;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  return link;
}

function detailHref(listing) {
  return `./skills/${encodeURIComponent(String(listing.id))}/`;
}

function detailGroup(title, rows, className = '') {
  const section = document.createElement('section');
  section.className = `evidence-group ${className}`.trim();
  section.append(text('h3', title));
  const list = document.createElement('dl');
  for (const [label, value, rowClass] of rows) list.append(text('dt', label), text('dd', value, rowClass));
  section.append(list);
  return section;
}

function smsDimensionRows(listing) {
  const dimensions = listing.sms?.dimensions;
  if (!dimensions || typeof dimensions !== 'object') return [];
  const entries = Array.isArray(dimensions)
    ? dimensions.map(value => [value?.key || 'unknown', value])
    : Object.entries(dimensions);
  return entries.map(([key, value]) => {
    const score = typeof value === 'object' ? value.score : value;
    const reason = typeof value === 'object' ? value.reason : '';
    return [categoryLabel(key), Number.isFinite(Number(score)) ? `${score}/10${reason ? `，${reason}` : ''}` : '未记录'];
  });
}

function openEvidence(listing) {
  const review = listing.verification?.lastReview || {};
  const evalInfo = evalSummary(listing);
  const category = categoryLabel(listingCategory(listing));
  const scenario = listing.catalog?.scenario || listing.catalog?.useCase || listing.description;
  elements.dialogTitle.textContent = visibleString(listing.name);

  const summary = document.createElement('div');
  summary.className = 'detail-intro';
  const summaryCopy = document.createElement('div');
  summaryCopy.append(text('span', category, 'tag'), text('p', listing.description, 'detail-description'));
  const boundary = document.createElement('div');
  boundary.className = 'install-boundary';
  const installation = installationDecision(listing);
  const installEligible = installation.eligible;
  boundary.append(trustBadge(listing), text('strong', installEligible ? '可进入受控部署' : '当前不可直接安装'), text('p', installEligible
    ? '完整包已批准。安装仍需通过 skillops deploy 的目标检查、漂移检测和 lock 台账。'
    : `${installation.reasons.join('；') || '当前可信证据不满足受控部署要求'}，不提供直接安装。`));
  const installAction = document.createElement('button');
  installAction.type = 'button';
  installAction.className = 'btn sm install-action';
  installAction.textContent = installEligible ? '查看部署方式' : '安装暂不可用';
  installAction.disabled = !installEligible;
  if (installEligible) installAction.addEventListener('click', () => {
    navigator.clipboard?.writeText(`skillops deploy ${listing.id} --to <target-root>`);
    installAction.textContent = '已复制部署模板';
  });
  boundary.append(installAction);
  summary.append(summaryCopy, boundary);
  elements.dialogSummary.replaceChildren(summary);

  const scoreRows = [
    ['SMS 定义', '静态质量潜力，不代表真实运行成功率'],
    ['SMS 总分', listing.sms?.total == null ? '待评分' : `${listing.sms.total}/100`],
    ['SMS 段位', smsBand(Number(listing.sms?.total))],
    ['评分规范', listing.sms?.rubricVersion || '版本未记录'],
    ...smsDimensionRows(listing),
  ];
  const evalRows = [
    ['Eval 定义', '基于测试集与运行环境的实绩证据'],
    ['当前状态', evalInfo.label],
    ['实绩摘要', evalInfo.detail],
    ['测试集', listing.eval?.testSet || listing.eval?.dataset || '未记录'],
    ['运行环境', listing.eval?.environment || '未记录'],
  ];

  elements.dialogContent.replaceChildren(
    detailGroup('适用场景', [
      ['工作类型', category], ['典型任务', scenario || '未记录'],
      ['标签', listingTags(listing).join('，') || '未记录'],
    ]),
    detailGroup('SMS 静态潜力', scoreRows, 'sms-group'),
    detailGroup('Eval 运行实绩', evalRows, 'eval-group'),
    detailGroup('来源与版本', [
      ['来源', sourceLabel(listing), 'mono'], ['技能路径', listing.source?.path || '未记录', 'mono'],
      ['原始名称', listing.original?.name || listing.name, 'mono'],
      ['中文元数据', listing.localization?.status === 'auto_translated' ? '自动翻译，待人工校对' : '来源已提供中文'],
      ['版本', listing.source?.version || shortHash(listing.version?.commit), 'mono'],
      ['内容指纹', listing.version?.fingerprint || '未记录', 'mono'],
      ['签名', listing.source?.integrity?.signed === true ? '已验证' : '未记录'],
    ]),
    detailGroup('许可与安全', [
      ['许可状态', humanStatus(listing.license?.status)], ['SPDX', listing.license?.spdx || '未识别', 'mono'],
      ['分发范围', humanDistribution(listing.distribution)], ['安全检查', humanStatus(listing.security?.status)],
      ['安全发现', String(listing.security?.findings?.length ?? 0)],
      ['包完整性', listing.install?.packageComplete === true ? '完整' : '仅同步部分内容'],
    ]),
    detailGroup('人工审核', [
      ['认证状态', installation.trust.label],
      ['审核状态', humanStatus(listing.verification?.status)], ['审核人', review.reviewer || '未记录'],
      ['审核方式', review.reviewerType === 'agent_assisted' ? 'Agent 辅助预审' : '人工审核'],
      ['审核理由', review.reason || '未记录'],
      ['审核时间', review.at ? new Date(review.at).toLocaleString('zh-CN') : '未记录'],
      ['审核指纹', listing.verification?.reviewedFingerprint || '未记录', 'mono'],
      ['证据快照', shortHash(listing.verification?.evidence?.evidenceDigest), 'mono'],
      ['绑定技能包', shortHash(listing.verification?.evidence?.packageDigest), 'mono'],
      ['绑定 SMS', shortHash(listing.verification?.evidence?.smsDigest), 'mono'],
      ['绑定 Eval', shortHash(listing.verification?.evidence?.evalDigest), 'mono'],
      ['终审认证', shortHash(listing.verification?.certification?.certificationDigest || listing.verification?.certification?.evidenceDigest), 'mono'],
      ['有效期', listing.verification?.certification?.validUntil ? new Date(listing.verification.certification.validUntil).toLocaleString('zh-CN') : '未记录'],
    ]),
  );
  elements.dialog.showModal();
  history.replaceState(null, '', `#skill=${encodeURIComponent(listing.id)}`);
}

function closeEvidence() {
  elements.dialog.close();
  history.replaceState(null, '', '#catalog');
}

function cardFor(listing, { compact = false } = {}) {
  const article = document.createElement('article');
  article.className = compact ? 'skill-card compact-card' : 'skill-card';
  article.dataset.skillId = listing.id;

  const main = document.createElement('div');
  main.className = 'card-layout';
  const topline = document.createElement('div');
  topline.className = 'card-topline';
  const tags = document.createElement('div');
  tags.className = 'card-topline-tags';
  tags.append(text('span', categoryLabel(listingCategory(listing)), 'tag'), text('span', humanDistribution(listing.distribution), 'tag'));
  topline.append(tags, trustBadge(listing));
  main.append(topline, text('h3', listing.name));
  const originalName = listing.original?.name && listing.original.name !== listing.name
    ? listing.original.name
    : '';
  const originalNameElement = text('p', originalName, 'original-name mono');
  if (!originalName) originalNameElement.setAttribute('aria-hidden', 'true');
  main.append(originalNameElement);
  main.append(text('p', listing.description, 'description'));

  const recommendation = recommendationFor(listing);
  const recommendationPanel = document.createElement('div');
  recommendationPanel.className = `recommendation-basis${recommendation.matched ? ' matched' : ''}`;
  recommendationPanel.append(text('strong', '推荐依据'), text('p', recommendation.label));
  const related = compositionSkills(listing);
  if (related.length) recommendationPanel.append(text('p', `可组合：${related.map(item => item.titleZh || item.skillId).join('、')}`, 'composition-inline'));
  main.append(recommendationPanel);

  const evalInfo = evalSummary(listing);
  const installation = installationDecision(listing);
  const metrics = document.createElement('dl');
  metrics.className = 'market-metrics';
  metrics.append(
    evidenceRow('SMS 静态潜力', listing.sms?.total == null ? '待评分' : `${listing.sms.total} 分 · ${smsBand(Number(listing.sms.total))} 段`),
    evidenceRow('Eval 运行实绩', evalInfo.detail),
    evidenceRow('安装状态', installation.eligible ? '可进入受控部署' : `不可安装：${installation.reasons[0] || '可信证据不完整'}`),
    evidenceRow('安全与许可', `${humanStatus(listing.security?.status)} · ${listing.license?.spdx || humanStatus(listing.license?.status)}`),
  );

  const actions = document.createElement('div');
  actions.className = 'card-actions';
  const links = document.createElement('div');
  links.className = 'card-links';
  links.append(createSourceLink(listing));
  const previewButton = text('button', '快速预览', 'text-button mono');
  previewButton.type = 'button';
  previewButton.addEventListener('click', () => openEvidence(listing));
  links.append(previewButton);
  const detailLink = text('a', '查看完整详情', 'btn');
  detailLink.href = detailHref(listing);
  actions.append(links, detailLink);
  main.append(metrics, actions);
  article.append(main);
  return article;
}

function filteredListings() {
  const needle = state.query.trim().toLocaleLowerCase('zh-CN');
  return state.listings.filter(listing => {
    const distributionMatches = state.distribution === 'all' || listing.distribution === state.distribution;
    const categoryMatches = state.category === 'all' || listingCategory(listing) === state.category;
    const projection = operationsProjection(listing);
    const haystack = [listing.name, listing.description, listing.source?.repo, listing.source?.path,
      listing.catalog?.coordinate, listing.catalog?.category, ...listingTags(listing), ...intentTags(listing),
      ...(projection?.routing?.whenToUse || []), ...(projection?.routing?.whenNotToUse || [])]
      .filter(Boolean).join(' ').toLocaleLowerCase('zh-CN');
    const structuredMatch = recommendationFor(listing, state.query).matched;
    return distributionMatches && categoryMatches && (!needle || haystack.includes(needle) || structuredMatch);
  });
}

function shelfDefinitions() {
  const approved = [...state.listings];
  const editorial = approved.filter(item => item.catalog?.featured === true || Number(item.sms?.total) >= 76)
    .sort((a, b) => Number(b.sms?.total || 0) - Number(a.sms?.total || 0));
  const highSms = approved.filter(item => Number(item.sms?.total) >= 76)
    .sort((a, b) => Number(b.sms?.total || 0) - Number(a.sms?.total || 0));
  const recent = approved.sort((a, b) => listingTime(b) - listingTime(a));
  const signed = state.listings.filter(item => item.source?.integrity?.signed === true);
  const noKey = state.listings.filter(item => item.catalog?.requiresApiKey === false);
  return [
    { id: 'editorial', title: '编辑精选', note: 'SMS 达到 A 段，或由目录明确标记精选。', items: editorial },
    { id: 'high-sms', title: '高 SMS 潜力', note: '按静态质量分排序，不等同于运行实绩。', items: highSms },
    { id: 'recent', title: '最近上架', note: '按审核或目录观测时间排序。', items: recent },
    { id: 'signed', title: '来源已签名', note: '上游版本签名已验证，仍需通过本地许可、安全和质量门。', items: signed },
    { id: 'no-key', title: '无需密钥', note: '目录明确声明无需 API Key，安装前仍需检查。', items: noKey },
  ].filter(shelf => shelf.items.length).slice(0, 4);
}

function renderShelves() {
  const shelves = shelfDefinitions();
  elements.shelfList.replaceChildren(...shelves.map(shelf => {
    const section = document.createElement('section');
    section.className = 'market-shelf';
    const header = document.createElement('div');
    header.className = 'shelf-heading';
    const copy = document.createElement('div');
    copy.append(text('h3', shelf.title), text('p', shelf.note));
    header.append(copy, text('span', `${shelf.items.length} 项`, 'mono shelf-count'));
    const track = document.createElement('div');
    track.className = 'shelf-track';
    track.append(...shelf.items.slice(0, 4).map(item => cardFor(item, { compact: true })));
    section.append(header, track);
    return section;
  }));
}

function renderCategories() {
  const counts = new Map();
  for (const listing of state.listings) {
    const category = listingCategory(listing);
    counts.set(category, (counts.get(category) || 0) + 1);
  }
  const values = [...counts.entries()].sort((a, b) => b[1] - a[1] || categoryLabel(a[0]).localeCompare(categoryLabel(b[0]), 'zh-CN'));
  elements.categoryList.replaceChildren(...values.map(([category, count]) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `category-button${state.category === category ? ' active' : ''}`;
    button.dataset.category = category;
    button.setAttribute('aria-pressed', String(state.category === category));
    button.append(text('strong', categoryLabel(category)), text('span', `${count} 项`, 'mono'));
    button.addEventListener('click', () => {
      state.category = state.category === category ? 'all' : category;
      renderCategories();
      renderCatalog();
      document.querySelector('#catalog').scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
    return button;
  }));
  elements.categoryReset.hidden = state.category === 'all';
}

function showState(title, message, kind = '') {
  elements.listings.hidden = true;
  elements.statePanel.hidden = false;
  elements.statePanel.className = `state-panel ${kind}`.trim();
  elements.statePanel.replaceChildren(text('h2', title), text('p', message));
}

function renderCatalog() {
  const visible = filteredListings();
  elements.resultCount.textContent = `${visible.length} 项结果`;
  const parts = [];
  if (state.query.trim()) parts.push(`任务：“${state.query.trim()}”`);
  if (state.category !== 'all') parts.push(categoryLabel(state.category));
  if (state.distribution !== 'all') parts.push(humanDistribution(state.distribution));
  elements.activeContext.textContent = parts.join('，') || '全部已批准技能';
  if (!visible.length) {
    const hasFilters = Boolean(state.query.trim()) || state.category !== 'all' || state.distribution !== 'all';
    showState(hasFilters ? '没有匹配的技能' : '还没有已批准技能',
      hasFilters ? '换一种任务描述，或清除分类与分发范围后再试。' : '完成可信审核并批准技能后，重新运行预览构建命令。');
    return;
  }
  elements.statePanel.hidden = true;
  elements.listings.hidden = false;
  elements.listings.replaceChildren(...visible.map(item => cardFor(item)));
}

function renderAll() {
  renderCategories();
  renderShelves();
  renderCatalog();
}

function openHashDetail() {
  const match = location.hash.match(/^#skill=(.+)$/);
  if (!match) return;
  const listing = state.listings.find(item => item.id === decodeURIComponent(match[1]));
  if (listing) openEvidence(listing);
}

async function loadListings() {
  try {
    const response = await fetch(DATA_URL, { cache: 'no-store' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    if (data.schemaVersion !== 1 || data.source !== 'CandidateStore.listListings' || !Array.isArray(data.listings)) {
      throw new Error('数据格式不受支持');
    }
    if (data.listings.some(item => item.verification?.status !== 'approved')) throw new Error('数据包含未批准项目');
    state.listings = data.listings;
    elements.totalCount.textContent = String(state.listings.length);
    elements.generatedAt.textContent = `构建于 ${new Date(data.generatedAt).toLocaleString('zh-CN')}`;
    renderAll();
    openHashDetail();
  } catch (error) {
    elements.totalCount.textContent = '-';
    elements.shelfList.replaceChildren();
    showState('无法读取预览数据', '请先运行构建命令，并通过本地预览服务打开页面。', 'error');
    console.error('Failed to load approved listings', error);
  }
}

elements.form.addEventListener('submit', event => {
  event.preventDefault();
  state.query = elements.search.value;
  renderCatalog();
  document.querySelector('#catalog').scrollIntoView({ behavior: 'smooth', block: 'start' });
});

elements.search.addEventListener('input', event => {
  state.query = event.target.value;
  renderCatalog();
});

elements.distribution.addEventListener('change', event => {
  state.distribution = event.target.value;
  renderCatalog();
});

elements.categoryReset.addEventListener('click', () => {
  state.category = 'all';
  renderCategories();
  renderCatalog();
});

elements.dialogClose.addEventListener('click', closeEvidence);
elements.dialog.addEventListener('click', event => { if (event.target === elements.dialog) closeEvidence(); });
elements.dialog.addEventListener('close', () => {
  if (location.hash.startsWith('#skill=')) history.replaceState(null, '', '#catalog');
});

loadListings();

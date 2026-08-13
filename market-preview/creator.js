const DEFAULT_DATA_URL = './data/creator.json';
const MAX_WORKS = 1_000;
const MAX_ITEMS = 500;
const PRIVATE_KEY = /(?:candidate|identityReceipt|subjectDigest|receiptDigest|storageRef|localPath|absolutePath|packagePath|skillContent|prompt|output|token|secret|password|credential|apiKey|privateKey)/i;
const PRIVATE_VALUE = /(?:^|[^A-Za-z0-9])cand_[A-Za-z0-9_-]+|(?:^|\s)(?:file:\/\/|\/(?:Users|home|var|private|tmp)\/)|\bcas:sha256:|-----BEGIN [A-Z ]*PRIVATE KEY-----|\bBearer\s+\S+|\b(?:sk|ghp|github_pat)_[A-Za-z0-9_-]{12,}/i;
const STATUS_LABELS = Object.freeze({
  draft: '草稿', submitted: '待复核', in_review: '待复核', changes_required: '需修改',
  approved: '已批准', published: '已发布', withdrawn: '已下架', recalled: '已召回',
  rejected: '已驳回', appealed: '申诉中',
});
const ACTION_LABELS = Object.freeze({
  continue_draft: '继续完善草稿', submit_for_review: '补齐证据后提交复核', await_review: '等待权利与市场复核',
  revise_and_resubmit: '根据意见形成新草稿', publish_approved: '等待发布事件', monitor_release: '关注版本与反馈',
  appeal_or_republish: '查看原因并决定申诉或重新发布', security_response: '查看召回说明与替代方案', none: '暂无动作',
});
const SUMMARY = Object.freeze([
  ['works', '全部作品'], ['drafts', '草稿'], ['inReview', '待复核'],
  ['changesRequired', '需修改'], ['published', '已发布'], ['inactive', '下架 / 召回'],
]);

function fail() { throw new Error('PUBLIC_CREATOR_DATA_REQUIRED'); }
function object(value) { if (!value || typeof value !== 'object' || Array.isArray(value)) fail(); return value; }
function array(value, maximum = MAX_ITEMS) { if (!Array.isArray(value) || value.length > maximum) fail(); return value; }
function text(value, fallback = '', maximum = 1_000) {
  if (value == null && fallback !== undefined) return fallback;
  if (typeof value !== 'string') fail();
  const normalized = value.normalize('NFC').trim();
  if ([...normalized].length > maximum || normalized.includes('\0') || PRIVATE_VALUE.test(normalized)) fail();
  return normalized;
}
function time(value) {
  const normalized = text(value, '', 128);
  if (!normalized) return null;
  const milliseconds = Date.parse(normalized);
  if (!Number.isFinite(milliseconds)) fail();
  return new Date(milliseconds).toISOString();
}
function assertPublic(value) {
  if (Array.isArray(value)) return value.forEach(assertPublic);
  if (value && typeof value === 'object') {
    for (const [key, nested] of Object.entries(value)) {
      if (PRIVATE_KEY.test(key)) fail();
      assertPublic(nested);
    }
  } else if (typeof value === 'string' && PRIVATE_VALUE.test(value)) fail();
}
function strings(value, maximum = 50) {
  return array(value ?? [], maximum).map(item => text(item, '', 180)).filter(Boolean);
}
function rights(value) {
  if (Array.isArray(value) || value == null) return strings(value ?? []);
  object(value);
  const labels = [];
  for (const [key, granted] of Object.entries(value)) {
    if (granted === true) labels.push(text(key, '', 80));
    else if (typeof granted === 'string') labels.push(text(granted, '', 180));
    else if (Array.isArray(granted)) labels.push(...strings(granted));
  }
  return [...new Set(labels)].slice(0, 50);
}
function normalizeTimeline(value) {
  return array(value ?? []).map((item, index) => {
    object(item);
    return {
      id: text(item.eventId ?? item.timelineId ?? `timeline_${index}`, '', 160),
      type: text(item.type ?? item.status ?? 'event', '', 80),
      labelZh: text(item.labelZh ?? STATUS_LABELS[item.status] ?? item.type ?? '状态变化', '', 160),
      reasonZh: text(item.reasonZh ?? item.reasonSummaryZh ?? '', '', 500),
      occurredAt: time(item.occurredAt ?? item.createdAt ?? item.at),
    };
  }).sort((left, right) => Date.parse(right.occurredAt ?? 0) - Date.parse(left.occurredAt ?? 0));
}
function normalizeAppeals(value) {
  return array(value ?? []).map((item, index) => {
    object(item);
    return {
      appealId: text(item.appealId ?? `appeal_${index}`, '', 160),
      status: text(item.status ?? 'submitted', '', 60),
      reasonZh: text(item.reasonZh ?? item.reasonSummaryZh ?? '已提交复核', '', 500),
      submittedAt: time(item.submittedAt ?? item.createdAt),
    };
  });
}
function normalizeWork(item, index) {
  object(item);
  const abilityType = text(item.abilityType ?? item.type, '', 32);
  if (!['skill', 'application'].includes(abilityType)) fail();
  const status = text(item.status ?? 'draft', '', 32);
  if (!STATUS_LABELS[status]) fail();
  const reviewGaps = strings(item.reviewGaps ?? item.missingEvidence ?? []);
  return {
    workId: text(item.workId ?? `work_${index}`, '', 160),
    abilityType,
    productId: text(item.productId ?? '', '', 160),
    titleZh: text(item.titleZh ?? item.title ?? '未命名作品', '', 160),
    summaryZh: text(item.summaryZh ?? item.descriptionZh ?? '', '', 500),
    version: text(item.version ?? item.currentVersion ?? '尚无版本', '', 80),
    status,
    statusLabelZh: STATUS_LABELS[status],
    nextAction: text(item.nextAction ?? 'none', '', 80),
    nextActionZh: text(item.nextActionZh ?? ACTION_LABELS[item.nextAction] ?? item.nextAction ?? ACTION_LABELS.none, '', 240),
    reviewGaps,
    rightsSummary: rights(item.rightsSummary ?? item.rights ?? item.rightsDeclaration ?? []),
    timeline: normalizeTimeline(item.timeline ?? item.versionTimeline ?? []),
    appeals: normalizeAppeals(item.appeals ?? []),
    updatedAt: time(item.updatedAt ?? item.createdAt),
  };
}

export function normalizeCreatorData(input) {
  assertPublic(input);
  object(input);
  if (input.schemaVersion !== 1) fail();
  const publisher = object(input.publisher);
  const works = array(input.works ?? [], MAX_WORKS).map(normalizeWork);
  const summary = {
    works: works.length,
    drafts: works.filter(work => work.status === 'draft').length,
    inReview: works.filter(work => ['submitted', 'in_review', 'approved'].includes(work.status)).length,
    changesRequired: works.filter(work => ['changes_required', 'rejected'].includes(work.status)).length,
    published: works.filter(work => work.status === 'published').length,
    inactive: works.filter(work => ['withdrawn', 'recalled'].includes(work.status)).length,
  };
  return Object.freeze({
    schemaVersion: 1,
    generatedAt: time(input.generatedAt),
    publisher: Object.freeze({
      publisherId: text(publisher.publisherId, '', 160),
      displayName: text(publisher.displayName ?? publisher.name, '未命名发布主体', 160),
      kind: text(publisher.kind, '', 32),
      status: text(publisher.status ?? 'active', '', 32),
    }),
    summary: Object.freeze(summary),
    works: Object.freeze(works),
  });
}

function node(tag, content = '', className = '') {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (content !== '') element.textContent = content;
  return element;
}
function formatTime(value) {
  if (!value) return '时间未提供';
  return new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
}
function empty(container, message) { container.append(node('p', message, 'empty-row')); }

function renderSummary(data) {
  const grid = document.querySelector('#summary-grid');
  grid.replaceChildren();
  for (const [key, label] of SUMMARY) {
    const item = node('div');
    item.append(node('dt', label), node('dd', String(data.summary[key])));
    grid.append(item);
  }
}
function renderWorks(data) {
  const list = document.querySelector('#works-list');
  list.replaceChildren();
  if (!data.works.length) return empty(list, '尚无可展示作品。创作项目默认私有，未经裁剪不会出现在这里。');
  for (const work of data.works) {
    const row = node('article', '', 'work-row');
    const main = node('div');
    const head = node('div', '', 'work-head');
    head.append(node('span', work.abilityType === 'skill' ? '技能' : '应用', 'type-chip'), node('h3', work.titleZh), node('span', work.statusLabelZh, `status-chip ${work.status}`));
    main.append(head);
    if (work.summaryZh) main.append(node('p', work.summaryZh, 'work-copy'));
    const meta = node('p', '', 'work-meta');
    meta.append(node('span', work.version), node('span', work.productId || '商品身份待建立'), node('span', formatTime(work.updatedAt)));
    main.append(meta);
    if (work.reviewGaps.length) {
      const gaps = node('ul', '', 'gap-list');
      work.reviewGaps.forEach(gap => gaps.append(node('li', `缺口：${gap}`)));
      main.append(gaps);
    }
    if (work.rightsSummary.length) {
      const rights = node('ul', '', 'rights-list');
      work.rightsSummary.forEach(right => rights.append(node('li', right, 'right-chip')));
      main.append(rights);
    }
    const action = node('aside', '', 'work-action');
    action.append(node('p', '下一动作', 'label'), node('p', work.nextActionZh));
    row.append(main, action);
    list.append(row);
  }
}
function renderEvidence(data) {
  const list = document.querySelector('#evidence-list');
  list.replaceChildren();
  const evidenced = data.works.filter(work => work.timeline.length);
  if (!evidenced.length) return empty(list, '尚无可公开的版本与发布事件。');
  for (const work of evidenced) {
    const article = node('article', '', 'evidence-work');
    const header = node('header');
    header.append(node('h3', work.titleZh), node('p', `${work.version} · ${work.statusLabelZh}`));
    const timeline = node('ol', '', 'timeline');
    for (const event of work.timeline) {
      const item = node('li');
      const stamp = node('time', formatTime(event.occurredAt));
      if (event.occurredAt) stamp.dateTime = event.occurredAt;
      const copy = node('div');
      copy.append(node('p', event.labelZh));
      if (event.reasonZh) copy.append(node('p', event.reasonZh, 'reason'));
      item.append(stamp, copy);
      timeline.append(item);
    }
    article.append(header, timeline);
    list.append(article);
  }
}
function renderAppeals(data) {
  const list = document.querySelector('#appeals-list');
  list.replaceChildren();
  const appeals = data.works.flatMap(work => work.appeals.map(appeal => ({ ...appeal, titleZh: work.titleZh })));
  if (!appeals.length) return empty(list, '当前没有申诉记录。');
  for (const appeal of appeals) {
    const row = node('article', '', 'appeal-row');
    const copy = node('div');
    copy.append(node('p', appeal.titleZh), node('p', appeal.reasonZh, 'secondary'));
    const meta = node('div');
    meta.append(node('p', appeal.status, 'mono'), node('p', formatTime(appeal.submittedAt), 'secondary mono'));
    row.append(copy, meta);
    list.append(row);
  }
}
function render(data) {
  document.querySelector('#publisher-name').textContent = data.publisher.displayName;
  document.querySelector('#publisher-kind').textContent = data.publisher.kind === 'organization' ? '组织' : '个人';
  document.querySelector('#generated-at').textContent = formatTime(data.generatedAt);
  document.querySelector('#work-count').textContent = `${data.summary.works} 个作品`;
  renderSummary(data);
  renderWorks(data);
  renderEvidence(data);
  renderAppeals(data);
  document.querySelector('#state').hidden = true;
  document.querySelector('#workspace').hidden = false;
}
function renderError(error) {
  const state = document.querySelector('#state');
  if (!state) return;
  state.className = 'state-panel wrap error';
  state.replaceChildren(node('p', 'creator projection unavailable', 'eyebrow'), node('h2', '无法读取创作者数据'), node('p', error?.message === 'PUBLIC_CREATOR_DATA_REQUIRED' ? '输入包含非公开字段或结构不受支持，页面已停止展示。' : '请检查本地创作者投影是否存在且格式正确。'));
}
function configuredUrl() {
  return document.querySelector('meta[name="skillops:creator-url"]')?.content || document.body?.dataset.creatorUrl || DEFAULT_DATA_URL;
}
async function load() {
  if (globalThis.SKILLOPS_CREATOR_DATA !== undefined) return globalThis.SKILLOPS_CREATOR_DATA;
  const response = await fetch(configuredUrl(), { headers: { accept: 'application/json' } });
  if (!response.ok) throw new Error(`创作者投影读取失败 (${response.status})`);
  return response.json();
}

if (typeof document !== 'undefined') load().then(payload => render(normalizeCreatorData(payload))).catch(renderError);

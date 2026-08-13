const DEFAULT_DATA_URL = './data/ops-public.json';
const PRIVATE_KEY = /^(?:.*Principal.*|principalId|reviewers|subjectId|email|path|localPath|absolutePath|storageRef|content|skillBody|prompt|output|token|secret|password|credential|api[_-]?key|productionUrl|privateUrl)$/i;
const PRIVATE_VALUE = /^(?:cand_|file:\/\/|\/|[A-Za-z]:[\\/])/i;
const ROLE_LABELS = { viewer: '观察者', member: '成员', reviewer: '审核员', operator: '运营员', org_admin: '组织管理员' };
const EVENT_LABELS = {
  'organization.created': '创建组织', 'organization.updated': '更新组织',
  'project.created': '创建项目', 'project.updated': '更新项目', 'project.retired': '停用项目', 'project.restored': '恢复项目',
  'establishment.created': '创建能力编制', 'establishment.updated': '更新能力编制',
  'establishment.retired': '停用能力编制', 'establishment.restored': '恢复能力编制',
  'enrollment.created': '技能入编', 'enrollment.updated': '更新技能入编',
  'enrollment.retired': '技能退出编制', 'enrollment.restored': '恢复技能入编',
  'policy.changed': '更新组织策略', 'role.bound': '绑定角色', 'role.unbound': '解除角色',
};

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function assertPublic(value) {
  if (Array.isArray(value)) {
    value.forEach(assertPublic);
    return;
  }
  if (isObject(value)) {
    for (const [key, nested] of Object.entries(value)) {
      if (PRIVATE_KEY.test(key)) throw new Error('PUBLIC_DATA_REQUIRED');
      assertPublic(nested);
    }
    return;
  }
  if (typeof value === 'string' && (PRIVATE_VALUE.test(value) || /^cand_/i.test(value))) throw new Error('PUBLIC_DATA_REQUIRED');
}

function entries(value) {
  return isObject(value) ? Object.values(value).filter(isObject) : [];
}

function safeNumber(value) {
  const result = Number(value);
  return Number.isFinite(result) && result >= 0 ? result : 0;
}

function reconciliationRows(staging) {
  const value = staging.reconciliationRequired ?? staging.reconciliation_required ?? staging.reconciliation;
  if (Array.isArray(value)) return value.filter(isObject);
  if (isObject(value)) return Object.values(value).filter(isObject);
  const operations = Array.isArray(staging.operations) ? staging.operations.filter(isObject) : [];
  return operations
    .filter(operation => operation.state === 'reconciliation_required')
    .map(operation => isObject(operation.reconciliation) ? operation.reconciliation : operation);
}

export function normalizePublicOps(payload) {
  if (!isObject(payload)) throw new Error('PUBLIC_DATA_REQUIRED');
  assertPublic(payload);
  const organizationProjection = payload.organizationProjection ?? payload.organization ?? payload.governance;
  const stagingStatus = payload.stagingStatus ?? payload.staging;
  if (!isObject(organizationProjection) || !isObject(organizationProjection.organization) || !isObject(stagingStatus)) {
    throw new Error('PUBLIC_DATA_REQUIRED');
  }
  const operations = Array.isArray(stagingStatus.operations) ? stagingStatus.operations.filter(isObject) : [];
  const receipts = Array.isArray(stagingStatus.receipts)
    ? stagingStatus.receipts.filter(isObject)
    : operations.filter(operation => operation.state === 'accepted').map(operation => operation.receipt).filter(isObject);
  const reconciliation = reconciliationRows(stagingStatus);
  return Object.freeze({
    generatedAt: typeof payload.generatedAt === 'string' ? payload.generatedAt : null,
    throughSequence: safeNumber(organizationProjection.throughSequence),
    organization: structuredClone(organizationProjection.organization),
    projects: entries(organizationProjection.projects),
    establishments: entries(organizationProjection.establishments),
    enrollments: entries(organizationProjection.enrollments),
    roles: Object.fromEntries(Object.keys(ROLE_LABELS).map(role => [role, safeNumber(organizationProjection.roleSummary?.[role])])),
    auditEvents: Array.isArray(organizationProjection.auditEvents) ? organizationProjection.auditEvents.filter(isObject) : [],
    staging: {
      cursor: String(stagingStatus.cursor ?? '0'),
      accepted: safeNumber(stagingStatus.receiptCount ?? receipts.filter(row => row.status === 'accepted').length),
      reconciliationCount: safeNumber(stagingStatus.reconciliationRequiredCount ?? reconciliation.length),
      receipts,
      reconciliation,
    },
  });
}

function node(tagName, value, className) {
  const element = document.createElement(tagName);
  if (className) element.className = className;
  element.textContent = String(value ?? '');
  return element;
}

function formatTime(value) {
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return '时间未记录';
  return new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(time));
}

function statusLabel(value) {
  return ({ active: '运行中', retired: '已停用', accepted: '已接收', reconciliation_required: '待对账' })[value] || String(value || '状态未记录');
}

function empty(target, copy) {
  target.replaceChildren(node('p', copy, 'empty-row'));
}

function renderProjects(data, elements) {
  elements.projectList.replaceChildren();
  if (!data.projects.length) return empty(elements.projectList, '当前组织尚未创建项目。');
  for (const project of data.projects) {
    const card = node('article', '', 'project-card');
    card.append(node('p', project.projectId || '项目', 'eyebrow'), node('h3', project.name || '未命名项目'), node('p', statusLabel(project.status)));
    elements.projectList.append(card);
  }
}

function renderEstablishments(data, elements) {
  elements.establishmentList.replaceChildren();
  elements.establishmentCount.textContent = `${data.establishments.length} 项`;
  if (!data.establishments.length) return empty(elements.establishmentList, '尚无能力编制。');
  for (const item of data.establishments) {
    const row = node('article', '', 'record-row');
    const copy = node('div');
    copy.append(node('h3', item.name || '未命名编制'), node('p', item.projectId ? `所属项目 ${item.projectId}` : '组织级编制'));
    const meta = node('div', '', 'record-meta');
    meta.append(node('p', `${safeNumber(item.capacity)} 个席位`, 'mono'), node('p', statusLabel(item.status)));
    row.append(copy, meta);
    elements.establishmentList.append(row);
  }
}

function renderEnrollments(data, elements) {
  elements.enrollmentList.replaceChildren();
  elements.enrollmentCount.textContent = `${data.enrollments.length} 项`;
  if (!data.enrollments.length) return empty(elements.enrollmentList, '尚无技能进入组织编制。');
  for (const item of data.enrollments) {
    const row = node('article', '', 'record-row');
    const copy = node('div');
    copy.append(node('h3', item.skillId || '技能未命名'), node('p', `编制 ${item.establishmentId || '未关联'}`));
    const meta = node('div', '', 'record-meta');
    meta.append(node('p', item.releaseId || '发行未绑定', 'mono'), node('p', statusLabel(item.status)));
    row.append(copy, meta);
    elements.enrollmentList.append(row);
  }
}

function renderRoles(data, elements) {
  elements.roleSummary.replaceChildren();
  for (const [role, label] of Object.entries(ROLE_LABELS)) {
    const item = node('div');
    item.append(node('dt', label), node('dd', data.roles[role]));
    elements.roleSummary.append(item);
  }
}

function renderStaging(data, elements) {
  elements.stagingCursor.textContent = data.staging.cursor;
  elements.stagingAccepted.textContent = String(data.staging.accepted);
  elements.stagingReconciliation.textContent = String(data.staging.reconciliationCount);
  elements.reconciliationChip.textContent = data.staging.reconciliationCount ? '存在待对账项' : '台账已对齐';
  elements.reconciliationChip.className = `status-chip ${data.staging.reconciliationCount ? 'caution' : 'positive'}`;
  elements.receiptList.replaceChildren();
  if (!data.staging.receipts.length && !data.staging.reconciliation.length) {
    return empty(elements.receiptList, data.staging.reconciliationCount ? '存在待对账记录，当前公共投影未提供明细。' : '尚无 Staging 发送回执。');
  }
  for (const receipt of data.staging.receipts) {
    const row = node('article', '', 'receipt-row');
    row.append(node('p', receipt.operationId || '未命名操作', 'mono'), node('p', statusLabel(receipt.status), 'secondary'), node('p', formatTime(receipt.receivedAt || receipt.recordedAt), 'secondary mono'));
    elements.receiptList.append(row);
  }
  for (const item of data.staging.reconciliation) {
    const row = node('article', '', 'receipt-row');
    row.append(node('p', item.operationId || '待对账操作', 'mono'), node('p', '待对账', 'secondary'), node('p', formatTime(item.recordedAt || item.occurredAt), 'secondary mono'));
    elements.receiptList.append(row);
  }
}

function renderAudit(data, elements) {
  const events = [...data.auditEvents].sort((left, right) => safeNumber(right.sequence) - safeNumber(left.sequence));
  elements.auditCount.textContent = `${events.length} 条`;
  elements.auditList.replaceChildren();
  if (!events.length) {
    const item = node('li', '尚无组织治理审计事件。', 'empty-row');
    elements.auditList.append(item);
    return;
  }
  for (const event of events) {
    const item = node('li', '', 'audit-item');
    item.append(node('p', `#${event.sequence ?? '-'}`, 'audit-sequence'), node('p', EVENT_LABELS[event.type] || event.type || '治理事件'), node('time', formatTime(event.occurredAt), 'audit-time'));
    elements.auditList.append(item);
  }
}

function render(data) {
  const elements = {
    state: document.querySelector('#state'), dashboard: document.querySelector('#dashboard'),
    heroOrganization: document.querySelector('#hero-organization'), heroSequence: document.querySelector('#hero-sequence'), heroGenerated: document.querySelector('#hero-generated'),
    organizationStatus: document.querySelector('#organization-status'), projectList: document.querySelector('#project-list'),
    establishmentList: document.querySelector('#establishment-list'), establishmentCount: document.querySelector('#establishment-count'),
    enrollmentList: document.querySelector('#enrollment-list'), enrollmentCount: document.querySelector('#enrollment-count'), roleSummary: document.querySelector('#role-summary'),
    stagingCursor: document.querySelector('#staging-cursor'), stagingAccepted: document.querySelector('#staging-accepted'), stagingReconciliation: document.querySelector('#staging-reconciliation'),
    reconciliationChip: document.querySelector('#reconciliation-chip'), receiptList: document.querySelector('#receipt-list'),
    auditCount: document.querySelector('#audit-count'), auditList: document.querySelector('#audit-list'),
  };
  elements.heroOrganization.textContent = data.organization.name || '未命名组织';
  elements.heroSequence.textContent = String(data.throughSequence);
  elements.heroGenerated.textContent = formatTime(data.generatedAt);
  elements.organizationStatus.textContent = statusLabel(data.organization.status);
  elements.organizationStatus.className = `status-chip ${data.organization.status === 'active' ? 'positive' : 'caution'}`;
  renderProjects(data, elements);
  renderEstablishments(data, elements);
  renderEnrollments(data, elements);
  renderRoles(data, elements);
  renderStaging(data, elements);
  renderAudit(data, elements);
  elements.state.hidden = true;
  elements.dashboard.hidden = false;
}

function renderError(error) {
  const state = document.querySelector('#state');
  if (!state) return;
  state.className = 'state-panel wrap error';
  state.replaceChildren(node('p', 'public projection unavailable', 'eyebrow'), node('h2', '无法读取运营数据'), node('p', error?.message === 'PUBLIC_DATA_REQUIRED' ? '输入不是安全的公共投影，页面已停止展示。' : '请检查公共运营 JSON 是否存在且格式正确。'));
}

function configuredUrl() {
  return document.querySelector('meta[name="skillops:ops-url"]')?.content || document.body?.dataset.opsUrl || DEFAULT_DATA_URL;
}

async function load() {
  const injected = globalThis.SKILLOPS_PUBLIC_OPS;
  if (injected !== undefined) return injected;
  const response = await fetch(configuredUrl(), { headers: { accept: 'application/json' } });
  if (!response.ok) throw new Error(`公共运营数据读取失败 (${response.status})`);
  return response.json();
}

if (typeof document !== 'undefined') {
  load().then(payload => render(normalizePublicOps(payload))).catch(renderError);
}

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

const DIMENSION_LABELS = {
  clarity: '清晰度',
  invocability: '可调用性',
  executability: '可执行性',
  stability: '稳定性',
  quality: '交付质量',
  reusability: '复用性',
  composability: '可组合性',
  evaluability: '可评估性',
  safety: '安全性',
  business: '业务价值',
};

const STATUS_LABELS = {
  allowed: '允许分发',
  index_only: '仅来源索引',
  pass: '本地扫描通过',
  review: '需要关注',
  pending: '等待验证',
  complete: '已完成',
  approved: '旧版批准，待双人终审',
  verified: '已有实绩',
  eligible: '符合受控部署条件',
  source_required: '需要补齐来源包',
  certified: '双人终审有效',
  pending_second_review: '待第二人复核',
  pending_review: '待终审',
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

const elements = {
  loading: document.querySelector('#loading-state'),
  error: document.querySelector('#error-state'),
  errorMessage: document.querySelector('#error-message'),
  content: document.querySelector('#detail-content'),
  category: document.querySelector('#skill-category'),
  translationNote: document.querySelector('#translation-note'),
  name: document.querySelector('#skill-name'),
  originalName: document.querySelector('#original-name'),
  description: document.querySelector('#skill-description'),
  actions: document.querySelector('#hero-actions'),
  decisionMetrics: document.querySelector('#decision-metrics'),
  installBoundary: document.querySelector('#install-boundary'),
  scenarioDescription: document.querySelector('#scenario-description'),
  scenarioFacts: document.querySelector('#scenario-facts'),
  tags: document.querySelector('#skill-tags'),
  smsSummary: document.querySelector('#sms-summary'),
  dimensions: document.querySelector('#sms-dimensions'),
  evalContent: document.querySelector('#eval-content'),
  provenance: document.querySelector('#provenance-records'),
  governance: document.querySelector('#governance-content'),
  package: document.querySelector('#package-content'),
  related: document.querySelector('#related'),
  relatedList: document.querySelector('#related-list'),
  marketLinks: [...document.querySelectorAll('#market-home, #market-back, #error-back')],
};

function text(tagName, value, className) {
  const element = document.createElement(tagName);
  if (className) element.className = className;
  element.textContent = visibleString(value);
  return element;
}

function visibleString(value) {
  return String(value ?? '').replace(/[—–]/g, '-');
}

function safeExternalUrl(value) {
  try {
    const url = new URL(value);
    return ['https:', 'http:'].includes(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}

function readConfig() {
  let injected = {};
  const configNode = document.querySelector('#skillops-detail-config');
  if (configNode) {
    try { injected = JSON.parse(configNode.textContent); } catch { injected = {}; }
  }
  const globalConfig = globalThis.SKILLOPS_DETAIL_CONFIG || {};
  const body = document.body.dataset;
  const metaSource = document.querySelector('meta[name="skillops:listing-url"]')?.content;
  const match = location.pathname.match(/^(.*)\/skills\/([^/]+)\/(?:index\.html)?$/);
  const skillId = injected.skillId || globalConfig.skillId || body.skillId || (match ? decodeURIComponent(match[2]) : '');
  const prefix = match ? match[1] : '';
  const inferredUrl = skillId ? `${prefix}/data/skills/${encodeURIComponent(skillId)}.json` : '';
  const listingUrl = injected.listingUrl || injected.listingSrc || globalConfig.listingUrl
    || body.listingSrc || metaSource || inferredUrl;
  const marketUrl = injected.marketUrl || globalConfig.marketUrl || (match ? (prefix ? `${prefix}/` : '/') : '../../');
  return { skillId, listingUrl, marketUrl };
}

function statusLabel(value) {
  return STATUS_LABELS[value] || visibleString(value || '未记录');
}

function trustState(listing) {
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
  const tone = code === 'certified' ? 'positive'
    : ['recalled', 'revoked', 'withdrawn', 'retired'].includes(code) ? 'critical'
      : 'caution';
  return { code, label: statusLabel(code), tone };
}

function installReasonText(reason) {
  if (typeof reason === 'object' && reason) return visibleString(reason.messageZh || reason.message || INSTALL_REASON_LABELS[reason.code] || reason.code);
  return INSTALL_REASON_LABELS[reason] || visibleString(reason);
}

function installDecision(listing) {
  const trust = trustState(listing);
  const install = listing.install || {};
  const declaredEligibility = typeof install.eligibility === 'object' ? install.eligibility.eligible : install.eligibility;
  const supplied = [
    ...(Array.isArray(install.reasons) ? install.reasons : []),
    ...(Array.isArray(install.eligibility?.reasons) ? install.eligibility.reasons : []),
    install.reason,
  ].filter(Boolean);
  const reasons = supplied.map(installReasonText);
  if (declaredEligibility === false || install.eligibility === false) reasons.push(INSTALL_REASON_LABELS.explicitly_ineligible);
  if (listing.distribution === 'source_link_only') reasons.push(INSTALL_REASON_LABELS.license_allows_source_link_only);
  if (install.packageComplete !== true) reasons.push(INSTALL_REASON_LABELS.complete_package_missing);
  const reasonCode = {
    pending_second_review: 'pending_second_review', pending_review: 'pending_review', pending: 'pending_review',
    stale: 'evidence_stale', expired: 'certification_expired', withdrawn: 'release_withdrawn',
    recalled: 'release_recalled', revoked: 'release_revoked', retired: 'skill_retired',
    active_pending_revalidation: 'revalidation_required',
  }[trust.code];
  if (reasonCode) reasons.push(INSTALL_REASON_LABELS[reasonCode]);
  const trusted = trust.code === 'certified' || trust.code === 'expiring';
  const statusEligible = listing.install?.status === 'eligible';
  const eligible = statusEligible && declaredEligibility !== false
    && install.packageComplete === true && listing.distribution !== 'source_link_only' && trusted;
  return { eligible, trust, reasons: [...new Set(reasons.filter(Boolean))] };
}

function categoryLabel(value) {
  return CATEGORY_LABELS[value] || visibleString(value || 'uncategorized').replace(/[-_]/g, ' ');
}

function shortHash(value) {
  const string = String(value || '');
  if (!string) return '未记录';
  return string.length > 22 ? `${string.slice(0, 12)}...${string.slice(-8)}` : string;
}

function smsTier(total) {
  if (!Number.isFinite(Number(total))) return '待评估';
  if (Number(total) >= 86) return 'S';
  if (Number(total) >= 76) return 'A';
  if (Number(total) >= 64) return 'B';
  return '待复核';
}

function listingTags(listing) {
  const tags = listing.catalog?.tags;
  if (Array.isArray(tags)) return tags.map(String);
  if (tags && typeof tags === 'object') return Object.entries(tags).map(([key, value]) => `${key}:${value}`);
  return tags ? [String(tags)] : [];
}

function operationsProjection(payload) {
  const listing = payload?.listing || payload?.skill || payload;
  return payload?.operationsProjection || listing?.operationsProjection || listing?.skillOperations || listing?.v41 || null;
}

const ROUTING_FINDING_LABELS = {
  missing_when_to_use: '缺少“何时使用”说明', missing_when_not_to_use: '缺少“何时不要使用”说明',
  missing_positive_example: '缺少正向任务示例', missing_negative_example: '缺少反向任务示例',
  no_confusion_comparison: '尚未说明易混淆技能', positive_negative_boundary_duplicate: '正反边界存在重复',
  positive_negative_boundary_ambiguous: '正反边界仍有歧义', confusion_conflict_not_declared: '易混淆技能未声明冲突',
  declared_conflict_not_explained: '已声明冲突但缺少区分说明', inputs_not_described: '输入未说明', outputs_not_described: '输出未说明',
  single_compatibility_target: '仅验证一个兼容目标', release_pinned_dependency: '依赖固定到特定发行版',
};

function listBlock(title, values, emptyCopy) {
  const block = document.createElement('section');
  block.className = 'routing-boundary-block';
  block.append(text('h3', title));
  const items = Array.isArray(values) ? values.filter(Boolean) : [];
  if (!items.length) block.append(text('p', emptyCopy, 'pending-copy'));
  else {
    const list = document.createElement('ul');
    for (const item of items) list.append(text('li', item));
    block.append(list);
  }
  return block;
}

function renderRouting(listing, projection) {
  let section = document.querySelector('#routing');
  if (!section) {
    section = document.createElement('section');
    section.className = 'detail-section';
    section.id = 'routing';
    section.setAttribute('aria-labelledby', 'routing-title');
    const heading = document.createElement('div');
    heading.className = 'section-heading';
    heading.append(text('span', '路由', 'section-number mono'), text('h2', '何时用，何时不要用'));
    heading.querySelector('h2').id = 'routing-title';
    const content = document.createElement('div'); content.id = 'routing-content';
    section.append(heading, text('p', 'Routing 只判断静态路由质量，与 Eval 运行实绩分开呈现。', 'section-lead'), content);
    document.querySelector('#sms')?.before(section);
  }
  const content = section.querySelector('#routing-content');
  if (!content) return;
  const routing = projection?.routing;
  const skill = projection?.skill;
  if (!routing || !skill) {
    content.replaceChildren(text('p', '这个技能尚未形成 Skill Record 2.0 路由档案。当前只能依据目录说明判断。', 'pending-panel'));
    return;
  }
  const summary = document.createElement('div');
  summary.className = 'routing-assessment-summary';
  const score = document.createElement('div');
  score.append(text('strong', `${routing.total}/${routing.maxTotal}`, 'routing-score mono'), text('span', '静态 Routing 质量'));
  const explanation = document.createElement('div');
  explanation.append(
    text('h3', 'Routing 与 Eval 分开判断'),
    text('p', 'Routing 评估元数据是否足以让 Agent 正确选择技能。它不是运行成功率，也不能替代 Eval。'),
  );
  summary.append(score, explanation);
  const findings = routing.dimensions.flatMap(item => item.reasons || []).map(code => ROUTING_FINDING_LABELS[code] || code);
  const boundaries = document.createElement('div');
  boundaries.className = 'routing-boundaries';
  boundaries.append(
    listBlock('何时使用', routing.whenToUse, '尚未提供正向路由条件。'),
    listBlock('何时不要使用', routing.whenNotToUse, '尚未提供反向路由条件。'),
  );
  const technical = document.createElement('dl');
  technical.className = 'fact-grid routing-facts';
  addFacts(technical, [
    ['任务意图', skill.intentTags.join('，') || '未记录'],
    ['必需权限', skill.permissions.required.join('，') || '无需额外权限'],
    ['禁止权限', skill.permissions.prohibited.join('，') || '未声明'],
    ['兼容环境', `${skill.compatibility.contract}：${skill.compatibility.targets.join('，')}`],
    ['静态发现', findings.join('；') || '未发现静态路由缺口'],
    ['评估限制', '只描述静态路由质量，不代表运行实绩'],
  ]);
  content.replaceChildren(summary, boundaries, technical);
}

function renderComposition(projection) {
  let section = document.querySelector('#composition');
  if (!section) {
    section = document.createElement('section');
    section.className = 'detail-section';
    section.id = 'composition';
    section.setAttribute('aria-labelledby', 'composition-title');
    const heading = document.createElement('div');
    heading.className = 'section-heading';
    heading.append(text('span', '组合', 'section-number mono'), text('h2', '可组合技能与顺序'));
    heading.querySelector('h2').id = 'composition-title';
    const content = document.createElement('div'); content.id = 'composition-content';
    section.append(heading, text('p', '组合计划只展示公开理由、顺序与阻断，不执行技能。', 'section-lead'), content);
    document.querySelector('#sms')?.before(section);
  }
  const content = section.querySelector('#composition-content');
  if (!content) return;
  const composition = projection?.composition;
  if (!composition) {
    content.replaceChildren(text('p', '尚无经过权限与兼容门禁的组合计划。', 'pending-panel'));
    return;
  }
  const status = text('p', composition.status === 'ready' ? '组合计划可用' : composition.status === 'blocked' ? '组合计划被阻断' : '当前任务没有匹配组合', `composition-status ${composition.status}`);
  const list = document.createElement('ol');
  list.className = 'composition-steps';
  for (const step of composition.steps || []) {
    const item = document.createElement('li');
    item.append(text('span', String(step.position).padStart(2, '0'), 'mono'), text('strong', step.titleZh || step.skillId), text('p', step.reasonZh));
    list.append(item);
  }
  const related = document.createElement('div');
  related.className = 'composition-related';
  related.append(text('h3', '可组合技能'));
  const skills = composition.relatedSkills || [];
  related.append(text('p', skills.length ? skills.map(item => `${item.titleZh || item.skillId}（${item.reasonZh}）`).join('；') : '当前计划没有其他组合技能。'));
  const blockers = (composition.blockers || []).map(item => item.messageZh);
  if (blockers.length) related.append(text('p', `阻断原因：${blockers.join('；')}`, 'composition-blocker'));
  content.replaceChildren(status, list, related);
}

function sourceLabel(listing) {
  return listing.catalog?.coordinate || listing.source?.repo || listing.source?.url || '本地来源';
}

function addFacts(container, rows, rowClass = '') {
  container.replaceChildren(...rows.flatMap(([label, value]) => {
    const wrapper = document.createElement('div');
    if (rowClass) wrapper.className = rowClass;
    wrapper.append(text('dt', label), text('dd', value));
    return [wrapper];
  }));
}

function sourceLink(listing, label = '查看原始来源') {
  const url = safeExternalUrl(listing.source?.marketplaceUrl || listing.source?.url || listing.source?.upstreamUrl);
  if (!url) return null;
  const link = text('a', label, 'button');
  link.href = url;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  return link;
}

function renderHero(listing) {
  const category = categoryLabel(listing.catalog?.category);
  const original = listing.original?.name || listing.localization?.originalName;
  const isAutoTranslated = listing.localization?.status === 'auto_translated';
  elements.category.textContent = category;
  elements.translationNote.hidden = !isAutoTranslated;
  elements.name.textContent = visibleString(listing.localization?.titleZh || listing.name || '未命名技能');
  elements.originalName.textContent = original && original !== listing.name ? `英文原名: ${visibleString(original)}` : '';
  elements.originalName.hidden = !elements.originalName.textContent;
  elements.description.textContent = visibleString(listing.localization?.descriptionZh || listing.description || '暂无中文说明');
  document.title = `${elements.name.textContent} | 造物云技能市场`;

  const source = sourceLink(listing, listing.distribution === 'source_link_only' ? '查看来源并继续判断' : '查看原始来源');
  const back = text('a', '返回能力市场', 'button ghost');
  back.href = readConfig().marketUrl;
  elements.actions.replaceChildren(...[source, back].filter(Boolean));

  const evalState = listing.eval?.status === 'pending' || !listing.eval?.status ? '等待实绩验证' : statusLabel(listing.eval.status);
  addFacts(elements.decisionMetrics, [
    ['SMS 静态潜力', listing.sms?.total == null ? '待评分' : `${listing.sms.total}/100 · ${smsTier(listing.sms.total)} 段`],
    ['Eval 运行实绩', evalState],
    ['许可', listing.license?.spdx || statusLabel(listing.license?.status)],
    ['安全', statusLabel(listing.security?.status)],
    ['技能包', listing.install?.packageComplete ? '完整' : '不完整'],
  ]);

  const decision = installDecision(listing);
  const eligible = decision.eligible;
  elements.installBoundary.className = `install-boundary ${eligible ? 'eligible' : 'restricted'}`;
  elements.installBoundary.replaceChildren(
    text('span', decision.trust.label, `trust-badge trust-${decision.trust.tone}`),
    text('strong', eligible ? '可进入受控部署' : '当前不可直接安装'),
    text('p', eligible
      ? '技能包已完整同步。部署仍需经过目标检查、漂移检测和 lock 台账。'
      : decision.reasons.join('；') || '当前可信证据不满足受控部署要求。'),
  );
  if (eligible && listing.distribution !== 'source_link_only') {
    const deploy = text('button', '复制部署命令', 'button small');
    deploy.type = 'button';
    deploy.addEventListener('click', async () => {
      const command = `skillops deploy ${listing.id} --to <target-root>`;
      try {
        await navigator.clipboard.writeText(command);
        deploy.textContent = '部署命令已复制';
      } catch {
        deploy.textContent = command;
      }
    });
    elements.installBoundary.append(deploy);
  }
}

function renderFit(listing) {
  const category = categoryLabel(listing.catalog?.category);
  const scenario = listing.catalog?.scenario || listing.catalog?.useCase || listing.catalog?.summaryZh || listing.description;
  elements.scenarioDescription.textContent = visibleString(scenario || '来源尚未提供具体使用场景。');
  const inputs = listing.catalog?.inputs || listing.inputs || '按技能说明提供任务材料';
  const outputs = listing.catalog?.outputs || listing.outputs || '按技能约定生成结果';
  addFacts(elements.scenarioFacts, [
    ['工作类型', category],
    ['输入', Array.isArray(inputs) ? inputs.join('，') : inputs],
    ['输出', Array.isArray(outputs) ? outputs.join('，') : outputs],
    ['是否需要密钥', listing.catalog?.requiresApiKey === true ? '需要' : '未声明或不需要'],
  ]);
  const tags = listingTags(listing);
  elements.tags.replaceChildren(...tags.map(value => text('span', value, 'tag')));
  elements.tags.hidden = tags.length === 0;
}

function normalizeDimensions(dimensions) {
  if (Array.isArray(dimensions)) return dimensions;
  if (dimensions && typeof dimensions === 'object') {
    return Object.entries(dimensions).map(([key, value]) => typeof value === 'object' ? { key, ...value } : { key, score: value });
  }
  return [];
}

function renderSms(listing) {
  const total = Number(listing.sms?.total);
  const tier = smsTier(total);
  elements.smsSummary.replaceChildren(
    text('p', Number.isFinite(total) ? String(total) : '-', 'score-number mono'),
    text('div', `${tier} 段`, `tier tier-${tier}`),
    text('p', listing.sms?.rubricVersion || '评分规范未记录', 'score-version mono'),
  );
  const dimensions = normalizeDimensions(listing.sms?.dimensions);
  if (!dimensions.length) {
    elements.dimensions.replaceChildren(text('p', '尚未完成十维评估。', 'pending-panel'));
    return;
  }
  elements.dimensions.replaceChildren(...dimensions.map((dimension, index) => {
    const item = document.createElement('article');
    item.className = 'dimension-item';
    const heading = document.createElement('div');
    heading.className = 'dimension-heading';
    heading.append(
      text('span', String(index + 1).padStart(2, '0'), 'dimension-index mono'),
      text('h3', DIMENSION_LABELS[dimension.key] || categoryLabel(dimension.key)),
      text('strong', Number.isFinite(Number(dimension.score)) ? `${dimension.score}/10` : '未评分', 'mono'),
    );
    item.append(heading, text('p', dimension.reason || '未记录评分理由', 'dimension-reason'));
    const evidence = Array.isArray(dimension.evidence) ? dimension.evidence : [];
    if (evidence.length) {
      const list = document.createElement('ul');
      list.className = 'evidence-list mono';
      for (const value of evidence) list.append(text('li', value));
      item.append(list);
    }
    return item;
  }));
}

function renderEval(listing) {
  const evaluation = listing.eval || {};
  if (!evaluation.status || evaluation.status === 'pending' || evaluation.status === 'stale') {
    elements.evalContent.replaceChildren(
      text('p', evaluation.status === 'stale' ? 'Eval 证据已过期' : 'Eval 等待验证', 'pending-title'),
      text('p', '当前没有固定测试集、运行环境或成功率证据。页面不会用 SMS 分数替代实绩。'),
    );
    elements.evalContent.className = 'pending-panel';
    return;
  }
  elements.evalContent.className = 'eval-record';
  const rawRate = Number(evaluation.successRate);
  const rate = Number.isFinite(rawRate) ? `${Math.round(rawRate * (rawRate <= 1 ? 100 : 1))}%` : '未记录';
  const facts = document.createElement('dl');
  facts.className = 'fact-grid';
  const environment = evaluation.environment && typeof evaluation.environment === 'object'
    ? Object.entries(evaluation.environment).map(([key, value]) => `${key}: ${visibleString(value)}`).join(' · ')
    : evaluation.environment;
  addFacts(facts, [
    ['状态', statusLabel(evaluation.status)],
    ['成功率', rate],
    ['通过 / 失败', `${evaluation.passed ?? '-'} / ${evaluation.failed ?? '-'}`],
    ['测试集', evaluation.suiteId || evaluation.testSet || evaluation.dataset || '未记录'],
    ['测试集版本', evaluation.suiteVersion || '未记录'],
    ['测试集指纹', shortHash(evaluation.suiteDigest)],
    ['Runner', evaluation.runner || '未记录'],
    ['运行环境', environment || '未记录'],
    ['绑定包指纹', shortHash(evaluation.basedOnPackageDigest)],
  ]);
  const cases = Array.isArray(evaluation.cases) ? evaluation.cases : [];
  const caseList = document.createElement('div');
  caseList.className = 'eval-case-list';
  for (const item of cases) {
    const card = document.createElement('article');
    card.className = `eval-case eval-${item.status || 'unknown'}`;
    const heading = document.createElement('div');
    heading.className = 'eval-case-heading';
    heading.append(
      text('h3', item.id || '未命名用例'),
      text('span', statusLabel(item.status), 'mono'),
    );
    const assertions = Array.isArray(item.assertions) ? item.assertions : [];
    const evidence = document.createElement('ul');
    evidence.className = 'case-evidence';
    for (const assertion of assertions) {
      evidence.append(text('li', `${assertion.passed ? '通过' : '失败'} · ${assertion.type || '断言'} · ${assertion.message || '未记录说明'}`));
    }
    card.append(
      heading,
      text('p', `耗时 ${item.durationMs ?? '-'} ms · 输出摘要: ${item.outputSummary || '未保留'}`, 'eval-case-meta'),
      evidence,
    );
    if (item.error) card.append(text('p', `错误: ${item.error}`, 'eval-error'));
    caseList.append(card);
  }
  elements.evalContent.replaceChildren(facts, caseList);
}

function renderProvenance(listing) {
  addFacts(elements.provenance, [
    ['来源平台', listing.catalog?.provider || listing.source?.kind || '未记录'],
    ['来源坐标', sourceLabel(listing)],
    ['技能路径', listing.source?.path || '未记录'],
    ['版本', listing.source?.version || '未记录'],
    ['Commit', shortHash(listing.source?.commit || listing.version?.commit)],
    ['内容指纹', shortHash(listing.version?.fingerprint)],
    ['来源签名', listing.source?.integrity?.signed === true ? `已验证 · ${listing.source.integrity.keyId || '签名密钥未记录'}` : '未记录'],
    ['分发范围', listing.distribution === 'content' ? '允许分发正文' : '仅来源链接'],
  ], 'record-row');
}

function governanceBlock(title, status, details) {
  const block = document.createElement('section');
  block.className = 'governance-block';
  block.append(text('h3', title), text('strong', status, 'governance-status'));
  for (const detail of details) block.append(text('p', detail));
  return block;
}

function chineseReviewReason(review) {
  const reason = String(review?.reason || '');
  if (/Signed source.*Eval remains explicitly pending\./i.test(reason)) {
    return '已复核来源签名、安全格式、来源链、许可与分发边界、本地安全扫描及 SMS v2 证据。Eval 仍明确标记为等待验证。';
  }
  return reason || '未记录审核说明';
}

function renderGovernance(listing) {
  const findings = Array.isArray(listing.security?.findings) ? listing.security.findings : [];
  const review = listing.verification?.lastReview || {};
  const certification = listing.verification?.certification || {};
  const evidence = listing.verification?.evidence || {};
  const decision = installDecision(listing);
  const licenseDetails = [
    listing.license?.spdx ? `SPDX: ${listing.license.spdx}` : '未识别明确 SPDX 许可证',
    listing.license?.redistributable ? '允许按许可证边界再分发。' : '当前不复制正文，仅保留来源链接。',
  ];
  const safetyDetails = findings.length
    ? findings.map(value => typeof value === 'string' ? value : value.message || value.code || '未命名发现')
    : ['本地静态扫描未记录风险发现。该结果不等同于运行时安全保证。'];
  const reviewDetails = [
    chineseReviewReason(review),
    `审核者: ${review.reviewer || '未记录'} · ${review.at ? new Date(review.at).toLocaleString('zh-CN') : '时间未记录'}`,
    `终审进度: ${Array.isArray(certification.approvals) ? certification.approvals.length : 0}/${certification.requiredApprovals || 2}`,
    `有效期: ${certification.validUntil ? new Date(certification.validUntil).toLocaleString('zh-CN') : '未记录'}`,
  ];
  const evidenceDetails = [
    `证据快照: ${shortHash(evidence.evidenceDigest)}`,
    `绑定技能包: ${shortHash(evidence.packageDigest)}`,
    `绑定 SMS: ${shortHash(evidence.smsDigest)}`,
    `绑定 Eval: ${shortHash(evidence.evalDigest)}`,
    `绑定终审: ${shortHash(certification.certificationDigest || certification.evidenceDigest)}`,
  ];
  elements.governance.replaceChildren(
    governanceBlock('许可边界', listing.license?.spdx || statusLabel(listing.license?.status), licenseDetails),
    governanceBlock('安全扫描', statusLabel(listing.security?.status), safetyDetails),
    governanceBlock('可信终审', decision.trust.label, reviewDetails),
    governanceBlock('证据绑定', evidence.evidenceDigest ? '可追溯' : '证据摘要未记录', evidenceDetails),
  );
}

function renderPackage(listing) {
  const complete = listing.install?.packageComplete === true;
  const packageRecord = listing.package || listing.artifact?.package || {};
  const manifest = Array.isArray(packageRecord.manifest) ? packageRecord.manifest : [];
  const fileCount = packageRecord.fileCount ?? listing.catalog?.packageFileCount ?? listing.install?.fileCount;
  const totalBytes = packageRecord.totalBytes;
  const packageDigest = packageRecord.packageDigest || listing.install?.packageDigest;
  const packageAudit = packageRecord.audit || listing.packageAudit || listing.install?.packageAudit;
  const title = complete ? '技能包已完整同步' : '当前仅同步部分内容';
  const body = complete
    ? '来源文件已形成完整清单。只有包指纹和全包审计保持有效时，才可进入受控部署。'
    : '缺少 references、scripts、模板或其他关联文件时，不提供直接安装。请先补齐完整技能包并重新经过审核。';
  const decision = installDecision(listing);
  const status = document.createElement('div');
  status.className = `package-status ${decision.eligible ? 'complete' : 'incomplete'}`;
  status.append(text('strong', title), text('p', body));
  const facts = document.createElement('dl');
  facts.className = 'package-facts';
  addFacts(facts, [
    ['包完整性', complete ? '完整' : '不完整'],
    ['文件数量', fileCount == null ? '未记录' : `${fileCount} 个`],
    ['包总体积', totalBytes == null ? '未记录' : `${totalBytes} bytes`],
    ['包指纹', shortHash(packageDigest)],
    ['全包审计', packageAudit?.status ? statusLabel(packageAudit.status) : '未完成'],
    ['安装资格', statusLabel(listing.install?.status)],
    ['安装结论', decision.eligible ? '可进入受控部署' : '当前不可直接安装'],
    ['结构化原因', decision.reasons.join('；') || '未记录'],
    ['部署方式', listing.install?.method || 'skillops deploy'],
    ['保护机制', '目标检查 · 漂移检测 · lock 台账'],
  ]);
  const manifestSection = document.createElement('section');
  manifestSection.className = 'package-manifest';
  manifestSection.append(text('h3', '文件清单'));
  if (manifest.length) {
    const list = document.createElement('ul');
    for (const file of manifest.slice(0, 20)) {
      const item = document.createElement('li');
      item.append(
        text('span', file.path || '未命名文件', 'mono'),
        text('span', `${file.size ?? '?'} bytes · ${shortHash(file.sha256)}`, 'manifest-meta mono'),
      );
      list.append(item);
    }
    manifestSection.append(list);
    if (manifest.length > 20) manifestSection.append(text('p', `另有 ${manifest.length - 20} 个文件未展开`, 'manifest-more'));
  } else {
    manifestSection.append(text('p', '当前 listing 尚未提供可验证的完整文件清单。', 'pending-panel'));
  }
  elements.package.replaceChildren(status, facts, manifestSection);
}

function relatedHref(listing) {
  const config = readConfig();
  const currentPath = new URL(location.href).pathname;
  const skillsRoot = currentPath.replace(/\/skills\/[^/]+\/(?:index\.html)?$/, '/skills/');
  return listing.href || `${skillsRoot}${encodeURIComponent(listing.id)}/` || config.marketUrl;
}

function renderRelated(related) {
  const listings = (Array.isArray(related) ? related : []).filter(item => item && item.id);
  elements.related.hidden = listings.length === 0;
  elements.relatedList.replaceChildren(...listings.map(listing => {
    const link = document.createElement('a');
    link.className = 'related-item';
    link.href = relatedHref(listing);
    link.append(
      text('span', categoryLabel(listing.catalog?.category), 'tag'),
      text('h3', listing.localization?.titleZh || listing.name || '未命名技能'),
      text('p', listing.localization?.descriptionZh || listing.description || '暂无中文说明'),
      text('span', '查看详情', 'related-action mono'),
    );
    return link;
  }));
}

function normalizePayload(payload) {
  const listing = payload?.listing || payload?.skill || (payload?.id ? payload : null);
  const related = payload?.relatedListings || payload?.relatedSkills || payload?.related || [];
  return { listing, related };
}

function render(payload) {
  const { listing, related } = normalizePayload(payload);
  if (!listing?.id) throw new Error('详情数据缺少已批准 listing');
  renderHero(listing);
  renderFit(listing);
  const projection = operationsProjection(payload);
  renderRouting(listing, projection);
  renderComposition(projection);
  renderSms(listing);
  renderEval(listing);
  renderProvenance(listing);
  renderGovernance(listing);
  renderPackage(listing);
  renderRelated(related);
  elements.loading.hidden = true;
  elements.error.hidden = true;
  elements.content.hidden = false;
}

function showError(error) {
  elements.loading.hidden = true;
  elements.content.hidden = true;
  elements.error.hidden = false;
  elements.errorMessage.textContent = error instanceof Error ? visibleString(error.message) : '请返回能力市场后重新进入。';
}

async function load() {
  const config = readConfig();
  for (const link of elements.marketLinks) link.href = config.marketUrl;
  if (!config.listingUrl) {
    showError(new Error('页面缺少详情数据地址。'));
    return;
  }
  try {
    const response = await fetch(config.listingUrl, { cache: 'no-store' });
    if (!response.ok) throw new Error(`详情数据读取失败: HTTP ${response.status}`);
    const payload = await response.json();
    render(payload);
  } catch (error) {
    showError(error);
  }
}

load();

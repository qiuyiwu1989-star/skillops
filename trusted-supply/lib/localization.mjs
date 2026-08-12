const TITLE_PHRASES = new Map([
  ['humanizer', '文本去 AI 味'],
  ['interactive-architecture-diagram', '交互式架构图'],
  ['chinese-official-writing', '中文公文写作'],
  ['brief-writer', '简报写作'],
  ['market-research', '市场研究'],
  ['release-checklist', '发布检查清单'],
  ['summarize-notes', '笔记总结'],
  ['customer-brief', '客户简报'],
]);

const TITLE_TOKENS = new Map([
  ['ai', 'AI'], ['architecture', '架构'], ['assistant', '助手'], ['brief', '简报'],
  ['chinese', '中文'], ['content', '内容'], ['customer', '客户'], ['data', '数据'],
  ['diagram', '图'], ['document', '文档'], ['extractor', '提取'], ['financial', '金融'],
  ['guide', '指南'], ['image', '图像'], ['interactive', '交互式'], ['knowledge', '知识'],
  ['market', '市场'], ['notes', '笔记'], ['official', '公文'], ['pdf', 'PDF'],
  ['research', '研究'], ['researcher', '研究助手'], ['skill', '技能'], ['stock', '股票'],
  ['summarize', '总结'], ['text', '文本'], ['translator', '翻译'], ['writer', '写作'],
  ['writing', '写作'],
]);

const CATEGORY_LABELS = new Map([
  ['content-creation', '内容创作'], ['data-analysis', '数据分析'], ['design-media', '设计与媒体'],
  ['dev-programming', '开发编程'], ['knowledge-management', '知识管理'],
  ['office-efficiency', '办公效率'], ['professional', '专业服务'],
]);

export function containsChinese(value) {
  return /[\u3400-\u9fff]/u.test(String(value || ''));
}

function clean(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function firstChinese(values) {
  return values.map(clean).find(value => value && containsChinese(value)) || '';
}

function translateTitleTokens(value) {
  const normalized = clean(value).toLowerCase().replace(/[\s_]+/g, '-');
  if (TITLE_PHRASES.has(normalized)) return TITLE_PHRASES.get(normalized);
  const tokens = normalized.split('-').filter(Boolean);
  if (!tokens.length || tokens.some(token => !TITLE_TOKENS.has(token))) return '';
  return tokens.map(token => TITLE_TOKENS.get(token)).join('');
}

function categoryLabel(category) {
  return CATEGORY_LABELS.get(clean(category)) || '通用能力';
}

export function localizeCandidateMetadata(candidate) {
  const format = candidate?.audit?.format || {};
  const frontmatter = format.frontmatter || {};
  const catalog = candidate?.catalog || {};
  const originalName = clean(format.name) || clean(catalog.coordinate) || 'skill';
  const originalDescription = clean(format.description);

  const nativeTitle = firstChinese([
    catalog.titleZh, catalog.nameZh, catalog.displayNameZh,
    frontmatter.name_zh, frontmatter.title_zh, frontmatter.displayName,
    frontmatter.display_name, originalName,
  ]);
  const translatedTitle = nativeTitle || translateTitleTokens(originalName);
  const titleZh = translatedTitle || `${categoryLabel(catalog.category)}技能`;

  const nativeDescription = firstChinese([
    catalog.summaryZh, catalog.descriptionZh,
    frontmatter.description_zh, frontmatter.summary_zh, frontmatter.summary,
    originalDescription,
  ]);
  const descriptionZh = nativeDescription || `这是一个用于${categoryLabel(catalog.category)}场景的外部技能。自动中文摘要尚待人工校对，请结合原始说明、来源与评估证据判断是否适用。`;

  const titleMethod = nativeTitle ? 'source_metadata' : translatedTitle ? 'deterministic_glossary' : 'category_fallback';
  const descriptionMethod = nativeDescription ? 'source_metadata' : 'category_fallback';
  return {
    locale: 'zh-CN',
    titleZh,
    descriptionZh,
    originalName,
    originalDescription,
    status: titleMethod === 'source_metadata' && descriptionMethod === 'source_metadata' ? 'native' : 'auto_translated',
    titleMethod,
    descriptionMethod,
    reviewStatus: 'unreviewed',
  };
}

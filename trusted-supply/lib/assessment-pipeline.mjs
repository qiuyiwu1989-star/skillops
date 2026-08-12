import { SMS_DIMENSIONS } from './sms.mjs';

const HEADING = /^#{1,6}\s+(.+)$/gm;
const TRIGGERS = /触发|when to use|使用场景|适用场景|关键词/gi;
const STEPS = /步骤|流程|workflow|phase|step\s*\d|执行顺序/gi;
const CHECKS = /检查|自检|校验|验收|质量|checklist|测试/gi;
const BOUNDARIES = /边界|限制|禁止|不得|安全|不适用|风险/gi;
const COMPOSITION = /其他技能|skills?|references\/|scripts\/|配合|组合|调用/gi;

function count(text, pattern) {
  return [...String(text).matchAll(pattern)].length;
}

function clamp(value, minimum = 0, maximum = 10) {
  return Math.max(minimum, Math.min(maximum, Math.round(value)));
}

function evidence(label, value) {
  return `${label}:${value}`;
}

export function extractSmsSignals(candidate) {
  const content = String(candidate?.artifact?.content || '');
  const format = candidate?.audit?.format || {};
  const headings = [...content.matchAll(HEADING)].map(match => match[1].trim());
  const words = content.trim().split(/\s+/).filter(Boolean).length;
  return {
    contentChars: content.length,
    words,
    headings: headings.length,
    triggerSignals: count(content, TRIGGERS),
    stepSignals: count(content, STEPS),
    checkSignals: count(content, CHECKS),
    boundarySignals: count(content, BOUNDARIES),
    compositionSignals: count(content, COMPOSITION),
    examples: count(content, /示例|example/gi),
    codeBlocks: count(content, /```/g) / 2,
    lists: count(content, /^\s*(?:[-*]|\d+[.)])\s+/gm),
    tables: count(content, /^\|.+\|$/gm),
    hasName: Boolean(format.name),
    hasDescription: Boolean(format.description),
    securityStatus: candidate?.audit?.security?.status || 'unknown',
    licenseStatus: candidate?.audit?.license?.status || 'unknown',
    sourceSigned: candidate?.source?.integrity?.signed === true,
  };
}

function dimension(key, score, reason, facts) {
  return { key, score: clamp(score), reason, evidence: facts };
}

export function createHeuristicSmsDraft(candidate, { scorer = 'skillops:heuristic-preassessment' } = {}) {
  if (!candidate?.artifact?.fingerprint) throw new TypeError('candidate fingerprint is required');
  if (!candidate.audit || candidate.audit.basedOnFingerprint !== candidate.artifact.fingerprint) {
    throw new TypeError('candidate must have a current audit before SMS pre-assessment');
  }
  const s = extractSmsSignals(candidate);
  const complexityPenalty = s.contentChars > 18_000 ? 2 : s.contentChars > 12_000 ? 1 : 0;
  const safetyBase = s.securityStatus === 'pass' ? 8 : s.securityStatus === 'review' ? 5 : 0;
  const scores = {
    clarity: 5 + Number(s.hasName) + Number(s.hasDescription) + Math.min(2, s.headings / 5) - complexityPenalty,
    invocability: 4 + Math.min(4, s.triggerSignals) + Number(s.hasDescription),
    executability: 4 + Math.min(4, s.stepSignals / 2) + Math.min(1, s.codeBlocks),
    stability: 4 + Math.min(3, s.checkSignals / 3) + Math.min(1, s.examples),
    quality: 4 + Math.min(3, s.checkSignals / 2) + Math.min(2, s.examples),
    reusability: 5 + Math.min(2, s.headings / 8) + Math.min(2, s.examples),
    composability: 4 + Math.min(4, s.compositionSignals / 3),
    evaluability: 3 + Math.min(4, s.checkSignals / 2) + Math.min(2, s.examples),
    safety: safetyBase + Math.min(2, s.boundarySignals / 5),
    business: 5 + Math.min(3, s.triggerSignals / 2) + Math.min(1, s.examples),
  };
  const facts = {
    clarity: [evidence('frontmatter', `${s.hasName && s.hasDescription ? 'name+description' : 'incomplete'}`), evidence('headings', s.headings)],
    invocability: [evidence('trigger_signals', s.triggerSignals), evidence('description', s.hasDescription)],
    executability: [evidence('step_signals', s.stepSignals), evidence('code_blocks', s.codeBlocks)],
    stability: [evidence('check_signals', s.checkSignals), evidence('examples', s.examples)],
    quality: [evidence('quality_signals', s.checkSignals), evidence('tables', s.tables)],
    reusability: [evidence('content_chars', s.contentChars), evidence('sections', s.headings)],
    composability: [evidence('composition_signals', s.compositionSignals), evidence('code_blocks', s.codeBlocks)],
    evaluability: [evidence('check_signals', s.checkSignals), evidence('examples', s.examples)],
    safety: [evidence('security_scan', s.securityStatus), evidence('boundary_signals', s.boundarySignals)],
    business: [evidence('trigger_signals', s.triggerSignals), evidence('examples', s.examples)],
  };
  const reasons = {
    clarity: '结构与元数据的可理解程度由静态信号预评估。', invocability: '依据触发条件和任务描述信号预评估。',
    executability: '依据步骤、流程和命令示例信号预评估。', stability: '依据检查项和示例覆盖预评估。',
    quality: '依据质量门、检查项和结构化材料预评估。', reusability: '依据模块化结构与示例复用信号预评估。',
    composability: '依据外部资源、脚本和技能组合信号预评估。', evaluability: '依据验收、自检和示例信号预评估。',
    safety: '依据可信供应链安全扫描和边界声明预评估。', business: '依据明确场景、触发范围和交付示例预评估。',
  };
  return {
    schemaVersion: 1,
    kind: 'sms_preassessment',
    rubricVersion: 'SMS-2.0',
    basedOnFingerprint: candidate.artifact.fingerprint,
    scorer,
    generatedAt: new Date().toISOString(),
    dimensions: SMS_DIMENSIONS.map(({ key }) => dimension(key, scores[key], reasons[key], facts[key])),
    signals: s,
    limitations: [
      '静态启发式预评估不运行技能，不能替代 Eval。',
      '所有分值、理由与证据必须由有名称的复核者确认或修改后才能导入 SMS。',
    ],
  };
}

export function confirmSmsDraft(draft, { scorer }) {
  if (draft?.kind !== 'sms_preassessment') throw new TypeError('SMS pre-assessment draft is required');
  if (!scorer || !String(scorer).trim()) throw new TypeError('named scorer is required');
  return {
    dimensions: draft.dimensions,
    scorer: String(scorer).trim(),
    basedOnFingerprint: draft.basedOnFingerprint,
  };
}

import assert from 'node:assert/strict';
import test from 'node:test';

import { localizeCandidateMetadata } from '../lib/localization.mjs';

function candidate({ name, description, frontmatter = {}, catalog = {} }) {
  return { audit: { format: { name, description, frontmatter } }, catalog };
}

test('prefers Chinese source metadata while preserving original fields', () => {
  const localized = localizeCandidateMetadata(candidate({
    name: 'interactive-architecture-diagram',
    description: 'Architecture diagram generator.',
    frontmatter: { displayName: '架构图一键生成', summary: '把复杂信息转换成清晰架构图。' },
    catalog: { category: 'design-media' },
  }));
  assert.equal(localized.titleZh, '架构图一键生成');
  assert.equal(localized.descriptionZh, '把复杂信息转换成清晰架构图。');
  assert.equal(localized.originalName, 'interactive-architecture-diagram');
  assert.equal(localized.status, 'native');
});

test('automatically translates known English titles and keeps Chinese descriptions', () => {
  const localized = localizeCandidateMetadata(candidate({
    name: 'chinese-official-writing',
    description: '用于中文公文起草、改写与复核。',
    catalog: { category: 'office-efficiency' },
  }));
  assert.equal(localized.titleZh, '中文公文写作');
  assert.equal(localized.descriptionZh, '用于中文公文起草、改写与复核。');
  assert.equal(localized.status, 'auto_translated');
  assert.equal(localized.reviewStatus, 'unreviewed');
});

test('unknown English metadata fails soft to an honest Chinese category summary', () => {
  const localized = localizeCandidateMetadata(candidate({
    name: 'mysterious-xyz', description: 'Does something.', catalog: { category: 'professional' },
  }));
  assert.equal(localized.titleZh, '专业服务技能');
  assert.match(localized.descriptionZh, /自动中文摘要尚待人工校对/);
  assert.equal(localized.originalDescription, 'Does something.');
});

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  SAFE_SKILL_DOCUMENT_LIMITS,
  auditSkillFormat,
  parseSafeSkillDocument,
} from '../lib/skill-document.mjs';

const skillHubLike = `---
name: research-brief
description: >-
  Research a supplied topic and produce a concise,
  evidence-linked decision brief.
license: Apache-2.0
allowed-tools:
  - Read
  - WebSearch
metadata:
  author: community-lab
  categories: [research, writing]
  compatibility:
    clients:
      - claude-code
      - codex
---

# Research brief

Use supplied evidence and clearly label uncertainty.
`;

test('parses a minimal redacted SkillHub-style YAML frontmatter safely', () => {
  const parsed = parseSafeSkillDocument(skillHubLike);
  assert.deepEqual(parsed.errors, []);
  assert.equal(parsed.frontmatter.name, 'research-brief');
  assert.equal(parsed.frontmatter.description, 'Research a supplied topic and produce a concise, evidence-linked decision brief.');
  assert.equal(parsed.frontmatter.license, 'Apache-2.0');
  assert.deepEqual(parsed.frontmatter['allowed-tools'], ['Read', 'WebSearch']);
  assert.deepEqual(parsed.frontmatter.metadata.categories, ['research', 'writing']);
  assert.deepEqual(parsed.frontmatter.metadata.compatibility.clients, ['claude-code', 'codex']);
  assert.equal(Object.getPrototypeOf(parsed.frontmatter), null);
  assert.match(parsed.body, /# Research brief/);
});

test('supports literal blocks, folded blocks, quoted scalars, comments, and finite flow mappings', () => {
  const parsed = parseSafeSkillDocument(`---
name: "quoted: skill"
description: |
  First line.
  Second line.
license: 'MIT'
metadata: {owner: "team #1", stable: true, priority: 2}
tags: ["a,b", plain] # safe comment
---
Body
`);
  assert.deepEqual(parsed.errors, []);
  assert.equal(parsed.frontmatter.name, 'quoted: skill');
  assert.equal(parsed.frontmatter.description, 'First line.\nSecond line.\n');
  assert.equal(parsed.frontmatter.license, 'MIT');
  assert.equal(parsed.frontmatter.metadata.owner, 'team #1');
  assert.equal(parsed.frontmatter.metadata.stable, true);
  assert.deepEqual(parsed.frontmatter.tags, ['a,b', 'plain']);
});

test('supports redacted real-world JSON-style metadata and wrapped flow lists', () => {
  const parsed = parseSafeSkillDocument(`---
name: data-research
description: |
  Collect structured public data and produce a sourced report.
metadata: { "client": { "emoji": "📊", "requires": { "bins": ["node"] } } }
auto_trigger:
  keywords: [public data, annual report, policy update,
    market research, risk metric]
  patterns:
    - "(search|collect)\\\\s*(report|data)"
---
Body
`);
  assert.deepEqual(parsed.errors, []);
  assert.equal(parsed.frontmatter.metadata.client.emoji, '📊');
  assert.deepEqual(parsed.frontmatter.metadata.client.requires.bins, ['node']);
  assert.deepEqual(parsed.frontmatter.auto_trigger.keywords, [
    'public data', 'annual report', 'policy update', 'market research', 'risk metric',
  ]);
  assert.equal(parsed.frontmatter.auto_trigger.patterns[0], '(search|collect)\\s*(report|data)');
});

test('format audit extracts only safe root name, description, and license scalars', () => {
  const audit = auditSkillFormat(skillHubLike);
  assert.equal(audit.status, 'pass');
  assert.equal(audit.name, 'research-brief');
  assert.match(audit.description, /evidence-linked/);
  assert.equal(audit.license, 'Apache-2.0');
  const invalid = auditSkillFormat(`---\nname: [not, scalar]\ndescription: false\n---\nBody\n`);
  assert.equal(invalid.status, 'fail');
  assert.ok(invalid.issues.includes('missing_name'));
  assert.ok(invalid.issues.includes('missing_description'));
});

for (const [label, yaml, expected] of [
  ['tag', 'name: !!js/function function() {}', 'yaml_tag_anchor_or_alias_forbidden'],
  ['custom tag', 'name: !ruby/object:Kernel {}', 'yaml_tag_anchor_or_alias_forbidden'],
  ['anchor', 'name: &shared safe-name', 'yaml_tag_anchor_or_alias_forbidden'],
  ['alias', 'name: *shared', 'yaml_tag_anchor_or_alias_forbidden'],
  ['merge key', '<<: {name: injected}', 'unsafe_or_invalid_key'],
  ['tab indentation', 'name: safe\n\tdescription: unsafe', 'tab_indentation_forbidden'],
  ['prototype pollution', '__proto__: polluted', 'unsafe_object_key'],
  ['duplicate key', 'name: one\nname: two', 'duplicate_key'],
]) {
  test(`fails closed on YAML ${label}`, () => {
    const parsed = parseSafeSkillDocument(`---\n${yaml}\n---\nBody\n`);
    assert.ok(parsed.errors.some(error => error.startsWith(expected)), parsed.errors.join(', '));
    assert.equal(Object.hasOwn(parsed.frontmatter, 'name'), false, 'a rejected document exposes no partial metadata');
  });
}

test('fails closed on excessive nesting, node count, header size, and block size', () => {
  const deep = parseSafeSkillDocument(`---
name: deep
description: safe
a:
  b:
    c:
      d:
        e:
          f:
            g: too-deep
---
Body
`);
  assert.ok(deep.errors.some(error => error.startsWith('yaml_depth_limit_exceeded')));

  const nodes = Array.from({ length: SAFE_SKILL_DOCUMENT_LIMITS.maxNodes + 1 }, (_, index) => `key${index}: value`).join('\n');
  assert.ok(parseSafeSkillDocument(`---\n${nodes}\n---\nBody`).errors.some(error => error.startsWith('yaml_node_limit_exceeded')));

  const oversizedHeader = `name: x\ndescription: ${'x'.repeat(SAFE_SKILL_DOCUMENT_LIMITS.maxHeaderBytes)}`;
  assert.deepEqual(parseSafeSkillDocument(`---\n${oversizedHeader}\n---\nBody`).errors, ['yaml_header_limit_exceeded']);

  const block = `description: |\n  ${'x'.repeat(SAFE_SKILL_DOCUMENT_LIMITS.maxBlockBytes + 1)}`;
  assert.ok(parseSafeSkillDocument(`---\nname: x\n${block}\n---\nBody`).errors.some(error => error.startsWith('yaml_block_limit_exceeded')));
});

test('does not interpret code-like scalars or mutate Object.prototype', () => {
  delete Object.prototype.skillopsPolluted;
  const parsed = parseSafeSkillDocument(`---
name: harmless
description: "process.exit(1); globalThis.skillopsPolluted = true"
metadata:
  command: "$(touch /tmp/never-run)"
---
Body
`);
  assert.deepEqual(parsed.errors, []);
  assert.equal(parsed.frontmatter.description, 'process.exit(1); globalThis.skillopsPolluted = true');
  assert.equal(parsed.frontmatter.metadata.command, '$(touch /tmp/never-run)');
  assert.equal(Object.prototype.skillopsPolluted, undefined);
});

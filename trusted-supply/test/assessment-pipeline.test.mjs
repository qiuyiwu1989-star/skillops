import assert from 'node:assert/strict';
import test from 'node:test';

import { applyAudit, createCandidate } from '../lib/candidate.mjs';
import { confirmSmsDraft, createHeuristicSmsDraft } from '../lib/assessment-pipeline.mjs';

const CONTENT = `---\nname: brief-writer\ndescription: Draft a brief when the user asks for one.\n---\n\n# Workflow\n1. Confirm the audience.\n2. Draft the brief.\n## Quality checks\n- Check facts.\n- Do not invent details.\n## Example\nUse the supplied notes.\n`;

function audited() {
  return applyAudit(createCandidate({
    source: { kind: 'fixture', url: 'https://example.test/brief', path: 'SKILL.md', commit: 'abc' },
    content: CONTENT,
  }));
}

test('heuristic pipeline produces an evidence-backed draft, never a complete SMS assessment', () => {
  const draft = createHeuristicSmsDraft(audited());
  assert.equal(draft.kind, 'sms_preassessment');
  assert.equal(draft.dimensions.length, 10);
  assert.ok(draft.dimensions.every(item => item.evidence.length >= 1));
  assert.equal(Object.hasOwn(draft, 'status'), false);
  assert.match(draft.limitations.join(' '), /不能替代 Eval/);
});

test('a named reviewer must explicitly confirm a current draft before import', () => {
  const draft = createHeuristicSmsDraft(audited());
  assert.throws(() => confirmSmsDraft(draft, {}), /scorer/i);
  const confirmed = confirmSmsDraft(draft, { scorer: 'agent-assisted-review:codex' });
  assert.equal(confirmed.scorer, 'agent-assisted-review:codex');
  assert.equal(confirmed.basedOnFingerprint, draft.basedOnFingerprint);
});

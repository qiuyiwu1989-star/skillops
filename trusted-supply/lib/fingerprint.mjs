import crypto from 'node:crypto';

export function normalizeContent(content) {
  return String(content ?? '').replace(/\r\n?/g, '\n').replace(/[ \t]+$/gm, '').trimEnd() + '\n';
}

export function contentFingerprint(content) {
  return `sha256:${crypto.createHash('sha256').update(normalizeContent(content), 'utf8').digest('hex')}`;
}

export function sourceIdentity(source = {}) {
  const kind = String(source.kind || source.type || 'unknown').toLowerCase();
  const repo = String(source.repo || source.url || '').trim();
  const filePath = String(source.path || '').replace(/^\.\//, '');
  return `${kind}:${repo}:${filePath}`;
}

export function candidateId(source) {
  return `cand_${crypto.createHash('sha256').update(sourceIdentity(source)).digest('hex').slice(0, 20)}`;
}

export function sourceVersionIdentity(source = {}, fingerprint = '') {
  return `${sourceIdentity(source)}@${String(source.commit || 'unversioned')}:${fingerprint}`;
}

import { contentFingerprint } from './fingerprint.mjs';

const ALLOWED_LICENSES = new Set([
  '0BSD', 'AFL-3.0', 'Apache-2.0', 'Artistic-2.0', 'BSD-2-Clause',
  'BSD-3-Clause', 'BSL-1.0', 'CC-BY-4.0', 'CC-BY-SA-4.0', 'CC0-1.0',
  'ISC', 'MIT', 'Unlicense', 'WTFPL', 'Zlib',
]);

const COPYLEFT_LICENSES = new Set([
  'AGPL-3.0', 'EPL-2.0', 'GPL-2.0', 'GPL-3.0', 'LGPL-2.1', 'LGPL-3.0', 'MPL-2.0',
]);

function cleanScalar(value) {
  const text = String(value ?? '').trim();
  if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) {
    return text.slice(1, -1);
  }
  return text;
}

export function parseSkillDocument(content) {
  const text = String(content ?? '').replace(/\r\n?/g, '\n');
  const result = { frontmatter: {}, body: text, errors: [] };
  if (!text.startsWith('---\n')) {
    result.errors.push('missing_frontmatter');
    return result;
  }
  const end = text.indexOf('\n---\n', 4);
  if (end < 0) {
    result.errors.push('unclosed_frontmatter');
    return result;
  }
  const header = text.slice(4, end);
  result.body = text.slice(end + 5);
  for (const rawLine of header.split('\n')) {
    if (!rawLine.trim() || /^\s*#/.test(rawLine)) continue;
    const match = rawLine.match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
    if (!match) {
      result.errors.push(`invalid_frontmatter_line:${rawLine.trim().slice(0, 80)}`);
      continue;
    }
    result.frontmatter[match[1]] = cleanScalar(match[2]);
  }
  return result;
}

export function auditFormat(content) {
  const parsed = parseSkillDocument(content);
  const issues = [...parsed.errors];
  const name = cleanScalar(parsed.frontmatter.name);
  const description = cleanScalar(parsed.frontmatter.description);
  if (!name) issues.push('missing_name');
  if (!description) issues.push('missing_description');
  if (!parsed.body.trim()) issues.push('empty_body');
  return {
    status: issues.length ? 'fail' : 'pass',
    name,
    description,
    frontmatter: parsed.frontmatter,
    issues,
  };
}

export function classifyLicense(input) {
  const raw = String(input ?? '').trim();
  if (!raw || /^(unknown|noassertion|none|n\/a)$/i.test(raw)) {
    return { status: 'index_only', spdx: null, reason: 'license_missing_or_unclear', redistributable: false };
  }
  if (/all rights reserved|proprietary|no redistribution|不得转载|禁止转载/i.test(raw)) {
    return { status: 'blocked', spdx: null, reason: 'redistribution_prohibited', redistributable: false };
  }
  let spdx = [...ALLOWED_LICENSES].find(value => value.toLowerCase() === raw.toLowerCase());
  const copyleft = [...COPYLEFT_LICENSES].find(value => value.toLowerCase() === raw.toLowerCase());
  if (copyleft) {
    return { status: 'index_only', spdx: copyleft, reason: 'copyleft_obligations_not_implemented', redistributable: false };
  }
  if (!spdx && /permission is hereby granted, free of charge/i.test(raw)) spdx = 'MIT';
  if (!spdx && /apache license\s+version 2\.0/i.test(raw)) spdx = 'Apache-2.0';
  if (!spdx && /creative commons attribution 4\.0/i.test(raw)) spdx = 'CC-BY-4.0';
  if (spdx) return { status: 'allowed', spdx, reason: 'recognized_spdx', redistributable: true };
  return { status: 'index_only', spdx: raw, reason: 'license_unrecognized', redistributable: false };
}

const SECURITY_RULES = [
  { id: 'remote_pipe_shell', severity: 'block', pattern: /(?:curl|wget)\b[^\n|]{0,500}\|\s*(?:ba)?sh\b/gi },
  { id: 'remote_code_execution', severity: 'block', pattern: /(?:eval|exec)\s*[(`][^\n]{0,300}(?:curl|wget|https?:\/\/)/gi },
  { id: 'credential_exfiltration', severity: 'block', pattern: /(?:(?:curl|wget|fetch|requests?\.(?:post|get))[^\n]{0,500}(?:process\.env|os\.environ|\.ssh|credentials?|api[_-]?keys?|secrets?|tokens?)|(?:\benv\b|process\.env|os\.environ|cat\s+(?:~\/)?\.env)[^\n|]{0,200}\|[^\n]{0,200}(?:curl|wget))/gi },
  { id: 'destructive_delete', severity: 'block', pattern: /\brm\s+-[a-z]*r[a-z]*f[a-z]*\s+(?:\/|~|\$HOME|\$\{HOME\})(?=\s|[;`'"\\]|$)/gi },
  { id: 'privilege_escalation', severity: 'review', pattern: /\bsudo\b|chmod\s+(?:777|[ugo]*\+s)\b/gi },
  { id: 'sensitive_file_access', severity: 'review', pattern: /(?:~\/\.ssh|\/etc\/(?:shadow|passwd)|\.env\b)/gi },
  { id: 'prompt_instruction_override', severity: 'review', pattern: /ignore\s+(?:all\s+)?previous\s+instructions|忽略(?:以上|此前|所有)指令/gi },
];

export function scanSecurity(content) {
  const text = String(content ?? '');
  const findings = [];
  for (const rule of SECURITY_RULES) {
    rule.pattern.lastIndex = 0;
    let match;
    while ((match = rule.pattern.exec(text)) !== null) {
      findings.push({
        rule: rule.id,
        severity: rule.severity,
        excerpt: match[0].replace(/\s+/g, ' ').slice(0, 160),
        offset: match.index,
      });
      if (findings.length >= 50) break;
      if (match[0].length === 0) rule.pattern.lastIndex++;
    }
  }
  const status = findings.some(f => f.severity === 'block')
    ? 'block'
    : findings.some(f => f.severity === 'review') ? 'review' : 'pass';
  return { status, findings };
}

export function auditProvenance(candidate) {
  const source = candidate?.source || {};
  const issues = [];
  if (!source.kind && !source.type) issues.push('missing_source_kind');
  if (!source.url && !source.repo) issues.push('missing_source_location');
  if (!source.path) issues.push('missing_source_path');
  if (!source.commit) issues.push('missing_source_commit');
  if (!candidate?.artifact?.fingerprint) issues.push('missing_content_fingerprint');
  else if (contentFingerprint(candidate?.artifact?.content || '') !== candidate.artifact.fingerprint) issues.push('content_fingerprint_mismatch');
  return { status: issues.length ? 'fail' : 'pass', issues };
}

function normalizeSms(sms) {
  if (!sms || sms.status === 'pending' || sms.total == null) return { status: 'pending' };
  const total = Number(sms.total);
  if (!Number.isFinite(total)) return { status: 'pending' };
  return { ...sms, status: 'complete', total };
}

export function auditCandidate(candidate, { smsThreshold = 64 } = {}) {
  const format = auditFormat(candidate?.artifact?.content || '');
  const provenance = auditProvenance(candidate);
  const license = classifyLicense(candidate?.artifact?.license ?? candidate?.source?.license);
  const security = scanSecurity(candidate?.artifact?.content || '');
  const sms = normalizeSms(candidate?.sms);
  const hardBlocks = [];
  if (format.status !== 'pass') hardBlocks.push('format');
  if (provenance.status !== 'pass') hardBlocks.push('provenance');
  if (license.status === 'blocked') hardBlocks.push('license');
  if (security.status === 'block') hardBlocks.push('security');
  const smsMeetsThreshold = sms.status === 'complete' && sms.total >= smsThreshold;
  return {
    checkedAt: new Date().toISOString(),
    basedOnFingerprint: candidate?.artifact?.fingerprint || null,
    format,
    provenance,
    license,
    security,
    sms,
    smsThreshold,
    smsMeetsThreshold,
    hardBlocks,
    eligibleForReview: hardBlocks.length === 0,
  };
}

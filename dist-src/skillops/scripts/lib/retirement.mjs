/* retirement.mjs — 技能退役的纯本地、可恢复台账
 *
 * 退役不等于 Release 撤回或吊销，也不会删除、移动、下载或执行技能文件。
 * 本模块只生成依赖感知的计划，并把确认后的退役/恢复动作追加到本地 JSON 台账。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const RETIREMENT_SCHEMA_VERSION = 1;

const SKILL_ID = /^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?\/[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/;
const RELEASE_ID = /^rel_[a-f0-9]{64}$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const SAFE_REF = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const DEPENDENCY_KINDS = ['deployments', 'compositions', 'projects', 'organizationRefs'];
const DEPENDENCY_STATUSES = new Set(['clear', 'blocking', 'unknown']);
const PRIVATE_TEXT = /(?:https?:\/\/|file:\/\/|(?:^|\s)(?:\/Users\/|\/home\/|[A-Za-z]:[\\/])|[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,})/i;

export class RetirementError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'RetirementError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new RetirementError(code, message);
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  }
  return typeof value === 'string' ? value.normalize('NFC') : value;
}

function digest(value) {
  return `sha256:${crypto.createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex')}`;
}

function timestamp(value, label) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) fail('INVALID_TIMESTAMP', `${label} 必须是有效时间`);
  return date.toISOString();
}

function nowValue(now) {
  return timestamp(typeof now === 'function' ? now() : (now ?? new Date()), 'now');
}

function match(value, pattern, label) {
  if (typeof value !== 'string' || !pattern.test(value)) fail('INVALID_IDENTITY', `${label} 格式无效`);
  return value.normalize('NFC');
}

function safeText(value, label, { max = 500 } = {}) {
  if (typeof value !== 'string' || !value.trim()) fail('INVALID_INPUT', `${label} 必须是非空字符串`);
  const normalized = value.trim().normalize('NFC');
  if (normalized.length > max) fail('INVALID_INPUT', `${label} 过长`);
  if (PRIVATE_TEXT.test(normalized)) fail('PRIVATE_VALUE_FORBIDDEN', `${label} 不得包含路径、网址、邮箱或身份详情`);
  return normalized;
}

function exactKeys(value, allowed, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('INVALID_INPUT', `${label} 必须是对象`);
  const unknown = Object.keys(value).filter(key => !allowed.has(key));
  if (unknown.length) fail('PRIVATE_FIELD_FORBIDDEN', `${label} 不允许字段：${unknown.join(', ')}`);
}

function normalizeDependencyEntry(input, label) {
  if (typeof input === 'string') return { ref: match(input, SAFE_REF, `${label}.ref`), status: 'clear' };
  exactKeys(input, new Set(['ref', 'status']), label);
  const status = input.status ?? 'clear';
  if (!DEPENDENCY_STATUSES.has(status)) fail('INVALID_DEPENDENCY_STATUS', `${label}.status 不受支持`);
  return { ref: match(input.ref, SAFE_REF, `${label}.ref`), status };
}

function normalizeDependencyKind(value, kind) {
  if (value === undefined || value === null || value === 'unknown') return { known: false, items: [] };
  if (!Array.isArray(value)) {
    exactKeys(value, new Set(['status']), `dependencies.${kind}`);
    if (value.status !== 'unknown') fail('INVALID_DEPENDENCIES', `dependencies.${kind} 只允许数组或 unknown`);
    return { known: false, items: [] };
  }
  const items = value.map((item, index) => normalizeDependencyEntry(item, `dependencies.${kind}[${index}]`))
    .sort((a, b) => a.ref.localeCompare(b.ref, 'en'));
  if (new Set(items.map(item => item.ref)).size !== items.length) fail('DUPLICATE_DEPENDENCY', `dependencies.${kind} 包含重复引用`);
  return { known: true, items };
}

function normalizeDependencies(input) {
  if (input === undefined || input === null) input = {};
  exactKeys(input, new Set(DEPENDENCY_KINDS), 'dependencies');
  return Object.fromEntries(DEPENDENCY_KINDS.map(kind => [kind, normalizeDependencyKind(input[kind], kind)]));
}

function retirementReasons(dependencies) {
  const reasons = [];
  for (const kind of DEPENDENCY_KINDS) {
    const group = dependencies[kind];
    if (!group.known) {
      reasons.push({ code: 'DEPENDENCY_SCOPE_UNKNOWN', blocking: true, dependencyKind: kind, messageZh: `${kind} 依赖范围尚未明确` });
      continue;
    }
    for (const item of group.items) {
      if (item.status === 'unknown') reasons.push({ code: 'DEPENDENCY_STATE_UNKNOWN', blocking: true, dependencyKind: kind, ref: item.ref, messageZh: '依赖状态未知' });
      if (item.status === 'blocking') reasons.push({ code: 'ACTIVE_DEPENDENCY_BLOCKS_RETIREMENT', blocking: true, dependencyKind: kind, ref: item.ref, messageZh: '仍有活动依赖阻止退役' });
    }
  }
  if (!reasons.length) reasons.push({ code: 'DEPENDENCIES_CLEARED', blocking: false, messageZh: '四类依赖已明确且无阻塞项' });
  return reasons;
}

function normalizeReleaseIds(input) {
  if (!Array.isArray(input) || input.length < 1) fail('RELEASES_REQUIRED', 'releaseIds 必须明确列出至少一个 Release');
  const values = input.map((value, index) => match(value, RELEASE_ID, `releaseIds[${index}]`)).sort();
  if (new Set(values).size !== values.length) fail('DUPLICATE_RELEASE', 'releaseIds 不得重复');
  return values;
}

function planBody(input, analyzedAt) {
  exactKeys(input, new Set(['skillId', 'releaseIds', 'dependencies', 'replacementSkillId', 'reason']), 'retirement input');
  const skillId = match(input.skillId, SKILL_ID, 'skillId');
  const replacementSkillId = input.replacementSkillId === undefined || input.replacementSkillId === null
    ? null : match(input.replacementSkillId, SKILL_ID, 'replacementSkillId');
  if (replacementSkillId === skillId) fail('INVALID_REPLACEMENT', 'replacementSkillId 不能与退役技能相同');
  const dependencies = normalizeDependencies(input.dependencies);
  const reasons = retirementReasons(dependencies);
  return {
    schemaVersion: RETIREMENT_SCHEMA_VERSION,
    action: 'skill.retire.plan',
    status: reasons.some(item => item.blocking) ? 'blocked' : 'ready',
    subject: { skillId, releaseIds: normalizeReleaseIds(input.releaseIds) },
    replacementSkillId,
    reason: safeText(input.reason, 'reason'),
    analyzedAt,
    dependencies,
    reasons,
    lifecycleBoundary: {
      releaseStatusUnchanged: true,
      existingLocks: 'preserved_for_explanation',
      newDeploymentsAfterRetirement: 'blocked',
    },
  };
}

/** 生成退役计划。只有四类依赖全部明确且无阻塞项，才会产生可确认摘要。 */
export function planRetirement(input, { now } = {}) {
  const body = planBody(input, nowValue(now));
  if (body.status === 'blocked') return Object.freeze({ ...body, planDigest: null, requiredConfirmations: [] });
  const planDigest = digest(body);
  return Object.freeze({
    ...body,
    planDigest,
    requiredConfirmations: [{ kind: 'plan_digest', value: planDigest, messageZh: '退役确认必须绑定本计划摘要' }],
  });
}

function validatePlan(input) {
  exactKeys(input, new Set([
    'schemaVersion', 'action', 'status', 'subject', 'replacementSkillId', 'reason', 'analyzedAt',
    'dependencies', 'reasons', 'lifecycleBoundary', 'planDigest', 'requiredConfirmations',
  ]), 'retirement plan');
  if (input.schemaVersion !== RETIREMENT_SCHEMA_VERSION || input.action !== 'skill.retire.plan') fail('INVALID_PLAN', '退役计划版本或动作无效');
  exactKeys(input.subject, new Set(['skillId', 'releaseIds']), 'retirement plan subject');
  const rebuilt = planRetirement({
    skillId: input.subject.skillId,
    releaseIds: input.subject.releaseIds,
    dependencies: Object.fromEntries(DEPENDENCY_KINDS.map(kind => {
      const group = input.dependencies?.[kind];
      return [kind, group?.known ? group.items : { status: 'unknown' }];
    })),
    replacementSkillId: input.replacementSkillId,
    reason: input.reason,
  }, { now: input.analyzedAt });
  if (input.status !== 'ready' || rebuilt.status !== 'ready') fail('PLAN_BLOCKED', '依赖未清除的计划不能执行退役');
  if (input.planDigest !== rebuilt.planDigest || digest({
    schemaVersion: input.schemaVersion,
    action: input.action,
    status: input.status,
    subject: input.subject,
    replacementSkillId: input.replacementSkillId,
    reason: input.reason,
    analyzedAt: input.analyzedAt,
    dependencies: input.dependencies,
    reasons: input.reasons,
    lifecycleBoundary: input.lifecycleBoundary,
  }) !== input.planDigest) fail('PLAN_TAMPERED', '退役计划摘要不一致');
  if (JSON.stringify(input.requiredConfirmations) !== JSON.stringify(rebuilt.requiredConfirmations)) fail('PLAN_TAMPERED', '退役确认要求被修改');
  return rebuilt;
}

function actorDigest(actor) {
  const value = match(actor, SAFE_REF, 'actor');
  return digest({ actor: value });
}

function eventBody(input) {
  return {
    schemaVersion: RETIREMENT_SCHEMA_VERSION,
    type: input.type,
    skillId: input.skillId,
    occurredAt: input.occurredAt,
    actorDigest: input.actorDigest,
    reason: input.reason,
    planDigest: input.planDigest ?? null,
    releaseIds: input.releaseIds ?? [],
    replacementSkillId: input.replacementSkillId ?? null,
    dependenciesDigest: input.dependenciesDigest ?? null,
    previousEventDigest: input.previousEventDigest ?? null,
  };
}

function createEvent(input) {
  const body = eventBody(input);
  const eventDigest = digest(body);
  return Object.freeze({ ...body, eventId: `ret_${eventDigest.slice('sha256:'.length)}`, eventDigest });
}

function validateLedger(input) {
  if (!input || input.schemaVersion !== RETIREMENT_SCHEMA_VERSION || !Array.isArray(input.events)) fail('LEDGER_INVALID', '退役台账格式无效');
  let previous = null;
  const eventIds = new Set();
  const events = input.events.map((raw, index) => {
    exactKeys(raw, new Set([
      'schemaVersion', 'type', 'skillId', 'occurredAt', 'actorDigest', 'reason', 'planDigest', 'releaseIds',
      'replacementSkillId', 'dependenciesDigest', 'previousEventDigest', 'eventId', 'eventDigest',
    ]), `events[${index}]`);
    if (raw.schemaVersion !== RETIREMENT_SCHEMA_VERSION || !['skill.retired', 'skill.restored'].includes(raw.type)) fail('LEDGER_INVALID', '退役事件类型无效');
    match(raw.skillId, SKILL_ID, 'event.skillId');
    timestamp(raw.occurredAt, 'event.occurredAt');
    match(raw.actorDigest, DIGEST, 'event.actorDigest');
    safeText(raw.reason, 'event.reason');
    if (raw.planDigest !== null) match(raw.planDigest, DIGEST, 'event.planDigest');
    normalizeReleaseIds(raw.type === 'skill.retired' ? raw.releaseIds : (raw.releaseIds.length ? raw.releaseIds : [`rel_${'0'.repeat(64)}`]));
    if (raw.type === 'skill.restored' && raw.releaseIds.length) fail('LEDGER_INVALID', '恢复事件不得重写 Release 列表');
    if (raw.replacementSkillId !== null) match(raw.replacementSkillId, SKILL_ID, 'event.replacementSkillId');
    if (raw.dependenciesDigest !== null) match(raw.dependenciesDigest, DIGEST, 'event.dependenciesDigest');
    if (raw.previousEventDigest !== previous) fail('LEDGER_TAMPERED', '退役事件链不连续');
    const calculated = digest(eventBody(raw));
    if (raw.eventDigest !== calculated || raw.eventId !== `ret_${calculated.slice('sha256:'.length)}`) fail('LEDGER_TAMPERED', '退役事件摘要不一致');
    if (eventIds.has(raw.eventId)) fail('LEDGER_INVALID', '退役事件重复');
    eventIds.add(raw.eventId);
    previous = raw.eventDigest;
    return Object.freeze(structuredClone(raw));
  });
  return { schemaVersion: RETIREMENT_SCHEMA_VERSION, events };
}

function atomicWrite(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporary = `${filePath}.${process.pid}.${Date.now()}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    fs.renameSync(temporary, filePath);
  } finally {
    if (fs.existsSync(temporary)) fs.rmSync(temporary, { force: true });
  }
}

function statusFromEvents(events, skillId) {
  const selected = events.filter(event => event.skillId === skillId);
  const latest = selected.at(-1) ?? null;
  if (!latest) return {
    schemaVersion: RETIREMENT_SCHEMA_VERSION, skillId, state: 'active',
    allowsNewDeployments: true, existingLocks: 'preserved_for_explanation', latestEventId: null,
  };
  if (latest.type === 'skill.restored') return {
    schemaVersion: RETIREMENT_SCHEMA_VERSION, skillId, state: 'active_pending_revalidation',
    allowsNewDeployments: false, existingLocks: 'preserved_for_explanation', latestEventId: latest.eventId,
    restoredAt: latest.occurredAt, reason: latest.reason,
  };
  return {
    schemaVersion: RETIREMENT_SCHEMA_VERSION, skillId, state: 'retired',
    allowsNewDeployments: false, existingLocks: 'preserved_for_explanation', latestEventId: latest.eventId,
    retiredAt: latest.occurredAt, reason: latest.reason, releaseIds: [...latest.releaseIds],
    replacementSkillId: latest.replacementSkillId, planDigest: latest.planDigest,
    releaseLifecycle: 'unchanged',
  };
}

export class RetirementStore {
  constructor(filePath) {
    if (typeof filePath !== 'string' || !filePath) fail('LEDGER_PATH_REQUIRED', '缺少退役台账路径');
    this.filePath = path.resolve(filePath);
  }

  read() {
    if (!fs.existsSync(this.filePath)) return { schemaVersion: RETIREMENT_SCHEMA_VERSION, events: [] };
    let parsed;
    try { parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8')); } catch { fail('LEDGER_INVALID', '退役台账不是有效 JSON'); }
    return structuredClone(validateLedger(parsed));
  }

  retire(plan, { confirmPlanDigest, actor, at } = {}) {
    const verified = validatePlan(plan);
    if (confirmPlanDigest !== verified.planDigest) fail('CONFIRMATION_MISMATCH', '确认摘要与退役计划不一致');
    const occurredAt = timestamp(at ?? new Date(), 'at');
    const ledger = this.read();
    const current = statusFromEvents(ledger.events, verified.subject.skillId);
    if (current.state === 'retired') {
      if (current.planDigest === verified.planDigest) return { action: 'unchanged', status: current };
      fail('ALREADY_RETIRED', '技能已按另一计划退役');
    }
    const event = createEvent({
      type: 'skill.retired', skillId: verified.subject.skillId, occurredAt, actorDigest: actorDigest(actor),
      reason: verified.reason, planDigest: verified.planDigest, releaseIds: verified.subject.releaseIds,
      replacementSkillId: verified.replacementSkillId, dependenciesDigest: digest(verified.dependencies),
      previousEventDigest: ledger.events.at(-1)?.eventDigest ?? null,
    });
    atomicWrite(this.filePath, { schemaVersion: RETIREMENT_SCHEMA_VERSION, events: [...ledger.events, event] });
    return { action: 'retired', event: structuredClone(event), status: statusFromEvents([...ledger.events, event], event.skillId) };
  }

  restore(skillId, { actor, reason, at } = {}) {
    match(skillId, SKILL_ID, 'skillId');
    const ledger = this.read();
    const current = statusFromEvents(ledger.events, skillId);
    if (current.state === 'active') fail('NOT_RETIRED', '技能尚未退役');
    if (current.state === 'active_pending_revalidation') return { action: 'unchanged', status: current };
    const event = createEvent({
      type: 'skill.restored', skillId, occurredAt: timestamp(at ?? new Date(), 'at'), actorDigest: actorDigest(actor),
      reason: safeText(reason, 'reason'), previousEventDigest: ledger.events.at(-1)?.eventDigest ?? null,
    });
    atomicWrite(this.filePath, { schemaVersion: RETIREMENT_SCHEMA_VERSION, events: [...ledger.events, event] });
    return { action: 'restored', event: structuredClone(event), status: statusFromEvents([...ledger.events, event], skillId) };
  }

  status(skillId) {
    match(skillId, SKILL_ID, 'skillId');
    return statusFromEvents(this.read().events, skillId);
  }

  list() {
    const events = this.read().events;
    return [...new Set(events.map(event => event.skillId))].sort().map(skillId => statusFromEvents(events, skillId));
  }
}

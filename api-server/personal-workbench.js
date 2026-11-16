import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const STORY_ID = 'b20a02ec-34b0-4258-ac6e-d2899e77b78a';
export const STORY_VERSION = '1.0.1';
const DATA_DIR = process.env.DATA_DIR || 'data';
const CENTER = 'http://127.0.0.1:5050/api/inside/skills';
const ENTRY = 'SKILL.md';
const criteria = [
  ['opening', '从家长熟悉的具体场景开场'],
  ['evidence', '明确区分产品设想和已验证事实'],
  ['accuracy', '没有虚构客户证言、数据或使用效果'],
  ['action', '给家长一个具体而自然的下一步'],
];
const activeJobs = new Map();

class WorkflowError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
const fail = (status, message) => { throw new WorkflowError(status, message); };
const sha = value => createHash('sha256').update(value).digest('hex');

function workspaceFor(id, version) {
  if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(id) ||
      !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version) || version.length > 100) {
    fail(400, '请指定有效的个人技能和正式版本。');
  }
  const trialRequired = id === STORY_ID && version === STORY_VERSION;
  const [major, minor, patch] = version.split('.');
  return {
    id, version, trialRequired, nextVersion: major + '.' + minor + '.' + (BigInt(patch) + 1n),
    key: id + '/' + version,
    store: join(DATA_DIR, trialRequired ? 'storytelling-workbench.json'
      : 'personal-workbench-' + id + '-' + version + '.json'),
  };
}

function readState(workspace) {
  try {
    return JSON.parse(readFileSync(workspace.store, 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return { revision: 0, history: [] };
  }
}
function saveState(workspace, state) {
  const temp = workspace.store + '.' + randomUUID() + '.tmp';
  try {
    writeFileSync(temp, JSON.stringify(state), { mode: 0o600, flag: 'wx' });
    renameSync(temp, workspace.store);
  } finally {
    rmSync(temp, { force: true });
  }
}
function response(workspace, state, latest) {
  return {
    revision: state.revision, score: state.score, candidate: state.candidate,
    trial: state.trial, published: state.published, error: state.error,
    job: activeJobs.get(workspace.key) || null, baseVersion: workspace.version,
    nextVersion: workspace.nextVersion, latestVersion: latest.version,
    canPublish: !state.published && latest.version === workspace.version, trialRequired: workspace.trialRequired,
  };
}

async function center(workspace, path = '', body) {
  const token = process.env[body ? 'PERSONAL_WORKBENCH_WRITE_TOKEN' : 'PERSONAL_RELEASES_READ_TOKEN'];
  if (!token) fail(503, '个人中心连接尚未配置。');
  const r = await fetch(CENTER + '/' + workspace.id + path, {
    method: body ? 'POST' : 'GET',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
    redirect: 'error',
    signal: AbortSignal.timeout(12000),
  });
  if (r.status === 404) fail(404, '个人技能不存在。');
  if (r.status === 409) fail(409, '个人中心草稿或版本已变化，请重新核对。');
  if (!r.ok) fail(502, '个人中心请求失败，请检查版本状态后重试。');
  return r.json();
}
function getBase(workspace, skill, state) {
  const base = skill.releases?.find(item => item.version === workspace.version);
  if (skill.id !== workspace.id || skill.status === 'archived' || !base?.files?.[ENTRY]) {
    fail(404, '所选正式版本不可用。');
  }
  if (state.baseHash && state.baseHash !== base.hash) fail(409, '所选版本的内容已变化，请重新核对。');
  return base;
}
function requireRevision(state, body) {
  if (state.revision !== body.revision) fail(409, '候选已变化，请刷新后重试。');
  if (state.published) fail(409, '这份候选已发布。');
}
function setCandidate(state, text, source) {
  const content = typeof text === 'string' ? text.trim() : '';
  if (content.length < 40 || content.length > 24000 || content.includes('\0')) {
    fail(400, '候选正文须为 40–24000 字的文本。');
  }
  if (content === state.candidate?.content) return;
  if (state.candidate) state.history.push(state.candidate);
  state.candidate = { content, hash: sha(content), source, at: new Date().toISOString() };
  delete state.trial;
  state.revision++;
}
function sameFiles(a, b) {
  return a && b && Object.keys(a).length === Object.keys(b).length &&
    Object.keys(a).every(key => Object.hasOwn(b, key) && a[key] === b[key]);
}

async function complete(messages, maxTokens) {
  const base = process.env.LLM_BASE_URL;
  const key = process.env.LLM_API_KEY;
  const model = process.env.LLM_MODEL;
  if (!base || !key || !model) fail(503, '试岗模型尚未配置。');
  const request = { model, messages, temperature: 0.15, max_tokens: maxTokens, stream: false };
  if (new URL(base).hostname.endsWith('.xiaomimimo.com')) request.thinking = { type: 'disabled' };
  const r = await fetch(base.replace(/\/$/, '') + '/chat/completions', {
    method: 'POST', headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
    body: JSON.stringify(request), signal: AbortSignal.timeout(90000),
  });
  if (!r.ok) fail(502, '试岗模型请求失败。');
  const data = await r.json();
  const choice = data.choices?.[0];
  const text = choice?.message?.content?.trim();
  if (!text || choice.finish_reason === 'length') fail(502, '试岗返回的产物不完整。');
  return text;
}

async function runTrial(base, candidate) {
  const task = base.trial?.task;
  if (!task) fail(409, '基线没有可复用的试岗题。');
  const generate = content => complete([
    { role: 'system', content: '按以下技能处理用户任务。只输出可直接朗读的稿件。\n\n' + content },
    { role: 'user', content: task },
  ], 900);
  const [baseline, output] = await Promise.all([generate(base.files[ENTRY]), generate(candidate.content)]);
  const candidateFirst = Number.parseInt(randomUUID().slice(0, 2), 16) % 2 === 0;
  const [a, b] = candidateFirst ? [output, baseline] : [baseline, output];
  const raw = await complete([
    { role: 'system', content: '你是试岗评审。按给定判据分别判断两个稿件，只输出 JSON：{"checks":[{"key":"判据编号","a":"pass|fail|unclear","b":"pass|fail|unclear","reason":"分别引用稿件依据并解释"}]}。四项判据各出现一次，不要添加稿件以外的事实。' },
    { role: 'user', content: JSON.stringify({ task, criteria: Object.fromEntries(criteria), a, b }) },
  ], 1500);
  let checks;
  try { checks = JSON.parse(raw.replace(/^```(?:json)?\s*|\s*```$/g, '')).checks; }
  catch { fail(502, '试岗评审格式异常，请重试。'); }
  const outcomes = ['pass', 'fail', 'unclear'];
  if (!Array.isArray(checks) || checks.length !== criteria.length) fail(502, '试岗评审缺少判据。');
  const results = criteria.map(([key, label]) => {
    const match = checks.filter(item => item?.key === key);
    const point = match[0];
    if (match.length !== 1 || !outcomes.includes(point.a) || !outcomes.includes(point.b) ||
        typeof point.reason !== 'string' || !point.reason.trim()) fail(502, '试岗评审判据不完整。');
    return {
      key, label, baseline: candidateFirst ? point.b : point.a, candidate: candidateFirst ? point.a : point.b,
      reason: (candidateFirst ? 'A 为候选，B 为基线。' : 'A 为基线，B 为候选。') + point.reason.trim(),
    };
  });
  return {
    task, model: process.env.LLM_MODEL, baseline, candidate: output, results, candidateHash: candidate.hash,
    assessment: results.map(item => item.label + '：基线 ' + item.baseline + '，候选 ' + item.candidate + '。' + item.reason).join('\n'),
    at: new Date().toISOString(),
  };
}

async function publish(workspace, state, body, skill, base) {
  const { nextVersion, trialRequired } = workspace;
  if (!state.candidate || body.confirmVersion !== nextVersion || body.candidateHash !== state.candidate.hash) {
    fail(400, '请确认当前候选及待发布版本。');
  }
  const trial = state.trial;
  if (trialRequired && (!trial || trial.candidateHash !== state.candidate.hash ||
      trial.results.some(item => item.candidate !== 'pass'))) {
    fail(409, '当前候选需要通过试岗后才能发布。');
  }
  const files = { ...base.files, [ENTRY]: state.candidate.content };
  const latest = skill.releases.at(-1);
  if (latest.version === nextVersion && sameFiles(latest.files, files) &&
      (!trialRequired || (latest.trial?.candidate_hash === latest.hash && latest.trial?.base_hash === base.hash))) {
    return latest;
  }
  if (latest.id !== base.id) fail(409, '请从最新正式版开始发布，当前候选仍保留。');
  if (sameFiles(base.files, files)) fail(409, '候选与正式版内容相同。');
  let draft = skill;
  if (!sameFiles(draft.files, files)) {
    if (draft.hash !== base.hash) fail(409, '个人中心有其他草稿，请保留并核对后再发布。');
    draft = await center(workspace, '/draft', {
      expected_revision: draft.revision, files, reason: '经确认，从 SkillOps 保存培训候选',
    });
  }
  const published = await center(workspace, '/releases', {
    expected_revision: draft.revision, version: nextVersion,
    reason: '经确认，从 SkillOps 发布培训候选',
    ...(trialRequired ? { trial: {
      task: trial.task, model: trial.model, baseline: trial.baseline, candidate: trial.candidate,
      assessment: trial.assessment, base_hash: base.hash, candidate_hash: draft.hash, revision: draft.revision,
    } } : {}),
  });
  const result = published.releases?.find(item => item.version === nextVersion && item.hash === draft.hash);
  if (!result) fail(502, '未能核对发布结果，请刷新版本记录。');
  return result;
}

async function runJob(workspace, action, state, engines, skill, base) {
  try {
    if (action === 'score') {
      state.score = await engines.runScoring(skill.name, base.files[ENTRY]);
    } else if (action === 'train') {
      const weak = [...state.score.dimensions].sort((a, b) => a.score - b.score).slice(0, 3);
      const proposal = await engines.coachRewrite(skill.name, base.files[ENTRY], weak, 'B', 'structure');
      setCandidate(state, proposal.rewritten, 'MiMo 培训');
    } else {
      state.trial = await runTrial(base, state.candidate);
    }
    saveState(workspace, state);
  } catch (error) {
    state.error = error instanceof WorkflowError || error.code === 'too_short'
      ? error.message : '执行失败，请稍后重试。';
    saveState(workspace, state);
  } finally {
    activeJobs.delete(workspace.key);
  }
}

export async function personalWorkbench(id, version, action, body, engines) {
  let workspace, keepJob = false, locked = false;
  try {
    workspace = workspaceFor(id, version);
    if (action) {
      if (activeJobs.has(workspace.key)) fail(409, '已有操作正在运行，请等待结果。');
      activeJobs.set(workspace.key, action);
      locked = true;
    }
    const skill = await center(workspace);
    const state = readState(workspace);
    const base = getBase(workspace, skill, state);
    const latest = skill.releases.at(-1);
    if (!action) return { status: 200, data: response(workspace, state, latest) };
    requireRevision(state, body);
    state.baseHash = base.hash;
    if (action === 'edit') {
      if (!state.candidate) fail(409, '请先生成培训候选。');
      setCandidate(state, body.content, '手工改稿');
      delete state.error;
      saveState(workspace, state);
    } else if (action === 'publish') {
      const release = await publish(workspace, state, body, skill, base);
      state.published = { version: release.version, id: release.id, hash: release.hash };
      saveState(workspace, state);
      activeJobs.delete(workspace.key);
      return { status: 200, data: response(workspace, state, release) };
    } else {
      if (action === 'train' && (!state.score || state.candidate)) fail(409, '需要先评分，已有候选可直接改稿。');
      if (action === 'trial' && (!workspace.trialRequired || !state.candidate)) fail(409, '当前技能版本没有可运行的试岗候选。');
      delete state.error;
      saveState(workspace, state);
      keepJob = true;
      runJob(workspace, action, state, engines, skill, base)
        .catch(() => console.error('Could not persist personal workbench result'));
      return { status: 202, data: response(workspace, state, latest) };
    }
    activeJobs.delete(workspace.key);
    return { status: 200, data: response(workspace, state, latest) };
  } catch (error) {
    if (error instanceof WorkflowError) return { status: error.status, data: { message: error.message } };
    return { status: 502, data: { message: '工作台操作失败，请稍后检查状态。' } };
  } finally {
    if (locked && !keepJob) activeJobs.delete(workspace.key);
  }
}

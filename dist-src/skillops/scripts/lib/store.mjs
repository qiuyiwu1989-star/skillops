/* store.mjs — SkillOps CLI 的本地存储（~/.skillops/，零依赖）
 *
 * config.json  卷注册表 + 默认命名空间（花名册的"编制口径"）
 * index.json   scan 产出的花名册（技能索引缓存，随时可重建，不是真身）
 * env          可选 KEY=VALUE（LLM_* 等），score/coach 用；不覆盖已有环境变量
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export const ROOT = path.join(os.homedir(), '.skillops');
const CONFIG = path.join(ROOT, 'config.json');
const INDEX = path.join(ROOT, 'index.json');
const ENV = path.join(ROOT, 'env');

function ensureRoot() { fs.mkdirSync(ROOT, { recursive: true }); }
function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

export function loadConfig() {
  return readJson(CONFIG, { defaultNamespace: '', vaults: [] });
}
export function saveConfig(cfg) {
  ensureRoot();
  fs.writeFileSync(CONFIG, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
}

export function loadIndex() {
  return readJson(INDEX, { updatedAt: null, skills: [] });
}
export function saveIndex(ix) {
  ensureRoot();
  fs.writeFileSync(INDEX, JSON.stringify(ix, null, 2) + '\n', 'utf8');
}

// state.json：轻量运行状态（上次周报时间等）
const STATE = path.join(ROOT, 'state.json');
export function loadState() { return readJson(STATE, {}); }
export function saveState(st) { ensureRoot(); fs.writeFileSync(STATE, JSON.stringify(st, null, 2) + '\n', 'utf8'); }

// telemetry.jsonl：技能调用遥测（PostToolUse hook 追加，一行一次调用）
export const TELEMETRY = path.join(ROOT, 'telemetry.jsonl');
export function appendTelemetry(row) { ensureRoot(); fs.appendFileSync(TELEMETRY, JSON.stringify(row) + '\n', 'utf8'); }
export function readTelemetry(sinceTs = 0) {
  try {
    return fs.readFileSync(TELEMETRY, 'utf8').split('\n').filter(Boolean)
      .map(l => { try { return JSON.parse(l); } catch { return null; } })
      .filter(r => r && Date.parse(r.ts) >= sinceTs);
  } catch { return []; }
}

// 把 ~/.skillops/env 里的 KEY=VALUE 注入 process.env（已存在的不覆盖）
export function loadEnvFile() {
  try {
    for (const line of fs.readFileSync(ENV, 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
      if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  } catch { /* 没有 env 文件是常态 */ }
}

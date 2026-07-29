#!/usr/bin/env node
/* skillops — AI 技能的人事部（HRD）· 便携标准包 v1.0.0
 *
 * 零依赖（纯 Node 内置模块）。可在任何机器、任何 agent 下运行。
 * file-as-truth：技能真身是你各处的 SKILL.md 文件夹（卷），本 CLI 只做索引与登记，
 * 不搬家、不改写正文；唯一的写动作是「落户」（往 frontmatter 插一行 id）。
 *
 * 用法：
 *   skillops init [--namespace <你的名>]          初始化：设命名空间 + 自动发现常见卷
 *   skillops vault add <dir> [--name 名] [--readonly]
 *   skillops vault ls | rm <名>
 *   skillops scan                                 盘点全部卷 → 花名册 + 体检
 *   skillops ls [--vault 名]                      花名册
 *   skillops status [--hook]                      警报（--hook：干净则沉默，给 SessionStart 用）
 *   skillops register <技能> [--id ns/name]        落户（省略 --id 用默认命名空间）
 *   skillops report                               人事周报
 *   skillops track                                遥测（hook 从 stdin 灌 payload）
 *   skillops score <技能>                          SMS 评分（需 LLM_* 环境变量）
 *
 * 数据都在 ~/.skillops/（config.json / index.json / state.json / telemetry.jsonl / env）
 * 造物云出品 · © 邱懿武 · SMS 标准公开
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { loadConfig, saveConfig, loadIndex, saveIndex, loadEnvFile, loadState, saveState, appendTelemetry, readTelemetry, ROOT } from './lib/store.mjs';
import { scanVaults, census } from './lib/scan.mjs';
import { upsertFrontmatterKey } from './lib/fm.mjs';

// ── 小工具：ANSI + 中英文混排对齐 ──
const C = { dim: s => `\x1b[2m${s}\x1b[0m`, b: s => `\x1b[1m${s}\x1b[0m`, g: s => `\x1b[32m${s}\x1b[0m`, y: s => `\x1b[33m${s}\x1b[0m`, r: s => `\x1b[31m${s}\x1b[0m`, o: s => `\x1b[38;5;208m${s}\x1b[0m` };
const w = s => [...String(s)].reduce((n, ch) => n + (ch.codePointAt(0) > 0xff ? 2 : 1), 0);
const pad = (s, n) => String(s) + ' '.repeat(Math.max(0, n - w(s)));

const args = process.argv.slice(2);
const cmd = args[0];
const flag = name => { const i = args.indexOf(`--${name}`); return i === -1 ? null : (args[i + 1] ?? true); };
const has = name => args.includes(`--${name}`);

const NS_RE = /^[a-z0-9][a-z0-9-]*$/i;
const ID_RE = /^[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9._-]*$/i;

function requireVaults(cfg) {
  if (!cfg.vaults.length) {
    console.log(`还没有注册任何卷。先跑：${C.b('skillops init')}（自动发现）或 ${C.b('skillops vault add <目录>')}`);
    process.exit(1);
  }
}

function runScan() {
  const cfg = loadConfig();
  requireVaults(cfg);
  const skills = scanVaults(cfg.vaults);
  saveIndex({ updatedAt: new Date().toISOString(), skills });
  return { cfg, skills, report: census(skills) };
}

function printAlerts(report, cfg) {
  const ns = cfg.defaultNamespace || 'me';
  if (report.unregistered.length) {
    console.log(C.y(`\n⚠ 无户口 ${report.unregistered.length} 个`) + C.dim(`（落户：skillops register <名>，默认命名空间 ${ns}/）`));
    for (const s of report.unregistered) console.log(`  ○ ${pad(s.name, 34)} ${C.dim(s.vault)}`);
  }
  if (report.conflicts.length) {
    console.log(C.r(`\n✗ 分歧 ${report.conflicts.length} 组`) + C.dim('（同身份、内容不同 —— 版本漂移，最该处理）'));
    for (const c of report.conflicts) {
      console.log(`  ${C.b(c.key)}`);
      for (const s of c.group) console.log(`    fp=${s.fingerprint.slice(0, 6)} ${pad(s.mtime, 12)} ${s.dir}`);
    }
  }
  if (report.clones.length) {
    console.log(C.dim(`\n≡ 分身 ${report.clones.length} 组（内容相同的多处拷贝 = 事实上的手工部署）`));
    for (const g of report.clones) console.log(C.dim(`  ${g[0].name}: ${g.map(s => s.vault).join(' = ')}`));
  }
  if (!report.unregistered.length && !report.conflicts.length) console.log(C.g('\n✓ 花名册干净：全部有户口、无分歧'));
}

function findSkill(skills, needle) {
  const abs = path.resolve(needle);
  let hits = skills.filter(s => s.dir === abs);
  if (!hits.length) hits = skills.filter(s => s.id === needle);
  if (!hits.length) hits = skills.filter(s => s.name === needle || path.basename(s.dir) === needle);
  if (!hits.length) { console.log(C.r(`找不到技能：${needle}`) + C.dim('（先 skillops scan，或用目录路径指定）')); process.exit(1); }
  if (hits.length > 1) {
    console.log(C.y(`「${needle}」命中 ${hits.length} 处，请用目录路径指定：`));
    for (const s of hits) console.log(`  ${s.dir}`);
    process.exit(1);
  }
  return hits[0];
}

const commands = {
  // 初始化：设命名空间 + 自动发现常见卷（第三方装完第一条命令）
  init() {
    const cfg = loadConfig();
    const ns = flag('namespace') || cfg.defaultNamespace || os.userInfo().username.toLowerCase().replace(/[^a-z0-9-]/g, '-');
    if (!NS_RE.test(ns)) { console.log(C.r(`命名空间不合法：${ns}`) + C.dim('（字母数字与连字符，如 alice / acme-corp）')); process.exit(1); }
    cfg.defaultNamespace = ns;

    // 自动发现：全局技能目录 + 当前项目
    const candidates = [
      { dir: path.join(os.homedir(), '.claude', 'skills'), name: 'global' },
      { dir: path.join(process.cwd(), '.claude', 'skills'), name: 'project/' + path.basename(process.cwd()) },
      { dir: path.join(os.homedir(), 'skills'), name: 'home-skills' },
    ];
    let added = 0;
    for (const c of candidates) {
      if (!fs.existsSync(c.dir)) continue;
      if (cfg.vaults.some(v => v.dir === c.dir)) continue;
      cfg.vaults.push({ name: c.name, dir: c.dir, readonly: false });
      added++;
      console.log(C.g(`✓ 发现并注册卷：${c.name}`) + C.dim(` → ${c.dir}`));
    }
    saveConfig(cfg);
    console.log(`\n命名空间：${C.b(ns)}   卷：${cfg.vaults.length} 个   数据目录：${C.dim(ROOT)}`);
    if (!added && !cfg.vaults.length) console.log(C.y('没自动发现到技能目录 —— 用 skillops vault add <目录> 手动注册'));
    else console.log(C.dim('下一步：skillops scan'));
  },

  vault() {
    const sub = args[1], cfg = loadConfig();
    if (sub === 'add') {
      const dir = path.resolve(args[2] || '');
      if (!dir || !fs.existsSync(dir)) { console.log(C.r(`目录不存在：${dir}`)); process.exit(1); }
      const name = flag('name') || path.basename(path.dirname(dir)) + '/' + path.basename(dir);
      if (cfg.vaults.some(v => v.dir === dir)) { console.log(C.dim(`已注册过：${dir}`)); return; }
      cfg.vaults.push({ name, dir, readonly: has('readonly') });
      saveConfig(cfg);
      console.log(C.g(`✓ 卷已注册：${name}`) + C.dim(` → ${dir}${has('readonly') ? '（只读）' : ''}`));
    } else if (sub === 'rm') {
      const before = cfg.vaults.length;
      cfg.vaults = cfg.vaults.filter(v => v.name !== args[2]);
      saveConfig(cfg);
      console.log(before === cfg.vaults.length ? C.y(`没有叫「${args[2]}」的卷`) : C.g(`✓ 已注销：${args[2]}`) + C.dim('（只取消登记，文件一个没动）'));
    } else {
      if (!cfg.vaults.length) return console.log(C.dim('（还没有卷，跑 skillops init）'));
      console.log(C.b(`卷 × ${cfg.vaults.length}`));
      for (const v of cfg.vaults) console.log(`  ${pad(v.name, 28)} ${v.readonly ? C.dim('[只读] ') : '       '}${C.dim(v.dir)}`);
    }
  },

  scan() {
    const { cfg, report } = runScan();
    console.log(C.b('▶ SkillOps 盘点') + C.dim(`  卷 ${cfg.vaults.length} · 技能 ${report.total} · 花名册 ${path.join(ROOT, 'index.json')}`));
    for (const [vault, n] of Object.entries(report.byVault)) console.log(`  ${pad(vault, 28)} ${n}`);
    printAlerts(report, cfg);
  },

  ls() {
    let { skills } = loadIndex();
    if (!skills.length) ({ skills } = runScan());
    const vf = flag('vault');
    if (vf) skills = skills.filter(s => s.vault === vf);
    skills.sort((a, b) => (a.id || '~').localeCompare(b.id || '~') || a.name.localeCompare(b.name));
    console.log(C.b(`花名册 × ${skills.length}`) + C.dim('   ✓=有户口  ○=无户口'));
    for (const s of skills) {
      const mark = s.id ? C.g('✓') : C.y('○');
      console.log(`  ${mark} ${pad(s.id || s.name, 40)} ${pad(s.vault, 26)} ${C.dim(`${pad('fp=' + s.fingerprint.slice(0, 6), 10)} ${s.files}f  ${s.mtime}`)}`);
    }
  },

  status() {
    // --hook：SessionStart 钩子模式 —— 无 ANSI、无警报则完全沉默
    if (has('hook')) {
      const cfg = loadConfig();
      if (!cfg.vaults.length) return;                       // 没初始化就别出声
      const skills = scanVaults(cfg.vaults);
      saveIndex({ updatedAt: new Date().toISOString(), skills });
      const report = census(skills);
      const ns = cfg.defaultNamespace || 'me';
      const lines = [];
      if (report.unregistered.length) {
        const names = report.unregistered.slice(0, 8).map(s => s.name).join('、');
        lines.push(`⚠ ${report.unregistered.length} 个技能无户口：${names}${report.unregistered.length > 8 ? ' …' : ''}（可 skillops register <名> 落户到 ${ns}/，第三方技能先跳过）`);
      }
      for (const c of report.conflicts)
        lines.push(`✗ 分歧「${c.key}」：${c.group.map(s => s.dir).join(' ≠ ')}（同身份不同内容，请向主人汇报）`);
      const st = loadState();
      if (!st.lastReportAt || Date.now() - Date.parse(st.lastReportAt) > 7 * 864e5)
        lines.push(`📋 技能人事周报到期（上次：${st.lastReportAt ? st.lastReportAt.slice(0, 10) : '从未'}）。请跑 skillops report 并汇报、请主人拍板。`);
      if (lines.length) console.log(`[skillops 技能人事体检 · 花名册 ${report.total} 人]\n` + lines.join('\n'));
      return;
    }
    const { cfg, report } = runScan();
    console.log(C.b('▶ 体检') + C.dim(`  技能 ${report.total} · 有户口 ${report.total - report.unregistered.length} · 分歧 ${report.conflicts.length} · 分身 ${report.clones.length}`));
    printAlerts(report, cfg);
  },

  register() {
    const target = args[1];
    const cfg = loadConfig();
    if (!target) { console.log('用法：skillops register <技能名或目录> [--id namespace/name]'); process.exit(1); }
    const { skills } = runScan();
    const s = findSkill(skills, target);
    const id = flag('id') || `${cfg.defaultNamespace || 'me'}/${path.basename(s.dir)}`;
    if (!ID_RE.test(String(id))) { console.log(C.r(`户口不合法：${id}`) + C.dim('（格式 namespace/name）')); process.exit(1); }
    if (s.readonly) { console.log(C.r(`「${s.name}」在只读卷（${s.vault}），不落户 —— 去真身所在的卷操作`)); process.exit(1); }
    const dupe = skills.find(x => x.id === id && x.dir !== s.dir);
    if (dupe) { console.log(C.r(`户口 ${id} 已被占用：${dupe.dir}`)); process.exit(1); }
    const file = path.join(s.dir, 'SKILL.md');
    fs.writeFileSync(file, upsertFrontmatterKey(fs.readFileSync(file, 'utf8'), 'id', id), 'utf8');
    runScan();
    console.log(C.g(`✓ 落户完成：${s.name} → ${C.b(id)}`) + C.dim(`  (${file})`));
  },

  // 遥测：hook 从 stdin 灌 payload；永不报错、永不出声
  async track() {
    try {
      let raw = '';
      if (!process.stdin.isTTY) for await (const chunk of process.stdin) raw += chunk;
      const payload = raw ? JSON.parse(raw) : {};
      const skill = payload?.tool_input?.skill || payload?.tool_input?.name || args[1] || null;
      if (skill) appendTelemetry({ ts: new Date().toISOString(), skill: String(skill).slice(0, 120) });
    } catch { /* 遥测失败绝不影响会话 */ }
  },

  report() {
    const { skills, report } = runScan();
    const st = loadState();
    const since = st.lastReportAt ? Math.max(Date.parse(st.lastReportAt), Date.now() - 30 * 864e5) : Date.now() - 7 * 864e5;
    const calls = readTelemetry(since);
    const byName = {};
    for (const c of calls) byName[c.skill] = (byName[c.skill] || 0) + 1;
    const top = Object.entries(byName).sort((a, b) => b[1] - a[1]).slice(0, 5);
    const born = skills.filter(s => Date.parse(s.mtime) >= since - 864e5);
    const L = [];
    L.push(`# 技能人事周报  ${new Date().toISOString().slice(0, 10)}`);
    L.push(`统计窗口：${new Date(since).toISOString().slice(0, 10)} 起 · 花名册 ${report.total} 人（有户口 ${report.total - report.unregistered.length}）`);
    L.push('');
    if (born.length) L.push(`## 新生/近期变动 ${born.length} 个\n` + born.map(s => `- ${s.id || s.name}（${s.vault} · ${s.mtime}）${s.id ? '' : ' ⚠ 未落户'}`).join('\n'));
    if (top.length) L.push(`## 调用榜（遥测 ${calls.length} 次）\n` + top.map(([n, k]) => `- ${n} × ${k}`).join('\n'));
    else L.push('## 调用榜\n（还没有遥测数据 —— 装上 PostToolUse hook 才有）');
    if (report.unregistered.length) L.push(`## 待拍板 · 无户口 ${report.unregistered.length} 个\n` + report.unregistered.map(s => `- ${s.name}（${s.vault}）`).join('\n'));
    if (report.conflicts.length) L.push(`## 待拍板 · 分歧 ${report.conflicts.length} 组\n` + report.conflicts.map(c => `- ${c.key}: ${c.group.map(s => s.dir).join(' ≠ ')}`).join('\n'));
    if (report.clones.length) L.push(`## 分身 ${report.clones.length} 组（内容相同的多处拷贝）`);
    console.log(L.join('\n'));
    saveState({ ...st, lastReportAt: new Date().toISOString() });
  },

  async score() {
    loadEnvFile();
    if (!process.env.LLM_API_KEY) {
      console.log(C.r('缺 LLM_API_KEY。') + `写进 ${C.b(path.join(ROOT, 'env'))}（LLM_BASE_URL / LLM_MODEL / LLM_API_KEY）或导出环境变量。`);
      console.log(C.dim('评分花的是你自己的 LLM 额度 —— 本工具不代跑、不上传你的技能内容到我们的服务器。'));
      process.exit(1);
    }
    const { skills } = loadIndex();
    const s = findSkill(skills.length ? skills : runScan().skills, args[1] || '');
    const { runScoring, tierFor } = await import(new URL('./lib/scoring.mjs', import.meta.url));
    console.log(C.dim(`评分中（SMS v2.0 · 花你自己的 LLM 额度）… ${s.name}`));
    const r = await runScoring(s.id || s.name, fs.readFileSync(path.join(s.dir, 'SKILL.md'), 'utf8'));
    console.log(C.b(`\n${s.id || s.name}  ${C.o(r.total + '/100')}  ${r.tier || tierFor(r.total)} 段`));
    for (const d of r.dimensions || []) console.log(`  ${pad(d.name || d.key, 22)} ${pad(d.score, 4)} ${C.dim(d.comment || '')}`);
    if (r.summary) console.log(C.dim(`\n${r.summary}`));
  },

  help() {
    console.log(`${C.b('skillops')} — AI 技能的人事部（HRD）· 便携标准包 v1.0.0
${C.dim('真身在你自己的文件里（file-as-truth）；本工具只做登记与体检，唯一写动作 = 落户写入一行 id。')}

  init [--namespace <名>]                     初始化：设命名空间 + 自动发现卷
  vault add <dir> [--name 名] [--readonly]    注册卷
  vault ls / vault rm <名>                     卷管理
  scan                                        盘点 → 花名册 + 体检
  ls [--vault 名]                             花名册
  status [--hook]                             警报（--hook：干净则沉默）
  register <技能> [--id ns/name]               落户
  report                                      人事周报
  track                                       遥测（hook 用）
  score <技能>                                 SMS 评分（需 LLM_* 环境变量）

${C.dim('数据：' + ROOT + '   标准与方法论见 references/   造物云出品 · © 邱懿武')}`);
  },
};

const fn = commands[cmd] || commands.help;
await fn();

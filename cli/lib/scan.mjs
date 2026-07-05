/* scan.mjs — 盘点引擎：遍历卷 → 发现 SKILL.md → 指纹 → 花名册 + 警报（零依赖）
 *
 * 指纹 = 正文（去 frontmatter）空白归一化后 sha256 前 12 位。
 * 警报两类：
 *   分歧 conflict —— 同身份（id，缺省退化为目录名）但内容指纹不同 → 版本漂移候选，最要命
 *   分身 clone    —— 内容指纹相同的多处拷贝 → 事实上的"手工部署"，将来交给 deploy 管
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { parseSkillMd } from './fm.mjs';

const PRUNE = new Set(['node_modules', '.git', 'dist', 'build', '.cache', '.DS_Store']);
const MAX_DEPTH = 6;

// 递归找含 SKILL.md 的目录（卷根本身是技能也算）。
// 跟随目录符号链接（插件/未来的 deploy --link 都是链接），用 realpath 集合防环。
export function findSkillDirs(root, depth = 0, out = [], seen = new Set()) {
  let real;
  try { real = fs.realpathSync(root); } catch { return out; }
  if (seen.has(real)) return out;
  seen.add(real);
  if (fs.existsSync(path.join(root, 'SKILL.md'))) out.push(root);   // existsSync 跟随链接
  if (depth >= MAX_DEPTH) return out;
  let entries;
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (PRUNE.has(e.name)) continue;
    const p = path.join(root, e.name);
    let isDir = e.isDirectory();
    if (!isDir && e.isSymbolicLink()) { try { isDir = fs.statSync(p).isDirectory(); } catch { isDir = false; } }
    if (isDir) findSkillDirs(p, depth + 1, out, seen);
  }
  return out;
}

export function fingerprint(body) {
  const norm = String(body).replace(/\s+/g, ' ').trim();
  return crypto.createHash('sha256').update(norm).digest('hex').slice(0, 12);
}

function countFiles(dir, depth = 0) {
  if (depth > MAX_DEPTH) return 0;
  let n = 0;
  try {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (PRUNE.has(e.name)) continue;
      let ent = e;
      if (e.isSymbolicLink()) {                          // 链接按真身算
        try { ent = fs.statSync(path.join(dir, e.name)); } catch { continue; }
      }
      if (ent.isFile()) n++;
      else if (ent.isDirectory()) n += countFiles(path.join(dir, e.name), depth + 1);
    }
  } catch { /* 忽略不可读 */ }
  return n;
}

// 盘点所有卷 → 技能记录数组
export function scanVaults(vaults) {
  const skills = [];
  for (const v of vaults) {
    for (const dir of findSkillDirs(v.dir)) {
      const file = path.join(dir, 'SKILL.md');
      let raw;
      try { raw = fs.readFileSync(file, 'utf8'); } catch { continue; }
      const { attrs, body } = parseSkillMd(raw);
      const st = fs.statSync(file);
      skills.push({
        id: attrs.id || null,                                  // 户口（namespace/name）
        name: attrs.name || path.basename(dir),
        description: (attrs.description || '').slice(0, 160),
        version: attrs.version || null,
        dir, vault: v.name, readonly: !!v.readonly,
        fingerprint: fingerprint(body),
        files: countFiles(dir),
        mtime: st.mtime.toISOString().slice(0, 10),
      });
    }
  }
  return skills;
}

// 花名册体检：无户口 / 分歧 / 分身
export function census(skills) {
  const identityOf = s => s.id || s.name.toLowerCase();
  const byIdentity = new Map(), byFp = new Map();
  for (const s of skills) {
    const k = identityOf(s);
    (byIdentity.get(k) ?? byIdentity.set(k, []).get(k)).push(s);
    (byFp.get(s.fingerprint) ?? byFp.set(s.fingerprint, []).get(s.fingerprint)).push(s);
  }
  const conflicts = [...byIdentity.entries()]
    .filter(([, group]) => new Set(group.map(s => s.fingerprint)).size > 1)
    .map(([key, group]) => ({ key, group }));
  const clones = [...byFp.values()].filter(g => g.length > 1);
  return {
    total: skills.length,
    unregistered: skills.filter(s => !s.id),
    conflicts, clones,
    byVault: skills.reduce((m, s) => (m[s.vault] = (m[s.vault] || 0) + 1, m), {}),
  };
}

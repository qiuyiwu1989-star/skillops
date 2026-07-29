/* fm.mjs — SKILL.md frontmatter 极简解析/写回（零依赖）
 *
 * 只处理顶层标量键（name / description / id / version …），嵌套块原样跳过。
 * 写回原则：字节级保守 —— 只插入一行，其余内容一个字节不动（落户不能弄脏别人的档案）。
 */

// 解析：返回 { attrs, body, hasFrontmatter }
export function parseSkillMd(raw) {
  const attrs = {};
  if (!raw.startsWith('---')) return { attrs, body: raw, hasFrontmatter: false };
  const end = raw.indexOf('\n---', 3);
  if (end === -1) return { attrs, body: raw, hasFrontmatter: false };
  const fmBlock = raw.slice(raw.indexOf('\n') + 1, end);
  for (const line of fmBlock.split('\n')) {
    const m = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/); // 顶层（无缩进）标量
    if (m) attrs[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
  }
  const bodyStart = raw.indexOf('\n', end + 1);
  return { attrs, body: bodyStart === -1 ? '' : raw.slice(bodyStart + 1), hasFrontmatter: true };
}

// 落户写回：把 `key: value` 插进 frontmatter（已存在则替换那一行）；无 frontmatter 则新建块
export function upsertFrontmatterKey(raw, key, value) {
  const line = `${key}: ${value}`;
  if (!raw.startsWith('---')) return `---\n${line}\n---\n\n${raw}`;
  const end = raw.indexOf('\n---', 3);
  if (end === -1) return `---\n${line}\n---\n\n${raw}`;
  const head = raw.slice(0, end);          // 含开头 '---' 与 frontmatter 内容
  const rest = raw.slice(end);             // '\n---' 起的全部
  const re = new RegExp(`^${key}:.*$`, 'm');
  if (re.test(head)) return head.replace(re, line) + rest;
  return head + '\n' + line + rest;
}

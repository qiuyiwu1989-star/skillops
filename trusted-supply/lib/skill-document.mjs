const LIMITS = Object.freeze({
  maxHeaderBytes: 64 * 1024,
  maxLines: 1_000,
  maxDepth: 6,
  maxNodes: 256,
  maxScalarBytes: 16 * 1024,
  maxBlockBytes: 32 * 1024,
});

const SAFE_KEY = /^[A-Za-z_][A-Za-z0-9_.-]{0,127}$/;
const BLOCK_MARKER = /^[>|][+-]?$/;
const POLLUTION_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

class SafeYamlError extends Error {
  constructor(code, line, detail = '') {
    super(`${code}${line ? ` at line ${line}` : ''}${detail ? `: ${detail}` : ''}`);
    this.code = code;
    this.line = line || null;
  }
}

function yamlError(code, line, detail) {
  throw new SafeYamlError(code, line, detail);
}

function byteLength(value) {
  return Buffer.byteLength(String(value), 'utf8');
}

function safeObject() {
  return Object.create(null);
}

function validateKey(raw, line) {
  const trimmed = raw.trim();
  const key = (trimmed.startsWith('"') || trimmed.startsWith("'"))
    ? parseQuoted(trimmed, line)
    : trimmed;
  if (!SAFE_KEY.test(key)) yamlError('unsafe_or_invalid_key', line, key.slice(0, 80));
  if (POLLUTION_KEYS.has(key.toLowerCase())) yamlError('unsafe_object_key', line, key);
  if (key === '<<') yamlError('yaml_merge_key_forbidden', line);
  return key;
}

function findUnquoted(text, needle) {
  let quote = null;
  let escaped = false;
  let square = 0;
  let curly = 0;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (quote === '"') {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') quote = null;
      continue;
    }
    if (quote === "'") {
      if (char === "'" && text[index + 1] === "'") index++;
      else if (char === "'") quote = null;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === '[') square++;
    else if (char === ']') square--;
    else if (char === '{') curly++;
    else if (char === '}') curly--;
    if (char === needle && square === 0 && curly === 0) return index;
  }
  return -1;
}

function stripPlainComment(text) {
  let quote = null;
  let escaped = false;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (quote === '"') {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') quote = null;
      continue;
    }
    if (quote === "'") {
      if (char === "'" && text[index + 1] === "'") index++;
      else if (char === "'") quote = null;
      continue;
    }
    if (char === '"' || char === "'") quote = char;
    else if (char === '#' && (index === 0 || /\s/.test(text[index - 1]))) return text.slice(0, index).trimEnd();
  }
  if (quote) yamlError('unclosed_quote', null);
  return text.trimEnd();
}

function splitFlow(text, line) {
  const values = [];
  let start = 0;
  let quote = null;
  let escaped = false;
  let square = 0;
  let curly = 0;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (quote === '"') {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') quote = null;
      continue;
    }
    if (quote === "'") {
      if (char === "'" && text[index + 1] === "'") index++;
      else if (char === "'") quote = null;
      continue;
    }
    if (char === '"' || char === "'") quote = char;
    else if (char === '[') square++;
    else if (char === ']') square--;
    else if (char === '{') curly++;
    else if (char === '}') curly--;
    else if (char === ',' && square === 0 && curly === 0) {
      values.push(text.slice(start, index).trim());
      start = index + 1;
    }
    if (square < 0 || curly < 0) yamlError('unbalanced_flow_collection', line);
  }
  if (quote || square !== 0 || curly !== 0) yamlError('unbalanced_flow_collection', line);
  values.push(text.slice(start).trim());
  if (values.some(value => !value)) yamlError('empty_flow_item', line);
  return values;
}

function rejectYamlFeatures(value, line) {
  const text = value.trim();
  if (/^(?:!|&|\*)\S*/.test(text)) yamlError('yaml_tag_anchor_or_alias_forbidden', line);
  if (/(?:^|[\s,[{])(?:!!?[A-Za-z]|&[A-Za-z0-9_-]+|\*[A-Za-z0-9_-]+)(?=$|[\s,}\]])/.test(text)) {
    yamlError('yaml_tag_anchor_or_alias_forbidden', line);
  }
}

function createState(lines, limits) {
  return {
    lines,
    limits,
    nodes: 0,
    addNode(line) {
      this.nodes++;
      if (this.nodes > limits.maxNodes) yamlError('yaml_node_limit_exceeded', line);
    },
  };
}

function parseQuoted(value, line) {
  if (value.startsWith("'")) {
    if (!value.endsWith("'") || value.length < 2) yamlError('unclosed_quote', line);
    const inner = value.slice(1, -1);
    if (/(^|[^'])'([^']|$)/.test(inner.replace(/''/g, ''))) yamlError('invalid_single_quoted_scalar', line);
    return inner.replace(/''/g, "'");
  }
  try {
    const parsed = JSON.parse(value);
    if (typeof parsed !== 'string') yamlError('invalid_quoted_scalar', line);
    return parsed;
  } catch (error) {
    if (error instanceof SafeYamlError) throw error;
    yamlError('invalid_double_quoted_scalar', line);
  }
}

function parseScalar(value, line, state, depth) {
  if (depth > state.limits.maxDepth) yamlError('yaml_depth_limit_exceeded', line);
  const clean = stripPlainComment(value).trim();
  if (!clean) return null;
  if (byteLength(clean) > state.limits.maxScalarBytes) yamlError('yaml_scalar_limit_exceeded', line);
  rejectYamlFeatures(clean, line);
  state.addNode(line);
  if ((clean.startsWith('"') && clean.endsWith('"')) || (clean.startsWith("'") && clean.endsWith("'"))) {
    return parseQuoted(clean, line);
  }
  if (clean.startsWith('[') || clean.endsWith(']')) {
    if (!(clean.startsWith('[') && clean.endsWith(']'))) yamlError('unbalanced_flow_collection', line);
    const inner = clean.slice(1, -1).trim();
    if (!inner) return [];
    return splitFlow(inner, line).map(item => parseScalar(item, line, state, depth + 1));
  }
  if (clean.startsWith('{') || clean.endsWith('}')) {
    if (!(clean.startsWith('{') && clean.endsWith('}'))) yamlError('unbalanced_flow_collection', line);
    const result = safeObject();
    const inner = clean.slice(1, -1).trim();
    if (!inner) return result;
    for (const pair of splitFlow(inner, line)) {
      const colon = findUnquoted(pair, ':');
      if (colon < 1) yamlError('invalid_flow_mapping', line);
      const key = validateKey(pair.slice(0, colon), line);
      if (Object.hasOwn(result, key)) yamlError('duplicate_key', line, key);
      result[key] = parseScalar(pair.slice(colon + 1), line, state, depth + 1);
    }
    return result;
  }
  if (/^(?:null|~)$/i.test(clean)) return null;
  if (/^(?:true|false)$/i.test(clean)) return clean.toLowerCase() === 'true';
  if (/^[-+]?(?:0|[1-9]\d*)(?:\.\d+)?(?:e[-+]?\d+)?$/i.test(clean)) {
    const number = Number(clean);
    if (!Number.isFinite(number)) yamlError('invalid_numeric_scalar', line);
    return number;
  }
  if (/^(?:---|\.\.\.|%YAML|%TAG)\b/.test(clean)) yamlError('yaml_directive_or_document_forbidden', line);
  return clean;
}

function significant(lines, index) {
  while (index < lines.length && (!lines[index].text.trim() || lines[index].text.trimStart().startsWith('#'))) index++;
  return index;
}

function splitPair(text, line) {
  const colon = findUnquoted(text, ':');
  if (colon < 1) yamlError('invalid_mapping_entry', line, text.trim().slice(0, 80));
  return { key: validateKey(text.slice(0, colon), line), value: text.slice(colon + 1).trimStart() };
}

function blockScalar(lines, index, parentIndent, marker, state) {
  const start = index;
  let cursor = index;
  let contentIndent = Infinity;
  while (cursor < lines.length) {
    const current = lines[cursor];
    if (current.text.trim() && current.indent <= parentIndent) break;
    if (current.text.trim()) contentIndent = Math.min(contentIndent, current.indent);
    cursor++;
  }
  if (contentIndent === Infinity) return { value: '', index: cursor };
  const chunks = lines.slice(start, cursor).map(current => current.text.trim() ? current.raw.slice(contentIndent) : '');
  let value;
  if (marker[0] === '|') value = chunks.join('\n');
  else {
    value = '';
    for (let offset = 0; offset < chunks.length; offset++) {
      const chunk = chunks[offset];
      const next = chunks[offset + 1];
      value += chunk;
      if (offset < chunks.length - 1) value += (!chunk || !next) ? '\n' : ' ';
    }
  }
  if (marker.endsWith('-')) value = value.replace(/\n+$/, '');
  else if (marker.endsWith('+')) value += '\n';
  else value = value.replace(/\n*$/, '\n');
  if (byteLength(value) > state.limits.maxBlockBytes) yamlError('yaml_block_limit_exceeded', lines[start]?.number);
  state.addNode(lines[start]?.number);
  return { value, index: cursor };
}

function parsePairValue(pair, lines, index, mappingIndent, state, depth) {
  const line = lines[index];
  if (BLOCK_MARKER.test(pair.value)) return blockScalar(lines, index + 1, mappingIndent, pair.value, state);
  if (pair.value) {
    let scalar = pair.value;
    let cursor = index + 1;
    if (scalar.startsWith('[') || scalar.startsWith('{')) {
      while (!flowCollectionClosed(scalar, line.number)) {
        if (cursor >= lines.length || (lines[cursor].text.trim() && lines[cursor].indent <= mappingIndent)) {
          yamlError('unbalanced_flow_collection', line.number);
        }
        scalar += ` ${lines[cursor].text.trim()}`;
        if (byteLength(scalar) > state.limits.maxScalarBytes) yamlError('yaml_scalar_limit_exceeded', line.number);
        cursor++;
      }
    }
    return { value: parseScalar(scalar, line.number, state, depth), index: cursor };
  }
  const next = significant(lines, index + 1);
  if (next < lines.length && lines[next].indent > mappingIndent) {
    return parseNode(lines, next, lines[next].indent, state, depth);
  }
  state.addNode(line.number);
  return { value: null, index: index + 1 };
}

function flowCollectionClosed(text, line) {
  let quote = null;
  let escaped = false;
  let square = 0;
  let curly = 0;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (quote === '"') {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') quote = null;
      continue;
    }
    if (quote === "'") {
      if (char === "'" && text[index + 1] === "'") index++;
      else if (char === "'") quote = null;
      continue;
    }
    if (char === '"' || char === "'") quote = char;
    else if (char === '[') square++;
    else if (char === ']') square--;
    else if (char === '{') curly++;
    else if (char === '}') curly--;
    if (square < 0 || curly < 0) yamlError('unbalanced_flow_collection', line);
  }
  if (quote) yamlError('unclosed_quote', line);
  return square === 0 && curly === 0;
}

function setPair(target, pair, value, line) {
  if (Object.hasOwn(target, pair.key)) yamlError('duplicate_key', line, pair.key);
  target[pair.key] = value;
}

function parseMapping(lines, index, indent, state, depth, seed = null) {
  if (depth > state.limits.maxDepth) yamlError('yaml_depth_limit_exceeded', lines[index]?.number);
  const result = seed || safeObject();
  while (index < lines.length) {
    index = significant(lines, index);
    if (index >= lines.length || lines[index].indent < indent) break;
    const line = lines[index];
    if (line.indent > indent) yamlError('unexpected_indentation', line.number);
    if (line.text.startsWith('-')) break;
    const pair = splitPair(line.text, line.number);
    const parsed = parsePairValue(pair, lines, index, indent, state, depth + 1);
    setPair(result, pair, parsed.value, line.number);
    index = parsed.index;
  }
  return { value: result, index };
}

function parseSequence(lines, index, indent, state, depth) {
  if (depth > state.limits.maxDepth) yamlError('yaml_depth_limit_exceeded', lines[index]?.number);
  const result = [];
  while (index < lines.length) {
    index = significant(lines, index);
    if (index >= lines.length || lines[index].indent < indent) break;
    const line = lines[index];
    if (line.indent > indent) yamlError('unexpected_indentation', line.number);
    if (!/^-(?:\s|$)/.test(line.text)) break;
    const rest = line.text.slice(1).trimStart();
    if (!rest) {
      const next = significant(lines, index + 1);
      if (next < lines.length && lines[next].indent > indent) {
        const parsed = parseNode(lines, next, lines[next].indent, state, depth + 1);
        result.push(parsed.value);
        index = parsed.index;
      } else {
        state.addNode(line.number);
        result.push(null);
        index++;
      }
      continue;
    }
    const colon = findUnquoted(rest, ':');
    if (colon > 0 && !rest.startsWith('[') && !rest.startsWith('{') && !rest.startsWith('"') && !rest.startsWith("'")) {
      const mappingIndent = indent + 2;
      const seed = safeObject();
      const pair = splitPair(rest, line.number);
      const parsed = parsePairValue(pair, lines, index, mappingIndent, state, depth + 2);
      setPair(seed, pair, parsed.value, line.number);
      const continuation = significant(lines, parsed.index);
      if (continuation < lines.length && lines[continuation].indent === mappingIndent && !lines[continuation].text.startsWith('-')) {
        const mapped = parseMapping(lines, continuation, mappingIndent, state, depth + 1, seed);
        result.push(mapped.value);
        index = mapped.index;
      } else {
        result.push(seed);
        index = parsed.index;
      }
    } else {
      result.push(parseScalar(rest, line.number, state, depth + 1));
      index++;
    }
  }
  return { value: result, index };
}

function parseNode(lines, index, indent, state, depth) {
  if (lines[index]?.indent !== indent) yamlError('unexpected_indentation', lines[index]?.number);
  return /^-(?:\s|$)/.test(lines[index].text)
    ? parseSequence(lines, index, indent, state, depth)
    : parseMapping(lines, index, indent, state, depth);
}

function parseSafeFrontmatter(header, startLine, limits) {
  if (header.includes('\t')) yamlError('tab_indentation_forbidden', startLine);
  const rawLines = header.split('\n');
  if (rawLines.length > limits.maxLines) yamlError('yaml_line_limit_exceeded', startLine);
  const lines = rawLines.map((raw, index) => ({
    raw,
    indent: raw.match(/^ */)[0].length,
    text: raw.trimStart(),
    number: startLine + index,
  }));
  const first = significant(lines, 0);
  if (first >= lines.length) return safeObject();
  if (lines[first].indent !== 0) yamlError('root_indentation_forbidden', lines[first].number);
  if (/^-(?:\s|$)/.test(lines[first].text)) yamlError('root_must_be_mapping', lines[first].number);
  const state = createState(lines, limits);
  const parsed = parseMapping(lines, first, 0, state, 0);
  const trailing = significant(lines, parsed.index);
  if (trailing < lines.length) yamlError('unexpected_yaml_content', lines[trailing].number);
  return parsed.value;
}

function scalarString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

export function parseSafeSkillDocument(content, options = {}) {
  const limits = { ...LIMITS, ...(options.limits || {}) };
  const text = String(content ?? '').replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const result = { frontmatter: safeObject(), body: text, errors: [] };
  if (!text.startsWith('---\n')) {
    result.errors.push('missing_frontmatter');
    return result;
  }
  const lines = text.split('\n');
  let closing = -1;
  for (let index = 1; index < lines.length; index++) {
    if (lines[index] === '---' || lines[index] === '...') {
      closing = index;
      break;
    }
  }
  if (closing < 0) {
    result.errors.push('unclosed_frontmatter');
    return result;
  }
  const header = lines.slice(1, closing).join('\n');
  result.body = lines.slice(closing + 1).join('\n');
  if (byteLength(header) > limits.maxHeaderBytes) {
    result.errors.push('yaml_header_limit_exceeded');
    return result;
  }
  try {
    result.frontmatter = parseSafeFrontmatter(header, 2, limits);
  } catch (error) {
    if (!(error instanceof SafeYamlError)) throw error;
    result.errors.push(error.line ? `${error.code}:line_${error.line}` : error.code);
  }
  return result;
}

export function auditSkillFormat(content, options = {}) {
  const parsed = parseSafeSkillDocument(content, options);
  const issues = [...parsed.errors];
  const name = scalarString(parsed.frontmatter.name);
  const description = scalarString(parsed.frontmatter.description);
  const license = scalarString(parsed.frontmatter.license) || null;
  if (!name) issues.push('missing_name');
  if (!description) issues.push('missing_description');
  if (!parsed.body.trim()) issues.push('empty_body');
  return {
    status: issues.length ? 'fail' : 'pass',
    name,
    description,
    license,
    frontmatter: parsed.frontmatter,
    issues,
  };
}

export const SAFE_SKILL_DOCUMENT_LIMITS = LIMITS;

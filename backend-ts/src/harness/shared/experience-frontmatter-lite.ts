import type { ExperienceIndexFields } from './experience-index-store.js';

const EMPTY_FIELDS: ExperienceIndexFields = {
  title: '',
  keywords: '',
  summary: '',
  applicable: '',
  lastVerified: '',
};

interface ParsedEntry {
  key: string;
  inline: string;
  block: boolean;
  list: string[];
  continuation: string[];
}

/**
 * 容器侧经验 frontmatter 解析（无第三方依赖）。
 *
 * 运行时镜像里虽然装齐了生产依赖，但容器闭包不应为了索引扫描把完整 YAML 解析器
 * 拉进来——这条链路正是 2026-10-30 镜像缺 `yaml` 的事故来源。经验文档只使用固定
 * 的五个元字段，这里按 YAML 的常用子集解析：内联标量、引号、流式数组、块标量与
 * 缩进续行；无法解释的结构一律回落到空字段，与宿主侧宽松解析同口径。
 */
export function parseExperienceFrontmatterLite(content: string): ExperienceIndexFields {
  if (!content.startsWith('---')) return { ...EMPTY_FIELDS };
  const lines = content.split(/\r?\n/);
  if (lines[0]?.trim() !== '---') return { ...EMPTY_FIELDS };

  let end = -1;
  for (let i = 1; i < lines.length; i += 1) {
    if (lines[i]!.trim() === '---') {
      end = i;
      break;
    }
  }
  if (end === -1) return { ...EMPTY_FIELDS };

  const values = new Map<string, string>();
  const seen = new Set<string>();
  let current: ParsedEntry | null = null;

  const commit = () => {
    if (current == null) return;
    const entry = current;
    let value: string;
    if (entry.block) {
      value = entry.continuation.map((line) => line.trim()).filter(Boolean).join(' ');
    } else if (entry.list.length > 0) {
      value = entry.list.join(', ');
    } else {
      value = [entry.inline, ...entry.continuation].filter(Boolean).join(' ');
    }
    values.set(entry.key, normalizeScalar(value));
    current = null;
  };

  for (let i = 1; i < end; i += 1) {
    const raw = lines[i]!;
    const trimmed = raw.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;

    const indent = raw.length - raw.trimStart().length;
    if (indent === 0) {
      const match = /^([A-Za-z_][A-Za-z0-9_-]*):(?:[ \t]*(.*))?$/.exec(raw);
      if (match == null) return { ...EMPTY_FIELDS };
      const key = match[1]!;
      if (seen.has(key)) return { ...EMPTY_FIELDS };
      seen.add(key);
      commit();

      const inline = stripInlineComment(match[2] ?? '').trim();
      current = {
        key,
        inline: isBlockMarker(inline) ? '' : parseScalar(inline),
        block: isBlockMarker(inline),
        list: [],
        continuation: [],
      };
      continue;
    }

    if (current == null) return { ...EMPTY_FIELDS };
    if (current.block) {
      current.continuation.push(raw);
      continue;
    }
    if (/^-\s+/.test(trimmed)) {
      current.list.push(parseScalar(stripInlineComment(trimmed.slice(2)).trim()));
      continue;
    }
    current.continuation.push(stripInlineComment(trimmed).trim());
  }
  commit();

  return {
    title: values.get('title') ?? '',
    keywords: values.get('keywords') ?? '',
    summary: values.get('summary') ?? '',
    applicable: values.get('applicable') ?? '',
    // last_verified 为规范字段名，lastVerified 容错兼容
    lastVerified: values.get('last_verified') ?? values.get('lastVerified') ?? '',
  };
}

function isBlockMarker(value: string): boolean {
  return /^[|>][-+]?$/.test(value);
}

/** 去掉 YAML 行内注释；引号内的 # 保留。 */
function stripInlineComment(value: string): string {
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < value.length; i += 1) {
    const ch = value[i]!;
    if (quote != null) {
      if (ch === '\\' && quote === '"') {
        i += 1;
        continue;
      }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === '#' && (i === 0 || /\s/.test(value[i - 1]!))) {
      return value.slice(0, i);
    }
  }
  return value;
}

/** YAML 标量常用子集：引号、null、流式数组；其余按普通文本保留。 */
function parseScalar(raw: string): string {
  const value = raw.trim();
  if (value === '') return '';
  if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
    try {
      return String(JSON.parse(value));
    } catch {
      return value.slice(1, -1);
    }
  }
  if (value.startsWith("'") && value.endsWith("'") && value.length >= 2) {
    return value.slice(1, -1).replace(/''/g, "'");
  }
  if (value.startsWith('[') && value.endsWith(']')) {
    return splitFlowItems(value.slice(1, -1)).map((item) => parseScalar(item)).join(', ');
  }
  if (/^(?:null|~)$/i.test(value)) return '';
  return value;
}

function splitFlowItems(value: string): string[] {
  const items: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < value.length; i += 1) {
    const ch = value[i]!;
    if (quote != null) {
      current += ch;
      if (ch === '\\' && quote === '"') {
        if (i + 1 < value.length) current += value[++i]!;
      } else if (ch === quote) {
        quote = null;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === ',') {
      items.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  items.push(current);
  return items.map((item) => item.trim());
}

function normalizeScalar(value: string): string {
  return value.replace(/\s*\r?\n\s*/g, ' ').trim();
}

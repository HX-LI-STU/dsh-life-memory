// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hanxustu (dsh-life-memory)
/**
 * 人格定义解析器（docs/25-persona.md §2）。
 *
 * 一个 `*.md` 文件 = 一个人格：文件名（去 `.md`）= id，YAML frontmatter 放元数据，
 * 正文 = 人格 system prompt。**零外部依赖**：frontmatter 用自写最小 YAML 子集解析器
 * （只支持 `key: value`、`key: [a, b]`、`key:\n  - a\n  - b`、引号字符串、`#` 注释；
 * 布尔/数字按字符串保留；未知字段忽略）。
 *
 * 严格规则（与参考项目 dsh-agents-md 对齐）：
 * - id 必须匹配 `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`；
 * - 正文包含**完整** `{{...}}` 模板组 → 无效（孤立 `{{` 不触发）；
 * - 空正文 / frontmatter 解析失败 → 无效并记录原因；
 * - 正文超过 maxBodyChars → 截断并标记 `truncated`；
 * - `contentHash = sha256(id + "\0" + JSON.stringify(frontmatterNormalized) + "\0" + body)`，
 *   用于定义归档去重（L0 `persona:def` note）与 prompt 缓存签名。
 */
import { statSync } from 'node:fs';
import { basename } from 'node:path';
import type { PersonaDefinition } from '../core/contracts.ts';
import { sha256Hex } from '../core/hash.ts';

/** 人格 id 校验（文件名 = id） */
export const PERSONA_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
/** 人格正文中禁止的完整模板组（`{{...}}`） */
export const PERSONA_TEMPLATE_GROUP_RE = /\{\{[^}]*\}\}/;
/** frontmatter 分隔符行 */
const FRONTMATTER_DELIMITER_RE = /^---\s*$/;

/** 解析后的 frontmatter（未知字段忽略；布尔/数字按字符串保留） */
export interface PersonaFrontmatter {
  name?: string;
  description?: string;
  aliases: string[];
  tags: string[];
  model?: string | null;
  provider?: string | null;
}

export interface ParsePersonaFileInput {
  /** 文件路径（用于 id 推导、mtime、sourcePath） */
  filePath: string;
  /** 文件内容（UTF-8 文本） */
  content: string;
  /** 正文最大字符数（超出截断） */
  maxBodyChars: number;
  /** 当前时间（无法 stat 时的 mtime 兜底） */
  now: number;
}

export interface PersonaParseResult {
  /** 解析得到的人格定义（即使 invalid 也返回，供 UI 展示原因） */
  definition: PersonaDefinition;
  /** 文件级错误（id 非法、解析失败等；valid=true 时返回 null） */
  error: { file: string; reason: string } | null;
}

/** 从文件路径取人格 id（basename 去掉 `.md`） */
export function personaIdFromPath(filePath: string): string {
  const name = basename(filePath);
  return name.endsWith('.md') ? name.slice(0, -3) : name;
}

function safeMtime(filePath: string, fallback: number): number {
  try {
    const stat = statSync(filePath);
    return Number.isFinite(stat.mtimeMs) ? Math.floor(stat.mtimeMs) : fallback;
  } catch {
    return fallback;
  }
}

function stripQuotes(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2) {
    const first = trimmed[0];
    const last = trimmed[trimmed.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return trimmed.slice(1, -1);
    }
  }
  return trimmed;
}

/** `[a, b]` → ['a','b']（支持引号与空项过滤） */
function parseInlineList(value: string): string[] {
  const inner = value.trim();
  if (!(inner.startsWith('[') && inner.endsWith(']'))) return [];
  const body = inner.slice(1, -1);
  const items: string[] = [];
  let current = '';
  let quote: string | null = null;
  for (const char of body) {
    if (quote !== null) {
      if (char === quote) quote = null;
      else current += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === ',') {
      items.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  items.push(current);
  return items.map((item) => stripQuotes(item.trim())).filter((item) => item.length > 0);
}

function normalizeStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    const out: string[] = [];
    for (const item of value) {
      if (typeof item !== 'string') continue;
      const trimmed = item.trim();
      if (trimmed.length > 0 && !out.includes(trimmed)) out.push(trimmed);
    }
    return out;
  }
  if (typeof value === 'string' && value.trim().length > 0) return [value.trim()];
  return [];
}

/**
 * 最小 YAML frontmatter 解析（失败抛错，由调用方转为 invalid）。
 * 支持：`key: value` / `key: [a, b]` / `key:` + 缩进 `- item` 列表 / `#` 注释 / 引号字符串。
 */
export function parsePersonaFrontmatter(frontmatterText: string): PersonaFrontmatter {
  const result: PersonaFrontmatter = { aliases: [], tags: [] };
  const lines = frontmatterText.split(/\r?\n/);
  let index = 0;
  while (index < lines.length) {
    const rawLine = lines[index];
    index += 1;
    const line = rawLine.trimEnd();
    if (line.trim().length === 0 || line.trim().startsWith('#')) continue;
    // 缩进列表项必须挂在上一个 key 上；走到这里说明没有 key 承接
    if (/^\s*-\s+/.test(line)) {
      throw new Error(`unexpected list item without key: ${line.trim()}`);
    }
    const colonIndex = line.indexOf(':');
    if (colonIndex <= 0) {
      throw new Error(`invalid frontmatter line (missing ":"): ${line.trim()}`);
    }
    const key = line.slice(0, colonIndex).trim().toLowerCase();
    const rawValue = line.slice(colonIndex + 1).trim();
    if (rawValue.length === 0) {
      // 块状列表：后续缩进 `- item`
      const items: string[] = [];
      while (index < lines.length) {
        const next = lines[index];
        if (next.trim().length === 0) {
          index += 1;
          continue;
        }
        const itemMatch = /^\s*-\s+(.*)$/.exec(next);
        if (!itemMatch) break;
        index += 1;
        const item = stripQuotes(itemMatch[1].split(/\s+#/)[0].trim());
        if (item.length > 0) items.push(item);
      }
      assignFrontmatterKey(result, key, items);
      continue;
    }
    // 行尾注释：仅在非引号包裹时剥离（最小实现：` #` 之后视为注释）
    const value = stripQuotes(rawValue.replace(/\s+#.*$/, '').trim());
    if (value.startsWith('[') && value.endsWith(']')) {
      assignFrontmatterKey(result, key, parseInlineList(value));
    } else if (value.startsWith('[') !== value.endsWith(']')) {
      // 未闭合的 inline 列表 / 括号视为坏 frontmatter（docs/25 §2：解析失败 → invalid）
      throw new Error(`malformed frontmatter value (unclosed bracket): ${line.trim()}`);
    } else {
      assignFrontmatterKey(result, key, value);
    }
  }
  return result;
}

function assignFrontmatterKey(result: PersonaFrontmatter, key: string, value: string[] | string): void {
  switch (key) {
    case 'name':
      if (typeof value === 'string') result.name = value;
      break;
    case 'description':
      if (typeof value === 'string') result.description = value;
      break;
    case 'aliases':
      result.aliases = normalizeStringArray(value);
      break;
    case 'tags':
      result.tags = normalizeStringArray(value);
      break;
    case 'model':
      if (typeof value === 'string') result.model = value.length > 0 ? value : null;
      break;
    case 'provider':
      if (typeof value === 'string') result.provider = value.length > 0 ? value : null;
      break;
    default:
      // 未知字段忽略（与参考项目一致）
      break;
  }
}

/** 切分 frontmatter 与正文；返回 null 表示没有 frontmatter（正文 = 全文） */
function splitFrontmatter(content: string): { frontmatterText: string; body: string; unterminated: boolean } {
  const normalized = content.replace(/^\uFEFF/, '');
  const lines = normalized.split(/\r?\n/);
  if (lines.length === 0 || !FRONTMATTER_DELIMITER_RE.test(lines[0])) {
    return { frontmatterText: '', body: normalized, unterminated: false };
  }
  for (let index = 1; index < lines.length; index += 1) {
    if (FRONTMATTER_DELIMITER_RE.test(lines[index])) {
      return {
        frontmatterText: lines.slice(1, index).join('\n'),
        body: lines.slice(index + 1).join('\n'),
        unterminated: false,
      };
    }
  }
  return { frontmatterText: '', body: normalized, unterminated: true };
}

/**
 * 解析一个人格 markdown 文件。
 * 无论有效与否都返回 `definition`（invalid 时 `valid=false` + `invalidReason`），
 * `error` 供 registry 汇总到 `PersonaLoadError[]`。
 */
export function parsePersonaFile(input: ParsePersonaFileInput): PersonaParseResult {
  const { filePath, content, maxBodyChars, now } = input;
  const id = personaIdFromPath(filePath);
  const mtime = safeMtime(filePath, now);
  const text = typeof content === 'string' ? content : '';
  const rawHash = sha256Hex(`raw\0${id}\0${text}`);

  const invalid = (reason: string): PersonaParseResult => {
    const definition: PersonaDefinition = {
      id,
      name: id,
      description: '',
      aliases: [],
      tags: [],
      model: null,
      provider: null,
      body: '',
      sourcePath: filePath,
      contentHash: rawHash,
      mtime,
      valid: false,
      invalidReason: reason,
      truncated: false,
    };
    return { definition, error: { file: filePath, reason } };
  };

  if (!PERSONA_ID_RE.test(id)) {
    return invalid(`invalid persona id (filename): ${id}`);
  }
  if (text.trim().length === 0) {
    return invalid('persona file is empty');
  }

  const split = splitFrontmatter(text);
  if (split.unterminated) {
    return invalid('unterminated frontmatter (missing closing ---)');
  }
  let frontmatter: PersonaFrontmatter;
  try {
    frontmatter = split.frontmatterText.trim().length > 0
      ? parsePersonaFrontmatter(split.frontmatterText)
      : { aliases: [], tags: [] };
  } catch (err) {
    return invalid(`invalid frontmatter: ${err instanceof Error ? err.message : String(err)}`);
  }

  let body = split.body.trim();
  if (body.length === 0) {
    return invalid('persona body is empty');
  }
  const templateGroup = PERSONA_TEMPLATE_GROUP_RE.exec(body);
  if (templateGroup !== null) {
    return invalid(`persona body contains {{…}} template group: ${templateGroup[0].slice(0, 40)}`);
  }

  let truncated = false;
  if (Number.isFinite(maxBodyChars) && maxBodyChars > 0 && body.length > maxBodyChars) {
    body = body.slice(0, maxBodyChars);
    truncated = true;
  }

  const name = (frontmatter.name ?? '').trim() || id;
  const frontmatterNormalized = {
    name,
    description: frontmatter.description ?? '',
    aliases: frontmatter.aliases,
    tags: frontmatter.tags,
    model: frontmatter.model ?? null,
    provider: frontmatter.provider ?? null,
  };
  const contentHash = sha256Hex(`${id}\0${JSON.stringify(frontmatterNormalized)}\0${body}`);
  const definition: PersonaDefinition = {
    id,
    name,
    description: frontmatter.description ?? '',
    aliases: frontmatterNormalized.aliases,
    tags: frontmatterNormalized.tags,
    model: frontmatterNormalized.model,
    provider: frontmatterNormalized.provider,
    body,
    sourcePath: filePath,
    contentHash,
    mtime,
    valid: true,
    invalidReason: null,
    truncated,
  };
  return { definition, error: null };
}

/** 便利：PersonaDefinition → PersonaSummary（status/UI/health 用；不含正文） */
export function toPersonaSummary(definition: PersonaDefinition): {
  id: string;
  name: string;
  description: string;
  tags: string[];
  valid: boolean;
  invalidReason?: string | null;
  mtime: number;
} {
  return {
    id: definition.id,
    name: definition.name,
    description: definition.description,
    tags: [...definition.tags],
    valid: definition.valid,
    invalidReason: definition.invalidReason ?? null,
    mtime: definition.mtime,
  };
}

// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hanxustu (dsh-life-memory)
/**
 * 人格定义文件管理（v5 面板 CRUD 的 Host 实现，docs/26 §4）。
 *
 * 面板/工具通过这里的函数创建/编辑/删除 `persona.dir/<id>.md`；
 * 文件系统仍是人格定义的源，写完后由注册表 reload 生效（调用方负责）。
 *
 * 规则（与 src/persona/parser.ts 一致）：
 * - id：`^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`；
 * - 正文非空、不得包含完整 `{{…}}` 模板组；
 * - 删除不物理删除：移动到 `<dir>/.trash/<id>-<ts>.md`（可恢复）。
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { PersonaDefinition } from '../core/contracts.ts';
import {
  PERSONA_ID_RE,
  PERSONA_TEMPLATE_GROUP_RE,
  parsePersonaFile,
} from './parser.ts';

export interface PersonaFileInput {
  /** 人格 id（缺省由 name 生成 slug） */
  id?: string;
  name: string;
  description?: string;
  tags?: string[];
  aliases?: string[];
  /** 人格正文（system prompt） */
  body: string;
}

export interface PersonaFileUpdatePatch {
  name?: string;
  description?: string;
  tags?: string[];
  aliases?: string[];
  body?: string;
}

export interface PersonaFileOptions {
  /** personas 目录（config.persona.dir） */
  dir: string;
  now?: () => number;
  maxBodyChars?: number;
}

export interface PersonaFileResult {
  persona: PersonaDefinition;
  file: string;
}

export interface PersonaDeleteResult {
  id: string;
  deleted: boolean;
  backupFile: string;
}

export const PERSONA_TRASH_DIR = '.trash';

/** 由名称生成合法 id（保留 ASCII 字母数字/._-，其余转 -，压缩重复） */
export function slugifyPersonaId(name: string): string {
  const ascii = String(name ?? '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 64);
  return ascii.length > 0 ? ascii : `persona-${Date.now().toString(36)}`;
}

/** 生成 persona markdown 文本（frontmatter 使用最小 YAML 子集） */
export function renderPersonaMarkdown(input: {
  name: string;
  description?: string;
  tags?: string[];
  aliases?: string[];
  body: string;
}): string {
  const lines: string[] = ['---'];
  const name = String(input.name ?? '').trim();
  lines.push(`name: ${quoteYaml(name)}`);
  const description = String(input.description ?? '').trim();
  if (description.length > 0) lines.push(`description: ${quoteYaml(description)}`);
  const tags = normalizeStringList(input.tags);
  if (tags.length > 0) lines.push(`tags: [${tags.map(quoteYaml).join(', ')}]`);
  const aliases = normalizeStringList(input.aliases);
  if (aliases.length > 0) lines.push(`aliases: [${aliases.map(quoteYaml).join(', ')}]`);
  lines.push('---');
  lines.push(String(input.body ?? '').trim());
  lines.push('');
  return lines.join('\n');
}

/** 人格文件绝对路径 */
export function personaFilePath(dir: string, id: string): string {
  return join(dir, `${id}.md`);
}

/** 读取现有人格 markdown（用于 update 合并） */
function readPersonaFile(dir: string, id: string): string {
  const file = personaFilePath(dir, id);
  if (!existsSync(file)) {
    throw Object.assign(new Error(`persona not found: ${id}`), { code: 'E_PERSONA_NOT_FOUND', status: 404 });
  }
  return readFileSync(file, 'utf8');
}

/** 从现有人格定义中解析字段（复用 parser；无效文件也读取可识别字段） */
function parseExisting(dir: string, id: string, maxBodyChars: number): PersonaDefinition {
  const file = personaFilePath(dir, id);
  const content = readFileSync(file, 'utf8');
  const parsed = parsePersonaFile({ filePath: file, content, maxBodyChars, now: Date.now() });
  return parsed.definition;
}

function normalizeStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const trimmed = item.trim();
    if (trimmed.length > 0 && !out.includes(trimmed)) out.push(trimmed);
  }
  return out;
}

function quoteYaml(value: string): string {
  const trimmed = String(value ?? '').replace(/\r?\n/g, ' ').trim();
  if (trimmed.length === 0) return '""';
  if (/^[A-Za-z0-9\u4e00-\u9fa5][A-Za-z0-9\u4e00-\u9fa5 .,;:!?()（）/_-]*$/.test(trimmed) && !/^\s*[[{]/.test(trimmed)) {
    return trimmed;
  }
  return JSON.stringify(trimmed);
}

function validateId(id: string): void {
  if (typeof id !== 'string' || !PERSONA_ID_RE.test(id)) {
    throw Object.assign(new Error(`invalid persona id: ${JSON.stringify(id)}`), {
      code: 'E_BAD_REQUEST',
      status: 400,
    });
  }
}

function validateBody(body: string): string {
  const text = String(body ?? '').trim();
  if (text.length === 0) {
    throw Object.assign(new Error('persona body 不能为空'), { code: 'E_BAD_REQUEST', status: 400 });
  }
  const group = PERSONA_TEMPLATE_GROUP_RE.exec(text);
  if (group) {
    throw Object.assign(
      new Error(`persona body 不能包含完整 {{…}} 模板组（发现 ${group[0].slice(0, 40)}）`),
      { code: 'E_BAD_REQUEST', status: 400 },
    );
  }
  return text;
}

function writeFileAtomic(file: string, content: string): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, content, 'utf8');
  renameSync(tmp, file);
}

function parseAfterWrite(dir: string, id: string, maxBodyChars: number): PersonaDefinition {
  const file = personaFilePath(dir, id);
  const content = readFileSync(file, 'utf8');
  const parsed = parsePersonaFile({ filePath: file, content, maxBodyChars, now: Date.now() });
  if (!parsed.definition.valid) {
    throw Object.assign(new Error(`persona 写入后校验失败：${parsed.definition.invalidReason ?? 'unknown'}`), {
      code: 'E_BAD_REQUEST',
      status: 400,
    });
  }
  return parsed.definition;
}

/** 创建人格文件（id 已存在 → E_PERSONA_EXISTS/409） */
export function createPersonaFile(input: PersonaFileInput, options: PersonaFileOptions): PersonaFileResult {
  const dir = options.dir;
  const maxBodyChars = options.maxBodyChars ?? 20_000;
  const id = typeof input.id === 'string' && input.id.trim().length > 0 ? input.id.trim() : slugifyPersonaId(input.name);
  validateId(id);
  const body = validateBody(input.body);
  const file = personaFilePath(dir, id);
  if (existsSync(file)) {
    throw Object.assign(new Error(`persona already exists: ${id}`), { code: 'E_PERSONA_EXISTS', status: 409 });
  }
  mkdirSync(dir, { recursive: true });
  writeFileAtomic(
    file,
    renderPersonaMarkdown({
      name: input.name,
      description: input.description,
      tags: input.tags,
      aliases: input.aliases,
      body,
    }),
  );
  const persona = parseAfterWrite(dir, id, maxBodyChars);
  return { persona, file };
}

/** 更新人格文件（不存在 → E_PERSONA_NOT_FOUND/404） */
export function updatePersonaFile(id: string, patch: PersonaFileUpdatePatch, options: PersonaFileOptions): PersonaFileResult {
  const dir = options.dir;
  const maxBodyChars = options.maxBodyChars ?? 20_000;
  validateId(id);
  const existing = parseExisting(dir, id, maxBodyChars);
  const body = patch.body === undefined ? existing.body : validateBody(patch.body);
  const file = personaFilePath(dir, id);
  writeFileAtomic(
    file,
    renderPersonaMarkdown({
      name: patch.name === undefined ? existing.name : patch.name,
      description: patch.description === undefined ? existing.description : patch.description,
      tags: patch.tags === undefined ? existing.tags : patch.tags,
      aliases: patch.aliases === undefined ? existing.aliases : patch.aliases,
      body,
    }),
  );
  const persona = parseAfterWrite(dir, id, maxBodyChars);
  return { persona, file };
}

/** 删除人格文件（移动到 .trash/；不存在 → 404） */
export function deletePersonaFile(id: string, options: PersonaFileOptions): PersonaDeleteResult {
  const dir = options.dir;
  validateId(id);
  const file = personaFilePath(dir, id);
  if (!existsSync(file)) {
    throw Object.assign(new Error(`persona not found: ${id}`), { code: 'E_PERSONA_NOT_FOUND', status: 404 });
  }
  const trashDir = join(dir, PERSONA_TRASH_DIR);
  mkdirSync(trashDir, { recursive: true });
  const stamp = new Date((options.now ?? (() => Date.now()))()).toISOString().replace(/[:.]/g, '-');
  const backupFile = join(trashDir, `${id}-${stamp}.md`);
  renameSync(file, backupFile);
  return { id, deleted: true, backupFile };
}

/** 列出已存在的人格文件 id（不解析内容） */
export function listPersonaFileIds(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.md') && !entry.name.startsWith('.'))
      .map((entry) => entry.name.slice(0, -3))
      .filter((id) => PERSONA_ID_RE.test(id))
      .sort();
  } catch {
    return [];
  }
}

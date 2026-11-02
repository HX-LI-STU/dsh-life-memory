// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hanxustu (dsh-life-memory)
/**
 * 文本归一化 + 分词（FTS 影子列 / 嵌入 / 内容哈希共用）。
 *
 * docs/20 §7.4 与 §10.2 定义了**两套相关但不同**的切分规则，本模块分别实现，
 * 避免"一套 tokenizer 打天下"造成的检索/向量不一致：
 *
 *   1. `tokenizeTextSeg()` —— FTS 影子列 `text_seg` / `seg` 用（docs §7.4）：
 *        - 连续 CJK 段（\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af）：
 *          长度 1 输出该字；长度 ≥2 输出**全部相邻二元组**（"深色主题"→"深色 色主 主题"）；
 *        - 连续 [\p{L}\p{N}] 段：输出整词（小写；下划线不算词字符，故 dsh_life_memory → dsh memory vault）；
 *        - 其它字符（标点/空白/emoji）丢弃；
 *        - token 用单个空格连接。
 *      例：'我喜欢用深色主题，请默认 deep-mode'
 *          → '我喜 喜欢 欢用 用深 深色 色主 主题 请默 默认 deep mode'
 *      查询端用同一函数切分查询串，token 加引号后 AND 连接（0 命中再降级 OR）。
 *
 *   2. `tokenizeWeighted()` —— 本地嵌入 dsh-local-hash-v1 用（docs §10.2，保留权重类别）：
 *        - CJK 单字 token，kindWeight = 0.6；
 *        - CJK 相邻二元组 token，kindWeight = 1.0；
 *        - 连续 [\p{L}\p{N}] 整词 token，kindWeight = 1.0；
 *        - 词频 n，权重 w = kindWeight * (1 + ln(n))。
 *      注意与 text_seg 的区别：嵌入保留 CJK **单字**（低权重），text_seg 只在
 *      单字段落时输出单字。
 *
 * 归一化：
 *   - `normalizeForTextSeg` / `normalizeForContentHash`：NFKC → **拉丁字母小写**
 *     （docs 明确"拉丁小写"，不改动中文等非拉丁字符）→（内容哈希再：空白折叠、
 *     去首尾）→ 去首尾标点；
 *   - `normalizeForEmbedding`：NFKC → `toLowerCase()`（docs §10.2 步骤 1 原文）。
 *
 * 确定性：所有函数无随机、无时间依赖、不依赖 locale（不使用 localeCompare）。
 */

/** CJK 字符类（docs/20 §7.4 的 CJK_CHAR 原样，含日文假名与韩文音节） */
export const CJK_CHAR_CLASS = '\\u3040-\\u30ff\\u3400-\\u4dbf\\u4e00-\\u9fff\\uf900-\\ufaff\\uac00-\\ud7af';

const CJK_RUN_RE = new RegExp(`[${CJK_CHAR_CLASS}]+`, 'gu');
const CJK_CHAR_RE = new RegExp(`^[${CJK_CHAR_CLASS}]$`, 'u');
const WORD_RUN_RE = /[\p{L}\p{N}]+/gu;
const SCAN_TOKEN_RE = new RegExp(`([${CJK_CHAR_CLASS}]+)|([\\p{L}\\p{N}]+)`, 'gu');

/** 需要剔除的控制字符（保留可读空白，统一转成空格） */
const CONTROL_CHARS_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\ufeff]/g;
const WHITESPACE_RE = /\s+/g;
/** 首尾标点/符号（docs §6.2 content hash 的"去首尾标点"） */
const EDGE_PUNCT_RE = /^[\p{P}\p{S}\s]+|[\p{P}\p{S}\s]+$/gu;
const LATIN_SCRIPT_RE = /^\p{Script=Latin}$/u;

/** 拉丁字母小写（不改动中文/其它文字；docs §7.4 "拉丁小写"） */
export function lowerLatin(text: string): string {
  let out = '';
  for (const char of text) {
    out += LATIN_SCRIPT_RE.test(char) ? char.toLowerCase() : char;
  }
  return out;
}

/** 通用归一化：NFKC + 全小写 + 控制字符清理 + 空白折叠（不用于 L0 字节级契约） */
export function normalizeText(text: string): string {
  if (typeof text !== 'string' || text.length === 0) return '';
  let value = text.normalize('NFKC');
  value = value.replace(CONTROL_CHARS_RE, '');
  value = value.toLowerCase();
  value = value.replace(WHITESPACE_RE, ' ').trim();
  return value;
}

/** FTS 影子列归一化：NFKC → 拉丁小写（docs §7.4 原文） */
export function normalizeForTextSeg(text: string): string {
  if (typeof text !== 'string' || text.length === 0) return '';
  return lowerLatin(text.normalize('NFKC'));
}

/** 嵌入归一化：NFKC → toLowerCase（docs §10.2 步骤 1 原文） */
export function normalizeForEmbedding(text: string): string {
  if (typeof text !== 'string' || text.length === 0) return '';
  return text.normalize('NFKC').toLowerCase();
}

/**
 * 内容哈希归一化（docs §6.2 normalizeText）：
 * NFKC → 拉丁小写 → 空白折叠 → 去首尾空白 → 去首尾标点。
 */
export function normalizeForContentHash(text: string): string {
  if (typeof text !== 'string' || text.length === 0) return '';
  let value = lowerLatin(text.normalize('NFKC'));
  value = value.replace(CONTROL_CHARS_RE, '');
  value = value.replace(WHITESPACE_RE, ' ').trim();
  value = value.replace(EDGE_PUNCT_RE, '').trim();
  return value;
}

/**
 * text_seg token 列表（docs §7.4）：CJK 二元组/单字 + 拉丁数字整词。
 * 返回保留重复的数组（顺序 = 出现顺序）。
 */
export function tokenizeTextSeg(text: string): string[] {
  const normalized = normalizeForTextSeg(text);
  if (normalized.length === 0) return [];
  const tokens: string[] = [];
  for (const match of normalized.matchAll(SCAN_TOKEN_RE)) {
    const cjk = match[1];
    if (cjk !== undefined) {
      const chars = Array.from(cjk);
      if (chars.length === 1) {
        tokens.push(chars[0]);
      } else {
        for (let i = 0; i + 1 < chars.length; i += 1) tokens.push(chars[i] + chars[i + 1]);
      }
      continue;
    }
    const word = match[2];
    if (word !== undefined) tokens.push(word);
  }
  return tokens;
}

/** text_seg 文档串：token 用单个空格连接（供 raw_index.text_seg / memory_records.text_seg） */
export function textToTextSeg(text: string): string {
  return tokenizeTextSeg(text).join(' ');
}

/**
 * 通用 tokenize（兼容早期任务描述）：等价于 `tokenizeTextSeg`（FTS 侧）。
 * 嵌入请用 `tokenizeWeighted`，两者对 CJK 单字的处理不同。
 */
export function tokenize(text: string): string[] {
  return tokenizeTextSeg(text);
}

/** 带类别权重的 token（docs §10.2 步骤 2） */
export interface WeightedToken {
  token: string;
  /** CJK 单字 0.6 / CJK 二元组 1.0 / 整词 1.0 */
  kindWeight: number;
}

/**
 * 嵌入用加权 token 列表（docs §10.2）：CJK 单字（0.6）+ CJK 二元组（1.0）+ 整词（1.0）。
 * 保留重复，顺序 = 出现顺序（词频由调用方按 token 归并）。
 */
export function tokenizeWeighted(text: string): WeightedToken[] {
  const normalized = normalizeForEmbedding(text);
  if (normalized.length === 0) return [];
  const tokens: WeightedToken[] = [];
  for (const match of normalized.matchAll(SCAN_TOKEN_RE)) {
    const cjk = match[1];
    if (cjk !== undefined) {
      const chars = Array.from(cjk);
      for (const char of chars) tokens.push({ token: char, kindWeight: 0.6 });
      for (let i = 0; i + 1 < chars.length; i += 1) {
        tokens.push({ token: chars[i] + chars[i + 1], kindWeight: 1.0 });
      }
      continue;
    }
    const word = match[2];
    if (word !== undefined) tokens.push({ token: word, kindWeight: 1.0 });
  }
  return tokens;
}

/** FTS5 文档串 -> MATCH 表达式用的去重 token（保持首次出现顺序） */
export function uniqueTokens(tokens: readonly string[]): string[] {
  return [...new Set(tokens)];
}

/** 原始文本 -> FTS5 文档串（text_seg） */
export function textToFtsText(text: string): string {
  return textToTextSeg(text);
}

/** token 数组 -> 空格连接文档串 */
export function tokensToFtsText(tokens: readonly string[]): string {
  return tokens.join(' ');
}

// ---------------------------------------------------------------------------
// token 估算 / 截断（system prompt 预算用，不属于 L0 字节契约）
// ---------------------------------------------------------------------------

/** token 数量估算系数：拉丁单词 ≈ 1.3 token */
export const LATIN_WORD_TOKEN_ESTIMATE = 1.3;
/** token 数量估算系数：单个汉字 ≈ 1 token */
export const CJK_CHAR_TOKEN_ESTIMATE = 1;

/** 单个字符是否是 CJK（供 truncate/estimate 快速判断） */
export function isCjkChar(char: string): boolean {
  return CJK_CHAR_RE.test(char);
}

/**
 * 估算文本 token 数：汉字 ≈ 1 token/字，拉丁/数字词 ≈ 1.3 token/词，其它 ≈ 0。
 * 只用于 prompt 预算裁剪，不追求与模型分词器一致。
 */
export function estimateTokens(text: string): number {
  if (typeof text !== 'string' || text.length === 0) return 0;
  const normalized = normalizeText(text);
  if (normalized.length === 0) return 0;
  let cjkChars = 0;
  let latinWords = 0;
  let inWord = false;
  for (const char of normalized) {
    if (CJK_CHAR_RE.test(char)) {
      cjkChars += 1;
      inWord = false;
    } else if (/^[\p{L}\p{N}]$/u.test(char)) {
      if (!inWord) {
        latinWords += 1;
        inWord = true;
      }
    } else {
      inWord = false;
    }
  }
  return Math.ceil(cjkChars * CJK_CHAR_TOKEN_ESTIMATE + latinWords * LATIN_WORD_TOKEN_ESTIMATE);
}

/**
 * 按估算 token 预算截断文本（保留原文可用部分，不添加省略号）。
 * - maxTokens <= 0 => 空串；
 * - 优先在字符边界截断；末尾空白会被 trim；
 * - 确定性，用于 system prompt 注入预算。
 */
export function truncateToTokens(text: string, maxTokens: number): string {
  if (typeof text !== 'string' || text.length === 0) return '';
  if (!Number.isFinite(maxTokens) || maxTokens <= 0) return '';
  let used = 0;
  let cutOffset = 0;
  let inWord = false;
  for (const char of text) {
    let cost = 0;
    if (CJK_CHAR_RE.test(char)) {
      cost = CJK_CHAR_TOKEN_ESTIMATE;
      inWord = false;
    } else if (/^[\p{L}\p{N}]$/u.test(char)) {
      if (!inWord) {
        cost = LATIN_WORD_TOKEN_ESTIMATE;
        inWord = true;
      }
    } else {
      inWord = false;
    }
    if (used + cost > maxTokens) break;
    used += cost;
    cutOffset += char.length;
  }
  return text.slice(0, cutOffset).trimEnd();
}

/** 仅用于测试/调试：列出 CJK 段（返回连续 CJK 子串） */
export function cjkRuns(text: string): string[] {
  return text.normalize('NFKC').match(CJK_RUN_RE) ?? [];
}

/** 普通单词段（[\p{L}\p{N}]+，不含 CJK；用于调试） */
export function wordRuns(text: string): string[] {
  const normalized = normalizeForTextSeg(text);
  return normalized.match(WORD_RUN_RE)?.filter((word) => !CJK_CHAR_RE.test(word)) ?? [];
}

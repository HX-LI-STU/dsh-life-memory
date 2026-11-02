// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hanxustu (dsh-life-memory)
/**
 * Store 内部工具：向量 BLOB 编解码、FTS5 MATCH 构造、heat 公式、JSON/数值校验。
 *
 * 与 docs/20 的对应：
 *   - §7.5 向量：Float32 小端 BLOB，dim*4 字节；写入前 L2 归一化；
 *   - §7.4 中文 FTS：MATCH 由 text_seg token 加引号后 AND 连接，0 命中降级 OR；
 *   - §4.3 heat 公式：0.35*recency + 0.25*freq + 0.30*importance + 0.10*recurrence。
 */

/** 每层 heat 的 recency 半衰期（天，docs §4.3） */
export const HEAT_HALF_LIFE_DAYS: Readonly<Record<string, number>> = {
  L1: 1,
  L2: 14,
  L3: 90,
};

/** 默认半衰期（扩展层未配置时） */
export const DEFAULT_HEAT_HALF_LIFE_DAYS = 30;

/** 0..1 截断 */
export function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

/** Float32Array -> 小端 float32 BLOB（dim*4 字节） */
export function float32ToBlob(vec: Float32Array): Uint8Array {
  const bytes = new Uint8Array(vec.length * 4);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < vec.length; i += 1) {
    view.setFloat32(i * 4, vec[i], true);
  }
  return bytes;
}

/** 小端 float32 BLOB -> Float32Array（复制一份，避免 SQLite 复用缓冲区） */
export function blobToFloat32(blob: Uint8Array): Float32Array {
  if (blob.byteLength % 4 !== 0) {
    throw new Error(`[dsh-life-memory] store: vector BLOB length ${blob.byteLength} is not a multiple of 4`);
  }
  const copy = new Uint8Array(blob.byteLength);
  copy.set(blob);
  const view = new DataView(copy.buffer);
  const out = new Float32Array(blob.byteLength / 4);
  for (let i = 0; i < out.length; i += 1) out[i] = view.getFloat32(i * 4, true);
  return out;
}

/** L2 范数 */
export function vectorNorm(vec: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < vec.length; i += 1) sum += vec[i] * vec[i];
  return Math.sqrt(sum);
}

/** 校验向量：有限数值且长度 = dim */
export function validateVector(vec: Float32Array, dim: number, label: string): void {
  if (!(vec instanceof Float32Array)) {
    throw new TypeError(`[dsh-life-memory] store: ${label} must be a Float32Array`);
  }
  if (!Number.isSafeInteger(dim) || dim <= 0) {
    throw new RangeError(`[dsh-life-memory] store: ${label} dim must be a positive integer`);
  }
  if (vec.length !== dim) {
    throw new RangeError(
      `[dsh-life-memory] store: ${label} length ${vec.length} does not match dim ${dim}`,
    );
  }
  for (let i = 0; i < vec.length; i += 1) {
    if (!Number.isFinite(vec[i])) {
      throw new RangeError(`[dsh-life-memory] store: ${label} has non-finite value at index ${i}`);
    }
  }
}

/** 就地 L2 归一化（零向量返回全零，不抛错） */
export function normalizeVector(vec: Float32Array): Float32Array {
  const norm = vectorNorm(vec);
  if (norm === 0) return new Float32Array(vec.length);
  const out = new Float32Array(vec.length);
  for (let i = 0; i < vec.length; i += 1) out[i] = vec[i] / norm;
  return out;
}

/** FTS5 token 加引号（token 来自 tokenizeTextSeg，只含字母/数字/CJK，无引号） */
export function quoteFtsToken(token: string): string {
  return `"${token.replace(/"/g, '""')}"`;
}

/** AND 表达式：`"深色" "色主" "主题"`（FTS5 中相邻短语即隐式 AND） */
export function buildAndMatch(tokens: readonly string[]): string {
  return tokens.map(quoteFtsToken).join(' ');
}

/** OR 表达式：`"深色" OR "色主"` */
export function buildOrMatch(tokens: readonly string[]): string {
  return tokens.map(quoteFtsToken).join(' OR ');
}

/** 待检索 token 规范化：去重、去空、上限 32 个（防超长 MATCH 表达式） */
export function normalizeFtsTokens(tokens: readonly string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const token of tokens) {
    if (typeof token !== 'string' || token.length === 0) continue;
    if (seen.has(token)) continue;
    seen.add(token);
    out.push(token);
    if (out.length >= 32) break;
  }
  return out;
}

/** heat 计算输入 */
export interface HeatInput {
  layer: string;
  importance: number;
  /** 最近访问时间（无访问时用 updated_at） */
  lastAccessAt: number | null;
  updatedAt: number;
  accessCount: number;
  sourceCount: number;
  now: number;
}

/**
 * docs §4.3 heat 公式：
 *   heat = 0.35*recency + 0.25*freq + 0.30*importance + 0.10*recurrence
 *   recency = 0.5^(ageDays/halfLife)；freq = min(1, log1p(accessCount)/log1p(20))；
 *   recurrence = min(1, distinctSourceRawIds/5)。
 */
export function computeHeat(input: HeatInput): number {
  const halfLife = HEAT_HALF_LIFE_DAYS[input.layer] ?? DEFAULT_HEAT_HALF_LIFE_DAYS;
  const reference = input.lastAccessAt ?? input.updatedAt;
  const ageDays = Math.max(0, input.now - reference) / 86_400_000;
  const recency = Math.pow(0.5, ageDays / halfLife);
  const freq = Math.min(1, Math.log1p(Math.max(0, input.accessCount)) / Math.log1p(20));
  const recurrence = Math.min(1, Math.max(0, input.sourceCount) / 5);
  return clamp01(0.35 * recency + 0.25 * freq + 0.3 * clamp01(input.importance) + 0.1 * recurrence);
}

/** 安全 JSON.parse 数组（DB 内 *_json 列） */
export function parseJsonArray<T>(text: string | null | undefined, fallback: T[] = []): T[] {
  if (typeof text !== 'string' || text.length === 0) return [...fallback];
  try {
    const parsed: unknown = JSON.parse(text);
    return Array.isArray(parsed) ? (parsed as T[]) : [...fallback];
  } catch {
    return [...fallback];
  }
}

/** 安全 JSON.parse 对象（DB 内 meta_json 列） */
export function parseJsonObject(
  text: string | null | undefined,
  fallback: Record<string, unknown> = {},
): Record<string, unknown> {
  if (typeof text !== 'string' || text.length === 0) return { ...fallback };
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return { ...fallback };
  } catch {
    return { ...fallback };
  }
}

/** 字符串数组 -> JSON 列 */
export function stringifyJsonArray(values: readonly string[] | undefined | null): string {
  return JSON.stringify(values ?? []);
}

/** 对象 -> JSON 列 */
export function stringifyJsonObject(value: Record<string, unknown> | undefined | null): string {
  if (value === undefined || value === null) return '{}';
  return JSON.stringify(value);
}

/** LIKE 模式转义（用于 CJK 极短查询的降级检索） */
export function escapeLikePattern(text: string): string {
  return text.replace(/[\\%_]/g, (char) => `\\${char}`);
}

// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hanxustu (dsh-life-memory)
/**
 * 派生层共享工具（L1/L2/L3 共用）。
 *
 * 全部函数都是**确定性纯函数**：不读时钟、不用随机数、不依赖 locale 比较；
 * 时间只接受调用方显式传入的 ts/now（来自派生上下文的 now 或 raw.ts），
 * 因此同一批 L0 输入在 rebuild 时能得到逐字节相同的派生文本（docs/20 §9.4）。
 */
import type { MemoryVaultConfig, RawRecord } from '../core/contracts.ts';
import { dateInTimeZone } from '../core/time.ts';
import { tokenizeTextSeg } from '../core/text.ts';

/** 内置层 id */
export const L1_LAYER_ID = 'L1' as const;
export const L2_LAYER_ID = 'L2' as const;
export const L3_LAYER_ID = 'L3' as const;

/** L3 代际重建计数在 meta 表的键（docs/20 §9.7 代际重建；层内私有约定） */
export const L3_REBUILD_GENERATION_KEY = 'l3.rebuildGeneration';

/** 数值裁剪到 [0,1]（NaN 归 0） */
export function clamp01(value: number): number {
  if (typeof value !== 'number' || Number.isNaN(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/** 字符串比较（不依赖 localeCompare，保证跨平台/跨语言一致） */
export function compareStrings(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/** 提取错误信息（不把整个 Error 对象写进结果，避免泄漏 payload） */
export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

/**
 * 派生文本规范化（docs/20 §9.2 "抽取文本规范化"）：
 * NFKC → 去控制字符（NUL 等；保留可读空白并折叠）→ 去首尾空白。
 * **保留原始标点与大小写**（供引用/证据校验），不做小写化。
 */
export function normalizeDerivedText(text: string | null | undefined): string {
  if (typeof text !== 'string' || text.length === 0) return '';
  let value = text.normalize('NFKC');
  // 控制字符（保留 \n\t 的可读性统一转空格），docs §8.1 text 不得含控制字符
  value = value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\ufeff]/g, ' ');
  value = value.replace(/\s+/g, ' ').trim();
  return value;
}

/** 按字符数截断（返回是否截断；不添加省略号，调用方记 meta.truncated） */
export function truncateChars(text: string, maxChars: number): { text: string; truncated: boolean } {
  if (typeof text !== 'string') return { text: '', truncated: false };
  if (!Number.isFinite(maxChars) || maxChars <= 0) return { text: '', truncated: text.length > 0 };
  if (text.length <= maxChars) return { text, truncated: false };
  return { text: text.slice(0, maxChars), truncated: true };
}

/** 取文本前 N 个字符（规范化空白后；不添加省略号，确定性模板用） */
export function firstChars(text: string, maxChars: number): string {
  if (typeof text !== 'string' || text.length === 0) return '';
  if (!Number.isFinite(maxChars) || maxChars <= 0) return '';
  return text.slice(0, maxChars).trim();
}

/** 去重保序地并入数组（原地修改，返回同一数组） */
export function pushUnique<T>(target: T[], items: Iterable<T>): T[] {
  for (const item of items) {
    if (!target.includes(item)) target.push(item);
  }
  return target;
}

/** 标签去重/清理：只保留非空字符串、去重、保序、最多 max 个 */
export function normalizeTags(tags: readonly string[] | undefined, max = 32): string[] {
  const out: string[] = [];
  for (const tag of tags ?? []) {
    if (typeof tag !== 'string') continue;
    const value = tag.trim();
    if (value.length === 0 || out.includes(value)) continue;
    out.push(value);
    if (out.length >= max) break;
  }
  return out;
}

// ---------------------------------------------------------------------------
// 时间 / 路径
// ---------------------------------------------------------------------------

/** 时间戳 → 配置时区的本地日期 YYYY-MM-DD（docs/20 §9.4 模板的 {day}） */
export function dayString(ts: number, timezone: string): string {
  const tz = timezone && timezone.length > 0 ? timezone : 'UTC';
  try {
    return dateInTimeZone(ts, tz);
  } catch {
    return new Date(ts).toISOString().slice(0, 10);
  }
}

/** 路径 basename（同时接受 Windows/posix 分隔符；不再做其它规范化） */
export function basenameOf(path: string | null | undefined): string | null {
  if (typeof path !== 'string' || path.length === 0) return null;
  const parts = path.split(/[\\/]+/).filter((part) => part.length > 0);
  return parts.length > 0 ? parts[parts.length - 1] : null;
}

/** 天数差（now - ts，单位天；负数归 0） */
export function ageDays(now: number, ts: number): number {
  const delta = now - ts;
  if (!Number.isFinite(delta) || delta <= 0) return 0;
  return delta / 86_400_000;
}

// ---------------------------------------------------------------------------
// 相似度 / 关键词（L2 摘要与近重复判定用）
// ---------------------------------------------------------------------------

/** 字符 3-gram 集合（先规范化空白；空文本返回空集合） */
export function char3gramSet(text: string): Set<string> {
  const normalized = normalizeDerivedText(text);
  const grams = new Set<string>();
  if (normalized.length === 0) return grams;
  if (normalized.length <= 3) {
    grams.add(normalized);
    return grams;
  }
  for (let i = 0; i + 3 <= normalized.length; i += 1) grams.add(normalized.slice(i, i + 3));
  return grams;
}

/** 字符 3-gram Jaccard 相似度（docs/20 §9.2.3-6 近重复判定，阈值 0.8） */
export function jaccard3gram(a: string, b: string): number {
  const setA = char3gramSet(a);
  const setB = char3gramSet(b);
  if (setA.size === 0 && setB.size === 0) return 1;
  if (setA.size === 0 || setB.size === 0) return 0;
  let intersection = 0;
  for (const gram of setA) {
    if (setB.has(gram)) intersection += 1;
  }
  return intersection / (setA.size + setB.size - intersection);
}

/** 中文/英文停用词（关键词抽取时剔除；确定性固定表） */
const STOPWORDS = new Set<string>([
  // 英文
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'to', 'of', 'and', 'or', 'in', 'on', 'for',
  'with', 'that', 'this', 'it', 'as', 'at', 'by', 'from', 'we', 'i', 'you', 'he', 'she', 'they', 'me', 'my',
  'our', 'your', 'not', 'no', 'do', 'does', 'did', 'so', 'if', 'then', 'than', 'too', 'very', 'can', 'could',
  'should', 'would', 'will', 'just', 'about', 'into', 'over', 'after', 'before', 'also', 'there', 'here',
  'what', 'when', 'where', 'which', 'who', 'how', 'why', 'use', 'using', 'used', 'please', 'want', 'need',
  // 中文（tokenizeTextSeg 产出的 CJK 二元组/单字）
  '我们', '你们', '他们', '她们', '它们', '什么', '这个', '那个', '这些', '那些', '可以', '就是', '不是',
  '没有', '然后', '因为', '所以', '现在', '一个', '这样', '怎么', '如果', '但是', '还是', '已经', '需要',
  '进行', '使用', '一下', '时候', '而且', '或者', '应该', '可能', '自己', '大家', '以及', '关于', '通过',
  '由于', '为了', '其实', '如何', '哪个', '哪里', '为什么', '是否', '之后', '之前', '一些', '这种', '那种',
  '这里', '那里', '知道', '觉得', '希望', '比较', '非常', '还是', '还有', '只是', '不过', '当然',
  // 单字虚词
  '的', '了', '是', '我', '你', '他', '她', '它', '在', '和', '就', '也', '都', '而', '及', '与', '或',
  '把', '被', '让', '给', '对', '从', '到', '为', '以', '等', '这', '那', '有', '不', '很', '会', '要',
  '能', '可', '说', '吗', '呢', '吧', '啊', '哦', '嗯', '着', '过', '得', '地', '还', '又', '再',
]);

/**
 * 窗口内 TF 关键词 Top N（docs/20 §9.4-2）。
 * 确定性排序：词频降序 → 首次出现位置升序；剔除停用词与单字符拉丁词。
 */
export function topKeywords(texts: readonly string[], limit: number): string[] {
  if (!Array.isArray(texts) || texts.length === 0 || limit <= 0) return [];
  const counts = new Map<string, { count: number; firstIndex: number }>();
  let index = 0;
  for (const text of texts) {
    if (typeof text !== 'string' || text.length === 0) continue;
    for (const token of tokenizeTextSeg(text)) {
      if (token.length === 0 || STOPWORDS.has(token)) continue;
      const isCjk = /^[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]+$/u.test(token);
      if (!isCjk && token.length < 2) continue;
      const entry = counts.get(token);
      if (entry) entry.count += 1;
      else counts.set(token, { count: 1, firstIndex: index });
      index += 1;
    }
  }
  return [...counts.entries()]
    .sort((a, b) => b[1].count - a[1].count || a[1].firstIndex - b[1].firstIndex || compareStrings(a[0], b[0]))
    .slice(0, Math.max(1, limit))
    .map(([token]) => token);
}

// ---------------------------------------------------------------------------
// 重要度启发式（docs/20 §9.3，确定性 0..1）
// ---------------------------------------------------------------------------

/** 强调/决策/偏好类标记词（docs §9.3 hasMarker） */
const MARKER_RE =
  /记住|决定|偏好|别用|不要用|必须|一定要|重要|别忘了|以后都|请记住|record|remember|prefer|always|never|decided|decision|must|important/i;

/** 显式记忆请求（docs §9.3 isExplicitRemember） */
const EXPLICIT_REMEMBER_RE = /记住|请记住|记一下|记录一下|别忘了|保存到记忆|备忘|remember\s+(that\s+)?|note\s+(that\s+)?|don'?t\s+forget|keep\s+in\s+mind|save\s+(this|that)/i;

/** 实体/路径/版本号迹象（docs §9.3 hasEntityOrPathOrVersion） */
const ENTITY_RE =
  /[A-Za-z]:\\[^\s"']+|\/[\w.-]+\/[\w./-]+|\b\d+\.\d+(\.\d+)?\b|\bv?\d+\.\d+\.\d+\b|[\w.-]+@[\w.-]+|https?:\/\/\S+|\b[A-Z][A-Za-z0-9_]{2,}\b/;

/** 工具噪声迹象（超长/纯日志/重复行；docs §9.3 isToolNoise） */
export function isToolNoise(text: string): boolean {
  if (typeof text !== 'string' || text.length === 0) return false;
  if (text.length > 5000) return true;
  const lines = text.split(/\r?\n/);
  if (lines.length >= 8) {
    const unique = new Set(lines.map((line) => line.trim()));
    if (unique.size / lines.length < 0.3) return true;
  }
  return /^\s*(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}|\[?(trace|debug|info|warn|error)\]?)/i.test(text);
}

/** 是否含强调/决策/偏好标记词 */
export function hasImportantMarker(text: string): boolean {
  return typeof text === 'string' && MARKER_RE.test(text);
}

/** 是否是显式"记住"请求 */
export function isExplicitRemember(text: string): boolean {
  return typeof text === 'string' && EXPLICIT_REMEMBER_RE.test(text);
}

/** 是否含实体/路径/版本号 */
export function hasEntityOrPathOrVersion(text: string): boolean {
  return typeof text === 'string' && ENTITY_RE.test(text);
}

export interface ImportanceOptions {
  /** 是否用户消息（+0.10） */
  isUserMessage?: boolean;
  /** 是否长期压缩前原文（compaction 基线已含，此处不再加） */
  isToolNoise?: boolean;
}

/**
 * 通用重要度打分（docs §9.3）：
 * `importance = clamp01(base + 0.10*isUserMessage + 0.10*hasMarker + 0.05*isLongText
 *   + 0.10*isExplicitRemember + 0.05*hasEntityOrPathOrVersion - 0.10*isToolNoise)`
 * base 由各层按 §9.2.1 / §8.2 给出。
 */
export function scoreImportance(base: number, text: string, options: ImportanceOptions = {}): number {
  let value = Number.isFinite(base) ? base : 0.3;
  if (options.isUserMessage === true) value += 0.1;
  if (hasImportantMarker(text)) value += 0.1;
  if (typeof text === 'string' && text.length > 200) value += 0.05;
  if (isExplicitRemember(text)) value += 0.1;
  if (hasEntityOrPathOrVersion(text)) value += 0.05;
  if (options.isToolNoise === true || isToolNoise(text)) value -= 0.1;
  return clamp01(value);
}

// ---------------------------------------------------------------------------
// heat 晋升评分（docs/20 §4.3，统一公式；实现必须一致）
// ---------------------------------------------------------------------------

/** 各层 heat 的 recency 半衰期（天；docs §4.3：L1 1d / L2 14d / L3 90d） */
export const HEAT_HALF_LIFE_DAYS: Record<string, number> = { L1: 1, L2: 14, L3: 90 };

export interface HeatInput {
  now: number;
  updatedAt: number;
  accessCount?: number;
  importance: number;
  distinctSourceCount?: number;
  halfLifeDays: number;
}

/**
 * `heat = 0.35*recency + 0.25*freq + 0.30*importance + 0.10*recurrence`
 * - recency = 0.5^(ageDays/halfLifeDays)
 * - freq = min(1, log1p(accessCount)/log1p(20))
 * - recurrence = min(1, distinctSourceRawIds/5)
 */
export function computeHeat(input: HeatInput): number {
  const halfLife = Number.isFinite(input.halfLifeDays) && input.halfLifeDays > 0 ? input.halfLifeDays : 14;
  const recency = 0.5 ** (ageDays(input.now, input.updatedAt) / halfLife);
  const accessCount = Number.isFinite(input.accessCount) && (input.accessCount ?? 0) > 0 ? (input.accessCount as number) : 0;
  const freq = Math.min(1, Math.log1p(accessCount) / Math.log1p(20));
  const recurrence = Math.min(1, Math.max(0, input.distinctSourceCount ?? 0) / 5);
  return clamp01(0.35 * recency + 0.25 * freq + 0.3 * clamp01(input.importance) + 0.1 * recurrence);
}

/** 层 heat 半衰期（未知层默认 30 天） */
export function heatHalfLifeFor(layer: string): number {
  return HEAT_HALF_LIFE_DAYS[layer] ?? 30;
}

// ---------------------------------------------------------------------------
// raw 辅助
// ---------------------------------------------------------------------------

/** raw.tags 是否包含某标签（精确匹配） */
export function rawHasTag(raw: RawRecord, tag: string): boolean {
  return Array.isArray(raw.tags) && raw.tags.includes(tag);
}

/** 取 raw.tags 中形如 `prefix:value` 的第一个 value */
export function rawTagValue(raw: RawRecord, prefix: string): string | null {
  if (!Array.isArray(raw.tags)) return null;
  for (const tag of raw.tags) {
    if (typeof tag === 'string' && tag.startsWith(prefix)) return tag.slice(prefix.length);
  }
  return null;
}

/** raw.payload 视为对象（安全转换） */
export function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

/** 安全取字符串字段 */
export function asString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** 按 raw.seq 升序排序（确定性；不修改入参） */
export function sortRawsBySeq(raws: readonly RawRecord[]): RawRecord[] {
  return [...raws].sort((a, b) => a.seq - b.seq);
}

/** 配置时区（空则 UTC；仅供展示/日期编号，取不到时回退 UTC） */
export function configTimezone(config: MemoryVaultConfig): string {
  const tz = config.timezone;
  return typeof tz === 'string' && tz.length > 0 ? tz : 'UTC';
}

// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hanxustu (dsh-life-memory)
/**
 * 原始记录 / 派生记忆的 id 规则。
 *
 * 原始记录 id（L0，不可变，docs/20 §6.2）：
 *   `YYYY-MM-DD-NNNNNN`
 *   - 日期 = 记录发生时刻在**配置时区（config.timezone）**中的本地日期；
 *   - NNNNNN = 当日分配序号，从 1 开始、零填充到 6 位（同一天内单调递增）；
 *   - 溢出规则：当日 > 999,999 条时数字变为 7 位（id 字典序不再等于时序；
 *     排序必须用 seq，id 仅作展示/引用）；
 *   - 与全局 seq（从 1 递增、永不复用）分开：seq 决定全库顺序，daySeq 只决定 id。
 *
 * 派生记忆 id（L1+，可由其它实现复用，docs/20 §6.2 / §8.1）：
 *   `<layer>-<kind>-<base36(createdAtMs)>-<hex8>`
 *   - 契约示例与 §8.1 校验正则：`^(L[0-9]+|[a-z][a-z0-9-]*)-[a-z_]+-[0-9a-z]+-[0-9a-f]{8}$`；
 *   - 本实现用 contentHash 前 8 位（而不是 randomUUID）保证**确定性**：
 *     相同输入重建得到相同 id，便于派生层 rebuild 幂等（见 Lead 契约说明）。
 */

import type { LayerId, MemoryKind, RawKind } from './contracts.ts';
import { shortHash } from './hash.ts';

/** 当日序号最小宽度（6 位；溢出时自然变长） */
export const RAW_ID_SEQ_WIDTH = 6;

/** 原始记录 id 形状校验：`YYYY-MM-DD-NNNNNN`（≥6 位当日序号，允许溢出到 7+ 位） */
export const RAW_ID_RE: RegExp = /^\d{4}-\d{2}-\d{2}-\d{6,}$/;

const RAW_ID_PARTS_RE = /^(\d{4}-\d{2}-\d{2})-(\d{6,})$/;

/** 派生记忆 id 形状校验（docs/20 §8.1） */
export const MEMORY_ID_RE: RegExp = /^(L[0-9]+|[a-z][a-z0-9-]*)-[a-z_]+-[0-9a-z]+-[0-9a-f]{8}$/;

/** 原始记录 id 结构 */
export interface RawIdParts {
  /** 本地日期 YYYY-MM-DD */
  date: string;
  /** 当日序号（从 1 开始） */
  daySeq: number;
}

/** 已知的原始记录种类（与契约 RawKind 同步，用于输入校验） */
export const RAW_KINDS: readonly RawKind[] = [
  'session',
  'turn',
  'user',
  'assistant',
  'tool_call',
  'tool_result',
  'system',
  'compaction',
  'event',
  'note',
];

const RAW_KIND_SET: ReadonlySet<string> = new Set(RAW_KINDS);

/** 类型守卫：是否合法 RawKind */
export function isRawKind(value: unknown): value is RawKind {
  return typeof value === 'string' && RAW_KIND_SET.has(value);
}

/**
 * 组装原始记录 id。
 * @throws RangeError 日期形状非法或 daySeq < 1
 */
export function formatRawId(date: string, daySeq: number): string {
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new RangeError(`[dsh-life-memory] formatRawId: invalid date ${String(date)}`);
  }
  if (!Number.isSafeInteger(daySeq) || daySeq < 1) {
    throw new RangeError(
      `[dsh-life-memory] formatRawId: daySeq must be a positive safe integer, got ${String(daySeq)}`,
    );
  }
  // 超过 6 位时自然变长（docs/20 §6.2 溢出规则）
  return `${date}-${String(daySeq).padStart(RAW_ID_SEQ_WIDTH, '0')}`;
}

/** 解析原始记录 id；形状非法返回 null */
export function parseRawId(id: string): RawIdParts | null {
  if (typeof id !== 'string') return null;
  const match = RAW_ID_PARTS_RE.exec(id);
  if (match === null) return null;
  const daySeq = Number(match[2]);
  if (!Number.isInteger(daySeq) || daySeq < 1) return null;
  return { date: match[1], daySeq };
}

/** 是否形如合法原始记录 id */
export function isRawId(id: string): boolean {
  return parseRawId(id) !== null;
}

/** 取原始 id 的日期部分；非法返回 null */
export function rawIdDate(id: string): string | null {
  return parseRawId(id)?.date ?? null;
}

/** 下一个当日序号（首次为 1；永不复用已分配序号） */
export function nextDaySequence(previousDaySeq: number | undefined | null): number {
  const prev = typeof previousDaySeq === 'number' && Number.isInteger(previousDaySeq) ? previousDaySeq : 0;
  return prev + 1;
}

const SAFE_ID_SEGMENT_RE = /[^A-Za-z0-9_]/g;

function sanitizeIdSegment(value: string): string {
  return value.replace(SAFE_ID_SEGMENT_RE, '-');
}

/**
 * 派生记忆 id：`<layer>-<kind>-<base36(ts)>-<contentHash 前 8 位>`。
 * 例：`deriveMemoryId('L3', 'fact', Date.now(), sha256hex(...))`。
 * 纯函数、确定性；同一 (layer, kind, ts, contentHash) 永远得到同一 id。
 */
export function deriveMemoryId(
  layer: LayerId,
  kind: MemoryKind | string,
  ts: number,
  contentHash: string,
): string {
  if (typeof layer !== 'string' || layer.length === 0) {
    throw new TypeError('[dsh-life-memory] deriveMemoryId: layer must be a non-empty string');
  }
  if (typeof kind !== 'string' || kind.length === 0) {
    throw new TypeError('[dsh-life-memory] deriveMemoryId: kind must be a non-empty string');
  }
  if (!Number.isFinite(ts) || ts < 0) {
    throw new RangeError(`[dsh-life-memory] deriveMemoryId: invalid ts ${String(ts)}`);
  }
  if (typeof contentHash !== 'string' || contentHash.length === 0) {
    throw new TypeError('[dsh-life-memory] deriveMemoryId: contentHash must be a non-empty string');
  }
  return `${sanitizeIdSegment(layer)}-${sanitizeIdSegment(kind)}-${Math.floor(ts).toString(36)}-${shortHash(contentHash, 8)}`;
}

/** 派生记忆 id 结构 */
export interface MemoryIdParts {
  layer: string;
  kind: string;
  /** base36 毫秒时间戳还原值 */
  ts: number;
  hash8: string;
}

/** 解析派生记忆 id；不符合 `<layer>-<kind>-<base36>-<hash8>` 时返回 null */
export function parseMemoryId(id: string): MemoryIdParts | null {
  if (typeof id !== 'string' || !MEMORY_ID_RE.test(id)) return null;
  const parts = id.split('-');
  if (parts.length !== 4) return null;
  const [layer, kind, time36, hash8] = parts;
  if (!layer || !kind) return null;
  const ts = Number.parseInt(time36, 36);
  if (!Number.isSafeInteger(ts) || ts <= 0) return null;
  return { layer, kind, ts, hash8 };
}

/** 是否是合法的派生记忆 id（docs/20 §8.1 正则） */
export function isMemoryId(id: unknown): id is string {
  return typeof id === 'string' && MEMORY_ID_RE.test(id);
}

// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hanxustu (dsh-life-memory)
/**
 * `manifest.json` 的形状、校验与派生工具（docs/20 §5.3）。
 *
 * manifest 是**可重建缓存**，不是事实来源：
 *   - 每次 append 成功 fsync 段文件后，原子替换写 manifest（tmp + fsync + rename）；
 *   - 崩溃/损坏/缺失时从段文件重扫重建（见 RawVaultImpl）；
 *   - 记录字段 docs §5.3：`{formatVersion, vaultId, updatedAt, segments:[{segment, day,
 *     writerId, records, bytes, headHash, tailHash, sealed}], stats:{records, days, bytes}}`。
 *
 * 额外缓存字段（本实现追加，供 O(1) 打开；docs §5.3 的字段全部保留原样）：
 *   - `segments[].firstSeq` / `lastSeq`：与 raw_segments 表列一致，用于快速求链尾与排序；
 *   - `lastSeq` / `lastHash`：哈希链尾；
 *   - `days`：每个本地日期已分配的最大当日序号（daySeq），用于下一次 id 分配。
 * 这些字段缺失/不一致时触发重建，不影响正确性。
 */

import { GENESIS_HASH } from '../core/contracts.ts';
import type {
  VaultManifest as ContractVaultManifest,
  VaultSegmentInfo,
} from '../core/contracts.ts';
import { isSha256Hex } from '../core/hash.ts';
import { isDateString } from '../core/time.ts';
import { parseSegmentRelativePath } from './layout.ts';

/** manifest 格式版本 */
export const MANIFEST_FORMAT_VERSION = 1 as const;

/**
 * manifest 中的段条目：contracts.ts 的 VaultSegmentInfo + firstSeq/lastSeq 缓存
 * （与 raw_segments 表列一致，用于快速求链尾/排序；缺失时触发 manifest 重建）。
 *
 * v2 追加 `sessionId`（段所属会话的原始 id；v1 旧段/无会话段为 null）：
 * 段文件物理位置已按 `sanitizeSessionKey(sessionId)` 分目录，此字段是原始 id 的
 * 权威副本（目录名可能被截断/替换字符，不能反推）。
 */
export interface ManifestSegment extends VaultSegmentInfo {
  /** 段首记录 seq（缓存） */
  firstSeq: number;
  /** 段尾记录 seq（缓存） */
  lastSeq: number;
  /** 段所属会话的原始 id（v1 旧段/未知为 null） */
  sessionId?: string | null;
}

/**
 * vault 顶层清单：contracts.ts 的 VaultManifest（formatVersion/vaultId/updatedAt/
 * segments/stats，docs §5.3 字段原样）+ 本实现的 O(1) 打开缓存字段
 * （lastSeq/lastHash/days）。
 */
export interface VaultManifest extends ContractVaultManifest {
  segments: ManifestSegment[];
  /** 哈希链尾 seq（空 vault = 0） */
  lastSeq: number;
  /** 哈希链尾 hash（空 vault = GENESIS_HASH） */
  lastHash: string;
  /** 每个本地日期已分配的最大当日序号 */
  days: Record<string, { daySeq: number }>;
}

const SEGMENT_REL_RE = /^segments\/(\d{4}-\d{2}-\d{2})\/([^/]+)$/;

/** 解析可选 sessionId 字段：缺失 → undefined；null → null；字符串（可为空? 不允许空串）→ 原值 */
function optionalSessionId(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : value;
}

/** 新建空 manifest */
export function emptyManifest(vaultId: string, now: number = Date.now()): VaultManifest {
  return {
    formatVersion: MANIFEST_FORMAT_VERSION,
    vaultId,
    updatedAt: now,
    segments: [],
    stats: { records: 0, days: 0, bytes: 0 },
    lastSeq: 0,
    lastHash: GENESIS_HASH,
    days: {},
  };
}

function isNonNegativeInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/** 校验段条目；非法返回 null */
function parseManifestSegment(raw: unknown): ManifestSegment | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;
  if (typeof obj.segment !== 'string') return null;
  // v1（segments/<day>/<name>）与 v2（segments/<day>/<sessionKey>/<name>）都接受
  const parsed = parseSegmentRelativePath(obj.segment);
  if (parsed === null) return null;
  const { day } = parsed;
  if (obj.day !== day) return null;
  if (!isDateString(day)) return null;
  if (typeof obj.writerId !== 'string' || !/^w[0-9a-f]{6}$/.test(obj.writerId)) return null;
  if (obj.writerId !== `w${parsed.writerId}`) return null;
  if (!isNonNegativeInt(obj.records) || !isNonNegativeInt(obj.bytes)) return null;
  if (!isNonNegativeInt(obj.firstSeq) || !isNonNegativeInt(obj.lastSeq)) return null;
  if (typeof obj.sealed !== 'boolean') return null;
  if (obj.records === 0) {
    if (obj.headHash !== '' || obj.tailHash !== '') return null;
    if (obj.firstSeq !== 0 || obj.lastSeq !== 0 || obj.bytes !== 0) return null;
  } else {
    if (!isSha256Hex(obj.headHash) || !isSha256Hex(obj.tailHash)) return null;
    if (obj.firstSeq < 1 || obj.lastSeq < obj.firstSeq) return null;
    if (obj.lastSeq < obj.firstSeq) return null;
  }
  const sessionId = optionalSessionId(obj.sessionId);
  return {
    segment: parsed.relPath,
    day,
    writerId: obj.writerId,
    records: obj.records,
    bytes: obj.bytes,
    headHash: obj.headHash as string,
    tailHash: obj.tailHash as string,
    sealed: obj.sealed,
    firstSeq: obj.firstSeq,
    lastSeq: obj.lastSeq,
    // v2 段默认带 sessionId 字段（null = 无会话/v1 旧段）
    sessionId: sessionId ?? (parsed.sessionKey === null ? null : undefined),
  };
}

/**
 * 结构校验 manifest（丢弃未知字段、排序 segments）。
 * 非法/版本不匹配/统计不自洽返回 null（调用方随后从段文件重建）。
 */
export function parseManifest(raw: unknown): VaultManifest | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;
  if (obj.formatVersion !== MANIFEST_FORMAT_VERSION) return null;
  if (typeof obj.vaultId !== 'string' || obj.vaultId.length === 0) return null;
  if (typeof obj.updatedAt !== 'number' || !Number.isFinite(obj.updatedAt)) return null;
  if (!Array.isArray(obj.segments)) return null;
  const segments: ManifestSegment[] = [];
  const seen = new Set<string>();
  for (const rawSegment of obj.segments) {
    const segment = parseManifestSegment(rawSegment);
    if (segment === null) return null;
    if (seen.has(segment.segment)) return null;
    seen.add(segment.segment);
    segments.push(segment);
  }
  if (!isNonNegativeInt(obj.lastSeq)) return null;
  if (typeof obj.lastHash !== 'string' || !isSha256Hex(obj.lastHash)) return null;
  if (typeof obj.days !== 'object' || obj.days === null || Array.isArray(obj.days)) return null;
  const days: Record<string, { daySeq: number }> = {};
  for (const [day, value] of Object.entries(obj.days as Record<string, unknown>)) {
    if (!isDateString(day)) return null;
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
    const dayObj = value as Record<string, unknown>;
    if (!isNonNegativeInt(dayObj.daySeq)) return null;
    days[day] = { daySeq: dayObj.daySeq };
  }
  const sorted = sortSegments(segments);
  const expectedStats = computeManifestStats(sorted);
  const statsRaw = obj.stats;
  if (typeof statsRaw !== 'object' || statsRaw === null || Array.isArray(statsRaw)) return null;
  const statsObj = statsRaw as Record<string, unknown>;
  if (
    statsObj.records !== expectedStats.records ||
    statsObj.days !== expectedStats.days ||
    statsObj.bytes !== expectedStats.bytes
  ) {
    return null; // 统计与 segments 不自洽 => 视为损坏
  }
  // 链尾与 segments 自洽性：lastSeq 必须是最大 lastSeq；lastHash 对应其 tailHash
  let maxSeg: ManifestSegment | null = null;
  for (const segment of sorted) {
    if (segment.records > 0 && (maxSeg === null || segment.lastSeq > maxSeg.lastSeq)) maxSeg = segment;
  }
  const expectedLastSeq = maxSeg?.lastSeq ?? 0;
  const expectedLastHash = maxSeg?.tailHash ?? GENESIS_HASH;
  if (obj.lastSeq !== expectedLastSeq || obj.lastHash !== expectedLastHash) return null;
  return {
    formatVersion: MANIFEST_FORMAT_VERSION,
    vaultId: obj.vaultId,
    updatedAt: obj.updatedAt,
    segments: sorted,
    stats: expectedStats,
    lastSeq: expectedLastSeq,
    lastHash: expectedLastHash,
    days,
  };
}

/** 由段清单计算 stats（records/days/bytes） */
export function computeManifestStats(segments: readonly ManifestSegment[]): {
  records: number;
  days: number;
  bytes: number;
} {
  const days = new Set<string>();
  let records = 0;
  let bytes = 0;
  for (const segment of segments) {
    records += segment.records;
    bytes += segment.bytes;
    days.add(segment.day);
  }
  return { records, days: days.size, bytes };
}

/**
 * 按 (day, sessionKey, segNo, writerId) 升序排序：
 *   - day 升序；
 *   - 同日内 v1 旧段（sessionKey=null）排最前，v2 会话目录按 sessionKey 字典序；
 *   - 同 (day, sessionKey) 内按 segNo，再按 writerId 稳定排序。
 * 排序只是确定性展示/重建顺序；读取正确性由全局 seq 归并保证，与目录无关。
 */
export function sortSegments<T extends { day: string; segment: string }>(segments: readonly T[]): T[] {
  return [...segments].sort((a, b) => {
    if (a.day !== b.day) return a.day < b.day ? -1 : 1;
    const parsedA = parseSegmentRelativePath(a.segment);
    const parsedB = parseSegmentRelativePath(b.segment);
    const keyA = parsedA?.sessionKey ?? '';
    const keyB = parsedB?.sessionKey ?? '';
    if (keyA !== keyB) return keyA < keyB ? -1 : 1;
    const noA = parsedA?.segNo ?? 0;
    const noB = parsedB?.segNo ?? 0;
    if (noA !== noB) return noA - noB;
    const nameA = parsedA?.name ?? a.segment;
    const nameB = parsedB?.name ?? b.segment;
    return nameA < nameB ? -1 : nameA > nameB ? 1 : 0;
  });
}

/** 深拷贝 manifest（防止外部修改内部状态） */
export function cloneManifest(manifest: VaultManifest): VaultManifest {
  return {
    ...manifest,
    segments: manifest.segments.map((segment) => ({ ...segment })),
    stats: { ...manifest.stats },
    days: Object.fromEntries(Object.entries(manifest.days).map(([day, value]) => [day, { ...value }])),
  };
}

/** 更新 stats/链尾/daySeq 缓存（由 segments 推导） */
export function refreshManifestDerived(manifest: VaultManifest, now: number = Date.now()): void {
  manifest.segments = sortSegments(manifest.segments);
  manifest.stats = computeManifestStats(manifest.segments);
  let maxSeg: ManifestSegment | null = null;
  for (const segment of manifest.segments) {
    if (segment.records > 0 && (maxSeg === null || segment.lastSeq > maxSeg.lastSeq)) maxSeg = segment;
  }
  manifest.lastSeq = maxSeg?.lastSeq ?? 0;
  manifest.lastHash = maxSeg?.tailHash ?? GENESIS_HASH;
  manifest.updatedAt = now;
}

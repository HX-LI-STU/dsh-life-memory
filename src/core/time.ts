// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hanxustu (dsh-life-memory)
/**
 * 时区安全的日期/时间工具（日期编号与 ISO 时间戳）。
 *
 * 设计要点：
 *   - 日期编号 `YYYY-MM-DD` 必须按「记录发生时刻在配置时区中的本地日期」计算，
 *     而不是 UTC 日期，也不是宿主本地日期（DSH 可能跨时区使用）；
 *   - 用 `Intl.DateTimeFormat.formatToParts` 取时区本地时间，不依赖 locale 的
 *     字符串格式（避免隐式格式差异），并显式指定 gregory 历法与 latn 数字；
 *   - 所有函数对夏令时（DST）安全：本地时间由「瞬时时刻 + 时区」推导，
 *     不存在把不存在的本地时间映射回 UTC 的问题；
 *   - Intl 格式化器按 timeZone 缓存（vault 追加记录时每条都要算日期，缓存很关键）。
 *
 * 不变量：
 *   - `isoInTimeZone(ts, tz)` 带毫秒与显式偏移（如 `2026-10-25T23:15:37.123+08:00`），
 *     且 `Date.parse(isoInTimeZone(ts, tz)) === ts`（ts 为整数毫秒）；
 *   - `dateInTimeZone(ts, tz)` 返回该时刻在 tz 的本地日历日期（DST 切换日同样正确）。
 */

/** 时区本地时间分量（0 基月份） */
export interface TimeZoneParts {
  year: number;
  /** 1..12 */
  month: number;
  /** 1..31 */
  day: number;
  /** 0..23 */
  hour: number;
  minute: number;
  second: number;
}

const partsFormatterCache = new Map<string, Intl.DateTimeFormat>();
const validTimeZoneCache = new Map<string, boolean>();

/** 校验 IANA 时区名（无效时区返回 false，不抛错） */
export function isValidTimeZone(timeZone: string): boolean {
  if (typeof timeZone !== 'string' || timeZone.length === 0) return false;
  const cached = validTimeZoneCache.get(timeZone);
  if (cached !== undefined) return cached;
  let ok = true;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone }).format(0);
  } catch {
    ok = false;
  }
  validTimeZoneCache.set(timeZone, ok);
  return ok;
}

function partsFormatter(timeZone: string): Intl.DateTimeFormat {
  let formatter = partsFormatterCache.get(timeZone);
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      calendar: 'gregory',
      numberingSystem: 'latn',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    });
    partsFormatterCache.set(timeZone, formatter);
  }
  return formatter;
}

/** 取某个 epoch 毫秒时刻在指定 IANA 时区中的日历/时钟分量 */
export function timeZoneParts(ts: number, timeZone: string): TimeZoneParts {
  if (!Number.isFinite(ts)) {
    throw new RangeError(`[dsh-life-memory] timeZoneParts: invalid timestamp ${String(ts)}`);
  }
  if (!isValidTimeZone(timeZone)) {
    throw new RangeError(`[dsh-life-memory] timeZoneParts: invalid timeZone ${String(timeZone)}`);
  }
  const parts = partsFormatter(timeZone).formatToParts(new Date(ts));
  let year = Number.NaN;
  let month = Number.NaN;
  let day = Number.NaN;
  let hour = Number.NaN;
  let minute = Number.NaN;
  let second = Number.NaN;
  for (const part of parts) {
    switch (part.type) {
      case 'year':
        year = Number(part.value);
        break;
      case 'month':
        month = Number(part.value);
        break;
      case 'day':
        day = Number(part.value);
        break;
      case 'hour':
        hour = Number(part.value);
        break;
      case 'minute':
        minute = Number(part.value);
        break;
      case 'second':
        second = Number(part.value);
        break;
      default:
        break;
    }
  }
  if (
    !Number.isInteger(year) ||
    !Number.isInteger(month) ||
    !Number.isInteger(day) ||
    !Number.isInteger(hour) ||
    !Number.isInteger(minute) ||
    !Number.isInteger(second)
  ) {
    throw new Error(
      `[dsh-life-memory] timeZoneParts: failed to resolve time zone parts for ${timeZone}`,
    );
  }
  return { year, month, day, hour, minute, second };
}

function pad2(value: number): string {
  return value < 10 ? `0${value}` : String(value);
}

/**
 * 时区本地日期字符串 `YYYY-MM-DD`（用于原始记录 id 与按天分段目录）。
 * 例：`dateInTimeZone(Date.UTC(2026,0,1,15,30), 'Asia/Shanghai') === '2026-01-01'`，
 * 同一时刻在 UTC 为 `2026-01-01`，在 America/New_York 为 `2026-01-01 10:30`。
 */
export function dateInTimeZone(ts: number, timeZone: string): string {
  const parts = timeZoneParts(ts, timeZone);
  return `${parts.year}-${pad2(parts.month)}-${pad2(parts.day)}`;
}

/** 当前时刻在指定时区的日期（默认取 `Date.now()`；测试可注入 now） */
export function todayInTimeZone(timeZone: string, now: number = Date.now()): string {
  return dateInTimeZone(now, timeZone);
}

/**
 * 计算某时刻在时区的 UTC 偏移（分钟，东区为正）。
 * 例：Asia/Shanghai 恒为 +480；America/New_York 夏令时 -240 / 冬令时 -300。
 */
export function timeZoneOffsetMinutes(ts: number, timeZone: string): number {
  const parts = timeZoneParts(ts, timeZone);
  const localAsUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  );
  const secondTs = Math.floor(ts / 1000) * 1000;
  return Math.round((localAsUtc - secondTs) / 60_000);
}

/** 把偏移分钟格式化为 `+HH:MM` / `-HH:MM` */
export function formatUtcOffset(offsetMinutes: number): string {
  const rounded = Math.trunc(offsetMinutes);
  const sign = rounded < 0 ? '-' : '+';
  const abs = Math.abs(rounded);
  return `${sign}${pad2(Math.floor(abs / 60))}:${pad2(abs % 60)}`;
}

/**
 * ISO 8601 UTC 时间戳（`toISOString()`，毫秒精度，`Z` 后缀）。
 * L0 原始记录行使用该格式（docs/20 §5.2 示例 `"2026-10-25T15:00:00.123Z"`；
 * 时区信息另存 `timezone` 字段）。与 `ts` 一一对应：
 * `Date.parse(isoUtc(ts)) === ts`（整数毫秒）。
 */
export function isoUtc(ts: number): string {
  if (!Number.isFinite(ts)) {
    throw new RangeError(`[dsh-life-memory] isoUtc: invalid timestamp ${String(ts)}`);
  }
  return new Date(ts).toISOString();
}

/**
 * ISO 8601 时间戳（含显式时区偏移与毫秒）。
 * `Date.parse(isoInTimeZone(ts, tz)) === ts`（整数毫秒）。
 * 例：`isoInTimeZone(ts, 'Asia/Shanghai') === '2026-10-25T23:15:37.123+08:00'`。
 */
export function isoInTimeZone(ts: number, timeZone: string): string {
  const parts = timeZoneParts(ts, timeZone);
  const offset = timeZoneOffsetMinutes(ts, timeZone);
  const ms = ((Math.floor(ts) % 1000) + 1000) % 1000;
  return (
    `${parts.year}-${pad2(parts.month)}-${pad2(parts.day)}` +
    `T${pad2(parts.hour)}:${pad2(parts.minute)}:${pad2(parts.second)}` +
    `.${String(ms).padStart(3, '0')}${formatUtcOffset(offset)}`
  );
}

/** 是否是形如 `YYYY-MM-DD` 的日期字符串（只做形状/范围基本校验） */
export function isDateString(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  const probe = new Date(Date.UTC(year, month - 1, day));
  return probe.getUTCFullYear() === year && probe.getUTCMonth() === month - 1 && probe.getUTCDate() === day;
}

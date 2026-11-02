// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hanxustu (dsh-life-memory)
/**
 * L0 原始记录行的字节级序列化 / 哈希 / 校验（docs/20 §5.2）。
 *
 * 行格式（字段顺序固定，顺序参与哈希，必须逐字节一致）：
 *   {
 *     id, seq, ts, iso, day, timezone, kind, sessionId, workspace, turnId,
 *     stepId, role, text, payload, tags, v, prevHash, hash
 *   }
 *
 * 哈希算法：
 *   hash = sha256_hex( utf8( prevHash + "\n" + JSON.stringify(record_without(hash)) ) )
 *   - record_without(hash) 字段顺序 = 上面的固定顺序（不含 hash）；
 *   - payload 按宿主原样序列化（JSON.stringify 保持宿主键序，**不排序键**）；
 *   - 链首 prevHash = GENESIS_HASH（64 个 '0'）。
 *
 * 注意：不要用 `canonicalJson`（键排序）来算 L0 行哈希——docs 明确 payload
 * 保持宿主键序；canonical JSON 只用于其它与顺序无关的内容哈希。
 *
 * payload 必须是无损 JSON 值（不接受 undefined/function/symbol/BigInt/NaN/
 * 循环引用/非 plain object）。捕获层负责把宿主对象降级成 JSON 值（docs §5.2），
 * 本模块拒绝坏 payload 而不是静默丢数据（原始层必须无损）。
 */

import type {
  RawAppendItem,
  RawRecord,
  RawRecordInput,
  RawRecordLocation,
} from '../core/contracts.ts';
import { GENESIS_HASH, RAW_RECORD_VERSION } from '../core/contracts.ts';
import { sha256Hex } from '../core/hash.ts';
import { isRawKind } from '../core/ids.ts';
import { isValidTimeZone } from '../core/time.ts';

/** 构建一条记录所需的、由 vault 分配的字段 */
export interface RawRecordIdentity {
  id: string;
  seq: number;
  day: string;
  iso: string;
  prevHash: string;
}

/** 构建/读取记录时允许的 payload 最大嵌套深度（防御异常深链） */
const MAX_PAYLOAD_DEPTH = 256;

/** payload 校验失败（原始层无损要求） */
export class PayloadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PayloadError';
  }
}

/**
 * 校验 payload 是 JSON 可无损表示的值：
 * null/boolean/有限 number/string/array/plain object（可含 Date，按 ISO 字符串序列化）。
 * 拒绝：undefined、function、symbol、bigint、NaN/Infinity、循环引用、Map/Set/TypedArray。
 */
export function validatePayloadJson(value: unknown, path = 'payload'): void {
  const seen = new Set<object>();
  walkPayload(value, path, 0, seen);
}

function walkPayload(value: unknown, path: string, depth: number, seen: Set<object>): void {
  if (depth > MAX_PAYLOAD_DEPTH) {
    throw new PayloadError(
      `[dsh-life-memory] ${path}: nesting deeper than ${MAX_PAYLOAD_DEPTH} levels; degrade payload before append`,
    );
  }
  switch (typeof value) {
    case 'string':
    case 'boolean':
      return;
    case 'number':
      if (!Number.isFinite(value)) {
        throw new PayloadError(
          `[dsh-life-memory] ${path}: non-finite number (${String(value)}); degrade payload before append`,
        );
      }
      return;
    case 'bigint':
    case 'function':
    case 'symbol':
    case 'undefined':
      throw new PayloadError(
        `[dsh-life-memory] ${path}: ${typeof value} is not a JSON value; degrade payload before append (docs/20 §5.2)`,
      );
    case 'object': {
      if (value === null) return;
      if (value instanceof Date) {
        if (Number.isNaN(value.getTime())) {
          throw new PayloadError(`[dsh-life-memory] ${path}: invalid Date`);
        }
        return;
      }
      if (seen.has(value)) {
        throw new PayloadError(`[dsh-life-memory] ${path}: circular reference; degrade payload before append`);
      }
      seen.add(value);
      if (Array.isArray(value)) {
        for (let i = 0; i < value.length; i += 1) {
          if (value[i] === undefined) {
            throw new PayloadError(
              `[dsh-life-memory] ${path}[${i}]: undefined is not a JSON value; degrade payload before append`,
            );
          }
          walkPayload(value[i], `${path}[${i}]`, depth + 1, seen);
        }
      } else {
        const proto = Object.getPrototypeOf(value) as object | null;
        if (proto !== Object.prototype && proto !== null) {
          throw new PayloadError(
            `[dsh-life-memory] ${path}: non-plain object (${(value as object).constructor?.name ?? 'unknown'}); ` +
              'degrade payload to plain JSON before append',
          );
        }
        for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
          if (child === undefined) {
            throw new PayloadError(
              `[dsh-life-memory] ${path}.${key}: undefined is not a JSON value; degrade payload before append`,
            );
          }
          walkPayload(child, `${path}.${key}`, depth + 1, seen);
        }
      }
      seen.delete(value);
      return;
    }
    default:
      throw new PayloadError(
        `[dsh-life-memory] ${path}: unsupported value type ${typeof value}; degrade payload before append`,
      );
  }
}

/** 规范化可选字符串字段：undefined/null -> null；其它类型报错 */
function optionalString(value: unknown, field: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') {
    throw new TypeError(`[dsh-life-memory] RawRecordInput.${field} must be a string or null`);
  }
  return value;
}

/** 校验并规范化 RawRecordInput（vault 分配 id/seq/hash 前执行） */
export function normalizeRawRecordInput(input: RawRecordInput, index: number): RawRecordInput {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new TypeError(`[dsh-life-memory] append: batch[${index}] must be an object`);
  }
  if (!isRawKind(input.kind)) {
    throw new TypeError(
      `[dsh-life-memory] append: batch[${index}].kind is invalid (${String(input.kind)})`,
    );
  }
  if (typeof input.ts !== 'number' || !Number.isFinite(input.ts)) {
    throw new TypeError(`[dsh-life-memory] append: batch[${index}].ts must be a finite epoch-ms number`);
  }
  if (typeof input.timezone !== 'string' || !isValidTimeZone(input.timezone)) {
    throw new TypeError(`[dsh-life-memory] append: batch[${index}].timezone is not a valid IANA timezone`);
  }
  if (typeof input.sessionId !== 'string' || input.sessionId.length === 0) {
    throw new TypeError(`[dsh-life-memory] append: batch[${index}].sessionId must be a non-empty string`);
  }
  if (input.payload === undefined) {
    throw new PayloadError(`[dsh-life-memory] append: batch[${index}].payload is required (docs/20 §5.2)`);
  }
  validatePayloadJson(input.payload, `append.batch[${index}].payload`);
  const tags = input.tags ?? [];
  if (!Array.isArray(tags) || tags.some((tag) => typeof tag !== 'string')) {
    throw new TypeError(`[dsh-life-memory] append: batch[${index}].tags must be a string array`);
  }
  let ingestKey: string | undefined;
  if (input.ingestKey !== undefined) {
    if (typeof input.ingestKey !== 'string' || input.ingestKey.length === 0) {
      throw new TypeError(`[dsh-life-memory] append: batch[${index}].ingestKey must be a non-empty string`);
    }
    ingestKey = input.ingestKey;
  }
  const normalized: RawRecordInput = {
    kind: input.kind,
    ts: input.ts,
    timezone: input.timezone,
    sessionId: input.sessionId,
    workspace: optionalString(input.workspace, 'workspace'),
    turnId: optionalString(input.turnId, 'turnId'),
    stepId: optionalString(input.stepId, 'stepId'),
    role: optionalString(input.role, 'role'),
    text: optionalString(input.text, 'text'),
    payload: input.payload,
    tags: [...tags],
  };
  if (ingestKey !== undefined) normalized.ingestKey = ingestKey;
  if (input.personaId !== undefined) {
    if (input.personaId !== null && typeof input.personaId !== 'string') {
      throw new TypeError(`[dsh-life-memory] append: batch[${index}].personaId must be a string or null`);
    }
    const trimmed = typeof input.personaId === 'string' ? input.personaId.trim() : '';
    if (trimmed.length > 128) {
      throw new RangeError(`[dsh-life-memory] append: batch[${index}].personaId exceeds 128 chars`);
    }
    // personaId 是索引元数据（docs/25-persona §7）：随内存记录传递，由 store 写入 raw_index，
    // **绝不进入 L0 行 JSON / 哈希 / verify 字节比较**（见 orderedRecordWithoutHash）。
    normalized.personaId = trimmed.length === 0 ? null : trimmed;
  }
  return normalized;
}

/**
 * 固定字段顺序的记录对象（不含 hash）。
 * 该对象的 JSON.stringify 结果就是哈希输入的一部分。
 */
function orderedRecordWithoutHash(record: Omit<RawRecord, 'hash'>): Record<string, unknown> {
  return {
    id: record.id,
    seq: record.seq,
    ts: record.ts,
    iso: record.iso,
    day: record.day,
    timezone: record.timezone,
    kind: record.kind,
    sessionId: record.sessionId,
    workspace: record.workspace ?? null,
    turnId: record.turnId ?? null,
    stepId: record.stepId ?? null,
    role: record.role ?? null,
    text: record.text ?? null,
    payload: record.payload,
    tags: record.tags ?? [],
    v: record.v,
    prevHash: record.prevHash,
  };
}

/** 哈希输入：prevHash + "\n" + JSON.stringify(record_without_hash)（docs/20 §5.2） */
export function serializeRecordForHash(record: Omit<RawRecord, 'hash'> | RawRecord): string {
  const withoutHash = orderedRecordWithoutHash(record as Omit<RawRecord, 'hash'>);
  return `${(record as RawRecord).prevHash}\n${JSON.stringify(withoutHash)}`;
}

/** 计算 L0 记录哈希（sha256_hex(prevHash + "\n" + recordJsonWithoutHash)） */
export function hashRawRecord(record: Omit<RawRecord, 'hash'> | RawRecord): string {
  return sha256Hex(serializeRecordForHash(record));
}

/** 序列化为一行 JSON（字段顺序固定，hash 在最后；不含换行符） */
export function serializeRecordLine(record: RawRecord): string {
  const ordered = orderedRecordWithoutHash(record);
  ordered.hash = record.hash;
  return JSON.stringify(ordered);
}

/** 记录 -> JSONL 行（含换行符，UTF-8 写入用） */
export function serializeRecordLineWithNewline(record: RawRecord): string {
  return `${serializeRecordLine(record)}\n`;
}

/**
 * 由输入 + vault 分配的 identity 构建不可变记录（含 hash）。
 * 记录对象只包含 L0 行字段（不携带 ingestKey/meta 等传输元数据）。
 */
export function buildRawRecord(input: RawRecordInput, identity: RawRecordIdentity): RawRecord {
  const withoutHash: Omit<RawRecord, 'hash'> = {
    kind: input.kind,
    ts: input.ts,
    timezone: input.timezone,
    sessionId: input.sessionId,
    workspace: input.workspace ?? null,
    // 仅内存元数据（store 写 raw_index.persona_id）；不参与 L0 行 JSON / 哈希。
    // 仅在显式提供时携带该属性，保证无 persona 的内存记录与从 L0 解析出的记录字段形状一致。
    ...(input.personaId !== undefined ? { personaId: input.personaId } : {}),
    turnId: input.turnId ?? null,
    stepId: input.stepId ?? null,
    role: input.role ?? null,
    text: input.text ?? null,
    payload: input.payload,
    tags: input.tags ? [...input.tags] : [],
    id: identity.id,
    seq: identity.seq,
    day: identity.day,
    iso: identity.iso,
    prevHash: identity.prevHash,
    v: RAW_RECORD_VERSION,
  };
  const hash = hashRawRecord(withoutHash);
  return { ...withoutHash, hash };
}

/** 解析结果（失败时带原因，供 verify 报告） */
export type ParseRecordResult =
  | { ok: true; record: RawRecord }
  | { ok: false; reason: string };

/**
 * 解析一行 L0 JSON 并做结构校验（不校验哈希，哈希由 verify 重算）。
 * 字段顺序不参与解析校验；verify 会额外比较字节级序列化结果。
 */
export function parseRecordLine(line: string): ParseRecordResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch (error) {
    return { ok: false, reason: `invalid JSON: ${(error as Error).message}` };
  }
  return validateParsedRecord(parsed);
}

/** 校验解析后的记录形状；通过则断言为 RawRecord */
export function validateParsedRecord(parsed: unknown): ParseRecordResult {
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, reason: 'record line is not a JSON object' };
  }
  const obj = parsed as Record<string, unknown>;
  const stringFields = ['id', 'iso', 'day', 'timezone', 'kind', 'sessionId', 'prevHash', 'hash'] as const;
  for (const field of stringFields) {
    if (typeof obj[field] !== 'string' || (obj[field] as string).length === 0) {
      return { ok: false, reason: `field "${field}" is missing or not a non-empty string` };
    }
  }
  if (!isRawKind(obj.kind)) return { ok: false, reason: `invalid kind "${String(obj.kind)}"` };
  if (!Number.isSafeInteger(obj.seq) || (obj.seq as number) < 1) {
    return { ok: false, reason: 'field "seq" is not a positive integer' };
  }
  if (typeof obj.ts !== 'number' || !Number.isFinite(obj.ts)) {
    return { ok: false, reason: 'field "ts" is not a finite number' };
  }
  if (obj.v !== RAW_RECORD_VERSION) {
    return { ok: false, reason: `unsupported record version v=${String(obj.v)}` };
  }
  if (!Array.isArray(obj.tags) || (obj.tags as unknown[]).some((tag) => typeof tag !== 'string')) {
    return { ok: false, reason: 'field "tags" is not a string array' };
  }
  if (!('payload' in obj) || obj.payload === undefined) {
    return { ok: false, reason: 'field "payload" is missing' };
  }
  for (const field of ['workspace', 'turnId', 'stepId', 'role', 'text'] as const) {
    const value = obj[field];
    if (value !== null && typeof value !== 'string') {
      return { ok: false, reason: `field "${field}" must be string or null` };
    }
  }
  if (!isValidTimeZone(obj.timezone as string)) {
    return { ok: false, reason: `invalid timezone "${String(obj.timezone)}"` };
  }
  // prevHash/hash 形状
  if (!/^[0-9a-f]{64}$/.test(obj.prevHash as string)) {
    return { ok: false, reason: 'field "prevHash" is not 64-char lowercase hex' };
  }
  if (!/^[0-9a-f]{64}$/.test(obj.hash as string)) {
    return { ok: false, reason: 'field "hash" is not 64-char lowercase hex' };
  }
  // 校验 payload 是合法 JSON 值（JSON.parse 已保证结构，但 NaN 不在此列——JSON 没有 NaN）
  return { ok: true, record: obj as unknown as RawRecord };
}

/** 触发式断言：形状非法时抛出（读取路径用） */
export function assertParsedRecord(line: string): RawRecord {
  const result = parseRecordLine(line);
  if (!result.ok) {
    throw new Error(`[dsh-life-memory] invalid raw record line: ${result.reason}`);
  }
  return result.record;
}

/** 组装 RawAppendItem（location 由 vault 写入完成后补齐） */
export function makeAppendItem(record: RawRecord, location: RawRecordLocation): RawAppendItem {
  return { record, location };
}

/** 空链常量（便于调用方） */
export const EMPTY_CHAIN_HASH = GENESIS_HASH;

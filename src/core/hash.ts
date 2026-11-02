// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hanxustu (dsh-life-memory)
/**
 * 哈希工具：sha256 十六进制、确定性 JSON 哈希、内容哈希、fnv1a32。
 *
 * 注意（L0 原始记录的哈希不在这里）：
 *   docs/20 §5.2 规定 L0 行的哈希是
 *     sha256_hex( utf8( prevHash + "\n" + JSON.stringify(record_without_hash) ) )
 *   其中 JSON 字段顺序固定、payload 按宿主原样序列化（不排序键）。
 *   该逻辑必须与行格式一起实现，见 `src/vault/record.ts`（serializeRecordForHash），
 *   不要用本模块的 canonical JSON 哈希去算 L0 行哈希（字段顺序/键序不同）。
 *
 * 本模块提供其它契约需要的确定性哈希原语：
 *   - `sha256Hex`：通用 sha256；
 *   - `hashJson`：canonical JSON（键排序）哈希，适合与顺序无关的内容哈希；
 *   - `contentHash(layer, kind, text)`：docs/20 §6.2 的派生记忆内容哈希；
 *   - `fnv1a32`：本地嵌入 dsh-local-hash-v1 的 signed feature hashing 原语。
 */
import { createHash } from 'node:crypto';
import { canonicalJson } from './canonical-json.ts';
import { GENESIS_HASH } from './contracts.ts';
import { normalizeForContentHash } from './text.ts';

export { GENESIS_HASH };

/** sha256 十六进制摘要（小写 64 字符）；字符串按 UTF-8 编码 */
export function sha256Hex(input: string | Uint8Array): string {
  return createHash('sha256').update(input).digest('hex');
}

/** 对任意 JSON 值做 canonical（键排序）序列化后求 sha256 */
export function hashJson(value: unknown): string {
  return sha256Hex(canonicalJson(value));
}

/**
 * 派生记忆内容哈希（docs/20 §6.2）：
 *   `sha256_hex(utf8(layer + "\0" + kind + "\0" + normalizeText(text)))`
 * 其中 normalizeText = normalizeForContentHash（NFKC → 拉丁小写 → 空白折叠 → 去首尾标点）。
 * 同层同 kind 同内容 => 同 hash（partial unique index 去重依据）。
 */
export function contentHash(layer: string, kind: string, text: string): string {
  return sha256Hex(`${layer}\0${kind}\0${normalizeForContentHash(text)}`);
}

/** 下一条记录应使用的 prevHash（空链时返回 GENESIS_HASH） */
export function nextPrevHash(lastHash: string | null | undefined): string {
  return typeof lastHash === 'string' && lastHash.length > 0 ? lastHash : GENESIS_HASH;
}

/** 是否是合法的 sha256 十六进制（64 位，大小写均可） */
export function isSha256Hex(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-fA-F]{64}$/.test(value);
}

/**
 * 取哈希前 N 位（默认 8）；输入不是十六进制哈希时先 sha256 再截取，
 * 保证派生 id 中永远是稳定的十六进制片段。
 */
export function shortHash(input: string, length = 8): string {
  if (typeof input !== 'string') {
    throw new TypeError('[dsh-life-memory] shortHash: input must be a string');
  }
  const width = Math.max(1, Math.min(64, Math.floor(length)));
  const lower = input.toLowerCase();
  const hex = /^[0-9a-f]+$/.test(lower) && lower.length >= width ? lower : sha256Hex(input);
  return hex.slice(0, width);
}

/**
 * FNV-1a 32 位哈希（无符号），对 UTF-8 字节计算，可指定初始种子。
 * 本地嵌入用两个种子：FNV_OFFSET(0x811c9dc5) 取索引、SEED2(0x7f4a7c15) 取符号。
 */
export function fnv1a32(input: string | Uint8Array, seed: number = 0x811c9dc5): number {
  const bytes = typeof input === 'string' ? Buffer.from(input, 'utf8') : input;
  let hash = seed >>> 0;
  for (let i = 0; i < bytes.length; i += 1) {
    hash ^= bytes[i];
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/** FNV-1a 32 的第二个种子（signed feature hashing 的符号位） */
export const FNV_SEED2 = 0x7f4a7c15;
/** FNV-1a 32 标准偏移基（索引种子） */
export const FNV_OFFSET = 0x811c9dc5;

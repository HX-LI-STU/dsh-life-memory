// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hanxustu (dsh-life-memory)
/**
 * 确定性 JSON（canonical JSON）序列化 —— 哈希链与去重的基石。
 *
 * 为什么需要它：
 *   - 原始记录的哈希必须跨进程、跨版本、跨重排一致；
 *   - `JSON.stringify` 保留对象插入顺序，同一份数据可能序列化成不同字节；
 *   - 本模块递归按键名字典序排序对象键、去除空白、输出 UTF-8 安全的 JSON 文本，
 *     从而 `canonicalJson(a) === canonicalJson(b)` 当且仅当 a、b 的 JSON 值语义相同。
 *
 * 不变量（invariants）：
 *   - 输入只允许纯 JSON 值：null / boolean / number(有限) / string / array / plain object；
 *   - 对象中值为 `undefined` 的键被丢弃（与 JSON.stringify 一致）；数组中的
 *     `undefined` 按 JSON 语义编码为 `null`；
 *   - BigInt / NaN / Infinity / function / symbol / 循环引用 一律抛出
 *     `CanonicalJsonError`，绝不静默丢数据（原始层必须无损）；
 *   - 输出不含任何空白字符（字符串内部的空白除外），非 ASCII 字符原样输出（UTF-8）；
 *   - 字符串用 `JSON.stringify` 转义，保证单行（换行符被转义为 `\n`），可直接写 JSONL。
 *
 * 注意：`-0` 会被编码为 `0`（JSON 无法区分），这是 JSON 本身的限制，已记录在此。
 * `Date` 实例按 `toISOString()` 编码（方便调用方，但原始层请只传 DSH JSON 值）。
 */

/** canonical JSON 序列化错误（不可序列化的输入） */
export class CanonicalJsonError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CanonicalJsonError';
  }
}

/** 最大嵌套深度：防御恶意/意外的深链，避免栈溢出（正常 DSH 事件远小于此值） */
const MAX_DEPTH = 512;

/** 确定性序列化：对象键递归排序、无空白、UTF-8 文本 */
export function canonicalJson(value: unknown): string {
  return writeValue(value, '$', 0);
}

/** 确定性序列化的 UTF-8 字节（哈希/落盘用，避免调用方重复编码） */
export function canonicalJsonBytes(value: unknown): Uint8Array {
  return new Uint8Array(Buffer.from(canonicalJson(value), 'utf8'));
}

/** 便捷：JSON 值 -> 确定性字符串；失败时返回 null 而不是抛错（UI/日志展示用） */
export function tryCanonicalJson(value: unknown): string | null {
  try {
    return canonicalJson(value);
  } catch {
    return null;
  }
}

function writeValue(value: unknown, path: string, depth: number): string {
  if (depth > MAX_DEPTH) {
    throw new CanonicalJsonError(
      `[dsh-life-memory] canonicalJson: nesting deeper than ${MAX_DEPTH} at ${path}`,
    );
  }
  switch (typeof value) {
    case 'string':
      return JSON.stringify(value);
    case 'number':
      if (!Number.isFinite(value)) {
        throw new CanonicalJsonError(
          `[dsh-life-memory] canonicalJson: non-finite number (${String(value)}) at ${path}; ` +
            'JSON payloads must contain only finite numbers',
        );
      }
      return JSON.stringify(value);
    case 'boolean':
      return value ? 'true' : 'false';
    case 'bigint':
      throw new CanonicalJsonError(
        `[dsh-life-memory] canonicalJson: bigint is not a JSON value at ${path}; convert it to number/string first`,
      );
    case 'undefined':
      throw new CanonicalJsonError(
        `[dsh-life-memory] canonicalJson: undefined is not a JSON value at ${path}`,
      );
    case 'function':
    case 'symbol':
      throw new CanonicalJsonError(
        `[dsh-life-memory] canonicalJson: ${typeof value} is not a JSON value at ${path}`,
      );
    case 'object':
      return writeObject(value as object, path, depth);
    default:
      throw new CanonicalJsonError(
        `[dsh-life-memory] canonicalJson: unsupported value type ${typeof value} at ${path}`,
      );
  }
}

function writeObject(value: object, path: string, depth: number): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) {
    const parts: string[] = [];
    for (let i = 0; i < value.length; i += 1) {
      const item = value[i];
      // JSON.stringify 语义：数组中的 undefined / 函数 / symbol 变成 null
      parts.push(
        item === undefined ? 'null' : writeValue(item, `${path}[${i}]`, depth + 1),
      );
    }
    return `[${parts.join(',')}]`;
  }
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) {
      throw new CanonicalJsonError(
        `[dsh-life-memory] canonicalJson: invalid Date at ${path}`,
      );
    }
    return JSON.stringify(value.toISOString());
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort();
  if (keys.length === 0) return '{}';
  const parts: string[] = [];
  for (const key of keys) {
    const childPath = path === '$' ? key : `${path}.${key}`;
    parts.push(`${JSON.stringify(key)}:${writeValue(record[key], childPath, depth + 1)}`);
  }
  return `{${parts.join(',')}}`;
}

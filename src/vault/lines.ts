// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hanxustu (dsh-life-memory)
/**
 * 段文件的行级 I/O（L0 JSONL，按 `\n` 结尾）。
 *
 * 设计要点：
 *   - 段文件可达 8 MiB，必须流式读取（内存有界）；
 *   - UTF-8 安全：以单字节 `0x0A` 切分不会切断多字节字符（UTF-8 续字节 ≥0x80），
 *     因此按 Buffer 切分后再逐行 `toString('utf8')` 是安全的；
 *   - 支持正序/逆序迭代（list 的 desc、get 的快速查找）；
 *   - 尾部半行（无 `\n` 的残尾）检测：只允许对未提交残尾截断（docs §6.5-C），
 *     判定由 RawVaultImpl 结合 manifest 的已提交字节数完成。
 */

import { open, stat, truncate } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';

const CHUNK_SIZE = 64 * 1024;
const NEWLINE = 0x0a;

/** 段尾信息 */
export interface LastLineInfo {
  /** 文件字节数 */
  size: number;
  /** 文件是否以 \n 结尾（空文件视为 true，无残尾） */
  endsWithNewline: boolean;
  /** 最后一个完整行的内容（不含 \n；无完整行时为 null） */
  lastCompleteLine: string | null;
  /** 尾部未闭合残行内容（无残尾时为 ''） */
  partialTail: string;
  /** 完整行区域的字节边界（= size - partialTailBytes） */
  completeBytes: number;
  /** 残尾字节数（无残尾为 0） */
  partialTailBytes: number;
}

/** 文件不存在时视为空文件 */
async function fileSize(file: string): Promise<number | null> {
  try {
    const info = await stat(file);
    return info.isFile() ? info.size : null;
  } catch {
    return null;
  }
}

/** 在 [0, beforeExclusive] 区间内从后往前找最后一个 `\n` 的字节索引；未找到返回 -1 */
async function findLastNewline(handle: FileHandle, beforeExclusive: number): Promise<number> {
  if (beforeExclusive < 0) return -1;
  let window = CHUNK_SIZE;
  let end = beforeExclusive + 1; // 搜索区间 [start, end)
  for (;;) {
    const start = Math.max(0, end - window);
    const length = end - start;
    const buffer = Buffer.allocUnsafe(length);
    await handle.read(buffer, 0, length, start);
    for (let i = length - 1; i >= 0; i -= 1) {
      if (buffer[i] === NEWLINE) return start + i;
    }
    if (start === 0) return -1;
    end = start;
    window *= 2;
  }
}

/**
 * 读取段尾信息：文件大小、是否以 \n 结尾、最后一个完整行、残尾。
 * 空文件/不存在：size=0、lastCompleteLine=null、无残尾。
 */
export async function readLastLineInfo(file: string): Promise<LastLineInfo> {
  const size = await fileSize(file);
  if (size === null || size === 0) {
    return {
      size: 0,
      endsWithNewline: true,
      lastCompleteLine: null,
      partialTail: '',
      completeBytes: 0,
      partialTailBytes: 0,
    };
  }
  const handle = await open(file, 'r');
  try {
    const lastByte = Buffer.allocUnsafe(1);
    await handle.read(lastByte, 0, 1, size - 1);
    let completeBytes = size;
    let partialTailBytes = 0;
    if (lastByte[0] !== NEWLINE) {
      const lastNl = await findLastNewline(handle, size - 1);
      completeBytes = lastNl + 1; // -1 => 0
      partialTailBytes = size - completeBytes;
    }
    let lastCompleteLine: string | null = null;
    if (completeBytes > 0) {
      // 完整行 = [前一个 \n + 1, completeBytes - 1)
      const previousNl = await findLastNewline(handle, completeBytes - 2);
      const start = previousNl + 1;
      const length = completeBytes - 1 - start;
      const buffer = Buffer.allocUnsafe(Math.max(0, length));
      if (length > 0) await handle.read(buffer, 0, length, start);
      lastCompleteLine = buffer.toString('utf8', 0, length);
    }
    let partialTail = '';
    if (partialTailBytes > 0) {
      const buffer = Buffer.allocUnsafe(partialTailBytes);
      await handle.read(buffer, 0, partialTailBytes, completeBytes);
      partialTail = buffer.toString('utf8');
    }
    return {
      size,
      endsWithNewline: partialTailBytes === 0,
      lastCompleteLine,
      partialTail,
      completeBytes,
      partialTailBytes,
    };
  } finally {
    await handle.close();
  }
}

/** 读取文件第一行（到第一个 \n 之前）；空文件返回 null */
export async function readFirstLine(file: string): Promise<string | null> {
  const handle = await open(file, 'r');
  try {
    const buffer = Buffer.allocUnsafe(CHUNK_SIZE);
    let carry = Buffer.alloc(0);
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, CHUNK_SIZE, null);
      if (bytesRead === 0) {
        return carry.length > 0 ? carry.toString('utf8') : null;
      }
      const chunk = Buffer.from(buffer.subarray(0, bytesRead));
      const combined = carry.length === 0 ? chunk : Buffer.concat([carry, chunk]);
      const idx = combined.indexOf(NEWLINE);
      if (idx >= 0) return combined.toString('utf8', 0, idx);
      carry = combined;
    }
  } finally {
    await handle.close();
  }
}

/**
 * 正序流式迭代完整行（不含换行符）。
 * 默认忽略尾部残行（未以 \n 结尾的最后一段）；`includePartialTail=true` 时也会产出。
 * 文件不存在视为空。
 */
export async function* iterateLinesForward(
  file: string,
  options: { includePartialTail?: boolean } = {},
): AsyncGenerator<string> {
  const handle = await open(file, 'r').catch(() => null);
  if (handle === null) return;
  try {
    const buffer = Buffer.allocUnsafe(CHUNK_SIZE);
    let carry: Buffer = Buffer.alloc(0);
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, CHUNK_SIZE, null);
      if (bytesRead === 0) break;
      const chunk = Buffer.from(buffer.subarray(0, bytesRead));
      const combined = carry.length === 0 ? chunk : Buffer.concat([carry, chunk]);
      let start = 0;
      let idx = combined.indexOf(NEWLINE, start);
      while (idx >= 0) {
        yield combined.toString('utf8', start, idx);
        start = idx + 1;
        idx = combined.indexOf(NEWLINE, start);
      }
      carry = start >= combined.length ? Buffer.alloc(0) : Buffer.from(combined.subarray(start));
    }
    if (options.includePartialTail === true && carry.length > 0) {
      yield carry.toString('utf8');
    }
  } finally {
    await handle.close();
  }
}

/**
 * 逆序流式迭代完整行（从最后一行到第一行）。
 * 尾部未闭合残行会被忽略；文件不存在视为空。
 */
export async function* iterateLinesReverse(file: string): AsyncGenerator<string> {
  const info = await readLastLineInfo(file);
  const end = info.completeBytes;
  if (end === 0) return;
  const handle = await open(file, 'r');
  try {
    let position = end;
    /** 始终只保存「尚未遇到换行的前缀」（可能是一行开头的一部分） */
    let buffer: Buffer = Buffer.alloc(0);
    while (position > 0) {
      const length = Math.min(CHUNK_SIZE, position);
      position -= length;
      const chunk = Buffer.allocUnsafe(length);
      await handle.read(chunk, 0, length, position);
      buffer = buffer.length === 0 ? chunk : Buffer.concat([chunk, buffer]);
      let cursorEnd = buffer.length;
      for (;;) {
        if (cursorEnd <= 0) break;
        const nl = buffer.lastIndexOf(NEWLINE, cursorEnd - 1);
        if (nl < 0) break;
        const line = buffer.toString('utf8', nl + 1, cursorEnd);
        cursorEnd = nl;
        if (line.length > 0) yield line;
      }
      buffer = cursorEnd === 0 ? Buffer.alloc(0) : Buffer.from(buffer.subarray(0, cursorEnd));
    }
    // 文件最开头的一行（其前没有 \n）
    if (buffer.length > 0) {
      const firstLine = buffer.toString('utf8');
      if (firstLine.length > 0) yield firstLine;
    }
  } finally {
    await handle.close();
  }
}

/** 截断文件到指定字节数（仅用于截断未提交残尾，docs §6.5-C） */
export async function truncateFileTo(file: string, size: number): Promise<void> {
  await truncate(file, size);
}

/** 完整行行数（按 \n 计数；残尾不计） */
export async function countCompleteLines(file: string): Promise<number> {
  let count = 0;
  for await (const _line of iterateLinesForward(file)) {
    count += 1;
    void _line;
  }
  return count;
}

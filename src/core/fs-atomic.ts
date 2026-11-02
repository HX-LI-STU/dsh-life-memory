// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hanxustu (dsh-life-memory)
/**
 * 文件系统原子操作与耐用写入工具。
 *
 * 原始层（L0）的崩溃安全依赖：
 *   - 追加数据：append + fsync（保证落盘顺序：先数据、后 state.json）；
 *   - state.json：写临时文件 -> fsync -> rename ->（尽力）fsync 目录，保证
 *     任何时刻磁盘上的 state.json 要么是旧版本、要么是新版本，不会半截；
 *   - 单写者锁：vault/state.lock 记录 pid + token，崩溃遗留的锁通过 pid 存活
 *     检测判定为 stale 并被接管。
 *
 * 平台注意：Windows 不允许对目录句柄 fsync，`fsyncDirBestEffort` 会静默忽略失败
 * （rename 本身在 NTFS 上是元数据原子操作，已足够）。
 */

import { randomBytes } from 'node:crypto';
import { open, mkdir, readFile, readdir, rename, rm, stat, unlink, writeFile } from 'node:fs/promises';
import type { Dirent, Stats } from 'node:fs';
import { basename, dirname, join } from 'node:path';

/** mkdir -p（幂等） */
export async function mkdirp(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
}

/** 尽力 fsync 目录（Windows 会失败，忽略） */
export async function fsyncDirBestEffort(dir: string): Promise<void> {
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    handle = await open(dir, 'r');
    await handle.sync();
  } catch {
    /* 平台不支持目录 fsync：忽略 */
  } finally {
    if (handle !== null) {
      try {
        await handle.close();
      } catch {
        /* ignore */
      }
    }
  }
}

/** 删除文件（不存在也不报错） */
export async function removeFileSafe(file: string): Promise<void> {
  try {
    await unlink(file);
  } catch {
    /* ignore */
  }
}

/** 是否存在（任意类型） */
export async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/** stat，失败返回 null */
export async function statSafe(path: string): Promise<Stats | null> {
  try {
    return await stat(path);
  } catch {
    return null;
  }
}

/** readdir，失败返回空数组 */
export async function readdirSafe(dir: string): Promise<Dirent[]> {
  try {
    return await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

/**
 * 原子写文件：同目录临时文件 + fsync + rename（+ 尽力 fsync 目录）。
 * 任何时刻读者只会看到完整旧文件或完整新文件。
 */
export async function atomicWriteFile(file: string, data: string | Uint8Array): Promise<void> {
  const dir = dirname(file);
  await mkdirp(dir);
  const tmp = join(dir, `.${basename(file)}.tmp-${process.pid}-${randomBytes(6).toString('hex')}`);
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    handle = await open(tmp, 'w');
    await handle.writeFile(data);
    await handle.sync();
    await handle.close();
    handle = null;
    await rename(tmp, file);
    await fsyncDirBestEffort(dir);
  } catch (error) {
    if (handle !== null) {
      try {
        await handle.close();
      } catch {
        /* ignore */
      }
    }
    await removeFileSafe(tmp);
    throw error;
  }
}

/** 原子写 JSON（紧凑格式；state/manifest 等元数据用） */
export async function atomicWriteJson(file: string, value: unknown): Promise<void> {
  await atomicWriteFile(file, JSON.stringify(value));
}

/**
 * 通过显式临时文件路径原子替换目标文件：
 * 写 tmp（可跨目录，需同卷）→ fsync → rename 覆盖 target → 尽力 fsync 目录。
 * docs/20 §5.3 要求 manifest 写到 `tmp/manifest.json.tmp` 再 rename 到根目录，
 * 因此不能用 atomicWriteFile（它把临时文件放目标同目录）。
 */
export async function atomicWriteViaTmp(
  tmpFile: string,
  targetFile: string,
  data: string | Uint8Array,
): Promise<void> {
  await mkdirp(dirname(tmpFile));
  await mkdirp(dirname(targetFile));
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    handle = await open(tmpFile, 'w');
    await handle.writeFile(data);
    await handle.sync();
    await handle.close();
    handle = null;
    await rename(tmpFile, targetFile);
    await fsyncDirBestEffort(dirname(targetFile));
  } catch (error) {
    if (handle !== null) {
      try {
        await handle.close();
      } catch {
        /* ignore */
      }
    }
    await removeFileSafe(tmpFile);
    throw error;
  }
}

/** 清空目录内所有普通文件（不含子目录）；用于启动时清理 tmp/ 残留 */
export async function cleanupDirFiles(dir: string): Promise<number> {
  const entries = await readdirSafe(dir);
  let removed = 0;
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    try {
      await unlink(join(dir, entry.name));
      removed += 1;
    } catch {
      /* ignore */
    }
  }
  return removed;
}

/** 读取文件尾部最多 maxBytes 字节（用于段尾扫描） */
export async function readTailBytes(file: string, maxBytes: number): Promise<Buffer> {
  const info = await statSafe(file);
  if (info === null || !info.isFile() || info.size === 0) return Buffer.alloc(0);
  const length = Math.min(info.size, Math.max(1, maxBytes));
  const handle = await open(file, 'r');
  try {
    const buffer = Buffer.allocUnsafe(length);
    await handle.read(buffer, 0, length, info.size - length);
    return buffer;
  } finally {
    await handle.close();
  }
}

/**
 * 读取 JSON 文件；文件不存在、解析失败、内容为 null 时返回 fallback。
 * 用于 state.json 损坏时的容错（调用方随后会走重建流程）。
 */
export async function readJsonFile<T>(file: string, fallback: T): Promise<T> {
  try {
    const raw = await readFile(file, 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || parsed === undefined) return fallback;
    return parsed as T;
  } catch {
    return fallback;
  }
}

/**
 * 追加写并 fsync（打开 -> 写 -> fsync -> 关闭）。
 * 调用方保证目录已存在；返回本次写入字节数。
 */
export async function appendFileDurable(file: string, data: string | Uint8Array): Promise<number> {
  const bytes = typeof data === 'string' ? Buffer.byteLength(data, 'utf8') : data.byteLength;
  const handle = await open(file, 'a');
  try {
    await handle.writeFile(data);
    await handle.sync();
  } finally {
    await handle.close();
  }
  return bytes;
}

// ---------------------------------------------------------------------------
// 单写者 pid 锁
// ---------------------------------------------------------------------------

/** 锁文件内容 */
export interface PidLockRecord {
  pid: number;
  /** 随机 token，释放时校验，避免误删他人的锁 */
  token: string;
  /** 加锁时间（epoch ms） */
  startedAt: number;
  /** 主机名（诊断用） */
  host: string;
}

/** 锁被其他存活进程持有 */
export class LockBusyError extends Error {
  readonly lockPath: string;
  readonly holder: PidLockRecord | null;

  constructor(lockPath: string, holder: PidLockRecord | null) {
    super(
      `[dsh-life-memory] vault is locked by pid ${holder?.pid ?? '?'} (started ${holder?.startedAt ?? '?'}); ` +
        `remove stale lock manually only if no process is writing: ${lockPath}`,
    );
    this.name = 'LockBusyError';
    this.lockPath = lockPath;
    this.holder = holder;
  }
}

/** 默认 pid 存活检测：ESRCH => 已死；EPERM => 存活但无权限 */
export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export interface PidLockOptions {
  /** 注入时钟（测试用） */
  now?: () => number;
  /** 注入 pid 存活检测（测试用） */
  isPidAlive?: (pid: number) => boolean;
  /** 指定 token（默认随机） */
  token?: string;
  /** >0：即使 pid 存活，持有时间超过该毫秒数也视为 stale（默认 0 = 只按 pid 判活） */
  staleMs?: number;
}

/** 读取锁文件内容；不存在/损坏返回 null */
export async function readPidLock(lockPath: string): Promise<PidLockRecord | null> {
  try {
    const raw = await readFile(lockPath, 'utf8');
    const parsed = JSON.parse(raw) as Partial<PidLockRecord>;
    if (
      typeof parsed.pid !== 'number' ||
      typeof parsed.token !== 'string' ||
      typeof parsed.startedAt !== 'number'
    ) {
      return null;
    }
    return {
      pid: parsed.pid,
      token: parsed.token,
      startedAt: parsed.startedAt,
      host: typeof parsed.host === 'string' ? parsed.host : '',
    };
  } catch {
    return null;
  }
}

/**
 * 获取单写者 pid 锁；返回释放函数（幂等）。
 *
 * 规则：
 *   - 无锁 / 锁文件损坏 => 接管；
 *   - 持有者 pid 已死 => 视为 stale，接管（stale-pid detection）；
 *   - 持有者就是当前进程 => 视为 stale（同进程重开：插件热重载场景；
 *     同进程内应只保留一个 openVault 实例，工厂会做缓存）；
 *   - 持有者其它存活进程 => 抛 LockBusyError。
 */
export async function acquirePidLock(lockPath: string, options: PidLockOptions = {}): Promise<() => Promise<void>> {
  const now = options.now ?? (() => Date.now());
  const alive = options.isPidAlive ?? isProcessAlive;
  const token = options.token ?? randomBytes(12).toString('hex');
  const staleMs = typeof options.staleMs === 'number' && options.staleMs > 0 ? options.staleMs : 0;
  await mkdirp(dirname(lockPath));

  for (let attempt = 0; attempt < 4; attempt += 1) {
    const existing = await readPidLock(lockPath);
    if (existing === null) {
      // 文件不存在或损坏：尝试原子创建（'wx' 保证只有一个赢家）
      const record: PidLockRecord = {
        pid: process.pid,
        token,
        startedAt: now(),
        host: hostName(),
      };
      try {
        await writeFile(lockPath, JSON.stringify(record), { encoding: 'utf8', flag: 'wx' });
        return makeReleaser(lockPath, token);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue;
        throw error;
      }
    }
    const age = now() - existing.startedAt;
    const staleByAge = staleMs > 0 && age > staleMs;
    if (existing.pid !== process.pid && alive(existing.pid) && !staleByAge) {
      throw new LockBusyError(lockPath, existing);
    }
    // stale：删除后重试（可能与其他进程竞争，最多 4 轮）
    await removeFileSafe(lockPath);
  }
  throw new LockBusyError(lockPath, await readPidLock(lockPath));
}

/** 释放锁：仅当 token 匹配才删除（避免误删已接管的锁） */
export async function releasePidLock(lockPath: string, token: string): Promise<void> {
  const current = await readPidLock(lockPath);
  if (current !== null && current.token === token) {
    await removeFileSafe(lockPath);
  }
}

function makeReleaser(lockPath: string, token: string): () => Promise<void> {
  let released = false;
  return async () => {
    if (released) return;
    released = true;
    await releasePidLock(lockPath, token);
  };
}

function hostName(): string {
  try {
    return process.env.COMPUTERNAME ?? process.env.HOSTNAME ?? '';
  } catch {
    return '';
  }
}

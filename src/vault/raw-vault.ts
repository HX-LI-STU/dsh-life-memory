// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hanxustu (dsh-life-memory)
/**
 * L0 原始记忆库实现：append-only JSONL 段文件 + sha256 哈希链 + manifest 清单。
 *
 * 生命周期与不变量（docs/20 §5/§6）：
 *   - 程序只追加，永不重写/删除/rename 已提交的段文件；
 *   - 每行 = 一条 RawRecord（固定字段顺序 + 固定哈希算法，见 vault/record.ts）；
 *   - append 顺序：分配 id/seq/hash → 追加并 fsync 段文件 → 原子写 manifest
 *     （tmp+fsync+rename）→ 更新内存状态；任何一步失败都回滚本批已写入的未提交尾
 *     （truncate 回原字节数，仅限未提交数据）；
 *   - manifest 是缓存：缺失/损坏/落后时从段文件全量重扫重建；
 *   - 恢复时只做「补 manifest / 截断未提交残尾」两类动作，绝不修改已提交记录。
 *
 * 单写者假设：文件层的 id/seq 分配由本实例从 manifest/段文件推导完成；同一 vault
 * 根目录在同一时刻应只有一个活跃 RawVault 实例（DSH 插件单进程；多进程并发追加
 * 需要 DB 写锁做仲裁，属于集成层的 SQLite 事务职责，见 docs/20 §6.3）。
 */

import { randomBytes, randomUUID } from 'node:crypto';
import { open } from 'node:fs/promises';
import { dirname } from 'node:path';

import type {
  AppendResult,
  Logger,
  MemoryVaultConfig,
  RawAppendItem,
  RawQuery,
  RawRecord,
  RawRecordInput,
  RawVault,
  RawVaultOptions,
  VerifyResult,
  VaultManifest as ContractVaultManifest,
  VaultStats,
} from '../core/contracts.ts';
import { GENESIS_HASH } from '../core/contracts.ts';
import {
  appendFileDurable,
  atomicWriteFile,
  atomicWriteViaTmp,
  cleanupDirFiles,
  mkdirp,
  readJsonFile,
  readdirSafe,
  removeFileSafe,
  statSafe,
} from '../core/fs-atomic.ts';
import { sha256Hex } from '../core/hash.ts';
import { formatRawId, parseRawId } from '../core/ids.ts';
import { silentLogger } from '../core/logger.ts';
import { dateInTimeZone, isValidTimeZone } from '../core/time.ts';

import {
  absoluteFromRelative,
  isSessionKey,
  normalizeWriterId,
  parseSegmentFileName,
  parseSegmentRelativePath,
  relativeSegmentPath,
  sanitizeSessionKey,
  segmentAbsolutePath,
  segmentFileName,
  vaultPaths,
  VERSION_CONTENT,
  SUPPORTED_VAULT_VERSIONS,
  type VaultPaths,
} from './layout.ts';
import {
  computeManifestStats,
  emptyManifest,
  parseManifest,
  refreshManifestDerived,
  sortSegments,
  type ManifestSegment,
  type VaultManifest,
} from './manifest.ts';
import { mergeSortedAsync } from './merge.ts';
import {
  buildRawRecord,
  hashRawRecord,
  normalizeRawRecordInput,
  parseRecordLine,
  serializeRecordLine,
  type ParseRecordResult,
} from './record.ts';
import {
  iterateLinesForward,
  iterateLinesReverse,
  readFirstLine,
  readLastLineInfo,
  truncateFileTo,
} from './lines.ts';

/** 打开 vault 的运行时选项（非契约字段：日志/时钟/诊断开关，测试可注入） */
export interface RawVaultRuntimeOptions {
  /** 日志器（默认静默） */
  logger?: Logger;
  /** 注入时钟（manifest updatedAt / writer heartbeat；测试用） */
  now?: () => number;
  /** 是否维护 locks/writer.json 诊断文件（默认 true） */
  writerInfo?: boolean;
}

/** 有记录的行位置（内部用；record 为 null 表示该行无法解析） */
interface LocatedRecord {
  record: RawRecord | null;
  line: string;
  segment: ManifestSegment;
}

/** 磁盘上的段文件清单项（扫描结果） */
interface SegmentFileInfo {
  day: string;
  /** 会话目录名；v1 旧布局为 null */
  sessionKey: string | null;
  name: string;
  writerId: string;
  segNo: number;
  relPath: string;
  absPath: string;
  size: number;
}

/** 本批处理的写入目标（一个段文件） */
interface PendingWrite {
  entry: ManifestSegment;
  isNew: boolean;
  absPath: string;
  chunks: string[];
  count: number;
  pendingBytes: number;
  firstSeq: number;
  lastSeq: number;
  headHash: string;
  tailHash: string;
}

/** 本进程内一个可继续追加的段 */
interface ActiveSegment {
  entry: ManifestSegment;
  absPath: string;
  isNew: boolean;
}

/** 记录到写入目标 + 行内偏移 */
interface PendingLine {
  record: RawRecord;
  relPath: string;
  lineNo: number;
  byteOffset: number;
  byteLen: number;
  ingestKey: string;
  /** 对应的写入目标（提交后构建 location 用） */
  write: PendingWrite;
}

/** 单批最多允许的输入条数（防止一次 append 长时间持锁；捕获层按 maxBatchSize 分批） */
export const MAX_APPEND_BATCH = 100_000;

/** writer.json 心跳间隔（ms） */
const WRITER_HEARTBEAT_INTERVAL_MS = 15_000;

/**
 * L0 原始记忆库实现（见模块头注释与 contracts.ts 的 RawVault 接口）。
 */
export class RawVaultImpl implements RawVault {
  readonly rootDir: string;
  readonly paths: VaultPaths;
  readonly writerId: string;

  private readonly log: Logger;
  private readonly clock: () => number;
  private readonly timezone: string;
  private readonly segmentMaxBytes: number;
  private readonly segmentMaxRecords: number;
  private readonly fsyncEnabled: boolean;
  private readonly writerInfoEnabled: boolean;
  private readonly seenIngestKeys: ((ingestKey: string) => boolean) | undefined;
  private readonly startedAt: number;

  private state: VaultManifest;
  private lastSeq: number;
  private lastHash: string;
  private readonly daySeq = new Map<string, number>();
  private readonly nextSegNo = new Map<string, number>();
  private readonly activeSegments = new Map<string, ActiveSegment>();
  private writeChain: Promise<unknown> = Promise.resolve();
  private closed = false;
  private lastWriterInfoAt = 0;

  private constructor(
    options: RawVaultOptions,
    paths: VaultPaths,
    writerId: string,
    runtime: RawVaultRuntimeOptions,
  ) {
    this.paths = paths;
    this.rootDir = paths.rootDir;
    this.writerId = writerId;
    this.log = runtime.logger ?? silentLogger;
    this.clock = runtime.now ?? (() => Date.now());
    this.writerInfoEnabled = runtime.writerInfo !== false;
    this.timezone = options.timezone;
    this.segmentMaxBytes =
      typeof options.segmentMaxBytes === 'number' && options.segmentMaxBytes > 0
        ? options.segmentMaxBytes
        : 8 * 1024 * 1024;
    this.segmentMaxRecords =
      typeof options.segmentMaxRecords === 'number' && options.segmentMaxRecords > 0
        ? options.segmentMaxRecords
        : 2_000;
    this.fsyncEnabled = options.fsync !== false;
    this.seenIngestKeys = options.seenIngestKeys;
    this.startedAt = this.clock();
    this.state = emptyManifest(randomUUID(), this.startedAt);
    this.lastSeq = 0;
    this.lastHash = GENESIS_HASH;
  }

  // -------------------------------------------------------------------------
  // 打开 / 初始化 / 恢复
  // -------------------------------------------------------------------------

  /**
   * 打开（或创建）一个 vault：建目录、清 tmp、校验 VERSION、恢复 manifest、
   * 封存旧段、写入诊断文件。失败时抛出（调用方不应继续使用该实例）。
   */
  static async open(
    options: RawVaultOptions,
    runtime: RawVaultRuntimeOptions = {},
  ): Promise<RawVaultImpl> {
    if (typeof options !== 'object' || options === null) {
      throw new TypeError('[dsh-life-memory] openRawVault: options is required');
    }
    if (typeof options.rootDir !== 'string' || options.rootDir.length === 0) {
      throw new TypeError('[dsh-life-memory] openRawVault: rootDir must be a non-empty string');
    }
    if (typeof options.timezone !== 'string' || !isValidTimeZone(options.timezone)) {
      throw new TypeError(
        `[dsh-life-memory] openRawVault: invalid IANA timezone ${String(options.timezone)}`,
      );
    }
    const writerId = normalizeWriterId(options.writerId) ?? randomBytes(3).toString('hex');
    const paths = vaultPaths(options.rootDir);
    const vault = new RawVaultImpl(options, paths, writerId, runtime);
    await vault.initialize();
    return vault;
  }

  private async initialize(): Promise<void> {
    await mkdirp(this.paths.rootDir);
    await mkdirp(this.paths.segmentsDir);
    await mkdirp(this.paths.tmpDir);
    await mkdirp(this.paths.locksDir);

    // 1. 清理 tmp/ 残留（docs §6.5 恢复入口第 1 步）
    const cleaned = await cleanupDirFiles(this.paths.tmpDir);
    if (cleaned > 0) this.log.info(`[vault] cleaned ${cleaned} stale tmp file(s)`);

    // 2. VERSION 校验/初始化
    await this.ensureVersionFile();

    // 3. 扫描段文件 + manifest 对账（缺失/损坏/落后 => 全量重建）
    const inventory = await this.scanInventory();
    const loadedRaw = await readJsonFile<unknown>(this.paths.manifestPath, null);
    let loaded: VaultManifest | null = null;
    if (loadedRaw !== null) {
      loaded = parseManifest(loadedRaw);
      if (loaded === null) this.log.warn('[vault] manifest.json is invalid, rebuilding from segments');
    }
    let manifest: VaultManifest;
    if (loaded !== null && (await this.manifestMatchesFiles(loaded, inventory))) {
      manifest = loaded;
    } else {
      manifest = await this.rebuildManifest(inventory, loaded?.vaultId);
    }

    // 4. 本实例打开后封存所有旧段（此后只写本实例新建的段；崩溃残留的未封口段也在此封存）
    for (const segment of manifest.segments) segment.sealed = true;
    this.state = manifest;
    refreshManifestDerived(this.state, this.clock());

    this.lastSeq = this.state.lastSeq;
    this.lastHash = this.state.lastHash;
    for (const [day, value] of Object.entries(this.state.days)) this.daySeq.set(day, value.daySeq);
    this.recomputeNextSegNo();
    this.activeSegments.clear();

    // 5. 原子写回 manifest（即使无变化也写入：确保持久化 vaultId / 封口状态 / 统计）
    await this.writeManifest();
    await this.writeWriterInfo(true).catch((error: unknown) => {
      this.log.warn('[vault] failed to write locks/writer.json', error);
    });
  }

  /**
   * 读取/初始化 VERSION 文件（内容 "1\n" 旧布局 / "2\n" 会话分目录）。
   * 兼容口径：reader 同时接受 1 与 2；旧库（"1"）打开时**只升级 VERSION 元数据**
   * 到 2（新数据按 v2 路径写入），旧的段文件保持原样、不迁移、不重写。
   */
  private async ensureVersionFile(): Promise<void> {
    const info = await statSafe(this.paths.versionPath);
    if (info === null) {
      await atomicWriteFile(this.paths.versionPath, VERSION_CONTENT);
      return;
    }
    const handle = await open(this.paths.versionPath, 'r');
    let content = '';
    try {
      const buffer = Buffer.allocUnsafe(64);
      const { bytesRead } = await handle.read(buffer, 0, 64, 0);
      content = buffer.toString('utf8', 0, bytesRead);
    } finally {
      await handle.close();
    }
    const version = content.trim();
    if (!SUPPORTED_VAULT_VERSIONS.includes(version)) {
      throw new Error(
        `[dsh-life-memory] unsupported vault VERSION "${version}" at ${this.paths.versionPath}; ` +
          `this build supports record layout version ${SUPPORTED_VAULT_VERSIONS.join(', ')}`,
      );
    }
    if (version !== String(VERSION_CONTENT).trim()) {
      // v1 → v2：仅升级版本标记（老段文件保留在原路径；不迁移、不重写）
      this.log.info(`[vault] upgrading VERSION ${version} -> ${VERSION_CONTENT.trim()} (legacy segments kept as-is)`);
      await atomicWriteFile(this.paths.versionPath, VERSION_CONTENT);
    }
  }

  /**
   * 扫描 segments/ 目录，返回按 (day, sessionKey, segNo, writerId) 升序的文件清单。
   *
   * 同时接受两种布局（向后兼容）：
   *   - v1：`segments/<day>/<name>.jsonl`（旧库；sessionKey=null）
   *   - v2：`segments/<day>/<sessionKey>/<name>.jsonl`（按会话物理隔离）
   * 只信任文件名/目录名形状，不假设新数据一定是 v2；manifest 才是段列表权威。
   */
  private async scanInventory(): Promise<SegmentFileInfo[]> {
    const out: SegmentFileInfo[] = [];
    const scanFile = async (day: string, sessionKey: string | null, dir: string, name: string): Promise<void> => {
      const parsed = parseSegmentFileName(name);
      if (parsed === null) return;
      const absPath = `${dir}/${name}`;
      const info = await statSafe(absPath);
      if (info === null || !info.isFile()) return;
      out.push({
        day,
        sessionKey,
        name,
        writerId: parsed.writerId,
        segNo: parsed.segNo,
        relPath: relativeSegmentPath(day, name, sessionKey),
        absPath,
        size: info.size,
      });
    };
    const dayEntries = await readdirSafe(this.paths.segmentsDir);
    for (const dayEntry of dayEntries) {
      if (!dayEntry.isDirectory()) continue;
      const day = dayEntry.name;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) continue;
      const dayDir = `${this.paths.segmentsDir}/${day}`;
      const entries = await readdirSafe(dayDir);
      for (const entry of entries) {
        if (entry.isFile()) {
          await scanFile(day, null, dayDir, entry.name);
          continue;
        }
        if (!entry.isDirectory() || !isSessionKey(entry.name)) continue;
        const sessionDir = `${dayDir}/${entry.name}`;
        const files = await readdirSafe(sessionDir);
        for (const file of files) {
          if (!file.isFile()) continue;
          await scanFile(day, entry.name, sessionDir, file.name);
        }
      }
    }
    return out.sort((a, b) => {
      if (a.day !== b.day) return a.day < b.day ? -1 : 1;
      const keyA = a.sessionKey ?? '';
      const keyB = b.sessionKey ?? '';
      if (keyA !== keyB) return keyA < keyB ? -1 : 1;
      if (a.segNo !== b.segNo) return a.segNo - b.segNo;
      return a.writerId < b.writerId ? -1 : a.writerId > b.writerId ? 1 : 0;
    });
  }

  /**
   * 校验 manifest 是否与磁盘一致：段文件齐全、字节数一致、首尾行 hash/seq 一致、
   * 无未提交残尾、无未知非空段文件。任一不满足返回 false（触发重建）。
   */
  private async manifestMatchesFiles(
    manifest: VaultManifest,
    inventory: readonly SegmentFileInfo[],
  ): Promise<boolean> {
    const byRelPath = new Map(inventory.map((file) => [file.relPath, file]));
    for (const segment of manifest.segments) {
      const file = byRelPath.get(segment.segment);
      if (file === undefined) return false;
      if (file.day !== segment.day) return false;
      // v2：manifest 的 sessionId 必须与所在会话目录一致（目录名 = sanitizeSessionKey(sessionId)）
      if (segment.sessionId != null && file.sessionKey !== null) {
        if (sanitizeSessionKey(segment.sessionId) !== file.sessionKey) return false;
      }
      const tail = await readLastLineInfo(file.absPath);
      if (tail.partialTailBytes !== 0) return false;
      if (tail.size !== segment.bytes) return false;
      if (segment.records === 0) {
        if (segment.bytes !== 0) return false;
        continue;
      }
      if (tail.lastCompleteLine === null) return false;
      const last = parseRecordLine(tail.lastCompleteLine);
      if (!last.ok) return false;
      if (last.record.hash !== segment.tailHash || last.record.seq !== segment.lastSeq) return false;
      const firstLine = await readFirstLine(file.absPath);
      if (firstLine === null) return false;
      const first = parseRecordLine(firstLine);
      if (!first.ok) return false;
      if (first.record.hash !== segment.headHash || first.record.seq !== segment.firstSeq) return false;
    }
    // 反向覆盖：inventory 中的非空文件必须在 manifest 中
    for (const file of inventory) {
      if (file.size === 0) continue; // 回滚遗留的空段文件允许存在（不承载数据）
      if (!manifest.segments.some((segment) => segment.segment === file.relPath)) return false;
    }
    // days 缓存自洽性：有段的日期必须有 daySeq 记录
    for (const segment of manifest.segments) {
      const day = manifest.days[segment.day];
      if (day === undefined || day.daySeq < 1) return false;
    }
    return true;
  }

  /**
   * 从段文件全量重建 manifest（docs §5.3：manifest 是可重建缓存）。
   * - 只截断「每个 writer+day 的最新一段」的未提交残尾，其它残尾只报告；
   * - 空段文件不进入 manifest（保留文件，允许后续复用）；
   * - daySeq 取该日期所有记录 id 的最大当日序号。
   */
  private async rebuildManifest(
    inventory: readonly SegmentFileInfo[],
    knownVaultId: string | undefined,
  ): Promise<VaultManifest> {
    this.log.warn(`[vault] rebuilding manifest from ${inventory.length} segment file(s)`);
    const maxSegNoByWriterDay = new Map<string, number>();
    for (const file of inventory) {
      const key = `${file.day}/${file.sessionKey ?? ''}/${file.writerId}`;
      const current = maxSegNoByWriterDay.get(key) ?? 0;
      if (file.segNo > current) maxSegNoByWriterDay.set(key, file.segNo);
    }
    const segments: ManifestSegment[] = [];
    const daySeqMap = new Map<string, number>();
    for (const file of inventory) {
      const tail = await readLastLineInfo(file.absPath);
      let size = tail.size;
      if (tail.partialTailBytes > 0) {
        const isNewestForWriter =
          maxSegNoByWriterDay.get(`${file.day}/${file.sessionKey ?? ''}/${file.writerId}`) === file.segNo;
        if (isNewestForWriter) {
          await truncateFileTo(file.absPath, tail.completeBytes);
          size = tail.completeBytes;
          this.log.warn(
            `[vault] truncated torn tail (${tail.partialTailBytes} bytes) of ${file.relPath} (docs/20 §6.5-C)`,
          );
        } else {
          this.log.error(
            `[vault] partial tail in non-newest segment ${file.relPath}; left untouched (integrity issue)`,
          );
        }
      }
      let records = 0;
      let head: RawRecord | null = null;
      let last: RawRecord | null = null;
      for await (const line of iterateLinesForward(file.absPath)) {
        if (line.length === 0) continue;
        const parsed = parseRecordLine(line);
        if (!parsed.ok) {
          this.log.error(`[vault] corrupt record line in ${file.relPath}: ${parsed.reason}`);
          continue;
        }
        records += 1;
        if (head === null) head = parsed.record;
        last = parsed.record;
        const idParts = parseRawId(parsed.record.id);
        if (idParts !== null) {
          const current = daySeqMap.get(parsed.record.day) ?? 0;
          if (idParts.daySeq > current) daySeqMap.set(parsed.record.day, idParts.daySeq);
        }
      }
      if (records === 0 || head === null || last === null) continue;
      segments.push({
        segment: file.relPath,
        day: file.day,
        writerId: `w${file.writerId}`,
        records,
        bytes: size,
        headHash: head.hash,
        tailHash: last.hash,
        sealed: true,
        firstSeq: head.seq,
        lastSeq: last.seq,
        // v2 段：从首条记录恢复原始 sessionId（目录名可能被截断/替换，不能反推）；
        // v1 旧段可能混写多个会话，故为 null。
        sessionId: file.sessionKey === null ? null : head.sessionId,
      });
      const currentDaySeq = daySeqMap.get(file.day) ?? 0;
      if (currentDaySeq < records) daySeqMap.set(file.day, records);
    }
    const vaultId = knownVaultId ?? randomUUID();
    const manifest = emptyManifest(vaultId, this.clock());
    manifest.segments = sortSegments(segments);
    for (const [day, daySeq] of daySeqMap) manifest.days[day] = { daySeq };
    refreshManifestDerived(manifest, this.clock());
    return manifest;
  }

  /**
   * 重新计算每个「(日期, 会话目录)」的下一个段号（本 writer 在該组已用的最大 segNo + 1）。
   * 段号只在同一会话目录内需要唯一；不同会话互不影响。
   */
  private recomputeNextSegNo(): void {
    this.nextSegNo.clear();
    for (const segment of this.state.segments) {
      if (segment.writerId !== `w${this.writerId}`) continue;
      const parsed = parseSegmentRelativePath(segment.segment);
      if (parsed === null) continue;
      const key = segmentGroupKey(segment.day, parsed.sessionKey);
      const current = this.nextSegNo.get(key) ?? 1;
      if (parsed.segNo >= current) this.nextSegNo.set(key, parsed.segNo + 1);
    }
  }

  /** 原子写 manifest（tmp + fsync + rename，docs §5.3/§6.6） */
  private async writeManifest(): Promise<void> {
    refreshManifestDerived(this.state, this.clock());
    await atomicWriteViaTmp(
      this.paths.manifestTmpPath,
      this.paths.manifestPath,
      JSON.stringify(this.state),
    );
  }

  /** 写 locks/writer.json 诊断文件（不参与正确性，失败不影响主流程） */
  private async writeWriterInfo(force: boolean): Promise<void> {
    if (!this.writerInfoEnabled) return;
    const now = this.clock();
    if (!force && now - this.lastWriterInfoAt < WRITER_HEARTBEAT_INTERVAL_MS) return;
    const info = {
      writerId: `w${this.writerId}`,
      pid: process.pid,
      hostname: process.env.COMPUTERNAME ?? process.env.HOSTNAME ?? '',
      startedAt: this.startedAt,
      heartbeatAt: now,
    };
    await atomicWriteFile(this.paths.writerInfoPath, JSON.stringify(info));
    this.lastWriterInfoAt = now;
  }

  // -------------------------------------------------------------------------
  // 追加（核心写协议）
  // -------------------------------------------------------------------------

  /**
   * 追加一批原始记录（docs/20 §6.1 的文件层部分）：
   *   校验 → ingestKey 去重（跳过，不分配 seq）→ 分配 id/seq/day/hash →
   *   按日期/阈值选择段文件 → 追加+fsync → 原子写 manifest → 返回 items。
   *
   * 失败的批会回滚本批写入的未提交尾（truncate 到原字节数）后抛出。
   */
  async append(batch: RawRecordInput[]): Promise<AppendResult> {
    this.assertOpen();
    if (!Array.isArray(batch)) {
      throw new TypeError('[dsh-life-memory] append: batch must be an array');
    }
    if (batch.length === 0) return { items: [], skipped: 0, segmentsWritten: [] };
    if (batch.length > MAX_APPEND_BATCH) {
      throw new RangeError(
        `[dsh-life-memory] append: batch too large (${batch.length} > ${MAX_APPEND_BATCH}); split the batch`,
      );
    }
    return this.enqueue(() => this.appendExclusive(batch));
  }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.writeChain.then(task, task);
    this.writeChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async appendExclusive(batch: readonly RawRecordInput[]): Promise<AppendResult> {
    // 1) 结构校验（全部通过后才分配 seq / 写文件）
    const normalized = batch.map((input, index) => normalizeRawRecordInput(input, index));

    // 2) ingestKey 去重：批内 + seenIngestKeys 回调（docs §6.4；跳过发生在分配 seq 之前）
    const accepted: Array<{ input: RawRecordInput; ingestKey: string }> = [];
    const batchKeys = new Set<string>();
    let skipped = 0;
    for (const input of normalized) {
      const ingestKey = resolveIngestKey(input);
      if (batchKeys.has(ingestKey)) {
        skipped += 1;
        continue;
      }
      batchKeys.add(ingestKey);
      if (this.seenIngestKeys !== undefined && this.seenIngestKeys(ingestKey)) {
        skipped += 1;
        continue;
      }
      accepted.push({ input, ingestKey });
    }
    if (accepted.length === 0) return { items: [], skipped, segmentsWritten: [] };

    // 3) 分配 id/seq/day/iso/hash（链式推进）
    const records: RawRecord[] = [];
    let seq = this.lastSeq;
    let prevHash = this.lastHash;
    const pendingDaySeq = new Map(this.daySeq);
    for (const { input } of accepted) {
      const day = dateInTimeZone(input.ts, this.timezone);
      const nextDaySeq = (pendingDaySeq.get(day) ?? 0) + 1;
      pendingDaySeq.set(day, nextDaySeq);
      seq += 1;
      const record = buildRawRecord(input, {
        id: formatRawId(day, nextDaySeq),
        seq,
        day,
        iso: new Date(input.ts).toISOString(),
        prevHash,
      });
      prevHash = record.hash;
      records.push(record);
    }

    // 4) 按 (日期, 会话目录) / 阈值分组到段文件（本批可能写多个段、多个会话目录）
    const localActive = new Map(this.activeSegments);
    const localNextSegNo = new Map(this.nextSegNo);
    const pendingWrites: PendingWrite[] = [];
    const writeByPath = new Map<string, PendingWrite>();
    const sealedSegments = new Set<string>();
    const newEntries: ManifestSegment[] = [];
    const pendingLines: PendingLine[] = [];
    const ensureActive = (day: string, sessionKey: string, sessionId: string): ActiveSegment => {
      const groupKey = segmentGroupKey(day, sessionKey);
      const existing = localActive.get(groupKey);
      if (existing !== undefined) return existing;
      const segNo = localNextSegNo.get(groupKey) ?? 1;
      localNextSegNo.set(groupKey, segNo + 1);
      const name = segmentFileName(this.writerId, segNo);
      const entry: ManifestSegment = {
        // v2 写入路径：segments/<day>/<sessionKey>/<name>.jsonl
        segment: relativeSegmentPath(day, name, sessionKey),
        day,
        writerId: `w${this.writerId}`,
        records: 0,
        bytes: 0,
        headHash: '',
        tailHash: '',
        sealed: false,
        firstSeq: 0,
        lastSeq: 0,
        sessionId,
      };
      const active: ActiveSegment = {
        entry,
        absPath: segmentAbsolutePath(this.paths, day, name, sessionKey),
        isNew: true,
      };
      newEntries.push(entry);
      localActive.set(groupKey, active);
      return active;
    };

    for (let i = 0; i < records.length; i += 1) {
      const record = records[i];
      const day = record.day;
      // 物理隔离单位：同一批次可能包含多个 sessionId ⇒ 各自写自己的会话目录；
      // 段内行顺序/哈希链仍按本批的全局 seq 顺序（prevHash 不因分目录断裂）。
      const sessionKey = sanitizeSessionKey(record.sessionId);
      const groupKey = segmentGroupKey(day, sessionKey);
      const line = serializeRecordLine(record);
      const lineBytes = Buffer.byteLength(line, 'utf8') + 1;
      let active = localActive.get(groupKey);
      if (active !== undefined) {
        const write = writeByPath.get(active.entry.segment);
        const committedBytes = active.entry.bytes + (write?.pendingBytes ?? 0);
        const committedRecords = active.entry.records + (write?.count ?? 0);
        const shouldRotate =
          committedRecords >= this.segmentMaxRecords ||
          (committedBytes > 0 && committedBytes + lineBytes > this.segmentMaxBytes);
        if (shouldRotate) {
          active.entry.sealed = true;
          sealedSegments.add(active.entry.segment);
          localActive.delete(groupKey);
          active = undefined;
        }
      }
      if (active === undefined) active = ensureActive(day, sessionKey, record.sessionId);
      let write = writeByPath.get(active.entry.segment);
      if (write === undefined) {
        write = {
          entry: active.entry,
          isNew: active.isNew,
          absPath: active.absPath,
          chunks: [],
          count: 0,
          pendingBytes: 0,
          firstSeq: 0,
          lastSeq: 0,
          headHash: '',
          tailHash: '',
        };
        writeByPath.set(active.entry.segment, write);
        pendingWrites.push(write);
      }
      pendingLines.push({
        record,
        relPath: write.entry.segment,
        lineNo: write.entry.records + write.count + 1,
        byteOffset: write.entry.bytes + write.pendingBytes,
        byteLen: lineBytes,
        ingestKey: accepted[i].ingestKey,
        write,
      });
      if (write.count === 0) {
        write.firstSeq = record.seq;
        write.headHash = record.hash;
      }
      write.count += 1;
      write.pendingBytes += lineBytes;
      write.lastSeq = record.seq;
      write.tailHash = record.hash;
      write.chunks.push(`${line}\n`);
    }

    // 5) 写段文件（每个目标文件一次 append + fsync）；失败则回滚已写文件
    const written: Array<{ absPath: string; originalBytes: number }> = [];
    try {
      for (const write of pendingWrites) {
        await mkdirp(dirname(write.absPath));
        written.push({ absPath: write.absPath, originalBytes: write.entry.bytes });
        const data = write.chunks.join('');
        if (this.fsyncEnabled) {
          await appendFileDurable(write.absPath, data);
        } else {
          const handle = await open(write.absPath, 'a');
          try {
            await handle.writeFile(data);
          } finally {
            await handle.close();
          }
        }
      }
      // 6) 提交 manifest（内存 + 原子写盘）
      for (const write of pendingWrites) {
        write.entry.records += write.count;
        write.entry.bytes += write.pendingBytes;
        write.entry.firstSeq = write.entry.records === write.count ? write.firstSeq : write.entry.firstSeq;
        write.entry.headHash = write.entry.records === write.count ? write.headHash : write.entry.headHash;
        write.entry.lastSeq = write.lastSeq;
        write.entry.tailHash = write.tailHash;
      }
      for (const entry of newEntries) {
        if (!this.state.segments.includes(entry)) this.state.segments.push(entry);
      }
      for (const relPath of sealedSegments) {
        const entry = this.state.segments.find((segment) => segment.segment === relPath);
        if (entry !== undefined) entry.sealed = true;
      }
      for (const [day, daySeq] of pendingDaySeq) {
        const current = this.state.days[day]?.daySeq ?? 0;
        if (daySeq > current) this.state.days[day] = { daySeq };
      }
      this.state.updatedAt = this.clock();
      refreshManifestDerived(this.state, this.clock());
      await this.writeManifest();

      // 7) 提交内存状态（仅在本批所有文件与 manifest 都成功后）
      this.lastSeq = records[records.length - 1].seq;
      this.lastHash = records[records.length - 1].hash;
      for (const [day, daySeq] of pendingDaySeq) this.daySeq.set(day, daySeq);
      for (const [groupKey, next] of localNextSegNo) this.nextSegNo.set(groupKey, next);
      this.activeSegments.clear();
      for (const [groupKey, active] of localActive) {
        active.isNew = false;
        this.activeSegments.set(groupKey, active);
      }
    } catch (error) {
      // 回滚本批已写入的未提交数据（只 truncate，不删除/重命名段文件）
      for (const item of written.reverse()) {
        try {
          await truncateFileTo(item.absPath, item.originalBytes);
        } catch (rollbackError) {
          this.log.error(
            `[vault] rollback truncate failed for ${item.absPath}; recovery will adopt/repair on next open`,
            rollbackError,
          );
        }
      }
      throw error;
    }

    await this.writeWriterInfo(false).catch((writeError: unknown) => {
      this.log.warn('[vault] failed to update locks/writer.json heartbeat', writeError);
    });

    const items: RawAppendItem[] = pendingLines.map((line) => ({
      record: line.record,
      location: {
        ingestKey: line.ingestKey,
        segment: line.relPath,
        lineNo: line.lineNo,
        byteOffset: line.byteOffset,
        byteLen: line.byteLen,
      },
    }));
    const segmentsWritten: string[] = [];
    const seenSegments = new Set<string>();
    for (const line of pendingLines) {
      if (seenSegments.has(line.relPath)) continue;
      seenSegments.add(line.relPath);
      segmentsWritten.push(line.relPath);
    }
    return { items, skipped, segmentsWritten };
  }

  // -------------------------------------------------------------------------
  // 读取（get / list / iterate）
  // -------------------------------------------------------------------------

  async get(id: string): Promise<RawRecord | null> {
    this.assertOpen();
    const parts = parseRawId(id);
    if (parts === null) return null;
    const daySegments = this.state.segments.filter((segment) => segment.day === parts.date);
    for (let i = daySegments.length - 1; i >= 0; i -= 1) {
      const segment = daySegments[i];
      const absPath = absoluteFromRelative(this.paths, segment.segment);
      for await (const record of this.iterateSegmentRecords(segment, absPath, true)) {
        if (record.id === id) return record;
        const recordParts = parseRawId(record.id);
        if (recordParts !== null && recordParts.daySeq < parts.daySeq) break;
      }
    }
    return null;
  }

  async list(query: RawQuery = {}): Promise<{ records: RawRecord[]; total: number }> {
    this.assertOpen();
    const normalized = normalizeRawQuery(query);
    if (normalized.ids !== undefined && normalized.ids.length > 0) {
      const found = await this.collectByIds(normalized.ids, normalized.desc === true);
      const total = found.length;
      const offset = normalized.offset ?? 0;
      const limit = normalized.limit ?? Number.POSITIVE_INFINITY;
      return { records: found.slice(offset, offset + limit), total };
    }
    const predicate = buildRawPredicate(normalized);
    const records: RawRecord[] = [];
    let total = 0;
    const offset = normalized.offset ?? 0;
    const limit = normalized.limit ?? Number.POSITIVE_INFINITY;
    for await (const record of this.iterateAllRecords(normalized.desc === true)) {
      if (!predicate(record)) continue;
      total += 1;
      if (total <= offset) continue;
      if (records.length < limit) records.push(record);
    }
    return { records, total };
  }

  async *iterate(query: RawQuery = {}): AsyncIterable<RawRecord> {
    this.assertOpen();
    const normalized = normalizeRawQuery(query);
    const offset = normalized.offset ?? 0;
    const limit = normalized.limit ?? Number.POSITIVE_INFINITY;
    const predicate = buildRawPredicate(normalized);
    if (normalized.ids !== undefined && normalized.ids.length > 0) {
      const found = await this.collectByIds(normalized.ids, normalized.desc === true);
      yield* found.slice(offset, offset + limit);
      return;
    }
    let skipped = 0;
    let yielded = 0;
    for await (const record of this.iterateAllRecords(normalized.desc === true)) {
      if (!predicate(record)) continue;
      if (skipped < offset) {
        skipped += 1;
        continue;
      }
      if (yielded >= limit) return;
      yielded += 1;
      yield record;
    }
  }

  private async collectByIds(ids: readonly string[], desc: boolean): Promise<RawRecord[]> {
    const seen = new Set<string>();
    const found: RawRecord[] = [];
    for (const id of ids) {
      if (typeof id !== 'string' || seen.has(id)) continue;
      seen.add(id);
      const record = await this.get(id);
      if (record !== null) found.push(record);
    }
    found.sort((a, b) => a.seq - b.seq);
    if (desc) found.reverse();
    return found;
  }

  /** 单个段的正序/逆序记录迭代（跳过损坏行，损坏由 verify 报告） */
  private async *iterateSegmentRecords(
    segment: ManifestSegment,
    absPath: string,
    desc: boolean,
  ): AsyncGenerator<RawRecord> {
    const lines = desc ? iterateLinesReverse(absPath) : iterateLinesForward(absPath);
    for await (const line of lines) {
      if (line.length === 0) continue;
      const parsed = parseRecordLine(line);
      if (!parsed.ok) {
        this.log.warn(`[vault] skipping corrupt line in ${segment.segment}: ${parsed.reason}`);
        continue;
      }
      yield parsed.record;
    }
  }

  /** 全局按 seq 升/降序流式迭代（k 路归并，内存 O(段数)） */
  private async *iterateAllRecords(desc: boolean): AsyncGenerator<RawRecord> {
    const segments = this.state.segments;
    if (segments.length === 0) return;
    const sources: Array<AsyncIterable<RawRecord>> = segments.map((segment) => {
      const absPath = absoluteFromRelative(this.paths, segment.segment);
      return this.iterateSegmentRecords(segment, absPath, desc);
    });
    const compare = desc
      ? (a: RawRecord, b: RawRecord): number => b.seq - a.seq
      : (a: RawRecord, b: RawRecord): number => a.seq - b.seq;
    yield* mergeSortedAsync(sources, compare);
  }

  /** 全局按 seq 升序迭代「记录 + 原始行 + 所属段」（verify 用） */
  private async *iterateAllLocated(): AsyncGenerator<LocatedRecord> {
    const segments = this.state.segments;
    if (segments.length === 0) return;
    const sources: Array<AsyncIterable<LocatedRecord>> = segments.map((segment) => {
      const absPath = absoluteFromRelative(this.paths, segment.segment);
      return iterateSegmentLocated(absPath, segment);
    });
    const compare = (a: LocatedRecord, b: LocatedRecord): number =>
      (a.record?.seq ?? Number.MAX_SAFE_INTEGER) - (b.record?.seq ?? Number.MAX_SAFE_INTEGER);
    yield* mergeSortedAsync(sources, compare);
  }

  // -------------------------------------------------------------------------
  // 校验 / 统计
  // -------------------------------------------------------------------------

  /**
   * 全链校验（docs §6.7 verify）：逐条按 seq 顺序重算 hash、检查 prevHash 连接、
   * seq 连续性、id/day 一致性、行字节规范性，最后与 manifest 统计对账。
   * 只读：绝不修改任何文件。
   */
  async verify(): Promise<VerifyResult> {
    this.assertOpen();
    let checked = 0;
    let expectedPrev = GENESIS_HASH;
    let expectedSeq = 1;
    let lastRecord: RawRecord | null = null;
    /** 段 -> 会话目录名（v1 旧段为 null；避免逐行解析路径） */
    const segmentSessionKeys = new Map<string, string | null>();
    const segmentStats = new Map<
      string,
      { records: number; bytes: number; headHash: string; tailHash: string; firstSeq: number; lastSeq: number }
    >();

    for await (const located of this.iterateAllLocated()) {
      const { record, line, segment } = located;
      if (record === null) {
        return {
          ok: false,
          checked,
          error: { id: '', seq: expectedSeq, reason: `invalid JSON record line in ${segment.segment}` },
        };
      }
      checked += 1;
      if (record.seq !== expectedSeq) {
        return {
          ok: false,
          checked,
          error: {
            id: record.id,
            seq: record.seq,
            reason: `seq mismatch: expected ${expectedSeq}, found ${record.seq} (gap/duplicate or missing segment)`,
          },
        };
      }
      if (record.prevHash !== expectedPrev) {
        return {
          ok: false,
          checked,
          error: {
            id: record.id,
            seq: record.seq,
            reason: 'prevHash mismatch: hash chain broken',
          },
        };
      }
      const recomputed = hashRawRecord(record);
      if (recomputed !== record.hash) {
        return {
          ok: false,
          checked,
          error: { id: record.id, seq: record.seq, reason: 'hash mismatch: record content tampered' },
        };
      }
      const canonicalLine = serializeRecordLine(record);
      if (canonicalLine !== line) {
        return {
          ok: false,
          checked,
          error: {
            id: record.id,
            seq: record.seq,
            reason: 'record line is not byte-canonical (field order/format changed)',
          },
        };
      }
      const idParts = parseRawId(record.id);
      if (idParts === null || idParts.date !== record.day) {
        return {
          ok: false,
          checked,
          error: { id: record.id, seq: record.seq, reason: 'id does not match record day' },
        };
      }
      if (record.day !== segment.day) {
        return {
          ok: false,
          checked,
          error: {
            id: record.id,
            seq: record.seq,
            reason: `record day ${record.day} does not match segment directory ${segment.day}`,
          },
        };
      }
      // v2：记录必须落在它自己的会话目录（目录名 = sanitizeSessionKey(record.sessionId)）；
      // v1 旧段（无会话目录）跳过该检查，保持只读兼容。
      let segmentSessionKey = segmentSessionKeys.get(segment.segment);
      if (segmentSessionKey === undefined) {
        segmentSessionKey = parseSegmentRelativePath(segment.segment)?.sessionKey ?? null;
        segmentSessionKeys.set(segment.segment, segmentSessionKey);
      }
      if (segmentSessionKey !== null && segmentSessionKey !== sanitizeSessionKey(record.sessionId)) {
        return {
          ok: false,
          checked,
          error: {
            id: record.id,
            seq: record.seq,
            reason:
              `record sessionId is not isolated in its session directory ` +
              `(segment=${segment.segment}, expected sessionKey=${sanitizeSessionKey(record.sessionId)})`,
          },
        };
      }
      if (segment.sessionId != null && segment.sessionId !== record.sessionId) {
        return {
          ok: false,
          checked,
          error: {
            id: record.id,
            seq: record.seq,
            reason: `manifest sessionId ${segment.sessionId} does not match record sessionId ${record.sessionId}`,
          },
        };
      }
      // 段统计
      const stats = segmentStats.get(segment.segment);
      if (stats === undefined) {
        segmentStats.set(segment.segment, {
          records: 1,
          bytes: Buffer.byteLength(line, 'utf8') + 1,
          headHash: record.hash,
          tailHash: record.hash,
          firstSeq: record.seq,
          lastSeq: record.seq,
        });
      } else {
        stats.records += 1;
        stats.bytes += Buffer.byteLength(line, 'utf8') + 1;
        stats.tailHash = record.hash;
        stats.lastSeq = record.seq;
      }
      expectedPrev = record.hash;
      expectedSeq += 1;
      lastRecord = record;
    }
    // 段清单对账（manifest 是缓存，但必须与文件一致）
    for (const segment of this.state.segments) {
      const stats = segmentStats.get(segment.segment);
      if (stats === undefined) {
        return {
          ok: false,
          checked,
          error: { id: '', seq: expectedSeq, reason: `segment ${segment.segment} is missing or empty` },
        };
      }
      if (
        stats.records !== segment.records ||
        stats.bytes !== segment.bytes ||
        stats.headHash !== segment.headHash ||
        stats.tailHash !== segment.tailHash ||
        stats.firstSeq !== segment.firstSeq ||
        stats.lastSeq !== segment.lastSeq
      ) {
        return {
          ok: false,
          checked,
          error: {
            id: lastRecord?.id ?? '',
            seq: lastRecord?.seq ?? 0,
            reason: `manifest mismatch for segment ${segment.segment}`,
          },
        };
      }
    }
    const actualLastSeq = lastRecord?.seq ?? 0;
    const actualLastHash = lastRecord?.hash ?? GENESIS_HASH;
    if (this.state.lastSeq !== actualLastSeq || this.state.lastHash !== actualLastHash) {
      return {
        ok: false,
        checked,
        error: {
          id: lastRecord?.id ?? '',
          seq: actualLastSeq,
          reason: 'manifest chain tail does not match segment contents',
        },
      };
    }
    return { ok: true, checked };
  }

  async stats(): Promise<VaultStats> {
    this.assertOpen();
    const segments = this.state.segments;
    const stats: VaultStats = {
      records: this.state.stats.records,
      segments: segments.length,
      days: Object.keys(this.state.days).length,
      bytes: this.state.stats.bytes,
    };
    const withRecords = segments.filter((segment) => segment.records > 0);
    if (withRecords.length === 0) return stats;
    const firstSegment = withRecords.reduce((min, segment) =>
      segment.firstSeq < min.firstSeq ? segment : min,
    );
    const lastSegment = withRecords.reduce((max, segment) => (segment.lastSeq > max.lastSeq ? segment : max));
    const firstLine = await readFirstLine(absoluteFromRelative(this.paths, firstSegment.segment));
    if (firstLine !== null) {
      const parsed = parseRecordLine(firstLine);
      if (parsed.ok) {
        stats.firstId = parsed.record.id;
        stats.firstTs = parsed.record.ts;
      }
    }
    const tail = await readLastLineInfo(absoluteFromRelative(this.paths, lastSegment.segment));
    if (tail.lastCompleteLine !== null) {
      const parsed = parseRecordLine(tail.lastCompleteLine);
      if (parsed.ok) {
        stats.lastId = parsed.record.id;
        stats.lastTs = parsed.record.ts;
      }
    }
    return stats;
  }

  /**
   * 读取 manifest（契约 API，docs/20 §5.3 形状的深拷贝）。
   * manifest 在 open() 时已完成对账/重建，因此这里返回内存中的权威快照。
   */
  async manifest(): Promise<ContractVaultManifest> {
    this.assertOpen();
    return this.manifestSnapshot;
  }

  /** 当前链尾（供集成层/恢复对账；不暴露可变引用） */
  get chainHead(): { lastSeq: number; lastHash: string } {
    return { lastSeq: this.lastSeq, lastHash: this.lastHash };
  }

  /** manifest 快照（深拷贝；测试/诊断/UI 用） */
  get manifestSnapshot(): VaultManifest {
    return {
      ...this.state,
      segments: this.state.segments.map((segment) => ({ ...segment })),
      stats: { ...this.state.stats },
      days: Object.fromEntries(Object.entries(this.state.days).map(([day, value]) => [day, { ...value }])),
    };
  }

  /** 段清单快照（深拷贝） */
  get segmentList(): ManifestSegment[] {
    return this.state.segments.map((segment) => ({ ...segment }));
  }

  /** 重新从段文件重建 manifest 并原子写盘（docs §6.7 syncManifest；只读段文件） */
  async syncManifest(): Promise<VaultManifest> {    this.assertOpen();
    return this.enqueue(async () => {
      const inventory = await this.scanInventory();
      this.state = await this.rebuildManifest(inventory, this.state.vaultId);
      for (const segment of this.state.segments) segment.sealed = true;
      refreshManifestDerived(this.state, this.clock());
      this.lastSeq = this.state.lastSeq;
      this.lastHash = this.state.lastHash;
      this.daySeq.clear();
      for (const [day, value] of Object.entries(this.state.days)) this.daySeq.set(day, value.daySeq);
      this.recomputeNextSegNo();
      this.activeSegments.clear();
      await this.writeManifest();
      return this.manifestSnapshot;
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try {
      await this.writeChain;
    } catch {
      /* 写入错误已在 append 中抛出 */
    }
    if (this.writerInfoEnabled) {
      try {
        const raw = await readJsonFile<{ writerId?: unknown }>(this.paths.writerInfoPath, {});
        if (raw.writerId === `w${this.writerId}`) {
          await removeFileSafe(this.paths.writerInfoPath);
        }
      } catch {
        /* 诊断文件删除失败不影响关闭 */
      }
    }
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new Error('[dsh-life-memory] vault is closed');
    }
  }
}

// ---------------------------------------------------------------------------
// 辅助函数
// ---------------------------------------------------------------------------

/** 计算/继承 ingestKey：显式 ingestKey 优先；否则 auto:<ts>:<sha256(payloadJson)> */
function resolveIngestKey(input: RawRecordInput): string {
  if (typeof input.ingestKey === 'string' && input.ingestKey.length > 0) return input.ingestKey;
  const payloadJson = JSON.stringify(input.payload);
  return `auto:${input.ts}:${sha256Hex(payloadJson)}`;
}

/** 段分组键：同一 (day, sessionKey) 共享段号命名空间；sessionKey 不含 '/'，故可无歧义拼接 */
function segmentGroupKey(day: string, sessionKey: string | null): string {
  return `${day}/${sessionKey ?? ''}`;
}

/** 规范化 RawQuery（防御非法值；ids 优先） */
function normalizeRawQuery(query: RawQuery): RawQuery {
  if (typeof query !== 'object' || query === null) return {};
  const normalized: RawQuery = {};
  if (typeof query.from === 'number' && Number.isFinite(query.from)) normalized.from = query.from;
  if (typeof query.to === 'number' && Number.isFinite(query.to)) normalized.to = query.to;
  if (typeof query.day === 'string' && query.day.length > 0) normalized.day = query.day;
  if (typeof query.sessionId === 'string' && query.sessionId.length > 0) {
    normalized.sessionId = query.sessionId;
  }
  if (typeof query.workspace === 'string' && query.workspace.length > 0) {
    normalized.workspace = query.workspace;
  }
  if (Array.isArray(query.kinds) && query.kinds.length > 0) normalized.kinds = [...query.kinds];
  if (Array.isArray(query.ids) && query.ids.length > 0) normalized.ids = query.ids.filter((id) => typeof id === 'string');
  if (typeof query.offset === 'number' && Number.isFinite(query.offset) && query.offset > 0) {
    normalized.offset = Math.floor(query.offset);
  }
  if (typeof query.limit === 'number' && Number.isFinite(query.limit) && query.limit >= 0) {
    normalized.limit = Math.floor(query.limit);
  }
  if (query.desc === true) normalized.desc = true;
  return normalized;
}

/** 构建谓词（ids 优先逻辑在调用方单独处理） */
function buildRawPredicate(query: RawQuery): (record: RawRecord) => boolean {
  const kinds = query.kinds !== undefined && query.kinds.length > 0 ? new Set(query.kinds) : null;
  return (record: RawRecord): boolean => {
    if (query.from !== undefined && record.ts < query.from) return false;
    if (query.to !== undefined && record.ts > query.to) return false;
    if (query.day !== undefined && record.day !== query.day) return false;
    if (query.sessionId !== undefined && record.sessionId !== query.sessionId) return false;
    if (query.workspace !== undefined && (record.workspace ?? null) !== query.workspace) return false;
    if (kinds !== null && !kinds.has(record.kind)) return false;
    return true;
  };
}

/** 迭代段文件里的每条完整行（record=null 表示该行 JSON/结构非法；verify 用） */
async function* iterateSegmentLocated(
  absPath: string,
  segment: ManifestSegment,
): AsyncGenerator<LocatedRecord> {
  for await (const line of iterateLinesForward(absPath)) {
    if (line.length === 0) continue;
    const parsed: ParseRecordResult = parseRecordLine(line);
    yield { record: parsed.ok ? parsed.record : null, line, segment };
  }
}

// ---------------------------------------------------------------------------
// 打开工厂
// ---------------------------------------------------------------------------

/** 可接受的打开参数：契约选项 / MemoryVaultConfig / 直接目录字符串 */
export type OpenVaultInput =
  | string
  | RawVaultOptions
  | Pick<MemoryVaultConfig, 'dataDir' | 'timezone'>;

function isRawVaultOptions(value: object): value is RawVaultOptions {
  return typeof (value as RawVaultOptions).rootDir === 'string';
}

/**
 * 打开 vault（契约原生入口）：`openRawVault({rootDir, timezone, ...}, {logger})`。
 */
export async function openRawVault(
  options: RawVaultOptions,
  runtime: RawVaultRuntimeOptions = {},
): Promise<RawVaultImpl> {
  return RawVaultImpl.open(options, runtime);
}

/**
 * 便利工厂（测试/集成用）：
 *   - string => rootDir，时区取宿主默认；
 *   - RawVaultOptions => 直接使用；
 *   - MemoryVaultConfig（含 dataDir/timezone）=> rootDir = dataDir。
 */
export async function openVault(
  input: OpenVaultInput,
  runtime: RawVaultRuntimeOptions = {},
): Promise<RawVaultImpl> {
  if (typeof input === 'string') {
    return openRawVault(
      { rootDir: input, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC' },
      runtime,
    );
  }
  if (typeof input === 'object' && input !== null) {
    if (isRawVaultOptions(input)) return openRawVault(input, runtime);
    if (typeof (input as { dataDir?: unknown }).dataDir === 'string') {
      return openRawVault(
        {
          rootDir: (input as { dataDir: string }).dataDir,
          timezone: (input as { timezone?: string }).timezone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
        },
        runtime,
      );
    }
  }
  throw new TypeError(
    '[dsh-life-memory] openVault: expected rootDir string, RawVaultOptions, or MemoryVaultConfig-like object',
  );
}

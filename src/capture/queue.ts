// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hanxustu (dsh-life-memory)
/**
 * 捕获队列：把映射后的原始记录批量、幂等、可恢复地写入 L0 + raw_index。
 *
 * 语义（docs/20 §6.1）：
 *   ingest(batch) → 缓冲 → 触发 flush → vault.append（先文件 fsync）
 *   → store.indexRawRecords（只读镜像）→ onAppended（派生调度）。
 *
 * 关键保证：
 * - 同一 ingestKey 只落盘一次（vault 的 seenIngestKeys 回调 + store 判重双保险）。
 * - 写失败不丢数据：整批重新入队（有上限，超限丢弃并计数/告警），下次 flush 重试。
 * - 串行化：所有 flush 排在同一个 Promise 链上，不会并发写同一 vault。
 * - 关闭前 flush：close() 等待队列清空。
 */
import type {
  CaptureConfig,
  CaptureSink,
  CaptureStats,
  Logger,
  MemoryStore,
  RawAppendItem,
  RawRecord,
  RawRecordInput,
  RawVault,
} from '../core/contracts.ts';
import type { DeriveReason } from '../core/contracts.ts';

export interface CaptureQueueDeps {
  vault: RawVault;
  store: Pick<MemoryStore, 'indexRawRecords' | 'hasRawIngestKey'>;
  config: CaptureConfig;
  logger: Logger;
  /** 落盘+索引成功后的回调（派生调度入口）；抛错不影响已落盘数据 */
  onAppended?: (items: RawAppendItem[], reason: DeriveReason) => void | Promise<void>;
  /** 时钟注入（测试） */
  now?: () => number;
  /** 定时器注入（测试） */
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

/** 缓冲上限：超过则丢弃最旧输入（记录 dropped 计数；正常批量远小于此值） */
export const MAX_BUFFER_SIZE = 10_000;

export class CaptureQueue implements CaptureSink {
  readonly #deps: CaptureQueueDeps;
  #buffer: RawRecordInput[] = [];
  #reason: DeriveReason = 'capture';
  #timer: unknown = null;
  #chain: Promise<void> = Promise.resolve();
  #closed = false;
  #stats: CaptureStats = { captured: 0, failed: 0, queued: 0, lastCaptureAt: null, dropped: 0 };
  #now: () => number;
  #setTimer: (fn: () => void, ms: number) => unknown;
  #clearTimer: (handle: unknown) => void;

  constructor(deps: CaptureQueueDeps) {
    this.#deps = deps;
    this.#now = deps.now ?? (() => Date.now());
    this.#setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.#clearTimer = deps.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  }

  /** 入队并返回"本次落盘"的记录（批量合并；调用方通常不必 await，钩子内 fire-and-forget） */
  async ingest(batch: RawRecordInput[], options: { reason?: DeriveReason } = {}): Promise<RawRecord[]> {
    if (this.#closed) throw new Error('[dsh-life-memory] capture queue is closed');
    if (!Array.isArray(batch) || batch.length === 0) return [];
    this.#reason = options.reason ?? 'capture';
    for (const input of batch) {
      // 立即判重（已在 raw_index 中的键直接丢弃，避免无谓缓冲）
      const key = input.ingestKey;
      if (key && this.#deps.store.hasRawIngestKey(key)) continue;
      this.#buffer.push(input);
    }
    if (this.#buffer.length > MAX_BUFFER_SIZE) {
      const overflow = this.#buffer.length - MAX_BUFFER_SIZE;
      this.#buffer.splice(0, overflow);
      this.#stats.dropped += overflow;
      this.#deps.logger.warn(`capture buffer overflow: dropped ${overflow} oldest inputs`);
    }
    this.#stats.queued = this.#buffer.length;
    if (this.#buffer.length >= Math.max(1, this.#deps.config.maxBatchSize)) {
      await this.flush();
      return this.#lastFlushed;
    }
    this.#schedule();
    return [];
  }

  #lastFlushed: RawRecord[] = [];

  /** 立即 flush（等待当前写链完成） */
  async flush(): Promise<void> {
    if (this.#timer !== null) {
      this.#clearTimer(this.#timer);
      this.#timer = null;
    }
    this.#chain = this.#chain.then(() => this.#flushOnce()).catch((err) => {
      this.#deps.logger.error('capture flush failed', err);
    });
    await this.#chain;
  }

  #schedule(): void {
    if (this.#timer !== null) return;
    this.#timer = this.#setTimer(() => {
      this.#timer = null;
      void this.flush();
    }, Math.max(1, this.#deps.config.flushIntervalMs));
  }

  async #flushOnce(): Promise<void> {
    if (this.#buffer.length === 0) return;
    const batch = this.#buffer;
    this.#buffer = [];
    const reason = this.#reason;
    try {
      const result = await this.#deps.vault.append(batch);
      if (result.items.length > 0) {
        this.#deps.store.indexRawRecords(result.items);
        this.#stats.captured += result.items.length;
        this.#stats.lastCaptureAt = this.#now();
        this.#lastFlushed = result.items.map((item) => item.record);
      } else {
        this.#lastFlushed = [];
      }
      if (result.skipped > 0) this.#deps.logger.debug(`capture skipped ${result.skipped} duplicate ingest keys`);
      this.#stats.queued = this.#buffer.length;
      try {
        await this.#deps.onAppended?.(result.items, reason);
      } catch (err) {
        // 派生失败不影响原始数据（原始已落盘），记录错误即可
        this.#deps.logger.error('post-append derive hook failed', err);
      }
    } catch (err) {
      this.#stats.failed += batch.length;
      // 整批放回缓冲头部，下次重试（保持顺序）
      this.#buffer = [...batch, ...this.#buffer].slice(-MAX_BUFFER_SIZE);
      this.#stats.queued = this.#buffer.length;
      this.#deps.logger.error(`capture append failed, ${batch.length} inputs requeued`, err);
      throw err;
    }
  }

  stats(): CaptureStats {
    return { ...this.#stats, queued: this.#buffer.length };
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#timer !== null) {
      this.#clearTimer(this.#timer);
      this.#timer = null;
    }
    await this.flush();
  }
}

// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hanxustu (dsh-life-memory)
/**
 * 单个记忆库的完整运行时 bundle（v5，docs/26 §2/§7.2）。
 *
 * 一个 bundle = `<dataDir>/vaults/<id>/` 下的全部组件：
 *   - L0 vault（append-only JSONL + manifest + writer lock）
 *   - SQLite store（raw_index / memory_records / vectors / FTS，schema v4）
 *   - embedder（默认与其它库共享同一实例）
 *   - retention / forgetting / memoryRuntime / recaller / capture queue / prompt builder
 *   - 原始层永久向量管道（enqueue / backfill / close）
 *   - 启动对账（L0 → raw_index）
 *   - 健康报告（health）
 *
 * 设计口径（docs/26）：
 * - **库之间完全隔离**：每个 bundle 拥有独立 store/vault/queue/writer lock，
 *   A 库的原始字节不会出现在 B 库的段文件里；
 * - bundle 构造是**异步**的（`openVault` 需要恢复尾部/重建 manifest）；
 * - `dispose()` 等待队列 flush 后关闭 store；bundle 不持有任何全局定时器。
 */
import { mkdirSync } from 'node:fs';
import { basename } from 'node:path';
import type {
  Embedder,
  ForgettingEngine,
  Logger,
  MemoryStore,
  MemoryVaultConfig,
  PersonaDefinition,
  PersonaHealth,
  RawRecord,
  RawVectorStats,
  RawVault,
  Recaller,
  RetentionEngine,
  RetentionStats,
  VaultHealth,
} from '../core/contracts.ts';
import { openStore } from '../store/index.ts';
import { openVault } from '../vault/index.ts';
import { hashRawRecord } from '../vault/record.ts';
import { createEmbedder } from '../embed/index.ts';
import { createRetentionEngine } from '../retention/index.ts';
import { createForgettingEngine } from '../forgetting/index.ts';
import { createMemoryRuntime } from '../layers/index.ts';
import type { MemoryRuntime } from '../layers/index.ts';
import { createRecaller } from '../search/recall.ts';
import { CaptureQueue } from '../capture/queue.ts';
import { createHealthReporter } from '../health.ts';
import type { HealthReporter } from '../health.ts';
import { PromptSectionBuilder } from '../prompt/section.ts';
import { toPersonaSummary } from '../persona/index.ts';
import { SHARED_VAULT_ID } from '../vaults/index.ts';

/** 启动对账结果（L0 → raw_index） */
export interface ReconcileResult {
  checked: number;
  storeBefore: number;
  indexed: number;
  reconciled: boolean;
}

/** 原始层永久向量管道（只追加、不更新；失败由回填 worker 重试） */
export interface RawVectorPipeline {
  /** 捕获/显式保存落盘后：把新 raw 记录加入嵌入队列（fire-and-forget） */
  enqueue(records: readonly RawRecord[]): void;
  /** 回填缺失向量（批量；返回本轮嵌入条数） */
  backfill(): Promise<number>;
  /** 放弃未完成的嵌入（dispose 前调用） */
  close(): void;
  /** 当前待嵌入条数（诊断） */
  pending(): number;
  /** 原始层向量索引统计 */
  stats(): RawVectorStats;
}

/** 单库统计（GET /vaults、marker.vaults 用） */
export interface VaultBundleStats {
  rawRecords: number;
  memoryCount: number;
  activeMemoryCount: number;
  vectorCount: number;
  dbBytes: number;
  segments: number;
  days: number;
  lastUpdatedAt: number | null;
}

export interface VaultBundle {
  /** 库 id（`shared` 或 persona id） */
  id: string;
  /** 库目录绝对路径（`<dataDir>/vaults/<id>`） */
  dir: string;
  vault: RawVault;
  store: MemoryStore;
  embedder: Embedder;
  retention: RetentionEngine;
  forgetting: ForgettingEngine;
  memoryRuntime: MemoryRuntime;
  recaller: Recaller;
  queue: CaptureQueue;
  promptBuilder: PromptSectionBuilder;
  health: HealthReporter;
  rawVectors: RawVectorPipeline;
  /** 启动对账：把 L0 中尚未镜像进 raw_index 的记录补齐 */
  reconcile(): Promise<ReconcileResult>;
  /** 捕获/派生/定时器变更后各调用一次（防抖 1s 后跑 retention tick） */
  markRetentionDirty(): void;
  runRetentionTick(at?: number): Promise<RetentionStats | null>;
  runForgetting(at?: number): Promise<void>;
  runDerivation(options?: { reason?: 'timer' | 'session_end' | 'capture'; sessionId?: string }): Promise<void>;
  /** 库统计（含最近更新时间；UI /vaults 用） */
  stats(): Promise<VaultBundleStats>;
  /** 是否 shared 库 */
  isShared(): boolean;
  /** 库代表的人格 id（shared → null） */
  personaId(): string | null;
  /** flush 捕获队列（会话 flush/结束/关闭时） */
  flush(): Promise<void>;
  /** 是否已关闭 */
  isClosed(): boolean;
  /** 关闭：停掉脏标记定时器 → 队列 flush → 关闭 store */
  dispose(): Promise<void>;
}

export interface VaultBundleOptions {
  /** 库目录（绝对路径；通常是 `<dataDir>/vaults/<id>`） */
  dataDir: string;
  config: MemoryVaultConfig;
  logger: Logger;
  now?: () => number;
  /** 共享 embedder（缺省按 config.embedding 创建/复用缓存实例） */
  embedder?: Embedder;
  /** 当前会话 id（prompt 工作记忆块用；集成层同步追踪） */
  getSessionId?: () => string | null;
  /** 人格定义读取（persona 库的 prompt 身份块/健康统计用） */
  getPersonaById?: (id: string) => PersonaDefinition | null;
  /** 全部人格定义（roster 行/健康统计用） */
  getPersonaRoster?: () => PersonaDefinition[];
  /** 数据变更回调（集成层用于刷新 system prompt / 触发其它库无关的副作用） */
  onChanged?: (bundle: VaultBundle) => void;
}

/**
 * 启动对账：把 L0 段文件中尚未镜像进 SQLite `raw_index` 的记录补齐。
 *
 * 背景：`vault.append()` 与 `store.indexRawRecords()` 是两次调用，若进程在两者之间崩溃，
 * 会出现"文件已落盘、索引缺失"。L0 是事实来源，因此启动时应补齐。
 * 幂等键按捕获层规则重建（`sessionId:seq` / `sessionId:header` / `recon:note:<id>`），
 * 位置字段标记为 `recovered`（索引重建场景无法逐行还原原始位置；权威副本仍在段文件）。
 */
export async function reconcileRawIndex(options: {
  vault: RawVault;
  store: MemoryStore;
  logger: Logger;
}): Promise<ReconcileResult> {
  const { vault, store, logger } = options;
  const vaultRecords = (await vault.stats()).records;
  const storeBefore = store.storageStats().rawCount;
  if (vaultRecords <= storeBefore) {
    return { checked: vaultRecords, storeBefore, indexed: 0, reconciled: false };
  }
  let indexed = 0;
  let batch: Array<{ record: RawRecord; location: { ingestKey: string; segment: string; lineNo: number; byteOffset: number; byteLen: number } }> = [];
  const flush = (): void => {
    if (batch.length === 0) return;
    store.indexRawRecords(batch);
    indexed += batch.length;
    batch = [];
  };
  try {
    for await (const record of vault.iterate()) {
      const payload = record.payload as { kind?: unknown } | null;
      const ingestKey =
        record.kind === 'session' && payload && payload.kind === 'session/header'
          ? `${record.sessionId}:header`
          : record.kind === 'note'
            ? `recon:note:${record.id}`
            : `${record.sessionId}:${record.seq}`;
      batch.push({
        record,
        location: { ingestKey, segment: 'recovered', lineNo: 0, byteOffset: 0, byteLen: 0 },
      });
      if (batch.length >= 500) flush();
    }
    flush();
    logger.warn(`raw_index reconciled: vault=${vaultRecords} storeBefore=${storeBefore} indexed=${indexed}`);
    return { checked: vaultRecords, storeBefore, indexed, reconciled: true };
  } catch (error) {
    logger.error('raw_index reconciliation failed (L0 files remain authoritative)', error);
    return { checked: vaultRecords, storeBefore, indexed, reconciled: false };
  }
}

/** 从库目录推导库 id（`vaults/shared` → `shared`） */
export function vaultIdFromDir(dataDir: string): string {
  const name = basename(dataDir);
  return name.length > 0 ? name : SHARED_VAULT_ID;
}

/** 创建一个库的完整运行时（异步：打开 L0 需要恢复/重建 manifest） */
export async function createVaultBundle(options: VaultBundleOptions): Promise<VaultBundle> {
  const { dataDir, config, logger } = options;
  const now = options.now ?? (() => Date.now());
  const id = vaultIdFromDir(dataDir);
  const isShared = id === SHARED_VAULT_ID;
  const personaId = isShared ? null : id;
  mkdirSync(dataDir, { recursive: true });

  const store = openStore({ dataDir, timezone: config.timezone }, { logger, now });
  const vault = await openVault(
    { rootDir: dataDir, timezone: config.timezone, seenIngestKeys: (key: string) => store.hasRawIngestKey(key) },
    { logger, now },
  );
  const embedder = options.embedder ?? createEmbedder(config.embedding, { logger });
  const retention = createRetentionEngine({ store, config, logger, now });
  const memoryRuntime = createMemoryRuntime({
    store,
    embedder,
    config,
    logger,
    readRaw: async (query) => (await vault.list(query)).records,
  });
  const recaller = createRecaller({ store, embedder, config, logger, now });
  const forgetting = createForgettingEngine({ store, config, logger, now });

  // ── 原始层永久向量管道（v3 / docs/24 §3）───────────────────────────────
  const rawVectorRef = embedder.ref;
  let rawVectorClosed = false;
  let rawVectorDraining = false;
  const rawVectorPending = new Map<string, string>();
  const truncateRawForVector = (text: string | null | undefined): string => {
    const max = Math.max(0, config.vectors.rawTextMaxChars);
    const value = (text ?? '').slice(0, max);
    return value.trim().length > 0 ? value : '';
  };
  const embedRawTexts = async (texts: string[]): Promise<Float32Array[] | null> => {
    try {
      return await embedder.embed(texts);
    } catch (error) {
      logger.warn(`raw vector embed failed (vault=${id}), retrying once`, error);
      try {
        return await embedder.embed(texts);
      } catch (retryError) {
        logger.warn(`raw vector embed failed permanently (vault=${id}; raw retained; backfill will retry later)`, retryError);
        return null;
      }
    }
  };
  const putRawVectors = (entries: Array<[string, string]>, vectors: Float32Array[]): void => {
    for (let i = 0; i < entries.length; i += 1) {
      const vector = vectors[i];
      if (!vector) continue;
      try {
        store.putRawVector(entries[i]![0], rawVectorRef, vector);
      } catch (error) {
        logger.debug?.(`raw vector write failed for ${entries[i]![0]} (vault=${id})`, error);
      }
    }
  };
  const scheduleRawVectorDrain = (): void => {
    if (rawVectorClosed || rawVectorDraining) return;
    rawVectorDraining = true;
    void (async () => {
      try {
        while (!rawVectorClosed && rawVectorPending.size > 0) {
          const batchSize = Math.max(1, config.vectors.backfillBatchSize);
          const batch = [...rawVectorPending.entries()].slice(0, batchSize);
          for (const [rawId] of batch) rawVectorPending.delete(rawId);
          const vectors = await embedRawTexts(batch.map(([, text]) => text));
          if (vectors) putRawVectors(batch, vectors);
        }
      } finally {
        rawVectorDraining = false;
        if (!rawVectorClosed && rawVectorPending.size > 0) scheduleRawVectorDrain();
      }
    })();
  };
  const enqueueRawVectors = (records: readonly RawRecord[]): void => {
    if (!config.vectors.enabled || config.vectors.rawTextMaxChars <= 0) return;
    for (const record of records) {
      const text = truncateRawForVector(record.text);
      if (!text) continue;
      rawVectorPending.set(record.id, text);
    }
    if (rawVectorPending.size > 0) scheduleRawVectorDrain();
  };

  // 保留期脏标记（每库独立；防抖 1s）
  let retentionDirty = false;
  let retentionTimeout: ReturnType<typeof setTimeout> | null = null;
  let closed = false;
  const markRetentionDirty = (): void => {
    if (!config.retention.enabled || closed) return;
    retentionDirty = true;
    if (retentionTimeout) return;
    retentionTimeout = setTimeout(() => {
      retentionTimeout = null;
      if (!retentionDirty || closed) return;
      retentionDirty = false;
      void retention
        .tick({ now: now() })
        .then(() => options.onChanged?.(bundle))
        .catch((error) => logger.warn(`retention tick failed (vault=${id})`, error));
    }, 1000);
    retentionTimeout.unref?.();
  };

  // eslint-disable-next-line prefer-const -- 回调在构造完成前不会被调用
  let bundle: VaultBundle;

  const queue = new CaptureQueue({
    vault,
    store,
    config: config.capture,
    logger,
    onAppended: async (items, reason) => {
      const raws = items.map((item) => item.record);
      enqueueRawVectors(raws);
      try {
        await memoryRuntime.runDerivation({ raws, reason: reason === 'capture' ? 'capture' : reason, now: now() });
        health.noteDerived();
      } catch (error) {
        logger.warn(`derivation after capture failed (vault=${id})`, error);
      }
      options.onChanged?.(bundle);
      markRetentionDirty();
    },
  });

  const personaHealthOf = (): PersonaHealth => {
    const enabled = config.persona.enabled;
    let definitions: ReturnType<typeof toPersonaSummary>[] = [];
    try {
      definitions = (options.getPersonaRoster?.() ?? []).map((definition) => toPersonaSummary(definition));
    } catch {
      definitions = [];
    }
    let memoryCounts: Record<string, { total: number; L1: number; L2: number; L3: number }> = {};
    let sharedCount = 0;
    try {
      const counts = store.countMemoriesByPersona();
      memoryCounts = counts.counts ?? {};
      sharedCount = Number(counts.shared ?? 0);
    } catch {
      memoryCounts = {};
      sharedCount = 0;
    }
    const definition = personaId ? (options.getPersonaById?.(personaId) ?? null) : null;
    return {
      enabled,
      activeId: personaId,
      activeName: definition?.name ?? personaId,
      definitions,
      memoryCounts,
      sharedCount,
      lastError: null,
    };
  };

  const health = createHealthReporter({
    config,
    vault,
    store,
    captureStats: () => queue.stats(),
    embedder: () => embedder.ref,
    layers: () => memoryRuntime.layers,
    retention: () => retention.stats(),
    vectors: () => store.rawVectorStats(rawVectorRef),
    forgetting: () => forgetting.stats(),
    persona: () => personaHealthOf(),
    logger,
    now,
  });

  const promptBuilder = new PromptSectionBuilder({
    config,
    store,
    now,
    getSessionId: () => options.getSessionId?.() ?? null,
    // 库已隔离：persona 库只在会话启用 persona 时由集成层选用；身份块使用该库自己的人格定义
    getActivePersona: () => (personaId ? (options.getPersonaById?.(personaId) ?? null) : null),
    getPersonaRoster: () => (config.persona.enabled ? (options.getPersonaRoster?.() ?? []) : []),
  });

  const rawVectors: RawVectorPipeline = {
    enqueue: enqueueRawVectors,
    async backfill(): Promise<number> {
      if (!config.vectors.enabled || config.vectors.rawTextMaxChars <= 0) return 0;
      try {
        const rows = store.listRawWithoutVectors(rawVectorRef, config.vectors.backfillBatchSize);
        const entries: Array<[string, string]> = [];
        for (const row of rows) {
          const text = truncateRawForVector(row.text);
          if (text) entries.push([row.id, text]);
          if (entries.length >= config.vectors.backfillBatchSize) break;
        }
        if (entries.length > 0) {
          const vectors = await embedRawTexts(entries.map(([, text]) => text));
          if (vectors) putRawVectors(entries, vectors);
          logger.info(`raw vector backfill (vault=${id}): embedded ${entries.length} raw records`);
        }
        store.setRawVectorMeta('raw_vectors.lastBackfillAt', String(now()));
        return entries.length;
      } catch (error) {
        logger.warn(`raw vector backfill failed (vault=${id}; will retry on next interval)`, error);
        return 0;
      }
    },
    close(): void {
      rawVectorClosed = true;
      rawVectorPending.clear();
    },
    pending: () => rawVectorPending.size,
    stats: () => store.rawVectorStats(rawVectorRef),
  };

  bundle = {
    id,
    dir: dataDir,
    vault,
    store,
    embedder,
    retention,
    forgetting,
    memoryRuntime,
    recaller,
    queue,
    promptBuilder,
    health,
    rawVectors,
    reconcile: () => reconcileRawIndex({ vault, store, logger }),
    markRetentionDirty,
    async runRetentionTick(at?: number): Promise<RetentionStats | null> {
      if (!config.retention.enabled) return null;
      try {
        await retention.tick({ now: at ?? now() });
        options.onChanged?.(bundle);
        return await retention.stats();
      } catch (error) {
        logger.warn(`retention tick failed (vault=${id})`, error);
        return null;
      }
    },
    async runForgetting(at?: number): Promise<void> {
      if (!config.forgetting.enabled) return;
      try {
        const result = await forgetting.run({ now: at ?? now() });
        if (result.deletedShort > 0 || result.archivedMid > 0) {
          logger.info(
            `forgetting (vault=${id}): deletedShort=${result.deletedShort} archivedMid=${result.archivedMid} protected=${result.protectedCount}`,
          );
          options.onChanged?.(bundle);
        }
      } catch (error) {
        logger.warn(`forgetting run failed (vault=${id}; will retry on next interval)`, error);
      }
    },
    async runDerivation(deriveOptions = {}): Promise<void> {
      try {
        await memoryRuntime.runDerivation({
          raws: [],
          reason: deriveOptions.reason ?? 'timer',
          sessionId: deriveOptions.sessionId,
          now: now(),
        });
        health.noteDerived();
        options.onChanged?.(bundle);
        markRetentionDirty();
      } catch (error) {
        logger.warn(`scheduled derivation failed (vault=${id})`, error);
      }
    },
    async stats(): Promise<VaultBundleStats> {
      const storage = store.storageStats();
      let vaultStats: { records: number; segments: number; days: number } = { records: 0, segments: 0, days: 0 };
      try {
        vaultStats = await vault.stats();
      } catch {
        vaultStats = { records: storage.rawCount ?? 0, segments: storage.segmentCount ?? 0, days: 0 };
      }
      let lastUpdatedAt: number | null = null;
      try {
        lastUpdatedAt = store.listMemories({ limit: 1, desc: true })[0]?.updatedAt ?? null;
      } catch {
        lastUpdatedAt = null;
      }
      return {
        rawRecords: storage.rawCount ?? vaultStats.records ?? 0,
        memoryCount: storage.memoryCount ?? 0,
        activeMemoryCount: storage.activeMemoryCount ?? 0,
        vectorCount: storage.vectorCount ?? 0,
        dbBytes: storage.dbBytes ?? 0,
        segments: storage.segmentCount ?? vaultStats.segments ?? 0,
        days: vaultStats.days ?? 0,
        lastUpdatedAt,
      };
    },
    isShared: () => isShared,
    personaId: () => personaId,
    flush: () => queue.flush(),
    isClosed: () => closed,
    async dispose(): Promise<void> {
      if (closed) return;
      closed = true;
      if (retentionTimeout) {
        clearTimeout(retentionTimeout);
        retentionTimeout = null;
      }
      rawVectors.close();
      try {
        await queue.close();
      } catch (error) {
        logger.warn(`capture queue close failed (vault=${id})`, error);
      }
      try {
        store.close();
      } catch (error) {
        logger.warn(`store close failed (vault=${id})`, error);
      }
    },
  };

  return bundle;
}

/** bundle 的健康快照（含库 id，便于 marker/诊断区分；不改变 store 内容） */
export async function bundleHealthOf(bundle: VaultBundle): Promise<VaultHealth & { vaultId: string }> {
  const health = await bundle.health.health();
  return { ...health, vaultId: bundle.id };
}

/** 原始记录哈希重算（memory_get_raw 校验用；与单库模式一致） */
export function hashRawRecordOf(record: RawRecord): string {
  return hashRawRecord(record);
}

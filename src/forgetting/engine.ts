// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hanxustu (dsh-life-memory)
/**
 * 遗忘引擎（docs/24-memory-access-forgetting.md §2）。
 *
 * 只有**三层记忆（L1/L2/L3 派生层）**会被遗忘，L0 原始层 / raw_index / 原始层向量
 * **永不修改、永不删除**（本模块只调用 store 的派生层遗忘方法）。
 *
 * 策略：
 * ```
 * short 到期（超过 retention.shortTermDays 且仍未晋升 mid）→ 物理删除派生记录
 * mid   到期（超过 retention.longTermAfterDays 且仍未晋升 long）→ 归档（status=archived）
 * long  永久保留（不遗忘；L3 long 删除由 store 触发器兜底拒绝）
 * 保护：pinned（protectPinned）/ importance ≥ protectImportance 不遗忘
 * ```
 * - 只处理仍停留在 short/mid 的 active 记录（已被 retention 晋升的不动）；
 * - `dryRun` 只统计不写；写 `store.recordForgetting`（可审计计数 + lastForgetAt）；
 * - 任何错误不抛出（log + 继续），单轮失败不影响其它轮。
 */
import type {
  ForgettingEngine,
  ForgettingRunResult,
  ForgettingStats,
  LayerId,
  Logger,
  MemoryRecord,
  MemoryStore,
  MemoryVaultConfig,
  RetentionTier,
} from '../core/contracts.ts';

/** 一天毫秒数 */
export const DAY_MS = 86_400_000;
/** 遗忘只作用于三层记忆（L1/L2/L3） */
export const FORGETTING_LAYERS: readonly LayerId[] = ['L1', 'L2', 'L3'];
/** 单轮候选预取上限（防止全表载入；真正写库量受 forgetting.batchSize 限制） */
export const FORGETTING_SCAN_MAX = 5000;

export interface ForgettingEngineOptions {
  store: MemoryStore;
  config: MemoryVaultConfig;
  logger: Logger;
  /** 时钟注入（测试）；默认 Date.now */
  now?: () => number;
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

function safeList(store: MemoryStore, query: Record<string, unknown>, logger: Logger, label: string): MemoryRecord[] {
  try {
    const records = store.listMemories(query as never);
    return Array.isArray(records) ? records : [];
  } catch (err) {
    logger.warn(`forgetting: 读取候选失败（${label}）：${errorMessage(err)}`);
    return [];
  }
}

/** 记录最后的"活跃时间"：createdAt 与 updatedAt 取较晚者（两者都早于截止线才算到期） */
function lastActiveAt(record: MemoryRecord): number {
  const created = typeof record.createdAt === 'number' && Number.isFinite(record.createdAt) ? record.createdAt : 0;
  const updated = typeof record.updatedAt === 'number' && Number.isFinite(record.updatedAt) ? record.updatedAt : created;
  return Math.max(created, updated);
}

/** 是否受保护（不遗忘）：pinned 或 importance ≥ protectImportance */
export function isForgettingProtected(record: MemoryRecord, config: MemoryVaultConfig): boolean {
  const forgetting = config.forgetting;
  if (forgetting.protectPinned && record.pinned === true) return true;
  const importance = typeof record.importance === 'number' && Number.isFinite(record.importance) ? record.importance : 0;
  return importance >= forgetting.protectImportance;
}

/**
 * 创建遗忘引擎。
 * 对外承诺：`run` 不抛错；`dryRun` 不写库；`stats/lastForgetAt` 读取失败时降级。
 */
export function createForgettingEngine(options: ForgettingEngineOptions): ForgettingEngine {
  const { store, config, logger } = options;
  const clock = options.now ?? (() => Date.now());

  async function stats(): Promise<ForgettingStats> {
    const fallback: ForgettingStats = { shortDeleted: 0, midArchived: 0, lastForgetAt: null };
    try {
      const stored = store.forgettingStats();
      return {
        shortDeleted: stored.shortDeleted ?? 0,
        midArchived: stored.midArchived ?? 0,
        lastForgetAt: stored.lastForgetAt ?? null,
      };
    } catch (err) {
      logger.warn(`forgetting.stats: 读取统计失败：${errorMessage(err)}`);
      return fallback;
    }
  }

  function lastForgetAt(): number | null {
    try {
      const stored = store.forgettingStats();
      return stored.lastForgetAt ?? null;
    } catch {
      return null;
    }
  }

  async function run(runOptions: { now?: number; dryRun?: boolean; limit?: number } = {}): Promise<ForgettingRunResult> {
    const started = clock();
    const now = Number.isFinite(runOptions.now) ? (runOptions.now as number) : started;
    const dryRun = runOptions.dryRun === true;
    const result: ForgettingRunResult = {
      evaluated: 0,
      deletedShort: 0,
      archivedMid: 0,
      protectedCount: 0,
      durationMs: 0,
      now,
    };
    if (config.forgetting.enabled === false) {
      result.durationMs = Math.max(0, clock() - started);
      return result;
    }
    const limit =
      Number.isFinite(runOptions.limit) && (runOptions.limit as number) > 0
        ? Math.floor(runOptions.limit as number)
        : config.forgetting.batchSize;
    const shortCutoff = now - config.retention.shortTermDays * DAY_MS;
    const midCutoff = now - config.retention.longTermAfterDays * DAY_MS;
    const baseQuery = {
      status: ['active'],
      layers: [...FORGETTING_LAYERS],
      desc: false,
      limit: Math.min(FORGETTING_SCAN_MAX, Math.max(limit * 10, 500)),
    };

    // ① short 到期候选（仍停留在 short 且 lastActiveAt 早于截止线）
    const shortRecords = safeList(
      store,
      { ...baseQuery, retentionTiers: ['short'] as RetentionTier[] },
      logger,
      'short',
    ).filter((record) => (record.retentionTier ?? 'short') === 'short' && lastActiveAt(record) < shortCutoff);
    // ② mid 到期候选
    const midRecords = safeList(
      store,
      { ...baseQuery, retentionTiers: ['mid'] as RetentionTier[] },
      logger,
      'mid',
    ).filter((record) => record.retentionTier === 'mid' && lastActiveAt(record) < midCutoff);

    result.evaluated = shortRecords.length + midRecords.length;
    const shortProtected = shortRecords.filter((record) => isForgettingProtected(record, config));
    const midProtected = midRecords.filter((record) => isForgettingProtected(record, config));
    result.protectedCount = shortProtected.length + midProtected.length;

    const deletableShort = shortRecords.filter((record) => !isForgettingProtected(record, config)).slice(0, limit);
    const archivableMid = midRecords
      .filter((record) => !isForgettingProtected(record, config))
      .slice(0, Math.max(1, limit));

    if (dryRun) {
      result.deletedShort = deletableShort.length;
      result.archivedMid = archivableMid.length;
      result.durationMs = Math.max(0, clock() - started);
      logger.debug(
        `forgetting.run(dryRun): evaluated=${result.evaluated} deletedShort=${result.deletedShort} archivedMid=${result.archivedMid} protected=${result.protectedCount}`,
      );
      return result;
    }

    // ③ 真正执行（store 负责派生层删除/归档；绝不触碰 L0/原始向量）
    try {
      if (deletableShort.length > 0) {
        const deleted = store.forgetDerivedMemories({
          layers: [...FORGETTING_LAYERS],
          tiers: ['short'],
          olderThan: shortCutoff,
          mode: 'delete',
          limit,
          protectPinned: config.forgetting.protectPinned,
          protectImportance: config.forgetting.protectImportance,
          now,
        });
        result.deletedShort = deleted?.deleted ?? 0;
      }
    } catch (err) {
      logger.warn(`forgetting.run: 短期记忆物理删除失败（继续处理中期）：${errorMessage(err)}`);
    }
    try {
      if (archivableMid.length > 0) {
        const archived = store.forgetDerivedMemories({
          layers: [...FORGETTING_LAYERS],
          tiers: ['mid'],
          olderThan: midCutoff,
          mode: 'archive',
          limit,
          protectPinned: config.forgetting.protectPinned,
          protectImportance: config.forgetting.protectImportance,
          now,
        });
        result.archivedMid = archived?.archived ?? 0;
      }
    } catch (err) {
      logger.warn(`forgetting.run: 中期记忆归档失败：${errorMessage(err)}`);
    }

    // ④ 审计计数（meta 计数器 + lastForgetAt）
    try {
      store.recordForgetting({ deletedShort: result.deletedShort, archivedMid: result.archivedMid }, now);
    } catch (err) {
      logger.warn(`forgetting.run: 写入遗忘审计失败（不影响已执行的遗忘）：${errorMessage(err)}`);
    }
    result.durationMs = Math.max(0, clock() - started);
    logger.debug(
      `forgetting.run: evaluated=${result.evaluated} deletedShort=${result.deletedShort} archivedMid=${result.archivedMid} protected=${result.protectedCount} duration=${result.durationMs}ms`,
    );
    return result;
  }

  return { run, stats, lastForgetAt };
}

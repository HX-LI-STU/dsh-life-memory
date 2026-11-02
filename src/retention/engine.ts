// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hanxustu (dsh-life-memory)
/**
 * 记忆分层模型（retention）引擎 —— 短期 / 中期 / 长期（docs/23-memory-models.md §3）。
 *
 * 与三层记忆模型（L1/L2/L3 = 工作/情景/语义，docs/20）**正交**：
 * - `layer` 回答"这条记忆是什么类型"；
 * - `retentionTier` 回答"这条记忆已经保留/巩固到哪个期限层级"。
 *
 * 晋升阶梯（**单调不降、永不删除**，确定性）：
 * ```
 * 新记录                → short
 * short → mid：         age ≥ retention.shortTermDays（默认 1 天）
 * mid   → long：        age ≥ retention.longTermAfterDays（默认 30 天）且满足任一：
 *                         importance ≥ longTermMinImportance
 *                         sourceRawIds.length ≥ longTermMinRecurrence
 *                         retentionScore ≥ longTermMinScore
 *                         pinned（且 pinnedIsLongTerm）
 *                         kind ∈ autoLongTermKinds
 * pinned（pinnedIsLongTerm） → 直接 long
 * ```
 * 每次 evaluate 最多晋升一级（与验收 §8.2 的"tick(+2d) 再 tick(+40d)"一致）；
 * 已到 long 的记录保持 long，任何情况下**不降级**。
 *
 * 保留期分数（§3.3，可解释，写入 `retention_score`，仅用于展示/长期晋升辅助条件）：
 * ```
 * ageDays   = max(0, (now - createdAt) / 86_400_000)
 * recency   = 0.5 ^ (ageDays / RETENTION_HALF_LIFE_DAYS)   # 遗忘曲线，半衰期 14 天
 * importance= record.importance
 * recurrence= min(1, sourceRawIds.length / 5)
 * frequency = min(1, log1p(accessCount) / log1p(20))
 * score     = Σ weights[k]·term[k] / Σ weights[k]          # 归一化 + clamp
 * ```
 *
 * 边界：只读写治理列（`retention_* / pinned / promoted_at / long_term_at`），
 * 不修改记忆内容，绝不触碰 L0 原始记录。
 */
import type {
  Logger,
  MemoryKind,
  MemoryRecord,
  MemoryStore,
  MemoryVaultConfig,
  RetentionConfig,
  RetentionEngine,
  RetentionState,
  RetentionStats,
  RetentionTickResult,
  RetentionTier,
} from '../core/contracts.ts';

/** 保留期分数 recency 半衰期（天）；`RetentionConfig` 无 halfLifeDays 字段，取文档默认常量 */
export const RETENTION_HALF_LIFE_DAYS = 14;
/** `retention.lastTickAt` 在 meta 表的键（docs/23 §5） */
export const RETENTION_LAST_TICK_KEY = 'retention.lastTickAt';
/** tick 分页大小 */
export const RETENTION_TICK_PAGE_SIZE = 200;
/** 单次 tick 的硬上限（防御异常分页实现） */
export const RETENTION_TICK_MAX_RECORDS = 100_000;
/** 分数比较容差（浮点漂移不算"变化"） */
const SCORE_EPSILON = 1e-6;
/**
 * tick 刷新 `retention_score` 的最小变化阈值（四舍五入到 4 位）：
 * 未晋升记录也刷新分数，但差异小于该阈值视为无变化，保证同 now 二次 tick **零写入**。
 */
export const RETENTION_SCORE_REFRESH_EPSILON = 1e-4;

/** 保留期层序（数值越大保留越久；只允许升） */
const TIER_RANK: Record<RetentionTier, number> = { short: 0, mid: 1, long: 2 };

function clamp01(value: number): number {
  if (typeof value !== 'number' || Number.isNaN(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

function tierOf(record: MemoryRecord): RetentionTier {
  return record.retentionTier ?? 'short';
}

function isArchived(record: MemoryRecord): boolean {
  return (record.status ?? 'active') !== 'active';
}

/** 记录当前保留期状态（未初始化默认 short / score 0 / 未钉住） */
function currentState(record: MemoryRecord): RetentionState {
  return {
    tier: tierOf(record),
    score: clamp01(record.retentionScore ?? 0),
    pinned: record.pinned === true,
    promotedAt: record.promotedAt ?? null,
    longTermAt: record.longTermAt ?? null,
  };
}

/** 保留期分数分项（可解释；单测直接断言） */
export interface RetentionTerms {
  ageDays: number;
  recency: number;
  importance: number;
  recurrence: number;
  frequency: number;
}

/** 计算三项原始项 + 年龄（纯函数，确定性；不读时钟） */
export function retentionTerms(record: MemoryRecord, now: number): RetentionTerms {
  const createdAt = typeof record.createdAt === 'number' && Number.isFinite(record.createdAt) ? record.createdAt : now;
  const ageDays = Math.max(0, (now - createdAt) / 86_400_000);
  const recency = 0.5 ** (ageDays / RETENTION_HALF_LIFE_DAYS);
  const importance = clamp01(record.importance);
  const sourceCount = Array.isArray(record.sourceRawIds) ? record.sourceRawIds.length : 0;
  const recurrence = Math.min(1, sourceCount / 5);
  const accessCount = typeof record.accessCount === 'number' && record.accessCount > 0 ? record.accessCount : 0;
  const frequency = Math.min(1, Math.log1p(accessCount) / Math.log1p(20));
  return { ageDays, recency, importance, recurrence, frequency };
}

/**
 * 保留期分数（docs/23 §3.3）：权重来自 `retention.weights`，按权重和归一化后 clamp 0..1。
 */
export function retentionScore(record: MemoryRecord, config: MemoryVaultConfig, now: number): number {
  const terms = retentionTerms(record, now);
  const weights = config.retention.weights;
  const weightSum =
    weights.recency + weights.importance + weights.recurrence + weights.frequency;
  if (!(weightSum > 0)) return 0;
  const raw =
    (weights.recency * terms.recency +
      weights.importance * terms.importance +
      weights.recurrence * terms.recurrence +
      weights.frequency * terms.frequency) /
    weightSum;
  return clamp01(raw);
}

/** 记录是否被钉住（钉住且 pinnedIsLongTerm 时直达长期层） */
function isPinned(record: MemoryRecord): boolean {
  return record.pinned === true;
}

/** 新建记录判定：仍是 short 且从未晋升（用于 autoLongTermKinds"新建即长期并钉住"） */
function isFreshRecord(record: MemoryRecord): boolean {
  return tierOf(record) === 'short' && (record.promotedAt === null || record.promotedAt === undefined);
}

/**
 * 中→长期条件（任一满足）：importance / recurrence / score / pinned / autoLongTermKinds。
 * 注意 pinnedIsLongTerm=false 时 pinned 不再作为长期条件。
 */
export function meetsLongTermConditions(
  record: MemoryRecord,
  config: MemoryVaultConfig,
  score: number,
): boolean {
  const retention = config.retention;
  if (record.importance >= retention.longTermMinImportance) return true;
  const sourceCount = Array.isArray(record.sourceRawIds) ? record.sourceRawIds.length : 0;
  if (sourceCount >= retention.longTermMinRecurrence) return true;
  if (score >= retention.longTermMinScore) return true;
  if (retention.pinnedIsLongTerm && isPinned(record)) return true;
  if (autoLongTermKind(record.kind, retention)) return true;
  return false;
}

function autoLongTermKind(kind: MemoryKind | string, retention: RetentionConfig): boolean {
  return Array.isArray(retention.autoLongTermKinds) && retention.autoLongTermKinds.includes(kind as MemoryKind);
}

/**
 * short→mid 的晋升条件（docs/24 §2）：
 * 年龄达到 `shortTermDays` **且** 满足任一：
 * - importance ≥ `promoteMidMinImportance`（默认 0.45）
 * - accessCount ≥ `promoteMidMinAccess`（默认 1，即被召回/访问过）
 * - sourceRawIds.length ≥ 2（被多个来源重述）
 * - pinned 或 kind ∈ autoLongTermKinds
 *
 * 不满足条件的 short 记录不会晋升；到期后由 ForgettingEngine 物理删除（"有意义的遗忘"）。
 */
export function meetsMidPromotionConditions(record: MemoryRecord, config: MemoryVaultConfig): boolean {
  const retention = config.retention;
  const importance = clamp01(record.importance);
  if (importance >= retention.promoteMidMinImportance) return true;
  const accessCount = typeof record.accessCount === 'number' && record.accessCount > 0 ? record.accessCount : 0;
  if (accessCount >= retention.promoteMidMinAccess) return true;
  const sourceCount = Array.isArray(record.sourceRawIds) ? record.sourceRawIds.length : 0;
  if (sourceCount >= 2) return true;
  if (isPinned(record)) return true;
  if (autoLongTermKind(record.kind, retention)) return true;
  return false;
}

/**
 * 由晋升规则推导目标保留期状态（纯函数，不写库；**只升不降**）。
 *
 * - `retention.enabled=false`：全部按 short 处理（引擎退化；store 的单向写入保证不会真的降级）；
 * - pinned 且 `pinnedIsLongTerm=true` → long；
 * - 新建且 kind ∈ autoLongTermKinds → long 并自动钉住（docs/23 §7）；
 * - short + age ≥ shortTermDays 且满足 mid 晋升条件（importance/access/recurrence/pinned/kind）→ mid；
 * - mid + age ≥ longTermAfterDays 且满足长期条件 → long；已 long 保持。
 */
export function evaluateRetention(record: MemoryRecord, config: MemoryVaultConfig, now: number): RetentionState {
  const retention = config.retention;
  const previous = currentState(record);
  const score = retentionScore(record, config, now);
  const terms = retentionTerms(record, now);

  let pinned = previous.pinned;
  let target: RetentionTier = previous.tier;
  if (retention.enabled === false) {
    target = 'short';
  } else if (isPinned(record) && retention.pinnedIsLongTerm) {
    target = 'long';
  } else if (isFreshRecord(record) && autoLongTermKind(record.kind, retention)) {
    // "新建即长期并自动钉住"（如 profile 画像常驻长期）
    target = 'long';
    pinned = true;
  } else {
    switch (previous.tier) {
      case 'short': {
        // 年龄达到短期窗口 + 满足晋升条件才进入 mid；否则保持 short（到期遗忘）
        if (terms.ageDays >= retention.shortTermDays && meetsMidPromotionConditions(record, config)) {
          target = 'mid';
        }
        break;
      }
      case 'mid': {
        if (terms.ageDays >= retention.longTermAfterDays && meetsLongTermConditions(record, config, score)) {
          target = 'long';
        }
        break;
      }
      case 'long':
      default: {
        target = 'long';
        break;
      }
    }
  }

  // 只升不降：任何情况下不得低于当前层（enabled=false 的 short 目标在 store 侧也会被单向写入忽略）
  if (retention.enabled !== false && TIER_RANK[target] < TIER_RANK[previous.tier]) {
    target = previous.tier;
  }
  const promoted = TIER_RANK[target] > TIER_RANK[previous.tier];
  const promotedAt = promoted ? now : previous.promotedAt;
  const longTermAt =
    target === 'long'
      ? (previous.tier === 'long' ? previous.longTermAt : now)
      : previous.longTermAt;
  return { tier: target, score, pinned, promotedAt, longTermAt };
}

/** 两个保留期状态是否有需要写库的差异 */
export function retentionStatesEqual(a: RetentionState, b: RetentionState): boolean {
  return (
    a.tier === b.tier &&
    a.pinned === b.pinned &&
    Math.abs(a.score - b.score) <= SCORE_EPSILON &&
    (a.promotedAt ?? null) === (b.promotedAt ?? null) &&
    (a.longTermAt ?? null) === (b.longTermAt ?? null)
  );
}

export interface RetentionEngineOptions {
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

/**
 * 创建保留期引擎。
 * 所有写操作只走 `setRetention` / `setRetentionBatch` / `setRetentionMeta`（治理列），
 * 不触碰记忆内容与 L0；对外方法承诺不抛错（内部记日志/降级）。
 */
export function createRetentionEngine(options: RetentionEngineOptions): RetentionEngine {
  const { store, config, logger } = options;
  const clock = options.now ?? (() => Date.now());

  function lastTickAt(): number | null {
    try {
      const raw = store.getRetentionMeta(RETENTION_LAST_TICK_KEY);
      if (raw === null || raw === undefined) return null;
      const value = Number.parseInt(String(raw), 10);
      return Number.isFinite(value) && value >= 0 ? value : null;
    } catch {
      return null;
    }
  }

  function score(record: MemoryRecord, nowOption?: number): number {
    try {
      const at = Number.isFinite(nowOption) ? (nowOption as number) : clock();
      return retentionScore(record, config, at);
    } catch {
      return 0;
    }
  }

  function evaluate(record: MemoryRecord, nowOption?: number): RetentionState {
    const at = Number.isFinite(nowOption) ? (nowOption as number) : clock();
    return evaluateRetention(record, config, at);
  }

  async function tick(
    tickOptions: { now?: number; limit?: number; dryRun?: boolean } = {},
  ): Promise<RetentionTickResult> {
    const started = clock();
    const now = Number.isFinite(tickOptions.now) ? (tickOptions.now as number) : started;
    const result: RetentionTickResult = {
      evaluated: 0,
      promotedToMid: 0,
      promotedToLong: 0,
      durationMs: 0,
      now,
    };
    if (config.retention.enabled === false) {
      result.durationMs = Math.max(0, clock() - started);
      return result;
    }
    const max =
      Number.isFinite(tickOptions.limit) && (tickOptions.limit as number) > 0
        ? Math.min(RETENTION_TICK_MAX_RECORDS, Math.floor(tickOptions.limit as number))
        : RETENTION_TICK_MAX_RECORDS;
    const updates: Array<{ id: string } & RetentionState> = [];
    let offset = 0;
    try {
      while (result.evaluated < max) {
        const pageLimit = Math.min(RETENTION_TICK_PAGE_SIZE, max - result.evaluated);
        let page: MemoryRecord[];
        try {
          page = store.listRetentionCandidates({ limit: pageLimit, offset });
        } catch (err) {
          logger.warn(`retention.tick: listRetentionCandidates 失败（跳过本轮）：${errorMessage(err)}`);
          break;
        }
        if (!Array.isArray(page) || page.length === 0) break;
        for (const record of page) {
          if (result.evaluated >= max) break;
          result.evaluated += 1;
          try {
            if (isArchived(record)) continue;
            const previous = currentState(record);
            const next = evaluateRetention(record, config, now);
            const changedTier = next.tier !== previous.tier;
            // score 刷新：未晋升记录也写入最新分数（UI/status 不显示旧分数）；
            // 用 1e-4 容差（四舍五入到 4 位）+ 同 now 确定性，保证二次 tick 零写入。
            const scoreChanged = Math.abs(next.score - previous.score) >= RETENTION_SCORE_REFRESH_EPSILON;
            if (!changedTier && !scoreChanged) continue;
            if (changedTier && TIER_RANK[next.tier] > TIER_RANK[previous.tier]) {
              if (next.tier === 'long') result.promotedToLong += 1;
              else result.promotedToMid += 1;
            }
            // tier 不变时只刷新 score（promotedAt/longTermAt 保持原值，绝不降级）
            updates.push({
              id: record.id,
              ...next,
              tier: changedTier ? next.tier : previous.tier,
              promotedAt: next.promotedAt,
              longTermAt: changedTier ? next.longTermAt : previous.longTermAt,
            });
          } catch (err) {
            logger.warn(`retention.tick: 记录 ${record.id} 评估失败（跳过）：${errorMessage(err)}`);
          }
        }
        if (page.length < pageLimit) break;
        offset += page.length;
        if (offset >= RETENTION_TICK_MAX_RECORDS) break;
      }
      if (!tickOptions.dryRun) {
        if (updates.length > 0) store.setRetentionBatch(updates, now);
        store.setRetentionMeta(RETENTION_LAST_TICK_KEY, String(now), now);
      }
    } catch (err) {
      logger.error(`retention.tick: 未预期失败（已隔离）：${errorMessage(err)}`);
    }
    result.durationMs = Math.max(0, clock() - started);
    logger.debug(
      `retention.tick: evaluated=${result.evaluated} promotedToMid=${result.promotedToMid} promotedToLong=${result.promotedToLong} updates=${updates.length} dryRun=${tickOptions.dryRun === true} duration=${result.durationMs}ms`,
    );
    return result;
  }

  async function stats(): Promise<RetentionStats> {
    const fallback: RetentionStats = { short: 0, mid: 0, long: 0, pinned: 0, lastTickAt: lastTickAt() };
    try {
      const stored = store.retentionStats();
      return {
        short: stored.short ?? 0,
        mid: stored.mid ?? 0,
        long: stored.long ?? 0,
        pinned: stored.pinned ?? 0,
        lastTickAt: lastTickAt() ?? stored.lastTickAt ?? null,
      };
    } catch (err) {
      logger.warn(`retention.stats: 读取统计失败：${errorMessage(err)}`);
      return fallback;
    }
  }

  /** 按保留期层列出记忆（已晋升到该层的记录；按 score 降序，最多 limit 条） */
  function byTier(tier: RetentionTier, listOptions: { limit?: number; offset?: number } = {}): MemoryRecord[] {
    try {
      const limit = Number.isFinite(listOptions.limit) && (listOptions.limit as number) > 0 ? Math.floor(listOptions.limit as number) : 200;
      return store.listByRetention(tier, {
        limit: Math.min(limit, 1000),
        offset: Math.max(0, Number.isFinite(listOptions.offset) ? Math.floor(listOptions.offset as number) : 0),
      });
    } catch (err) {
      logger.warn(`retention.byTier: 读取 ${tier} 失败：${errorMessage(err)}`);
      return [];
    }
  }

  /**
   * 显式设置保留期层（pin/unpin、显式提升）；仍遵守**只升不降**：
   * 请求低于当前层时忽略降级（保留当前层），只更新 pinned/score 等治理字段。
   */
  function setTier(
    id: string,
    tier: RetentionTier,
    tierOptions: { pinned?: boolean; now?: number } = {},
  ): RetentionState | null {
    try {
      const record = store.getMemory(id);
      if (!record) return null;
      const now = Number.isFinite(tierOptions.now) ? (tierOptions.now as number) : clock();
      const previous = currentState(record);
      let pinned = tierOptions.pinned !== undefined ? tierOptions.pinned === true : previous.pinned;
      let target: RetentionTier = tier;
      if (tierOptions.pinned === true && config.retention.pinnedIsLongTerm) {
        target = 'long';
      } else if (isFreshRecord(record) && autoLongTermKind(record.kind, config.retention)) {
        target = 'long';
        pinned = true;
      }
      // 只升不降：忽略降级请求（保留当前层）
      if (TIER_RANK[target] < TIER_RANK[previous.tier]) target = previous.tier;
      const promoted = TIER_RANK[target] > TIER_RANK[previous.tier];
      const state: RetentionState = {
        tier: target,
        score: retentionScore({ ...record, pinned }, config, now),
        pinned,
        promotedAt: promoted ? now : previous.promotedAt,
        longTermAt: TIER_RANK[target] >= TIER_RANK.long ? previous.tier === 'long' ? previous.longTermAt ?? now : now : previous.longTermAt,
      };
      store.setRetention(id, state, now);
      return store.getRetention(id) ?? state;
    } catch (err) {
      logger.warn(`retention.setTier: 设置 ${id} 失败：${errorMessage(err)}`);
      return null;
    }
  }

  return { score, evaluate, tick, stats, byTier, setTier, lastTickAt };
}

/** 便于测试/扩展：层序 rank */
export function retentionTierRank(tier: RetentionTier): number {
  return TIER_RANK[tier];
}

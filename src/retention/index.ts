// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hanxustu (dsh-life-memory)
/**
 * 记忆分层模型（retention）引擎入口 —— 短期 / 中期 / 长期（docs/23-memory-models.md）。
 *
 * 集成层用法：
 * ```ts
 * const retention = createRetentionEngine({ store, config, logger });
 * // 1) 后台定时器 / 会话结束后重算保留期晋升（单调不降）
 * await retention.tick();
 * // 2) system prompt 双块：L3 语义画像块 + L1 工作记忆块（工作块由 PromptSectionBuilder 生成）
 * const builder = new PromptSectionBuilder({ config, store, getSessionId: () => currentSessionId });
 * ```
 * 召回侧不依赖本引擎：默认不限制 retentionTier，仅在综合分上乘 `recall.retentionPrior`，
 * 命中只 touch access_count（供下一轮 tick 计算 frequency）。
 */
export {
  RETENTION_HALF_LIFE_DAYS,
  RETENTION_LAST_TICK_KEY,
  RETENTION_SCORE_REFRESH_EPSILON,
  RETENTION_TICK_MAX_RECORDS,
  RETENTION_TICK_PAGE_SIZE,
  createRetentionEngine,
  evaluateRetention,
  meetsLongTermConditions,
  meetsMidPromotionConditions,
  retentionScore,
  retentionStatesEqual,
  retentionTerms,
  retentionTierRank,
} from './engine.ts';
export type { RetentionEngineOptions, RetentionTerms } from './engine.ts';

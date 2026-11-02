// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hanxustu (dsh-life-memory)
/**
 * 遗忘引擎入口（docs/24-memory-access-forgetting.md §2）。
 *
 * 集成层用法：
 * ```ts
 * const forgetting = createForgettingEngine({ store, config, logger });
 * // 定时器（forgetting.checkIntervalMs）/ 启动后 / 手动巡检：
 * const report = await forgetting.run();           // 物理删除到期的 short、归档到期的 mid
 * const dry = await forgetting.run({ dryRun: true }); // 只统计不写
 * ```
 * 约束：只作用于三层记忆（L1/L2/L3 派生层）；L0、raw_index、原始层向量永不遗忘；
 * 遗忘前后 L0 段文件 sha256 必须逐字节不变（QA 验收项，本模块不触碰 vault）。
 */
export {
  DAY_MS,
  FORGETTING_LAYERS,
  FORGETTING_SCAN_MAX,
  createForgettingEngine,
  isForgettingProtected,
} from './engine.ts';
export type { ForgettingEngineOptions } from './engine.ts';

// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hanxustu (dsh-life-memory)
/**
 * 派生层入口：注册内置 L1/L2/L3，装配 `MemoryRuntime`（registry + saveExplicit + 统计）。
 *
 * 对外契约（集成层按此接线）：
 * - `createMemoryRuntime(options)` → `{ runner, saveExplicit, layers, runDerivation, deriveStats }`
 * - `createLayerRunner(options)` → `LayerRunner`（只注册内置层，测试/脚本用）
 * - `consolidate(runtime, {reason,...})` → 定时器/会话结束触发的便捷入口
 * - `defaultLayers` / `createDefaultLayers()` → 内置层定义（L1/L2/L3）
 * - `LlmConsolidator` → 可选 LLM 整理钩子类型（默认不启用；`config.consolidation.enabled=false` 时永不调用）
 *
 * 本模块不直接依赖 store/embed 的具体实现（全部由 options 注入），
 * 因此可以脱离宿主/DB 单测；两套实现只要满足 contracts.ts 即可互换。
 */
import type {
  DeriveContext,
  DeriveInput,
  DeriveReason,
  Embedder,
  LayerDefinition,
  LayerId,
  LayerRunner,
  LayerRunResult,
  Logger,
  MemoryQuery,
  MemoryRecord,
  MemoryStore,
  MemoryVaultConfig,
  NewMemoryRecord,
  RawQuery,
  RawRecord,
} from '../core/contracts.ts';
import type { SaveExplicitFn, SaveExplicitResult } from '../tools/handlers.ts';
import { createL1Layer } from './l1-episode.ts';
import { createL2Layer } from './l2-summary.ts';
import { createL3Layer, saveExplicitL3 } from './l3-semantic.ts';
import type { LayerRunnerDeps, InternalLayerDefinition } from './registry.ts';
import { createLayerRegistry } from './registry.ts';
import { L1_LAYER_ID, L2_LAYER_ID, L3_LAYER_ID, errorMessage } from './util.ts';

// ---------------------------------------------------------------------------
// 内置层
// ---------------------------------------------------------------------------

/** 内置三层定义（无状态，可安全复用/重复注册到不同 registry） */
export function createDefaultLayers(): InternalLayerDefinition[] {
  return [createL1Layer(), createL2Layer(), createL3Layer()];
}

/** 内置层定义（只读常量；扩展层用 `runner.register()` 追加） */
export const defaultLayers: readonly InternalLayerDefinition[] = Object.freeze(createDefaultLayers());

/** 内置层 id（拓扑顺序：L1 → L2 → L3） */
export const BUILTIN_LAYER_IDS: readonly LayerId[] = [L1_LAYER_ID, L2_LAYER_ID, L3_LAYER_ID];

// ---------------------------------------------------------------------------
// 可选 LLM 整理钩子（docs/20 §9.6，默认关闭；v1 只保留接口）
// ---------------------------------------------------------------------------

/** LLM 整理输入（确定性管线已产出的候选，交给宿主接线的 LLM 整理器） */
export interface LlmConsolidationInput {
  records: MemoryRecord[];
  reason: DeriveReason;
  now: number;
  config: MemoryVaultConfig;
}

/**
 * 可选 LLM 整理器（宿主接线；`config.consolidation.enabled=false` 时**永不调用**）。
 * 返回的新记忆仍需带 `sourceRawIds` 溯源；写入由调用方经 store 完成。
 */
export interface LlmConsolidator {
  readonly name: string;
  consolidate(input: LlmConsolidationInput): Promise<NewMemoryRecord[]>;
}

/** 按配置决定是否调用 LLM 整理器；关闭时直接返回空数组（确定性管线不受影响） */
export async function maybeRunLlmConsolidation(
  consolidator: LlmConsolidator | undefined,
  input: LlmConsolidationInput,
): Promise<NewMemoryRecord[]> {
  if (!consolidator) return [];
  if (input.config.consolidation.enabled !== true) return [];
  if (input.config.safety.allowNetwork !== true) return [];
  try {
    return await consolidator.consolidate(input);
  } catch {
    return []; // LLM 失败绝不影响确定性管线（docs §9.6）
  }
}

// ---------------------------------------------------------------------------
// 运行时装配
// ---------------------------------------------------------------------------

export interface MemoryRuntimeOptions {
  store: MemoryStore;
  embedder: Embedder;
  config: MemoryVaultConfig;
  logger: Logger;
  /** 读 L0（重建/窗口补齐用）；集成层传 vault 的实现 */
  readRaw?: (query?: RawQuery) => Promise<RawRecord[]>;
}

export interface MemoryRuntime {
  runner: LayerRunner;
  /** memory_save 用：显式保存一条 L3（签名与 src/tools/handlers.ts 的 SaveExplicitFn 完全一致） */
  saveExplicit: SaveExplicitFn;
  /** 已注册层定义（供 health/status 展示） */
  layers: LayerDefinition[];
  /** 便捷：立即跑一次派生（集成层在 append 后/会话结束/定时器里调用） */
  runDerivation(input: DeriveInput): Promise<LayerRunResult[]>;
  /** 派生水位/最近派生时间（memory_status 用） */
  deriveStats(): { cursors: Record<string, number>; pendingJobs: number; lastDeriveAt: number | null };
}

function buildContext(deps: LayerRunnerDeps, now: number): DeriveContext {
  const { store, embedder, config, logger } = deps;
  const readRaw: (query?: RawQuery) => Promise<RawRecord[]> =
    deps.readRaw ??
    (async () => {
      throw new Error('[dsh-life-memory] layers: 未配置 readRaw，无法读取 L0');
    });
  return {
    store,
    embedder,
    config,
    logger,
    readRaw,
    listLayerMemories: (layer: LayerId, query: MemoryQuery = {}) => store.listMemories({ ...query, layers: [layer] }),
    now: () => now,
  };
}

/**
 * 创建记忆运行时：注册 L1/L2/L3 并返回派生 + 显式保存 + 统计入口。
 * `runDerivation` 保证不抛错（逐层错误收集进 LayerRunResult.errors）。
 */
export function createMemoryRuntime(options: MemoryRuntimeOptions): MemoryRuntime {
  const { store, config, logger } = options;
  const clock = () => Date.now();
  const registry = createLayerRegistry({
    store,
    embedder: options.embedder,
    config,
    logger,
    ...(options.readRaw !== undefined ? { readRaw: options.readRaw } : {}),
  });
  for (const layer of defaultLayers) registry.register(layer);

  let lastDeriveAt: number | null = null;

  const saveExplicit: SaveExplicitFn = async (input): Promise<SaveExplicitResult> => {
    const ctx = buildContext({ ...options }, clock());
    return saveExplicitL3(input, ctx);
  };

  return {
    runner: registry,
    saveExplicit,
    layers: registry.list(),
    async runDerivation(input: DeriveInput): Promise<LayerRunResult[]> {
      const now =
        typeof input.now === 'number' && Number.isFinite(input.now) ? input.now : clock();
      try {
        const results = await registry.run({ ...input, now });
        lastDeriveAt = now;
        return results;
      } catch (err) {
        // 理论上 registry.run 不抛错；此处兜底，保证捕获路径永不被派生异常打断
        const message = errorMessage(err);
        logger.error(`layers: runDerivation 未预期异常（已隔离）：${message}`);
        return registry.list().map((layer) => ({
          layer: layer.id,
          written: 0,
          updated: 0,
          skipped: 0,
          errors: [message],
          durationMs: 0,
        }));
      }
    },
    deriveStats() {
      const cursors: Record<string, number> = {};
      for (const id of [...BUILTIN_LAYER_IDS, ...registry.list().map((layer) => layer.id)]) {
        try {
          cursors[id] = store.getDeriveCursor(id);
        } catch {
          cursors[id] = 0;
        }
      }
      return { cursors, pendingJobs: 0, lastDeriveAt };
    },
  };
}

/** 便捷：只创建已注册内置层的 LayerRunner（不含 saveExplicit/统计；测试/脚本用） */
export function createLayerRunner(options: MemoryRuntimeOptions): LayerRunner {
  const registry = createLayerRegistry({
    store: options.store,
    embedder: options.embedder,
    config: options.config,
    logger: options.logger,
    ...(options.readRaw !== undefined ? { readRaw: options.readRaw } : {}),
  });
  for (const layer of defaultLayers) registry.register(layer);
  return registry;
}

// ---------------------------------------------------------------------------
// 定时器 / 会话结束触发便捷入口
// ---------------------------------------------------------------------------

export interface ConsolidateOptions {
  /** 触发原因：session_end（会话结束）/ timer（定时器）/ manual（显式） */
  reason?: DeriveReason;
  /** 会话结束时的 sessionId */
  sessionId?: string;
  /** 本次新增的 raw（集成层一般传 capture 队列刚落盘的 records；定时器可省略） */
  raws?: RawRecord[];
  /** 当前时间（默认 Date.now） */
  now?: number;
  /** 只跑指定层（默认按 config.layers.enabled） */
  layers?: LayerId[];
}

/**
 * 增量派生便捷入口（定时器 / 会话结束）：
 * - 不传 raws 时由 runner 按各层 derive_cursors 从 L0 补齐（定时器场景）；
 * - 永不抛错（错误收集在 LayerRunResult.errors）。
 */
export async function consolidate(
  runtime: Pick<MemoryRuntime, 'runDerivation' | 'runner'>,
  options: ConsolidateOptions = {},
): Promise<LayerRunResult[]> {
  const reason: DeriveReason = options.reason ?? 'timer';
  const input: DeriveInput = {
    raws: options.raws ?? [],
    reason,
    ...(options.sessionId !== undefined ? { sessionId: options.sessionId } : {}),
    now: options.now ?? Date.now(),
  };
  try {
    return await runtime.runner.run(input, options.layers);
  } catch (err) {
    return [
      {
        layer: 'runtime',
        written: 0,
        updated: 0,
        skipped: 0,
        errors: [errorMessage(err)],
        durationMs: 0,
      },
    ];
  }
}

/** 便捷：会话结束触发的 L2/L3 整理（集成层生命周期事件调用） */
export async function consolidateSessionEnd(
  runtime: Pick<MemoryRuntime, 'runDerivation' | 'runner'>,
  sessionId: string,
  now?: number,
): Promise<LayerRunResult[]> {
  return consolidate(runtime, { reason: 'session_end', sessionId, ...(now !== undefined ? { now } : {}) });
}

/** 便捷：定时器触发（每 layers.consolidationIntervalMs） */
export async function consolidateTimer(
  runtime: Pick<MemoryRuntime, 'runDerivation' | 'runner'>,
  now?: number,
): Promise<LayerRunResult[]> {
  return consolidate(runtime, { reason: 'timer', ...(now !== undefined ? { now } : {}) });
}

export { createLayerRegistry } from './registry.ts';
export type {
  LayerRegistry,
  LayerRebuildResult,
  LayerInternalHooks,
  LayerWriteItem,
  LayerSidecarCounts,
  InternalLayerDefinition,
  LayerRunnerDeps,
} from './registry.ts';
export { createL1Layer, planL1Atom, buildL1Record, L1_EXTRACTOR, isL1Atom } from './l1-episode.ts';
export {
  createL2Layer,
  buildL2Windows,
  summarizeL2Window,
  buildL2EpisodeRecord,
  computeL2Importance,
  L2_IDLE_MS,
  L2_WINDOW_MAX_ATOMS,
  L2_EXTRACTOR,
} from './l2-summary.ts';
export {
  createL3Layer,
  saveExplicitL3,
  extractL3Candidates,
  extractWorkspaceFacts,
  normalizeObject,
  buildSpo,
  parseCanonicalKey,
  dimensionKeyOf,
  deriveL3MemoryId,
  buildL3MemoryRecord,
  buildL3ExpireRecord,
  readRebuildGeneration,
  L3_EXTRACTOR_VERSION,
  L3_MAX_CANDIDATES_PER_RAW,
} from './l3-semantic.ts';
export type { L3Candidate, SpoTriple, L3Category } from './l3-semantic.ts';

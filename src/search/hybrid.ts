// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hanxustu (dsh-life-memory)
/**
 * 混合评分原语（docs/20 §10.3，实现必须与公式一致）：
 *
 *   lexical  : b = max(0, -bm25)；lex = b / (1 + b)          ∈ [0,1)
 *   vector   : vector = max(0, cos)                          ∈ [0,1]
 *   recency  : recency = 0.5 ^ (ageDays / halfLifeDays)      ∈ (0,1]
 *   importance: m.importance                                 ∈ [0,1]
 *   score = (w_v*vector + w_l*lexical + w_r*recency + w_i*importance) / Σw
 *   score *= layerPrior(layer)      # L3=1.0, L2=0.98, L1=0.90, raw=1.0（可配）
 *
 * 本模块只提供"融合"这一步；候选获取、archived 过滤、MMR/去重由 Recaller 负责。
 * `combineScore` 返回归一化后的各因子（便于 RecallHit.components 可解释性）。
 */

/** 混合权重（与 contracts.ts RecallConfig.hybrid 结构兼容，halfLifeDays 可选） */
export interface HybridWeights {
  vectorWeight: number;
  lexicalWeight: number;
  recencyWeight: number;
  importanceWeight: number;
  /** 半衰期（天；仅 recencyScore 使用；combineScore 不直接使用） */
  halfLifeDays?: number;
}

/** 归一化后的评分因子（均 ∈ [0,1]） */
export interface HybridComponents {
  vector: number;
  lexical: number;
  recency: number;
  importance: number;
}

/** 融合结果（含可解释性因子） */
export interface HybridScoreResult {
  score: number;
  components: HybridComponents;
}

/** 默认权重（与 config DEFAULT_RECALL.hybrid 一致，仅作兜底） */
export const DEFAULT_HYBRID_WEIGHTS: Readonly<HybridWeights> = {
  vectorWeight: 0.55,
  lexicalWeight: 0.25,
  recencyWeight: 0.12,
  importanceWeight: 0.08,
  halfLifeDays: 30,
};

/** 分层层先验（docs §10.3；未列出的层默认 1） */
export const DEFAULT_LAYER_PRIOR: Readonly<Record<string, number>> = {
  L3: 1.0,
  L2: 0.98,
  L1: 0.9,
  raw: 1.0,
};

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

/**
 * FTS5 bm25 原始分 -> [0,1) 词法分。
 * SQLite `bm25()` 越大越差（通常为负数：-0.5 比 -2 差）；docs §10.3 定义：
 *   b = max(0, -bm25)；lex = b/(1+b) ∈ [0,1)
 * 宽容处理：调用方若传已归一化分（>=0）则直接 clamp01。
 */
export function normalizeLexicalScore(raw: number): number {
  if (!Number.isFinite(raw)) return 0;
  if (raw < 0) {
    const b = -raw;
    return b / (1 + b);
  }
  return clamp01(raw);
}

/** 单个 bm25 分值 -> 归一化词法分（保留独立函数便于单测/文档引用） */
export function lexicalScoreFromBm25(bm25: number): number {
  if (!Number.isFinite(bm25)) return 0;
  const b = Math.max(0, -bm25);
  return b / (1 + b);
}

/**
 * 时间衰减分（docs §10.3）：recency = 0.5 ^ (ageDays / halfLifeDays)，∈ (0,1]。
 * - 未来时间（ts > now）按 ageDays=0 处理，recency=1；
 * - halfLifeDays <= 0 抛 RangeError（配置层已保证 > 0）。
 */
export function recencyScore(ts: number, now: number, halfLifeDays: number): number {
  if (!Number.isFinite(ts) || !Number.isFinite(now)) return 0;
  if (!Number.isFinite(halfLifeDays) || halfLifeDays <= 0) {
    throw new RangeError(`[dsh-life-memory] recencyScore: halfLifeDays must be > 0, got ${halfLifeDays}`);
  }
  const ageDays = Math.max(0, now - ts) / 86_400_000;
  return Math.pow(0.5, ageDays / halfLifeDays);
}

/** 分层层先验（未配置返回 1；raw=1） */
export function layerPriorFor(layer: string | undefined, priors?: Record<string, number>): number {
  if (layer === undefined || layer.length === 0) return 1;
  const table = priors ?? DEFAULT_LAYER_PRIOR;
  const prior = table[layer];
  return typeof prior === 'number' && Number.isFinite(prior) && prior >= 0 ? prior : 1;
}

/**
 * 融合各因子（docs §10.3）：权重归一化后加权平均。
 * - vector/importance 直接 clamp01（vector 已是 max(0,cos)）；
 * - lexical 走 normalizeLexicalScore（兼容 raw bm25 与已归一化分）；
 * - recency 由调用方用 recencyScore() 预计算（∈[0,1]），此处 clamp01；
 * - 权重和 <= 0 抛 RangeError（配置层已校验，防御编程）。
 * - layerPrior 可选：传入后 final = score * layerPrior(layer)。
 */
export function combineScore(
  components: Partial<HybridComponents>,
  weights: HybridWeights = DEFAULT_HYBRID_WEIGHTS,
  options: { layer?: string; layerPrior?: Record<string, number> } = {},
): HybridScoreResult {
  const normalized: HybridComponents = {
    vector: clamp01(components.vector ?? 0),
    lexical: normalizeLexicalScore(components.lexical ?? 0),
    recency: clamp01(components.recency ?? 0),
    importance: clamp01(components.importance ?? 0),
  };
  const weightSum =
    weights.vectorWeight + weights.lexicalWeight + weights.recencyWeight + weights.importanceWeight;
  if (!(weightSum > 0)) {
    throw new RangeError('[dsh-life-memory] combineScore: hybrid weights sum must be > 0');
  }
  let score =
    (weights.vectorWeight * normalized.vector +
      weights.lexicalWeight * normalized.lexical +
      weights.recencyWeight * normalized.recency +
      weights.importanceWeight * normalized.importance) /
    weightSum;
  if (options.layer !== undefined) {
    score *= layerPriorFor(options.layer, options.layerPrior);
  }
  return { score, components: normalized };
}

/** 便捷：由 RecallConfig.hybrid 提取权重（结构兼容，无需拷贝时可直传） */
export function hybridWeightsFromConfig(hybrid: HybridWeights): HybridWeights {
  return {
    vectorWeight: hybrid.vectorWeight,
    lexicalWeight: hybrid.lexicalWeight,
    recencyWeight: hybrid.recencyWeight,
    importanceWeight: hybrid.importanceWeight,
    halfLifeDays: hybrid.halfLifeDays,
  };
}

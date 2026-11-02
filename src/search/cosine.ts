// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hanxustu (dsh-life-memory)
/**
 * 余弦相似度与向量检索原语（docs/20 §10.3/§10.4）。
 *
 * 约定：
 *   - 存储中的向量均已 L2 归一化，此时余弦相似度 = 点积；
 *   - 本模块的 `cosineSimilarity` 对未归一化输入也会现场除以范数（防御性），
 *     零向量返回 0 而不是 NaN；
 *   - `VecHit.score` 保持原始 cosine ∈ [-1, 1]（contracts.ts 约定），
 *     不入 0..1；混合评分时由 hybrid.ts 取 max(0, cos)。
 *
 * `VectorIndex` 接口是 docs §10.4 预留的 ANN 扩展点：v1 默认使用
 * `BruteForceIndex`（内存连续数组 + 线性点积），未来可替换 HNSW/随机投影实现，
 * 调用方（store/recall）不改。
 */

/** 点积（两向量长度必须一致） */
export function dotProduct(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) {
    throw new RangeError(`[dsh-life-memory] cosine: length mismatch ${a.length} vs ${b.length}`);
  }
  let sum = 0;
  for (let i = 0; i < a.length; i += 1) sum += a[i] * b[i];
  return sum;
}

/** L2 范数 */
export function l2Norm(vec: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < vec.length; i += 1) sum += vec[i] * vec[i];
  return Math.sqrt(sum);
}

/** 返回 L2 归一化副本（零向量返回全零向量，不做除零） */
export function normalize(vec: Float32Array): Float32Array {
  const norm = l2Norm(vec);
  if (!(norm > 0)) return new Float32Array(vec.length);
  const out = new Float32Array(vec.length);
  for (let i = 0; i < vec.length; i += 1) out[i] = vec[i] / norm;
  return out;
}

/** 是否已归一化（模长与 1 的差 <= eps） */
export function isNormalized(vec: Float32Array, eps = 1e-3): boolean {
  const norm = l2Norm(vec);
  return Math.abs(norm - 1) <= eps;
}

/**
 * 余弦相似度 ∈ [-1, 1]；长度不一致抛错。
 * 已归一化时等价于点积；未归一化时现场除范数（零范数返回 0）。
 */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) {
    throw new RangeError(`[dsh-life-memory] cosine: length mismatch ${a.length} vs ${b.length}`);
  }
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const scale = Math.sqrt(normA) * Math.sqrt(normB);
  if (!(scale > 0)) return 0;
  const cosine = dot / scale;
  // 数值误差兜底（|cos| 理论 <= 1）
  return cosine > 1 ? 1 : cosine < -1 ? -1 : cosine;
}

/** 已知双方均已归一化时的快速点积（不做范数检查） */
export function cosineSimilarityNormalized(a: Float32Array, b: Float32Array): number {
  return dotProduct(a, b);
}

/** topK 结果项 */
export interface ScoredItem<T> {
  item: T;
  score: number;
}

/**
 * 取分数最高的 k 项（降序；同分保持输入顺序的稳定排序由调用方保证即可）。
 * @param items 候选
 * @param k 数量上限（<=0 返回空）
 * @param score 打分函数
 * @param options.minScore 最低分（含），可选
 */
export function topK<T>(
  items: readonly T[],
  k: number,
  score: (item: T) => number,
  options: { minScore?: number } = {},
): ScoredItem<T>[] {
  const limit = Math.max(0, Math.floor(k));
  if (limit === 0) return [];
  const minScore = options.minScore ?? Number.NEGATIVE_INFINITY;
  const scored: ScoredItem<T>[] = [];
  for (const item of items) {
    const value = score(item);
    if (!Number.isFinite(value) || value < minScore) continue;
    scored.push({ item, score: value });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit);
}

// ---------------------------------------------------------------------------
// VectorIndex（docs §10.4：默认暴力实现，接口为 ANN 预留）
// ---------------------------------------------------------------------------

/** 向量索引命中 */
export interface VectorIndexHit<TMeta = unknown> {
  id: string;
  score: number;
  meta?: TMeta;
}

/** 向量索引接口（store/recall 只依赖此接口，可替换 ANN 实现） */
export interface VectorIndex<TMeta = unknown> {
  readonly size: number;
  /** 写入/覆盖一个向量（自动归一化） */
  upsert(id: string, vec: Float32Array, meta?: TMeta): void;
  /** 删除一个向量 */
  remove(id: string): void;
  /** 查询 top-k（可选谓词过滤） */
  search(
    query: Float32Array,
    k: number,
    options?: { filter?: (id: string, meta?: TMeta) => boolean; minScore?: number },
  ): VectorIndexHit<TMeta>[];
}

/**
 * 暴力余弦索引：Map<id, {vec, meta}> + 线性扫描。已归一化故点积即余弦。
 * 10k×512 实测约 6–9 ms（docs §10.4），v1 作为默认实现足够。
 */
export class BruteForceIndex<TMeta = unknown> implements VectorIndex<TMeta> {
  private readonly entries = new Map<string, { vec: Float32Array; meta?: TMeta }>();

  get size(): number {
    return this.entries.size;
  }

  /** 写入/覆盖（自动 L2 归一化；零向量保留全零） */
  upsert(id: string, vec: Float32Array, meta?: TMeta): void {
    if (typeof id !== 'string' || id.length === 0) {
      throw new TypeError('[dsh-life-memory] VectorIndex.upsert: id must be a non-empty string');
    }
    this.entries.set(id, { vec: normalize(vec), meta });
  }

  remove(id: string): void {
    this.entries.delete(id);
  }

  /** 清空 */
  clear(): void {
    this.entries.clear();
  }

  /**
   * 查询 top-k：query 与库内向量均归一化 => 点积即余弦；
   * minScore 按原始余弦过滤；返回按 score 降序。
   */
  search(
    query: Float32Array,
    k: number,
    options: { filter?: (id: string, meta?: TMeta) => boolean; minScore?: number } = {},
  ): VectorIndexHit<TMeta>[] {
    const limit = Math.max(0, Math.floor(k));
    if (limit === 0 || this.entries.size === 0) return [];
    const normalizedQuery = normalize(query);
    const hits: VectorIndexHit<TMeta>[] = [];
    for (const [id, entry] of this.entries) {
      if (entry.vec.length !== normalizedQuery.length) continue;
      if (options.filter !== undefined && !options.filter(id, entry.meta)) continue;
      const score = dotProduct(normalizedQuery, entry.vec);
      if (options.minScore !== undefined && score < options.minScore) continue;
      hits.push({ id, score, meta: entry.meta });
    }
    hits.sort((a, b) => b.score - a.score);
    return hits.slice(0, limit);
  }
}

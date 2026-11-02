// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hanxustu (dsh-life-memory)
/**
 * 本地确定性 hash 嵌入 `dsh-local-hash-v1`（docs/20 §10.2，必须逐位实现）。
 *
 * 算法（与文档规范完全一致）：
 *   1. 归一化：NFKC → toLowerCase；
 *   2. 切分（tokenizeWeighted）：CJK 单字 kindWeight=0.6、CJK 相邻二元组 1.0、
 *      `[\p{L}\p{N}]` 连续整词 1.0；
 *   3. 词频：唯一 token 出现次数 n，权重 w = kindWeight * (1 + ln(n))；
 *   4. signed feature hashing（Weinberger et al., 2009）：
 *        idx  = fnv1a32(utf8(token), FNV_OFFSET) % dim
 *        sign = (fnv1a32(utf8(token), SEED2) & 1) === 0 ? 1 : -1
 *        vec[idx] += sign * w        // 必须直接累加到 Float32Array（每次 float32 舍入，
 *                                    // 否则 golden vectors 的 sha256 对不上）
 *   5. L2 归一化：norm 用 float64 累加 float32 值，再写回 Float32Array；
 *      空文本/全停用词 => vec[0] = 1（docs 明确，不是零向量）。
 *
 * 确定性：无随机、无时间、无 locale 依赖；同一 (text, dim) 在任何进程/平台得到
 * 逐字节相同的 Float32 向量（tests/core/embed.test.ts 锁定 docs §10.2 golden 值）。
 *
 * 能力边界：hash 嵌入是词法/字符级相似，不做跨语言语义；同义改写可能很低分
 * （docs §10.2）。默认 hybrid 检索里向量与词法权重互补。
 */

import type { Embedder, EmbeddingRef } from '../core/contracts.ts';
import { FNV_OFFSET, FNV_SEED2, fnv1a32 } from '../core/hash.ts';
import { tokenizeWeighted } from '../core/text.ts';
import { LOCAL_HASH_DIM, LOCAL_HASH_MODEL, LOCAL_HASH_VERSION } from './ref.ts';

/** FNV-1a 32 的两个种子（docs §10.2 规定：索引用 FNV_OFFSET，符号用 SEED2） */
export { FNV_OFFSET, FNV_SEED2 };

/** 本地嵌入可接受的最大维度（防御异常配置；正常 256–1024） */
const MAX_LOCAL_DIM = 1_000_000;

/** 校验本地嵌入维度 */
function assertDim(dim: number): void {
  if (!Number.isSafeInteger(dim) || dim <= 0 || dim > MAX_LOCAL_DIM) {
    throw new RangeError(
      `[dsh-life-memory] local embedder: dim must be an integer in 1..${MAX_LOCAL_DIM}, got ${String(dim)}`,
    );
  }
}

/**
 * 单条文本 -> 单位化 Float32 向量（确定性；docs §10.2 golden 基准）。
 * @param text 原文（内部会 NFKC + 小写）
 * @param dim 维度（默认 512）
 */
export function localHashEmbed(text: string, dim: number = LOCAL_HASH_DIM): Float32Array {
  assertDim(dim);
  if (typeof text !== 'string') {
    throw new TypeError('[dsh-life-memory] local embedder: text must be a string');
  }
  const vec = new Float32Array(dim);
  // token -> {出现次数, 类别权重}
  const counts = new Map<string, { count: number; kindWeight: number }>();
  for (const { token, kindWeight } of tokenizeWeighted(text)) {
    const existing = counts.get(token);
    if (existing === undefined) counts.set(token, { count: 1, kindWeight });
    else existing.count += 1;
  }
  if (counts.size === 0) {
    // docs §10.2 步骤 5：空文本/全停用词 => vec[0] = 1，避免零向量
    vec[0] = 1;
    return vec;
  }
  for (const [token, { count, kindWeight }] of counts) {
    const weight = kindWeight * (1 + Math.log(count));
    const bytes = Buffer.from(token, 'utf8');
    const index = fnv1a32(bytes, FNV_OFFSET) % dim;
    const sign = (fnv1a32(bytes, FNV_SEED2) & 1) === 0 ? 1 : -1;
    // 关键：直接在 Float32Array 上累加（每一步按 float32 舍入），与 docs golden 逐位一致
    vec[index] += sign * weight;
  }
  let sumSquares = 0;
  for (let i = 0; i < dim; i += 1) sumSquares += vec[i] * vec[i];
  const norm = Math.sqrt(sumSquares);
  if (!(norm > 0)) {
    vec[0] = 1;
    return vec;
  }
  const out = new Float32Array(dim);
  for (let i = 0; i < dim; i += 1) out[i] = vec[i] / norm;
  return out;
}

/** 批量本地嵌入（按输入顺序返回等长数组） */
export function localHashEmbedMany(texts: readonly string[], dim: number = LOCAL_HASH_DIM): Float32Array[] {
  return texts.map((text) => localHashEmbed(text, dim));
}

/** `dsh-local-hash-v1` 的 EmbeddingRef */
export function localHashEmbeddingRef(dim: number = LOCAL_HASH_DIM): EmbeddingRef {
  assertDim(dim);
  return { model: LOCAL_HASH_MODEL, dim, version: LOCAL_HASH_VERSION };
}

/**
 * 创建本地确定性嵌入器（Embedder 契约）。
 * 默认 512 维；`dim` 改变意味着不同向量空间（EmbeddingRef.dim 不同，不能混算）。
 */
export function createLocalHashEmbedder(dim: number = LOCAL_HASH_DIM): Embedder {
  assertDim(dim);
  const ref = localHashEmbeddingRef(dim);
  return {
    ref,
    async embed(texts: string[]): Promise<Float32Array[]> {
      if (!Array.isArray(texts)) {
        throw new TypeError('[dsh-life-memory] local embedder: embed() requires a string array');
      }
      return localHashEmbedMany(texts, dim);
    },
  };
}

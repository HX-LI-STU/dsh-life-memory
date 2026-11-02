// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hanxustu (dsh-life-memory)
/**
 * 嵌入模型引用（EmbeddingRef）的唯一解析入口。
 *
 * `EmbeddingRef = {model, dim, version}` 是向量空间的唯一身份（docs/20 §10.1）：
 *   - provider=local：固定 `dsh-local-hash-v1` + version '1'（算法变更必须递增 version）；
 *   - provider=openai-compatible：模型名由配置决定，version '1'；
 *     dim 由配置声明（远程返回维度必须与之匹配）。
 *
 * 为什么独立成文件：store（写向量/登记 embedding_models）与 embed 工厂
 * 必须看到**同一个** ref，避免两处各算一份导致向量空间标签不一致。
 */

import type { EmbeddingConfig, EmbeddingRef } from '../core/contracts.ts';

/** 本地确定性嵌入模型 id（docs/20 §10.2） */
export const LOCAL_HASH_MODEL = 'dsh-local-hash-v1';
/** 本地嵌入算法版本（算法/参数改动必须递增，旧向量空间随之失效） */
export const LOCAL_HASH_VERSION = '1';
/** 本地嵌入默认维度 */
export const LOCAL_HASH_DIM = 512;
/** 远程嵌入默认版本字符串 */
export const REMOTE_EMBEDDING_VERSION = '1';

/**
 * 由配置解析 EmbeddingRef。
 * - local：忽略 config.model（算法只有一种），固定 dsh-local-hash-v1；
 * - remote：使用 config.model（必填，config.ts 已校验），version '1'。
 */
export function resolveEmbeddingRef(config: EmbeddingConfig): EmbeddingRef {
  if (config.provider === 'local') {
    return {
      model: LOCAL_HASH_MODEL,
      dim: config.dim > 0 ? Math.floor(config.dim) : LOCAL_HASH_DIM,
      version: LOCAL_HASH_VERSION,
    };
  }
  return {
    model: config.model && config.model.length > 0 ? config.model : 'remote-embedding',
    dim: config.dim > 0 ? Math.floor(config.dim) : LOCAL_HASH_DIM,
    version: REMOTE_EMBEDDING_VERSION,
  };
}

/** 是否指向本地确定性嵌入（用于决定是否允许离线/不联网） */
export function isLocalEmbeddingRef(ref: EmbeddingRef): boolean {
  return ref.model === LOCAL_HASH_MODEL;
}

// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hanxustu (dsh-life-memory)
/**
 * 嵌入器工厂（稳定入口，供 src/index.ts / src/layers/** 使用）：
 *
 *   createEmbedder(config.embedding, { logger?, fetchImpl?, sleep?, env? }): Embedder
 *
 * 选型：
 *   - provider='local'（默认）→ 纯 JS 确定性 hash 嵌入 dsh-local-hash-v1（离线、零依赖）；
 *   - provider='openai-compatible' → 远程嵌入（需要 baseURL；API key 从环境变量读取，
 *     不落配置；失败不回退本地，抛 E_EMBEDDING_UNAVAILABLE）。
 *
 * 缓存：同一个 EmbeddingConfig（不含注入的 fetch/sleep）返回同一个 Embedder 实例，
 * 避免每次构建重复创建；注入 fetchImpl/sleep 的测试实例不缓存。
 * 注意：是否允许联网由 config.safety.allowNetwork 在调用方（config.ts / 集成层）校验，
 * 本工厂只负责按 provider 构建。
 */

import type { Embedder, EmbeddingConfig, Logger } from '../core/contracts.ts';
import { silentLogger } from '../core/logger.ts';
import { createLocalHashEmbedder } from './local-hash.ts';
import { createOpenAiCompatibleEmbedder } from './openai-compatible.ts';
import { LOCAL_HASH_DIM, LOCAL_HASH_MODEL, resolveEmbeddingRef } from './ref.ts';

/** createEmbedder 的运行时依赖（测试可注入，默认走真实环境） */
export interface EmbedderRuntimeOptions {
  logger?: Logger;
  /** 注入 fetch（测试；默认 globalThis.fetch） */
  fetchImpl?: typeof fetch;
  /** 注入 sleep（测试；默认 setTimeout） */
  sleep?: (ms: number) => Promise<void>;
  /** 注入环境变量表（读取 apiKeyEnv；默认 process.env） */
  env?: Record<string, string | undefined>;
}

/** 嵌入器缓存 key（只由影响向量空间的配置决定，不含 logger/注入依赖） */
export function embedderCacheKey(config: EmbeddingConfig): string {
  return JSON.stringify({
    provider: config.provider,
    model: config.model,
    dim: config.dim,
    baseURL: config.baseURL ?? null,
    apiKeyEnv: config.apiKeyEnv ?? null,
    timeoutMs: config.timeoutMs,
    batchSize: config.batchSize,
  });
}

const embedderCache = new Map<string, Embedder>();

/** 清空嵌入器缓存（测试/配置热更新用） */
export function clearEmbedderCache(): void {
  embedderCache.clear();
}

/**
 * 按配置创建（或复用缓存的）嵌入器。
 * @throws TypeError 配置缺字段（provider/baseURL/dim 等）
 */
export function createEmbedder(
  config: EmbeddingConfig,
  runtime: EmbedderRuntimeOptions = {},
): Embedder {
  if (typeof config !== 'object' || config === null) {
    throw new TypeError('[dsh-life-memory] createEmbedder: embedding config is required');
  }
  const logger = runtime.logger ?? silentLogger;
  const provider = config.provider === 'openai-compatible' ? 'openai-compatible' : 'local';
  const dim =
    typeof config.dim === 'number' && Number.isSafeInteger(config.dim) && config.dim > 0
      ? config.dim
      : LOCAL_HASH_DIM;
  const injectable = runtime.fetchImpl !== undefined || runtime.sleep !== undefined;
  const cacheKey = embedderCacheKey({ ...config, provider, dim });
  if (!injectable) {
    const cached = embedderCache.get(cacheKey);
    if (cached !== undefined) return cached;
  }
  let embedder: Embedder;
  if (provider === 'local') {
    embedder = createLocalHashEmbedder(dim);
  } else {
    if (typeof config.baseURL !== 'string' || config.baseURL.length === 0) {
      throw new TypeError(
        '[dsh-life-memory] createEmbedder: embedding.provider=openai-compatible requires embedding.baseURL',
      );
    }
    const env = runtime.env ?? process.env;
    const apiKey =
      typeof config.apiKeyEnv === 'string' && config.apiKeyEnv.length > 0 ? env[config.apiKeyEnv] : undefined;
    embedder = createOpenAiCompatibleEmbedder({
      baseURL: config.baseURL,
      model: config.model,
      dim,
      apiKey: apiKey ?? null,
      timeoutMs: config.timeoutMs,
      batchSize: config.batchSize,
      logger,
      fetchImpl: runtime.fetchImpl,
      sleep: runtime.sleep,
    });
  }
  if (!injectable) embedderCache.set(cacheKey, embedder);
  return embedder;
}

/** 便捷：本地确定性嵌入器（默认 512 维） */
export { createLocalHashEmbedder, localHashEmbed, localHashEmbedMany, localHashEmbeddingRef } from './local-hash.ts';
export {
  createOpenAiCompatibleEmbedder,
  EmbeddingError,
  EMBEDDING_UNAVAILABLE,
  type OpenAiCompatibleEmbedderOptions,
} from './openai-compatible.ts';
export {
  LOCAL_HASH_DIM,
  LOCAL_HASH_MODEL,
  LOCAL_HASH_VERSION,
  REMOTE_EMBEDDING_VERSION,
  isLocalEmbeddingRef,
  resolveEmbeddingRef,
} from './ref.ts';

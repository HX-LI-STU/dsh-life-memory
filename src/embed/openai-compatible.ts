// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hanxustu (dsh-life-memory)
/**
 * OpenAI 兼容远程嵌入提供方（`POST {baseURL}/embeddings`，docs/20 §10.1）。
 *
 * 请求：`{model, input: string[]}` + `Authorization: Bearer <apiKey>`；
 * 响应：`{data: [{embedding: number[]}]}`（也兼容 `{embeddings: number[][]}` 变体）。
 *
 * 行为约定：
 *   - 按 batchSize 分批、顺序请求；
 *   - 每个返回向量校验维度 == ref.dim（不匹配 => 硬失败，绝不静默截断/补零）；
 *   - 返回前 L2 归一化（远程模型一般已归一化，这里兜底；零向量保持零）；
 *   - 重试：429 / 5xx / 超时 / 网络错误 / 响应不可解析 => 指数退避重试 maxRetries 次
 *     （默认 2 次：100ms、200ms，可注入 sleep 便于测试）；4xx（非 429）不重试；
 *   - 失败不回退本地（避免混用向量空间），抛出 code='E_EMBEDDING_UNAVAILABLE' 的错误，
 *     调用方应把该批记录留待补算（docs §10.1）。
 *
 * 测试注入：`fetchImpl` 与 `sleep` 均可注入，测试零真实网络、零真实等待。
 */

import type { Embedder, EmbeddingRef, Logger } from '../core/contracts.ts';
import { silentLogger } from '../core/logger.ts';
import { REMOTE_EMBEDDING_VERSION } from './ref.ts';

/** 嵌入不可用错误码（docs/20 §10.1：失败不回退本地，返回该错误码） */
export const EMBEDDING_UNAVAILABLE = 'E_EMBEDDING_UNAVAILABLE';

/** 嵌入请求/响应错误 */
export class EmbeddingError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly status: number | null;

  constructor(
    message: string,
    options: { retryable?: boolean; status?: number | null; cause?: unknown } = {},
  ) {
    super(`[dsh-life-memory] remote embedder: ${message}`, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'EmbeddingError';
    this.code = EMBEDDING_UNAVAILABLE;
    this.retryable = options.retryable === true;
    this.status = options.status ?? null;
  }
}

/** 创建远程嵌入器的选项（全部可注入，便于 hermetic 测试） */
export interface OpenAiCompatibleEmbedderOptions {
  /** 例如 https://api.openai.com/v1（末尾斜杠可有可无） */
  baseURL: string;
  /** 模型名，例如 text-embedding-3-small */
  model: string;
  /** 期望维度（响应维度必须匹配） */
  dim: number;
  /** 算法/接口版本（默认 '1'） */
  version?: string;
  /** API key（为空则不发 Authorization 头，例如本地 Ollama） */
  apiKey?: string | null;
  /** 单请求超时（默认 20000ms） */
  timeoutMs?: number;
  /** 单批最大条数（默认 32） */
  batchSize?: number;
  /** 重试次数（默认 2；总共最多 3 次请求） */
  maxRetries?: number;
  /** 重试退避基数（默认 100ms；测试可设 0） */
  retryBaseDelayMs?: number;
  /** 注入 fetch（测试）；默认 globalThis.fetch */
  fetchImpl?: typeof fetch;
  /** 注入 sleep（测试）；默认 setTimeout Promise */
  sleep?: (ms: number) => Promise<void>;
  logger?: Logger;
}

/** 解析响应中的向量数组（兼容 data[].embedding 与 embeddings[][] 两种形状） */
function extractEmbeddingArrays(json: unknown, expectedCount: number, dim: number): number[][] {
  if (typeof json !== 'object' || json === null) {
    throw new EmbeddingError('response body is not a JSON object', { retryable: true });
  }
  const body = json as Record<string, unknown>;
  const data = body.data;
  if (Array.isArray(data)) {
    if (data.length !== expectedCount) {
      throw new EmbeddingError(
        `response returned ${data.length} embedding(s), expected ${expectedCount}`,
        { retryable: false },
      );
    }
    const arrays: number[][] = new Array(expectedCount);
    for (let i = 0; i < data.length; i += 1) {
      const item = data[i];
      if (typeof item !== 'object' || item === null) {
        throw new EmbeddingError(`response data[${i}] is not an object`, { retryable: false });
      }
      const itemRecord = item as Record<string, unknown>;
      const embedding = itemRecord.embedding;
      if (!Array.isArray(embedding)) {
        throw new EmbeddingError(`response data[${i}].embedding is not an array`, { retryable: false });
      }
      const index = typeof itemRecord.index === 'number' && Number.isInteger(itemRecord.index)
        ? itemRecord.index
        : i;
      if (index < 0 || index >= expectedCount) {
        throw new EmbeddingError(`response data[${i}].index out of range: ${index}`, { retryable: false });
      }
      arrays[index] = validateEmbeddingArray(embedding, dim, index);
    }
    for (let i = 0; i < expectedCount; i += 1) {
      if (arrays[i] === undefined) {
        throw new EmbeddingError(`response is missing embedding for input index ${i}`, { retryable: false });
      }
    }
    return arrays;
  }
  const embeddings = body.embeddings;
  if (Array.isArray(embeddings)) {
    if (embeddings.length !== expectedCount) {
      throw new EmbeddingError(
        `response returned ${embeddings.length} embedding(s), expected ${expectedCount}`,
        { retryable: false },
      );
    }
    return embeddings.map((embedding, index) => {
      if (!Array.isArray(embedding)) {
        throw new EmbeddingError(`response embeddings[${index}] is not an array`, { retryable: false });
      }
      return validateEmbeddingArray(embedding, dim, index);
    });
  }
  throw new EmbeddingError('response has neither data[] nor embeddings[]', { retryable: true });
}

function validateEmbeddingArray(values: number[], dim: number, index: number): number[] {
  if (values.length !== dim) {
    throw new EmbeddingError(
      `embedding ${index} has dimension ${values.length}, expected ${dim} (model/dim mismatch)`,
      { retryable: false },
    );
  }
  for (let i = 0; i < values.length; i += 1) {
    if (typeof values[i] !== 'number' || !Number.isFinite(values[i])) {
      throw new EmbeddingError(`embedding ${index} has non-finite value at index ${i}`, { retryable: false });
    }
  }
  return values;
}

function toUnitVector(values: number[]): Float32Array {
  const vec = new Float32Array(values.length);
  let sum = 0;
  for (let i = 0; i < values.length; i += 1) {
    vec[i] = values[i];
    sum += vec[i] * vec[i];
  }
  const norm = Math.sqrt(sum);
  if (norm > 0) {
    for (let i = 0; i < vec.length; i += 1) vec[i] /= norm;
  }
  return vec;
}

function defaultSleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * 创建 OpenAI 兼容远程嵌入器。
 * 注意：本函数不做网络请求；只有 embed() 被调用时才发请求。
 */
export function createOpenAiCompatibleEmbedder(options: OpenAiCompatibleEmbedderOptions): Embedder {
  if (typeof options !== 'object' || options === null) {
    throw new TypeError('[dsh-life-memory] remote embedder: options are required');
  }
  const baseURL = options.baseURL;
  if (typeof baseURL !== 'string' || baseURL.length === 0) {
    throw new TypeError('[dsh-life-memory] remote embedder: baseURL is required');
  }
  if (typeof options.model !== 'string' || options.model.length === 0) {
    throw new TypeError('[dsh-life-memory] remote embedder: model is required');
  }
  if (!Number.isSafeInteger(options.dim) || options.dim <= 0) {
    throw new RangeError('[dsh-life-memory] remote embedder: dim must be a positive integer');
  }
  const dim = options.dim;
  const model = options.model;
  const version = options.version ?? REMOTE_EMBEDDING_VERSION;
  const timeoutMs =
    typeof options.timeoutMs === 'number' && Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
      ? Math.floor(options.timeoutMs)
      : 20_000;
  const batchSize =
    typeof options.batchSize === 'number' && Number.isSafeInteger(options.batchSize) && options.batchSize > 0
      ? options.batchSize
      : 32;
  const maxRetries =
    typeof options.maxRetries === 'number' && Number.isSafeInteger(options.maxRetries) && options.maxRetries >= 0
      ? options.maxRetries
      : 2;
  const retryBaseDelayMs =
    typeof options.retryBaseDelayMs === 'number' && Number.isFinite(options.retryBaseDelayMs) && options.retryBaseDelayMs >= 0
      ? options.retryBaseDelayMs
      : 100;
  const logger = options.logger ?? silentLogger;
  const sleep = options.sleep ?? defaultSleep;
  const fetchImpl: typeof fetch | undefined =
    options.fetchImpl ?? (typeof globalThis.fetch === 'function' ? globalThis.fetch : undefined);
  if (fetchImpl === undefined) {
    throw new Error(
      '[dsh-life-memory] remote embedder: no fetch implementation available ' +
        '(Node >= 18 provides global fetch; or inject fetchImpl)',
    );
  }
  const endpoint = `${baseURL.replace(/\/+$/, '')}/embeddings`;
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    accept: 'application/json',
  };
  if (typeof options.apiKey === 'string' && options.apiKey.length > 0) {
    headers.authorization = `Bearer ${options.apiKey}`;
  }
  const ref: EmbeddingRef = { model, dim, version };

  const requestBatch = async (inputs: readonly string[]): Promise<Float32Array[]> => {
    const signal =
      typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
        ? AbortSignal.timeout(timeoutMs)
        : undefined;
    let response: Response;
    try {
      response = await fetchImpl(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify({ model, input: inputs }),
        signal,
      });
    } catch (error) {
      throw new EmbeddingError(`request failed: ${(error as Error).message}`, {
        retryable: true,
        cause: error,
      });
    }
    if (!response.ok) {
      const snippet = await response.text().catch(() => '');
      const retryable = response.status === 429 || response.status >= 500;
      throw new EmbeddingError(`HTTP ${response.status} ${response.statusText}${snippet ? `: ${snippet.slice(0, 300)}` : ''}`, {
        retryable,
        status: response.status,
      });
    }
    let json: unknown;
    try {
      json = await response.json();
    } catch (error) {
      throw new EmbeddingError(`response is not valid JSON: ${(error as Error).message}`, {
        retryable: true,
        cause: error,
      });
    }
    const arrays = extractEmbeddingArrays(json, inputs.length, dim);
    return arrays.map((values) => toUnitVector(values));
  };

  const embedBatchWithRetry = async (inputs: readonly string[]): Promise<Float32Array[]> => {
    let attempt = 0;
    for (;;) {
      try {
        return await requestBatch(inputs);
      } catch (error) {
        const embedError =
          error instanceof EmbeddingError
            ? error
            : new EmbeddingError((error as Error).message, { retryable: false, cause: error });
        if (!embedError.retryable || attempt >= maxRetries) throw embedError;
        attempt += 1;
        const delay = retryBaseDelayMs * 2 ** (attempt - 1);
        logger.warn(
          `[embed] remote embedding attempt ${attempt}/${maxRetries} failed (${embedError.message}); retrying in ${delay}ms`,
        );
        await sleep(delay);
      }
    }
  };

  return {
    ref,
    async embed(texts: string[]): Promise<Float32Array[]> {
      if (!Array.isArray(texts)) {
        throw new TypeError('[dsh-life-memory] remote embedder: embed() requires a string array');
      }
      if (texts.some((text) => typeof text !== 'string')) {
        throw new TypeError('[dsh-life-memory] remote embedder: embed() inputs must be strings');
      }
      if (texts.length === 0) return [];
      const output: Float32Array[] = [];
      for (let offset = 0; offset < texts.length; offset += batchSize) {
        const batch = texts.slice(offset, offset + batchSize);
        const vectors = await embedBatchWithRetry(batch);
        output.push(...vectors);
      }
      return output;
    },
  };
}

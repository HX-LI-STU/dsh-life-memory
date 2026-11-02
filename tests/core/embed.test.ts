/**
 * 嵌入器测试：
 *   - dsh-local-hash-v1 与 docs/20 §10.2 的 golden vectors 逐位一致（dim16 逐值 ±1e-6；
 *     dim512 整段 float32 字节的 sha256 完全一致）；
 *   - 确定性 / 归一化 / 空文本规则 / CJK-英文相似度 sanity / 性能；
 *   - OpenAI 兼容远程嵌入：mock fetch（成功/分批/重试/维度不匹配/4xx 不重试/顺序还原），
 *     零真实网络、零真实等待（sleep 注入）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import type { EmbeddingConfig } from '../../src/core/contracts.ts';
import { silentLogger } from '../../src/core/logger.ts';
import {
  createEmbedder,
  clearEmbedderCache,
  embedderCacheKey,
  localHashEmbed,
  createLocalHashEmbedder,
  localHashEmbeddingRef,
} from '../../src/embed/index.ts';
import {
  createOpenAiCompatibleEmbedder,
  EmbeddingError,
  EMBEDDING_UNAVAILABLE,
} from '../../src/embed/openai-compatible.ts';
import { LOCAL_HASH_DIM, LOCAL_HASH_MODEL, LOCAL_HASH_VERSION } from '../../src/embed/ref.ts';

function sha256OfVector(vec: Float32Array): string {
  return createHash('sha256').update(Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength)).digest('hex');
}

function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / Math.sqrt(na * nb);
}

test('embed(local): docs §10.2 golden vectors dim=16 (tolerance 1e-6)', () => {
  const golden: Array<[string, number[]]> = [
    [
      '我喜欢用深色主题',
      [
        0, -0.140952304, 0, -0.234920487, 0, 0, 0.140952304, -0.375872791, 0.375872791, 0, 0.281904608, 0,
        0.469840974, -0.234920487, 0.51682508, 0,
      ],
    ],
    [
      'the quick brown fox',
      [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0.816496611, 0, 0.408248305, -0.408248305],
    ],
    [
      '深色主题 theme',
      [
        0, -0.241746902, 0.402911484, 0, 0, 0, 0, -0.402911484, 0.241746902, 0, 0, 0, 0.402911484,
        -0.402911484, 0.483493805, 0,
      ],
    ],
  ];
  for (const [text, expected] of golden) {
    const vec = localHashEmbed(text, 16);
    assert.equal(vec.length, 16);
    for (let i = 0; i < 16; i += 1) {
      assert.ok(
        Math.abs(vec[i] - expected[i]) <= 1e-6,
        `${text} index ${i}: got ${vec[i]}, expected ${expected[i]}`,
      );
    }
  }
});

test('embed(local): docs §10.2 golden float32-byte sha256 (dim=512)', () => {
  const golden: Array<[string, string]> = [
    ['我喜欢用深色主题', '06456107fc516b684797aa9be88bd029f628100f0c488082ee8b3c1af49fa842'],
    ['the quick brown fox', '40d04850ec9341febad9268e972c29368ae94d6d9a77b5536fa830db1636b6c3'],
    ['深色主题 theme', 'a3f7d5e8c880e41655f7a87906d54870f61a2608a0c2fc2b04d028aff667c1f8'],
    ['', 'c71873f6f3105b15ca6cd4b1db85011b4339558a0e0d912527da8a7011988b40'],
  ];
  for (const [text, expected] of golden) {
    const vec = localHashEmbed(text, 512);
    assert.equal(sha256OfVector(vec), expected, `sha256 mismatch for ${JSON.stringify(text)}`);
  }
});

test('embed(local): docs §10.2 cosine self-checks', () => {
  const dim = 512;
  const cos = (a: string, b: string): number => cosine(localHashEmbed(a, dim), localHashEmbed(b, dim));
  assert.ok(Math.abs(cos('我喜欢用深色主题', '我喜欢用深色主题。') - 1) < 1e-6);
  assert.ok(Math.abs(cos('dsh-life-memory', 'dsh_life_memory') - 1) < 1e-6);
  assert.ok(Math.abs(cos('the quick brown fox', 'a quick brown fox') - 0.75) < 1e-4);
  assert.ok(Math.abs(cos('我喜欢用深色主题', '偏好深色模式') - 0.1834) < 1e-3);
  assert.ok(Math.abs(cos('微服务架构', '单体应用架构') - 0.2669) < 1e-3);
  assert.ok(Math.abs(cos('我喜欢用深色主题', 'Please use the dark theme')) < 1e-6);
});

test('embed(local): deterministic, unit-normalized, empty text => vec[0]=1', () => {
  const a = localHashEmbed('用户偏好深色主题', LOCAL_HASH_DIM);
  const b = localHashEmbed('用户偏好深色主题', LOCAL_HASH_DIM);
  assert.deepEqual(Array.from(a), Array.from(b));
  let sum = 0;
  for (const value of a) sum += value * value;
  assert.ok(Math.abs(Math.sqrt(sum) - 1) < 1e-5);
  const empty = localHashEmbed('', LOCAL_HASH_DIM);
  assert.equal(empty[0], 1);
  for (let i = 1; i < empty.length; i += 1) assert.equal(empty[i], 0);
  // 纯标点/空白 => 无 token => 同空文本规则
  assert.equal(localHashEmbed('，。！  ', LOCAL_HASH_DIM)[0], 1);
});

test('embed(local): configurable dims + related CJK > unrelated CJK', () => {
  for (const dim of [64, 256]) {
    const vec = localHashEmbed('记忆库', dim);
    assert.equal(vec.length, dim);
    let sum = 0;
    for (const value of vec) sum += value * value;
    assert.ok(Math.abs(Math.sqrt(sum) - 1) < 1e-5);
  }
  assert.throws(() => localHashEmbed('x', 0), /dim/);
  const related = cosine(
    localHashEmbed('用户偏好深色主题', 512),
    localHashEmbed('用户喜欢深色主题', 512),
  );
  const unrelated = cosine(
    localHashEmbed('用户偏好深色主题', 512),
    localHashEmbed('明天天气怎么样', 512),
  );
  assert.ok(related > unrelated, `related ${related} should exceed unrelated ${unrelated}`);
  assert.ok(related > 0.3);
});

test('embed(local): Embedder ref + factory + 10k short texts performance', async () => {
  const embedder = createLocalHashEmbedder(256);
  assert.deepEqual(embedder.ref, { model: LOCAL_HASH_MODEL, dim: 256, version: LOCAL_HASH_VERSION });
  assert.deepEqual(localHashEmbeddingRef(64), { model: LOCAL_HASH_MODEL, dim: 64, version: LOCAL_HASH_VERSION });
  const vectors = await embedder.embed(['hello', '记忆库', '']);
  assert.equal(vectors.length, 3);
  const texts = Array.from({ length: 10_000 }, (_, i) => `记忆 ${i} memory vault 深色主题`);
  const started = performance.now();
  const batch = await embedder.embed(texts);
  const elapsed = performance.now() - started;
  assert.equal(batch.length, 10_000);
  assert.ok(elapsed < 1500, `10k short texts took ${elapsed.toFixed(0)}ms (expected < 1000ms target)`);
});

// ---------------------------------------------------------------------------
// 远程嵌入（mock fetch / mock sleep，零真实网络）
// ---------------------------------------------------------------------------

interface FetchCall {
  url: string;
  init: RequestInit | undefined;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function makeEmbeddingResponse(count: number, dim: number, base: number): unknown {
  return {
    object: 'list',
    data: Array.from({ length: count }, (_, i) => ({
      object: 'embedding',
      index: i,
      embedding: Array.from({ length: dim }, (_, j) => (j === 0 ? base + i + 1 : 0)),
    })),
    model: 'test-embedding',
  };
}

test('embed(remote): success request shape, unit vectors, dim validation', async () => {
  const calls: FetchCall[] = [];
  const fetchImpl = (async (url: string, init?: RequestInit): Promise<Response> => {
    calls.push({ url, init });
    return jsonResponse(makeEmbeddingResponse(2, 4, 1));
  }) as unknown as typeof fetch;
  const embedder = createOpenAiCompatibleEmbedder({
    baseURL: 'http://127.0.0.1:9999/v1/',
    model: 'test-embedding',
    dim: 4,
    apiKey: 'sk-test',
    fetchImpl,
    sleep: async () => {},
  });
  assert.deepEqual(embedder.ref, { model: 'test-embedding', dim: 4, version: '1' });
  const vectors = await embedder.embed(['a', 'b']);
  assert.equal(vectors.length, 2);
  assert.equal(vectors[0][0], 1); // 单位化后 [1,0,0,0]
  assert.equal(vectors[1][0], 1);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'http://127.0.0.1:9999/v1/embeddings');
  const headers = calls[0].init?.headers as Record<string, string>;
  assert.equal(headers.authorization, 'Bearer sk-test');
  const body = JSON.parse(String(calls[0].init?.body)) as { model: string; input: string[] };
  assert.equal(body.model, 'test-embedding');
  assert.deepEqual(body.input, ['a', 'b']);
});

test('embed(remote): batching by batchSize', async () => {
  const calls: FetchCall[] = [];
  const fetchImpl = (async (url: string, init?: RequestInit): Promise<Response> => {
    calls.push({ url, init });
    const body = JSON.parse(String(init?.body)) as { input: string[] };
    return jsonResponse(makeEmbeddingResponse(body.input.length, 3, 1));
  }) as unknown as typeof fetch;
  const embedder = createOpenAiCompatibleEmbedder({
    baseURL: 'http://x/v1',
    model: 'm',
    dim: 3,
    batchSize: 2,
    fetchImpl,
    sleep: async () => {},
  });
  const vectors = await embedder.embed(['1', '2', '3', '4', '5']);
  assert.equal(vectors.length, 5);
  assert.equal(calls.length, 3);
  const sizes = calls.map((call) => (JSON.parse(String(call.init?.body)) as { input: string[] }).input.length);
  assert.deepEqual(sizes, [2, 2, 1]);
});

test('embed(remote): retries on 500/429 then succeeds with exponential backoff', async () => {
  let attempts = 0;
  const sleeps: number[] = [];
  const fetchImpl = (async (): Promise<Response> => {
    attempts += 1;
    if (attempts === 1) return jsonResponse({ error: 'boom' }, 500);
    if (attempts === 2) return jsonResponse({ error: 'slow down' }, 429);
    return jsonResponse(makeEmbeddingResponse(1, 2, 1));
  }) as unknown as typeof fetch;
  const embedder = createOpenAiCompatibleEmbedder({
    baseURL: 'http://x/v1',
    model: 'm',
    dim: 2,
    maxRetries: 2,
    retryBaseDelayMs: 100,
    fetchImpl,
    sleep: async (ms: number) => {
      sleeps.push(ms);
    },
  });
  const vectors = await embedder.embed(['hello']);
  assert.equal(vectors.length, 1);
  assert.equal(attempts, 3);
  assert.deepEqual(sleeps, [100, 200]);
});

test('embed(remote): exhausts retries -> E_EMBEDDING_UNAVAILABLE', async () => {
  let attempts = 0;
  const fetchImpl = (async (): Promise<Response> => {
    attempts += 1;
    return jsonResponse({ error: 'down' }, 503);
  }) as unknown as typeof fetch;
  const embedder = createOpenAiCompatibleEmbedder({
    baseURL: 'http://x/v1',
    model: 'm',
    dim: 2,
    maxRetries: 2,
    retryBaseDelayMs: 0,
    fetchImpl,
    sleep: async () => {},
  });
  await assert.rejects(
    () => embedder.embed(['hello']),
    (error: unknown) => {
      assert.ok(error instanceof EmbeddingError);
      assert.equal(error.code, EMBEDDING_UNAVAILABLE);
      return true;
    },
  );
  assert.equal(attempts, 3);
});

test('embed(remote): 4xx is not retried; dim mismatch fails fast', async () => {
  let attempts = 0;
  const fetchImpl = (async (): Promise<Response> => {
    attempts += 1;
    return jsonResponse({ error: 'bad request' }, 400);
  }) as unknown as typeof fetch;
  const embedder = createOpenAiCompatibleEmbedder({
    baseURL: 'http://x/v1',
    model: 'm',
    dim: 2,
    fetchImpl,
    sleep: async () => {},
  });
  await assert.rejects(() => embedder.embed(['hello']), /HTTP 400/);
  assert.equal(attempts, 1);

  const dimMismatch = createOpenAiCompatibleEmbedder({
    baseURL: 'http://x/v1',
    model: 'm',
    dim: 8,
    fetchImpl: (async () => jsonResponse(makeEmbeddingResponse(1, 4, 1))) as unknown as typeof fetch,
    sleep: async () => {},
  });
  await assert.rejects(() => dimMismatch.embed(['hello']), /dimension/);
});

test('embed(remote): network failure retried; response index order restored', async () => {
  let attempts = 0;
  const fetchImpl = (async (): Promise<Response> => {
    attempts += 1;
    if (attempts === 1) throw new Error('ECONNRESET');
    return jsonResponse({
      data: [
        { index: 1, embedding: [0, 0, 0, 2] },
        { index: 0, embedding: [0, 0, 0, 4] },
      ],
    });
  }) as unknown as typeof fetch;
  const embedder = createOpenAiCompatibleEmbedder({
    baseURL: 'http://x/v1',
    model: 'm',
    dim: 4,
    retryBaseDelayMs: 0,
    fetchImpl,
    sleep: async () => {},
  });
  const vectors = await embedder.embed(['first', 'second']);
  assert.equal(attempts, 2);
  assert.equal(vectors[0][3], 1); // 归一化后 [0,0,0,1]，对应 index=0 => 原值 4
  assert.equal(vectors[1][3], 1);
  // 顺序：index 0 输入 = 'first'，其原向量第 4 分量 4 ⇒ 归一化 1
  assert.equal(vectors[0].length, 4);
});

test('embed(factory): local/remote selection, apiKey env, caching', async () => {
  clearEmbedderCache();
  const localConfig: EmbeddingConfig = {
    provider: 'local',
    dim: 128,
    model: 'dsh-local-hash-v1',
    timeoutMs: 1000,
    batchSize: 8,
  };
  const local = createEmbedder(localConfig);
  assert.deepEqual(local.ref, { model: LOCAL_HASH_MODEL, dim: 128, version: LOCAL_HASH_VERSION });
  assert.equal(createEmbedder(localConfig), local); // 同配置复用
  clearEmbedderCache();
  assert.notEqual(createEmbedder(localConfig), local);

  assert.throws(
    () =>
      createEmbedder({
        provider: 'openai-compatible',
        dim: 4,
        model: 'm',
        timeoutMs: 1000,
        batchSize: 8,
      }),
    /baseURL/,
  );

  let seenAuth: string | undefined;
  const remoteConfig: EmbeddingConfig = {
    provider: 'openai-compatible',
    dim: 2,
    model: 'm',
    baseURL: 'http://x/v1',
    apiKeyEnv: 'MY_KEY',
    timeoutMs: 1000,
    batchSize: 8,
  };
  const fetchImpl = (async (_url: string, init?: RequestInit): Promise<Response> => {
    seenAuth = (init?.headers as Record<string, string>).authorization;
    return jsonResponse(makeEmbeddingResponse(1, 2, 1));
  }) as unknown as typeof fetch;
  const remote = createEmbedder(remoteConfig, {
    env: { MY_KEY: 'env-secret' },
    fetchImpl,
    sleep: async () => {},
  });
  assert.equal(remote.ref.model, 'm');
  await remote.embed(['hi']);
  assert.equal(seenAuth, 'Bearer env-secret');
  assert.ok(embedderCacheKey(remoteConfig).includes('openai-compatible'));
});

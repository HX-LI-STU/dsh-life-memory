/**
 * 检索分工测试（docs/24-memory-access-forgetting.md §1/§3）：
 * - **explicit（默认）**：L0 原始层向量 + raw FTS + recency 融合，返回 `RecallHit{layer:'raw'}` + 引用；
 *   不受遗忘影响；无原始层向量时自动只走词法（warning 不失败）。
 * - **implicit**：三层记忆（既有行为，可遗忘）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { NewMemoryRecord, RawAppendItem, RawRecord } from '../../../src/core/contracts.ts';
import { silentLogger } from '../../../src/core/logger.ts';
import { DAY_MS, createForgettingEngine } from '../../../src/forgetting/index.ts';
import { createRetentionEngine } from '../../../src/retention/index.ts';
import {
  EXPLICIT_LEXICAL_WEIGHT,
  EXPLICIT_RECENCY_WEIGHT,
  EXPLICIT_VECTOR_WEIGHT,
  createRecaller,
} from '../../../src/search/recall.ts';
import {
  FakeMemoryStore,
  TEST_NOW,
  createClock,
  createFailingEmbedder,
  createFakeEmbedder,
  hashEmbed,
  makeRaw,
  testConfig,
} from '../layers/fakes.ts';

function rawItem(record: RawRecord, lineNo: number): RawAppendItem {
  return {
    record,
    location: {
      ingestKey: `${record.sessionId}:${record.seq}`,
      segment: 'segments/2026-10-25/seg-w000001-000001.jsonl',
      lineNo,
      byteOffset: (lineNo - 1) * 512,
      byteLen: 512,
    },
  };
}

interface ExplicitEnv {
  clock: ReturnType<typeof createClock>;
  store: FakeMemoryStore;
  embedder: ReturnType<typeof createFakeEmbedder>;
  config: ReturnType<typeof testConfig>;
  recaller: ReturnType<typeof createRecaller>;
  rawRecords: RawRecord[];
}

function makeExplicitEnv(overrides: Record<string, unknown> = {}): ExplicitEnv {
  const clock = createClock(TEST_NOW);
  const store = new FakeMemoryStore();
  store.nowValue = clock.now();
  const embedder = createFakeEmbedder(64);
  const config = testConfig(overrides);
  const recaller = createRecaller({ store, embedder, config, logger: silentLogger, now: () => clock.now() });
  return { clock, store, embedder, config, recaller, rawRecords: [] };
}

/** 写入原始记录（raw_index + 原始层向量），返回记录 */
function seedRaw(env: ExplicitEnv, options: { seq: number; text: string; ts?: number; kind?: RawRecord['kind'] }): RawRecord {
  const record = makeRaw(options.seq, {
    kind: options.kind ?? 'user',
    role: 'user',
    text: options.text,
    ts: options.ts ?? TEST_NOW,
  });
  env.rawRecords.push(record);
  env.store.indexRawRecord(rawItem(record, options.seq));
  env.store.putRawVector(record.id, env.embedder.ref, hashEmbed(options.text, 64));
  return record;
}

test('explicit 检索（默认）：命中 L0 原始记录，返回 raw + 引用 + 三因子', async () => {
  const env = makeExplicitEnv();
  const target = seedRaw(env, { seq: 1, text: '记住：我偏好深色主题，本地端口用 8080。' });
  const other = seedRaw(env, { seq: 2, text: '今天天气不错，出去走走。', kind: 'assistant' });
  const hits = await env.recaller.recall({ text: '深色主题', limit: 5 });
  assert.ok(hits.length >= 1);
  assert.equal(hits[0].layer, 'raw');
  assert.equal(hits[0].raw?.id, target.id);
  assert.deepEqual(hits[0].citations, [target.id]);
  assert.equal(hits[0].components.importance, 0);
  assert.ok(hits[0].components.vector > 0);
  assert.ok(hits[0].components.lexical > 0);
  assert.ok(hits[0].components.recency > 0);
  // 显式检索无 minScore 时也会带出向量近邻 + recency 底分；相关记录必须排第一
  const otherHit = hits.find((hit) => hit.raw?.id === other.id);
  if (otherHit) {
    assert.ok(otherHit.score < hits[0].score, '不相关记录的分数必须低于相关记录');
    assert.equal(otherHit.components.lexical, 0, '无词法重叠不相关记录 lexical=0');
  }
  // score = .45*vector + .35*lexical + .20*recency
  for (const hit of hits) {
    const expected =
      EXPLICIT_VECTOR_WEIGHT * hit.components.vector +
      EXPLICIT_LEXICAL_WEIGHT * hit.components.lexical +
      EXPLICIT_RECENCY_WEIGHT * hit.components.recency;
    assert.ok(Math.abs(hit.score - expected) <= 1e-9);
  }
  assert.equal(EXPLICIT_VECTOR_WEIGHT + EXPLICIT_LEXICAL_WEIGHT + EXPLICIT_RECENCY_WEIGHT, 1);
  // 权重常量与文档一致
  assert.equal(EXPLICIT_VECTOR_WEIGHT, 0.45);
  assert.equal(EXPLICIT_LEXICAL_WEIGHT, 0.35);
  assert.equal(EXPLICIT_RECENCY_WEIGHT, 0.2);
});

test('explicit 检索：原始层无向量 / 嵌入失败 → 自动只走词法（不失败）', async () => {
  // 场景 A：raw 向量不存在
  const env = makeExplicitEnv();
  const record = makeRaw(1, { kind: 'user', role: 'user', text: '端口配置在 config.toml' });
  env.store.indexRawRecord(rawItem(record, 1));
  const lexicalOnly = await env.recaller.recall({ text: '端口', limit: 5 });
  assert.ok(lexicalOnly.length >= 1);
  assert.equal(lexicalOnly[0].layer, 'raw');
  assert.equal(lexicalOnly[0].components.vector, 0);
  assert.ok(lexicalOnly[0].components.lexical > 0);

  // 场景 B：嵌入器失败（向量路径不可用）
  const env2 = makeExplicitEnv();
  const record2 = makeRaw(1, { kind: 'user', role: 'user', text: '端口配置在 config.toml' });
  env2.store.indexRawRecord(rawItem(record2, 1));
  const recaller2 = createRecaller({
    store: env2.store,
    embedder: createFailingEmbedder(64),
    config: env2.config,
    logger: silentLogger,
    now: () => env2.clock.now(),
  });
  const hits = await recaller2.recall({ text: '端口', limit: 5 });
  assert.ok(hits.length >= 1);
  assert.equal(hits[0].components.vector, 0);
});

test('explicit 检索：不受遗忘影响（遗忘后原始层仍可检索，引用仍可解析）', async () => {
  const env = makeExplicitEnv();
  const oldRaw = seedRaw(env, { seq: 1, text: '很久以前的端口配置记录', ts: TEST_NOW - 30 * 86_400_000 });
  // 一条已到期的短期派生记忆（会被遗忘删除）
  const derived = env.store.upsertMemory(
    {
      layer: 'L1',
      kind: 'atom',
      text: '很久以前的端口配置记录',
      importance: 0.3,
      confidence: 0.9,
      sourceRawIds: [oldRaw.id],
      tags: [],
      createdAt: TEST_NOW - 30 * 86_400_000,
    },
    hashEmbed('很久以前的端口配置记录', 64),
  );
  // 派生记录创建/更新时间都在 30 天前（fake store 插入时 updatedAt=now，这里显式回拨模拟历史记录）
  env.store.memories.get(derived.id)!.updatedAt = TEST_NOW - 30 * 86_400_000;
  const forgetting = createForgettingEngine({ store: env.store, config: env.config, logger: silentLogger, now: () => env.clock.now() });
  const report = await forgetting.run({ now: env.clock.now() });
  assert.equal(report.deletedShort, 1, '派生层短期记忆应被物理删除');
  assert.equal(env.store.countByLayer().L1 ?? 0, 0);
  // 原始层不受影响
  const hits = await env.recaller.recall({ text: '端口配置', limit: 5 });
  assert.ok(hits.some((hit) => hit.raw?.id === oldRaw.id), '显式检索不受遗忘影响');
  assert.ok(env.store.getRawIndex(oldRaw.id), 'raw_index 仍在');
  assert.ok(env.store.getRawVector(oldRaw.id), '原始层向量仍在');
});

test('implicit 检索：仍走三层记忆（不返回 raw）', async () => {
  const env = makeExplicitEnv();
  seedRaw(env, { seq: 1, text: '原始层的深色主题原文' });
  const memory = env.store.upsertMemory(
    {
      layer: 'L3',
      kind: 'preference',
      text: '用户偏好深色主题',
      importance: 0.8,
      confidence: 0.9,
      sourceRawIds: ['2026-10-25-000001'],
      tags: [],
      createdAt: TEST_NOW,
    },
    hashEmbed('用户偏好深色主题', 64),
  );
  const hits = await env.recaller.recall({ mode: 'implicit', text: '深色主题', limit: 5, trackAccess: false });
  assert.ok(hits.some((hit) => hit.memory?.id === memory.id));
  assert.ok(hits.every((hit) => hit.layer !== 'raw'));
});

test('explicit 检索：q 为空 → 空结果；minScore/limit 生效', async () => {
  const env = makeExplicitEnv();
  seedRaw(env, { seq: 1, text: '深色主题相关记录一' });
  seedRaw(env, { seq: 2, text: '深色主题相关记录二' });
  assert.deepEqual(await env.recaller.recall({ text: '   ' }), []);
  const limited = await env.recaller.recall({ text: '深色主题', limit: 1 });
  assert.equal(limited.length, 1);
  const highMin = await env.recaller.recall({ text: '深色主题', minScore: 0.999 });
  assert.equal(highMin.length, 0);
});

test('explicit 检索：原始层检索不写 retention / 不 touch 派生治理列', async () => {
  const env = makeExplicitEnv();
  seedRaw(env, { seq: 1, text: '深色主题原始记录' });
  const memory = env.store.upsertMemory(
    {
      layer: 'L1',
      kind: 'atom',
      text: '深色主题派生记录',
      importance: 0.5,
      confidence: 0.9,
      sourceRawIds: ['2026-10-25-000001'],
      tags: [],
      createdAt: TEST_NOW,
    },
    hashEmbed('深色主题派生记录', 64),
  );
  const before = env.store.getRetention(memory.id);
  const beforeAccess = env.store.getMemory(memory.id)?.accessCount ?? 0;
  await env.recaller.recall({ text: '深色主题', limit: 5, trackAccess: false });
  assert.deepEqual(env.store.getRetention(memory.id), before);
  assert.equal(env.store.getMemory(memory.id)?.accessCount, beforeAccess);
  assert.equal(env.store.retentionBatchCalls, 0);
});

test('retention：新的 short→mid 晋升条件与 forgetting 协同（未达标 short 到期被删除）', async () => {
  const clock = createClock(TEST_NOW);
  const store = new FakeMemoryStore();
  store.nowValue = clock.now();
  const config = testConfig();
  const retention = createRetentionEngine({ store, config, logger: silentLogger, now: () => clock.now() });
  const forgetting = createForgettingEngine({ store, config, logger: silentLogger, now: () => clock.now() });
  const lowValue = store.upsertMemory({
    layer: 'L1',
    kind: 'atom',
    text: '无访问、低重要度的短期记忆',
    importance: 0.2,
    confidence: 0.9,
    sourceRawIds: ['2026-10-25-000001'],
    tags: [],
    createdAt: TEST_NOW - 8 * 86_400_000,
  });
  const good = store.upsertMemory({
    layer: 'L1',
    kind: 'atom',
    text: '重要度高、可晋升的短期记忆',
    importance: 0.8,
    confidence: 0.9,
    sourceRawIds: ['2026-10-25-000002'],
    tags: [],
    createdAt: TEST_NOW - 8 * 86_400_000,
  });
  // 模拟 8 天前写入的历史记录（fake store 插入时 updatedAt=now）
  store.memories.get(lowValue.id)!.updatedAt = TEST_NOW - 8 * 86_400_000;
  store.memories.get(good.id)!.updatedAt = TEST_NOW - 8 * 86_400_000;
  await retention.tick({ now: clock.now() });
  assert.equal(store.getRetention(good.id)?.tier, 'mid', '达标记录晋升 mid');
  assert.equal(store.getRetention(lowValue.id)?.tier, 'short', '未达标记录保持 short');
  const report = await forgetting.run({ now: clock.now() });
  assert.equal(report.deletedShort, 1);
  assert.equal(store.getMemory(lowValue.id), null, '未晋升 short 到期被删除');
  assert.ok(store.getMemory(good.id), '已晋升 mid 不遗忘');
});

// ---------------------------------------------------------------------------
// 真实 store 冒烟（原始层向量 migration 3；storage 未就绪时 skip）
// ---------------------------------------------------------------------------

let realModules: {
  openStore?: (input: unknown, runtime?: unknown) => unknown;
  createLocalHashEmbedder?: (dim?: number) => unknown;
} | null = null;
try {
  const storeModule = await import('../../../src/store/index.ts');
  const embedModule = await import('../../../src/embed/local-hash.ts');
  if (typeof storeModule.openStore === 'function' && typeof embedModule.createLocalHashEmbedder === 'function') {
    realModules = {
      openStore: storeModule.openStore as never,
      createLocalHashEmbedder: embedModule.createLocalHashEmbedder as never,
    };
  }
} catch {
  realModules = null;
}
const skipReal = realModules === null ? '真实 store/embed 不可用' : false;

test('explicit × 真实 store：原始层向量+词法检索返回 raw hit；遗忘不影响 L0/原始向量', { skip: skipReal }, async () => {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { mergeConfig } = await import('../../../src/config.ts');
  const { createForgettingEngine: createRealForgetting } = await import('../../../src/forgetting/index.ts');

  const dir = mkdtempSync(join(tmpdir(), 'dsh-mv-explicit-'));
  const clock = createClock(TEST_NOW);
  const config = mergeConfig({
    timezone: 'Asia/Shanghai',
    embedding: { provider: 'local', dim: 512, model: 'dsh-local-hash-v1' },
  });
  type RealStore = {
    nowValue?: number;
    indexRawRecords(items: RawAppendItem[]): void;
    putRawVector(rawId: string, ref: unknown, vec: Float32Array): void;
    getRawVector(rawId: string): unknown;
    getRawIndex(rawId: string): unknown;
    listRawIndex(query?: unknown): { total: number };
    upsertMemory(record: NewMemoryRecord, embedding?: Float32Array): { id: string };
    getMemory(id: string): NewMemoryRecord | null;
    countByLayer(): Record<string, number>;
    rawVectorStats(ref?: unknown): { total: number };
    searchRawVector?: unknown;
    searchRawLexical?: unknown;
    forgetDerivedMemories?: unknown;
    forgettingStats(): { shortDeleted: number; midArchived: number; lastForgetAt: number | null };
    recordForgetting(stats: { deletedShort?: number; archivedMid?: number }, now?: number): void;
    close(): void;
  };
  const openStore = realModules!.openStore as unknown as (input: unknown, runtime?: unknown) => RealStore;
  const store = openStore(
    { dataDir: dir, timezone: config.timezone, embedding: config.embedding },
    { logger: silentLogger, now: () => clock.now() },
  );
  try {
    if (typeof store.searchRawVector !== 'function' || typeof store.searchRawLexical !== 'function') {
      return; // storage 尚未实现原始层向量（skip 语义由契约测试覆盖）
    }
    const createLocalHashEmbedder = realModules!.createLocalHashEmbedder as unknown as (dim?: number) => {
      ref: { model: string; dim: number; version: string };
      embed(texts: string[]): Promise<Float32Array[]>;
    };
    const embedder = createLocalHashEmbedder(512);
    const raw = makeRaw(1, { kind: 'user', role: 'user', text: '记住：我偏好深色主题，端口 8080', ts: TEST_NOW });
    store.indexRawRecords([rawItem(raw, 1)]);
    const [rawVector] = await embedder.embed([raw.text ?? '']);
    store.putRawVector(raw.id, embedder.ref, rawVector);
    const recaller = createRecaller({
      store: store as never,
      embedder: embedder as never,
      config,
      logger: silentLogger,
      now: () => clock.now(),
    });
    const hits = await recaller.recall({ text: '深色主题', limit: 5 });
    assert.ok(hits.some((hit) => hit.layer === 'raw' && hit.raw?.id === raw.id), '显式检索应命中 L0 原始记录');
    assert.ok((hits[0].components.vector ?? 0) > 0);
    assert.ok((hits[0].citations ?? []).includes(raw.id));

    // 遗忘：把时钟拨到 30 天后，派生层短期记忆到期删除；L0/原始向量不变
    const rawIndexBefore = store.listRawIndex().total;
    const rawVectorTotalBefore = store.rawVectorStats(embedder.ref).total;
    const derived = store.upsertMemory(
      {
        layer: 'L1',
        kind: 'atom',
        text: '到期派生记忆',
        importance: 0.3,
        confidence: 0.9,
        sourceRawIds: [raw.id],
        tags: [],
        createdAt: clock.now(),
      },
      await embedder.embed(['到期派生记忆']).then((rows) => rows[0]),
    );
    clock.advance(30 * DAY_MS);
    store.nowValue = clock.now();
    const forgetting = createRealForgetting({ store: store as never, config, logger: silentLogger, now: () => clock.now() });
    const report = await forgetting.run({ now: clock.now() });
    if (typeof store.forgetDerivedMemories === 'function') {
      assert.ok(report.deletedShort >= 1, '到期短期派生记忆应被删除');
      assert.equal(store.getMemory(derived.id), null);
    }
    assert.equal(store.listRawIndex().total, rawIndexBefore, 'raw_index 只增不减');
    assert.equal(store.rawVectorStats(embedder.ref).total, rawVectorTotalBefore, '原始层向量只增不减');
    const afterHits = await recaller.recall({ text: '深色主题', limit: 5 });
    assert.ok(afterHits.some((hit) => hit.raw?.id === raw.id), '遗忘后显式检索仍命中 L0');
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});


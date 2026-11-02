/**
 * 遗忘引擎测试（docs/24-memory-access-forgetting.md §2）：
 * - short 到期（> retention.shortTermDays 且未晋升 mid）→ 物理删除派生记录；
 * - mid 到期（> retention.longTermAfterDays 且未晋升 long）→ 归档；
 * - pinned / importance ≥ protectImportance 不遗忘；dryRun 只统计不写；幂等；错误不抛；
 * - 绝不触碰 L0 / raw_index / 原始层向量。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { NewMemoryRecord, RawRecord, RetentionTier } from '../../../src/core/contracts.ts';
import { deriveMemoryId } from '../../../src/core/ids.ts';
import { silentLogger } from '../../../src/core/logger.ts';
import {
  DAY_MS,
  FORGETTING_LAYERS,
  createForgettingEngine,
  isForgettingProtected,
} from '../../../src/forgetting/index.ts';
import {
  FakeMemoryStore,
  TEST_NOW,
  createClock,
  createFakeEmbedder,
  hashEmbed,
  makeRaw,
  testConfig,
} from '../layers/fakes.ts';

function makeEnv(overrides: Record<string, unknown> = {}) {
  const clock = createClock(TEST_NOW);
  const store = new FakeMemoryStore();
  store.nowValue = clock.now();
  const embedder = createFakeEmbedder(64);
  const config = testConfig(overrides);
  const engine = createForgettingEngine({ store, config, logger: silentLogger, now: () => clock.now() });
  return { clock, store, config, engine, embedder };
}

let seedCounter = 0;
interface SeedOptions {
  text: string;
  layer?: string;
  kind?: string;
  tier?: RetentionTier;
  importance?: number;
  pinned?: boolean;
  ageDays?: number;
  sessionId?: string;
}

/** 写入一条派生记忆（默认 short，ageDays 前创建/更新） */
function seed(store: FakeMemoryStore, options: SeedOptions): string {
  seedCounter += 1;
  const layer = options.layer ?? 'L1';
  const kind = options.kind ?? 'atom';
  const age = (options.ageDays ?? 10) * DAY_MS;
  const createdAt = TEST_NOW - age;
  const record: NewMemoryRecord = {
    id: deriveMemoryId(layer, kind, createdAt, `forget-${seedCounter}`),
    layer,
    kind: kind as never,
    text: options.text,
    importance: options.importance ?? 0.3,
    confidence: 0.9,
    sourceRawIds: ['2026-10-25-000001'],
    sessionId: options.sessionId ?? 's1',
    tags: [],
    createdAt,
    ...(options.pinned !== undefined ? { pinned: options.pinned } : {}),
  };
  const stored = store.upsertMemory(record, hashEmbed(options.text, 64));
  const memory = store.memories.get(stored.id)!;
  memory.updatedAt = createdAt;
  memory.retentionTier = options.tier ?? 'short';
  return stored.id;
}

test('forgetting: short 到期 → 物理删除派生记忆（含向量/私有行），计数与审计', async () => {
  const { store, engine, clock } = makeEnv();
  const expired = seed(store, { text: '到期短期记忆', ageDays: 10 });
  const fresh = seed(store, { text: '未到期短期记忆', ageDays: 1 });
  const report = await engine.run({ now: clock.now() });
  assert.equal(report.evaluated, 1, '只统计"到期"候选（未到期的短期记忆不计入）');
  assert.equal(report.deletedShort, 1);
  assert.equal(report.archivedMid, 0);
  assert.equal(report.protectedCount, 0);
  assert.equal(report.now, clock.now());
  assert.equal(store.getMemory(expired), null);
  assert.equal(store.getVector(expired), null, '临时向量随派生记忆删除');
  assert.ok(store.getMemory(fresh));
  const stats = await engine.stats();
  assert.equal(stats.shortDeleted, 1);
  assert.equal(stats.lastForgetAt, clock.now());
  assert.equal(engine.lastForgetAt(), clock.now());
});

test('forgetting: mid 到期 → 归档（保留内容，不物理删除）', async () => {
  const { store, engine, clock } = makeEnv();
  const expiredMid = seed(store, { text: '到期中期记忆', tier: 'mid', ageDays: 100 });
  const freshMid = seed(store, { text: '未到期中期记忆', tier: 'mid', ageDays: 10 });
  const report = await engine.run({ now: clock.now() });
  assert.equal(report.deletedShort, 0);
  assert.equal(report.archivedMid, 1);
  const archived = store.getMemory(expiredMid)!;
  assert.equal(archived.status, 'archived');
  assert.equal(typeof archived.validTo, 'number');
  assert.ok((archived.validTo ?? 0) <= clock.now());
  assert.equal(store.getMemory(freshMid)?.status ?? 'active', 'active');
  const stats = await engine.stats();
  assert.equal(stats.midArchived, 1);
});

test('forgetting: long / pinned / 高重要度受保护；protectedCount 统计', async () => {
  const { store, engine, clock, config } = makeEnv();
  const longId = seed(store, { text: '长期记忆', tier: 'long', ageDays: 100 });
  const pinnedId = seed(store, { text: '钉住记忆', ageDays: 100, pinned: true });
  const importantId = seed(store, { text: '高重要度记忆', ageDays: 100, importance: 0.95 });
  const deletableId = seed(store, { text: '普通到期记忆', ageDays: 100, importance: 0.3 });
  const report = await engine.run({ now: clock.now() });
  assert.equal(report.deletedShort, 1);
  assert.equal(report.protectedCount, 2, 'pinned + 高重要度');
  assert.equal(report.evaluated, 3, 'long 不在候选（只处理 short/mid）');
  assert.ok(store.getMemory(longId), 'long 绝不遗忘');
  assert.ok(store.getMemory(pinnedId), 'pinned 受保护');
  assert.ok(store.getMemory(importantId), 'importance ≥ protectImportance 受保护');
  assert.equal(store.getMemory(deletableId), null);
  assert.equal(isForgettingProtected(store.getMemory(pinnedId)!, config), true);
  // 保护开关关闭时 pinned 可被遗忘
  const relaxed = makeEnv({ forgetting: { protectPinned: false } });
  const pinned2 = seed(relaxed.store, { text: '钉住但保护关闭', ageDays: 100, pinned: true, importance: 0.3 });
  await relaxed.engine.run({ now: relaxed.clock.now() });
  assert.equal(relaxed.store.getMemory(pinned2), null);
});

test('forgetting: dryRun 只统计不写库（记忆/统计/审计都不变）', async () => {
  const { store, engine, clock } = makeEnv();
  const shortId = seed(store, { text: '到期短期记忆', ageDays: 10 });
  const midId = seed(store, { text: '到期中期记忆', tier: 'mid', ageDays: 100 });
  const dry = await engine.run({ now: clock.now(), dryRun: true });
  assert.equal(dry.deletedShort, 1);
  assert.equal(dry.archivedMid, 1);
  assert.ok(store.getMemory(shortId), 'dryRun 不删除');
  assert.equal(store.getMemory(midId)?.status ?? 'active', 'active', 'dryRun 不归档');
  const stats = await engine.stats();
  assert.equal(stats.shortDeleted, 0);
  assert.equal(stats.midArchived, 0);
  assert.equal(stats.lastForgetAt, null);
  assert.equal(engine.lastForgetAt(), null);
});

test('forgetting: 幂等（二次运行零删除/零归档）与 limit 限制', async () => {
  const { store, engine, clock } = makeEnv();
  seed(store, { text: '到期一', ageDays: 10 });
  seed(store, { text: '到期二', ageDays: 10 });
  const first = await engine.run({ now: clock.now(), limit: 1 });
  assert.equal(first.deletedShort, 1);
  const second = await engine.run({ now: clock.now(), limit: 1 });
  assert.equal(second.deletedShort, 1);
  const third = await engine.run({ now: clock.now() });
  assert.equal(third.deletedShort, 0, '已删除的不再计入');
  assert.equal(third.evaluated, 0);
});

test('forgetting: 不触碰 L0 / raw_index / 原始层向量', async () => {
  const { store, engine, clock, embedder } = makeEnv();
  const raw = makeRaw(1, { kind: 'user', role: 'user', text: '原始记录：端口 8080', ts: TEST_NOW - 30 * DAY_MS });
  store.indexRawRecord({
    record: raw,
    location: { ingestKey: 'k1', segment: 'segments/x.jsonl', lineNo: 1, byteOffset: 0, byteLen: 100 },
  });
  store.putRawVector(raw.id, embedder.ref, hashEmbed(raw.text ?? '', 64));
  const derivedId = seed(store, {
    text: '由该原始记录派生的到期记忆',
    ageDays: 10,
  });
  const rawIndexBefore = store.listRawIndex().total;
  const rawVectorStatsBefore = store.rawVectorStats(embedder.ref);
  const report = await engine.run({ now: clock.now() });
  assert.equal(report.deletedShort, 1);
  assert.equal(store.getMemory(derivedId), null);
  assert.equal(store.listRawIndex().total, rawIndexBefore);
  assert.deepEqual(store.rawVectorStats(embedder.ref), rawVectorStatsBefore);
  assert.ok(store.getRawVector(raw.id), '原始层向量只增不减');
});

test('forgetting: 错误隔离（store 抛错时 run 不抛，返回结果）', async () => {
  const { store, engine, clock } = makeEnv();
  seed(store, { text: '到期短期记忆', ageDays: 10 });
  (store as unknown as { forgetDerivedMemories: () => never }).forgetDerivedMemories = () => {
    throw new Error('simulated store failure');
  };
  const report = await engine.run({ now: clock.now() });
  assert.equal(report.deletedShort, 0);
  assert.equal(report.evaluated, 1);
});

test('forgetting: enabled=false → 全部 0；只处理 L1/L2/L3 派生层', async () => {
  const disabled = makeEnv({ forgetting: { enabled: false } });
  seed(disabled.store, { text: '到期记忆', ageDays: 100 });
  const report = await disabled.engine.run({ now: disabled.clock.now() });
  assert.equal(report.evaluated, 0);
  assert.equal(report.deletedShort, 0);
  assert.deepEqual(FORGETTING_LAYERS, ['L1', 'L2', 'L3']);

  const { store, engine, clock } = makeEnv();
  const l2 = seed(store, { text: '到期 L2 情节', layer: 'L2', kind: 'episode', ageDays: 10 });
  const l3 = seed(store, { text: '到期 L3 事实', layer: 'L3', kind: 'fact', ageDays: 10 });
  const report2 = await engine.run({ now: clock.now() });
  assert.equal(report2.deletedShort, 2);
  assert.equal(store.getMemory(l2), null);
  assert.equal(store.getMemory(l3), null);
});

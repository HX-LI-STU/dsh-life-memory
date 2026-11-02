/**
 * 保留期引擎测试（docs/23-memory-models.md §3）：
 * §3.3 分数公式（已知输入/权重边界）、§3.2 晋升阶梯（条件组合/边界/无降级/pinned/autoLongTermKinds）、
 * tick 幂等与统计、setTier 单向性、stats/byTier/lastTickAt、关闭退化。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { MemoryKind, MemoryRecord, RetentionState, RetentionTier } from '../../../src/core/contracts.ts';
import { deriveMemoryId } from '../../../src/core/ids.ts';
import { silentLogger } from '../../../src/core/logger.ts';
import {
  RETENTION_HALF_LIFE_DAYS,
  RETENTION_LAST_TICK_KEY,
  createRetentionEngine,
  evaluateRetention,
  meetsLongTermConditions,
  retentionScore,
  retentionTerms,
} from '../../../src/retention/index.ts';
import { FakeMemoryStore, TEST_NOW, createClock, testConfig } from '../layers/fakes.ts';

const DAY = 86_400_000;

function makeEnv(overrides: Record<string, unknown> = {}) {
  const clock = createClock(TEST_NOW);
  const store = new FakeMemoryStore();
  store.nowValue = clock.now();
  const config = testConfig(overrides);
  const engine = createRetentionEngine({ store, config, logger: silentLogger, now: () => clock.now() });
  return { clock, store, config, engine };
}

interface SeedOptions {
  text: string;
  layer?: string;
  kind?: MemoryKind;
  importance?: number;
  pinned?: boolean;
  createdAt?: number;
  sourceRawIds?: string[];
  accessCount?: number;
  tier?: RetentionTier;
}

let seedCounter = 0;
function seed(store: FakeMemoryStore, options: SeedOptions): MemoryRecord {
  seedCounter += 1;
  const layer = options.layer ?? 'L3';
  const kind = options.kind ?? 'fact';
  const createdAt = options.createdAt ?? TEST_NOW;
  const record = store.upsertMemory({
    id: deriveMemoryId(layer, kind, createdAt, `${options.text}-${seedCounter}`),
    layer,
    kind,
    text: options.text,
    importance: options.importance ?? 0.5,
    confidence: 0.9,
    sourceRawIds: options.sourceRawIds ?? ['2026-10-25-000001'],
    tags: [],
    createdAt,
    ...(options.pinned !== undefined ? { pinned: options.pinned } : {}),
  });
  const stored = store.memories.get(record.id)!;
  stored.accessCount = options.accessCount ?? 0;
  if (options.tier !== undefined) {
    stored.retentionTier = options.tier;
    stored.promotedAt = options.tier === 'short' ? null : createdAt;
    stored.longTermAt = options.tier === 'long' ? createdAt : null;
  }
  return store.getMemory(record.id)!;
}

/** 纯函数测试用记录 */
function pureRecord(overrides: Partial<MemoryRecord> = {}): MemoryRecord {
  return {
    id: 'L3-fact-test-00000001',
    layer: 'L3',
    kind: 'fact',
    text: '测试事实',
    importance: 0.8,
    confidence: 0.9,
    sourceRawIds: ['2026-10-25-000001'],
    tags: [],
    createdAt: TEST_NOW,
    updatedAt: TEST_NOW,
    revision: 1,
    contentHash: 'h',
    retentionTier: 'short',
    retentionScore: 0,
    pinned: false,
    promotedAt: null,
    longTermAt: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// §3.3 分数
// ---------------------------------------------------------------------------

test('retention: §3.3 分数公式精确复算（ageDays→recency / importance / recurrence / frequency）', () => {
  const { config } = makeEnv();
  const fresh = pureRecord(); // age 0
  const terms = retentionTerms(fresh, TEST_NOW);
  assert.equal(terms.ageDays, 0);
  assert.equal(terms.recency, 1);
  assert.ok(Math.abs(terms.recurrence - 0.2) < 1e-12);
  assert.equal(terms.frequency, 0);
  // .35*1 + .30*.8 + .20*.2 + .15*0 = .63
  assert.ok(Math.abs(retentionScore(fresh, config, TEST_NOW) - 0.63) < 1e-9);

  const halfLife = pureRecord({ createdAt: TEST_NOW - RETENTION_HALF_LIFE_DAYS * DAY });
  assert.ok(Math.abs(retentionScore(halfLife, config, TEST_NOW) - (0.35 * 0.5 + 0.3 * 0.8 + 0.2 * 0.2)) < 1e-9);
  const frequencyRecord = pureRecord({ accessCount: 20 });
  assert.equal(retentionTerms(frequencyRecord, TEST_NOW).frequency, 1);
  assert.ok(Math.abs(retentionScore(frequencyRecord, config, TEST_NOW) - 0.78) < 1e-9);
});

test('retention: 权重归一化/零权重/clamp 边界', () => {
  const importanceOnly = testConfig({
    retention: { weights: { recency: 0, importance: 5, recurrence: 0, frequency: 0 } },
  });
  assert.ok(Math.abs(retentionScore(pureRecord(), importanceOnly, TEST_NOW) - 0.8) < 1e-9);
  const zero = testConfig({ retention: { weights: { recency: 0, importance: 0, recurrence: 0, frequency: 0 } } });
  assert.equal(retentionScore(pureRecord(), zero, TEST_NOW), 0);
  const maxed = pureRecord({
    importance: 1,
    accessCount: 20,
    sourceRawIds: ['a', 'b', 'c', 'd', 'e'],
  });
  const score = retentionScore(maxed, makeEnv().config, TEST_NOW);
  assert.ok(score >= 0 && score <= 1 && Math.abs(score - 1) < 1e-9);
});

test('retention: 确定性（同记录 + 同 now → 同分/同状态）', () => {
  const { config } = makeEnv();
  const record = pureRecord({ createdAt: TEST_NOW - 5 * DAY, accessCount: 3 });
  assert.equal(retentionScore(record, config, TEST_NOW), retentionScore(record, config, TEST_NOW));
  assert.deepEqual(evaluateRetention(record, config, TEST_NOW), evaluateRetention(record, config, TEST_NOW));
});

// ---------------------------------------------------------------------------
// §3.2 晋升阶梯
// ---------------------------------------------------------------------------

test('retention: 新记录 short；short→mid 需 age ≥ shortTermDays(7d) 且满足晋升条件', () => {
  const { config } = makeEnv();
  // 年龄不够
  const young = pureRecord({ createdAt: TEST_NOW - 0.5 * DAY, importance: 0.8 });
  assert.equal(evaluateRetention(young, config, TEST_NOW).tier, 'short');
  // 年龄够但条件不足（importance 低 / 未访问 / 单来源 / 非 pinned / 非 autoLongKind）
  const noCondition = pureRecord({
    createdAt: TEST_NOW - 8 * DAY,
    importance: 0.2,
    accessCount: 0,
    sourceRawIds: ['a'],
  });
  assert.equal(evaluateRetention(noCondition, config, TEST_NOW).tier, 'short');
  // 边界：刚好 7 天 + importance ≥ promoteMidMinImportance(0.45) → mid
  const boundary = pureRecord({ createdAt: TEST_NOW - 7 * DAY, importance: 0.5 });
  const promoted = evaluateRetention(boundary, config, TEST_NOW);
  assert.equal(promoted.tier, 'mid');
  assert.equal(promoted.promotedAt, TEST_NOW);
  assert.equal(promoted.longTermAt, null);
  // 差 1 分钟不到 7 天 → 仍 short
  const justUnder = pureRecord({ createdAt: TEST_NOW - 7 * DAY + 60_000, importance: 0.5 });
  assert.equal(evaluateRetention(justUnder, config, TEST_NOW).tier, 'short');
  // 其它晋升条件：被访问过 / 多来源 / pinned / autoLongTermKinds
  assert.equal(
    evaluateRetention(pureRecord({ createdAt: TEST_NOW - 8 * DAY, importance: 0.2, accessCount: 1 }), config, TEST_NOW).tier,
    'mid',
  );
  assert.equal(
    evaluateRetention(pureRecord({ createdAt: TEST_NOW - 8 * DAY, importance: 0.2, sourceRawIds: ['a', 'b'] }), config, TEST_NOW).tier,
    'mid',
  );
});

test('retention: mid→long 需 age ≥ longTermAfterDays(90d) 且满足任一长期条件（重要性）', () => {
  const { config } = makeEnv();
  const base: Partial<MemoryRecord> = {
    retentionTier: 'mid',
    promotedAt: TEST_NOW - 100 * DAY,
    createdAt: TEST_NOW - 100 * DAY,
  };
  const important = pureRecord({ ...base, importance: 0.7, sourceRawIds: ['a'], accessCount: 0 });
  const state = evaluateRetention(important, config, TEST_NOW);
  assert.equal(state.tier, 'long');
  assert.equal(state.longTermAt, TEST_NOW);
  // 年龄不够：即使重要性达标也保持 mid
  const tooYoung = pureRecord({ ...base, createdAt: TEST_NOW - 50 * DAY, importance: 0.9 });
  assert.equal(evaluateRetention(tooYoung, config, TEST_NOW).tier, 'mid');
  // 年龄够但条件都不满足 → 保持 mid
  const mediocre = pureRecord({
    ...base,
    importance: 0.3,
    sourceRawIds: ['a'],
    accessCount: 0,
  });
  assert.equal(evaluateRetention(mediocre, config, TEST_NOW).tier, 'mid');
});

test('retention: mid→long 条件组合（复述数 / 分数 / pinned / autoLongTermKinds）', () => {
  const { config } = makeEnv();
  const base: Partial<MemoryRecord> = {
    retentionTier: 'mid',
    createdAt: TEST_NOW - 100 * DAY,
    importance: 0.3,
  };
  const recurrent = pureRecord({ ...base, sourceRawIds: ['a', 'b'] });
  assert.equal(evaluateRetention(recurrent, config, TEST_NOW).tier, 'long');
  const pinned = pureRecord({ ...base, pinned: true });
  assert.equal(evaluateRetention(pinned, config, TEST_NOW).tier, 'long');
  const profile = pureRecord({ ...base, kind: 'profile' });
  assert.equal(evaluateRetention(profile, config, TEST_NOW).tier, 'long');
  assert.equal(meetsLongTermConditions(pureRecord({ importance: 0.3 }), config, 0), false);
  assert.equal(meetsLongTermConditions(pureRecord({ importance: 0.6 }), config, 0), true);
  // pinnedIsLongTerm=false 时 pinned 不作为长期条件
  const relaxed = makeEnv({ retention: { pinnedIsLongTerm: false } });
  assert.equal(
    meetsLongTermConditions(pureRecord({ pinned: true, importance: 0.3 }), relaxed.config, 0),
    false,
  );
  assert.equal(evaluateRetention(pureRecord({ ...base, pinned: true }), relaxed.config, TEST_NOW).tier, 'mid');
});

test('retention: pinned 直达 long；autoLongTermKinds（新建 profile）直达 long 并自动钉住', () => {
  const { config } = makeEnv();
  const pinned = pureRecord({ pinned: true, createdAt: TEST_NOW });
  const pinnedState = evaluateRetention(pinned, config, TEST_NOW);
  assert.equal(pinnedState.tier, 'long');
  assert.equal(pinnedState.pinned, true);
  const profile = pureRecord({ kind: 'profile', createdAt: TEST_NOW });
  const profileState = evaluateRetention(profile, config, TEST_NOW);
  assert.equal(profileState.tier, 'long');
  assert.equal(profileState.pinned, true);
  // 非新建（已晋升过）的 profile 不再自动钉住
  const oldProfile = pureRecord({ kind: 'profile', retentionTier: 'short', promotedAt: TEST_NOW - DAY });
  assert.equal(evaluateRetention(oldProfile, config, TEST_NOW).tier, 'short');
});

test('retention: 只升不降 —— long 保持、mid 不回落、evaluate 不会返回更低层', () => {
  const { config } = makeEnv();
  const longRecord = pureRecord({ retentionTier: 'long', longTermAt: TEST_NOW - DAY, importance: 0.1 });
  assert.equal(evaluateRetention(longRecord, config, TEST_NOW).tier, 'long');
  const midRecord = pureRecord({ retentionTier: 'mid', importance: 0.1, createdAt: TEST_NOW - 100 * DAY });
  assert.equal(evaluateRetention(midRecord, config, TEST_NOW).tier, 'mid');
});

test('retention: enabled=false → 全部按 short 处理（行为退化）', () => {
  const { config } = makeEnv({ retention: { enabled: false } });
  assert.equal(evaluateRetention(pureRecord({ retentionTier: 'long' }), config, TEST_NOW).tier, 'short');
  assert.equal(evaluateRetention(pureRecord({ pinned: true }), config, TEST_NOW).tier, 'short');
});

// ---------------------------------------------------------------------------
// tick
// ---------------------------------------------------------------------------

test('retention.tick: short→mid 统计、写 lastTickAt、同 now 二次 tick 幂等', async () => {
  const { store, engine, clock } = makeEnv();
  seed(store, { text: '八天前的短期记忆', createdAt: TEST_NOW - 8 * DAY, importance: 0.5 });
  seed(store, { text: '六天前的短期记忆', createdAt: TEST_NOW - 6 * DAY, importance: 0.9 });
  seed(store, { text: '刚创建的短期记忆', createdAt: TEST_NOW, importance: 0.9 });
  const first = await engine.tick({ now: clock.now() });
  assert.equal(first.evaluated, 3);
  assert.equal(first.promotedToMid, 1);
  assert.equal(first.promotedToLong, 0);
  assert.equal(engine.lastTickAt(), clock.now());
  assert.equal(store.getRetentionMeta(RETENTION_LAST_TICK_KEY), String(clock.now()));
  const records = store.listMemories({});
  const byText = (text: string) => records.find((memory) => memory.text === text)!;
  assert.equal(byText('八天前的短期记忆').retentionTier, 'mid');
  assert.equal(byText('六天前的短期记忆').retentionTier, 'short', '年龄未到 7 天不晋升');
  assert.equal(byText('刚创建的短期记忆').retentionTier, 'short');

  const batchCalls = store.retentionBatchCalls;
  const second = await engine.tick({ now: clock.now() });
  assert.equal(second.promotedToMid, 0);
  assert.equal(second.promotedToLong, 0);
  assert.equal(store.retentionBatchCalls, batchCalls, '同 now 二次 tick 不写库');
});

test('retention.tick: mid→long 晋升统计 + 无降级（逐级晋升）', async () => {
  const { store, engine, clock } = makeEnv();
  seed(store, {
    text: '100 天前的中期记忆',
    createdAt: TEST_NOW - 100 * DAY,
    importance: 0.9,
    tier: 'mid',
  });
  const result = await engine.tick({ now: clock.now() });
  assert.equal(result.promotedToLong, 1);
  const record = store.listMemories({}).find((memory) => memory.text === '100 天前的中期记忆')!;
  assert.equal(record.retentionTier, 'long');
  assert.equal(record.longTermAt, clock.now());
  // 后续 tick 不降级
  const later = await engine.tick({ now: clock.now() + 100 * DAY });
  assert.equal(later.promotedToLong, 0);
  assert.equal(store.listMemories({}).find((memory) => memory.id === record.id)?.retentionTier, 'long');
});

test('retention.tick: dryRun 不写库/不写 lastTickAt；limit 限制评估条数', async () => {
  const { store, engine, clock } = makeEnv();
  seed(store, { text: 'A', createdAt: TEST_NOW - 8 * DAY, importance: 0.5 });
  seed(store, { text: 'B', createdAt: TEST_NOW - 8 * DAY, importance: 0.5 });
  seed(store, { text: 'C', createdAt: TEST_NOW - 8 * DAY, importance: 0.5 });
  const dry = await engine.tick({ now: clock.now(), dryRun: true });
  assert.equal(dry.evaluated, 3);
  assert.equal(dry.promotedToMid, 3);
  assert.equal(engine.lastTickAt(), null);
  assert.equal(store.retentionBatchCalls, 0);
  const limited = await engine.tick({ now: clock.now(), limit: 2 });
  assert.equal(limited.evaluated, 2);
  assert.ok(engine.lastTickAt() !== null);
});

test('retention.tick: 候选读取异常不抛出（降级为空轮）', async () => {
  const { store, config, clock } = makeEnv();
  const engine = createRetentionEngine({ store, config, logger: silentLogger, now: () => clock.now() });
  (store as unknown as { listRetentionCandidates: () => never }).listRetentionCandidates = () => {
    throw new Error('boom');
  };
  const result = await engine.tick({ now: clock.now() });
  assert.equal(result.evaluated, 0);
});

// ---------------------------------------------------------------------------
// stats / byTier / setTier
// ---------------------------------------------------------------------------

test('retention.stats/byTier: 三层统计与按层列出（score 降序）', async () => {
  const { store, engine } = makeEnv();
  seed(store, { text: 'short-1', tier: 'short' });
  seed(store, { text: 'mid-1', tier: 'mid' });
  seed(store, { text: 'mid-2', tier: 'mid' });
  seed(store, { text: 'long-1', tier: 'long' });
  seed(store, { text: 'pinned-1', tier: 'long', pinned: true });
  const stats = await engine.stats();
  assert.equal(stats.short, 1);
  assert.equal(stats.mid, 2);
  assert.equal(stats.long, 2);
  assert.equal(stats.pinned, 1);
  const longs = engine.byTier('long');
  assert.equal(longs.length, 2);
  assert.ok(longs.every((memory) => memory.retentionTier === 'long'));
  assert.equal(engine.byTier('long', { limit: 1 }).length, 1);
});

test('retention.setTier: 显式提升生效；显式降级被忽略（只升不降）；pin/unpin 不降级', () => {
  const { store, engine } = makeEnv();
  const record = seed(store, { text: '显式提升', tier: 'short' });
  const promoted = engine.setTier(record.id, 'long');
  assert.equal(promoted?.tier, 'long');
  assert.equal(store.getRetention(record.id)?.tier, 'long');

  // 降级请求忽略
  const demoted = engine.setTier(record.id, 'short');
  assert.equal(demoted?.tier, 'long');
  assert.equal(store.getRetention(record.id)?.tier, 'long');

  // unpin 不降级
  const unpinned = engine.setTier(record.id, 'short', { pinned: false });
  assert.equal(unpinned?.tier, 'long');
  assert.equal(unpinned?.pinned, false);

  // pin=true → long（pinnedIsLongTerm）
  const fresh = seed(store, { text: '新钉住', tier: 'short' });
  const pinned = engine.setTier(fresh.id, 'short', { pinned: true });
  assert.equal(pinned?.tier, 'long');
  assert.equal(pinned?.pinned, true);
  assert.equal(engine.setTier('missing-id', 'long'), null);
});

test('retention: 分数/状态计算不写库；RETENTION_LAST_TICK_KEY 常量', () => {
  const { store, engine } = makeEnv();
  const record = seed(store, { text: '只读评估', tier: 'short' });
  const before = store.getRetention(record.id);
  const state: RetentionState = engine.evaluate(record, TEST_NOW + 8 * DAY);
  assert.equal(state.tier, 'mid');
  assert.deepEqual(store.getRetention(record.id), before);
  assert.equal(RETENTION_LAST_TICK_KEY, 'retention.lastTickAt');
  assert.equal(RETENTION_HALF_LIFE_DAYS, 14);
});

test('retention.tick: 未晋升记录也刷新 retention_score（±1e-4），二次 tick 零写入', async () => {
  const { store, engine, clock, config } = makeEnv();
  // 刚创建 → 不晋升（short），但分数应从默认 0 刷新为公式值
  const fresh = seed(store, { text: '刚创建的短期记忆', importance: 0.8, createdAt: TEST_NOW });
  // 一条会晋升 mid 的记录：分数也应刷新
  const promoted = seed(store, { text: '八天前的记忆', importance: 0.7, createdAt: TEST_NOW - 8 * DAY });
  const first = await engine.tick({ now: clock.now() });
  assert.equal(first.evaluated, 2);
  assert.equal(first.promotedToMid, 1);

  const freshAfter = store.getMemory(fresh.id)!;
  const promotedAfter = store.getMemory(promoted.id)!;
  const expectedFresh = retentionScore(freshAfter, config, clock.now());
  const expectedPromoted = retentionScore(promotedAfter, config, clock.now());
  assert.equal(freshAfter.retentionTier, 'short');
  assert.ok(Math.abs((freshAfter.retentionScore ?? 0) - expectedFresh) <= 1e-4, `未晋升 score 应刷新：${freshAfter.retentionScore} vs ${expectedFresh}`);
  assert.ok(Math.abs((promotedAfter.retentionScore ?? 0) - expectedPromoted) <= 1e-4);

  // 同 now 二次 tick：分数已是最新 → 零写入
  const batchCalls = store.retentionBatchCalls;
  const second = await engine.tick({ now: clock.now() });
  assert.equal(second.promotedToMid, 0);
  assert.equal(second.promotedToLong, 0);
  assert.equal(store.retentionBatchCalls, batchCalls, '同 now 二次 tick 不写库');
  // 再次确认分数未被回退、层未降级
  assert.equal(store.getMemory(promoted.id)?.retentionTier, 'mid');
  assert.ok(Math.abs((store.getMemory(fresh.id)?.retentionScore ?? 0) - expectedFresh) <= 1e-4);
});


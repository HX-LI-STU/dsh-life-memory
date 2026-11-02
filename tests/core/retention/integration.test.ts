/**
 * 保留期 × 召回/注入集成测试（docs/23-memory-models.md §4）：
 * - recall 默认不限制 retentionTier；`retentionTiers` 过滤；综合分乘 `retentionPrior`；
 * - system prompt 双块：L3 语义画像块 + L1 工作记忆块（当前会话 / 最近 24h / short 保留期兜底）；
 * - 双块共享预算、整条丢弃、缓存签名（L3 集合 + 工作集合）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { NewMemoryRecord, RetentionTier } from '../../../src/core/contracts.ts';
import { deriveMemoryId } from '../../../src/core/ids.ts';
import { silentLogger } from '../../../src/core/logger.ts';
import { estimateTokens } from '../../../src/core/text.ts';
import { PromptSectionBuilder, WORKING_MEMORY_TITLE } from '../../../src/prompt/section.ts';
import {
  combineRecallScore,
  createRecaller,
  retentionPriorFor,
  retentionTierOf,
} from '../../../src/search/recall.ts';
import { FakeMemoryStore, TEST_NOW, createClock, createFakeEmbedder, hashEmbed, testConfig } from '../layers/fakes.ts';

const HOUR = 3_600_000;
const DAY = 86_400_000;

function makeEnv(overrides: Record<string, unknown> = {}) {
  const clock = createClock(TEST_NOW);
  const store = new FakeMemoryStore();
  store.nowValue = clock.now();
  const embedder = createFakeEmbedder(64);
  const config = testConfig(overrides);
  return { clock, store, embedder, config };
}

let seedCounter = 0;
interface SeedOptions {
  text: string;
  tier: RetentionTier;
  layer?: string;
  kind?: string;
  importance?: number;
  sessionId?: string | null;
  updatedAt?: number;
  createdAt?: number;
  score?: number;
  pinned?: boolean;
}

function seed(store: FakeMemoryStore, options: SeedOptions): string {
  seedCounter += 1;
  const layer = options.layer ?? 'L3';
  const kind = options.kind ?? 'fact';
  const createdAt = options.createdAt ?? TEST_NOW;
  const record: NewMemoryRecord = {
    id: deriveMemoryId(layer, kind, createdAt, `ret-${seedCounter}`),
    layer,
    kind: kind as never,
    text: options.text,
    importance: options.importance ?? 0.6,
    confidence: 0.9,
    sourceRawIds: ['2026-10-25-000001'],
    sessionId: options.sessionId ?? 's1',
    tags: [],
    createdAt,
    ...(options.pinned !== undefined ? { pinned: options.pinned } : {}),
  };
  const stored = store.upsertMemory(record, hashEmbed(options.text, 64));
  const memory = store.memories.get(stored.id)!;
  memory.updatedAt = options.updatedAt ?? TEST_NOW;
  memory.retentionTier = options.tier;
  memory.retentionScore = options.score ?? 0;
  return stored.id;
}

// ---------------------------------------------------------------------------
// recall：保留期过滤 + 先验
// ---------------------------------------------------------------------------

test('recall: 默认不限制保留期（short/mid/long 都返回）', async () => {
  const { store, embedder, config, clock } = makeEnv({ recall: { dedupSimilarity: 1 } });
  const short = seed(store, { text: '深色主题 短期记录', tier: 'short' });
  const mid = seed(store, { text: '深色主题 中期记录', tier: 'mid' });
  const long = seed(store, { text: '深色主题 长期记录', tier: 'long' });
  const recaller = createRecaller({ store, embedder, config, logger: silentLogger, now: () => clock.now() });
  const hits = await recaller.recall({ mode: 'implicit', text: '深色主题', limit: 10, trackAccess: false });
  assert.equal(hits.length, 3);
  assert.deepEqual(new Set(hits.map((hit) => hit.memory?.id)), new Set([short, mid, long]));
});

test('recall: retentionTiers 过滤生效', async () => {
  const { store, embedder, config, clock } = makeEnv({ recall: { dedupSimilarity: 1 } });
  seed(store, { text: '深色主题 短期记录', tier: 'short' });
  const mid = seed(store, { text: '深色主题 中期记录', tier: 'mid' });
  const long = seed(store, { text: '深色主题 长期记录', tier: 'long' });
  const recaller = createRecaller({ store, embedder, config, logger: silentLogger, now: () => clock.now() });
  const onlyLong = await recaller.recall({ mode: 'implicit', text: '深色主题', limit: 10, trackAccess: false, retentionTiers: ['long'] });
  assert.deepEqual(onlyLong.map((hit) => hit.memory?.id), [long]);
  const midAndLong = await recaller.recall({ mode: 'implicit',
    text: '深色主题',
    limit: 10,
    trackAccess: false,
    retentionTiers: ['mid', 'long'],
  });
  assert.deepEqual(new Set(midAndLong.map((hit) => hit.memory?.id)), new Set([mid, long]));
});

test('recall: 综合分乘 retentionPrior（short .95 / mid 1 / long 1；可解释）', async () => {
  const { store, embedder, config, clock } = makeEnv({ recall: { dedupSimilarity: 1 } });
  const short = seed(store, { text: '深色主题 短期先验', tier: 'short', importance: 0.8 });
  const mid = seed(store, { text: '深色主题 中期先验', tier: 'mid', importance: 0.8 });
  const recaller = createRecaller({ store, embedder, config, logger: silentLogger, now: () => clock.now() });
  const hits = await recaller.recall({ mode: 'implicit', text: '深色主题', limit: 10, trackAccess: false });
  const shortHit = hits.find((hit) => hit.memory?.id === short)!;
  const midHit = hits.find((hit) => hit.memory?.id === mid)!;
  const expectedShort =
    combineRecallScore(shortHit.memory!, shortHit.components, config) * retentionPriorFor('short', config);
  const expectedMid =
    combineRecallScore(midHit.memory!, midHit.components, config) * retentionPriorFor('mid', config);
  assert.ok(Math.abs(shortHit.score - expectedShort) <= 1e-9);
  assert.ok(Math.abs(midHit.score - expectedMid) <= 1e-9);
  assert.equal(retentionPriorFor('short', config), 0.95);
  assert.equal(retentionPriorFor('mid', config), 1);
  assert.equal(retentionPriorFor('long', config), 1);
  assert.equal(retentionTierOf(shortHit.memory!), 'short');
});

test('recall: retentionTier 缺省视为 short；enabled=false 时无先验', async () => {
  const { store, embedder, config, clock } = makeEnv({ retention: { enabled: false } });
  seed(store, { text: '深色主题 关闭分层', tier: 'long' });
  const recaller = createRecaller({ store, embedder, config, logger: silentLogger, now: () => clock.now() });
  const hits = await recaller.recall({ mode: 'implicit', text: '深色主题', limit: 5, trackAccess: false });
  assert.ok(hits.length >= 1);
  const hit = hits[0];
  assert.ok(Math.abs(hit.score - combineRecallScore(hit.memory!, hit.components, config)) <= 1e-9);
  assert.equal(retentionPriorFor('any' as never, config), 1);
});

// ---------------------------------------------------------------------------
// prompt 双块
// ---------------------------------------------------------------------------

test('prompt: 双块 —— L3 语义画像块 + 当前会话 L1 工作记忆块', async () => {
  const { store, config, clock } = makeEnv();
  seed(store, { text: '用户偏好深色主题', tier: 'mid', layer: 'L3', kind: 'preference', importance: 0.9 });
  seed(store, { text: '项目使用 TypeScript ESM', tier: 'long', layer: 'L3', kind: 'fact', importance: 0.8 });
  seed(store, { text: '本会话：先把登录页改成深色', tier: 'short', layer: 'L1', kind: 'atom', sessionId: 's1' });
  seed(store, { text: '本会话：然后补端口配置', tier: 'short', layer: 'L1', kind: 'atom', sessionId: 's1' });
  seed(store, { text: '别的会话：无关工作记忆', tier: 'short', layer: 'L1', kind: 'atom', sessionId: 's2' });
  const builder = new PromptSectionBuilder({
    config,
    store,
    now: () => clock.now(),
    getSessionId: () => 's1',
  });
  const section = await builder.build();
  assert.ok(section.includes('## 记忆库（dsh-life-memory）'));
  // 块 1：L3 语义画像
  assert.ok(section.includes('### 用户偏好'));
  assert.ok(section.includes('### 项目事实'));
  assert.ok(section.includes('用户偏好深色主题'));
  assert.ok(section.includes('项目使用 TypeScript ESM'));
  // 块 2：当前会话工作记忆
  assert.ok(section.includes(WORKING_MEMORY_TITLE));
  assert.ok(section.includes('本会话：先把登录页改成深色'));
  assert.ok(section.includes('本会话：然后补端口配置'));
  assert.ok(!section.includes('别的会话：无关工作记忆'), '工作记忆只含当前会话');
  // 两个块顺序：语义块在前
  assert.ok(section.indexOf('### 用户偏好') < section.indexOf(WORKING_MEMORY_TITLE));
});

test('prompt: 无 L3 时仍有工作记忆块', async () => {
  const { store, config, clock } = makeEnv();
  seed(store, { text: '只有工作记忆的一条', tier: 'short', layer: 'L1', kind: 'atom', sessionId: 's1' });
  const builder = new PromptSectionBuilder({ config, store, now: () => clock.now(), getSessionId: () => 's1' });
  const section = await builder.build();
  assert.ok(section.includes(WORKING_MEMORY_TITLE));
  assert.ok(section.includes('只有工作记忆的一条'));
  assert.ok(!section.includes('## 记忆库（dsh-life-memory）'));
});

test('prompt: 无 sessionId 时工作记忆不注入（绝不把其它会话内容混进来）', async () => {
  const { store, config, clock } = makeEnv();
  seed(store, {
    text: '最近 24h 的工作记忆',
    tier: 'short',
    layer: 'L1',
    kind: 'atom',
    updatedAt: TEST_NOW - 2 * HOUR,
  });
  seed(store, {
    text: '三天前的短期记录',
    tier: 'short',
    layer: 'L1',
    kind: 'atom',
    updatedAt: TEST_NOW - 3 * DAY,
  });
  const builder = new PromptSectionBuilder({ config, store, now: () => clock.now() });
  const section = await builder.build();
  // v1.0.2：无会话上下文时不再降级到 24h/短期层/全库，直接不注入工作记忆块
  assert.ok(!section.includes(WORKING_MEMORY_TITLE), '无 sessionId 不注入工作记忆块');
  assert.ok(!section.includes('最近 24h 的工作记忆'));
  assert.ok(!section.includes('三天前的短期记录'));

  // 有 sessionId 但该会话无 L1 → 同样不注入（不跨会话兜底）
  const builder2 = new PromptSectionBuilder({ config, store, now: () => clock.now(), getSessionId: () => 's-empty' });
  const section2 = await builder2.build();
  assert.ok(!section2.includes(WORKING_MEMORY_TITLE));
});

test('prompt: 双块共享预算（整条丢弃不截半句）', async () => {
  const { store, config, clock } = makeEnv();
  for (let index = 0; index < 30; index += 1) {
    seed(store, {
      text: `L3 偏好第 ${index} 条：${'深色主题与中文注释'.repeat(5)}`,
      tier: 'long',
      layer: 'L3',
      kind: 'preference',
      importance: 0.9 - index * 0.01,
    });
    seed(store, {
      text: `工作记忆第 ${index} 条：${'登录页与端口配置'.repeat(4)}`,
      tier: 'short',
      layer: 'L1',
      kind: 'atom',
      sessionId: 's1',
      updatedAt: TEST_NOW - index * 1000,
    });
  }
  const builder = new PromptSectionBuilder({ config, store, now: () => clock.now(), getSessionId: () => 's1' });
  const budget = 400;
  const section = await builder.build({ budgetTokens: budget });
  assert.ok(section.length > 0);
  const lines = section.split('\n').filter((line) => line.startsWith('- '));
  assert.ok(lines.length > 0);
  for (const line of lines) {
    assert.ok(line.includes('[mem:'), '注入行必须完整（含引用）');
    assert.ok(line.endsWith(']'), '不得截半句');
  }
  assert.ok(estimateTokens(section) <= budget + 60, `token 预算：${estimateTokens(section)} <= ${budget}+60`);
  // 预算不同 → 输出不同（预算参数进入缓存键）
  const bigger = await builder.build({ budgetTokens: 800 });
  assert.notEqual(bigger, section);
});

test('prompt: 缓存签名 = (L3 集合 + 工作集合 + 会话)；变更后失效', async () => {
  const { store, config, clock } = makeEnv();
  const session = { id: 's1' };
  seed(store, { text: '稳定 L3 画像', tier: 'long', layer: 'L3', kind: 'preference', importance: 0.9 });
  const builder = new PromptSectionBuilder({
    config,
    store,
    now: () => clock.now(),
    getSessionId: () => session.id,
  });
  const first = await builder.build();
  assert.equal(await builder.build(), first);
  // 工作记忆新增 → 签名变化
  seed(store, {
    text: '新的一条工作记忆',
    tier: 'short',
    layer: 'L1',
    kind: 'atom',
    sessionId: 's1',
    updatedAt: TEST_NOW + 1,
  });
  const second = await builder.build();
  assert.ok(second.includes('新的一条工作记忆'));
  assert.notEqual(second, first);
  // 会话切换 → 工作块变化（s2 无记录 → 回退最近 24h，仍包含刚才的 L1）
  session.id = 's3';
  await builder.build();
  // 显式 invalidate 生效
  builder.invalidate();
  assert.equal(await builder.build(), await builder.build());
});

test('recaller.buildPromptSection: 委托双块构建器并支持 getSessionId', async () => {
  const { store, embedder, config, clock } = makeEnv();
  seed(store, { text: '画像事实 A', tier: 'long', layer: 'L3', kind: 'fact' });
  seed(store, { text: '会话工作记忆 B', tier: 'short', layer: 'L1', kind: 'atom', sessionId: 's9' });
  const recaller = createRecaller({
    store,
    embedder,
    config,
    logger: silentLogger,
    now: () => clock.now(),
    getSessionId: () => 's9',
  });
  const section = await recaller.buildPromptSection({ budgetTokens: 800 });
  assert.ok(section.includes('画像事实 A'));
  assert.ok(section.includes('会话工作记忆 B'));
  assert.ok(section.includes(WORKING_MEMORY_TITLE));
  // 关闭注入时返回空串
  const disabled = createRecaller({
    store,
    embedder,
    config: testConfig({ recall: { injectSystemPrompt: false } }),
    logger: silentLogger,
    now: () => clock.now(),
  });
  assert.equal(await disabled.buildPromptSection(), '');
});

// ---------------------------------------------------------------------------
// 真实 store 冒烟（migration 2：retention_* 治理列）
// ---------------------------------------------------------------------------

let realStoreModule: typeof import('../../../src/store/index.ts') | null = null;
let realEmbedModule: typeof import('../../../src/embed/local-hash.ts') | null = null;
try {
  realStoreModule = await import('../../../src/store/index.ts');
  realEmbedModule = await import('../../../src/embed/local-hash.ts');
} catch {
  realStoreModule = null;
  realEmbedModule = null;
}
const skipReal =
  typeof realStoreModule?.openStore !== 'function' || typeof realEmbedModule?.createLocalHashEmbedder !== 'function'
    ? '真实 store/embed 不可用'
    : false;

test('retention × 真实 store：治理列落库、逐 tick 晋升、pinned 直达 long、无降级、召回过滤', { skip: skipReal }, async () => {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { mergeConfig } = await import('../../../src/config.ts');
  const { createRetentionEngine } = await import('../../../src/retention/index.ts');

  const dir = mkdtempSync(join(tmpdir(), 'dsh-mv-retention-'));
  const clock = createClock(TEST_NOW);
  const config = mergeConfig({
    timezone: 'Asia/Shanghai',
    embedding: { provider: 'local', dim: 512, model: 'dsh-local-hash-v1' },
  });
  type RealStore = {
    upsertMemory(record: NewMemoryRecord, embedding?: Float32Array): { id: string };
    getMemory(id: string): (NewMemoryRecord & { retentionTier?: string; retentionScore?: number; pinned?: boolean; longTermAt?: number | null }) | null;
    getRetention(id: string): { tier: string; score: number; pinned: boolean; promotedAt: number | null; longTermAt: number | null } | null;
    listMemories(query?: unknown): Array<NewMemoryRecord & { id: string; retentionTier?: string }>;
    retentionStats(): { short: number; mid: number; long: number; pinned: number; lastTickAt: number | null };
    setRetention?(id: string, state: { tier: string; score: number; pinned: boolean; promotedAt: number | null; longTermAt: number | null }, now?: number): void;
    getRetentionMeta(key: string): string | null;
    touchMemories(ids: string[], now?: number): void;
    close(): void;
  };
  const openStore = realStoreModule!.openStore as unknown as (input: unknown, runtime?: unknown) => RealStore;
  const store = openStore(
    { dataDir: dir, timezone: config.timezone, embedding: config.embedding },
    { logger: silentLogger, now: () => clock.now() },
  );
  try {
    const createLocalHashEmbedder = realEmbedModule!.createLocalHashEmbedder as unknown as (dim?: number) => {
      ref: { model: string; dim: number; version: string };
      embed(texts: string[]): Promise<Float32Array[]>;
    };
    const embedder = createLocalHashEmbedder(512);
    const [oldVector] = await embedder.embed(['40 天前的项目决策记录']);
    const oldRecord = store.upsertMemory(
      {
        layer: 'L3',
        kind: 'decision',
        text: '40 天前的项目决策记录',
        importance: 0.9,
        confidence: 0.9,
        sourceRawIds: ['2026-10-25-000001'],
        tags: [],
        createdAt: TEST_NOW - 100 * DAY,
      },
      oldVector,
    );
    const [freshVector] = await embedder.embed(['刚刚写入的短期事实']);
    const freshRecord = store.upsertMemory(
      {
        layer: 'L3',
        kind: 'fact',
        text: '刚刚写入的短期事实',
        importance: 0.5,
        confidence: 0.8,
        sourceRawIds: ['2026-10-25-000002'],
        tags: [],
        createdAt: TEST_NOW,
      },
      freshVector,
    );
    // 新建默认 short；pinned 只是治理标记，归入 long 由引擎 tick 完成
    assert.equal(store.getRetention(oldRecord.id)?.tier, 'short');
    assert.equal(store.getRetention(freshRecord.id)?.tier, 'short');
    const pinnedRecord = store.upsertMemory({
      layer: 'L3',
      kind: 'profile',
      text: '长期钉住的用户画像',
      importance: 0.9,
      confidence: 0.9,
      sourceRawIds: ['2026-10-25-000003'],
      tags: [],
      createdAt: TEST_NOW,
      pinned: true,
    });
    assert.equal(store.getRetention(pinnedRecord.id)?.tier, 'short');
    assert.equal(store.getRetention(pinnedRecord.id)?.pinned, true);

    const engine = createRetentionEngine({ store: store as never, config, logger: silentLogger, now: () => clock.now() });
    // tick 1：40 天前的记录 short→mid（单步晋升）；pinned 直达 long；刚创建的不动
    const first = await engine.tick({ now: clock.now() });
    assert.equal(first.promotedToMid, 1);
    assert.equal(first.promotedToLong, 1);
    assert.equal(store.getRetention(oldRecord.id)?.tier, 'mid');
    assert.equal(store.getRetention(freshRecord.id)?.tier, 'short');
    assert.equal(store.getRetention(pinnedRecord.id)?.tier, 'long');
    // tick 2：mid→long（年龄/重要性达标）
    const second = await engine.tick({ now: clock.now() });
    assert.equal(second.promotedToLong, 1);
    assert.equal(store.getRetention(oldRecord.id)?.tier, 'long');
    assert.equal(typeof store.getRetention(oldRecord.id)?.longTermAt, 'number');
    assert.equal(engine.lastTickAt(), clock.now());
    assert.equal(store.getRetentionMeta('retention.lastTickAt'), String(clock.now()));
    // 无降级：显式降级请求被 store 单向写入忽略
    const beforeDowngrade = store.getRetention(oldRecord.id)!;
    store.setRetention?.(oldRecord.id, { ...beforeDowngrade, tier: 'short' }, clock.now());
    assert.equal(store.getRetention(oldRecord.id)?.tier, 'long');
    // 治理列不变量：内容/修订不变
    const memoryAfter = store.getMemory(oldRecord.id)!;
    assert.equal(memoryAfter.text, '40 天前的项目决策记录');
    assert.equal(memoryAfter.importance, 0.9);
    // 统计
    const stats = await engine.stats();
    assert.ok(stats.long >= 2);
    assert.ok(stats.short >= 1);
    assert.ok(stats.pinned >= 1);
    assert.ok(engine.byTier('long').some((memory) => memory.id === pinnedRecord.id));

    // 召回：默认覆盖 short/mid/long；retentionTiers 过滤生效
    const recaller = createRecaller({ store: store as never, embedder: embedder as never, config, logger: silentLogger, now: () => clock.now() });
    const allHits = await recaller.recall({ mode: 'implicit', text: '项目决策记录', limit: 5, trackAccess: false });
    assert.ok(allHits.some((hit) => hit.memory?.id === oldRecord.id));
    const shortOnly = await recaller.recall({ mode: 'implicit',
      text: '短期事实',
      limit: 5,
      trackAccess: false,
      retentionTiers: ['mid', 'long'],
    });
    assert.ok(!shortOnly.some((hit) => hit.memory?.id === freshRecord.id));
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * 混合召回测试：§10.3 评分公式、中文 2 字查询、中英混合、layerPrior、保留期先验、
 * 状态/有效期过滤、近重复压制/MMR、空查询兜底、引用与 formatHit、注入块（L3+工作记忆）预算与稳定性。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type {
  MemoryKind,
  MemoryRecord,
  MemoryVaultConfig,
  NewMemoryRecord,
  RecallHit,
} from '../../../src/core/contracts.ts';
import { deriveMemoryId } from '../../../src/core/ids.ts';
import { estimateTokens } from '../../../src/core/text.ts';
import { silentLogger } from '../../../src/core/logger.ts';
import { createFailingEmbedder } from './fakes.ts';
import {
  createRecaller,
  combineRecallScore,
  normalizeLexicalComponent,
  retentionPriorFor,
} from '../../../src/search/recall.ts';
import {
  FakeMemoryStore,
  TEST_NOW,
  createClock,
  createFakeEmbedder,
  hashEmbed,
  testConfig,
} from './fakes.ts';

interface RecallEnv {
  store: FakeMemoryStore;
  clock: ReturnType<typeof createClock>;
  config: MemoryVaultConfig;
  recaller: ReturnType<typeof createRecaller>;
  embedder: ReturnType<typeof createFakeEmbedder>;
}

function createRecallEnv(overrides: Record<string, unknown> = {}, sessionId: string | null = null): RecallEnv {
  const clock = createClock(TEST_NOW);
  const store = new FakeMemoryStore();
  store.nowValue = clock.now();
  const embedder = createFakeEmbedder(64);
  const config = testConfig(overrides);
  const recaller = createRecaller({ store, embedder, config, logger: silentLogger, now: () => clock.now(), getSessionId: () => sessionId });
  return { store, clock, config, recaller, embedder };
}

let seedCounter = 0;
function seed(
  store: FakeMemoryStore,
  options: {
    layer: string;
    kind: MemoryKind;
    text: string;
    importance?: number;
    confidence?: number;
    sessionId?: string | null;
    workspace?: string | null;
    validTo?: number | null;
    status?: 'active' | 'archived';
    vectorText?: string;
    canonicalKey?: string;
    meta?: Record<string, unknown>;
  },
): MemoryRecord {
  seedCounter += 1;
  const rawId = `2026-10-25-${String(seedCounter).padStart(6, '0')}`;
  const record: NewMemoryRecord = {
    id: deriveMemoryId(options.layer, options.kind, TEST_NOW, `seed-${seedCounter}`),
    layer: options.layer,
    kind: options.kind,
    text: options.text,
    importance: options.importance ?? 0.5,
    confidence: options.confidence ?? 0.8,
    sourceRawIds: [rawId],
    sessionId: options.sessionId ?? 's1',
    workspace: options.workspace ?? null,
    tags: [],
    createdAt: TEST_NOW,
    validFrom: TEST_NOW,
    validTo: options.validTo ?? null,
    status: options.status,
    meta: { ...(options.canonicalKey ? { canonicalKey: options.canonicalKey } : {}), ...(options.meta ?? {}) },
  };
  const stored = store.upsertMemory(record, hashEmbed(options.vectorText ?? options.text, 64));
  if (options.status === 'archived') {
    const memory = store.memories.get(stored.id)!;
    memory.status = 'archived';
  }
  return stored;
}

test('recall: 评分公式与 components 满足 docs §10.3（D4 单测断言）', async () => {
  const env = createRecallEnv();
  seed(env.store, { layer: 'L1', kind: 'atom', text: '深色主题的实现细节', importance: 0.4 });
  seed(env.store, { layer: 'L3', kind: 'preference', text: '用户偏好深色主题', importance: 0.8 });
  const hits = await env.recaller.recall({ mode: 'implicit', text: '深色主题', limit: 5 });
  assert.ok(hits.length >= 1);
  const hybrid = env.config.recall.hybrid;
  const weightSum =
    hybrid.vectorWeight + hybrid.lexicalWeight + hybrid.recencyWeight + hybrid.importanceWeight;
  for (const hit of hits) {
    const memory = hit.memory!;
    const components = hit.components;
    for (const key of ['vector', 'lexical', 'recency', 'importance'] as const) {
      assert.ok(components[key] >= 0 && components[key] <= 1, `components.${key} 应在 [0,1]`);
    }
    const expected =
      ((hybrid.vectorWeight * components.vector +
        hybrid.lexicalWeight * components.lexical +
        hybrid.recencyWeight * components.recency +
        hybrid.importanceWeight * components.importance) /
        weightSum) *
      (env.config.recall.layerPrior[memory.layer] ?? 1) *
      retentionPriorFor(memory.retentionTier ?? 'short', env.config);
    assert.ok(Math.abs(hit.score - expected) <= 1e-9, '返回 score 必须等于公式复算值（含保留期先验）');
    assert.ok(
      Math.abs(
        combineRecallScore(memory, components, env.config) * retentionPriorFor(memory.retentionTier ?? 'short', env.config) -
          hit.score,
      ) <= 1e-9,
    );
  }
});

test('recall: 词法分归一化兼容原始 bm25 负分与已归一化两种实现', () => {
  assert.ok(Math.abs(normalizeLexicalComponent(-2) - 2 / 3) < 1e-12);
  assert.ok(Math.abs(normalizeLexicalComponent(0.9) - 0.9) < 1e-12);
  assert.equal(normalizeLexicalComponent(Number.NaN), 0);
});

test('recall: 中文 2 字查询（主题/偏好/端口）必须命中（bigram 影子列）', async () => {
  const env = createRecallEnv();
  seed(env.store, { layer: 'L3', kind: 'preference', text: '用户偏好深色主题', importance: 0.9 });
  seed(env.store, { layer: 'L3', kind: 'fact', text: '服务端口是 8080', importance: 0.6 });
  seed(env.store, { layer: 'L1', kind: 'atom', text: '今天天气不错', importance: 0.3 });

  for (const [query, expectedText] of [
    ['主题', '用户偏好深色主题'],
    ['偏好', '用户偏好深色主题'],
    ['端口', '服务端口是 8080'],
  ] as const) {
    const hits = await env.recaller.recall({ mode: 'implicit', text: query, limit: 5, trackAccess: false });
    assert.ok(hits.length >= 1, `查询 ${query} 应有命中`);
    assert.ok(
      hits.some((hit) => (hit.memory?.text ?? '').includes(expectedText.replace('用户偏好', '偏好'))),
      `查询 ${query} 应命中相关记录`,
    );
    assert.equal(hits[0].memory?.text.includes(query), true, `top1 应包含查询词 ${query}`);
  }
});

test('recall: 中英混合查询（深色 theme）返回中英文相关条目', async () => {
  const env = createRecallEnv();
  seed(env.store, { layer: 'L3', kind: 'preference', text: '用户偏好深色主题', importance: 0.9 });
  seed(env.store, { layer: 'L3', kind: 'preference', text: 'prefers the dark theme', importance: 0.9 });
  seed(env.store, { layer: 'L3', kind: 'fact', text: '部署使用 portable 模式', importance: 0.4 });
  const hits = await env.recaller.recall({ mode: 'implicit', text: '深色 theme', limit: 5, trackAccess: false });
  assert.ok(hits.length >= 2);
  const topTexts = hits.slice(0, 3).map((hit) => hit.memory?.text ?? '');
  assert.ok(topTexts.some((text) => text.includes('深色主题')));
  assert.ok(topTexts.some((text) => text.toLowerCase().includes('dark theme')));
});

test('recall: layerPrior 生效（同内容 L3 分数高于 L1）', async () => {
  const env = createRecallEnv({ recall: { dedupSimilarity: 1 } }); // 关闭近重复压制，观察先验差异
  const sharedText = '向量默认 512 维';
  const l1 = seed(env.store, { layer: 'L1', kind: 'atom', text: sharedText, importance: 0.7 });
  const l3 = seed(env.store, { layer: 'L3', kind: 'decision', text: sharedText, importance: 0.7 });
  const hits = await env.recaller.recall({ mode: 'implicit', text: sharedText, limit: 5, trackAccess: false });
  const l3Hit = hits.find((hit) => hit.memory?.id === l3.id)!;
  const l1Hit = hits.find((hit) => hit.memory?.id === l1.id)!;
  assert.ok(l3Hit && l1Hit);
  assert.ok(l3Hit.score > l1Hit.score);
  assert.ok(Math.abs(l3Hit.score / l1Hit.score - 1 / 0.9) < 1e-9);
});

test('recall: archived / 过期 validTo / L3 私有表 validTo 均被默认排除', async () => {
  const env = createRecallEnv();
  const active = seed(env.store, { layer: 'L3', kind: 'preference', text: '用户偏好深色主题活动' });
  seed(env.store, { layer: 'L3', kind: 'preference', text: '用户偏好深色主题归档', status: 'archived' });
  seed(env.store, { layer: 'L3', kind: 'preference', text: '用户偏好深色主题过期', validTo: TEST_NOW - 1 });
  const staleSemantic = seed(env.store, { layer: 'L3', kind: 'preference', text: '用户偏好深色主题私有表过期' });
  env.store.putL3Semantic({
    memoryId: staleSemantic.id,
    category: 'preference',
    canonicalKey: 'user.pref.x=stale',
    validTo: TEST_NOW - 1,
    supersededBy: null,
  });
  const hits = await env.recaller.recall({ mode: 'implicit', text: '用户偏好深色主题', limit: 10, trackAccess: false });
  assert.ok(hits.every((hit) => hit.memory?.id === active.id));
});

test('recall: 近重复压制（dedupSimilarity）只保留高分', async () => {
  const env = createRecallEnv({ recall: { dedupSimilarity: 0.9 } });
  seed(env.store, { layer: 'L3', kind: 'preference', text: '完全相同的内容主题', importance: 0.9 });
  seed(env.store, { layer: 'L2', kind: 'episode', text: '完全相同的内容主题', importance: 0.9 });
  const hits = await env.recaller.recall({ mode: 'implicit', text: '完全相同的内容主题', limit: 10, trackAccess: false });
  assert.equal(hits.length, 1, '近重复只保留高分（余弦 ≥ 0.9）');
});

test('recall: MMR 去冗余（λ=0.5 时优先多样性）', async () => {
  const env = createRecallEnv({ recall: { dedupSimilarity: 1, mmr: { enabled: true, lambda: 0.5 } } });
  // A/B 同向量但不同层（避免 store 内容去重），C 与它们不同
  const a = seed(env.store, { layer: 'L1', kind: 'atom', text: 'alpha token one', importance: 0.5 });
  const b = seed(env.store, { layer: 'L2', kind: 'episode', text: 'alpha token one', importance: 0.5 });
  const c = seed(env.store, { layer: 'L3', kind: 'fact', text: 'beta different content two', importance: 0.5 });
  const hits = await env.recaller.recall({ mode: 'implicit', text: 'alpha token', limit: 2, trackAccess: false });
  assert.equal(hits.length, 2);
  const ids = hits.map((hit) => hit.memory?.id);
  assert.ok(ids.includes(c.id), 'MMR 应选择多样条目而非近重复条目');
  const nearDuplicateKept = ids.filter((id) => id === a.id || id === b.id);
  assert.equal(nearDuplicateKept.length, 1, '两个近重复条目最多保留一个');
});

test('recall: 空查询退化为 recency+importance（vector/lexical=0）', async () => {
  const env = createRecallEnv({ recall: { dedupSimilarity: 1 } });
  seed(env.store, { layer: 'L3', kind: 'fact', text: '旧的低价值事实', importance: 0.05 });
  env.clock.advance(86_400_000);
  env.store.nowValue = env.clock.now();
  const recent = seed(env.store, { layer: 'L1', kind: 'atom', text: '最近的一条消息', importance: 0.5 });
  const hits = await env.recaller.recall({ mode: 'implicit', text: '   ', limit: 5, trackAccess: false });
  assert.ok(hits.length >= 2);
  for (const hit of hits) {
    assert.equal(hit.components.vector, 0);
    assert.equal(hit.components.lexical, 0);
    assert.ok(hit.components.recency > 0);
  }
  assert.equal(hits[0].memory?.id, recent.id, '空查询应按 recency+importance 排序');
});

test('recall: trackAccess —— 工具检索 touch，只读检索不 touch', async () => {
  const env = createRecallEnv();
  const memory = seed(env.store, { layer: 'L3', kind: 'preference', text: '用户偏好深色主题' });
  await env.recaller.recall({ mode: 'implicit', text: '深色主题', limit: 5, trackAccess: false });
  assert.equal(env.store.memories.get(memory.id)?.accessCount, 0);
  await env.recaller.recall({ mode: 'implicit', text: '深色主题', limit: 5 });
  assert.equal(env.store.memories.get(memory.id)?.accessCount, 1);
  assert.equal(env.store.memories.get(memory.id)?.lastAccessAt, TEST_NOW);
});

test('recall: 过滤条件（layers/kinds/sessionId/workspace/minScore）', async () => {
  const env = createRecallEnv();
  const l3 = seed(env.store, { layer: 'L3', kind: 'preference', text: '深色主题偏好 L3', sessionId: 's1', workspace: 'D:\\ws' });
  seed(env.store, { layer: 'L1', kind: 'atom', text: '深色主题偏好 L1', sessionId: 's1' });
  seed(env.store, { layer: 'L3', kind: 'fact', text: '深色主题偏好别的会话', sessionId: 's2' });

  const onlyL3 = await env.recaller.recall({ mode: 'implicit', text: '深色主题', layers: ['L3'], trackAccess: false });
  assert.ok(onlyL3.every((hit) => hit.layer === 'L3'));
  const onlyKind = await env.recaller.recall({ mode: 'implicit', text: '深色主题', kinds: ['preference'], trackAccess: false });
  assert.ok(onlyKind.every((hit) => hit.memory?.kind === 'preference'));
  const onlySession = await env.recaller.recall({ mode: 'implicit', text: '深色主题', sessionId: 's1', trackAccess: false });
  assert.ok(onlySession.every((hit) => hit.memory?.sessionId === 's1'));
  assert.ok(onlySession.some((hit) => hit.memory?.id === l3.id));
  const onlyWorkspace = await env.recaller.recall({ mode: 'implicit', text: '深色主题', workspace: 'D:\\ws', trackAccess: false });
  assert.ok(onlyWorkspace.every((hit) => hit.memory?.workspace === 'D:\\ws'));
  const highMin = await env.recaller.recall({ mode: 'implicit', text: '深色主题', minScore: 0.99, trackAccess: false });
  assert.equal(highMin.length, 0);
});

test('recall: bm25 量纲退化时词法分用名次归一化兜底（避免 lexical≈0）', async () => {
  const clock = createClock(TEST_NOW);
  const baseStore = new FakeMemoryStore();
  baseStore.nowValue = clock.now();
  // 模拟真实 SQLite FTS5 在小语料上的 bm25 量纲（~1e-6，docs 公式直接算会≈0）
  const tinyLexStore = baseStore as FakeMemoryStore & { searchLexical: FakeMemoryStore['searchLexical'] };
  const originalSearchLexical = baseStore.searchLexical.bind(baseStore);
  tinyLexStore.searchLexical = (query, options) =>
    originalSearchLexical(query, options).map((hit) => ({ ...hit, score: 1e-6 }));
  const config = testConfig();
  const recaller = createRecaller({
    store: tinyLexStore,
    embedder: createFakeEmbedder(64),
    config,
    logger: silentLogger,
    now: () => clock.now(),
  });
  seed(baseStore, { layer: 'L1', kind: 'atom', text: '记住：我偏好深色主题，本地端口用 8080。' });
  const hits = await recaller.recall({ mode: 'implicit', text: '深色主题 端口', limit: 5, trackAccess: false });
  assert.ok(hits.length >= 1);
  assert.ok(hits[0].components.lexical > 0.5, `词法分量应可见，实际 ${hits[0].components.lexical}`);
  // components 仍在 [0,1]，总分为公式复算值（D4）
  assert.ok(hits[0].components.lexical <= 1);
  assert.ok(Math.abs(combineRecallScore(hits[0].memory!, hits[0].components, config) * retentionPriorFor('short', config) - hits[0].score) <= 1e-9);
});

test('recall: 嵌入失败 → 降级为纯词法，不抛错', async () => {
  const store = new FakeMemoryStore();
  store.nowValue = TEST_NOW;
  const config = testConfig();
  const recaller = createRecaller({
    store,
    embedder: createFailingEmbedder(64),
    config,
    logger: silentLogger,
    now: () => TEST_NOW,
  });
  seed(store, { layer: 'L3', kind: 'preference', text: '用户偏好深色主题' });
  const hits = await recaller.recall({ mode: 'implicit', text: '深色主题', limit: 5, trackAccess: false });
  assert.ok(hits.length >= 1);
  assert.equal(hits[0].components.vector, 0);
  assert.ok(hits[0].components.lexical > 0);
});

test('recall: citations 含 memory id + raw ids；formatHit 人读可读（[mem:]/[raw:]）', async () => {
  const env = createRecallEnv();
  const memory = seed(env.store, { layer: 'L3', kind: 'preference', text: '用户偏好深色主题', importance: 0.9 });
  // raw 索引（用于 segment:line 引用）
  env.store.indexRawRecord({
    record: {
      id: memory.sourceRawIds[0],
      day: '2026-10-25',
      seq: 1,
      ts: TEST_NOW,
      iso: new Date(TEST_NOW).toISOString(),
      timezone: 'Asia/Shanghai',
      kind: 'user',
      sessionId: 's1',
      workspace: null,
      turnId: null,
      stepId: null,
      role: 'user',
      text: '用户偏好深色主题',
      payload: {},
      tags: [],
      v: 1,
      hash: '0'.repeat(64),
      prevHash: '0'.repeat(64),
    },
    location: { ingestKey: 'k1', segment: 'segments/2026-10-25/seg-w1-000001.jsonl', lineNo: 7, byteOffset: 0, byteLen: 0 },
  });
  const hits = await env.recaller.recall({ mode: 'implicit', text: '深色主题', limit: 5, trackAccess: false });
  const hit = hits[0];
  assert.deepEqual(hit.citations, [memory.id, memory.sourceRawIds[0]]);
  const text = env.recaller.formatHit(hit);
  assert.ok(text.includes(`[mem:${memory.id}]`));
  assert.ok(text.includes(`[raw:${memory.sourceRawIds[0]}@segments/2026-10-25/seg-w1-000001.jsonl:7]`));
  assert.ok(text.includes('用户偏好深色主题'));
  assert.ok(text.includes('score='));
});

test('recall: buildPromptSection —— 双块（L3 语义画像 + L1 工作记忆）、预算内、可缓存', async () => {
  const env = createRecallEnv({ recall: { dedupSimilarity: 1 } }, 's1');
  seed(env.store, { layer: 'L3', kind: 'preference', text: '用户偏好深色主题', importance: 0.9 });
  seed(env.store, { layer: 'L3', kind: 'fact', text: '项目使用 TypeScript ESM', importance: 0.7 });
  seed(env.store, { layer: 'L3', kind: 'decision', text: 'L3 不做物理删除，用 valid_to 表示失效', importance: 0.85 });
  seed(env.store, { layer: 'L3', kind: 'profile', text: '用户是中文母语者', importance: 0.8 });
  seed(env.store, { layer: 'L1', kind: 'atom', text: '本会话的工作记忆：登录页改深色', importance: 0.9, sessionId: 's1' });

  const section = await env.recaller.buildPromptSection({ budgetTokens: 800 });
  assert.ok(section.startsWith('## 记忆库（dsh-life-memory）'));
  assert.ok(section.includes('### 用户偏好'));
  assert.ok(section.includes('### 项目事实'));
  assert.ok(section.includes('### 关键决策'));
  assert.ok(section.includes('[mem:L3-preference-'));
  // 工作记忆块：最近的 L1 进入「工作记忆」块（不再混入 L3 语义块）
  assert.ok(section.includes('### 工作记忆'));
  assert.ok(section.includes('本会话的工作记忆：登录页改深色'));
  assert.ok(estimateTokens(section) <= 800 + 60, '预算内（允许尾部说明误差）');
  // 同日重复调用字符串完全一致（可缓存）
  const again = await env.recaller.buildPromptSection({ budgetTokens: 800 });
  assert.equal(section, again);
  // 小预算：不超预算
  const small = await env.recaller.buildPromptSection({ budgetTokens: 300 });
  assert.ok(estimateTokens(small) <= 300 + 60);
});

test('recall: buildPromptSection —— 关闭 injectSystemPrompt 时返回空串', async () => {
  const env = createRecallEnv({ recall: { injectSystemPrompt: false } });
  seed(env.store, { layer: 'L3', kind: 'preference', text: '用户偏好深色主题' });
  assert.equal(await env.recaller.buildPromptSection(), '');
});

test('recall: recall.enabled=false → 空结果', async () => {
  const env = createRecallEnv({ recall: { enabled: false } });
  seed(env.store, { layer: 'L3', kind: 'preference', text: '用户偏好深色主题' });
  assert.deepEqual(await env.recaller.recall({ mode: 'implicit', text: '深色主题' }), []);
});

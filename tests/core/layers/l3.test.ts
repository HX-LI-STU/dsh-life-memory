/**
 * L3 语义层测试：中英文 cue 抽取（§9.2.2）、canonical_key 归一化（§8.4）、
 * SPO、去重/取代链、私有表、显式保存（memory_save）、代际重建。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DeriveContext } from '../../../src/core/contracts.ts';
import { silentLogger } from '../../../src/core/logger.ts';
import {
  extractL3Candidates,
  extractWorkspaceFacts,
  extractCandidatesFromRaw,
  isCandidateSource,
  isNoisyCandidate,
  isFactSentence,
  normalizeObject,
  buildSpo,
  parseCanonicalKey,
  dimensionKeyOf,
  saveExplicitL3,
  deriveL3MemoryId,
  readRebuildGeneration,
  L3_EXTRACTOR_VERSION,
} from '../../../src/layers/l3-semantic.ts';
import { createL1Layer } from '../../../src/layers/l1-episode.ts';
import { createL2Layer } from '../../../src/layers/l2-summary.ts';
import { createL3Layer } from '../../../src/layers/l3-semantic.ts';
import { createClock, createHarness, createFakeEmbedder, FakeMemoryStore, makeRaw, testConfig, TEST_NOW } from './fakes.ts';

/** 构造最小 DeriveContext（saveExplicit 单测用） */
function makeCtx(store: FakeMemoryStore, now: () => number): DeriveContext {
  return {
    store,
    embedder: createFakeEmbedder(64),
    config: testConfig(),
    logger: silentLogger,
    readRaw: async () => [],
    listLayerMemories: (layer, query = {}) => store.listMemories({ ...query, layers: [layer] }),
    now,
  };
}

test('L3: 中文偏好抽取（以后都用…）→ user.pref.theme=…', () => {
  const candidates = extractL3Candidates('以后都用深色主题');
  assert.equal(candidates.length, 1);
  const candidate = candidates[0];
  assert.equal(candidate.kind, 'preference');
  assert.equal(candidate.category, 'preference');
  assert.equal(candidate.canonicalKey, 'user.pref.theme=深色主题');
  assert.equal(candidate.subject, 'user');
  assert.equal(candidate.predicate, 'pref.theme');
  assert.equal(candidate.object, '深色主题');
  assert.equal(candidate.quote, '深色主题');
  assert.equal(candidate.confidence, 0.75);
  assert.equal(candidate.importance, 0.7);
  assert.equal(candidate.extractedBy, `rule:zh-preference@${L3_EXTRACTOR_VERSION}`);
  assert.equal(candidate.text, '用户偏好：深色主题');
});

test('L3: 中文偏好（我喜欢…）与英文偏好（I prefer …）都映射同一维度', () => {
  const zh = extractL3Candidates('我喜欢深色主题')[0];
  assert.equal(zh.canonicalKey, 'user.pref.theme=深色主题');
  const en = extractL3Candidates('I prefer dark theme.')[0];
  assert.equal(en.kind, 'preference');
  assert.equal(en.dimension, 'theme');
  assert.ok(en.canonicalKey.startsWith('user.pref.theme='));
  assert.ok(en.canonicalKey.toLowerCase().includes('dark'));
});

test('L3: 中文决策抽取（决定：向量默认 512 维）→ project.vector.dim=512', () => {
  const candidates = extractL3Candidates('决定：向量默认 512 维');
  assert.equal(candidates.length, 1);
  const candidate = candidates[0];
  assert.equal(candidate.kind, 'decision');
  assert.equal(candidate.canonicalKey, 'project.vector.dim=512');
  assert.equal(candidate.predicate, 'vector.dim');
  assert.equal(candidate.confidence, 0.8);
  assert.equal(candidate.importance, 0.85);
});

test('L3: 英文决策抽取（we decided …）', () => {
  const candidates = extractL3Candidates('We decided to use pnpm as the package manager.');
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].kind, 'decision');
  assert.ok(candidates[0].canonicalKey.startsWith('project.package.manager='));
  assert.ok(candidates[0].quote.startsWith('to use pnpm'));
});

test('L3: 画像抽取（我的名字是 Hanxu → user.profile.name=hanxu，拉丁小写）', () => {
  const candidates = extractL3Candidates('我的名字是 Hanxu');
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].kind, 'profile');
  assert.equal(candidates[0].canonicalKey, 'user.profile.name=hanxu');
  assert.equal(candidates[0].object, 'hanxu');
});

test('L3: 显式记忆（记住：…）→ fact，conf/imp 0.95，extractedBy=rule:remember@<version>', () => {
  const candidates = extractL3Candidates('记住：部署环境是测试环境');
  assert.equal(candidates.length, 1);
  const candidate = candidates[0];
  assert.equal(candidate.kind, 'fact');
  assert.equal(candidate.confidence, 0.95);
  assert.equal(candidate.importance, 0.95);
  assert.equal(candidate.extractedBy, `rule:remember@${L3_EXTRACTOR_VERSION}`);
  assert.ok(candidate.quote.length > 0);
});

test('L3: remember 但非事实句式 / 疑问句 → 不抽（宁缺毋滥）', () => {
  assert.deepEqual(extractL3Candidates('记住：每周五部署到测试环境'), []);
  assert.deepEqual(extractL3Candidates('记住：端口是 8080 吗？'), []);
  assert.equal(isFactSentence('部署环境是测试环境'), true);
  assert.equal(isFactSentence('每周五部署到测试环境'), false);
  assert.equal(isFactSentence('端口是 8080 吗？'), false);
});

test('L3: 单条 raw 最多 3 条候选；多规则命中按顺序截断', () => {
  const candidates = extractL3Candidates(
    '我喜欢深色主题，决定采用 pnpm 包管理，我的名字是 Hanxu，以后都用中文注释，记住端口是 8080',
  );
  assert.ok(candidates.length <= 3);
  assert.ok(candidates.length >= 1);
});

test('L3: meta-workspace 抽取（git remote / package name/version / 路径 / 端口）', () => {
  const text = [
    'git remote add origin https://github.com/example/dsh-life-memory.git',
    '{ "name": "dsh-life-memory", "version": "0.1.0" }',
    'workspace D:\\work\\proj',
    'listening on :3000',
  ].join('\n');
  const facts = extractWorkspaceFacts(text);
  assert.ok(facts.length >= 3);
  const keys = facts.map((fact) => fact.canonicalKey);
  assert.ok(keys.some((key) => key.startsWith('project.git.remote=')));
  assert.ok(keys.some((key) => key.startsWith('project.fact.name=')));
  assert.ok(keys.some((key) => key.startsWith('project.fact.version=')));
  assert.ok(facts.every((fact) => fact.kind === 'fact' && fact.confidence === 0.6 && fact.importance === 0.6));
});

test('L3: canonical normalizeObject —— NFKC/拉丁小写/去尾标点/超长 sha1 压缩/非法字符折叠', () => {
  assert.equal(normalizeObject('  Hanxu  '), 'hanxu');
  assert.equal(normalizeObject('深色主题。'), '深色主题');
  assert.equal(normalizeObject('dark theme!'), 'dark_theme');
  assert.equal(normalizeObject('a/b c'), 'a_b_c');
  assert.equal(normalizeObject(''), 'unknown');
  const long = normalizeObject('这是一个超过二十四个字符的非常长的对象值用于测试哈希压缩逻辑');
  assert.ok(long.length <= 24 + 1 + 8);
  assert.match(long, /_[0-9a-f]{8}$/);
  // 确定性
  assert.equal(long, normalizeObject('这是一个超过二十四个字符的非常长的对象值用于测试哈希压缩逻辑'));
});

test('L3: parseCanonicalKey / dimensionKeyOf / buildSpo 结构', () => {
  assert.deepEqual(parseCanonicalKey('user.pref.theme=dark'), {
    subject: 'user',
    predicate: 'pref.theme',
    object: 'dark',
  });
  assert.equal(parseCanonicalKey('bad-key'), null);
  assert.equal(dimensionKeyOf('project.vector.dim=512'), 'project.vector.dim');
  const spo = buildSpo({ kind: 'preference', segment: '深色主题' });
  assert.equal(spo.canonicalKey, 'user.pref.theme=深色主题');
  const profile = buildSpo({ kind: 'profile', segment: '住在杭州' });
  assert.equal(profile.predicate, 'profile.location');
});

test('L3: 抽取器确定性 + 相同输入相同 canonical（去重基础）', () => {
  const a = extractL3Candidates('以后都用深色主题');
  const b = extractL3Candidates('以后都用深色主题');
  assert.deepEqual(a, b);
  assert.equal(a[0].canonicalKey, b[0].canonicalKey);
});

test('L3: 同 canonical_key 两次陈述 → 只 1 条活跃记录，溯源合并', async () => {
  const harness = createHarness({
    raws: [
      makeRaw(1, { kind: 'user', role: 'user', text: '以后都用深色主题', ts: TEST_NOW + 1000 }),
      makeRaw(2, { kind: 'user', role: 'user', text: '以后都用深色主题', ts: TEST_NOW + 2000 }),
    ],
    layers: [createL1Layer(), createL2Layer(), createL3Layer()],
  });
  harness.clock.set(TEST_NOW + 10_000);
  harness.store.nowValue = harness.clock.now();
  await harness.run({ reason: 'capture' });
  const active = harness.store.listMemories({ layers: ['L3'], onlyValid: true });
  assert.equal(active.length, 1);
  assert.equal(active[0].kind, 'preference');
  assert.equal((active[0].meta as Record<string, unknown>).canonicalKey, 'user.pref.theme=深色主题');
  assert.deepEqual(active[0].sourceRawIds.sort(), ['2026-10-25-000001', '2026-10-25-000002']);
  const row = harness.store.getL3Semantic(active[0].id);
  assert.ok(row);
  assert.equal(row?.category, 'preference');
  assert.equal(row?.sourceKind, 'deterministic');
  assert.equal(row?.extractedBy, `rule:zh-preference@${L3_EXTRACTOR_VERSION}`);
});

test('L3: 同维度值变化 → 取代（旧 valid_to/supersededBy，新 supersedes），不删除历史', async () => {
  const harness = createHarness({
    raws: [makeRaw(1, { kind: 'user', role: 'user', text: '我喜欢浅色主题', ts: TEST_NOW + 1000 })],
    layers: [createL1Layer(), createL2Layer(), createL3Layer()],
  });
  harness.clock.set(TEST_NOW + 10_000);
  harness.store.nowValue = harness.clock.now();
  await harness.run({ reason: 'capture' });
  const oldRecord = harness.store.listMemories({ layers: ['L3'], onlyValid: true })[0];
  assert.equal((oldRecord.meta as Record<string, unknown>).canonicalKey, 'user.pref.theme=浅色主题');

  // 第二条消息把偏好改为深色
  harness.pushRaws(makeRaw(2, { kind: 'user', role: 'user', text: '以后都用深色主题', ts: TEST_NOW + 20_000 }));
  harness.clock.set(TEST_NOW + 30_000);
  harness.store.nowValue = harness.clock.now();
  await harness.run({ reason: 'capture' });

  const all = harness.store.listMemories({ layers: ['L3'] });
  assert.equal(all.length, 2, '旧值保留（不物理删除）');
  const old = harness.store.getMemory(oldRecord.id)!;
  const fresh = all.find((memory) => (memory.meta as Record<string, unknown>).canonicalKey === 'user.pref.theme=深色主题')!;
  assert.ok(fresh, '新值记录存在');
  assert.equal(typeof old.validTo, 'number');
  assert.ok((old.validTo ?? 0) <= harness.clock.now());
  assert.deepEqual(fresh.supersedes, [old.id]);
  assert.equal(old.status, 'active');
  // 私有表：旧行 supersededBy 指向新记录，新行 supersededBy=null
  const oldRow = harness.store.getL3Semantic(old.id);
  const newRow = harness.store.getL3Semantic(fresh.id);
  assert.equal(oldRow?.supersededBy, fresh.id);
  assert.equal(typeof oldRow?.validTo, 'number');
  assert.equal(newRow?.supersededBy, null);
  assert.equal((newRow?.canonicalKey ?? '').startsWith('user.pref.theme='), true);
  // 默认有效视图只剩新值
  const valid = harness.store.listMemories({ layers: ['L3'], onlyValid: true });
  assert.deepEqual(valid.map((memory) => memory.id), [fresh.id]);
});

test('L3: 只有 user 消息 / memory_save note 参与自动抽取（assistant/tool_result/system/tool_call 不抽）', async () => {
  const harness = createHarness({
    raws: [
      makeRaw(1, { kind: 'assistant', text: '用户喜欢深色主题（助手转述）', ts: TEST_NOW + 1000 }),
      makeRaw(2, {
        kind: 'tool_result',
        role: 'tool',
        text: '{"name": "dsh-life-memory", "version": "0.1.0"}\nlistening on :3000\npath D:\\work\\proj',
        ts: TEST_NOW + 2000,
      }),
      makeRaw(3, { kind: 'system', role: 'system', text: '决定：采用 pnpm 包管理', ts: TEST_NOW + 3000 }),
      makeRaw(4, { kind: 'user', role: 'user', text: '以后都用深色主题', ts: TEST_NOW + 4000 }),
      makeRaw(5, { kind: 'tool_call', role: 'assistant', text: '记住：部署环境是测试环境', ts: TEST_NOW + 5000 }),
    ],
    layers: [createL1Layer(), createL2Layer(), createL3Layer()],
  });
  harness.clock.set(TEST_NOW + 10_000);
  harness.store.nowValue = harness.clock.now();
  await harness.run({ reason: 'capture' });
  const l3 = harness.store.listMemories({ layers: ['L3'] });
  assert.equal(l3.length, 1, '工具/助手/系统流水不得产生 L3');
  assert.deepEqual(l3[0].sourceRawIds, ['2026-10-25-000004']);
  const meta = l3[0].meta as Record<string, unknown>;
  assert.deepEqual(
    l3.map((memory) => (memory.meta as Record<string, unknown>).canonicalKey),
    ['user.pref.theme=深色主题'],
  );
  // 包名/版本/端口/路径/系统决策都不得落成长期事实
  const keys = l3.map((memory) => String((memory.meta as Record<string, unknown>).canonicalKey));
  assert.equal(keys.some((key) => /fact\.(name|version|port|workspace)/.test(key)), false);
  assert.equal(meta.sourceKind, 'deterministic');
});

test('L3: 显式 memory_save note 回放 → manual 记录 + 重建仍为 manual（不覆盖人工记录）', async () => {
  const noteRaw = makeRaw(1, {
    kind: 'note',
    role: 'system',
    text: '深色主题',
    tags: ['memory_save', 'kind:preference'],
    payload: {
      source: 'memory_save',
      kind: 'preference',
      text: '深色主题',
      canonicalKey: 'user.pref.theme=dark',
      tags: ['ui'],
    },
  });
  const harness = createHarness({ raws: [noteRaw], layers: [createL1Layer(), createL2Layer(), createL3Layer()] });
  harness.clock.set(TEST_NOW + 10_000);
  harness.store.nowValue = harness.clock.now();
  await harness.run({ reason: 'capture' });
  const active = harness.store.listMemories({ layers: ['L3'], onlyValid: true });
  assert.equal(active.length, 1);
  assert.equal(active[0].kind, 'preference');
  const meta = active[0].meta as Record<string, unknown>;
  assert.equal(meta.sourceKind, 'manual');
  assert.equal(meta.extractedBy, 'memory_save@1');
  assert.equal(meta.canonicalKey, 'user.pref.theme=dark');
  assert.deepEqual(active[0].sourceRawIds, [noteRaw.id]);
  assert.equal(harness.store.getL3Semantic(active[0].id)?.sourceKind, 'manual');

  // 代际重建：L0 note 是显式保存的唯一权威来源，新代仍应还原为 manual（append-only）
  const rebuilt = await harness.registry.rebuild('L3');
  assert.equal(rebuilt.errors.length, 0);
  const all = harness.store.listMemories({ layers: ['L3'] });
  assert.equal(all.length, 2);
  const fresh = all.find((memory) => (memory.status ?? 'active') === 'active')!;
  const freshMeta = fresh.meta as Record<string, unknown>;
  assert.equal(freshMeta.sourceKind, 'manual');
  assert.equal(freshMeta.canonicalKey, 'user.pref.theme=dark');
  assert.equal(harness.store.getL3Semantic(fresh.id)?.sourceKind, 'manual');
});

test('L3: note 回放不覆盖已存在的 manual 记录（importance/来源不被基线覆盖）', async () => {
  const noteRaw = makeRaw(1, {
    kind: 'note',
    role: 'system',
    text: '深色主题',
    payload: {
      source: 'memory_save',
      kind: 'preference',
      text: '深色主题',
      canonicalKey: 'user.pref.theme=dark',
      tags: ['ui'],
    },
  });
  const harness = createHarness({ raws: [noteRaw], layers: [createL1Layer(), createL2Layer(), createL3Layer()] });
  harness.clock.set(TEST_NOW + 2000);
  harness.store.nowValue = harness.clock.now();
  const explicit = await saveExplicitL3(
    {
      text: '深色主题',
      kind: 'preference',
      canonicalKey: 'user.pref.theme=dark',
      sourceRawIds: [noteRaw.id],
      importance: 0.8,
    },
    makeCtx(harness.store, () => harness.clock.now()),
  );
  harness.clock.set(TEST_NOW + 10_000);
  harness.store.nowValue = harness.clock.now();
  await harness.run({ reason: 'capture' });
  const active = harness.store.listMemories({ layers: ['L3'], onlyValid: true });
  assert.equal(active.length, 1);
  assert.equal(active[0].id, explicit.memoryId);
  assert.equal(active[0].importance, 0.8, 'manual 记录的 importance 不能被 note 回放基线覆盖');
  assert.equal((active[0].meta as Record<string, unknown>).sourceKind, 'manual');
  assert.deepEqual(active[0].sourceRawIds, [noteRaw.id]);
});

test('L3: rebuild（代际归档）——旧记录 archived，新代 id 不同，L0 不受影响', async () => {
  const harness = createHarness({
    raws: [makeRaw(1, { kind: 'user', role: 'user', text: '以后都用深色主题', ts: TEST_NOW + 1000 })],
    layers: [createL1Layer(), createL2Layer(), createL3Layer()],
  });
  harness.clock.set(TEST_NOW + 10_000);
  harness.store.nowValue = harness.clock.now();
  await harness.run({ reason: 'capture' });
  const genBefore = readRebuildGeneration({
    store: harness.store,
  } as unknown as DeriveContext);
  assert.equal(genBefore, 0);
  const oldId = harness.store.listMemories({ layers: ['L3'], onlyValid: true })[0].id;

  const result = await harness.registry.rebuild('L3');
  assert.equal(result.errors.length, 0);
  assert.equal(result.archivedOld, 1);
  assert.equal(readRebuildGeneration({ store: harness.store } as unknown as DeriveContext), 1);
  const all = harness.store.listMemories({ layers: ['L3'] });
  assert.equal(all.length, 2);
  const old = harness.store.getMemory(oldId)!;
  assert.equal(old.status, 'archived');
  assert.equal(typeof old.validTo, 'number');
  const active = all.filter((memory) => (memory.status ?? 'active') === 'active');
  assert.equal(active.length, 1);
  assert.notEqual(active[0].id, oldId);
  // 新代 id 携带代际号（base36 段 = generation+1 = 2）
  assert.match(active[0].id, /^L3-preference-2-[0-9a-f]{8}$/);
  assert.equal(active[0].id, deriveL3MemoryId('preference', 'user.pref.theme=深色主题', 1));
});

test('L3: saveExplicit（memory_save）→ 创建/幂等/取代 回执', async () => {
  const store = new FakeMemoryStore();
  const clock = createClock(TEST_NOW);
  store.nowValue = clock.now();
  const ctx = makeCtx(store, () => clock.now());
  clock.set(TEST_NOW + 1000);
  store.nowValue = clock.now();

  const created = await saveExplicitL3(
    {
      text: '用户偏好深色主题',
      kind: 'preference',
      canonicalKey: 'user.pref.theme=dark',
      sourceRawIds: ['2026-10-25-000001'],
      tags: ['ui'],
      confidence: 0.9,
      importance: 0.8,
    },
    ctx,
  );
  assert.equal(created.dedup, 'created');
  assert.equal(created.layer, 'L3');
  assert.match(created.memoryId, /^L3-preference-/);
  assert.equal(created.revision, 1);
  const stored = store.getMemory(created.memoryId)!;
  assert.equal(stored.kind, 'preference');
  assert.equal((stored.meta as Record<string, unknown>).sourceKind, 'manual');
  assert.equal(store.getL3Semantic(created.memoryId)?.sourceKind, 'manual');
  assert.equal(store.getL3Semantic(created.memoryId)?.extractedBy, 'memory_save@1');

  // 完全相同 → 幂等（noop）
  const again = await saveExplicitL3(
    {
      text: '用户偏好深色主题',
      kind: 'preference',
      canonicalKey: 'user.pref.theme=dark',
      sourceRawIds: ['2026-10-25-000001'],
    },
    ctx,
  );
  assert.equal(again.dedup, 'noop');
  assert.equal(again.memoryId, created.memoryId);
  assert.equal(store.countByLayer().L3, 1);

  // 同维度不同值 → 取代
  clock.set(TEST_NOW + 2000);
  store.nowValue = clock.now();
  const superseded = await saveExplicitL3(
    {
      text: '用户偏好浅色主题',
      kind: 'preference',
      canonicalKey: 'user.pref.theme=light',
      sourceRawIds: ['2026-10-25-000002'],
    },
    ctx,
  );
  assert.equal(superseded.dedup, 'superseded');
  assert.deepEqual(superseded.supersededIds, [created.memoryId]);
  const old = store.getMemory(created.memoryId)!;
  assert.equal(typeof old.validTo, 'number');
  assert.equal(store.getL3Semantic(created.memoryId)?.supersededBy, superseded.memoryId);
  const valid = store.listMemories({ layers: ['L3'], onlyValid: true });
  assert.deepEqual(valid.map((memory) => memory.id), [superseded.memoryId]);
});

test('L3: saveExplicit 强制溯源（sourceRawIds 不能为空）', async () => {
  const store = new FakeMemoryStore();
  const ctx = makeCtx(store, () => TEST_NOW);
  await assert.rejects(
    () => saveExplicitL3({ text: '事实 A', kind: 'fact', sourceRawIds: [] }, ctx),
    /sourceRawIds/,
  );
});

test('L3: saveExplicit 显式 supersedes 旧记录 + canonicalKey 未给时由文本生成', async () => {
  const store = new FakeMemoryStore();
  const clock = createClock(TEST_NOW);
  const ctx = makeCtx(store, () => clock.now());
  store.nowValue = clock.now();
  const first = await saveExplicitL3(
    { text: '项目用 TypeScript', kind: 'fact', sourceRawIds: ['2026-10-25-000001'] },
    ctx,
  );
  const firstStored = store.getMemory(first.memoryId)!;
  clock.set(TEST_NOW + 5000);
  store.nowValue = clock.now();
  const second = await saveExplicitL3(
    {
      text: '项目改用 JavaScript',
      kind: 'fact',
      sourceRawIds: ['2026-10-25-000002'],
      supersedes: [first.memoryId],
      canonicalKey: 'project.fact.language=javascript',
    },
    ctx,
  );
  assert.equal(second.dedup, 'superseded');
  assert.deepEqual(second.supersededIds, [first.memoryId]);
  assert.equal(typeof store.getMemory(firstStored.id)!.validTo, 'number');
  // 未给 canonicalKey 时也能生成合法键
  clock.set(TEST_NOW + 9000);
  store.nowValue = clock.now();
  const third = await saveExplicitL3(
    { text: '部署目标是 测试环境', kind: 'fact', sourceRawIds: ['2026-10-25-000003'] },
    ctx,
  );
  const meta = store.getMemory(third.memoryId)!.meta as Record<string, unknown>;
  assert.match(String(meta.canonicalKey), /^project\..+=/);
});

// ---------------------------------------------------------------------------
// v2：来源门禁 + 噪声过滤（工具输出/助手/代码不再污染 L3）
// ---------------------------------------------------------------------------

test('L3: 候选来源门禁 —— 只有用户消息与显式 memory_save note', () => {
  assert.equal(isCandidateSource({ kind: 'user', role: 'user' }), true);
  assert.equal(isCandidateSource({ kind: 'user' }), true);
  assert.equal(isCandidateSource({ kind: 'note', role: 'system', payload: { source: 'memory_save' } }), true);
  for (const kind of ['assistant', 'tool_call', 'tool_result', 'system', 'turn', 'session', 'compaction', 'event']) {
    assert.equal(isCandidateSource({ kind, role: 'system' }), false, `${kind} 不是可信来源`);
  }
  // 普通 note（非 memory_save）不可信；null 安全
  assert.equal(isCandidateSource({ kind: 'note', role: 'system', payload: { source: 'other' } }), false);
  assert.equal(isCandidateSource({ kind: 'note', role: 'system' }), false);
  assert.equal(isCandidateSource(null), false);
});

test('L3: 噪声过滤 —— 代码围栏/代码特征/URL/路径/纯数字/工具标记/长度', () => {
  assert.equal(isNoisyCandidate('```ts\nconst x = 1\n```'), true);
  assert.equal(isNoisyCandidate('const port = 8080'), true);
  assert.equal(isNoisyCandidate('import fs from node:fs'), true);
  assert.equal(isNoisyCandidate('items.map((x) => x.id)'), true);
  assert.equal(isNoisyCandidate('class Foo extends Bar'), true);
  assert.equal(isNoisyCandidate('https://example.com/docs'), true);
  assert.equal(isNoisyCandidate('D:\\work\\proj'), true);
  assert.equal(isNoisyCandidate('/usr/local/bin'), true);
  assert.equal(isNoisyCandidate('8080'), true);
  assert.equal(isNoisyCandidate('[tool_result] 端口是 8080'), true);
  assert.equal(isNoisyCandidate('短句'), true, '候选 <6 字符');
  assert.equal(isNoisyCandidate('长'.repeat(501)), true, '候选 >500 字符');
  // 正常事实/偏好句不受影响
  assert.equal(isNoisyCandidate('用户偏好深色主题'), false);
  assert.equal(isNoisyCandidate('决定：采用 pnpm 包管理'), false);
  assert.equal(isNoisyCandidate('部署环境是测试环境'), false);
});

test('L3: extractCandidatesFromRaw —— 来源与噪声双门禁', () => {
  // 工具输出里的包名/版本/端口/路径：不产生任何 L3（历史污染源）
  assert.deepEqual(
    extractCandidatesFromRaw(
      makeRaw(1, {
        kind: 'tool_result',
        role: 'tool',
        text: '{"name": "dsh-life-memory", "version": "0.1.0"}\nlistening on :3000\npath D:\\work\\proj',
      }),
    ),
    [],
  );
  // 助手消息 / 代码行 / 代码围栏：不抽
  assert.deepEqual(extractCandidatesFromRaw(makeRaw(2, { kind: 'assistant', text: '以后都用深色主题' })), []);
  assert.deepEqual(
    extractCandidatesFromRaw(makeRaw(3, { kind: 'user', role: 'user', text: 'const port = 8080; // 记住端口是 8080' })),
    [],
  );
  assert.deepEqual(
    extractCandidatesFromRaw(makeRaw(4, { kind: 'user', role: 'user', text: '```\n决定：采用 pnpm 包管理\n```' })),
    [],
  );
  // 用户偏好 / 事实 / 决策：产生
  assert.equal(extractCandidatesFromRaw(makeRaw(5, { text: '以后都用深色主题' }))[0]?.kind, 'preference');
  assert.equal(extractCandidatesFromRaw(makeRaw(6, { text: '记住：部署环境是测试环境' }))[0]?.kind, 'fact');
  assert.equal(extractCandidatesFromRaw(makeRaw(7, { text: '决定：采用 pnpm 包管理' }))[0]?.kind, 'decision');
  // 显式 memory_save note：产生（manual 回放）
  const explicit = extractCandidatesFromRaw(
    makeRaw(8, {
      kind: 'note',
      role: 'system',
      text: '深色主题',
      payload: {
        source: 'memory_save',
        kind: 'preference',
        text: '深色主题',
        canonicalKey: 'user.pref.theme=dark',
        tags: ['ui'],
      },
    }),
  );
  assert.equal(explicit.length, 1);
  assert.equal(explicit[0].kind, 'preference');
  assert.equal(explicit[0].explicit, true);
  assert.equal(explicit[0].canonicalKey, 'user.pref.theme=dark');
  assert.equal(explicit[0].extractedBy, 'memory_save@1');
});

test('L3: 用户事实/决策/偏好产生 L3；非事实句式的 remember 不产生', async () => {
  const harness = createHarness({
    raws: [
      makeRaw(1, { kind: 'user', role: 'user', text: '记住：部署环境是测试环境', ts: TEST_NOW + 1000 }),
      makeRaw(2, { kind: 'user', role: 'user', text: '决定：采用 pnpm 包管理', ts: TEST_NOW + 2000 }),
      makeRaw(3, { kind: 'user', role: 'user', text: '以后都用深色主题', ts: TEST_NOW + 3000 }),
      makeRaw(4, { kind: 'user', role: 'user', text: '记住：每周五部署到测试环境', ts: TEST_NOW + 4000 }),
    ],
    layers: [createL1Layer(), createL2Layer(), createL3Layer()],
  });
  harness.clock.set(TEST_NOW + 10_000);
  harness.store.nowValue = harness.clock.now();
  await harness.run({ reason: 'capture' });
  const l3 = harness.store.listMemories({ layers: ['L3'] });
  const kinds = l3.map((memory) => memory.kind).sort();
  assert.deepEqual(kinds, ['decision', 'fact', 'preference']);
  const keys = l3.map((memory) => String((memory.meta as Record<string, unknown>).canonicalKey));
  assert.equal(keys.some((key) => key.includes('每周五')), false, '非事实句式不得落成事实');
});

test('L3: memory_save note 回放遵循派生脱敏（quote/canonical 不含密钥原文）', async () => {
  const secret = 'sk-ant-abcdefghijklmnopqrstuvwxyz012345';
  const harness = createHarness({
    raws: [
      makeRaw(1, {
        kind: 'note',
        role: 'system',
        text: secret,
        payload: { source: 'memory_save', kind: 'fact', text: secret },
      }),
    ],
    config: testConfig({ safety: { redactSecretsInDerived: true } }),
    layers: [createL1Layer(), createL2Layer(), createL3Layer()],
  });
  harness.clock.set(TEST_NOW + 10_000);
  harness.store.nowValue = harness.clock.now();
  await harness.run({ reason: 'capture' });
  const active = harness.store.listMemories({ layers: ['L3'], onlyValid: true });
  assert.equal(active.length, 1);
  const meta = active[0].meta as Record<string, unknown>;
  assert.equal(active[0].text.includes(secret), false, '主文本必须脱敏');
  assert.match(active[0].text, /\[REDACTED:api-key\]/);
  assert.equal(String(meta.quote).includes(secret), false, 'quote 必须脱敏');
  assert.equal(String(meta.canonicalKey).includes(secret), false, 'canonical_key 必须脱敏');
});

/**
 * MemoryRuntime 装配测试：createMemoryRuntime / deriveStats / saveExplicit 回执 /
 * consolidate 便捷入口 / defaultLayers / 可选 LLM 整理钩子（默认关闭）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createMemoryRuntime,
  createLayerRunner,
  createDefaultLayers,
  defaultLayers,
  consolidate,
  consolidateSessionEnd,
  consolidateTimer,
  maybeRunLlmConsolidation,
  BUILTIN_LAYER_IDS,
  type LlmConsolidator,
} from '../../../src/layers/index.ts';
import { silentLogger } from '../../../src/core/logger.ts';
import { createClock, createFakeEmbedder, FakeMemoryStore, makeRaw, makeReadRaw, TEST_NOW, testConfig } from './fakes.ts';

function createRuntimeHarness(raws = [makeRaw(1, { kind: 'user', role: 'user', text: '以后都用深色主题' })]) {
  const clock = createClock(TEST_NOW + 10_000);
  const store = new FakeMemoryStore();
  store.nowValue = clock.now();
  const config = testConfig();
  const runtime = createMemoryRuntime({
    store,
    embedder: createFakeEmbedder(64),
    config,
    logger: silentLogger,
    readRaw: makeReadRaw(raws),
  });
  return { runtime, store, config, clock, raws };
}

test('runtime: createMemoryRuntime 注册 L1/L2/L3 并暴露 layers/deriveStats', () => {
  const { runtime } = createRuntimeHarness();
  assert.deepEqual(runtime.layers.map((layer) => layer.id), ['L1', 'L2', 'L3']);
  assert.deepEqual(BUILTIN_LAYER_IDS, ['L1', 'L2', 'L3']);
  const stats = runtime.deriveStats();
  assert.deepEqual(Object.keys(stats.cursors).sort(), ['L1', 'L2', 'L3']);
  assert.equal(stats.cursors.L1, 0);
  assert.equal(stats.pendingJobs, 0);
  assert.equal(stats.lastDeriveAt, null);
});

test('runtime: runDerivation 增量派生 + 更新 lastDeriveAt + 水位', async () => {
  const { runtime, store, clock } = createRuntimeHarness();
  const results = await runtime.runDerivation({ raws: [], reason: 'capture', now: clock.now() });
  assert.equal(results.length, 3);
  assert.ok(store.countByLayer().L1 >= 1);
  assert.ok(store.countByLayer().L3 >= 1);
  const stats = runtime.deriveStats();
  assert.equal(stats.lastDeriveAt, clock.now());
  assert.equal(stats.cursors.L1, 1);
  assert.equal(stats.cursors.L3, 1);
});

test('runtime: saveExplicit 回执字段与 SaveExplicitFn 契约一致', async () => {
  const { runtime, store, clock } = createRuntimeHarness([]);
  const result = await runtime.saveExplicit({
    text: '用户偏好深色主题',
    kind: 'preference',
    canonicalKey: 'user.pref.theme=dark',
    sourceRawIds: ['2026-10-25-000001'],
    tags: ['ui'],
    confidence: 0.9,
    importance: 0.8,
    validFrom: clock.now(),
  });
  assert.equal(result.layer, 'L3');
  assert.equal(result.dedup, 'created');
  assert.equal(result.revision, 1);
  assert.match(result.memoryId, /^L3-preference-/);
  assert.deepEqual(result.supersededIds, undefined);
  const stored = store.getMemory(result.memoryId);
  assert.ok(stored);
  assert.equal(stored?.kind, 'preference');
  assert.deepEqual(stored?.sourceRawIds, ['2026-10-25-000001']);
});

test('runtime: runDerivation 不抛错（缺 readRaw 时优雅降级，逐层返回结果）', async () => {
  const clock = createClock(TEST_NOW);
  const store = new FakeMemoryStore();
  store.nowValue = clock.now();
  const runtime = createMemoryRuntime({
    store,
    embedder: createFakeEmbedder(64),
    config: testConfig(),
    logger: silentLogger,
    // 不传 readRaw：L1 无法从 L0 补齐 → 本次无候选（不应抛错）
  });
  const results = await runtime.runDerivation({ raws: [], reason: 'capture', now: clock.now() });
  assert.equal(results.length, 3);
  assert.ok(results.every((result) => Array.isArray(result.errors)));
  assert.ok(results.every((result) => result.written === 0));
});

test('consolidate: 便捷入口按 reason 触发（timer/session_end）', async () => {
  const { runtime, store, raws } = createRuntimeHarness();
  // 先 capture 派生 L1
  await runtime.runDerivation({ raws: [], reason: 'capture', now: TEST_NOW });
  const timerResults = await consolidate(runtime, { reason: 'timer', now: TEST_NOW + 60_000 });
  assert.equal(timerResults.length, 3);
  raws.push(makeRaw(2, { kind: 'user', role: 'user', text: '决定采用 pnpm', ts: TEST_NOW + 120_000 }));
  const endResults = await consolidateSessionEnd(runtime, 's1', TEST_NOW + 180_000);
  assert.equal(endResults.length, 3);
  assert.ok(store.countByLayer().L2 >= 1);
  const manual = await consolidateTimer(runtime, TEST_NOW + 240_000);
  assert.equal(manual.length, 3);
});

test('createLayerRunner / defaultLayers：内置层定义元信息', () => {
  assert.equal(defaultLayers.length, 3);
  assert.deepEqual(createDefaultLayers().map((layer) => layer.id), ['L1', 'L2', 'L3']);
  const store = new FakeMemoryStore();
  const runner = createLayerRunner({
    store,
    embedder: createFakeEmbedder(64),
    config: testConfig(),
    logger: silentLogger,
    readRaw: makeReadRaw([]),
  });
  assert.deepEqual(runner.list().map((layer) => layer.id), ['L1', 'L2', 'L3']);
  assert.deepEqual(runner.list().map((layer) => layer.name), ['L1 工作记忆层', 'L2 情景记忆层', 'L3 语义记忆层']);
  for (const layer of runner.list()) {
    assert.equal(layer.version, 1);
    assert.equal(layer.rebuildableFromRaw, true);
  }
});

test('maybeRunLlmConsolidation：默认关闭（config.consolidation.enabled=false）永不调用', async () => {
  let calls = 0;
  const consolidator: LlmConsolidator = {
    name: 'test',
    async consolidate() {
      calls += 1;
      return [];
    },
  };
  const config = testConfig();
  assert.equal(config.consolidation.enabled, false);
  const records = await maybeRunLlmConsolidation(consolidator, {
    records: [],
    reason: 'timer',
    now: TEST_NOW,
    config,
  });
  assert.deepEqual(records, []);
  assert.equal(calls, 0);
  // 即使 enabled=true 但 allowNetwork=false 也不调用（默认离线）
  const enabledConfig = testConfig({ consolidation: { enabled: true } });
  await maybeRunLlmConsolidation(consolidator, { records: [], reason: 'timer', now: TEST_NOW, config: enabledConfig });
  assert.equal(calls, 0);
});

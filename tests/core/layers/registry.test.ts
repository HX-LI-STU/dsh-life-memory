/**
 * 层运行器（registry）测试：拓扑顺序、增量游标、批上限、错误隔离、重建语义、sidecar 事务。
 *
 * 注意：派生 id 必须匹配 docs/20 §8.1 的形状（层 id 为 L1/L2/L3/L4… 或小写扩展名），
 * 因此自定义测试层统一用 L4/L5/L6。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type {
  DeriveContext,
  DeriveInput,
  LayerDefinition,
  NewMemoryRecord,
  RawRecord,
} from '../../../src/core/contracts.ts';
import type { InternalLayerDefinition, LayerRegistry } from '../../../src/layers/registry.ts';
import { createLayerRegistry } from '../../../src/layers/registry.ts';
import { silentLogger } from '../../../src/core/logger.ts';
import { deriveMemoryId } from '../../../src/core/ids.ts';
import {
  FakeMemoryStore,
  TEST_NOW,
  createClock,
  createFailingEmbedder,
  createFakeEmbedder,
  makeRaw,
  makeReadRaw,
  testConfig,
} from './fakes.ts';

/** 测试用最小层：对每条 raw 生成一条 custom 记忆 */
function rawLayer(
  id: string,
  dependsOn: string[] = [],
  extra: Partial<InternalLayerDefinition> = {},
): InternalLayerDefinition {
  return {
    id,
    name: `${id} 测试层`,
    version: 1,
    dependsOn,
    rebuildableFromRaw: true,
    enabled: (config) => config.layers.enabled.includes(id) || !config.layers.enabled.includes('L1'),
    async derive(input: DeriveInput): Promise<NewMemoryRecord[]> {
      return (input.pendingRaws ?? input.raws).map((raw) => ({
        id: deriveMemoryId(id, 'custom', raw.ts, raw.id),
        layer: id,
        kind: 'custom',
        text: `层 ${id}：${raw.text ?? raw.id}`,
        sourceRawIds: [raw.id],
        sessionId: raw.sessionId,
        workspace: raw.workspace ?? null,
        tags: ['test'],
        createdAt: raw.ts,
        createdSeq: raw.seq,
        meta: { rawId: raw.id },
      }));
    },
    ...extra,
  };
}

function setup(options: {
  raws: RawRecord[];
  config?: ReturnType<typeof testConfig>;
  embedder?: ReturnType<typeof createFakeEmbedder>;
  layers: InternalLayerDefinition[];
}): { store: FakeMemoryStore; registry: LayerRegistry; clock: ReturnType<typeof createClock>; config: ReturnType<typeof testConfig> } {
  const clock = createClock(TEST_NOW);
  const store = new FakeMemoryStore();
  store.nowValue = clock.now();
  const config = options.config ?? testConfig({ layers: { enabled: options.layers.map((layer) => layer.id) } });
  const registry = createLayerRegistry({
    store,
    embedder: options.embedder ?? createFakeEmbedder(64),
    config,
    logger: silentLogger,
    readRaw: makeReadRaw(options.raws),
    now: () => clock.now(),
  });
  for (const layer of options.layers) registry.register(layer);
  return { store, registry, clock, config };
}

const RAWS = [1, 2, 3, 4, 5].map((seq) => makeRaw(seq, { text: `消息 ${seq}` }));

test('registry: register/list 按 dependsOn 拓扑排序（与注册顺序无关）', () => {
  const { registry } = setup({ raws: RAWS, layers: [] });
  registry.register(rawLayer('L6', ['L5']));
  registry.register(rawLayer('L4'));
  registry.register(rawLayer('L5', ['L4']));
  assert.deepEqual(
    registry.list().map((layer) => layer.id),
    ['L4', 'L5', 'L6'],
  );
  assert.equal(registry.get('L4')?.name, 'L4 测试层');
  assert.equal(registry.get('missing'), undefined);
});

test('registry: 增量派生只处理水位之后的 raw，并推进到本批最大 seq', async () => {
  const { store, registry } = setup({ raws: RAWS, layers: [rawLayer('L4')] });
  const first = await registry.run({ raws: [], reason: 'capture', now: TEST_NOW });
  assert.equal(first.length, 1);
  assert.equal(first[0].written, 5);
  assert.equal(store.getDeriveCursor('L4'), 5);
  assert.equal(store.countByLayer().L4, 5);

  store.nowValue = TEST_NOW + 10_000;
  const second = await registry.run({ raws: [], reason: 'capture', now: TEST_NOW + 10_000 });
  assert.equal(second[0].written, 0);
  assert.equal(store.countByLayer().L4, 5);
});

test('registry: 单批上限 layers.maxBatchRaws（分多次推进水位）', async () => {
  const config = testConfig({ layers: { enabled: ['L5'], maxBatchRaws: 2 } });
  const { store, registry } = setup({ raws: RAWS, layers: [rawLayer('L5')], config });
  const seen: number[] = [];
  const probe: InternalLayerDefinition = {
    ...rawLayer('L6'),
    async derive(input: DeriveInput) {
      seen.push((input.pendingRaws ?? input.raws).length);
      return [];
    },
  };
  registry.register(probe);
  await registry.run({ raws: [], reason: 'capture', now: TEST_NOW }, ['L6']);
  await registry.run({ raws: [], reason: 'capture', now: TEST_NOW }, ['L6']);
  await registry.run({ raws: [], reason: 'capture', now: TEST_NOW }, ['L6']);
  await registry.run({ raws: [], reason: 'capture', now: TEST_NOW }, ['L6']);
  assert.deepEqual(seen, [2, 2, 1, 0]);
  assert.equal(store.getDeriveCursor('L6'), 5);
});

test('registry: 每层独立游标；显式 layers 子集只跑该层（自动补依赖）', async () => {
  const { store, registry } = setup({ raws: RAWS, layers: [rawLayer('L4'), rawLayer('L5', ['L4'])] });
  await registry.run({ raws: [], reason: 'capture', now: TEST_NOW }, ['L5']);
  // L5 依赖 L4 → L4 也应在本次运行
  assert.equal(store.getDeriveCursor('L4'), 5);
  assert.equal(store.getDeriveCursor('L5'), 5);
  assert.equal(store.countByLayer().L4, 5);
  assert.equal(store.countByLayer().L5, 5);
});

test('registry: 幂等（重复运行同批输入不产生重复行）', async () => {
  const layer = rawLayer('L4');
  const { store, registry } = setup({ raws: RAWS, layers: [layer] });
  await registry.run({ raws: [], reason: 'capture', now: TEST_NOW });
  const before = [...store.memories.values()].map((memory) => `${memory.id}:${memory.revision}`).sort();
  // 直接再跑一次同批 raw（模拟崩溃后重放；游标已被 clearLayer 归零）
  store.clearLayer('L4', { now: TEST_NOW });
  const results = await registry.run({ raws: RAWS, reason: 'rebuild', now: TEST_NOW });
  assert.equal(results[0].errors.length, 0);
  const after = [...store.memories.values()].map((memory) => `${memory.id}:${memory.revision}`).sort();
  assert.deepEqual(after, before);
});

test('registry: 嵌入失败仍写记录（向量可后补），errors 记录原因', async () => {
  const { store, registry } = setup({
    raws: [RAWS[0]],
    layers: [rawLayer('L4')],
    embedder: createFailingEmbedder(64),
  });
  const results = await registry.run({ raws: [], reason: 'capture', now: TEST_NOW });
  assert.equal(results[0].written, 1);
  assert.ok(results[0].errors.some((message) => message.includes('embedding')));
  assert.equal(store.countByLayer().L4, 1);
  assert.equal(store.vectors.size, 0);
});

test('registry: 单层抛错被隔离，不向捕获路径抛出；失败层水位不前进', async () => {
  const broken: InternalLayerDefinition = {
    ...rawLayer('L4'),
    async derive(): Promise<NewMemoryRecord[]> {
      throw new Error('抽取器崩溃');
    },
  };
  const good = rawLayer('L5', ['L4']);
  const { store, registry } = setup({
    raws: RAWS,
    layers: [broken, good],
    config: testConfig({ layers: { enabled: ['L4', 'L5'] } }),
  });
  const results = await registry.run({ raws: [], reason: 'capture', now: TEST_NOW });
  const bad = results.find((result) => result.layer === 'L4');
  const goods = results.find((result) => result.layer === 'L5');
  assert.ok(bad && bad.errors.length > 0);
  assert.equal(bad?.written, 0);
  assert.equal(store.getDeriveCursor('L4'), 0);
  assert.equal(goods?.written, 5);
  assert.equal(store.getDeriveCursor('L5'), 5);
});

test('registry: 非法候选被跳过并计数（空文本/缺溯源）', async () => {
  const invalid: InternalLayerDefinition = {
    ...rawLayer('L1'),
    async derive(): Promise<NewMemoryRecord[]> {
      return [
        { layer: 'L1', kind: 'atom', text: '   ', sourceRawIds: ['2026-10-25-000001'] },
        // 故意缺 sourceRawIds（运行时校验应拒绝），绕过类型检查模拟扩展层异常输出
        { layer: 'L1', kind: 'atom', text: '没有溯源' } as unknown as NewMemoryRecord,
      ];
    },
  };
  const { registry } = setup({ raws: RAWS, layers: [invalid], config: testConfig({ layers: { enabled: ['L1'] } }) });
  const results = await registry.run({ raws: [], reason: 'capture', now: TEST_NOW });
  assert.equal(results[0].written, 0);
  assert.equal(results[0].skipped, 2);
  assert.equal(results[0].errors.length, 2);
});

test('registry: rebuild（physical）清空层 + 重放 L0，两次重建结果逐条一致', async () => {
  const { store, registry } = setup({ raws: RAWS, layers: [rawLayer('L4')] });
  await registry.run({ raws: [], reason: 'capture', now: TEST_NOW });
  const snapshot = () =>
    [...store.memories.values()]
      .filter((memory) => memory.layer === 'L4')
      .map((memory) => `${memory.id}|${memory.text}|${memory.sourceRawIds.join(',')}`)
      .sort();
  const before = snapshot();
  const rebuilt1 = await registry.rebuild('L4');
  assert.equal(rebuilt1.written, 5);
  assert.deepEqual(snapshot(), before);
  const rebuilt2 = await registry.rebuild('L4');
  assert.equal(rebuilt2.written, 5);
  assert.deepEqual(snapshot(), before);
  assert.ok(store.clearLayerCalls.every((call) => call.layer === 'L4'));
  assert.equal(store.getDeriveCursor('L4'), 5);
});

test('registry: rebuild 未知层 / 不可重建层抛错', async () => {
  const { registry } = setup({ raws: RAWS, layers: [rawLayer('L4', [], { rebuildableFromRaw: false })] });
  await assert.rejects(() => registry.rebuild('NOPE'), /未知层/);
  await assert.rejects(() => registry.rebuild('L4'), /不可从 L0 重建/);
});

test('registry: rebuild archive（L3 代际）归档旧记录而非删除，并返回 archivedOld', async () => {
  const generationKey = 'l3.rebuildGeneration';
  const archiveLayer: InternalLayerDefinition = {
    ...rawLayer('L3'),
    id: 'L3',
    rebuildStrategy: 'archive',
    onRebuildStart(ctx: DeriveContext) {
      const current = Number.parseInt(ctx.store.getMeta(generationKey) ?? '0', 10) || 0;
      ctx.store.setMeta(generationKey, String(current + 1));
    },
    async derive(input: DeriveInput, ctx: DeriveContext): Promise<NewMemoryRecord[]> {
      const generation = Number.parseInt(ctx.store.getMeta(generationKey) ?? '0', 10) || 0;
      return (input.pendingRaws ?? input.raws).map((raw) => ({
        id: deriveMemoryId('L3', 'fact', generation + 1, raw.id),
        layer: 'L3',
        kind: 'fact',
        text: `代际 ${generation} 事实 ${raw.id}`,
        sourceRawIds: [raw.id],
        tags: [],
        createdAt: raw.ts,
        meta: { canonicalKey: `project.g${generation}.x=${raw.id}` },
      }));
    },
  };
  const { store, registry } = setup({
    raws: RAWS,
    layers: [archiveLayer],
    config: testConfig({ layers: { enabled: ['L3'] } }),
  });
  await registry.run({ raws: [], reason: 'capture', now: TEST_NOW });
  const firstIds = [...store.memories.values()].map((memory) => memory.id).sort();
  assert.equal(firstIds.length, 5);

  const rebuilt = await registry.rebuild('L3');
  assert.equal(rebuilt.archivedOld, 5);
  assert.equal(rebuilt.written, 5);
  const all = [...store.memories.values()];
  const archived = all.filter((memory) => memory.status === 'archived');
  const active = all.filter((memory) => (memory.status ?? 'active') === 'active');
  assert.equal(archived.length, 5, '旧代记录保留（archived，不删除）');
  assert.equal(active.length, 5, '新代记录 active');
  assert.ok(archived.every((memory) => typeof memory.validTo === 'number'));
  assert.ok(active.every((memory) => !firstIds.includes(memory.id)), '新代 id 与旧代不同');
});

test('registry: writeSidecar 在 store.transaction 内调用', async () => {
  let sidecarCalls = 0;
  const layer: InternalLayerDefinition = {
    ...rawLayer('L4'),
    async derive(input: DeriveInput): Promise<NewMemoryRecord[]> {
      return (input.pendingRaws ?? input.raws).map((raw) => ({
        id: deriveMemoryId('L4', 'custom', raw.ts, raw.id),
        layer: 'L4',
        kind: 'custom',
        text: `私有行 ${raw.id}`,
        sourceRawIds: [raw.id],
        createdAt: raw.ts,
      }));
    },
    writeSidecar(ctx: DeriveContext, items): void {
      sidecarCalls += 1;
      assert.ok(ctx.store.transaction !== undefined);
      assert.equal(items.length, 5);
    },
  };
  const { store, registry } = setup({ raws: RAWS, layers: [layer] });
  const results = await registry.run({ raws: [], reason: 'capture', now: TEST_NOW });
  assert.equal(results[0].written, 5);
  assert.equal(sidecarCalls, 1);
  assert.ok(store.transactionCalls >= 1);
});

test('registry: 派生文本脱敏（safety.redactSecretsInDerived=true）', async () => {
  const secretRaw = makeRaw(1, { text: '我的 key 是 sk-abcdefghijklmnopqrstuvwx，请记住' });
  const layer: InternalLayerDefinition = {
    ...rawLayer('L4'),
    async derive(input: DeriveInput): Promise<NewMemoryRecord[]> {
      return (input.pendingRaws ?? input.raws).map((raw) => ({
        id: deriveMemoryId('L4', 'custom', raw.ts, raw.id),
        layer: 'L4',
        kind: 'custom',
        text: raw.text ?? '',
        sourceRawIds: [raw.id],
        createdAt: raw.ts,
      }));
    },
  };
  const { store, registry } = setup({ raws: [secretRaw], layers: [layer] });
  const results = await registry.run({ raws: [], reason: 'capture', now: TEST_NOW });
  assert.equal(results[0].errors.length, 0);
  const stored = [...store.memories.values()][0];
  assert.ok(!stored.text.includes('sk-abcdefghijklmnopqrstuvwx'));
  assert.ok(stored.text.includes('[REDACTED:api-key]'));
  assert.ok(Array.isArray((stored.meta as Record<string, unknown>).redacted));
});

test('registry: register 后重复注册同 id → 覆盖；list() 返回最新定义', () => {
  const { registry } = setup({ raws: [], layers: [] });
  const v1: LayerDefinition = { ...rawLayer('L4'), version: 1 };
  const v2: LayerDefinition = { ...rawLayer('L4'), version: 2, name: 'L4 v2' };
  registry.register(v1);
  registry.register(v2);
  assert.equal(registry.list().length, 1);
  assert.equal(registry.list()[0].version, 2);
});

test('registry: rebuild 时 readRaw 缺省 → errors 记录而不抛出', async () => {
  const store = new FakeMemoryStore();
  const registry = createLayerRegistry({
    store,
    embedder: createFakeEmbedder(64),
    config: testConfig({ layers: { enabled: ['L4'] } }),
    logger: silentLogger,
    now: () => TEST_NOW,
  });
  registry.register(rawLayer('L4'));
  const result = await registry.rebuild('L4');
  assert.ok(result.errors.length > 0);
  assert.match(result.errors[0], /readRaw/);
});

test('registry: 超过单次上限的候选被截断并报错', async () => {
  const many: InternalLayerDefinition = {
    ...rawLayer('L4'),
    async derive(): Promise<NewMemoryRecord[]> {
      const records: NewMemoryRecord[] = [];
      for (let i = 0; i < 3000; i += 1) {
        records.push({ layer: 'L4', kind: 'custom', text: `记录 ${i}`, sourceRawIds: ['2026-10-25-000001'] });
      }
      return records;
    },
  };
  const { registry } = setup({
    raws: [RAWS[0]],
    layers: [many],
    config: testConfig({ layers: { enabled: ['L4'], maxBatchRaws: 10 } }),
  });
  const results = await registry.run({ raws: [], reason: 'capture', now: TEST_NOW });
  assert.ok(results[0].errors.some((message) => message.includes('超过单次上限')));
});

/**
 * 人格 × 召回测试（docs/25-persona.md §4）：
 * - explicit（L0 原始层）按 raw_index.persona_id 过滤（当前人格 + 共享，可关闭共享）；
 * - implicit（三层记忆）按 MemoryRecord.personaId 过滤；
 * - 未传 personaId 时不过滤（v3 行为）；persona.enabled=false 时退化为不过滤。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { NewMemoryRecord, RawAppendItem, RawRecord } from '../../../src/core/contracts.ts';
import { deriveMemoryId } from '../../../src/core/ids.ts';
import { silentLogger } from '../../../src/core/logger.ts';
import { createRecaller } from '../../../src/search/recall.ts';
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
  const recaller = createRecaller({ store, embedder, config, logger: silentLogger, now: () => clock.now() });
  return { clock, store, embedder, config, recaller };
}

function rawItem(record: RawRecord, lineNo: number): RawAppendItem {
  return {
    record,
    location: { ingestKey: `k${lineNo}`, segment: 'segments/x.jsonl', lineNo, byteOffset: 0, byteLen: 100 },
  };
}

/** 写入一条原始记录（可带 personaId）+ 原始层向量 */
function seedRaw(
  env: ReturnType<typeof makeEnv>,
  options: { seq: number; text: string; personaId?: string | null },
): RawRecord {
  const record = makeRaw(options.seq, {
    kind: 'user',
    role: 'user',
    text: options.text,
    ts: TEST_NOW,
    personaId: options.personaId === undefined ? null : options.personaId,
  });
  env.store.indexRawRecord(rawItem(record, options.seq));
  env.store.putRawVector(record.id, env.embedder.ref, hashEmbed(options.text, 64));
  return record;
}

let memoryCounter = 0;
function seedMemory(
  env: ReturnType<typeof makeEnv>,
  options: { text: string; personaId?: string | null; layer?: string; kind?: string },
): string {
  memoryCounter += 1;
  const layer = options.layer ?? 'L3';
  const kind = options.kind ?? 'preference';
  const record: NewMemoryRecord = {
    id: deriveMemoryId(layer, kind, TEST_NOW, `persona-recall-${memoryCounter}`),
    layer,
    kind: kind as never,
    text: options.text,
    importance: 0.8,
    confidence: 0.9,
    sourceRawIds: ['2026-10-25-000001'],
    sessionId: 's1',
    personaId: options.personaId === undefined ? null : options.personaId,
    tags: [],
    createdAt: TEST_NOW,
  };
  return env.store.upsertMemory(record, hashEmbed(options.text, 64)).id;
}

test('explicit：personaId 过滤原始层（当前人格 + 共享），raw.personaId 来自 raw_index', async () => {
  const env = makeEnv();
  const alphaRaw = seedRaw(env, { seq: 1, text: '深色主题 记在 A 人格', personaId: 'alpha' });
  const betaRaw = seedRaw(env, { seq: 2, text: '深色主题 记在 B 人格', personaId: 'beta' });
  const sharedRaw = seedRaw(env, { seq: 3, text: '深色主题 共享记忆', personaId: null });

  const scoped = await env.recaller.recall({ text: '深色主题', personaId: 'alpha', limit: 10 });
  const ids = scoped.map((hit) => hit.raw?.id);
  assert.ok(ids.includes(alphaRaw.id));
  assert.ok(ids.includes(sharedRaw.id), '默认包含共享记忆');
  assert.ok(!ids.includes(betaRaw.id), '其它人格原始记忆不返回');
  const alphaHit = scoped.find((hit) => hit.raw?.id === alphaRaw.id)!;
  assert.equal(alphaHit.raw?.personaId, 'alpha', 'raw 记录携带人格归属（来自索引元数据）');

  const noShared = await env.recaller.recall({
    text: '深色主题',
    personaId: 'alpha',
    includeSharedPersona: false,
    limit: 10,
  });
  assert.deepEqual(noShared.map((hit) => hit.raw?.id), [alphaRaw.id]);

  // null = 仅共享
  const sharedOnly = await env.recaller.recall({ text: '深色主题', personaId: null, limit: 10 });
  assert.deepEqual(sharedOnly.map((hit) => hit.raw?.id), [sharedRaw.id]);
});

test('explicit：未传 personaId 不过滤（全部返回）；persona.enabled=false 也不过滤', async () => {
  const env = makeEnv();
  seedRaw(env, { seq: 1, text: '深色主题 A', personaId: 'alpha' });
  seedRaw(env, { seq: 2, text: '深色主题 B', personaId: 'beta' });
  seedRaw(env, { seq: 3, text: '深色主题 共享', personaId: null });
  const all = await env.recaller.recall({ text: '深色主题', limit: 10 });
  assert.equal(all.length, 3);

  const disabledEnv = makeEnv({ persona: { enabled: false } });
  const alpha = seedRaw(disabledEnv, { seq: 1, text: '深色主题 A', personaId: 'alpha' });
  const beta = seedRaw(disabledEnv, { seq: 2, text: '深色主题 B', personaId: 'beta' });
  const scopedButDisabled = await disabledEnv.recaller.recall({ text: '深色主题', personaId: 'alpha', limit: 10 });
  assert.deepEqual(
    new Set(scopedButDisabled.map((hit) => hit.raw?.id)),
    new Set([alpha.id, beta.id]),
    'persona 功能关闭时忽略过滤',
  );
});

test('implicit：personaId 过滤三层记忆（当前人格 + 共享，可关闭共享）', async () => {
  const env = makeEnv();
  const alphaMemory = seedMemory(env, { text: '深色主题 A 人格语义', personaId: 'alpha' });
  const betaMemory = seedMemory(env, { text: '深色主题 B 人格语义', personaId: 'beta' });
  const sharedMemory = seedMemory(env, { text: '深色主题 共享语义', personaId: null });

  const scoped = await env.recaller.recall({ mode: 'implicit', text: '深色主题', personaId: 'alpha', limit: 10, trackAccess: false });
  const ids = new Set(scoped.map((hit) => hit.memory?.id));
  assert.ok(ids.has(alphaMemory));
  assert.ok(ids.has(sharedMemory));
  assert.ok(!ids.has(betaMemory));

  const noShared = await env.recaller.recall({
    mode: 'implicit',
    text: '深色主题',
    personaId: 'alpha',
    includeSharedPersona: false,
    limit: 10,
    trackAccess: false,
  });
  assert.deepEqual(noShared.map((hit) => hit.memory?.id), [alphaMemory]);

  // 未传 personaId → 全部（v3 行为）
  const all = await env.recaller.recall({ mode: 'implicit', text: '深色主题', limit: 10, trackAccess: false });
  assert.equal(all.length, 3);
});

test('implicit：空查询兜底也遵守人格过滤', async () => {
  const env = makeEnv();
  const alphaMemory = seedMemory(env, { text: 'A 人格最近记忆', personaId: 'alpha' });
  seedMemory(env, { text: 'B 人格最近记忆', personaId: 'beta' });
  const sharedMemory = seedMemory(env, { text: '共享最近记忆', personaId: null });
  const hits = await env.recaller.recall({ mode: 'implicit', text: '   ', personaId: 'alpha', limit: 10, trackAccess: false });
  const ids = new Set(hits.map((hit) => hit.memory?.id));
  assert.ok(ids.has(alphaMemory) && ids.has(sharedMemory));
  assert.equal(ids.size, 2);
});

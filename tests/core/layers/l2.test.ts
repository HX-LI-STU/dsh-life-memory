/**
 * L2 情节层测试：切窗（30min 空闲 / 20 条 / session_end）、抽取式摘要（§9.4）、
 * layer_l2_episodes 私有行、幂等去重、重要度公式、rebuild 可复现。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createL1Layer } from '../../../src/layers/l1-episode.ts';
import {
  createL2Layer,
  buildL2Windows,
  summarizeL2Window,
  computeL2Importance,
  buildL2EpisodeRecord,
  L2_IDLE_MS,
  L2_EXTRACTOR,
} from '../../../src/layers/l2-summary.ts';
import type { MemoryRecord } from '../../../src/core/contracts.ts';
import { createHarness, makeRaw, TEST_NOW } from './fakes.ts';

/** 构造 L1 atom 记忆（直接喂纯函数用） */
function atom(seq: number, text: string, options: { ts?: number; role?: string; turnId?: string } = {}): MemoryRecord {
  const ts = options.ts ?? TEST_NOW + seq * 60_000;
  return {
    id: `L1-atom-${seq.toString(36)}-${String(seq).padStart(8, '0')}`,
    layer: 'L1',
    kind: 'atom',
    text,
    importance: 0.45,
    confidence: 0.95,
    sourceRawIds: [`2026-10-25-${String(seq).padStart(6, '0')}`],
    sessionId: 's1',
    workspace: 'D:\\work\\proj',
    tags: options.role === 'user' ? ['role:user'] : ['role:assistant'],
    createdAt: ts,
    updatedAt: ts,
    revision: 1,
    contentHash: `hash-${seq}`,
    createdSeq: seq,
    meta: { role: options.role ?? 'assistant', turnId: options.turnId ?? `t${seq}` },
  };
}

function userRaws(count: number, startTs = TEST_NOW): ReturnType<typeof makeRaw>[] {
  return Array.from({ length: count }, (_, index) =>
    makeRaw(index + 1, {
      kind: 'user',
      role: 'user',
      text: `第 ${index + 1} 条消息：处理深色主题的细节 ${index + 1}`,
      turnId: `t${Math.floor(index / 2)}`,
      ts: startTs + index * 60_000,
    }),
  );
}

test('L2: 切窗规则 —— 20 条上限', () => {
  const atoms = Array.from({ length: 20 }, (_, index) => atom(index + 1, `消息 ${index + 1}`));
  const windows = buildL2Windows(atoms, { sessionEnded: false, now: TEST_NOW + 20 * 60_000 });
  assert.equal(windows.length, 1);
  assert.equal(windows[0].atoms.length, 20);
  assert.equal(windows[0].short, false);
});

test('L2: 切窗规则 —— 相邻 atom 时间差 > 30 min 切窗，且最短 2 条', () => {
  const atoms = [
    atom(1, 'A', { ts: TEST_NOW }),
    atom(2, 'B', { ts: TEST_NOW + 60_000 }),
    atom(3, 'C', { ts: TEST_NOW + 60 * 60_000 }), // 与 B 间隔 59min → 切窗
    atom(4, 'D', { ts: TEST_NOW + 61 * 60_000 }),
  ];
  const windows = buildL2Windows(atoms, { sessionEnded: true, now: TEST_NOW + 70 * 60_000 });
  assert.deepEqual(
    windows.map((window) => window.atoms.map((item) => item.text)),
    [['A', 'B'], ['C', 'D']],
  );
});

test('L2: 进行中的尾窗不物化；session_end / 空闲 30min / 满 20 条才闭合', () => {
  const atoms = [atom(1, 'A'), atom(2, 'B'), atom(3, 'C')];
  assert.equal(buildL2Windows(atoms, { sessionEnded: false, now: TEST_NOW + 3 * 60_000 }).length, 0);
  assert.equal(buildL2Windows(atoms, { sessionEnded: true, now: TEST_NOW + 3 * 60_000 }).length, 1);
  // 空闲超过 30 min → 闭合
  assert.equal(buildL2Windows(atoms, { sessionEnded: false, now: TEST_NOW + 40 * 60_000 }).length, 1);
});

test('L2: 单条会话在 session_end 生成 short episode；非 session_end 不生成', () => {
  const atoms = [atom(1, '只有一条消息', { role: 'user' })];
  assert.equal(buildL2Windows(atoms, { sessionEnded: false, now: TEST_NOW }).length, 0);
  const windows = buildL2Windows(atoms, { sessionEnded: true, now: TEST_NOW });
  assert.equal(windows.length, 1);
  assert.equal(windows[0].short, true);
});

test('L2: 抽取式摘要模板（day/关键词/用户关注/最后进展），确定性可复现', () => {
  const atoms = [
    atom(1, '我喜欢用深色主题，请默认深色', { role: 'user' }),
    atom(2, '好的，已把主题改为深色', { role: 'assistant' }),
    atom(3, '顺便把端口改成 8080', { role: 'user' }),
  ];
  const summary1 = summarizeL2Window(atoms, { timezone: 'Asia/Shanghai' });
  const summary2 = summarizeL2Window(atoms, { timezone: 'Asia/Shanghai' });
  assert.equal(summary1.text, summary2.text);
  assert.match(summary1.text, /^2025-10-25 会话（proj）：讨论了 .+；用户关注：我喜欢用深色主题，请默认深色；最后进展：顺便把端口改成 8080。$/);
  assert.ok(summary1.keywords.length > 0);
  assert.equal(summary1.workspaceLabel, 'proj');
  // 关键词 Top2 用 '、' 连接作为 topic
  assert.equal(summary1.topic, summary1.keywords.slice(0, 2).join('、'));
});

test('L2: 重要度公式（0.50 + 决策词 + turnCount≥10 + 错误）', () => {
  const plain = [atom(1, '普通讨论', { turnId: 'a' }), atom(2, '普通讨论续', { turnId: 'b' })];
  assert.equal(computeL2Importance(plain), 0.5);
  const decision = [atom(1, '决定采用方案 A', { turnId: 'a' }), atom(2, '结论是继续', { turnId: 'b' })];
  assert.ok(Math.abs(computeL2Importance(decision) - 0.6) < 1e-9);
  const manyTurns = Array.from({ length: 10 }, (_, index) => atom(index + 1, `讨论 ${index}`, { turnId: `t${index}` }));
  assert.ok(Math.abs(computeL2Importance(manyTurns) - 0.6) < 1e-9);
  const withError = [atom(1, '处理失败：端口被占用', { turnId: 'a' }), atom(2, '已修复', { turnId: 'b' })];
  assert.ok(Math.abs(computeL2Importance(withError) - 0.55) < 1e-9);
});

test('L2: episode 记录字段与私有行（pageIds/rawFirst/rawLast/turnCount/topic/heat）', async () => {
  const harness = createHarness({ raws: userRaws(4), layers: [createL1Layer(), createL2Layer()] });
  await harness.run({ reason: 'session_end', sessionId: 's1' });
  const episodes = harness.store.listMemories({ layers: ['L2'] });
  assert.equal(episodes.length, 1);
  const episode = episodes[0];
  assert.equal(episode.kind, 'episode');
  assert.equal(episode.layer, 'L2');
  assert.equal(episode.sessionId, 's1');
  assert.equal(episode.importance, 0.5); // 普通消息 4 条、turnCount=2
  assert.ok(episode.tags.includes('episode'));
  assert.ok(episode.tags.includes(`source:${L2_EXTRACTOR}`));
  assert.ok(episode.tags.includes('session:s1'));
  assert.match(episode.summary ?? '', /^.+、.+$/);
  const meta = episode.meta as Record<string, unknown>;
  assert.equal(meta.atomCount, 4);
  assert.equal(typeof meta.windowKey, 'string');
  assert.ok((meta.windowKey as string).startsWith('s1:'));

  const row = harness.store.l2Rows.get(episode.id);
  assert.ok(row, 'layer_l2_episodes 行应写入');
  assert.equal(row?.sessionId, 's1');
  assert.equal(row?.startTs, TEST_NOW);
  assert.equal(row?.endTs, TEST_NOW + 3 * 60_000);
  assert.equal(row?.turnCount, 2);
  assert.equal(row?.rawFirstId, '2026-10-25-000001');
  assert.equal(row?.rawLastId, '2026-10-25-000004');
  assert.equal(row?.pageIds?.length, 4);
  assert.ok((row?.heat ?? 0) > 0 && (row?.heat ?? 0) <= 1);
  assert.equal(row?.topic, (meta.keywords as string[]).slice(0, 2).join('、'));
});

test('L2: 进行中的会话不产生 episode；session_end 触发后产生', async () => {
  const harness = createHarness({ raws: userRaws(3), layers: [createL1Layer(), createL2Layer()] });
  await harness.run({ reason: 'capture' });
  assert.equal(harness.store.countByLayer().L2 ?? 0, 0);
  const results = await harness.run({ reason: 'session_end', sessionId: 's1' });
  assert.equal(harness.store.countByLayer().L2, 1);
  // session_end 时 L1/L2 都可能处理（L1 无新增），L2 written=1
  const l2 = results.find((result) => result.layer === 'L2');
  assert.equal(l2?.written, 1);
});

test('L2: 定时器触发 idle 窗口闭合（30min）+ 窗口键去重（重复触发不新增）', async () => {
  const harness = createHarness({ raws: userRaws(3), layers: [createL1Layer(), createL2Layer()] });
  await harness.run({ reason: 'capture' });
  harness.clock.advance(L2_IDLE_MS + 10 * 60_000); // 距最后 atom > 30min → 空闲闭合
  const results = await harness.run({ reason: 'timer' });
  assert.equal(harness.store.countByLayer().L2, 1);
  assert.equal(results.find((result) => result.layer === 'L2')?.written, 1);
  // 再次 timer：窗口键已存在 → 幂等跳过
  harness.clock.advance(60_000);
  const second = await harness.run({ reason: 'timer' });
  assert.equal(harness.store.countByLayer().L2, 1);
  assert.equal(second.find((result) => result.layer === 'L2')?.written, 0);
});

test('L2: 会话结束重建 episode；rebuild 两次结果逐字节一致（确定性）', async () => {
  const harness = createHarness({ raws: userRaws(6), layers: [createL1Layer(), createL2Layer()] });
  await harness.run({ reason: 'session_end', sessionId: 's1' });
  const snapshot = () =>
    harness.store
      .listMemories({ layers: ['L2'] })
      .map((memory) => `${memory.id}|${memory.text}|${memory.sourceRawIds.join(',')}`)
      .sort();
  const before = snapshot();
  const first = await harness.registry.rebuild('L2');
  assert.equal(first.written, before.length);
  assert.deepEqual(snapshot(), before);
  const second = await harness.registry.rebuild('L2');
  assert.equal(second.errors.length, 0);
  assert.deepEqual(snapshot(), before);
});

test('L2: 与已有 episode 近重复（3-gram Jaccard≥0.8）时更新原记录而非新建', () => {
  const atoms = [
    atom(1, '讨论深色主题的实现方式与默认值', { role: 'user' }),
    atom(2, '已确认默认深色模式并记录', { role: 'assistant' }),
  ];
  const window = { atoms, startTs: TEST_NOW, endTs: TEST_NOW + 60_000, short: false };
  const probe = buildL2EpisodeRecord('s1', window, { now: TEST_NOW, timezone: 'Asia/Shanghai' });
  const existingId = 'L2-episode-1-aaaaaaaa';
  const updated = buildL2EpisodeRecord('s1', window, {
    now: TEST_NOW,
    timezone: 'Asia/Shanghai',
    existingId,
  });
  assert.equal(updated.id, existingId);
  assert.equal(updated.text, probe.text);
});

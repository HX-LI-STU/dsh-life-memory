/**
 * 真实实现集成测试（可选）：真实 SQLite store + 本地 hash embedder + tmpdir。
 *
 * 依赖 storage-engine-dev 的 `src/store` / `src/embed`；若尚未可用则整组 skip。
 * 覆盖：L1/L2/L3 真实落库、L3 canonical 去重/取代（valid_to + supersededBy）、
 * 召回（citations 指向真实 raw_index）、L1 rebuild 可复现、L3 代际归档不删历史、L0 索引不变。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RawAppendItem, RawRecord } from '../../../src/core/contracts.ts';
import { mergeConfig } from '../../../src/config.ts';
import { silentLogger } from '../../../src/core/logger.ts';
import { createMemoryRuntime } from '../../../src/layers/index.ts';
import type { LayerRebuildResult } from '../../../src/layers/registry.ts';
import { readRebuildGeneration } from '../../../src/layers/l3-semantic.ts';
import { createRecaller } from '../../../src/search/recall.ts';
import { createClock, makeRaw, makeReadRaw, TEST_NOW } from './fakes.ts';

interface RealModules {
  openStore: typeof import('../../../src/store/index.ts').openStore;
  createLocalHashEmbedder: typeof import('../../../src/embed/local-hash.ts').createLocalHashEmbedder;
}

let real: RealModules | null = null;
let skipReason = '';
try {
  const storeModule = await import('../../../src/store/index.ts');
  const embedModule = await import('../../../src/embed/local-hash.ts');
  if (typeof storeModule.openStore === 'function' && typeof embedModule.createLocalHashEmbedder === 'function') {
    real = { openStore: storeModule.openStore, createLocalHashEmbedder: embedModule.createLocalHashEmbedder };
  } else {
    skipReason = 'real store/embed 工厂未导出';
  }
} catch (err) {
  skipReason = `real store/embed 不可用：${err instanceof Error ? err.message : String(err)}`;
}

const skip = real === null ? skipReason || 'real store/embed 不可用' : false;

/** 构造 raw 索引项（真实 store 的 provenance/citation 用） */
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

test('integration: 真实 store/embedder 上的 L1/L2/L3 派生、取代、召回与重建', { skip }, async () => {
  const modules = real!;
  const dir = mkdtempSync(join(tmpdir(), 'dsh-mv-layers-'));
  const clock = createClock(TEST_NOW);
  const config = mergeConfig({ timezone: 'Asia/Shanghai', embedding: { provider: 'local', dim: 512, model: 'dsh-local-hash-v1' } });
  const store = modules.openStore(
    { dataDir: dir, timezone: config.timezone, embedding: config.embedding },
    { logger: silentLogger, now: () => clock.now() },
  );
  try {
    const embedder = modules.createLocalHashEmbedder(512);
    const t0 = TEST_NOW;
    const raws: RawRecord[] = [
      makeRaw(1, { kind: 'user', role: 'user', text: '我喜欢浅色主题', ts: t0 }),
      makeRaw(2, { kind: 'user', role: 'user', text: '以后都用深色主题', ts: t0 + 60_000 }),
      makeRaw(3, { kind: 'assistant', role: 'assistant', text: '已把主题改为深色', ts: t0 + 120_000 }),
      makeRaw(4, { kind: 'user', role: 'user', text: '决定：向量默认 512 维', ts: t0 + 180_000 }),
      makeRaw(5, {
        kind: 'tool_result',
        role: 'tool',
        text: '{"name": "dsh-life-memory", "version": "0.1.0"}',
        tags: ['tool:read'],
        ts: t0 + 240_000,
      }),
    ];
    store.indexRawRecords(raws.map((record, index) => rawItem(record, index + 1)));
    const runtime = createMemoryRuntime({
      store,
      embedder,
      config,
      logger: silentLogger,
      readRaw: makeReadRaw(raws),
    });

    // ① 第一次派生：只给第一轮 raw（浅色偏好）
    clock.set(t0 + 600_000);
    await runtime.runDerivation({ raws: [raws[0]], reason: 'capture', now: clock.now() });
    const light = store
      .listMemories({ layers: ['L3'], onlyValid: true })
      .find((memory) => (memory.meta as Record<string, unknown>).canonicalKey === 'user.pref.theme=浅色主题');
    assert.ok(light, '第一轮应产生浅色主题偏好');

    // ② 第二轮：深色偏好 + 决策 + 工具结果事实 → 同维度不同值应取代旧记录
    clock.set(t0 + 660_000);
    await runtime.runDerivation({ raws: raws.slice(1), reason: 'capture', now: clock.now() });
    const dark = store
      .listMemories({ layers: ['L3'], onlyValid: true })
      .find((memory) => (memory.meta as Record<string, unknown>).canonicalKey === 'user.pref.theme=深色主题');
    assert.ok(dark, '第二轮应产生深色主题偏好');
    const lightAfter = store.getMemory(light!.id)!;
    assert.equal(typeof lightAfter.validTo, 'number', '旧值应写 valid_to');
    assert.ok((lightAfter.validTo ?? 0) <= clock.now());
    assert.deepEqual(dark!.supersedes, [light!.id]);
    const lightRow = store.getL3Semantic(light!.id);
    assert.equal(lightRow?.supersededBy, dark!.id);
    assert.equal(store.getL3Semantic(dark!.id)?.supersededBy, null);
    const decision = store
      .listMemories({ layers: ['L3'], onlyValid: true })
      .find((memory) => memory.kind === 'decision');
    assert.ok(decision, '决策抽取应落库');
    assert.equal(store.countByLayer().L1, 5, '每条 raw 一条 L1 atom');

    // ③ 会话结束 → L2 episode + layer_l2_episodes 行（真实私有表）
    clock.set(t0 + 700_000);
    await runtime.runDerivation({ raws: [], reason: 'session_end', sessionId: 's1', now: clock.now() });
    const episodes = store.listMemories({ layers: ['L2'] });
    assert.equal(episodes.length, 1);
    const episode = episodes[0];
    assert.match(episode.text, /会话（proj）：讨论了 /);
    assert.equal(episode.sourceRawIds.length, 5);
    // L2 私有行通过 DB 确认（契约无 getter，用 SQL 验证）
    const db = store.db as { prepare(sql: string): { get(...params: unknown[]): unknown } };
    const l2Row = db
      .prepare('SELECT memory_id, session_id, start_ts, end_ts, page_ids_json FROM layer_l2_episodes WHERE memory_id = ?')
      .get(episode.id) as { memory_id: string; session_id: string; page_ids_json: string } | undefined;
    assert.ok(l2Row, 'layer_l2_episodes 应有行');
    assert.equal(l2Row?.session_id, 's1');
    assert.equal(JSON.parse(l2Row?.page_ids_json ?? '[]').length, 5);

    // ④ 召回：中文 2 字查询命中；citations 指向真实 raw_index
    const recaller = createRecaller({ store, embedder, config, logger: silentLogger, now: () => clock.now() });
    const hits = await recaller.recall({ mode: 'implicit', text: '深色主题', limit: 5, trackAccess: false });
    assert.ok(hits.length >= 1);
    assert.ok(hits.every((hit) => (hit.memory?.validTo ?? null) === null || (hit.memory?.validTo ?? 0) > clock.now()));
    assert.ok(hits.some((hit) => hit.memory?.id === dark!.id));
    // 中文 2 字查询的词法分量必须可见（真实 store 的 bm25 量纲退化 → recall 名次归一化兜底）
    const topHit = hits[0];
    assert.ok((topHit.components.lexical ?? 0) > 0.01, `词法分量应可见，实际 ${topHit.components.lexical}`);
    for (const hit of hits) {
      const rawIds = hit.memory?.sourceRawIds ?? [];
      assert.ok(rawIds.length > 0);
      for (const rawId of rawIds) {
        const indexed = store.getRawIndex(rawId);
        assert.ok(indexed, `citation raw ${rawId} 应可在 raw_index 找到`);
        assert.equal(indexed?.lineNo > 0, true);
      }
    }

    // ⑤ L1 rebuild 两次：id/text/contentHash 逐条一致（确定性）
    const snapshot = () =>
      store
        .listMemories({ layers: ['L1'], limit: 1000 })
        .map((memory) => `${memory.id}|${memory.text}|${memory.contentHash}|${memory.sourceRawIds.join(',')}`)
        .sort();
    const l1Before = snapshot();
    const rebuild1 = await runtime.runner.rebuild('L1');
    assert.equal(rebuild1.errors.length, 0);
    assert.deepEqual(snapshot(), l1Before);
    const rebuild2 = await runtime.runner.rebuild('L1');
    assert.equal(rebuild2.errors.length, 0);
    assert.deepEqual(snapshot(), l1Before);

    // ⑥ L3 代际重建：旧记录 archived 保留、新代 active、L0 索引不变
    const rawCountBefore = store.storageStats().rawCount;
    const l3AllBefore = store.listMemories({ layers: ['L3'], limit: 1000 }).length;
    const generationBefore = readRebuildGeneration({ store } as never);
    const l3Rebuild = (await runtime.runner.rebuild('L3')) as LayerRebuildResult;
    assert.equal(l3Rebuild.errors.length, 0);
    assert.ok((l3Rebuild.archivedOld ?? 0) >= 1, '应报告归档旧代数量');
    assert.equal(readRebuildGeneration({ store } as never), generationBefore + 1);
    const l3All = store.listMemories({ layers: ['L3'], limit: 1000 });
    assert.ok(l3All.length >= l3AllBefore, 'L3 记录数只增不减（不物理删除）');
    assert.ok(l3All.some((memory) => memory.status === 'archived'), '旧代应 archived');
    assert.ok(l3All.some((memory) => (memory.status ?? 'active') === 'active'), '新代应 active');
    assert.equal(store.storageStats().rawCount, rawCountBefore, 'L0 raw 索引不受 rebuild 影响');
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

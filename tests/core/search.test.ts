/**
 * 检索原语测试：余弦/归一化/topK/BruteForceIndex（docs §10.3/§10.4）与
 * 混合评分/时间衰减/词法分归一化（docs §10.3）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BruteForceIndex,
  cosineSimilarity,
  dotProduct,
  isNormalized,
  l2Norm,
  normalize,
  topK,
} from '../../src/search/cosine.ts';
import {
  DEFAULT_LAYER_PRIOR,
  combineScore,
  layerPriorFor,
  lexicalScoreFromBm25,
  normalizeLexicalScore,
  recencyScore,
} from '../../src/search/hybrid.ts';

test('cosine: dot/norm/normalize/cosine correctness', () => {
  const a = new Float32Array([3, 4]);
  const b = new Float32Array([6, 8]);
  assert.equal(dotProduct(a, b), 50);
  assert.equal(l2Norm(a), 5);
  const unitA = normalize(a);
  assert.ok(Math.abs(unitA[0] - 0.6) < 1e-6 && Math.abs(unitA[1] - 0.8) < 1e-6);
  assert.ok(isNormalized(normalize(a)));
  assert.ok(Math.abs(cosineSimilarity(a, b) - 1) < 1e-6); // 同向未归一化
  assert.ok(Math.abs(cosineSimilarity(new Float32Array([1, 0]), new Float32Array([0, 1]))) < 1e-6);
  assert.ok(Math.abs(cosineSimilarity(new Float32Array([1, 0]), new Float32Array([-1, 0])) + 1) < 1e-6);
  const normalizedA = normalize(new Float32Array([1, 2, 3]));
  const normalizedB = normalize(new Float32Array([2, 4, 6]));
  assert.ok(Math.abs(cosineSimilarity(normalizedA, normalizedB) - 1) < 1e-6);
  // 零向量 -> 0（不产生 NaN）
  assert.equal(cosineSimilarity(new Float32Array([0, 0]), new Float32Array([1, 1])), 0);
  assert.deepEqual(Array.from(normalize(new Float32Array([0, 0]))), [0, 0]);
  assert.throws(() => cosineSimilarity(new Float32Array([1]), new Float32Array([1, 2])), /length/);
});

test('topK: ordering, limit, minScore, zero-k', () => {
  const items = [
    { id: 'a', score: 0.2 },
    { id: 'b', score: 0.9 },
    { id: 'c', score: 0.5 },
  ];
  const result = topK(items, 2, (item) => item.score);
  assert.deepEqual(result.map((entry) => entry.item.id), ['b', 'c']);
  assert.deepEqual(topK(items, 0, (item) => item.score), []);
  const filtered = topK(items, 10, (item) => item.score, { minScore: 0.3 });
  assert.deepEqual(filtered.map((entry) => entry.item.id), ['b', 'c']);
});

test('BruteForceIndex: upsert/search/remove/filter/minScore (docs §10.4 interface)', () => {
  const index = new BruteForceIndex<{ layer: string }>();
  index.upsert('m1', new Float32Array([1, 0, 0]), { layer: 'L3' });
  index.upsert('m2', new Float32Array([0, 1, 0]), { layer: 'L1' });
  index.upsert('m3', new Float32Array([0.9, 0.1, 0]), { layer: 'L3' });
  assert.equal(index.size, 3);
  const hits = index.search(new Float32Array([1, 0, 0]), 2);
  assert.equal(hits[0].id, 'm1');
  assert.ok(hits[0].score > 0.99);
  const filtered = index.search(new Float32Array([1, 0, 0]), 10, {
    filter: (_id, meta) => meta?.layer === 'L3',
  });
  assert.deepEqual(filtered.map((hit) => hit.id), ['m1', 'm3']);
  const threshold = index.search(new Float32Array([1, 0, 0]), 10, { minScore: 0.5 });
  assert.deepEqual(threshold.map((hit) => hit.id), ['m1', 'm3']);
  index.upsert('m1', new Float32Array([0, 0, 1]), { layer: 'L3' });
  assert.equal(index.size, 3);
  assert.equal(index.search(new Float32Array([1, 0, 0]), 1)[0].id, 'm3');
  index.remove('m3');
  assert.equal(index.size, 2);
  index.clear();
  assert.equal(index.size, 0);
});

test('hybrid: normalizeLexicalScore / lexicalScoreFromBm25 (docs §10.3)', () => {
  // b = max(0, -bm25); lex = b/(1+b)
  assert.ok(Math.abs(lexicalScoreFromBm25(-3) - 0.75) < 1e-12);
  assert.ok(Math.abs(lexicalScoreFromBm25(-1) - 0.5) < 1e-12);
  assert.equal(lexicalScoreFromBm25(0), 0);
  assert.equal(lexicalScoreFromBm25(2), 0); // 正 bm25 视为 0
  assert.equal(lexicalScoreFromBm25(Number.NaN), 0);
  assert.ok(Math.abs(normalizeLexicalScore(-3) - 0.75) < 1e-12);
  assert.ok(Math.abs(normalizeLexicalScore(0.6) - 0.6) < 1e-12); // 已是归一化分
  assert.equal(normalizeLexicalScore(7), 1);
});

test('hybrid: recencyScore exponential decay with half-life (docs §10.3)', () => {
  const day = 86_400_000;
  const now = Date.UTC(2026, 9, 25);
  assert.equal(recencyScore(now, now, 30), 1);
  assert.ok(Math.abs(recencyScore(now - 30 * day, now, 30) - 0.5) < 1e-12);
  assert.ok(Math.abs(recencyScore(now - 60 * day, now, 30) - 0.25) < 1e-12);
  assert.ok(Math.abs(recencyScore(now - 14 * day, now, 14) - 0.5) < 1e-12);
  assert.equal(recencyScore(now + 1000, now, 30), 1); // 未来时间按 0 龄
  assert.throws(() => recencyScore(now, now, 0), /halfLifeDays/);
});

test('hybrid: combineScore weighted average + normalization + components + layerPrior', () => {
  const weights = { vectorWeight: 0.55, lexicalWeight: 0.25, recencyWeight: 0.12, importanceWeight: 0.08 };
  const result = combineScore({ vector: 0.6, lexical: -2, recency: 0.5, importance: 0.8 }, weights);
  const expectedLexical = 2 / 3;
  const expected =
    (0.55 * 0.6 + 0.25 * expectedLexical + 0.12 * 0.5 + 0.08 * 0.8) / (0.55 + 0.25 + 0.12 + 0.08);
  assert.ok(Math.abs(result.score - expected) < 1e-12);
  assert.ok(Math.abs(result.components.vector - 0.6) < 1e-12);
  assert.ok(Math.abs(result.components.lexical - expectedLexical) < 1e-12);

  // 单因子权重
  const vectorOnly = combineScore({ vector: 0.8 }, { vectorWeight: 1, lexicalWeight: 0, recencyWeight: 0, importanceWeight: 0 });
  assert.equal(vectorOnly.score, 0.8);
  // 权重归一化（2:1 => 1:1 效果）
  const normalizedWeights = combineScore(
    { vector: 1, lexical: 0.5 },
    { vectorWeight: 2, lexicalWeight: 1, recencyWeight: 0, importanceWeight: 0 },
  );
  assert.ok(Math.abs(normalizedWeights.score - (2 * 1 + 1 * 0.5) / 3) < 1e-12);
  // clamp 负值 / 超界
  const clamped = combineScore(
    { vector: -1, lexical: -1, recency: 2, importance: -4 },
    { vectorWeight: 1, lexicalWeight: 1, recencyWeight: 1, importanceWeight: 1 },
  );
  assert.equal(clamped.components.vector, 0);
  assert.ok(Math.abs(clamped.components.lexical - 0.5) < 1e-12);
  assert.equal(clamped.components.recency, 1);
  assert.equal(clamped.components.importance, 0);
  // 权重和为 0 抛错
  assert.throws(
    () => combineScore({}, { vectorWeight: 0, lexicalWeight: 0, recencyWeight: 0, importanceWeight: 0 }),
    /weights sum/,
  );
  // layerPrior（docs: L3=1.0, L2=0.98, L1=0.90）
  const base = combineScore({ vector: 1 }, { vectorWeight: 1, lexicalWeight: 0, recencyWeight: 0, importanceWeight: 0 }, { layer: 'L1' });
  assert.ok(Math.abs(base.score - 0.9) < 1e-12);
  assert.equal(layerPriorFor('L3'), DEFAULT_LAYER_PRIOR.L3);
  assert.equal(layerPriorFor('unknown-layer'), 1);
});

test('hybrid: recency integrated into combined score', () => {
  const now = Date.UTC(2026, 9, 25);
  const weights = { vectorWeight: 0, lexicalWeight: 0, recencyWeight: 1, importanceWeight: 0 };
  const fresh = combineScore({ recency: recencyScore(now, now, 30) }, weights);
  const old = combineScore({ recency: recencyScore(now - 30 * 86_400_000, now, 30) }, weights);
  assert.ok(fresh.score > old.score);
  assert.ok(Math.abs(old.score - 0.5) < 1e-12);
});

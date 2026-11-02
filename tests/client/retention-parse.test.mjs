#!/usr/bin/env node
/**
 * tests/client/retention-parse.test.mjs —— 客户端「记忆分层」解析/排序纯逻辑单测。
 *
 * 输入 fixtures 来自 integration-dev 在真实 E2E 隔离库抓的 `/memories?retention=` 原文
 * （2026-10-26；mid=4/long=3/pinned=1 的快照），用于验证 client/src/util.ts 中：
 *   - `retentionOf()`：优先嵌套 `retention:{tier,score,pinned}`，兼容扁平字段；
 *   - `compareRetention()`：pinned 优先、再按 retentionScore 降序；
 *   - `retentionLabel()/retentionLongLabel()`：short/mid/long → 短期/中期/长期（记忆）。
 *
 * 运行（需要 Node 24，仓库内脚本）：
 *   cmd /c "scripts\node24.cmd tests\run.mjs tests/client"
 * 或：
 *   cmd /c "scripts\node24.cmd tests/client/retention-parse.test.mjs"
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compareRetention, retentionLabel, retentionLongLabel, retentionOf } from '../../client/src/util.ts';

/** 真实 fixture：/memories?retention=mid（节选 2/4 条） */
const MID_ROWS = [
  {
    id: 'L1-atom-mvo2526k-fd7c3aa5',
    layer: 'L1',
    kind: 'atom',
    text: 'build.mjs: 100 lines',
    importance: 0.3,
    pinned: false,
    retention: { tier: 'mid', score: 0.25759860353861824, pinned: false },
    retentionTier: 'mid',
    retentionScore: 0.25759860353861824,
  },
  {
    id: 'L1-atom-mvo2526k-a5a603aa',
    layer: 'L1',
    kind: 'atom',
    text: '请帮我检查一下构建脚本。',
    importance: 0.44999999999999996,
    pinned: false,
    retention: { tier: 'mid', score: 0.3025986035386183, pinned: false },
    retentionTier: 'mid',
    retentionScore: 0.3025986035386183,
  },
];

/** 真实 fixture：/memories?retention=long（节选 2/3 条；含 pinned） */
const LONG_ROWS = [
  {
    id: 'L3-fact-1-b3a339e8',
    layer: 'L3',
    kind: 'fact',
    text: '事实：自检记忆分层 run-1792946660389: 长期保留的重要事实(深色主题 / 本地端口 8080)',
    importance: 0.95,
    pinned: false,
    retention: { tier: 'long', score: 0.3733039077531513, pinned: false },
    retentionTier: 'long',
    retentionScore: 0.3733039077531513,
  },
  {
    id: 'L3-preference-1-0a1fb785',
    layer: 'L3',
    kind: 'preference',
    text: '用户偏好深色主题(自检保存)',
    importance: 0.8,
    pinned: true,
    retention: { tier: 'long', score: 0.36830353498814683, pinned: true },
    retentionTier: 'long',
    retentionScore: 0.36830353498814683,
  },
];

test('retentionOf 解析真实 mid 条目（嵌套对象优先）', () => {
  const info = retentionOf(MID_ROWS[0]);
  assert.ok(info !== null);
  assert.equal(info.tier, 'mid');
  assert.ok(Math.abs(info.score - 0.25759860353861824) < 1e-12);
  assert.equal(info.pinned, false);
});

test('retentionOf 解析真实 long + pinned 条目', () => {
  const info = retentionOf(LONG_ROWS[1]);
  assert.ok(info !== null);
  assert.equal(info.tier, 'long');
  assert.equal(info.pinned, true);
  assert.ok(info.score > 0 && info.score < 1);
});

test('retentionOf 兼容仅有扁平字段的中间版本/旧数据', () => {
  const flatOnly = { id: 'x', layer: 'L1', retentionTier: 'short', retentionScore: 0.12, pinned: true };
  const info = retentionOf(flatOnly);
  assert.ok(info !== null);
  assert.equal(info.tier, 'short');
  assert.ok(Math.abs(info.score - 0.12) < 1e-12);
  assert.equal(info.pinned, true);
});

test('retentionOf 对缺失/非法输入返回 null（UI 降级不崩溃）', () => {
  assert.equal(retentionOf(null), null);
  assert.equal(retentionOf(undefined), null);
  assert.equal(retentionOf({}), null);
  assert.equal(retentionOf({ retention: null }), null);
  assert.equal(retentionOf({ retention: { tier: 123 } }), null);
});

test('compareRetention：mid 层按 score 降序（真实 fixture）', () => {
  const sorted = [...MID_ROWS].sort(compareRetention);
  assert.deepEqual(
    sorted.map((row) => row.id),
    ['L1-atom-mvo2526k-a5a603aa', 'L1-atom-mvo2526k-fd7c3aa5'],
  );
});

test('compareRetention：pinned 优先于更高 score（真实 fixture；两个模型一致）', () => {
  const sorted = [...LONG_ROWS].sort(compareRetention);
  // pinned 条目 score 更低（0.3683 < 0.3733）但仍排第一
  assert.equal(sorted[0].id, 'L3-preference-1-0a1fb785');
  assert.equal(retentionOf(sorted[0]).pinned, true);
});

test('compareRetention：无 retention 字段的条目排最后', () => {
  const rows = [MID_ROWS[0], { id: 'no-retention' }];
  const sorted = [...rows].sort(compareRetention);
  assert.equal(sorted[0].id, MID_ROWS[0].id);
  assert.equal(sorted[1].id, 'no-retention');
});

test('retentionLabel/retentionLongLabel：short/mid/long → 短期/中期/长期（记忆）', () => {
  assert.equal(retentionLabel('short'), '短期');
  assert.equal(retentionLabel('mid'), '中期');
  assert.equal(retentionLabel('long'), '长期');
  assert.equal(retentionLongLabel('short'), '短期记忆');
  assert.equal(retentionLongLabel('mid'), '中期记忆');
  assert.equal(retentionLongLabel('long'), '长期记忆');
  // 未知 tier 原样返回（扩展层/宿主新值降级）
  assert.equal(retentionLabel('custom_tier'), 'custom_tier');
});

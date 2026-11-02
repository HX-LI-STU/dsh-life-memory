/**
 * L1 原子层测试：映射规则（§9.2.1）、重要度启发式（§9.3）、确定性/幂等、脱敏与截断。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createL1Layer, planL1Atom, buildL1Record, L1_EXTRACTOR } from '../../../src/layers/l1-episode.ts';
import { scoreImportance } from '../../../src/layers/util.ts';
import { createHarness, makeRaw, TEST_NOW } from './fakes.ts';

test('L1: user/assistant/tool_call/tool_result/compaction/note 各生成一条 atom', () => {
  const user = planL1Atom(makeRaw(1, { kind: 'user', role: 'user', text: '把首页改成深色模式', turnId: 't1' }));
  assert.ok(user);
  assert.equal(user.text, '把首页改成深色模式');
  assert.ok(user.tags.includes('role:user'));
  assert.ok(user.tags.includes('rawKind:user'));
  assert.ok(user.tags.includes('turn:t1'));
  assert.ok(user.tags.includes(`source:${L1_EXTRACTOR}`));
  assert.equal(user.meta.rawKind, 'user');
  assert.equal(user.meta.turnId, 't1');

  const assistant = planL1Atom(makeRaw(2, { kind: 'assistant', role: 'assistant', text: '已完成修改' }));
  assert.ok(assistant);
  assert.equal(assistant.text, '已完成修改');
  assert.ok(assistant.tags.includes('role:assistant'));

  const call = planL1Atom(
    makeRaw(3, {
      kind: 'tool_call',
      role: 'tool',
      text: '[tool_call] grep {"q":"主题"}',
      payload: { type: 'tool/call', data: { name: 'grep', arguments: '{"q":"主题"}' } },
      tags: ['tool:grep'],
    }),
  );
  assert.ok(call);
  assert.equal(call.text, 'grep({"q":"主题"})');
  assert.ok(call.tags.includes('tool:grep'));

  const result = planL1Atom(makeRaw(4, { kind: 'tool_result', role: 'tool', text: '结果文本', tags: ['tool:grep'] }));
  assert.ok(result);
  assert.equal(result.text, '结果文本');
  assert.equal(result.base, 0.3);

  const compaction = planL1Atom(
    makeRaw(5, { kind: 'compaction', text: null, payload: { type: 'plugin:compaction', summary: '压缩前摘要' } }),
  );
  assert.ok(compaction);
  assert.equal(compaction.text, '压缩前摘要');
  assert.equal(compaction.base, 0.6);

  const note = planL1Atom(makeRaw(6, { kind: 'note', text: '记住：部署用 pnpm' }));
  assert.ok(note);
  // NFKC 会把全角冒号归一为半角（docs §9.2 文本规范化）
  assert.equal(note.text, '记住:部署用 pnpm');
  assert.equal(note.base, 0.9);
  assert.ok(note.tags.includes('origin:memory_save'));
});

test('L1: turn 结构性事件不生成 atom；空文本 session/system 跳过', () => {
  assert.equal(planL1Atom(makeRaw(1, { kind: 'turn', text: 'turn/end' })), null);
  assert.equal(planL1Atom(makeRaw(2, { kind: 'session', text: null })), null);
  assert.equal(planL1Atom(makeRaw(3, { kind: 'system', text: '   ' })), null);
  assert.equal(planL1Atom(makeRaw(4, { kind: 'event', text: null })), null);
  assert.ok(planL1Atom(makeRaw(5, { kind: 'system', text: '环境提示：Node 24' })));
});

test('L1: assistant 纯工具调用轮合成 "tool: name1,name2"（§9.2.1）', () => {
  const plan = planL1Atom(
    makeRaw(1, {
      kind: 'assistant',
      role: 'assistant',
      text: null,
      payload: {
        type: 'assistant/message',
        message: { content: [{ type: 'tool-call', name: 'read_file' }, { type: 'tool-call', name: 'grep' }] },
      },
    }),
  );
  assert.ok(plan);
  assert.equal(plan.text, 'tool: read_file,grep');
  assert.equal(plan.meta.synthesized, 'tool-names');
});

test('L1: tool_result 文本截断到 2000 字符（完整原文保留在 L0），错误基线 0.45', () => {
  const long = 'x'.repeat(2500);
  const plan = planL1Atom(makeRaw(1, { kind: 'tool_result', text: long, tags: ['tool-error'] }));
  assert.ok(plan);
  assert.equal(plan.text.length, 2000);
  assert.equal(plan.meta.truncated, true);
  assert.equal(plan.meta.fullTextChars, 2500);
  assert.equal(plan.base, 0.45);
  assert.ok(plan.tags.includes('is-error'));
});

test('L1: 重要度启发式 —— user > assistant > tool_call；note/compaction 高基线', () => {
  const user = buildL1Record(makeRaw(1, { kind: 'user', role: 'user', text: '普通用户消息' }));
  const assistant = buildL1Record(makeRaw(2, { kind: 'assistant', role: 'assistant', text: '普通助手消息' }));
  const call = buildL1Record(makeRaw(3, { kind: 'tool_call', role: 'tool', text: 'grep(x)' }));
  const note = buildL1Record(makeRaw(4, { kind: 'note', text: '记住这个' }));
  assert.ok(user && assistant && call && note);
  assert.ok(user.importance! > assistant.importance!);
  assert.ok(assistant.importance! > call.importance!);
  assert.ok(note.importance! >= 0.9);
  // 用户消息：base 0.35 + isUserMessage 0.10 = 0.45
  assert.ok(Math.abs(user.importance! - 0.45) < 1e-9);
  // §9.3 启发式：标记词/长文本/显式记忆各自加分
  const marked = scoreImportance(0.3, '决定采用 pnpm，记住这一点' + '很重要'.repeat(80));
  assert.ok(marked >= 0.55);
});

test('L1: 元数据（createdSeq/session/workspace/role）与确定性 id', () => {
  const raw = makeRaw(7, {
    kind: 'user',
    role: 'user',
    text: '测试消息',
    sessionId: 'sess_x',
    workspace: 'D:\\ws\\proj',
    ts: TEST_NOW + 5,
  });
  const record = buildL1Record(raw);
  assert.ok(record);
  assert.equal(record.createdSeq, 7);
  assert.equal(record.createdAt, raw.ts);
  assert.equal(record.sessionId, 'sess_x');
  assert.equal(record.workspace, 'D:\\ws\\proj');
  assert.deepEqual(record.sourceRawIds, [raw.id]);
  assert.match(record.id ?? '', /^L1-atom-[0-9a-z]+-[0-9a-f]{8}$/);
  // 确定性：同输入同输出
  assert.deepEqual(buildL1Record(raw), record);
});

test('L1: 通过 runner 增量派生（一次 raw 一条 atom，重复运行幂等）', async () => {
  const harness = createHarness({ raws: [makeRaw(1, { kind: 'user', role: 'user', text: '第一条' })] });
  const first = await harness.run();
  assert.equal(first[0].written, 1);
  assert.equal(harness.store.countByLayer().L1, 1);
  const second = await harness.run();
  assert.equal(second[0].written, 0);
  assert.equal(harness.store.countByLayer().L1, 1);
  const memory = [...harness.store.memories.values()][0];
  assert.equal(memory.revision, 1);
  assert.equal(memory.kind, 'atom');
  assert.equal(memory.layer, 'L1');
});

test('L1: 同批相同文本只产生一条 atom（store 活跃唯一约束），溯源合并', async () => {
  const harness = createHarness({
    raws: [
      makeRaw(1, { kind: 'user', role: 'user', text: '继续' }),
      makeRaw(2, { kind: 'user', role: 'user', text: '继续' }),
    ],
  });
  await harness.run();
  const atoms = harness.store.listMemories({ layers: ['L1'] });
  assert.equal(atoms.length, 1);
  assert.deepEqual(atoms[0].sourceRawIds.sort(), ['2026-10-25-000001', '2026-10-25-000002']);
});

test('L1: 派生文本脱敏不会污染 L0（raw 原样）', async () => {
  const raw = makeRaw(1, { kind: 'user', role: 'user', text: '我的 token: sk-abcdefghijklmnopqrstuvwx' });
  const harness = createHarness({ raws: [raw] });
  await harness.run();
  const atom = harness.store.listMemories({ layers: ['L1'] })[0];
  assert.ok(!atom.text.includes('sk-abcdefghijklmnopqrstuvwx'));
  assert.ok(atom.text.includes('[REDACTED:'), '派生文本应脱敏');
  // L0 原始记录没有被修改（raw.text 保持原样）
  assert.equal(raw.text, '我的 token: sk-abcdefghijklmnopqrstuvwx');
});

test('L1: 层定义元信息符合契约', () => {
  const layer = createL1Layer();
  assert.equal(layer.id, 'L1');
  assert.equal(layer.version, 1);
  assert.deepEqual(layer.dependsOn, []);
  assert.equal(layer.rebuildableFromRaw, true);
});

/** system prompt 注入块测试（纯函数 + 缓存构建器） */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MEMORY_PROMPT_HEADER,
  PromptSectionBuilder,
  promptSignature,
  renderPromptSection,
  sectionBudgets,
} from '../../src/prompt/section.ts';
import { DEFAULT_CONFIG } from '../../src/config.ts';
import type { MemoryRecord, MemoryStore } from '../../src/core/contracts.ts';

function mem(overrides: Partial<MemoryRecord>): MemoryRecord {
  return {
    id: 'L3-preference-a-1',
    layer: 'L3',
    kind: 'preference',
    text: '用户偏好深色主题',
    importance: 0.8,
    confidence: 0.9,
    sourceRawIds: ['2026-10-25-000001'],
    tags: [],
    createdAt: 1761390000000,
    updatedAt: 1761390000000,
    revision: 1,
    contentHash: 'h1',
    status: 'active',
    ...overrides,
  };
}

const NOW = Date.UTC(2026, 9, 25, 15, 0, 0);

test('renderPromptSection: 分节、引用、预算与空态', () => {
  assert.equal(renderPromptSection({ memories: [], budgetTokens: 800, redact: true, now: NOW }), '');
  const memories = [
    mem({ id: 'L3-preference-1', kind: 'preference', text: '偏好深色主题', contentHash: 'h1' }),
    mem({ id: 'L3-preference-2', kind: 'preference', text: '中文交流；代码注释用中文', contentHash: 'h2' }),
    mem({ id: 'L3-fact-1', kind: 'fact', text: '项目 dsh-life-memory 使用 TypeScript ESM', contentHash: 'h3' }),
    mem({ id: 'L3-decision-1', kind: 'decision', text: 'L3 不做物理删除，用 valid_to 表示失效', contentHash: 'h4' }),
    mem({ id: 'L3-fact-old', kind: 'fact', text: '已归档的旧事实', contentHash: 'h5', status: 'archived' }),
  ];
  const text = renderPromptSection({ memories, budgetTokens: 800, redact: true, now: NOW });
  assert.ok(text.startsWith(MEMORY_PROMPT_HEADER));
  assert.ok(text.includes('### 用户偏好'));
  assert.ok(text.includes('### 项目事实'));
  assert.ok(text.includes('### 关键决策'));
  assert.ok(text.includes('- 偏好深色主题 [mem:L3-preference-1]'));
  assert.ok(!text.includes('已归档的旧事实'));
  assert.ok(text.includes('<!-- 更新于 2026-10-25'));
  assert.ok(!text.endsWith('\n'));
});

test('renderPromptSection: 预算裁剪为整条丢弃', () => {
  const memories = Array.from({ length: 40 }, (_, i) =>
    mem({ id: `L3-preference-${i}`, kind: 'preference', text: `偏好设置第 ${i} 条：${'深色主题'.repeat(10)}`, contentHash: `h${i}` }),
  );
  const text = renderPromptSection({ memories, budgetTokens: 200, redact: true, now: NOW });
  const itemLines = text.split('\n').filter((l) => l.startsWith('- '));
  assert.ok(itemLines.length > 0);
  assert.ok(itemLines.length < 40);
  for (const line of itemLines) assert.ok(line.includes('[mem:'));
});

test('renderPromptSection: 脱敏派生文本', () => {
  const memories = [mem({ id: 'L3-fact-secret', kind: 'fact', text: 'OpenAI key 是 sk-abcdefghijklmnopqrstuvwx 请保密', contentHash: 's1' })];
  const text = renderPromptSection({ memories, budgetTokens: 800, redact: true, now: NOW });
  assert.ok(text.includes('[REDACTED:api-key]'));
  assert.ok(!text.includes('sk-abcdefghijklmnopqrstuvwx'));
});

test('sectionBudgets: 默认 800 的分配', () => {
  const b = sectionBudgets(800);
  assert.equal(b.footer, 50);
  assert.equal(b.preference + b.fact + b.decision, 750);
});

test('promptSignature: 与 id/revision/updatedAt 相关且稳定', () => {
  const a = [mem({ id: 'a', revision: 1, contentHash: 'x' })];
  const b = [mem({ id: 'a', revision: 2, contentHash: 'x' })];
  assert.equal(promptSignature(a), promptSignature([mem({ id: 'a', revision: 1, contentHash: 'y' })]));
  assert.notEqual(promptSignature(a), promptSignature(b));
});

test('PromptSectionBuilder: 缓存命中与失效', async () => {
  let calls = 0;
  let current: MemoryRecord[] = [mem({ id: 'L3-preference-1', kind: 'preference', text: '偏好深色主题' })];
  const store = {
    listMemories: () => {
      calls += 1;
      return current;
    },
  } as unknown as MemoryStore;
  const builder = new PromptSectionBuilder({ config: { ...DEFAULT_CONFIG, recall: { ...DEFAULT_CONFIG.recall, injectSystemPrompt: true } }, store, now: () => NOW });
  const first = await builder.build();
  const second = await builder.build();
  assert.equal(first, second);
  assert.ok(calls >= 2, '每次 build 读取 L3 集合与工作记忆集合以计算签名');
  assert.ok(first.includes('[mem:L3-preference-1]'));

  current = [mem({ id: 'L3-preference-1', kind: 'preference', text: '偏好浅色主题', updatedAt: NOW + 1 })];
  const third = await builder.build();
  assert.ok(third.includes('偏好浅色主题'));
  assert.ok(!third.includes('偏好深色主题'));
});

test('PromptSectionBuilder: 关闭注入时返回空串', async () => {
  const store = { listMemories: () => [mem({})] } as unknown as MemoryStore;
  const builder = new PromptSectionBuilder({
    config: { ...DEFAULT_CONFIG, recall: { ...DEFAULT_CONFIG.recall, injectSystemPrompt: false } },
    store,
  });
  assert.equal(await builder.build(), '');
});

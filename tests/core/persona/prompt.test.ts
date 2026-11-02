/**
 * 人格 × prompt 注入测试（docs/25-persona.md §5）：
 * 人格身份块 / roster 行 / 按人格过滤画像与工作记忆 / 预算截断 / 缓存签名 /
 * 无激活人格时的 v3 回归 / persona.enabled=false 与 injectSystemPrompt=false 的差异。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { NewMemoryRecord, PersonaDefinition } from '../../../src/core/contracts.ts';
import { deriveMemoryId } from '../../../src/core/ids.ts';
import { estimateTokens } from '../../../src/core/text.ts';
import {
  PERSONA_ROSTER_PREFIX,
  PERSONA_ROSTER_SUFFIX,
  PERSONA_SECTION_TITLE_PREFIX,
  PromptSectionBuilder,
  WORKING_MEMORY_TITLE,
  renderPersonaBlock,
  renderPersonaRosterLine,
} from '../../../src/prompt/section.ts';
import { FakeMemoryStore, TEST_NOW, createClock, hashEmbed, testConfig } from '../layers/fakes.ts';

function makePersona(overrides: Partial<PersonaDefinition> = {}): PersonaDefinition {
  const id = overrides.id ?? 'kobayashi';
  return {
    id,
    name: overrides.name ?? '小林',
    description: overrides.description ?? '温柔、严谨的个人助理',
    aliases: overrides.aliases ?? [],
    tags: overrides.tags ?? [],
    model: null,
    provider: null,
    body: overrides.body ?? '你是"小林"，说话简洁、先给结论。\n涉及偏好时优先参考记忆。',
    sourcePath: `/personas/${id}.md`,
    contentHash: overrides.contentHash ?? `hash-${id}`,
    mtime: TEST_NOW,
    valid: overrides.valid ?? true,
    invalidReason: overrides.invalidReason ?? null,
    truncated: false,
  };
}

let seedCounter = 0;
function seedMemory(
  store: FakeMemoryStore,
  options: { text: string; kind: string; layer?: string; personaId?: string | null; sessionId?: string; updatedAt?: number },
): string {
  seedCounter += 1;
  const layer = options.layer ?? 'L3';
  const createdAt = TEST_NOW;
  const record: NewMemoryRecord = {
    id: deriveMemoryId(layer, options.kind, createdAt, `persona-prompt-${seedCounter}`),
    layer,
    kind: options.kind as never,
    text: options.text,
    importance: 0.8,
    confidence: 0.9,
    sourceRawIds: ['2026-10-25-000001'],
    sessionId: options.sessionId ?? 's1',
    personaId: options.personaId === undefined ? null : options.personaId,
    tags: [],
    createdAt,
  };
  const stored = store.upsertMemory(record, hashEmbed(options.text, 64));
  store.memories.get(stored.id)!.updatedAt = options.updatedAt ?? TEST_NOW;
  return stored.id;
}

function makeEnv(options: { active?: PersonaDefinition | null; roster?: PersonaDefinition[]; overrides?: Record<string, unknown> } = {}) {
  const clock = createClock(TEST_NOW);
  const store = new FakeMemoryStore();
  store.nowValue = clock.now();
  const config = testConfig(options.overrides ?? {});
  const builder = new PromptSectionBuilder({
    config,
    store,
    now: () => clock.now(),
    getSessionId: () => 's1',
    ...(options.active !== undefined
      ? { getActivePersona: () => options.active ?? null }
      : {}),
    ...(options.roster !== undefined ? { getPersonaRoster: () => options.roster ?? [] } : {}),
  });
  return { clock, store, config, builder };
}

test('renderPersonaBlock: 标题 + 正文按整行注入；预算不足保留头部说明', () => {
  const persona = makePersona();
  const full = renderPersonaBlock({ persona, budgetTokens: 800, redact: false });
  assert.ok(full.startsWith(`${PERSONA_SECTION_TITLE_PREFIX}${persona.name}）`));
  assert.ok(full.includes('你是"小林"'));
  assert.ok(full.includes('优先参考记忆'));

  const tiny = renderPersonaBlock({ persona, budgetTokens: 12, redact: false });
  assert.ok(tiny.startsWith(PERSONA_SECTION_TITLE_PREFIX.split('（')[0]));
  assert.ok(estimateTokens(tiny) <= 13);

  assert.equal(renderPersonaBlock({ persona: makePersona({ valid: false }), budgetTokens: 800, redact: false }), '');
  assert.equal(renderPersonaBlock({ persona, budgetTokens: 0, redact: false }), '');
});

test('renderPersonaRosterLine: ≤1 个不输出；≤10 个含 id（name）— description；>10 仅列 id', () => {
  assert.equal(renderPersonaRosterLine([]), '');
  assert.equal(renderPersonaRosterLine([makePersona()]), '');
  const two = renderPersonaRosterLine([
    makePersona({ id: 'a', name: 'A', description: '描述 A' }),
    makePersona({ id: 'b', name: 'B', description: '' }),
  ]);
  assert.ok(two.startsWith(PERSONA_ROSTER_PREFIX));
  assert.ok(two.endsWith(PERSONA_ROSTER_SUFFIX));
  assert.ok(two.includes('a（A）— 描述 A'));
  assert.ok(two.includes('b（B）'));
  const eleven = Array.from({ length: 11 }, (_, index) =>
    makePersona({ id: `p${index}`, name: `P${index}`, description: 'd' }),
  );
  const truncated = renderPersonaRosterLine(eleven);
  assert.ok(truncated.includes('共 11 个'));
  assert.ok(!truncated.includes('（P0）'), '>10 时仅列 id');
});

test('prompt: 激活人格 → 人格身份块 + roster + 仅当前人格与共享的画像/工作记忆', async () => {
  const active = makePersona({ id: 'alpha', name: 'Alpha' });
  const roster = [active, makePersona({ id: 'beta', name: 'Beta' })];
  const env = makeEnv({ active, roster });
  const mine = seedMemory(env.store, { text: 'A 的偏好深色主题', kind: 'preference', personaId: 'alpha' });
  const other = seedMemory(env.store, { text: 'B 的偏好浅色主题', kind: 'preference', personaId: 'beta' });
  const shared = seedMemory(env.store, { text: '共享事实：项目用 TypeScript', kind: 'fact', personaId: null });
  const workMine = seedMemory(env.store, { text: '本会话工作记忆 A', kind: 'atom', layer: 'L1', personaId: 'alpha' });
  const workOther = seedMemory(env.store, { text: '本会话工作记忆 B', kind: 'atom', layer: 'L1', personaId: 'beta' });

  const section = await env.builder.build();
  assert.ok(section.startsWith(`## 当前人格（persona: ${active.name}）`), '人格块在首位');
  assert.ok(section.includes('你是"小林"'));
  assert.ok(section.includes(PERSONA_ROSTER_PREFIX) && section.includes('alpha（Alpha）'));
  // 记忆按人格过滤
  assert.ok(section.includes('A 的偏好深色主题'));
  assert.ok(section.includes('共享事实：项目用 TypeScript'));
  assert.ok(!section.includes('B 的偏好浅色主题'), '其他人格语义记忆不注入');
  assert.ok(section.includes('本会话工作记忆 A'));
  assert.ok(!section.includes('本会话工作记忆 B'), '其他人格工作记忆不注入');
  assert.ok(section.includes(WORKING_MEMORY_TITLE));
  // 引用 id 引用的正是本查询应有的集合
  assert.ok(section.includes(`[mem:${mine}]`));
  assert.ok(section.includes(`[mem:${shared}]`));
  assert.ok(section.includes(`[mem:${workMine}]`));
  assert.ok(!section.includes(`[mem:${other}]`));
  assert.ok(!section.includes(`[mem:${workOther}]`));
});

test('prompt: 无激活人格 → 与 v3 完全一致（无人格块、不过滤）', async () => {
  const envWithNull = makeEnv({ active: null, roster: [] });
  const v3 = makeEnv();
  const seed = (store: FakeMemoryStore) => {
    seedMemory(store, { text: 'A 的偏好', kind: 'preference', personaId: 'alpha' });
    seedMemory(store, { text: 'B 的偏好', kind: 'preference', personaId: 'beta' });
    seedMemory(store, { text: '共享事实', kind: 'fact', personaId: null });
  };
  seed(envWithNull.store);
  seed(v3.store);
  const withNull = await envWithNull.builder.build();
  const plain = await v3.builder.build();
  const normalizeIds = (section: string): string => section.replace(/\[mem:[^\]]+\]/g, '[mem:<id>]');
  assert.equal(normalizeIds(withNull), normalizeIds(plain));
  assert.ok(!plain.includes('## 当前人格'));
  assert.ok(plain.includes('A 的偏好') && plain.includes('B 的偏好') && plain.includes('共享事实'));
});

test('prompt: persona.enabled=false → 不注入人格块且不过滤（行为退化 v3）', async () => {
  const active = makePersona({ id: 'alpha', name: 'Alpha' });
  const env = makeEnv({ active, roster: [active, makePersona({ id: 'beta', name: 'Beta' })], overrides: { persona: { enabled: false } } });
  seedMemory(env.store, { text: 'A 的偏好', kind: 'preference', personaId: 'alpha' });
  seedMemory(env.store, { text: 'B 的偏好', kind: 'preference', personaId: 'beta' });
  const section = await env.builder.build();
  assert.ok(!section.includes('## 当前人格'));
  assert.ok(!section.includes(PERSONA_ROSTER_PREFIX));
  assert.ok(section.includes('A 的偏好') && section.includes('B 的偏好'));
});

test('prompt: injectSystemPrompt=false → 不注入人格块，但记忆仍按人格过滤', async () => {
  const active = makePersona({ id: 'alpha', name: 'Alpha' });
  const env = makeEnv({ active, roster: [active, makePersona({ id: 'beta', name: 'Beta' })], overrides: { persona: { injectSystemPrompt: false } } });
  seedMemory(env.store, { text: 'A 的偏好', kind: 'preference', personaId: 'alpha' });
  seedMemory(env.store, { text: 'B 的偏好', kind: 'preference', personaId: 'beta' });
  const section = await env.builder.build();
  assert.ok(!section.includes('## 当前人格'));
  assert.ok(section.includes('A 的偏好'));
  assert.ok(!section.includes('B 的偏好'), '人格启用时记忆仍按人格过滤');
});

test('prompt: 预算内截断（人格正文整行、总 token 不超预算）', async () => {
  const longBody = Array.from({ length: 40 }, (_, index) => `第 ${index} 行人格设定：${'保持简洁并优先引用记忆'.repeat(3)}`).join('\n');
  const active = makePersona({ body: longBody });
  const env = makeEnv({ active, roster: [active, makePersona({ id: 'b', name: 'B', description: 'd' })] });
  seedMemory(env.store, { text: '偏好深色主题', kind: 'preference', personaId: 'kobayashi' });
  const budget = 500;
  const section = await env.builder.build({ budgetTokens: budget });
  assert.ok(section.startsWith('## 当前人格'));
  assert.ok(estimateTokens(section) <= budget + 60, `token 预算：${estimateTokens(section)} <= ${budget}+60`);
  // 注入的人格正文行必须完整（不从中间截断）
  const bodyLines = section.split('\n').filter((line) => line.startsWith('第 '));
  assert.ok(bodyLines.length > 0 && bodyLines.length < 40);
  for (const line of bodyLines) {
    assert.ok(longBody.includes(line), '人格正文按整行注入');
  }
});

test('prompt: 缓存签名包含 personaId/contentHash/roster ids —— 人格变化使缓存失效', async () => {
  const alpha = makePersona({ id: 'alpha', name: 'Alpha', body: '人格 A 正文' });
  const beta = makePersona({ id: 'beta', name: 'Beta', body: '人格 B 正文' });
  let active: PersonaDefinition = alpha;
  const clock = createClock(TEST_NOW);
  const store = new FakeMemoryStore();
  store.nowValue = clock.now();
  const config = testConfig();
  const builder = new PromptSectionBuilder({
    config,
    store,
    now: () => clock.now(),
    getActivePersona: () => active,
    getPersonaRoster: () => [alpha, beta],
  });
  seedMemory(store, { text: 'A 偏好', kind: 'preference', personaId: 'alpha' });
  seedMemory(store, { text: 'B 偏好', kind: 'preference', personaId: 'beta' });
  const first = await builder.build();
  assert.equal(await builder.build(), first, '未变化 → 缓存复用');
  assert.ok(first.includes('人格 A 正文'));
  active = { ...beta };
  const second = await builder.build();
  assert.notEqual(second, first, '切换人格 → 签名变化');
  assert.ok(second.includes('人格 B 正文'));
  assert.ok(second.includes('B 偏好') && !second.includes('A 偏好'));
});

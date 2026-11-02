/**
 * 人格解析器测试（docs/25-persona.md §2）：
 * 合法文件 / 无 frontmatter / 空正文 / 坏 frontmatter / `{{…}}` 严格规则 / 孤立 `{{` /
 * 超长截断 / 非法文件名 / aliases+tags 清洗 / unknown 字段忽略 / 引号与块状列表 / 确定性 hash。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  PERSONA_ID_RE,
  PERSONA_TEMPLATE_GROUP_RE,
  parsePersonaFile,
  parsePersonaFrontmatter,
  personaIdFromPath,
  toPersonaSummary,
} from '../../../src/persona/index.ts';
import { TEST_NOW } from '../layers/fakes.ts';

const tmpDirs: string[] = [];
function tmpFile(name: string, content: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-mv-persona-'));
  tmpDirs.push(dir);
  const path = join(dir, name);
  writeFileSync(path, content, 'utf8');
  return path;
}
process.on('exit', () => {
  for (const dir of tmpDirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

const VALID = `---
name: 小林
description: 温柔、严谨的个人助理
aliases: [kobayashi, xiaolin, kobayashi]
tags:
  - assistant
  - engineer
model: deepseek-chat
provider: deepseek
unknownField: ignored
---
你是"小林"，用户长期合作的个人助理。说话简洁、先给结论，再给依据。
涉及用户偏好时优先参考记忆中的画像。
`;

function parse(content: string, name = 'kobayashi.md', maxBodyChars = 20_000) {
  return parsePersonaFile({ filePath: tmpFile(name, content), content, maxBodyChars, now: TEST_NOW });
}

test('parser: 合法文件 → definition 全字段（id/name/description/aliases/tags/model/provider/body）', () => {
  const { definition, error } = parse(VALID);
  assert.equal(error, null);
  assert.equal(definition.valid, true);
  assert.equal(definition.id, 'kobayashi');
  assert.equal(definition.name, '小林');
  assert.equal(definition.description, '温柔、严谨的个人助理');
  assert.deepEqual(definition.aliases, ['kobayashi', 'xiaolin'], '别名去重且保序');
  assert.deepEqual(definition.tags, ['assistant', 'engineer']);
  assert.equal(definition.model, 'deepseek-chat');
  assert.equal(definition.provider, 'deepseek');
  assert.ok(definition.body.startsWith('你是"小林"'));
  assert.ok(definition.body.includes('优先参考记忆中的画像'));
  assert.equal(definition.truncated, false);
  assert.equal(definition.valid, true);
  assert.match(definition.contentHash, /^[0-9a-f]{64}$/);
  assert.ok(definition.mtime > 0);
});

test('parser: 无 frontmatter → 正文即 body，name=id', () => {
  const { definition, error } = parse('你是一个简洁的助手。\n只说结论。', 'plain.md');
  assert.equal(error, null);
  assert.equal(definition.name, 'plain');
  assert.equal(definition.description, '');
  assert.deepEqual(definition.tags, []);
  assert.deepEqual(definition.aliases, []);
  assert.equal(definition.body, '你是一个简洁的助手。\n只说结论。');
});

test('parser: 空正文 / 空文件 → invalid 且原因明确', () => {
  const onlyFrontmatter = parse('---\nname: Empty\n---\n   \n', 'empty.md');
  assert.equal(onlyFrontmatter.definition.valid, false);
  assert.match(onlyFrontmatter.definition.invalidReason ?? '', /body is empty/);
  assert.ok(onlyFrontmatter.error);

  const emptyFile = parse('   \n', 'blank.md');
  assert.equal(emptyFile.definition.valid, false);
  assert.match(emptyFile.definition.invalidReason ?? '', /empty/);
});

test('parser: 坏 frontmatter（缺冒号 / 未闭合 / 无 key 的列表项）→ invalid', () => {
  const brokenLine = parse('---\nname 小林\n---\n正文', 'bad1.md');
  assert.equal(brokenLine.definition.valid, false);
  assert.match(brokenLine.definition.invalidReason ?? '', /invalid frontmatter/);

  const unterminated = parse('---\nname: 小林\n正文没有结束分隔符', 'bad2.md');
  assert.equal(unterminated.definition.valid, false);
  assert.match(unterminated.definition.invalidReason ?? '', /unterminated frontmatter/);

  const orphanItem = parse('---\n- 孤立列表项\n---\n正文', 'bad3.md');
  assert.equal(orphanItem.definition.valid, false);
});

test('parser: 严格 {{…}} 规则 —— 完整模板组 invalid；孤立 {{ 不触发', () => {
  const templated = parse('---\nname: T\n---\n你好 {{user.name}}，请回答。', 'tpl.md');
  assert.equal(templated.definition.valid, false);
  assert.match(templated.definition.invalidReason ?? '', /template group/);
  assert.ok(templated.error);

  const isolated = parse('---\nname: T\n---\n这里只有一个左括号 {{ 没有右括号，允许。', 'ok.md');
  assert.equal(isolated.definition.valid, true);
  assert.ok(isolated.definition.body.includes('{{'));

  // 正则语义校验：完整组命中、孤立不命中
  assert.equal(PERSONA_TEMPLATE_GROUP_RE.test('a {{b}} c'), true);
  assert.equal(PERSONA_TEMPLATE_GROUP_RE.test('a {{ b }} c'), true);
  assert.equal(PERSONA_TEMPLATE_GROUP_RE.test('a {{ b c'), false);
});

test('parser: 超长正文 → 截断 + truncated=true（其余字段仍有效）', () => {
  const body = '这是一段很长的正文。'.repeat(20);
  const { definition } = parse(`---\nname: Long\n---\n${body}`, 'long.md', 30);
  assert.equal(definition.valid, true);
  assert.equal(definition.truncated, true);
  assert.equal(definition.body.length, 30);
});

test('parser: 非法文件名 id → invalid + error（不加载）', () => {
  const tooLong = `${'x'.repeat(65)}.md`;
  for (const name of ['bad name.md', '中文.md', tooLong]) {
    const { definition, error } = parse('正文', name);
    assert.equal(definition.valid, false, `${name} 应 invalid`);
    assert.ok(error, `${name} 应有 error`);
    assert.match(definition.invalidReason ?? '', /invalid persona id/);
  }
  // 合法 id 边界
  assert.equal(PERSONA_ID_RE.test('a'), true);
  assert.equal(PERSONA_ID_RE.test('A.b_c-d.1'), true);
  assert.equal(PERSONA_ID_RE.test('-abc'), false);
  assert.equal(PERSONA_ID_RE.test('a'.repeat(65)), false);
  assert.equal(personaIdFromPath('/x/y/kobayashi.md'), 'kobayashi');
});

test('parser: frontmatter 最小 YAML 子集（引号/块状列表/行尾注释/布尔数字按字符串）', () => {
  const fm = parsePersonaFrontmatter(
    [
      '# 注释行',
      'name: "小林"',
      "description: '带引号的描述'",
      'aliases: [a, b, a]',
      'tags:',
      '  - x',
      '  - y  # 行尾注释',
      'priority: 5',
      'enabled: true',
      'unknown: whatever',
    ].join('\n'),
  );
  assert.equal(fm.name, '小林');
  assert.equal(fm.description, '带引号的描述');
  assert.deepEqual(fm.aliases, ['a', 'b']);
  assert.deepEqual(fm.tags, ['x', 'y']);
  assert.equal(fm.model, undefined);
  assert.equal(fm.provider, undefined);
});

test('parser: contentHash 确定性（同内容同 hash；正文变化 → 变化）', () => {
  const a = parse(VALID);
  const b = parse(VALID);
  assert.equal(a.definition.contentHash, b.definition.contentHash);
  const c = parse(VALID.replace('先给结论', '先给结论！'));
  assert.notEqual(a.definition.contentHash, c.definition.contentHash);
  // frontmatter 变化同样改变 hash（name/别名等）
  const d = parse(VALID.replace('name: 小林', 'name: 小林2'));
  assert.notEqual(a.definition.contentHash, d.definition.contentHash);
});

test('parser: toPersonaSummary 不含正文、保留 valid/invalidReason', () => {
  const valid = parse(VALID).definition;
  const summary = toPersonaSummary(valid);
  assert.equal(summary.id, 'kobayashi');
  assert.equal(summary.name, '小林');
  assert.equal(summary.valid, true);
  assert.equal('body' in summary, false);
  const invalid = parse('', 'empty2.md').definition;
  assert.equal(toPersonaSummary(invalid).valid, false);
  assert.ok(toPersonaSummary(invalid).invalidReason);
});

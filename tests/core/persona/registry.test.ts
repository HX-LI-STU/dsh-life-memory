/**
 * 人格注册表测试（docs/25-persona.md §3）：
 * reload/list/排序/errors、activate（id/name/alias/null/不存在/无效）、激活失效清理、
 * watch（注入 watcher + 防抖 + dispose）、目录不存在容错、lastError。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPersonaRegistry, type PersonaWatcherLike } from '../../../src/persona/index.ts';
import { silentLogger } from '../../../src/core/logger.ts';
import { TEST_NOW } from '../layers/fakes.ts';

const dirs: string[] = [];
function makeDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-mv-persona-reg-'));
  dirs.push(dir);
  return dir;
}
process.on('exit', () => {
  for (const dir of dirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

function writePersona(dir: string, fileName: string, body: string, frontmatter = ''): void {
  const content = frontmatter.length > 0 ? `---\n${frontmatter}\n---\n${body}` : body;
  writeFileSync(join(dir, fileName), content, 'utf8');
}

function createRegistry(dir: string, extra: Record<string, unknown> = {}) {
  return createPersonaRegistry({
    dir,
    config: { watch: false, maxBodyChars: 20_000 },
    logger: silentLogger,
    now: () => TEST_NOW,
    ...extra,
  });
}

test('registry: reload 加载 *.md（忽略点文件/子目录），按 name/id 稳定排序', async () => {
  const dir = makeDir();
  writePersona(dir, 'b.md', '人格 B 正文', 'name: Beta');
  writePersona(dir, 'a.md', '人格 A 正文', 'name: Alpha');
  writePersona(dir, 'no-fm.md', '无 frontmatter 人格');
  writePersona(dir, '.hidden.md', '点文件应忽略');
  writeFileSync(join(dir, 'readme.txt'), '不是 markdown', 'utf8');
  mkdirSync(join(dir, 'sub.md'), { recursive: true });
  const registry = createRegistry(dir);
  const roster = await registry.reload();
  assert.deepEqual(roster.definitions.map((definition) => definition.id), ['a', 'b', 'no-fm']);
  assert.equal(roster.definitions[0].name, 'Alpha');
  assert.deepEqual(roster.errors, []);
  assert.equal(roster.activeId, null);
  assert.equal(roster.loadedAt, TEST_NOW);
  assert.equal(registry.list().length, 3);
  assert.equal(registry.get('a')?.name, 'Alpha');
  assert.equal(registry.get('missing'), undefined);
  assert.equal(registry.lastError(), null);
  registry.dispose();
});

test('registry: 无效文件进入 errors + list（valid=false/invalidReason），非法文件名不加载', async () => {
  const dir = makeDir();
  writePersona(dir, 'ok.md', '正常人格');
  writePersona(dir, 'empty.md', '  ', 'name: Empty');
  writePersona(dir, 'bad name.md', '非法文件名');
  writePersona(dir, 'tpl.md', '你好 {{user}}');
  writePersona(dir, 'badfm.md', '正文', 'this is not yaml');
  const registry = createRegistry(dir);
  const roster = await registry.reload();
  assert.deepEqual(roster.definitions.map((definition) => definition.id).sort(), ['badfm', 'empty', 'ok', 'tpl']);
  assert.ok(roster.definitions.find((definition) => definition.id === 'empty')?.valid === false);
  assert.ok(roster.definitions.find((definition) => definition.id === 'tpl')?.invalidReason?.includes('template group'));
  assert.equal(roster.definitions.find((definition) => definition.id === 'ok')?.valid, true);
  // 非法文件名：只出现在 errors，不进入 definitions
  assert.ok(roster.errors.some((error) => error.file.endsWith('bad name.md')));
  assert.ok(!roster.definitions.some((definition) => definition.id === 'bad name'));
  // 有错误时 lastError 非空
  assert.ok((registry.lastError() ?? '').length > 0);
  registry.dispose();
});

test('registry: 目录不存在 → 空 roster + lastError，不抛错；创建目录后 reload 恢复', async () => {
  const dir = join(makeDir(), 'not-created-yet');
  const registry = createRegistry(dir);
  const roster = await registry.reload();
  assert.deepEqual(roster.definitions, []);
  assert.deepEqual(roster.errors, []);
  assert.match(registry.lastError() ?? '', /not found/);
  mkdirSync(dir, { recursive: true });
  writePersona(dir, 'a.md', '恢复后的人格');
  const reloaded = await registry.reload();
  assert.equal(reloaded.definitions.length, 1);
  registry.dispose();
});

test('registry: activate 支持 id/name/alias；null 清除；不存在/无效失败且状态不变', async () => {
  const dir = makeDir();
  writePersona(dir, 'kobayashi.md', '小林正文', 'name: 小林\naliases: [xiaolin]');
  writePersona(dir, 'other.md', '另一个人格', 'name: Other');
  writePersona(dir, 'broken.md', '正文', 'name: Broken\nbad line here');
  let persisted: string | null = null;
  const registry = createRegistry(dir, {
    getActiveId: () => persisted,
    setActiveId: (id: string | null) => {
      persisted = id;
    },
  });
  await registry.reload();

  const byId = await registry.activate('kobayashi');
  assert.equal(byId.ok, true);
  assert.equal(byId.activeId, 'kobayashi');
  assert.equal(persisted, 'kobayashi');
  assert.equal(registry.active()?.name, '小林');

  const byName = await registry.activate('Other');
  assert.equal(byName.ok, true);
  assert.equal(byName.activeId, 'other');

  const byAlias = await registry.activate('xiaolin');
  assert.equal(byAlias.ok, true);
  assert.equal(byAlias.activeId, 'kobayashi');

  const missing = await registry.activate('nope');
  assert.equal(missing.ok, false);
  assert.match(missing.error ?? '', /not found/);
  assert.equal(persisted, 'kobayashi', '失败时状态不变');

  const invalid = await registry.activate('broken');
  assert.equal(invalid.ok, false);
  assert.match(invalid.error ?? '', /invalid/);
  assert.equal(persisted, 'kobayashi');

  const cleared = await registry.activate(null);
  assert.equal(cleared.ok, true);
  assert.equal(cleared.activeId, null);
  assert.equal(persisted, null);
  assert.equal(registry.active(), null);
  assert.equal(registry.roster().activeId, null);
  registry.dispose();
});

test('registry: 重载后激活人格被删除/变无效 → 自动清除激活并记 lastError', async () => {
  const dir = makeDir();
  writePersona(dir, 'alpha.md', 'A 正文', 'name: Alpha');
  let persisted: string | null = null;
  const setCalls: Array<string | null> = [];
  const registry = createRegistry(dir, {
    getActiveId: () => persisted,
    setActiveId: (id: string | null) => {
      persisted = id;
      setCalls.push(id);
    },
  });
  await registry.reload();
  await registry.activate('alpha');
  assert.equal(registry.active()?.id, 'alpha');

  // 删除定义 → reload → 自动清除
  rmSync(join(dir, 'alpha.md'));
  await registry.reload();
  assert.equal(registry.active(), null);
  assert.equal(persisted, null);
  assert.ok(setCalls.includes(null));
  assert.match(registry.lastError() ?? '', /not found after reload/);

  // 变为无效（含 {{…}}）→ 同样清除
  writePersona(dir, 'beta.md', 'B 正文', 'name: Beta');
  await registry.reload();
  await registry.activate('beta');
  assert.equal(registry.active()?.id, 'beta');
  writePersona(dir, 'beta.md', '你好 {{user}}', 'name: Beta');
  await registry.reload();
  assert.equal(registry.active(), null);
  assert.match(registry.lastError() ?? '', /is invalid/);
  registry.dispose();
});

test('registry: watch 防抖重载（新增/修改/删除文件）与 dispose 关闭 watcher', async () => {
  const dir = makeDir();
  writePersona(dir, 'a.md', 'A 正文', 'name: Alpha');
  let listener: (() => void) | null = null;
  let closed = false;
  const watcher: PersonaWatcherLike = {
    close() {
      closed = true;
    },
  };
  const registry = createPersonaRegistry({
    dir,
    config: { watch: true, maxBodyChars: 20_000 },
    logger: silentLogger,
    now: () => TEST_NOW,
    debounceMs: 5,
    watchFactory: (_dir, onChange) => {
      listener = onChange;
      return watcher;
    },
  });
  await registry.reload();
  assert.equal(registry.list().length, 1);
  assert.ok(listener, '应注册 watcher');
  writePersona(dir, 'b.md', 'B 正文', 'name: Beta');
  (listener as unknown as () => void)();
  (listener as unknown as () => void)(); // 防抖：两次触发只 reload 一次也无妨
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.deepEqual(registry.list().map((definition) => definition.id).sort(), ['a', 'b']);

  registry.dispose();
  assert.equal(closed, true, 'dispose 应关闭 watcher');
  writePersona(dir, 'c.md', 'C 正文', 'name: Gamma');
  (listener as unknown as () => void)();
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(registry.list().length, 2, 'dispose 后不再热重载');
});

test('registry: watch=true 且目录不存在 → 不抛错，lastError 记录', async () => {
  const dir = join(makeDir(), 'missing-dir');
  const registry = createPersonaRegistry({
    dir,
    config: { watch: true, maxBodyChars: 20_000 },
    logger: silentLogger,
    now: () => TEST_NOW,
    debounceMs: 5,
  });
  assert.match(registry.lastError() ?? '', /not found|watch/);
  const roster = await registry.reload();
  assert.deepEqual(roster.definitions, []);
  registry.dispose();
});

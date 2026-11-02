/**
 * 冒烟测试：验证 Node 24 工具链（node:sqlite / TS type stripping / node:test）
 * 与配置合并逻辑。运行：
 *   node tests/run.mjs tests/core
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_CONFIG, mergeConfig, resolveConfig } from '../../src/config.ts';
import type { MemoryVaultConfig } from '../../src/core/contracts.ts';

test('node:sqlite is available with FTS5', () => {
  // 动态 import，避免类型检查阶段解析 node:sqlite 的 ExperimentalWarning 类型问题
  const { DatabaseSync } = process.getBuiltinModule('node:sqlite');
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE t (a TEXT)');
  db.prepare('INSERT INTO t VALUES (?)').run('hello');
  const rows = db.prepare('SELECT a FROM t').all();
  assert.equal(rows.length, 1);
  db.exec('CREATE VIRTUAL TABLE fts USING fts5(content)');
  db.prepare('INSERT INTO fts VALUES (?)').run('记忆库 memory vault');
  const hit = db.prepare("SELECT rowid FROM fts WHERE fts MATCH 'memory'").all();
  assert.equal(hit.length, 1);
  db.close();
});

test('config: defaults and deep merge', () => {
  const partial = { scope: 'workspace' as const, recall: { promptBudgetTokens: 1234 } };
  const merged: MemoryVaultConfig = mergeConfig(partial);
  assert.equal(merged.scope, 'workspace');
  assert.equal(merged.recall.promptBudgetTokens, 1234);
  // 未覆盖的嵌套字段保留默认
  assert.equal(merged.recall.toolDefaultLimit, DEFAULT_CONFIG.recall.toolDefaultLimit);
  assert.equal(merged.layers.enabled.length, 3);
});

test('config: resolveConfig resolves paths/timezone and validates', () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-mv-'));
  const cfg = resolveConfig(
    { scope: 'global', embedding: { provider: 'local', dim: 256 } },
    { dshHome: home, timezone: 'Asia/Shanghai' },
  );
  assert.equal(cfg.timezone, 'Asia/Shanghai');
  assert.equal(cfg.embedding.dim, 256);
  assert.ok(cfg.dataDir.endsWith('life-memory'));
  const wsCfg = resolveConfig({ scope: 'workspace' }, { dshHome: home, timezone: 'UTC', workspace: home });
  assert.ok(wsCfg.dataDir.includes('.dsh-life-memory'));
  assert.throws(() => resolveConfig({ embedding: { provider: 'openai-compatible' } }, { dshHome: home }), /baseURL/);
  // 远程嵌入需要显式允许联网
  assert.throws(
    () =>
      resolveConfig(
        { embedding: { provider: 'openai-compatible', baseURL: 'https://api.example.com/v1' } },
        { dshHome: home },
      ),
    /allowNetwork/,
  );
  const remoteOk = resolveConfig(
    {
      embedding: { provider: 'openai-compatible', baseURL: 'https://api.example.com/v1' },
      safety: { allowNetwork: true },
    },
    { dshHome: home },
  );
  assert.equal(remoteOk.safety.allowNetwork, true);
  // recall 新字段默认值
  assert.equal(remoteOk.recall.mmr.enabled, true);
  assert.equal(remoteOk.recall.layerPrior.L3, 1);
  assert.equal(remoteOk.consolidation.enabled, false);
  assert.throws(() => resolveConfig({ timezone: 'Not/AZone' }, { dshHome: home }), /timezone/);
});

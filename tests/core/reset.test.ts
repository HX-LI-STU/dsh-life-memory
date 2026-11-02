import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  applyPendingReset,
  pendingResetRequested,
  RESET_MARKER_FILE,
} from '../../src/vaults/index.ts';

test('reset: .reset-requested → 备份活动数据并清空；配置文件保留；幂等', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'mv-reset-'));
  mkdirSync(join(dataDir, 'vaults', 'shared'), { recursive: true });
  writeFileSync(join(dataDir, 'vaults', 'shared', 'vault.db'), 'db');
  mkdirSync(join(dataDir, 'exports', 'sessions'), { recursive: true });
  writeFileSync(join(dataDir, 'exports', 'sessions', 'x.jsonl'), 'x');
  writeFileSync(join(dataDir, 'vault.db'), 'oldroot');
  writeFileSync(join(dataDir, 'session-config.json'), '{"version":1}');
  writeFileSync(join(dataDir, 'active-persona.json'), '{"personaId":"p"}');

  // 无标记 → no-op
  assert.equal(pendingResetRequested(dataDir), false);
  const noop = applyPendingReset(dataDir);
  assert.equal(noop.applied, false);
  assert.equal(existsSync(join(dataDir, 'vaults', 'shared', 'vault.db')), true);

  // 有标记 → 备份 + 清空
  writeFileSync(join(dataDir, RESET_MARKER_FILE), 'requested');
  assert.equal(pendingResetRequested(dataDir), true);
  const result = applyPendingReset(dataDir, { now: () => 1_790_000_000_000 });
  assert.equal(result.applied, true);
  assert.ok(result.backupDir && result.backupDir.startsWith(dataDir));
  assert.deepEqual([...result.movedEntries].sort(), ['exports', 'vault.db', 'vaults']);
  assert.equal(existsSync(join(result.backupDir!, 'vaults', 'shared', 'vault.db')), true);
  assert.equal(existsSync(join(result.backupDir!, 'exports', 'sessions', 'x.jsonl')), true);
  assert.equal(existsSync(join(result.backupDir!, 'vault.db')), true);
  assert.equal(existsSync(join(dataDir, 'vaults')), false);
  assert.equal(existsSync(join(dataDir, 'exports')), false);
  assert.equal(existsSync(join(dataDir, 'vault.db')), false);
  assert.equal(existsSync(join(dataDir, RESET_MARKER_FILE)), false);

  // 配置保留
  assert.equal(readFileSync(join(dataDir, 'session-config.json'), 'utf8'), '{"version":1}');
  assert.equal(readFileSync(join(dataDir, 'active-persona.json'), 'utf8'), '{"personaId":"p"}');

  // 再次执行 → no-op
  assert.equal(applyPendingReset(dataDir).applied, false);
});

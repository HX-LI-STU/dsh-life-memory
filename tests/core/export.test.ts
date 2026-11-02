/**
 * v6：原始会话 / 原始数据库 导入导出（src/export/**）。
 *
 * 覆盖：
 *   - exportSessionArchive：header 格式/字段、L0 全文、location、sha256；
 *   - importSessionArchive：新 id + payload.importedFrom/originalSessionId、只追加、
 *     链继续、篡改归档被拒绝且不写数据；
 *   - exportVaultArchive / importVaultArchive：目录快照（VERSION/manifest/vault.db/segments）、
 *     导入为新库后可打开且计数一致、目标/保留 id 冲突拒绝。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { RawRecordInput } from '../../src/core/contracts.ts';
import { openStore } from '../../src/store/index.ts';
import { openVault } from '../../src/vault/index.ts';
import {
  SESSION_ARCHIVE_FORMAT,
  SessionArchiveError,
  exportSessionArchive,
  exportVaultArchive,
  importSessionArchive,
  importVaultArchive,
} from '../../src/export/index.ts';

const TZ = 'Asia/Shanghai';
const BASE_TS = Date.UTC(2026, 9, 26, 2, 0, 0);

const tmpDirs: string[] = [];
function tmpRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-mv-export-'));
  tmpDirs.push(dir);
  return dir;
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

function mkInput(overrides: Partial<RawRecordInput> = {}): RawRecordInput {
  return {
    kind: 'user',
    ts: BASE_TS,
    timezone: TZ,
    sessionId: 'sess_a',
    workspace: 'D:\\work\\proj',
    role: 'user',
    text: 'hello 记忆归档',
    payload: { eventType: 'message', nested: { text: '记忆' } },
    tags: ['role:user'],
    ...overrides,
  };
}

async function openPair(root: string) {
  const store = openStore({ dataDir: root, timezone: TZ });
  const vault = await openVault({ rootDir: root, timezone: TZ, fsync: false }, { writerInfo: false });
  return { store, vault };
}

function readArchiveLines(file: string): Array<Record<string, unknown>> {
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

test('export/import session archive: header, full L0, new ids, importedFrom, append-only', async () => {
  const root = tmpRoot();
  const { store, vault } = await openPair(root);
  const appended = await vault.append([
    mkInput({ ts: BASE_TS, sessionId: 'sess_a' }),
    mkInput({ kind: 'assistant', role: 'assistant', text: 'big ' + 'x'.repeat(9000), ts: BASE_TS + 1000, sessionId: 'sess_a' }),
    mkInput({ ts: BASE_TS + 2000, sessionId: 'sess_b' }),
  ]);
  store.indexRawRecords(appended.items);
  assert.deepEqual(await vault.verify(), { ok: true, checked: 3 });
  const originalIds = appended.items.map((item) => item.record.id);

  // 1) 导出 sess_a（2 条原始记录，0 条派生记忆）
  const exported = await exportSessionArchive({
    vaultDir: root,
    store,
    vault,
    sessionId: 'sess_a',
    dataDir: root,
    vaultId: 'shared',
    personaId: null,
    now: BASE_TS + 5000,
  });
  assert.equal(exported.rawCount, 2);
  assert.equal(exported.memoryCount, 0);
  assert.equal(exported.bytes > 0, true);
  assert.match(exported.sha256, /^[0-9a-f]{64}$/);
  assert.ok(existsSync(exported.file));
  assert.ok(exported.file.includes(join('exports', 'sessions')));
  assert.equal(exported.segments.length >= 1, true);

  const lines = readArchiveLines(exported.file);
  const header = lines[0];
  assert.equal(header.format, SESSION_ARCHIVE_FORMAT);
  assert.equal(header.version, 1);
  assert.equal(header.sessionId, 'sess_a');
  assert.equal(header.vaultId, 'shared');
  assert.equal(header.personaId, null);
  assert.equal(header.rawCount, 2);
  assert.equal((header.segments as unknown[]).length >= 1, true);
  assert.equal((header.hashChain as unknown[]).length, 2);
  assert.equal(lines.length, 3); // header + 2 raw（无 memory 行）

  const firstRaw = lines[1];
  assert.equal(firstRaw.id, originalIds[0]);
  assert.equal(firstRaw.sessionId, 'sess_a');
  assert.equal((firstRaw.payload as Record<string, unknown>).eventType, 'message');
  assert.equal(typeof firstRaw.prevHash, 'string');
  assert.equal(typeof firstRaw.hash, 'string');
  assert.ok(firstRaw.location !== null && typeof firstRaw.location === 'object');
  // 大 text 不截断
  assert.equal(String(lines[2].text).length, 'big '.length + 9000);
  // 链清单与 raw 行一致
  assert.deepEqual(
    (header.hashChain as Array<{ id: string; hash: string }>).map((entry) => entry.id),
    [originalIds[0], originalIds[1]],
  );

  // 2) 导入到同库新会话（只追加）
  const imported = await importSessionArchive({
    targetVaultDir: root,
    store,
    vault,
    file: exported.file,
    newSessionId: 'import-sess-a',
    now: BASE_TS + 6000,
  });
  assert.equal(imported.rawCount, 2);
  assert.equal(imported.newSessionId, 'import-sess-a');
  assert.equal(imported.mapping.length, 2);
  assert.equal(imported.mapping[0].from, originalIds[0]);
  assert.notEqual(imported.mapping[0].to, imported.mapping[0].from);
  assert.equal(imported.mapping[0].seq, 4);
  assert.equal(imported.segmentsWritten.length >= 1, true);
  assert.ok(imported.segmentsWritten.every((segment) => segment.includes('/import-sess-a/')));

  // 原数据不变 + 新数据独立成会话
  assert.deepEqual(await vault.verify(), { ok: true, checked: 5 });
  assert.equal((await vault.stats()).records, 5);
  for (const id of originalIds) assert.notEqual(await vault.get(id), null);
  const importedRecord = await vault.get(imported.mapping[0].to);
  assert.ok(importedRecord !== null);
  assert.equal(importedRecord.sessionId, 'import-sess-a');
  const importedPayload = importedRecord.payload as Record<string, unknown>;
  assert.equal(importedPayload.importedFrom, originalIds[0]);
  assert.equal(importedPayload.originalSessionId, 'sess_a');
  assert.equal(importedPayload.eventType, 'message'); // 原 payload 字段保留
  assert.equal((await vault.list({ sessionId: 'import-sess-a' })).total, 2);

  // 3) 篡改归档（改 text 不改 hash）必须被拒绝，且不写任何数据
  const tampered = readArchiveLines(exported.file);
  tampered[1].text = 'tampered text';
  const tamperedFile = join(root, 'tampered.jsonl');
  writeFileSync(tamperedFile, `${tampered.map((line) => JSON.stringify(line)).join('\n')}\n`);
  const beforeTamper = (await vault.stats()).records;
  await assert.rejects(
    () => importSessionArchive({ targetVaultDir: root, store, vault, file: tamperedFile }),
    (error: unknown) => error instanceof SessionArchiveError && error.code === 'E_ARCHIVE_INVALID',
  );
  assert.equal((await vault.stats()).records, beforeTamper);
  assert.deepEqual(await vault.verify(), { ok: true, checked: beforeTamper });

  await vault.close();
  store.close();
});

test('export/import vault archive: snapshot files, new vault id, counts match, no overwrite', async () => {
  const dataDir = tmpRoot();
  const sharedDir = join(dataDir, 'vaults', 'shared');
  const { store, vault } = await openPair(sharedDir);
  const appended = await vault.append([
    mkInput({ ts: BASE_TS }),
    mkInput({ ts: BASE_TS + 1, kind: 'assistant', text: 'ok' }),
  ]);
  store.indexRawRecords(appended.items);
  assert.deepEqual(await vault.verify(), { ok: true, checked: 2 });

  // 派生记忆（让 memoryCount > 0，验证 WAL 快照被完整复制/回放）
  store.upsertMemory({
    layer: 'L3',
    kind: 'fact',
    text: '导出快照里的记忆',
    sourceRawIds: [appended.items[0].record.id],
    sessionId: 'sess_a',
    importance: 0.8,
    confidence: 0.9,
    tags: ['export'],
    createdAt: BASE_TS,
  });
  assert.equal(store.storageStats().memoryCount, 1);

  const exported = await exportVaultArchive({ dataDir, vaultId: 'shared', store, now: BASE_TS + 10_000 });
  assert.ok(existsSync(exported.dir));
  assert.equal(exported.rawCount, 2);
  assert.equal(exported.segments >= 1, true);
  assert.match(exported.sha256, /^[0-9a-f]{64}$/);
  assert.ok(exported.bytes > 0);
  const paths = exported.files.map((file) => file.path);
  assert.ok(paths.includes('VERSION'));
  assert.ok(paths.includes('manifest.json'));
  assert.ok(paths.includes('vault.db'));
  assert.ok(paths.some((path) => path.startsWith('segments/')));
  for (const file of exported.files) assert.match(file.sha256, /^[0-9a-f]{64}$/);
  assert.equal(
    exported.bytes,
    exported.files.reduce((sum, file) => sum + file.bytes, 0),
  );

  // 导入为新库 id：目录新建、计数一致、可打开且链完整
  const imported = await importVaultArchive({
    dataDir,
    targetVaultId: 'copy-one',
    path: exported.dir,
    timezone: TZ,
  });
  assert.equal(imported.vaultId, 'copy-one');
  assert.equal(imported.rawCount, 2);
  assert.equal(imported.memoryCount, exported.memoryCount);
  assert.equal(imported.days, 1);
  assert.ok(existsSync(join(dataDir, 'vaults', 'copy-one', 'manifest.json')));
  assert.ok(existsSync(join(dataDir, 'vaults', 'copy-one', 'vault.db')));
  const copyVault = await openVault(
    { rootDir: join(dataDir, 'vaults', 'copy-one'), timezone: TZ, fsync: false },
    { writerInfo: false },
  );
  assert.deepEqual(await copyVault.verify(), { ok: true, checked: 2 });
  assert.equal((await copyVault.stats()).records, 2);
  await copyVault.close();

  // 目标已存在 / 保留 id：拒绝且不覆盖
  await assert.rejects(
    () => importVaultArchive({ dataDir, targetVaultId: 'copy-one', path: exported.dir, timezone: TZ }),
    (error: unknown) => error instanceof SessionArchiveError && error.code === 'E_VAULT_EXISTS',
  );
  await assert.rejects(
    () => importVaultArchive({ dataDir, targetVaultId: 'shared', path: exported.dir, timezone: TZ }),
    (error: unknown) => error instanceof SessionArchiveError && error.code === 'E_BAD_ARGS',
  );
  await assert.rejects(
    () => importVaultArchive({ dataDir, targetVaultId: 'bad id', path: exported.dir, timezone: TZ }),
    (error: unknown) => error instanceof SessionArchiveError && error.code === 'E_BAD_ARGS',
  );
  // 归档目录结构缺失：拒绝
  const brokenDir = join(dataDir, 'exports', 'broken-archive');
  await assert.rejects(
    () => importVaultArchive({ dataDir, targetVaultId: 'copy-two', path: brokenDir, timezone: TZ }),
    (error: unknown) => error instanceof SessionArchiveError && error.code === 'E_ARCHIVE_NOT_FOUND',
  );

  await vault.close();
  store.close();
});

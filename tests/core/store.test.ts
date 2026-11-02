/**
 * SQLite MemoryStore 测试：
 *   - schema 与 docs/21-schema.sql 逐字节对账 + PRAGMA/迁移账本/幂等打开；
 *   - raw_index 只读镜像 + 触发器不可变 + 幂等收养；
 *   - upsertMemory 插入/幂等/更新/去重重述/取代链/版本快照/校验；
 *   - 向量 BLOB 往返/幂等替换/余弦检索/filters；
 *   - 中文二元组 FTS 检索（AND/OR 降级/LIKE 单字降级）；
 *   - 层/统计/治理/水位/clearLayer/L2・L3 私有表/完整性记录/事务回滚。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import type {
  MemoryStore,
  NewMemoryRecord,
  RawAppendItem,
  RawRecordInput,
} from '../../src/core/contracts.ts';
import { contentHash, sha256Hex } from '../../src/core/hash.ts';
import { isMemoryId } from '../../src/core/ids.ts';
import { silentLogger } from '../../src/core/logger.ts';
import { textToTextSeg } from '../../src/core/text.ts';
import { openRawVault, serializeRecordLine } from '../../src/vault/index.ts';
import {
  CONNECTION_PRAGMAS,
  MIGRATION_2_SHA256,
  MIGRATION_2_SQL,
  MIGRATION_3_SHA256,
  MIGRATION_3_SQL,
  MIGRATION_4_SHA256,
  MIGRATION_4_SQL,
  SCHEMA_V1_DOC_SHA256,
  SCHEMA_V1_SHA256,
  SCHEMA_V1_SQL,
  STORE_SCHEMA_VERSION,
  openStore,
} from '../../src/store/index.ts';

const TZ = 'Asia/Shanghai';
const BASE_TS = Date.UTC(2026, 9, 25, 7, 0, 0);

const tmpDirs: string[] = [];
function tmpDataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-mv-store-'));
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

function db(store: MemoryStore): DatabaseSync {
  return store.db as DatabaseSync;
}

function mkRawInput(overrides: Partial<RawRecordInput> = {}): RawRecordInput {
  return {
    kind: 'user',
    ts: BASE_TS,
    timezone: TZ,
    sessionId: 'sess_1',
    workspace: 'D:\\work\\proj',
    role: 'user',
    text: 'hello world',
    payload: { message: 'hello world' },
    tags: ['role:user'],
    ...overrides,
  };
}

async function seedRaws(
  store: MemoryStore,
  dataDir: string,
  inputs: RawRecordInput[],
): Promise<RawAppendItem[]> {
  const vault = await openRawVault(
    {
      rootDir: dataDir,
      timezone: TZ,
      fsync: false,
      seenIngestKeys: (key) => store.hasRawIngestKey(key),
    },
    { writerInfo: false },
  );
  try {
    const result = await vault.append(inputs);
    store.indexRawRecords(result.items);
    return result.items;
  } finally {
    await vault.close();
  }
}

function memoryId(seed: number, layer = 'L3', kind = 'preference'): string {
  return `${layer}-${kind}-m9k2x1-${sha256Hex(String(seed)).slice(0, 8)}`;
}

const REF_512 = { model: 'dsh-local-hash-v1', dim: 512, version: '1' };

test('store: schema matches docs/21-schema.sql, PRAGMAs, migrations ledger, reopen idempotent', () => {
  const docs21Path = 'docs/21-schema.sql';
  const docsSql = existsSync(docs21Path) ? readFileSync(docs21Path, 'utf8') : null;
  assert.equal(sha256Hex(SCHEMA_V1_SQL), SCHEMA_V1_SHA256, 'embedded DDL sha256 changed');
  if (docsSql !== null) {
    assert.equal(sha256Hex(docsSql), SCHEMA_V1_DOC_SHA256, 'docs/21-schema.sql changed: regenerate src/store/schema.ts');
    assert.ok(docsSql.includes(SCHEMA_V1_SQL), 'embedded DDL must be a byte-exact slice of docs/21-schema.sql');
  }

  const dataDir = tmpDataDir();
  const store = openStore({ dataDir, timezone: TZ });
  const conn = db(store);
  assert.ok(existsSync(join(dataDir, 'vault.db')));
  assert.equal(Number((conn.prepare('PRAGMA user_version').get() as { user_version: number }).user_version), STORE_SCHEMA_VERSION);
  const journal = (conn.prepare('PRAGMA journal_mode').get() as { journal_mode: string }).journal_mode;
  assert.equal(journal, 'wal');
  const fk = (conn.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number }).foreign_keys;
  assert.equal(Number(fk), 1);
  const busy = (conn.prepare('PRAGMA busy_timeout').get() as { timeout: number }).timeout;
  assert.equal(Number(busy), 5000);

  const objects = conn
    .prepare("SELECT name, type FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND name NOT LIKE '%_data' AND name NOT LIKE '%_idx' AND name NOT LIKE '%_content' AND name NOT LIKE '%_docsize' AND name NOT LIKE '%_config'")
    .all() as Array<{ name: string; type: string }>;
  const names = new Set(objects.map((row) => row.name));
  for (const table of [
    'meta',
    'schema_migrations',
    'counters',
    'embedding_models',
    'layers',
    'raw_index',
    'raw_segments',
    'raw_fts',
    'memory_records',
    'memory_fts',
    'memory_revisions',
    'memory_sources',
    'layer_l2_episodes',
    'layer_l3_semantic',
    'entities',
    'relations',
    'vectors',
    'derive_cursors',
    'derive_jobs',
    'integrity_runs',
    'repair_log',
  ]) {
    assert.ok(names.has(table), `missing table ${table}`);
  }
  for (const view of ['v_layer_stats', 'v_retention_stats', 'v_memory_active', 'v_raw_recent', 'v_embedding_coverage', 'v_missing_vectors']) {
    assert.ok(names.has(view), `missing view ${view}`);
  }
  for (const trigger of [
    'tr_raw_index_no_update',
    'tr_raw_index_no_delete',
    'tr_memory_fts_ai',
    'tr_memory_fts_ad',
    'tr_memory_fts_au',
    'tr_l3_long_no_delete',
    'tr_raw_vectors_no_update',
    'tr_raw_vectors_no_delete',
  ]) {
    assert.ok(names.has(trigger), `missing trigger ${trigger}`);
  }

  const migration = conn
    .prepare('SELECT version, applied_at, checksum FROM schema_migrations WHERE version = 1')
    .get() as { version: number; applied_at: number; checksum: string };
  assert.equal(Number(migration.version), 1);
  assert.equal(migration.checksum, SCHEMA_V1_SHA256);
  assert.ok(Number(migration.applied_at) > 0);
  const migration2 = conn
    .prepare('SELECT version, applied_at, checksum FROM schema_migrations WHERE version = 2')
    .get() as { version: number; applied_at: number; checksum: string };
  assert.equal(Number(migration2.version), 2);
  assert.equal(migration2.checksum, MIGRATION_2_SHA256);
  assert.ok(Number(migration2.applied_at) > 0);
  const migration3 = conn
    .prepare('SELECT version, applied_at, checksum FROM schema_migrations WHERE version = 3')
    .get() as { version: number; applied_at: number; checksum: string };
  assert.equal(Number(migration3.version), 3);
  assert.equal(migration3.checksum, MIGRATION_3_SHA256);
  assert.ok(Number(migration3.applied_at) > 0);

  // migration 3：raw 向量索引 + 遗忘索引（docs/24）
  const v3Objects = new Set(
    (
      conn
        .prepare("SELECT name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'")
        .all() as Array<{ name: string }>
    ).map((row) => row.name),
  );
  for (const name of ['ix_vectors_owner_kind', 'ix_mem_forget']) {
    assert.ok(v3Objects.has(name), 'missing index ' + name);
  }
  assert.ok(!v3Objects.has('tr_l3_no_delete'), 'old broad L3 delete trigger must be dropped');
  const docs24Path = 'docs/24-memory-access-forgetting.md';
  const docs24 = existsSync(docs24Path) ? readFileSync(docs24Path, 'utf8') : null;
  assert.equal(sha256Hex(MIGRATION_3_SQL), MIGRATION_3_SHA256, 'embedded migration 3 sha256 changed');
  if (docs24 !== null) {
    for (const fragment of [
      "owner_kind='raw'",
      'rebuildRawVectors',
      'forgetDerivedMemories',
      'searchRawVector',
      'INSERT OR IGNORE',
    ]) {
      assert.ok(docs24.includes(fragment), 'docs/24 missing fragment: ' + fragment);
    }
  }
  // DDL 名称以 migration 3 常量为准（docs/24 是设计说明，不逐字复制 SQL）
  for (const fragment of [
    'ix_vectors_owner_kind',
    'ix_mem_forget',
    'tr_raw_vectors_no_update',
    'tr_raw_vectors_no_delete',
    'tr_l3_long_no_delete',
  ]) {
    assert.ok(MIGRATION_3_SQL.includes(fragment), 'migration 3 SQL missing ' + fragment);
  }
  const migration4 = conn
    .prepare('SELECT version, applied_at, checksum FROM schema_migrations WHERE version = 4')
    .get() as { version: number; applied_at: number; checksum: string };
  assert.equal(Number(migration4.version), 4);
  assert.equal(migration4.checksum, MIGRATION_4_SHA256);
  assert.ok(Number(migration4.applied_at) > 0);

  // migration 4：人格（persona）作用域列/索引（docs/25 §7）
  const memoryColumnNames = (
    conn.prepare('PRAGMA table_info(memory_records)').all() as Array<{ name: string }>
  ).map((column) => column.name);
  const rawColumnNames = (conn.prepare('PRAGMA table_info(raw_index)').all() as Array<{ name: string }>).map(
    (column) => column.name,
  );
  assert.ok(memoryColumnNames.includes('persona_id'));
  assert.ok(rawColumnNames.includes('persona_id'));
  for (const name of ['ix_mem_persona', 'ix_raw_persona']) {
    assert.ok(v3Objects.has(name), 'missing persona index ' + name);
  }
  const docs25Path = 'docs/25-persona.md';
  const docs25 = existsSync(docs25Path) ? readFileSync(docs25Path, 'utf8') : null;
  assert.equal(sha256Hex(MIGRATION_4_SQL), MIGRATION_4_SHA256, 'embedded migration 4 sha256 changed');
  if (docs25 !== null) {
    for (const fragment of [
      'persona_id',
      'ix_mem_persona',
      'ix_raw_persona',
      'countMemoriesByPersona',
      'persona.active',
    ]) {
      assert.ok(docs25.includes(fragment), 'docs/25 missing fragment: ' + fragment);
    }
  }

  const vaultId = store.getMeta('vault_id');
  assert.ok(vaultId !== null && vaultId.length >= 32);
  assert.equal(store.getMeta('schema_version'), String(STORE_SCHEMA_VERSION));
  assert.equal(store.getMeta('embedding_model'), 'dsh-local-hash-v1');
  assert.equal(store.getMeta('embedding_dim'), '512');
  assert.equal(store.getMeta('timezone'), TZ);
  assert.deepEqual(store.listLayers().map((layer) => layer.id), ['L1', 'L2', 'L3']);
  // docs/23-memory-models §2：内置层显示名统一（layers 表是 tool/UI 的显示名来源）
  assert.deepEqual(
    store.listLayers().map((layer) => layer.name),
    ['L1 工作记忆层', 'L2 情景记忆层', 'L3 语义记忆层'],
  );
  const builtinNames = conn
    .prepare("SELECT id, name FROM layers WHERE kind = 'builtin' ORDER BY id")
    .all() as Array<{ id: string; name: string }>;
  assert.deepEqual(
    builtinNames.map((row) => [row.id, row.name]),
    [
      ['L1', 'L1 工作记忆层'],
      ['L2', 'L2 情景记忆层'],
      ['L3', 'L3 语义记忆层'],
    ],
  );
  assert.equal(store.storageStats().schemaVersion, STORE_SCHEMA_VERSION);
  assert.ok(store.storageStats().dbBytes > 0);
  store.close();

  const reopened = openStore({ dataDir, timezone: TZ });
  assert.equal(reopened.getMeta('vault_id'), vaultId);
  assert.equal(reopened.storageStats().memoryCount, 0);
  assert.deepEqual(
    reopened.listLayers().map((layer) => layer.name),
    ['L1 工作记忆层', 'L2 情景记忆层', 'L3 语义记忆层'],
  );
  reopened.close();
});

test('store: raw_index mirror fields, filters, FTS, immutability triggers, idempotent adoption', async () => {
  const dataDir = tmpDataDir();
  const store = openStore({ dataDir, timezone: TZ });
  const items = await seedRaws(store, dataDir, [
    mkRawInput({ text: '我喜欢用深色主题', payload: { b: 1, a: 2 }, ts: BASE_TS }),
    mkRawInput({ kind: 'assistant', role: 'assistant', text: 'the quick brown fox', ts: BASE_TS + 1000, sessionId: 'sess_2' }),
    mkRawInput({ kind: 'tool_result', role: 'tool', text: 'tool output 记忆库', ts: BASE_TS + 2000 }),
  ]);
  assert.equal(store.storageStats().rawCount, 3);
  assert.equal(store.storageStats().segmentCount, 2);

  const row = store.getRawIndex(items[0].record.id);
  assert.ok(row !== null);
  assert.equal(row?.seq, 1);
  assert.equal(row?.day, '2026-10-25');
  assert.equal(row?.sessionId, 'sess_1');
  assert.equal(row?.segment, items[0].location.segment);
  assert.equal(row?.lineNo, items[0].location.lineNo);
  assert.equal(row?.byteOffset, items[0].location.byteOffset);
  assert.equal(row?.byteLen, items[0].location.byteLen);
  assert.equal(row?.ingestKey, items[0].location.ingestKey);
  assert.equal(row?.textSeg, textToTextSeg('我喜欢用深色主题'));
  assert.equal(row?.payloadJson, JSON.stringify(items[0].record.payload));
  assert.equal(row?.recordVersion, 1);
  assert.ok((row?.createdAt ?? 0) > 0);
  assert.equal(store.getRawIndex('2026-10-25-999999'), null);

  const page = store.listRawIndex({ limit: 2 });
  assert.equal(page.total, 3);
  assert.equal(page.records.length, 2);
  assert.equal(page.records[0].payloadJson, ''); // list 不返回大 payload（详情走文件）
  assert.deepEqual(
    store.listRawIndex({ kinds: ['assistant'] }).records.map((entry) => entry.seq),
    [2],
  );
  assert.equal(store.listRawIndex({ sessionId: 'sess_2' }).total, 1);
  assert.equal(store.listRawIndex({ from: BASE_TS + 1000 }).total, 2);
  assert.equal(store.listRawIndex({ day: '2026-10-25' }).total, 3);
  assert.equal(store.listRawIndex({ day: '2026-10-26' }).total, 0);
  assert.deepEqual(
    store.listRawIndex({ desc: true, limit: 2 }).records.map((entry) => entry.seq),
    [3, 2],
  );
  assert.deepEqual(
    store.listRawIndex({ ids: [items[2].record.id] }).records.map((entry) => entry.id),
    [items[2].record.id],
  );

  // 中文 bigram FTS 命中（raw_fts 由 indexRawRecords 写入）
  const conn = db(store);
  const ftsHits = conn
    .prepare("SELECT rowid FROM raw_fts WHERE raw_fts MATCH ?")
    .all('"深色"') as Array<{ rowid: number }>;
  assert.deepEqual(ftsHits.map((hit) => Number(hit.rowid)), [1]);
  assert.equal(store.hasRawIngestKey(items[1].location.ingestKey), true);
  assert.equal(store.hasRawIngestKey('auto:nope'), false);

  // 幂等：重复收养不新增行/段统计/FTS
  store.indexRawRecords(items);
  assert.equal(store.storageStats().rawCount, 3);
  const segmentRow = conn
    .prepare('SELECT records FROM raw_segments WHERE segment = ?')
    .get(items[0].location.segment) as { records: number } | undefined;
  // v2 会话分目录：items[0] 所在段只含 sess_1 的 2 条记录（第 3 条在 sess_2 的段里）
  assert.equal(Number(segmentRow?.records), 2);
  const segmentTotal = (conn.prepare('SELECT SUM(records) AS n FROM raw_segments').get() as { n: number }).n;
  assert.equal(Number(segmentTotal), 3);
  const ftsCount = conn.prepare('SELECT COUNT(*) AS n FROM raw_fts').get() as { n: number };
  assert.equal(Number(ftsCount.n), 3);

  // 不可变性：触发器拒绝 UPDATE/DELETE
  assert.throws(
    () => conn.prepare('UPDATE raw_index SET text = ? WHERE id = ?').run('tampered', items[0].record.id),
    /append-only/,
  );
  assert.throws(() => conn.prepare('DELETE FROM raw_index WHERE id = ?').run(items[0].record.id), /append-only/);
  store.close();
});

test('store: upsertMemory insert / idempotent / update / restate / supersede / validation', async () => {
  const dataDir = tmpDataDir();
  const store = openStore({ dataDir, timezone: TZ });
  const raws = await seedRaws(store, dataDir, [
    mkRawInput({ text: '我喜欢用深色主题' }),
    mkRawInput({ text: '请默认深色模式', ts: BASE_TS + 1000 }),
  ]);
  const rawIds = raws.map((item) => item.record.id);

  const id = memoryId(1);
  const base: NewMemoryRecord = {
    id,
    layer: 'L3',
    kind: 'preference',
    text: '用户偏好深色主题',
    summary: '深色偏好',
    importance: 0.8,
    confidence: 0.9,
    sourceRawIds: rawIds,
    sessionId: 'sess_1',
    workspace: 'D:\\work\\proj',
    tags: ['theme', 'ui'],
    validFrom: BASE_TS,
    meta: { canonicalKey: 'user.pref.theme=dark' },
  };
  const inserted = store.upsertMemory(base);
  assert.equal(inserted.id, id);
  assert.equal(inserted.revision, 1);
  assert.equal(inserted.layer, 'L3');
  assert.equal(inserted.kind, 'preference');
  assert.deepEqual(inserted.sourceRawIds, rawIds);
  assert.deepEqual(inserted.tags, ['theme', 'ui']);
  assert.deepEqual(inserted.meta, { canonicalKey: 'user.pref.theme=dark' });
  assert.equal(inserted.contentHash, contentHash('L3', 'preference', '用户偏好深色主题'));
  assert.equal(inserted.embedding, null);
  assert.equal(inserted.status, 'active');
  assert.ok((inserted.heat ?? 0) >= 0 && (inserted.heat ?? 0) <= 1);
  assert.ok(inserted.createdAt >= BASE_TS);

  // 同 id 同内容 => 幂等 NOOP（revision 不变）
  const noop = store.upsertMemory(base);
  assert.equal(noop.revision, 1);
  assert.equal(store.storageStats().memoryCount, 1);

  // 同 id + 变更 validTo => 更新路径：revision++ 且写旧版本快照
  const updated = store.upsertMemory({ ...base, validTo: BASE_TS + 5000 });
  assert.equal(updated.revision, 2);
  assert.equal(updated.validTo, BASE_TS + 5000);
  const revisions = store.listRevisions(id);
  assert.equal(revisions.length, 1);
  assert.equal(revisions[0].revision, 1);
  assert.equal(revisions[0].changeKind, 'update');
  assert.equal(revisions[0].validTo, null);
  assert.equal(revisions[0].text, '用户偏好深色主题');

  // 不同显式 id、同层同内容 => 重述不新增行（返回已有 id；新来源被追加）
  const duplicateId = memoryId(2);
  const restated = store.upsertMemory({ ...base, id: duplicateId, sourceRawIds: [rawIds[1]] });
  assert.equal(restated.id, id);
  assert.equal(store.storageStats().memoryCount, 1);
  assert.ok(restated.sourceRawIds.includes(rawIds[0]) && restated.sourceRawIds.includes(rawIds[1]));
  assert.ok(store.listRevisions(id).length >= 1);

  // 自动分配 id：无显式 id => 合法派生 id
  const auto = store.upsertMemory({
    layer: 'L3',
    kind: 'fact',
    text: '向量默认 512 维',
    sourceRawIds: [rawIds[0]],
    importance: 0.6,
  });
  assert.ok(isMemoryId(auto.id));
  assert.equal(auto.revision, 1);

  // 显式取代：旧记录 validTo 被写入，新记录 supersedes 保留旧 id
  const oldA = store.upsertMemory({
    id: memoryId(10, 'L3', 'decision'),
    layer: 'L3',
    kind: 'decision',
    text: '决定：向量默认 256 维',
    sourceRawIds: [rawIds[0]],
  });
  const newB = store.upsertMemory({
    id: memoryId(11, 'L3', 'decision'),
    layer: 'L3',
    kind: 'decision',
    text: '决定：向量改为 512 维',
    sourceRawIds: [rawIds[1]],
    supersedes: [oldA.id],
  });
  assert.deepEqual(newB.supersedes, [oldA.id]);
  const oldAfter = store.getMemory(oldA.id);
  assert.ok(oldAfter?.validTo !== null && oldAfter?.validTo !== undefined);
  assert.ok((oldAfter?.validTo ?? 0) < Date.now());
  const oldRevisions = store.listRevisions(oldA.id);
  assert.ok(oldRevisions.length >= 1);
  assert.equal(oldRevisions[0].changeKind, 'supersede');

  // 校验
  assert.throws(
    () => store.upsertMemory({ ...base, id: 'not-a-memory-id' }),
    /id format/,
  );
  assert.throws(
    () => store.upsertMemory({ ...base, id: memoryId(20), layer: 'L9' }),
    /not registered/,
  );
  assert.throws(() => store.upsertMemory({ ...base, id: memoryId(21), text: '' }), /non-empty/);
  assert.throws(
    () => store.upsertMemory({ ...base, id: memoryId(22), text: 'bad\u0000text' }),
    /control/,
  );
  assert.throws(
    () => store.upsertMemory({ ...base, id: memoryId(23), text: 'x'.repeat(9000) }),
    /8192/,
  );
  assert.throws(
    () => store.upsertMemory({ ...base, id: memoryId(24), sourceRawIds: [] }),
    /sourceRawIds/,
  );
  const constructed = store.upsertMemory({
    ...base,
    id: memoryId(25, 'L3', 'profile'),
    kind: 'profile',
    text: '用户画像：中文开发者',
    sourceRawIds: [],
    meta: { sourcePolicy: 'constructed' },
  });
  assert.equal(constructed.sourceRawIds.length, 0);
  store.close();
});

test('store: vectors BLOB roundtrip / idempotent replace / cosine search / filters', async () => {
  const dataDir = tmpDataDir();
  const ref = { model: 'test-embed', dim: 4, version: '1' };
  const store = openStore({ dataDir, timezone: TZ }, { embedding: ref });
  const raws = await seedRaws(store, dataDir, [mkRawInput()]);
  const rawId = raws[0].record.id;

  const a = store.upsertMemory({
    id: memoryId(30, 'L3', 'fact'),
    layer: 'L3',
    kind: 'fact',
    text: '深色主题默认开启',
    sourceRawIds: [rawId],
    importance: 0.9,
  });
  const b = store.upsertMemory({
    id: memoryId(31, 'L1', 'atom'),
    layer: 'L1',
    kind: 'atom',
    text: '浅色主题的讨论',
    sourceRawIds: [rawId],
  });
  const c = store.upsertMemory({
    id: memoryId(32, 'L2', 'episode'),
    layer: 'L2',
    kind: 'episode',
    text: '主题方案汇总',
    sourceRawIds: [rawId],
  });
  store.putVector('memory', a.id, ref, new Float32Array([3, 0, 0, 0])); // 未归一化 => 现场归一化
  store.putVector('memory', b.id, ref, new Float32Array([0, 1, 0, 0]));
  store.putVector('memory', c.id, ref, new Float32Array([0.7, 0.7, 0, 0]));

  const roundtrip = store.getVector(a.id);
  assert.ok(roundtrip !== null);
  assert.deepEqual(roundtrip?.ref, ref);
  assert.equal(roundtrip?.vec.length, 4);
  assert.ok(Math.abs((roundtrip?.vec[0] ?? 0) - 1) < 1e-6);
  // memory_records.embedding_* 列同步
  assert.deepEqual(store.getMemory(a.id)?.embedding, ref);
  assert.equal(store.getVector('nope'), null);

  // 幂等覆盖：同 owner+model+version 只保留一行
  store.putVector('memory', a.id, ref, new Float32Array([0, 0, 1, 0]));
  assert.equal(store.storageStats().vectorCount, 3);
  assert.ok(Math.abs((store.getVector(a.id)?.vec[2] ?? 0) - 1) < 1e-6);

  const query = new Float32Array([1, 0, 0, 0]);
  const hits = store.searchVector(query, ref);
  assert.equal(hits.length, 3); // a 已被覆盖为 [0,0,1,0]（score 0），b 正交（score 0）
  assert.equal(hits[0].id, c.id);
  assert.ok(Math.abs(hits[0].score - Math.SQRT1_2) < 1e-5);
  assert.ok(hits.every((hit, index) => index === 0 || hits[index - 1].score >= hit.score));
  assert.equal(store.searchVector(query, ref, { limit: 1 }).length, 1);
  const threshold = store.searchVector(query, ref, { minScore: 0.9 });
  assert.equal(threshold.length, 0);
  assert.deepEqual(
    store.searchVector(query, ref, { layers: ['L1'] }).map((hit) => hit.id),
    [b.id],
  );
  assert.deepEqual(
    store.searchVector(query, ref, { kinds: ['episode'] }).map((hit) => hit.id),
    [c.id],
  );

  // archived 不参与检索
  store.upsertMemory({
    id: b.id,
    layer: 'L1',
    kind: 'atom',
    text: '浅色主题的讨论',
    sourceRawIds: [rawId],
    status: 'archived',
  });
  const afterArchive = store.searchVector(query, ref).map((hit) => hit.id);
  assert.ok(afterArchive.includes(c.id));
  assert.ok(!afterArchive.includes(b.id));

  assert.throws(() => store.putVector('memory', a.id, ref, new Float32Array([1, 2, 3])), /length/);
  assert.throws(
    () => store.putVector('memory', a.id, ref, new Float32Array([1, Number.NaN, 0, 0])),
    /finite/,
  );
  assert.throws(
    () => store.putVector('memory', a.id, { ...ref, dim: 8 }, new Float32Array(8)),
    /embedding model|vector space/,
  );
  store.close();
});

test('store: Chinese/English lexical search (AND, OR fallback, LIKE single-char fallback)', async () => {
  const dataDir = tmpDataDir();
  const store = openStore({ dataDir, timezone: TZ });
  const raws = await seedRaws(store, dataDir, [mkRawInput()]);
  const rawId = raws[0].record.id;
  const make = (seed: number, layer: string, kind: 'preference' | 'atom' | 'episode', text: string): string =>
    store.upsertMemory({
      id: memoryId(seed, layer, kind),
      layer,
      kind,
      text,
      sourceRawIds: [rawId],
    }).id;
  const dark = make(40, 'L3', 'preference', '我喜欢用深色主题');
  const light = make(41, 'L3', 'preference', '浅色主题也可以');
  const english = make(42, 'L1', 'atom', 'the quick brown fox jumps');

  const andHits = store.searchLexical('深色主题');
  assert.equal(andHits[0]?.id, dark);
  assert.ok(!andHits.some((hit) => hit.id === light), 'AND semantics: light lacks 深色');
  for (const hit of andHits) {
    assert.ok(hit.score >= 0 && hit.score < 1);
    assert.equal(hit.layer, 'L3');
  }

  const lightHits = store.searchLexical('浅色主题');
  assert.equal(lightHits[0]?.id, light);

  const englishHits = store.searchLexical('quick fox');
  assert.equal(englishHits[0]?.id, english);

  // AND 0 命中 -> OR 降级：没有任何一条同时含 深色+浅色
  const orHits = store.searchLexical('深色 浅色');
  assert.deepEqual(new Set(orHits.map((hit) => hit.id)), new Set([dark, light]));

  // 单字 CJK 在 bigram 索引下无法命中长文本 -> LIKE 降级（固定低分）
  const singleChar = store.searchLexical('深');
  assert.equal(singleChar[0]?.id, dark);
  assert.equal(singleChar[0]?.score, 0.25);

  // 层/种类过滤
  assert.equal(store.searchLexical('quick fox', { layers: ['L3'] }).length, 0);
  assert.equal(store.searchLexical('quick fox', { kinds: ['atom'] }).length, 1);
  assert.equal(store.searchLexical('quick fox', { limit: 1 }).length, 1);
  assert.deepEqual(store.searchLexical(''), []);
  assert.deepEqual(store.searchLexical('   '), []);
  store.close();
});

test('store: layers/stats/governance/cursors/clearLayer/private tables/integrity/transaction', async () => {
  const dataDir = tmpDataDir();
  const store = openStore({ dataDir, timezone: TZ });
  const raws = await seedRaws(store, dataDir, [mkRawInput()]);
  const rawId = raws[0].record.id;

  assert.deepEqual(store.listLayers().map((layer) => layer.id), ['L1', 'L2', 'L3']);
  const l3 = store.listLayers().find((layer) => layer.id === 'L3');
  assert.equal(l3?.kind, 'builtin');
  assert.equal(l3?.enabled, true);
  assert.equal(l3?.rebuildable, true);
  assert.deepEqual(l3?.dependsOn, ['L1', 'L2']);

  const l3Memory = store.upsertMemory({
    id: memoryId(50, 'L3', 'fact'),
    layer: 'L3',
    kind: 'fact',
    text: '事实条目 A',
    sourceRawIds: [rawId],
    importance: 0.5,
  });
  const l1Memory = store.upsertMemory({
    id: memoryId(51, 'L1', 'atom'),
    layer: 'L1',
    kind: 'atom',
    text: '原子事件 B',
    sourceRawIds: [rawId],
  });
  assert.equal(store.countByLayer().L3, 1);
  assert.equal(store.countByLayer().L1, 1);
  const stats = store.storageStats();
  assert.equal(stats.memoryCount, 2);
  assert.equal(stats.activeMemoryCount, 2);
  assert.equal(stats.rawCount, 1);
  assert.ok(stats.dbPath.endsWith('vault.db'));
  assert.deepEqual(stats.embedding, REF_512);
  const layerStats = store.layerStats();
  assert.equal(layerStats.find((row) => row.layer === 'L3')?.count, 1);

  // touchMemories：治理列变化
  const before = store.getMemory(l3Memory.id);
  store.touchMemories([l3Memory.id]);
  const after = store.getMemory(l3Memory.id);
  assert.equal(after?.accessCount, (before?.accessCount ?? 0) + 1);
  assert.ok((after?.lastAccessAt ?? 0) > 0);
  assert.ok((after?.heat ?? 0) >= (before?.heat ?? 0));
  assert.equal(after?.text, before?.text);

  // 水位
  assert.equal(store.getDeriveCursor('L1'), 0);
  store.setDeriveCursor('L1', 5);
  assert.equal(store.getDeriveCursor('L1'), 5);
  assert.throws(() => store.setDeriveCursor('L1', 3), /move forward/);

  // L2/L3 私有表
  const l2Memory = store.upsertMemory({
    id: memoryId(52, 'L2', 'episode'),
    layer: 'L2',
    kind: 'episode',
    text: 'L2 情节摘要',
    sourceRawIds: [rawId],
  });
  store.putL2Episode({
    memoryId: l2Memory.id,
    sessionId: 'sess_1',
    topic: '深色主题',
    startTs: BASE_TS,
    endTs: BASE_TS + 1000,
    turnCount: 3,
    pageIds: [l1Memory.id],
  });
  const l2Row = db(store)
    .prepare('SELECT topic, turn_count, page_ids_json FROM layer_l2_episodes WHERE memory_id = ?')
    .get(l2Memory.id) as { topic: string; turn_count: number; page_ids_json: string };
  assert.equal(l2Row.topic, '深色主题');
  assert.equal(Number(l2Row.turn_count), 3);
  assert.deepEqual(JSON.parse(l2Row.page_ids_json), [l1Memory.id]);

  store.putL3Semantic({
    memoryId: l3Memory.id,
    category: 'fact',
    subject: 'project',
    predicate: 'vector.dim',
    object: '512',
    canonicalKey: 'project.vector.dim=512',
    validFrom: BASE_TS,
    sourceKind: 'deterministic',
  });
  const semantic = store.getL3Semantic(l3Memory.id);
  assert.equal(semantic?.canonicalKey, 'project.vector.dim=512');
  assert.equal(semantic?.category, 'fact');
  const l3b = store.upsertMemory({
    id: memoryId(53, 'L3', 'fact'),
    layer: 'L3',
    kind: 'fact',
    text: '事实条目 C',
    sourceRawIds: [rawId],
  });
  assert.throws(
    () =>
      store.putL3Semantic({
        memoryId: l3b.id,
        category: 'fact',
        canonicalKey: 'project.vector.dim=512',
      }),
    /canonicalKey|UNIQUE/,
  );

  // embedding coverage
  store.putVector('memory', l3Memory.id, REF_512, new Float32Array(512).fill(0));
  const coverage = store.embeddingCoverage();
  assert.equal(coverage.L3, 1);

  // 完整性记录
  assert.equal(store.getLastIntegrityRun(), null);
  store.recordIntegrityRun({ kind: 'raw_chain', startedAt: BASE_TS, recordsChecked: 1, segmentsChecked: 1, ok: true });
  store.recordIntegrityRun({ kind: 'quick_check', startedAt: BASE_TS + 1, ok: true, details: { tables: 21 } });
  assert.equal(store.listIntegrityRuns().length, 2);
  assert.equal(store.getLastIntegrityRun()?.kind, 'quick_check');
  assert.deepEqual(store.listRepairLog(), []);
  store.setMeta('l3.rebuildGeneration', '2');
  assert.equal(store.getMeta('l3.rebuildGeneration'), '2');

  // 事务回滚：记录 + 私有行整体不落库
  assert.throws(
    () =>
      store.transaction(() => {
        store.upsertMemory({
          id: memoryId(54, 'L3', 'fact'),
          layer: 'L3',
          kind: 'fact',
          text: '回滚条目',
          sourceRawIds: [rawId],
        });
        throw new Error('rollback-please');
      }),
    /rollback-please/,
  );
  assert.equal(store.getMemory(memoryId(54, 'L3', 'fact')), null);
  // 嵌套事务由最外层统一提交
  const nested = store.transaction(() =>
    store.transaction(() =>
      store.upsertMemory({
        id: memoryId(55, 'L3', 'fact'),
        layer: 'L3',
        kind: 'fact',
        text: '嵌套事务条目',
        sourceRawIds: [rawId],
      }),
    ),
  );
  assert.equal(nested.revision, 1);

  // clearLayer L1：物理删除 + 向量清理 + 水位归零；L0 不受影响
  store.putVector('memory', l1Memory.id, REF_512, new Float32Array(512).fill(0));
  const cleared = store.clearLayer('L1');
  assert.equal(cleared.removed, 1);
  assert.equal(cleared.archived, 0);
  assert.equal(store.getMemory(l1Memory.id), null);
  assert.equal(store.getVector(l1Memory.id), null);
  assert.equal(store.getDeriveCursor('L1'), 0);
  assert.equal(store.storageStats().rawCount, 1);

  // clearLayer L3：默认拒绝物理删除；archive=true => 归档 + 快照
  assert.throws(() => store.clearLayer('L3'), /archive/);
  const archived = store.clearLayer('L3', { archive: true });
  assert.ok(archived.archived >= 3);
  assert.equal(archived.removed, 0);
  const l3Rows = store.listMemories({ layers: ['L3'] });
  assert.ok(l3Rows.length >= 3);
  for (const row of l3Rows) {
    assert.equal(row.status, 'archived');
    assert.ok(row.validTo !== null && row.validTo !== undefined);
  }
  assert.ok(store.listRevisions(l3Memory.id).some((revision) => revision.changeKind === 'archive'));
  assert.equal(store.listLayers().find((layer) => layer.id === 'L3')?.active, 0);
  assert.equal(store.getDeriveCursor('L3'), 0);
  // 归档时 L3 私有表也必须关闭 valid_to：否则 canonical_key 仍被部分唯一索引占用
  assert.ok((store.getL3Semantic(l3Memory.id)?.validTo ?? 0) > 0);
  // 新代际可复用同一 canonical_key（这是 L3 代际重建的硬要求）
  const nextGen = store.upsertMemory({
    id: memoryId(56, 'L3', 'fact'),
    layer: 'L3',
    kind: 'fact',
    text: '新一代事实条目',
    sourceRawIds: [rawId],
  });
  store.putL3Semantic({
    memoryId: nextGen.id,
    category: 'fact',
    canonicalKey: 'project.vector.dim=512',
    validFrom: BASE_TS,
  });
  assert.equal(store.getL3Semantic(nextGen.id)?.canonicalKey, 'project.vector.dim=512');
  assert.equal(store.getL3Semantic(nextGen.id)?.validTo ?? null, null);
  store.close();
});

test('store: close semantics + persistence across reopen', async () => {
  const dataDir = tmpDataDir();
  let store = openStore({ dataDir, timezone: TZ });
  const raws = await seedRaws(store, dataDir, [mkRawInput()]);
  const record = store.upsertMemory({
    id: memoryId(60, 'L3', 'fact'),
    layer: 'L3',
    kind: 'fact',
    text: '持久化事实',
    sourceRawIds: [raws[0].record.id],
  });
  store.close();
  assert.throws(() => store.getMemory(record.id), /after close/);
  assert.throws(() => store.upsertMemory({ layer: 'L3', kind: 'fact', text: 'x', sourceRawIds: [] }), /after close/);

  store = openStore({ dataDir, timezone: TZ });
  assert.equal(store.getMemory(record.id)?.text, '持久化事实');
  assert.equal(store.storageStats().memoryCount, 1);
  assert.equal(store.storageStats().rawCount, 1);
  assert.ok(statSync(join(dataDir, 'vault.db')).size > 0);
  store.close();
  // silentLogger 引用一下，避免 lint 提示未使用
  assert.equal(typeof silentLogger.info, 'function');
});

test('retention: v2 columns/index/view + defaults', () => {
  const docs23Path = 'docs/23-memory-models.md';
  const docs23 = existsSync(docs23Path) ? readFileSync(docs23Path, 'utf8') : null;
  assert.equal(sha256Hex(MIGRATION_2_SQL), MIGRATION_2_SHA256, 'embedded migration 2 sha256 changed');
  if (docs23 !== null) for (const fragment of [
    "ADD COLUMN retention_tier  TEXT NOT NULL DEFAULT 'short'",
    'ADD COLUMN retention_score REAL NOT NULL DEFAULT 0',
    'ADD COLUMN pinned',
    'ADD COLUMN promoted_at',
    'ADD COLUMN long_term_at',
    'CREATE INDEX ix_mem_retention',
    'CREATE INDEX ix_mem_pinned',
    'CREATE VIEW  v_retention_stats',
    'PRAGMA user_version = 2',
  ]) {
    assert.ok(docs23.includes(fragment), 'docs/23-memory-models §5 missing fragment: ' + fragment);
  }

  const dataDir = tmpDataDir();
  const store = openStore({ dataDir, timezone: TZ });
  const conn = db(store);
  const columns = conn.prepare('PRAGMA table_info(memory_records)').all() as Array<{
    name: string;
    type: string;
    notnull: number;
    dflt_value: string | null;
  }>;
  const byName = new Map(columns.map((column) => [column.name, column]));
  assert.equal(byName.get('retention_tier')?.type, 'TEXT');
  assert.equal(byName.get('retention_tier')?.notnull, 1);
  assert.ok((byName.get('retention_tier')?.dflt_value ?? '').includes('short'));
  assert.equal(byName.get('retention_score')?.type, 'REAL');
  assert.equal(byName.get('retention_score')?.notnull, 1);
  assert.equal(byName.get('pinned')?.type, 'INTEGER');
  assert.equal(byName.get('pinned')?.notnull, 1);
  assert.equal(byName.get('promoted_at')?.notnull, 0);
  assert.equal(byName.get('long_term_at')?.notnull, 0);

  const indexRows = conn
    .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name IN ('ix_mem_retention', 'ix_mem_pinned')")
    .all() as Array<{ name: string }>;
  assert.deepEqual(indexRows.map((row) => row.name).sort(), ['ix_mem_pinned', 'ix_mem_retention']);
  assert.ok(
    conn.prepare("SELECT name FROM sqlite_master WHERE type = 'view' AND name = 'v_retention_stats'").get() !==
      undefined,
  );

  const migrations = conn
    .prepare('SELECT version, checksum FROM schema_migrations ORDER BY version')
    .all() as Array<{ version: number; checksum: string }>;
  assert.deepEqual(migrations.map((row) => Number(row.version)), [1, 2, 3, 4]);
  assert.equal(migrations[0].checksum, SCHEMA_V1_SHA256);
  assert.equal(migrations[1].checksum, MIGRATION_2_SHA256);
  assert.equal(migrations[2].checksum, MIGRATION_3_SHA256);
  assert.equal(migrations[3].checksum, MIGRATION_4_SHA256);
  assert.equal(store.storageStats().schemaVersion, STORE_SCHEMA_VERSION);
  assert.equal(store.getMeta('schema_version'), String(STORE_SCHEMA_VERSION));

  // 默认值：新记录 = short / score 0 / not pinned / 无时间戳；两套模型正交
  const normal = store.upsertMemory({
    id: memoryId(70, 'L3', 'fact'),
    layer: 'L3',
    kind: 'fact',
    text: '普通事实条目',
    sourceRawIds: ['r1'],
  });
  assert.equal(normal.layer, 'L3');
  assert.equal(normal.retentionTier, 'short');
  assert.equal(normal.retentionScore, 0);
  assert.equal(normal.pinned, false);
  assert.equal(normal.promotedAt, null);
  assert.equal(normal.longTermAt, null);

  // pinned 只是治理标记：store 不在 upsert 时改 tier（晋升 long 由 RetentionEngine 调 setRetention）
  const pinnedMemory = store.upsertMemory({
    id: memoryId(71, 'L3', 'profile'),
    layer: 'L3',
    kind: 'profile',
    text: '用户画像',
    sourceRawIds: [],
    meta: { sourcePolicy: 'constructed' },
    pinned: true,
  });
  assert.equal(pinnedMemory.pinned, true);
  assert.equal(pinnedMemory.retentionTier, 'short');
  assert.equal(pinnedMemory.promotedAt, null);

  const statsRows = conn
    .prepare('SELECT tier, total, max_score, avg_score, last_updated FROM v_retention_stats ORDER BY tier')
    .all() as Array<{
    tier: string;
    total: number;
    max_score: number | null;
    avg_score: number | null;
    last_updated: number | null;
  }>;
  assert.deepEqual(statsRows.map((row) => row.tier), ['short']);
  assert.equal(Number(statsRows[0]?.total), 2);
  assert.equal(Number(statsRows[0]?.max_score), 0);
  store.close();
});

test('retention: old v1 database upgrades in place (v1 rows preserved, v2 applied once)', () => {
  const dataDir = tmpDataDir();
  mkdirSync(dataDir, { recursive: true });
  const dbPath = join(dataDir, 'vault.db');
  const raw = new DatabaseSync(dbPath);
  for (const pragma of CONNECTION_PRAGMAS) {
    if (/^\s*PRAGMA\s+user_version/i.test(pragma)) continue;
    try {
      raw.exec(pragma);
    } catch {
      /* mmap 等平台 PRAGMA 失败可忽略（与 store 行为一致） */
    }
  }
  raw.exec(SCHEMA_V1_SQL);
  raw
    .prepare('UPDATE schema_migrations SET applied_at = ?, checksum = ? WHERE version = 1')
    .run(BASE_TS, SCHEMA_V1_SHA256);
  raw.exec('PRAGMA user_version = 1;');
  const legacyId = 'L3-fact-m9k2x1-a1b2c3d4';
  const legacyText = '迁移前的旧事实';
  raw
    .prepare(
      'INSERT INTO memory_records(id, layer, kind, text, text_seg, created_at, updated_at, content_hash) ' +
        'VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    )
    .run(
      legacyId,
      'L3',
      'fact',
      legacyText,
      textToTextSeg(legacyText),
      BASE_TS,
      BASE_TS,
      contentHash('L3', 'fact', legacyText),
    );
  raw.close();

  const probe = new DatabaseSync(dbPath);
  assert.equal(
    Number((probe.prepare('PRAGMA user_version').get() as { user_version: number }).user_version),
    1,
  );
  // v1 seed 的旧显示名（docs/21 历史字节，migration 1 不允许修改）
  assert.deepEqual(
    (probe.prepare('SELECT name FROM layers ORDER BY id').all() as Array<{ name: string }>).map(
      (row) => row.name,
    ),
    ['L1 短期/工作层', 'L2 中期/情节层', 'L3 长期/语义层'],
  );
  probe.close();

  const store = openStore({ dataDir, timezone: TZ });
  assert.equal(store.storageStats().schemaVersion, STORE_SCHEMA_VERSION);
  const migrated = store.getMemory(legacyId);
  assert.ok(migrated !== null);
  assert.equal(migrated?.text, legacyText);
  assert.equal(migrated?.retentionTier, 'short');
  assert.equal(migrated?.retentionScore, 0);
  assert.equal(migrated?.pinned, false);
  assert.equal(migrated?.promotedAt ?? null, null);
  assert.equal(migrated?.longTermAt ?? null, null);
  const ledger = db(store)
    .prepare('SELECT version FROM schema_migrations ORDER BY version')
    .all() as Array<{ version: number }>;
  assert.deepEqual(ledger.map((row) => Number(row.version)), [1, 2, 3, 4]);
  // migration 2 尾部 UPDATE 修正内置层显示名（scripts 中已验 v1 旧名）
  assert.deepEqual(
    store.listLayers().map((layer) => layer.name),
    ['L1 工作记忆层', 'L2 情景记忆层', 'L3 语义记忆层'],
  );
  store.close();

  // 再打开 => 幂等 no-op（不会重复 ALTER 报 duplicate column）
  const reopened = openStore({ dataDir, timezone: TZ });
  assert.equal(reopened.storageStats().schemaVersion, STORE_SCHEMA_VERSION);
  assert.equal(reopened.getMemory(legacyId)?.text, legacyText);
  reopened.close();
});

test('retention: setRetention only-up promotions, timestamps, idempotency, governance-only invariant', () => {
  const dataDir = tmpDataDir();
  const store = openStore({ dataDir, timezone: TZ });
  const id = memoryId(80, 'L3', 'fact');
  const created = store.upsertMemory({
    id,
    layer: 'L3',
    kind: 'fact',
    text: '保留期状态测试条目',
    sourceRawIds: ['r1'],
  });
  assert.equal(created.retentionTier, 'short');
  const selectGovernance = () =>
    db(store)
      .prepare('SELECT text, content_hash, revision, updated_at FROM memory_records WHERE id = ?')
      .get(id) as { text: string; content_hash: string; revision: number; updated_at: number };
  const before = selectGovernance();

  const now1 = BASE_TS + 10_000;
  // short -> mid：写 promotedAt，longTermAt 仍 null
  store.setRetention(
    id,
    { tier: 'mid', score: 0.62, pinned: false, promotedAt: null, longTermAt: null },
    now1,
  );
  const mid = store.getRetention(id);
  assert.equal(mid?.tier, 'mid');
  assert.equal(mid?.score, 0.62);
  assert.equal(mid?.promotedAt, now1);
  assert.equal(mid?.longTermAt, null);

  // 降级请求（mid -> short）整条忽略：tier/score/promotedAt 都不变
  store.setRetention(
    id,
    { tier: 'short', score: 0.99, pinned: false, promotedAt: null, longTermAt: null },
    now1 + 1000,
  );
  assert.deepEqual(store.getRetention(id), mid);

  // mid -> long：写 promotedAt + longTermAt
  store.setRetention(
    id,
    { tier: 'long', score: 0.8, pinned: false, promotedAt: null, longTermAt: null },
    now1 + 2000,
  );
  const long = store.getRetention(id);
  assert.equal(long?.tier, 'long');
  assert.equal(long?.promotedAt, now1 + 2000);
  assert.equal(long?.longTermAt, now1 + 2000);

  // 同层二次写入：允许刷新 score，但不覆盖时间戳（tick 幂等不抖时间）
  store.setRetention(
    id,
    { tier: 'long', score: 0.9, pinned: true, promotedAt: null, longTermAt: null },
    now1 + 3000,
  );
  const longAgain = store.getRetention(id);
  assert.equal(longAgain?.score, 0.9);
  assert.equal(longAgain?.pinned, true);
  assert.equal(longAgain?.promotedAt, now1 + 2000);
  assert.equal(longAgain?.longTermAt, now1 + 2000);

  // 再次降级请求：忽略
  store.setRetention(
    id,
    { tier: 'mid', score: 0.1, pinned: false, promotedAt: null, longTermAt: null },
    now1 + 4000,
  );
  assert.deepEqual(store.getRetention(id), longAgain);

  // 显式时间戳优先（另一个记录）
  const explicitId = memoryId(81, 'L3', 'fact');
  store.upsertMemory({ id: explicitId, layer: 'L3', kind: 'fact', text: '显式时间戳条目', sourceRawIds: ['r1'] });
  store.setRetention(
    explicitId,
    { tier: 'mid', score: 0.5, pinned: false, promotedAt: 123_456, longTermAt: null },
    now1,
  );
  assert.equal(store.getRetention(explicitId)?.promotedAt, 123_456);
  store.setRetention(
    explicitId,
    { tier: 'long', score: 0.5, pinned: false, promotedAt: 234_567, longTermAt: 654_321 },
    now1 + 1,
  );
  const explicitLong = store.getRetention(explicitId);
  assert.equal(explicitLong?.promotedAt, 234_567);
  assert.equal(explicitLong?.longTermAt, 654_321);

  // 只有治理列变化：内容/哈希/revision/updated_at 逐字段不变（docs/23-memory-models §8-6）
  assert.deepEqual(selectGovernance(), before);

  // 不存在的 id：忽略（不抛错）
  store.setRetention('L3-fact-m9k2x1-ffffffff', {
    tier: 'long',
    score: 0.5,
    pinned: false,
    promotedAt: null,
    longTermAt: null,
  });
  assert.equal(store.getRetention('L3-fact-m9k2x1-ffffffff'), null);

  // 非法状态
  assert.throws(
    () =>
      store.setRetention(id, {
        tier: 'bogus' as never,
        score: 0.5,
        pinned: false,
        promotedAt: null,
        longTermAt: null,
      }),
    /tier/,
  );
  assert.throws(
    () =>
      store.setRetention(id, {
        tier: 'mid',
        score: Number.NaN,
        pinned: false,
        promotedAt: null,
        longTermAt: null,
      }),
    /score/,
  );
  assert.throws(
    () =>
      store.setRetention(id, {
        tier: 'mid',
        score: 0.5,
        pinned: 'yes' as never,
        promotedAt: null,
        longTermAt: null,
      }),
    /pinned/,
  );
  store.close();
});

test('retention: setRetentionBatch single transaction + rollback + no downgrade', () => {
  const dataDir = tmpDataDir();
  const store = openStore({ dataDir, timezone: TZ });
  const ids = [memoryId(85, 'L3', 'fact'), memoryId(86, 'L3', 'fact'), memoryId(87, 'L3', 'fact')];
  for (let index = 0; index < ids.length; index += 1) {
    store.upsertMemory({
      id: ids[index],
      layer: 'L3',
      kind: 'fact',
      text: '批量保留期 ' + index,
      sourceRawIds: ['r1'],
    });
  }
  // 单事务批量 short -> mid
  store.setRetentionBatch(
    ids.map((id) => ({
      id,
      tier: 'mid' as const,
      score: 0.5,
      pinned: false,
      promotedAt: null,
      longTermAt: null,
    })),
    BASE_TS + 5000,
  );
  assert.equal(store.retentionStats().mid, 3);

  // 批量里对已是 long 的记录发 mid => 忽略不降级；同时可晋升其他记录
  store.setRetention(ids[0], {
    tier: 'long',
    score: 0.9,
    pinned: true,
    promotedAt: null,
    longTermAt: null,
  }, BASE_TS + 6000);
  store.setRetentionBatch(
    [
      { id: ids[0], tier: 'mid', score: 0.1, pinned: false, promotedAt: null, longTermAt: null },
      { id: ids[1], tier: 'long', score: 0.8, pinned: false, promotedAt: null, longTermAt: null },
    ],
    BASE_TS + 7000,
  );
  assert.equal(store.getRetention(ids[0])?.tier, 'long');
  assert.equal(store.getRetention(ids[0])?.score, 0.9);
  assert.equal(store.getRetention(ids[1])?.tier, 'long');

  // 回滚：第二条非法 tier => 整批回滚（第一条保持原值）
  const before = store.getRetention(ids[1]);
  assert.throws(
    () =>
      store.setRetentionBatch(
        [
          {
            id: ids[1],
            tier: 'long',
            score: 0.05,
            pinned: false,
            promotedAt: null,
            longTermAt: null,
          },
          {
            id: ids[2],
            tier: 'invalid' as never,
            score: 0.2,
            pinned: false,
            promotedAt: null,
            longTermAt: null,
          },
        ],
        BASE_TS + 8000,
      ),
    /tier/,
  );
  assert.deepEqual(store.getRetention(ids[1]), before);
  store.close();
});

test('retention: stats/listByRetention/listRetentionCandidates/meta/listMemories filters', () => {
  const dataDir = tmpDataDir();
  const store = openStore({ dataDir, timezone: TZ });
  const l1 = store.upsertMemory({ id: memoryId(90, 'L3', 'fact'), layer: 'L3', kind: 'fact', text: '长期一', sourceRawIds: ['r1'] });
  const l2 = store.upsertMemory({ id: memoryId(91, 'L2', 'summary'), layer: 'L2', kind: 'summary', text: '长期二', sourceRawIds: ['r1'] });
  const m1 = store.upsertMemory({ id: memoryId(92, 'L3', 'fact'), layer: 'L3', kind: 'fact', text: '中期一', sourceRawIds: ['r1'] });
  const s1 = store.upsertMemory({ id: memoryId(93, 'L1', 'atom'), layer: 'L1', kind: 'atom', text: '短期一', sourceRawIds: ['r1'] });
  const s2 = store.upsertMemory({ id: memoryId(94, 'L1', 'atom'), layer: 'L1', kind: 'atom', text: '短期二', sourceRawIds: ['r1'] });
  store.setRetentionBatch(
    [
      { id: l1.id, tier: 'long', score: 0.8, pinned: false, promotedAt: null, longTermAt: null },
      { id: l2.id, tier: 'long', score: 0.4, pinned: false, promotedAt: null, longTermAt: null },
      { id: m1.id, tier: 'mid', score: 0.7, pinned: false, promotedAt: null, longTermAt: null },
      { id: s1.id, tier: 'short', score: 0.2, pinned: false, promotedAt: null, longTermAt: null },
    ],
    BASE_TS + 60_000,
  );
  store.setRetention(l2.id, { tier: 'long', score: 0.4, pinned: true, promotedAt: null, longTermAt: null }, BASE_TS + 61_000);

  const stats = store.retentionStats();
  assert.equal(stats.short, 2); // s2 默认 short + s1
  assert.equal(stats.mid, 1);
  assert.equal(stats.long, 2);
  assert.equal(stats.pinned, 1);
  assert.equal(stats.lastTickAt, null);

  store.setRetentionMeta('retention.lastTickAt', String(BASE_TS + 120_000));
  assert.equal(store.getRetentionMeta('retention.lastTickAt'), String(BASE_TS + 120_000));
  assert.equal(store.retentionStats().lastTickAt, BASE_TS + 120_000);
  store.setRetentionMeta('retention.note', 'hello');
  assert.equal(store.getRetentionMeta('retention.note'), 'hello');

  // listByRetention：score DESC + 分页 + 只返回 status=active
  assert.deepEqual(store.listByRetention('long').map((memory) => memory.id), [l1.id, l2.id]);
  assert.deepEqual(store.listByRetention('long', { limit: 1 }).map((memory) => memory.id), [l1.id]);
  assert.deepEqual(
    store.listByRetention('long', { limit: 1, offset: 1 }).map((memory) => memory.id),
    [l2.id],
  );
  assert.deepEqual(store.listByRetention('short').map((memory) => memory.id), [s1.id, s2.id]);
  assert.throws(() => store.listByRetention('bogus' as never), /tier/);

  // listRetentionCandidates：未到 long（short/mid）始终参与 + 最近更新的 long
  const old = BASE_TS - 60 * 86_400_000;
  db(store).prepare('UPDATE memory_records SET updated_at = ? WHERE id = ?').run(old, l2.id);
  db(store).prepare('UPDATE memory_records SET updated_at = ? WHERE id = ?').run(Date.now() + 1_000_000, l1.id);
  const candidateIds = store.listRetentionCandidates().map((memory) => memory.id);
  for (const id of [l1.id, m1.id, s1.id, s2.id]) {
    assert.ok(candidateIds.includes(id), 'candidate missing ' + id);
  }
  assert.ok(!candidateIds.includes(l2.id), 'old long record must be excluded from default candidates');
  assert.ok(store.listRetentionCandidates({ since: old - 1000 }).map((memory) => memory.id).includes(l2.id));
  assert.equal(store.listRetentionCandidates()[0]?.id, l1.id);
  assert.equal(store.listRetentionCandidates({ limit: 2 }).length, 2);

  // listMemories 过滤 + 保留期字段
  assert.deepEqual(
    store.listMemories({ retentionTiers: ['long'] }).map((memory) => memory.id).sort(),
    [l1.id, l2.id].sort(),
  );
  assert.deepEqual(store.listMemories({ pinned: true }).map((memory) => memory.id), [l2.id]);
  assert.deepEqual(
    store.listMemories({ retentionTiers: ['mid'], pinned: false }).map((memory) => memory.id),
    [m1.id],
  );
  const fetched = store.getMemory(l1.id);
  assert.equal(fetched?.retentionTier, 'long');
  assert.equal(fetched?.retentionScore, 0.8);
  assert.equal(fetched?.pinned, false);
  assert.ok((fetched?.promotedAt ?? 0) > 0);
  assert.ok((fetched?.longTermAt ?? 0) > 0);
  store.close();
});

test('retention: pinned preserved on content update; unpin does not bump revision or tier', () => {
  const dataDir = tmpDataDir();
  const store = openStore({ dataDir, timezone: TZ });
  const id = memoryId(100, 'L3', 'profile');
  const pinned = store.upsertMemory({
    id,
    layer: 'L3',
    kind: 'profile',
    text: '用户画像 V1',
    sourceRawIds: ['r1'],
    pinned: true,
  });
  assert.equal(pinned.pinned, true);
  assert.equal(pinned.retentionTier, 'short');

  // 内容更新且未显式传 pinned => pinned 保留，revision++
  const updated = store.upsertMemory({
    id,
    layer: 'L3',
    kind: 'profile',
    text: '用户画像 V2',
    sourceRawIds: ['r1'],
  });
  assert.equal(updated.pinned, true);
  assert.equal(updated.retentionTier, 'short');
  assert.equal(updated.revision, 2);

  // 引擎晋升 long 后，内容更新不改变 retention
  store.setRetention(id, {
    tier: 'long',
    score: 0.8,
    pinned: true,
    promotedAt: null,
    longTermAt: null,
  }, BASE_TS + 1000);
  const longRecord = store.getMemory(id);
  assert.equal(longRecord?.retentionTier, 'long');
  assert.ok((longRecord?.longTermAt ?? 0) > 0);
  const contentUpdated = store.upsertMemory({
    id,
    layer: 'L3',
    kind: 'profile',
    text: '用户画像 V3',
    sourceRawIds: ['r1'],
  });
  assert.equal(contentUpdated.retentionTier, 'long');
  assert.equal(contentUpdated.pinned, true);

  // 显式取消钉住 => pinned=false；内容/版本不变（治理列不 bump revision），层不强制变化
  const unpinned = store.upsertMemory({
    id,
    layer: 'L3',
    kind: 'profile',
    text: '用户画像 V3',
    sourceRawIds: ['r1'],
    pinned: false,
  });
  assert.equal(unpinned.pinned, false);
  assert.equal(unpinned.retentionTier, 'long');
  assert.equal(unpinned.revision, 3);
  store.close();
});


test('store: builtin layer display names normalized on every open (v2 fallback, idempotent)', () => {
  const dataDir = tmpDataDir();
  const expected = ['L1 工作记忆层', 'L2 情景记忆层', 'L3 语义记忆层'];

  const store = openStore({ dataDir, timezone: TZ });
  assert.deepEqual(store.listLayers().map((layer) => layer.name), expected);
  // 模拟"已迁移到 v2 但显示名仍是旧值"的历史库（layers 是治理元数据，允许 UPDATE）
  db(store).prepare('UPDATE layers SET name = ? WHERE id = ?').run('L1 短期/工作层', 'L1');
  db(store).prepare('UPDATE layers SET name = ? WHERE id = ?').run('L2 中期/情节层', 'L2');
  assert.notDeepEqual(store.listLayers().map((layer) => layer.name), expected);
  store.close();

  const reopened = openStore({ dataDir, timezone: TZ });
  assert.deepEqual(reopened.listLayers().map((layer) => layer.name), expected);
  // 其它治理字段不受影响（只改 name）
  const l3 = reopened.listLayers().find((layer) => layer.id === 'L3');
  assert.equal(l3?.kind, 'builtin');
  assert.equal(l3?.enabled, true);
  assert.equal(l3?.rebuildable, true);
  assert.deepEqual(l3?.dependsOn, ['L1', 'L2']);
  reopened.close();

  const reopenedAgain = openStore({ dataDir, timezone: TZ });
  assert.deepEqual(reopenedAgain.listLayers().map((layer) => layer.name), expected);
  reopenedAgain.close();
});

const DAY_MS = 86_400_000;
const RAW_REF = { model: 'raw-test-embed', dim: 4, version: '1' };
const unit = (values: number[]): Float32Array => new Float32Array(values);

test('migration: v2 database upgrades in place to v3 (retention data preserved, new indexes/triggers, idempotent)', () => {
  const dataDir = tmpDataDir();
  mkdirSync(dataDir, { recursive: true });
  const dbPath = join(dataDir, 'vault.db');
  const raw = new DatabaseSync(dbPath);
  for (const pragma of CONNECTION_PRAGMAS) {
    if (/^\s*PRAGMA\s+user_version/i.test(pragma)) continue;
    try {
      raw.exec(pragma);
    } catch {
      /* 平台相关 PRAGMA 可忽略 */
    }
  }
  raw.exec(SCHEMA_V1_SQL);
  raw.exec(MIGRATION_2_SQL);
  raw
    .prepare(
      'INSERT OR REPLACE INTO schema_migrations(version, applied_at, description, checksum) VALUES (?, ?, ?, ?)',
    )
    .run(1, BASE_TS, 'initial', SCHEMA_V1_SHA256);
  raw
    .prepare(
      'INSERT OR REPLACE INTO schema_migrations(version, applied_at, description, checksum) VALUES (?, ?, ?, ?)',
    )
    .run(2, BASE_TS, 'retention', MIGRATION_2_SHA256);
  raw.exec('PRAGMA user_version = 2;');
  const legacyId = 'L3-fact-m9k2x1-b2c3d4e5';
  const legacyText = 'v2 时代的长期事实';
  raw
    .prepare(
      'INSERT INTO memory_records(id, layer, kind, text, text_seg, created_at, updated_at, content_hash, ' +
        'retention_tier, retention_score, pinned, promoted_at, long_term_at) ' +
        'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    )
    .run(
      legacyId,
      'L3',
      'fact',
      legacyText,
      textToTextSeg(legacyText),
      BASE_TS,
      BASE_TS,
      contentHash('L3', 'fact', legacyText),
      'long',
      0.9,
      1,
      1234,
      5678,
    );
  raw.close();

  const store = openStore({ dataDir, timezone: TZ });
  assert.equal(store.storageStats().schemaVersion, STORE_SCHEMA_VERSION);
  const conn = db(store);
  assert.equal(Number((conn.prepare('PRAGMA user_version').get() as { user_version: number }).user_version), STORE_SCHEMA_VERSION);
  const migrated = store.getMemory(legacyId);
  assert.ok(migrated !== null);
  assert.equal(migrated?.text, legacyText);
  assert.equal(migrated?.retentionTier, 'long');
  assert.equal(migrated?.retentionScore, 0.9);
  assert.equal(migrated?.pinned, true);
  assert.equal(migrated?.promotedAt, 1234);
  assert.equal(migrated?.longTermAt, 5678);

  const objectNames = new Set(
    (
      conn
        .prepare("SELECT name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'")
        .all() as Array<{ name: string }>
    ).map((row) => row.name),
  );
  for (const name of ['ix_vectors_owner_kind', 'ix_mem_forget', 'tr_raw_vectors_no_update', 'tr_raw_vectors_no_delete', 'tr_l3_long_no_delete']) {
    assert.ok(objectNames.has(name), 'missing migration-3 object ' + name);
  }
  assert.ok(!objectNames.has('tr_l3_no_delete'), 'old broad L3 delete trigger must be dropped');

  const ledger = conn
    .prepare('SELECT version, checksum FROM schema_migrations ORDER BY version')
    .all() as Array<{ version: number; checksum: string }>;
  assert.deepEqual(ledger.map((row) => Number(row.version)), [1, 2, 3, 4]);
  assert.equal(ledger[2].checksum, MIGRATION_3_SHA256);
  assert.equal(ledger[3].checksum, MIGRATION_4_SHA256);
  store.close();

  // 幂等重开
  const reopened = openStore({ dataDir, timezone: TZ });
  assert.equal(reopened.storageStats().schemaVersion, STORE_SCHEMA_VERSION);
  assert.equal(reopened.getMemory(legacyId)?.retentionTier, 'long');
  reopened.close();
});

test('raw vectors: append-only INSERT OR IGNORE, immutability triggers, search/list/stats/rebuild/meta; empty-text raws skipped', async () => {
  const dataDir = tmpDataDir();
  const store = openStore({ dataDir, timezone: TZ });
  const items = await seedRaws(store, dataDir, [
    // 空文本 raw（turn/session/permission 等事件）：按 docs/24 §3 不嵌入，也不得造成回填饥饿
    mkRawInput({ text: null, ts: BASE_TS - 1000 }),
    mkRawInput({ text: '   ', ts: BASE_TS - 500 }), // 仅空白文本同样跳过
    mkRawInput({ text: '深色主题 偏好' }),
    mkRawInput({ text: 'the quick brown fox', ts: BASE_TS + 1000 }),
    mkRawInput({ text: '端口 8080', ts: BASE_TS + 2000 }),
  ]);
  const ids = items.map((item) => item.record.id);
  const emptyRawId = ids[0];
  const blankRawId = ids[1];
  const textIds = ids.slice(2); // 有文本的 raw（3 条）
  const conn = db(store);

  // 空文本 raw：不出现在回填列表、不计入 pending（但计入 total）
  let initialStats = store.rawVectorStats(RAW_REF);
  assert.equal(initialStats.total, 5);
  assert.equal(initialStats.pending, 3, 'pending must only count raws with non-empty text');
  assert.equal(initialStats.embedded, 0);
  // 恒等式：embedded + pending === 有文本 raw 数（3）；且 <= total（5，空文本只计入 total）
  assert.equal(initialStats.embedded + initialStats.pending, 3);
  assert.ok(initialStats.embedded + initialStats.pending <= initialStats.total);
  const initialPending = store.listRawWithoutVectors(RAW_REF);
  assert.equal(initialPending.length, 3);
  assert.ok(initialPending.every((row) => row.id !== emptyRawId), 'null-text raw must not be listed');
  assert.ok(initialPending.every((row) => row.id !== blankRawId), 'whitespace-only raw must not be listed');
  assert.ok(initialPending.every((row) => typeof row.text === 'string' && row.text.trim().length > 0));

  // raw 必须已在 raw_index
  assert.throws(
    () => store.putRawVector('2026-10-25-999999', RAW_REF, unit([1, 0, 0, 0])),
    /raw_index/,
  );

  // 写入 + 幂等（同 raw+model 只写一次，不更新）
  store.putRawVector(textIds[0], RAW_REF, unit([1, 0, 0, 0]));
  store.putRawVector(textIds[0], RAW_REF, unit([0, 1, 0, 0]));
  const first = store.getRawVector(textIds[0]);
  assert.deepEqual(first?.ref, RAW_REF);
  assert.ok(Math.abs((first?.vec[0] ?? 0) - 1) < 1e-6, 'second putRawVector must NOT update existing row');
  assert.equal(store.getRawVector('2026-10-25-999999'), null);

  // 不可变触发器：raw 向量 UPDATE/DELETE 直接 ABORT
  assert.throws(
    () => conn.prepare("UPDATE vectors SET dim = dim WHERE owner_kind = 'raw'").run(),
    /append-only/,
  );
  assert.throws(
    () => conn.prepare("DELETE FROM vectors WHERE owner_kind = 'raw'").run(),
    /append-only/,
  );

  // search 排序 / minScore / limit
  store.putRawVector(textIds[1], RAW_REF, unit([0, 1, 0, 0]));
  store.putRawVector(textIds[2], RAW_REF, unit([0.5, 0.5, 0, 0]));
  const hits = store.searchRawVector(unit([1, 0, 0, 0]), RAW_REF);
  assert.equal(hits.length, 3);
  assert.equal(hits[0].rawId, textIds[0]);
  assert.ok(hits[0].score >= hits[1].score && hits[1].score >= hits[2].score);
  assert.deepEqual(
    store.searchRawVector(unit([1, 0, 0, 0]), RAW_REF, { limit: 1 }).map((hit) => hit.rawId),
    [textIds[0]],
  );
  assert.deepEqual(
    store.searchRawVector(unit([1, 0, 0, 0]), RAW_REF, { minScore: 0.95 }).map((hit) => hit.rawId),
    [textIds[0]],
  );

  // listRawWithoutVectors / rawVectorStats：有文本的都已嵌入 => pending 归零（total 仍含空文本 raw）
  assert.deepEqual(store.listRawWithoutVectors(RAW_REF), []);
  const stats = store.rawVectorStats(RAW_REF);
  assert.equal(stats.total, 5);
  assert.equal(stats.pending, 0, 'pending must reach 0 once every text-bearing raw is embedded');
  assert.equal(stats.embedded, 3);
  assert.equal(stats.embedded + stats.pending, 3);
  assert.ok(stats.embedded + stats.pending <= stats.total);
  assert.deepEqual(stats.ref, RAW_REF);
  assert.equal(stats.lastBackfillAt, null);

  // meta（key 前缀 raw_vectors.）
  store.setRawVectorMeta('raw_vectors.lastBackfillAt', String(BASE_TS + 99));
  assert.equal(store.getRawVectorMeta('raw_vectors.lastBackfillAt'), String(BASE_TS + 99));
  assert.equal(store.rawVectorStats(RAW_REF).lastBackfillAt, BASE_TS + 99);
  assert.throws(() => store.setRawVectorMeta('other.key', 'x'), /raw_vectors\./);
  assert.equal(store.getRawVectorMeta('other.key'), null);

  // 重建：清空 raw 向量、恢复触发器、pending 反映「有文本但缺向量」的数量
  const rebuilt = store.rebuildRawVectors();
  assert.deepEqual(rebuilt, { removed: 3 });
  const afterRebuildStats = store.rawVectorStats(RAW_REF);
  assert.equal(afterRebuildStats.total, 5);
  assert.equal(afterRebuildStats.embedded, 0);
  assert.equal(afterRebuildStats.pending, 3);
  assert.equal(afterRebuildStats.embedded + afterRebuildStats.pending, 3);
  const pendingAfterRebuild = store.listRawWithoutVectors(RAW_REF);
  assert.deepEqual(pendingAfterRebuild.map((row) => row.id), textIds);
  assert.ok(pendingAfterRebuild.every((row) => row.id !== emptyRawId && row.id !== blankRawId));
  assert.equal(store.listRawWithoutVectors(RAW_REF, 1).length, 1);
  assert.equal(store.listRawWithoutVectors(RAW_REF)[0].text, items[2].record.text); // 首条有文本 raw
  // 重建后触发器已恢复（需先有一条 raw 向量，BEFORE UPDATE 触发器才逐行触发）
  store.putRawVector(textIds[0], RAW_REF, unit([1, 0, 0, 0]));
  assert.throws(
    () => conn.prepare("UPDATE vectors SET norm = norm WHERE owner_kind = 'raw'").run(),
    /append-only/,
  );
  const partialStats = store.rawVectorStats(RAW_REF);
  assert.equal(partialStats.embedded, 1);
  assert.equal(partialStats.pending, 2);
  assert.equal(partialStats.embedded + partialStats.pending, 3);
  store.close();
});

test('searchRawLexical: Chinese/English raw_fts, OR fallback, degenerate rank protection, CJK LIKE fallback', async () => {
  const dataDir = tmpDataDir();
  const store = openStore({ dataDir, timezone: TZ });
  const items = await seedRaws(store, dataDir, [
    mkRawInput({ text: '我喜欢用深色主题' }),
    mkRawInput({ text: '浅色主题也可以', ts: BASE_TS + 1000 }),
    mkRawInput({ text: 'the quick brown fox jumps', ts: BASE_TS + 2000 }),
  ]);
  const ids = items.map((item) => item.record.id);

  const chinese = store.searchRawLexical('深色主题');
  assert.equal(chinese[0]?.rawId, ids[0]);
  assert.ok(chinese[0].score > 0 && chinese[0].score < 1);
  // 退化保护：单文档小语料下 bm25 量纲会退化（~1e-6），改用名次分（top=1）
  {
    const degenerateDir = tmpDataDir();
    const degenerateStore = openStore({ dataDir: degenerateDir, timezone: TZ });
    await seedRaws(degenerateStore, degenerateDir, [mkRawInput({ text: '只有一个文档的深色主题' })]);
    const degenerate = degenerateStore.searchRawLexical('深色主题');
    assert.equal(degenerate.length, 1);
    assert.equal(degenerate[0].score, 1);
    degenerateStore.close();
  }

  const english = store.searchRawLexical('quick fox');
  assert.equal(english[0]?.rawId, ids[2]);

  // AND 0 命中 -> OR 降级（没有任何 raw 同时含 深色 与 浅色）
  const orHits = store.searchRawLexical('深色 浅色');
  assert.deepEqual(new Set(orHits.map((hit) => hit.rawId)), new Set([ids[0], ids[1]]));

  // 单字 CJK：bigram 索引无法命中 -> LIKE 兜底（固定低分 0.25）
  const single = store.searchRawLexical('深');
  assert.equal(single[0]?.rawId, ids[0]);
  assert.equal(single[0]?.score, 0.25);

  assert.deepEqual(store.searchRawLexical(''), []);
  assert.deepEqual(store.searchRawLexical('   '), []);
  assert.equal(store.searchRawLexical('quick fox', { limit: 1 }).length, 1);
  assert.deepEqual(store.searchRawLexical('quick fox', { minScore: 0.99 }), []);
  store.close();
});

test('forgetting: short delete cascades derived artifacts, mid archive, protections, L3 long guard, raw untouched', async () => {
  const dataDir = tmpDataDir();
  const store = openStore({ dataDir, timezone: TZ });
  const raws = await seedRaws(store, dataDir, [
    mkRawInput({ text: '遗忘测试原始记录一' }),
    mkRawInput({ text: '遗忘测试原始记录二', ts: BASE_TS + 1000 }),
  ]);
  const rawIds = raws.map((item) => item.record.id);
  // 原始层向量（应完全不受遗忘影响）
  store.putRawVector(rawIds[0], RAW_REF, unit([1, 0, 0, 0]));
  store.putRawVector(rawIds[1], RAW_REF, unit([0, 1, 0, 0]));
  const rawCountBefore = store.storageStats().rawCount;
  const rawPendingBefore = store.rawVectorStats(RAW_REF).pending;

  const oldTs = BASE_TS - 10 * DAY_MS;
  const ageRecord = (id: string): void => {
    db(store).prepare('UPDATE memory_records SET updated_at = ? WHERE id = ?').run(oldTs, id);
  };
  const makeMemory = (
    seed: number,
    layer: string,
    kind: 'atom' | 'summary' | 'fact',
    text: string,
    extra: { importance?: number; pinned?: boolean } = {},
  ) => {
    const memory = store.upsertMemory({
      id: memoryId(seed, layer, kind),
      layer,
      kind,
      text,
      sourceRawIds: rawIds,
      importance: extra.importance,
      pinned: extra.pinned,
    });
    return memory;
  };

  const shortExpired = makeMemory(200, 'L1', 'atom', '短期到期条目');
  store.putVector('memory', shortExpired.id, REF_512, new Float32Array(512).fill(0));
  ageRecord(shortExpired.id);
  const shortPinned = makeMemory(201, 'L1', 'atom', '短期钉住条目', { pinned: true });
  ageRecord(shortPinned.id);
  const shortImportant = makeMemory(202, 'L1', 'atom', '短期高重要度条目', { importance: 0.95 });
  ageRecord(shortImportant.id);
  const shortFresh = makeMemory(203, 'L1', 'atom', '短期但未到期条目');
  const midExpired = makeMemory(204, 'L2', 'summary', '中期到期条目');
  store.setRetention(midExpired.id, { tier: 'mid', score: 0.6, pinned: false, promotedAt: null, longTermAt: null }, BASE_TS + 1);
  ageRecord(midExpired.id);
  const l3Long = makeMemory(205, 'L3', 'fact', '长期语义条目');
  store.setRetention(l3Long.id, { tier: 'long', score: 0.9, pinned: true, promotedAt: null, longTermAt: null }, BASE_TS + 2);
  ageRecord(l3Long.id);
  const l3Short = makeMemory(206, 'L3', 'fact', '短期语义条目');
  ageRecord(l3Short.id);

  // delete：short 到期（保护 pinned / importance>=0.9）
  const deleted = store.forgetDerivedMemories({
    tiers: ['short'],
    mode: 'delete',
    olderThan: BASE_TS - 5 * DAY_MS,
    protectPinned: true,
    protectImportance: 0.9,
  });
  assert.equal(deleted.deleted, 2); // shortExpired + l3Short（L3 short 允许删除）
  assert.ok(deleted.ids.includes(shortExpired.id));
  assert.ok(deleted.ids.includes(l3Short.id));
  assert.equal(deleted.archived, 0);
  assert.equal(store.getMemory(shortExpired.id), null);
  assert.equal(store.getVector(shortExpired.id), null); // 临时向量级联清理
  assert.deepEqual(store.listSources(shortExpired.id), []);
  assert.ok(!store.searchLexical('短期到期条目').some((hit) => hit.id === shortExpired.id));
  // 保护项保留
  assert.ok(store.getMemory(shortPinned.id) !== null);
  assert.ok(store.getMemory(shortImportant.id) !== null);
  assert.ok(store.getMemory(shortFresh.id) !== null);
  // 非 short 层不受影响
  assert.ok(store.getMemory(midExpired.id) !== null);
  assert.ok(store.getMemory(l3Long.id) !== null);

  // L3 long：DB 触发器拒绝物理删除
  assert.throws(
    () => db(store).prepare('DELETE FROM memory_records WHERE id = ?').run(l3Long.id),
    /long-term L3/,
  );
  // tiers=['long'] 的 delete 请求不会删除 L3 long（候选排除）
  const deleteLong = store.forgetDerivedMemories({
    tiers: ['long'],
    mode: 'delete',
    olderThan: BASE_TS + 10 * 365 * DAY_MS,
  });
  assert.equal(deleteLong.deleted, 0);
  assert.ok(store.getMemory(l3Long.id) !== null);

  // archive：mid 到期 -> status=archived + valid_to + revision++ + 快照；内容仍可查
  const beforeArchiveRevision = store.getMemory(midExpired.id)?.revision ?? 0;
  const archived = store.forgetDerivedMemories({
    tiers: ['mid'],
    mode: 'archive',
    olderThan: BASE_TS - 5 * DAY_MS,
  });
  assert.equal(archived.deleted, 0);
  assert.equal(archived.archived, 1);
  assert.deepEqual(archived.ids, [midExpired.id]);
  const archivedRecord = store.getMemory(midExpired.id);
  assert.equal(archivedRecord?.status, 'archived');
  assert.ok((archivedRecord?.validTo ?? 0) > 0);
  assert.equal(archivedRecord?.revision, beforeArchiveRevision + 1);
  assert.ok(store.listRevisions(midExpired.id).some((revision) => revision.changeKind === 'archive'));
  assert.ok(!store.searchLexical('中期到期条目').some((hit) => hit.id === midExpired.id));
  // 默认 listMemories 不过滤 status => 仍可读到归档内容
  assert.ok(store.listMemories({ ids: [midExpired.id] }).length === 1);

  // layers 过滤：只处理指定层
  const l2Only = makeMemory(207, 'L2', 'summary', '仅 L2 层到期');
  ageRecord(l2Only.id);
  const filtered = store.forgetDerivedMemories({
    layers: ['L1'],
    tiers: ['short'],
    mode: 'delete',
    olderThan: BASE_TS - 5 * DAY_MS,
  });
  assert.ok(!filtered.ids.includes(l2Only.id));
  assert.ok(store.getMemory(l2Only.id) !== null);
  const filteredL2 = store.forgetDerivedMemories({
    layers: ['L2'],
    tiers: ['short'],
    mode: 'delete',
    olderThan: BASE_TS - 5 * DAY_MS,
  });
  assert.ok(filteredL2.ids.includes(l2Only.id));

  // L0 / raw_index / 原始层向量完全未动
  assert.equal(store.storageStats().rawCount, rawCountBefore);
  assert.equal(store.listRawIndex().total, rawCountBefore);
  assert.equal(store.rawVectorStats(RAW_REF).pending, rawPendingBefore);
  assert.equal(store.rawVectorStats(RAW_REF).total, rawCountBefore);

  // 参数校验
  assert.throws(
    () =>
      store.forgetDerivedMemories({
        mode: 'bogus' as never,
        olderThan: BASE_TS,
      }),
    /mode/,
  );
  assert.throws(
    () =>
      store.forgetDerivedMemories({
        mode: 'delete',
        olderThan: Number.NaN,
      }),
    /olderThan/,
  );

  // 遗忘审计计数：原子累加 + 时间
  assert.deepEqual(store.forgettingStats(), { shortDeleted: 0, midArchived: 0, lastForgetAt: null });
  store.recordForgetting({ deletedShort: 2, archivedMid: 1 }, BASE_TS + 777);
  assert.deepEqual(store.forgettingStats(), {
    shortDeleted: 2,
    midArchived: 1,
    lastForgetAt: BASE_TS + 777,
  });
  store.recordForgetting({ deletedShort: 1 }, BASE_TS + 778);
  assert.deepEqual(store.forgettingStats(), {
    shortDeleted: 3,
    midArchived: 1,
    lastForgetAt: BASE_TS + 778,
  });
  assert.throws(() => store.recordForgetting({ deletedShort: -1 }), /non-negative/);
  store.close();
});

test('migration: v3 database upgrades in place to v4 (persona_id columns, data preserved, idempotent)', () => {
  const dataDir = tmpDataDir();
  mkdirSync(dataDir, { recursive: true });
  const dbPath = join(dataDir, 'vault.db');
  const raw = new DatabaseSync(dbPath);
  for (const pragma of CONNECTION_PRAGMAS) {
    if (/^\s*PRAGMA\s+user_version/i.test(pragma)) continue;
    try {
      raw.exec(pragma);
    } catch {
      /* 平台相关 PRAGMA 可忽略 */
    }
  }
  raw.exec(SCHEMA_V1_SQL);
  raw.exec(MIGRATION_2_SQL);
  raw.exec(MIGRATION_3_SQL);
  for (const [version, description, checksum] of [
    [1, 'initial', SCHEMA_V1_SHA256],
    [2, 'retention', MIGRATION_2_SHA256],
    [3, 'access-split', MIGRATION_3_SHA256],
  ] as const) {
    raw
      .prepare(
        'INSERT OR REPLACE INTO schema_migrations(version, applied_at, description, checksum) VALUES (?, ?, ?, ?)',
      )
      .run(version, BASE_TS, description, checksum);
  }
  raw.exec('PRAGMA user_version = 3;');
  const legacyId = 'L3-fact-m9k2x1-c3d4e5f6';
  const legacyText = 'v3 时代的长期事实';
  raw
    .prepare(
      'INSERT INTO memory_records(id, layer, kind, text, text_seg, created_at, updated_at, content_hash, ' +
        'retention_tier, retention_score, pinned, promoted_at, long_term_at) ' +
        'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    )
    .run(
      legacyId,
      'L3',
      'fact',
      legacyText,
      textToTextSeg(legacyText),
      BASE_TS,
      BASE_TS,
      contentHash('L3', 'fact', legacyText),
      'long',
      0.85,
      1,
      1111,
      2222,
    );
  raw.close();

  const store = openStore({ dataDir, timezone: TZ });
  assert.equal(store.storageStats().schemaVersion, STORE_SCHEMA_VERSION);
  const conn = db(store);
  assert.equal(
    Number((conn.prepare('PRAGMA user_version').get() as { user_version: number }).user_version),
    STORE_SCHEMA_VERSION,
  );
  // 旧行保留（retention 数据不变），新增 persona_id 列为 NULL（共享）
  const migrated = store.getMemory(legacyId);
  assert.ok(migrated !== null);
  assert.equal(migrated?.text, legacyText);
  assert.equal(migrated?.retentionTier, 'long');
  assert.equal(migrated?.retentionScore, 0.85);
  assert.equal(migrated?.personaId ?? null, null);

  // 新列 + 索引存在
  const memoryColumns = (conn.prepare('PRAGMA table_info(memory_records)').all() as Array<{ name: string }>).map(
    (column) => column.name,
  );
  const rawColumns = (conn.prepare('PRAGMA table_info(raw_index)').all() as Array<{ name: string }>).map(
    (column) => column.name,
  );
  assert.ok(memoryColumns.includes('persona_id'));
  assert.ok(rawColumns.includes('persona_id'));
  const objectNames = new Set(
    (conn.prepare("SELECT name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'").all() as Array<{ name: string }>).map(
      (row) => row.name,
    ),
  );
  for (const name of ['ix_mem_persona', 'ix_raw_persona']) {
    assert.ok(objectNames.has(name), 'missing ' + name);
  }

  const ledger = conn
    .prepare('SELECT version, checksum FROM schema_migrations ORDER BY version')
    .all() as Array<{ version: number; checksum: string }>;
  assert.deepEqual(ledger.map((row) => Number(row.version)), [1, 2, 3, 4]);
  assert.equal(ledger[3].checksum, MIGRATION_4_SHA256);
  store.close();

  // 幂等重开
  const reopened = openStore({ dataDir, timezone: TZ });
  assert.equal(reopened.storageStats().schemaVersion, STORE_SCHEMA_VERSION);
  assert.equal(reopened.getMemory(legacyId)?.retentionTier, 'long');
  assert.equal(reopened.getMemory(legacyId)?.personaId ?? null, null);
  reopened.close();
});

test('persona: memory scope write/read/filter, update semantics, counts, active persona meta', () => {
  const dataDir = tmpDataDir();
  const store = openStore({ dataDir, timezone: TZ });
  const coder1 = store.upsertMemory({
    id: memoryId(300, 'L3', 'fact'),
    layer: 'L3',
    kind: 'fact',
    text: 'coder 事实一',
    sourceRawIds: ['r1'],
    personaId: 'coder',
  });
  const coder2 = store.upsertMemory({
    id: memoryId(301, 'L1', 'atom'),
    layer: 'L1',
    kind: 'atom',
    text: 'coder 工作原子',
    sourceRawIds: ['r1'],
    personaId: 'coder',
  });
  const writer = store.upsertMemory({
    id: memoryId(302, 'L2', 'summary'),
    layer: 'L2',
    kind: 'summary',
    text: 'writer 情节',
    sourceRawIds: ['r1'],
    personaId: 'writer',
  });
  const shared = store.upsertMemory({
    id: memoryId(303, 'L3', 'fact'),
    layer: 'L3',
    kind: 'fact',
    text: '共享事实',
    sourceRawIds: ['r1'],
    personaId: null,
  });
  const unspecified = store.upsertMemory({
    id: memoryId(304, 'L3', 'fact'),
    layer: 'L3',
    kind: 'fact',
    text: '未指定人格（默认共享）',
    sourceRawIds: ['r1'],
  });
  assert.equal(coder1.personaId, 'coder');
  assert.equal(writer.personaId, 'writer');
  assert.equal(shared.personaId, null);
  assert.equal(unspecified.personaId, null, '直接列默认 NULL = 共享');

  // 查询作用域：不传 = 全部；string 默认含共享；includeSharedPersona=false 仅该人格；null = 仅共享
  assert.equal(store.listMemories().length, 5);
  assert.deepEqual(
    new Set(store.listMemories({ personaId: 'coder' }).map((memory) => memory.id)),
    new Set([coder1.id, coder2.id, shared.id, unspecified.id]),
  );
  assert.deepEqual(
    store.listMemories({ personaId: 'coder', includeSharedPersona: false }).map((memory) => memory.id).sort(),
    [coder1.id, coder2.id].sort(),
  );
  assert.equal(store.listMemories({ personaId: null }).length, 2);
  assert.equal(store.listMemories({ personaId: 'writer' }).length, 3); // writer + shared + unspecified

  // 更新语义：未显式传 personaId => 保留；显式 null => 清为共享；显式 string => 改归属
  const contentUpdated = store.upsertMemory({
    id: coder1.id,
    layer: 'L3',
    kind: 'fact',
    text: 'coder 事实二',
    sourceRawIds: ['r1'],
  });
  assert.equal(contentUpdated.personaId, 'coder');
  assert.equal(contentUpdated.revision, 2);
  const revisionAfterContent = contentUpdated.revision;
  const updatedAtAfterContent = contentUpdated.updatedAt;
  const personaOnly = store.upsertMemory({
    id: coder1.id,
    layer: 'L3',
    kind: 'fact',
    text: 'coder 事实二',
    sourceRawIds: ['r1'],
    personaId: 'writer',
  });
  assert.equal(personaOnly.personaId, 'writer');
  assert.equal(personaOnly.revision, revisionAfterContent, 'persona 变更不 bump revision');
  assert.equal(personaOnly.updatedAt, updatedAtAfterContent, 'persona 变更不改 updated_at');
  const personaCleared = store.upsertMemory({
    id: coder1.id,
    layer: 'L3',
    kind: 'fact',
    text: 'coder 事实二',
    sourceRawIds: ['r1'],
    personaId: null,
  });
  assert.equal(personaCleared.personaId, null);

  // 统计（status='active'；archived 不计入）
  const archivedCoder = store.upsertMemory({
    id: memoryId(305, 'L1', 'atom'),
    layer: 'L1',
    kind: 'atom',
    text: 'coder 已归档原子',
    sourceRawIds: ['r1'],
    personaId: 'coder',
    status: 'archived',
  });
  assert.equal(archivedCoder.status, 'archived');
  const counts = store.countMemoriesByPersona();
  assert.deepEqual(counts.counts.coder, { total: 1, L1: 1, L2: 0, L3: 0 });
  assert.deepEqual(counts.counts.writer, { total: 1, L1: 0, L2: 1, L3: 0 });
  assert.equal(counts.shared, 3); // shared + unspecified + 已改回共享的 coder1

  // 激活人格 meta（persist across restart；null/空串 = 清除）
  assert.equal(store.getActivePersonaId(), null);
  store.setActivePersonaId('coder');
  assert.equal(store.getActivePersonaId(), 'coder');
  store.close();

  const reopened = openStore({ dataDir, timezone: TZ });
  assert.equal(reopened.getActivePersonaId(), 'coder');
  reopened.setActivePersonaId(null);
  assert.equal(reopened.getActivePersonaId(), null);
  reopened.setActivePersonaId('writer');
  reopened.setActivePersonaId('');
  assert.equal(reopened.getActivePersonaId(), null);
  reopened.setActivePersonaId('  ');
  assert.equal(reopened.getActivePersonaId(), null);
  reopened.close();
});

test('persona: raw_index persona metadata only — L0 line bytes/hash unchanged, append-only intact', async () => {
  const dataDir = tmpDataDir();
  const store = openStore({ dataDir, timezone: TZ });
  const vault = await openRawVault(
    {
      rootDir: dataDir,
      timezone: TZ,
      fsync: false,
      seenIngestKeys: (key) => store.hasRawIngestKey(key),
    },
    { writerInfo: false },
  );
  try {
    const result = await vault.append([
      mkRawInput({ text: '带人格的原始记录', personaId: 'coder' }),
      mkRawInput({ text: '共享原始记录', ts: BASE_TS + 1000, personaId: null }),
    ]);
    const [withPersona, sharedRaw] = result.items;
    // 内存记录携带 personaId（供索引），但 L0 行不包含它
    assert.equal(withPersona.record.personaId, 'coder');
    const rel = result.segmentsWritten[0];
    const file = join(dataDir, ...rel.split('/'));
    const contentBefore = readFileSync(file, 'utf8');
    assert.ok(!contentBefore.toLowerCase().includes('personaid'), 'personaId must never appear in L0 line');
    const lines = contentBefore.split('\n').filter((line) => line.length > 0);
    assert.equal(lines[0], serializeRecordLine(withPersona.record));
    assert.ok(lines[0].endsWith(`"hash":"${withPersona.record.hash}"}`));

    store.indexRawRecords(result.items);
    // 索引列写入 persona_id；L0 文件字节不变（索引只写 SQLite）
    assert.equal(store.getRawIndex(withPersona.record.id)?.personaId, 'coder');
    assert.equal(store.getRawIndex(sharedRaw.record.id)?.personaId, null);
    assert.equal(readFileSync(file, 'utf8'), contentBefore);
    // raw 查询过滤
    assert.deepEqual(
      store.listRawIndex({ personaId: 'coder' }).records.map((row) => row.id),
      [withPersona.record.id],
    );
    assert.deepEqual(
      store.listRawIndex({ personaId: null }).records.map((row) => row.id),
      [sharedRaw.record.id],
    );
    assert.equal(store.listRawIndex().total, 2);
    // 哈希链/字节校验仍然 OK
    const verified = await vault.verify();
    assert.deepEqual(verified, { ok: true, checked: 2 });
  } finally {
    await vault.close();
    store.close();
  }
});

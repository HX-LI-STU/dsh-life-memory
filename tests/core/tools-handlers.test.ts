/** 工具处理器测试（fake store/vault/recaller，验证协议形状、脱敏、错误码） */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  formatHitCitation,
  handleTool,
  memoryGetRaw,
  memoryLayers,
  memoryRecall,
  memorySave,
  memoryStatus,
} from '../../src/tools/handlers.ts';
import type { ToolContext } from '../../src/tools/handlers.ts';
import { TOOL_DEFINITIONS } from '../../src/tools/schemas.ts';
import { DEFAULT_CONFIG } from '../../src/config.ts';
import type {
  AppendResult,
  CaptureStats,
  LayerRegistryRow,
  MemoryRecord,
  MemoryStore,
  RawRecord,
  RawQuery,
  RawVault,
  RecallHit,
  RecallQuery,
  Recaller,
  VaultHealth,
  VaultManifest,
  VerifyResult,
  VaultStats,
} from '../../src/core/contracts.ts';

function memory(overrides: Partial<MemoryRecord> = {}): MemoryRecord {
  return {
    id: 'L3-preference-abc-12345678',
    layer: 'L3',
    kind: 'preference',
    text: '用户偏好深色主题',
    summary: '深色主题偏好',
    importance: 0.8,
    confidence: 0.9,
    sourceRawIds: ['2026-10-25-000001'],
    sessionId: 's1',
    workspace: 'D:\\work\\proj',
    tags: ['theme'],
    createdAt: 1761390000000,
    updatedAt: 1761390000000,
    revision: 1,
    contentHash: 'h'.repeat(64),
    status: 'active',
    ...overrides,
  };
}

function rawRecord(overrides: Partial<RawRecord> = {}): RawRecord {
  return {
    id: '2026-10-25-000001',
    seq: 1,
    ts: 1761390000000,
    iso: '2026-10-25T15:00:00.000Z',
    day: '2026-10-25',
    timezone: 'Asia/Shanghai',
    kind: 'user',
    sessionId: 's1',
    workspace: 'D:\\work\\proj',
    role: 'user',
    text: '我喜欢用深色主题',
    payload: { type: 'user/message', seq: 1 },
    hash: 'a'.repeat(64),
    prevHash: '0'.repeat(64),
    v: 1,
    ...overrides,
  };
}

class FakeVault implements RawVault {
  records = new Map<string, RawRecord>();
  appended: RawRecord[] = [];
  async append(batch: Parameters<RawVault['append']>[0]): Promise<AppendResult> {
    const items = batch.map((input, i) => {
      const record = rawRecord({ ...input, id: `2026-10-25-${String(this.appended.length + i + 1).padStart(6, '0')}`, seq: this.appended.length + i + 1 } as Partial<RawRecord>);
      this.appended.push(record);
      this.records.set(record.id, record);
      return { record, location: { ingestKey: input.ingestKey ?? 'auto', segment: 'segments/2026-10-25/seg-wabcdef-000001.jsonl', lineNo: this.appended.length, byteOffset: 0, byteLen: 100 } };
    });
    return { items, skipped: 0, segmentsWritten: ['segments/2026-10-25/seg-wabcdef-000001.jsonl'] };
  }
  async get(id: string): Promise<RawRecord | null> {
    return this.records.get(id) ?? null;
  }
  async list(): Promise<{ records: RawRecord[]; total: number }> {
    return { records: [...this.records.values()], total: this.records.size };
  }
  async *iterate(): AsyncIterable<RawRecord> {}
  async verify(): Promise<VerifyResult> {
    return { ok: true, checked: this.records.size };
  }
  async stats(): Promise<VaultStats> {
    return { records: this.records.size, segments: 1, days: 1, bytes: 1024, firstId: '2026-10-25-000001', lastId: '2026-10-25-000001' };
  }
  async manifest(): Promise<VaultManifest> {
    return { formatVersion: 1, vaultId: 'v1', updatedAt: 0, segments: [], stats: { records: 0, days: 0, bytes: 0 } };
  }
  async close(): Promise<void> {}
}

class FakeStore {
  rawIndex = new Map<string, MemoryStore['getRawIndex'] extends (id: string) => infer R ? R : never>();
  indexed: string[] = [];
  layers: LayerRegistryRow[] = [
    { id: 'L1', name: 'L1 短期/工作层', version: 1, dependsOn: [], kind: 'builtin', enabled: true, rebuildable: true, count: 10, active: 9, archived: 1, latestUpdatedAt: 1761390000000 },
    { id: 'L2', name: 'L2 中期/情节层', version: 1, dependsOn: ['L1'], kind: 'builtin', enabled: true, rebuildable: true, count: 3, active: 3, archived: 0, latestUpdatedAt: 1761390000000 },
    { id: 'L3', name: 'L3 长期/语义层', version: 1, dependsOn: ['L1', 'L2'], kind: 'builtin', enabled: true, rebuildable: true, count: 1, active: 1, archived: 0, latestUpdatedAt: 1761390000000 },
  ];
  indexRawRecords(items: { record: RawRecord; location: { ingestKey: string; segment: string; lineNo: number; byteOffset: number; byteLen: number } }[]): void {
    for (const item of items) {
      this.indexed.push(item.record.id);
      this.rawIndex.set(item.record.id, {
        id: item.record.id,
        seq: item.record.seq,
        ts: item.record.ts,
        iso: item.record.iso,
        day: item.record.day,
        timezone: item.record.timezone,
        kind: item.record.kind,
        sessionId: item.record.sessionId,
        workspace: item.record.workspace ?? null,
        personaId: item.record.personaId ?? null,
        turnId: item.record.turnId ?? null,
        stepId: item.record.stepId ?? null,
        role: item.record.role ?? null,
        text: item.record.text ?? null,
        textSeg: '',
        payloadJson: '{}',
        hash: item.record.hash,
        prevHash: item.record.prevHash,
        segment: item.location.segment,
        lineNo: item.location.lineNo,
        byteOffset: item.location.byteOffset,
        byteLen: item.location.byteLen,
        recordVersion: 1,
        ingestKey: item.location.ingestKey,
        createdAt: 0,
      });
    }
  }
  hasRawIngestKey(): boolean {
    return false;
  }
  getRawIndex(id: string) {
    return this.rawIndex.get(id) ?? null;
  }
  listLayers(): LayerRegistryRow[] {
    return this.layers;
  }
  listIntegrityRuns() {
    return [];
  }
  listRepairLog() {
    return [];
  }
  embeddingCoverage() {
    return { L1: 9, L2: 3, L3: 1 };
  }
}

class FakeRecaller implements Recaller {
  lastQuery: RecallQuery | null = null;
  hits: RecallHit[] = [];
  async recall(query: RecallQuery): Promise<RecallHit[]> {
    this.lastQuery = query;
    return this.hits;
  }
  async buildPromptSection(): Promise<string> {
    return '';
  }
  formatHit(): string {
    return '';
  }
}

const captureStats: CaptureStats = { captured: 10, failed: 0, queued: 0, lastCaptureAt: 1761390000000, dropped: 0 };

function makeCtx(overrides: Partial<ToolContext> = {}) {
  const vault = new FakeVault();
  const store = new FakeStore();
  const recaller = new FakeRecaller();
  const health: VaultHealth = {
    ok: true,
    dataDir: 'C:\\x\\life-memory',
    vault: { records: 10, segments: 1, days: 1, bytes: 1024 },
    storage: { dbPath: 'vault.db', dbBytes: 2048, rawCount: 10, memoryCount: 4, activeMemoryCount: 4, vectorCount: 4, segmentCount: 1, embedding: { model: 'dsh-local-hash-v1', dim: 512, version: '1' }, schemaVersion: 1 },
    layers: [],
    capture: captureStats,
    embedder: { model: 'dsh-local-hash-v1', dim: 512, version: '1' },
    retention: { short: 0, mid: 0, long: 0, pinned: 0, lastTickAt: null },
    persona: { enabled: true, activeId: null, activeName: null, definitions: [], memoryCounts: {}, sharedCount: 0, lastError: null },
    vectors: { total: 0, embedded: 0, pending: 0, ref: { model: 'dsh-local-hash-v1', dim: 512, version: '1' }, lastBackfillAt: null },
    forgetting: { shortDeleted: 0, midArchived: 0, lastForgetAt: null },
    lastDeriveAt: null,
    lastError: null,
    uptimeMs: 1000,
  };
  const ctx: ToolContext = {
    config: { ...DEFAULT_CONFIG, timezone: 'Asia/Shanghai', dataDir: 'C:\\x\\life-memory' },
    store: store as unknown as MemoryStore,
    vault,
    recaller,
    health: async () => health,
    captureStats: () => captureStats,
    deriveStats: () => ({ cursors: { L1: 10, L2: 8, L3: 6 }, pendingJobs: 0, lastDeriveAt: 1761390000000 }),
    hashRawRecord: () => 'a'.repeat(64),
    now: () => 1761390001000,
    ...overrides,
  };
  return { ctx, vault, store, recaller };
}

test('schemas: 17 个工具定义齐全（5 记忆 + 8 人格/会话 + 4 导出导入）且字段与文档一致', () => {
  assert.deepEqual(TOOL_DEFINITIONS.map((t) => t.name), [
    'memory_recall',
    'memory_save',
    'memory_status',
    'memory_get_raw',
    'memory_layers',
    'memory_persona_list',
    'memory_persona_use',
    'memory_persona_current',
    'memory_persona_reload',
    'memory_persona_create',
    'memory_persona_update',
    'memory_persona_delete',
    'memory_session_config',
    'memory_export_session',
    'memory_import_session',
    'memory_export_vault',
    'memory_import_vault',
  ]);
  const recall = TOOL_DEFINITIONS[0];
  assert.deepEqual(recall.inputSchema.required, ['query']);
  assert.ok(String(recall.inputSchema.properties && (recall.inputSchema.properties as Record<string, unknown>).query));
  const save = TOOL_DEFINITIONS[1];
  assert.deepEqual(save.inputSchema.required, ['text']);
  // v5：CRUD/session-config 必填字段
  const create = TOOL_DEFINITIONS[9];
  assert.deepEqual(create.inputSchema.required, ['name', 'body']);
  const update = TOOL_DEFINITIONS[10];
  assert.deepEqual(update.inputSchema.required, ['id']);
  const remove = TOOL_DEFINITIONS[11];
  assert.deepEqual(remove.inputSchema.required, ['id']);
  // v6：导出/导入工具必填字段
  const exportSession = TOOL_DEFINITIONS[13];
  assert.equal(exportSession.name, 'memory_export_session');
  assert.deepEqual(exportSession.inputSchema.required, undefined);
  const importSession = TOOL_DEFINITIONS[14];
  assert.equal(importSession.name, 'memory_import_session');
  assert.deepEqual(importSession.inputSchema.required, ['path']);
  const exportVault = TOOL_DEFINITIONS[15];
  assert.equal(exportVault.name, 'memory_export_vault');
  assert.deepEqual(exportVault.inputSchema.required, undefined);
  const importVault = TOOL_DEFINITIONS[16];
  assert.equal(importVault.name, 'memory_import_vault');
  assert.deepEqual(importVault.inputSchema.required, ['path', 'vault']);
});

test('memory_recall: 返回协议形状、引用与四成分', async () => {
  const { ctx, recaller, vault } = makeCtx();
  vault.records.set('2026-10-25-000001', rawRecord());
  recaller.hits = [
    {
      layer: 'L3',
      memory: memory(),
      score: 0.8421,
      components: { vector: 0.71, lexical: 0.95, recency: 0.99, importance: 0.8 },
      citations: ['L3-preference-abc-12345678', '2026-10-25-000001'],
    },
  ];
  const result = await memoryRecall({ query: '深色主题', limit: 5 }, ctx);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.query, '深色主题');
  assert.equal(result.returned, 1);
  const items = result.items as Array<Record<string, unknown>>;
  assert.equal(items[0].layer, 'L3');
  assert.equal(items[0].score, 0.8421);
  assert.deepEqual(Object.keys(items[0].components as object).sort(), ['importance', 'lexical', 'recency', 'vector']);
  const citations = items[0].citations as Array<{ memoryId: string; rawIds: string[] }>;
  assert.equal(citations[0].memoryId, 'L3-preference-abc-12345678');
  assert.deepEqual(citations[0].rawIds, ['2026-10-25-000001']);
  const raw = items[0].raw as Array<Record<string, unknown>>;
  assert.equal(raw[0].id, '2026-10-25-000001');
  assert.equal(raw[0].excerpt, '我喜欢用深色主题');
  assert.equal(recaller.lastQuery?.text, '深色主题');
  assert.equal(recaller.lastQuery?.trackAccess, true);
});

test('memory_recall: 派生文本脱敏命中密钥，原始 excerpt 保持', async () => {
  const { ctx, recaller } = makeCtx();
  recaller.hits = [
    {
      layer: 'L3',
      memory: memory({ text: '用户的 API key 是 sk-abcdefghijklmnopqrstuvwx，注意保密' }),
      score: 0.5,
      components: { vector: 0.5, lexical: 0.5, recency: 0.5, importance: 0.5 },
      citations: ['2026-10-25-000001'],
    },
  ];
  const result = await memoryRecall({ query: 'key', includeRaw: false }, ctx);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const items = result.items as Array<Record<string, unknown>>;
  assert.ok(String(items[0].text).includes('[REDACTED:api-key]'));
  assert.ok(!String(items[0].text).includes('sk-abcdefghijklmnopqrstuvwx'));
});

test('memory_recall: 参数校验与 token 预算截断', async () => {
  const { ctx, recaller } = makeCtx();
  assert.equal((await memoryRecall({}, ctx)).ok, false);
  assert.equal((await memoryRecall({ query: 'x'.repeat(2001) }, ctx)).ok, false);

  recaller.hits = Array.from({ length: 20 }, (_, i) => ({
    layer: 'L1' as const,
    memory: memory({ id: `L1-atom-${i}`, text: '很长的记忆内容'.repeat(200), layer: 'L1', kind: 'atom', sourceRawIds: [`2026-10-25-0000${String(i).padStart(2, '0')}`] }),
    score: 0.9 - i * 0.01,
    components: { vector: 0.9, lexical: 0.5, recency: 0.9, importance: 0.5 },
    citations: [`2026-10-25-0000${String(i).padStart(2, '0')}`],
  }));
  const result = await memoryRecall({ query: '记忆', limit: 20, budgetTokens: 300, includeRaw: false }, ctx);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.ok((result.items as unknown[]).length < 20);
  assert.equal(result.truncated, true);
});

test('memory_save: 先写 L0 note，再派生 L3，返回回执', async () => {
  const saveExplicit = async (input: { sourceRawIds: string[]; text: string }) => {
    assert.equal(input.sourceRawIds.length, 1);
    return { memoryId: 'L3-fact-x', layer: 'L3', revision: 1, dedup: 'created' as const, supersededIds: [], warnings: [] };
  };
  const { ctx, vault, store } = makeCtx({ saveExplicit });
  const result = await memorySave({ text: '部署时必须先跑 pnpm build', kind: 'decision', tags: ['deploy'] }, ctx);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(vault.appended.length, 1);
  assert.equal(vault.appended[0].kind, 'note');
  assert.equal(vault.appended[0].text, '部署时必须先跑 pnpm build');
  assert.equal(store.indexed.length, 1);
  assert.equal(result.memoryId, 'L3-fact-x');
  assert.equal(result.dedup, 'created');
  assert.equal(result.rawId, vault.appended[0].id);
  assert.deepEqual(result.supersededIds, []);
});

test('memory_save: 缺少派生器时 raw 仍落盘并返回 pending', async () => {
  const { ctx, vault } = makeCtx({ saveExplicit: undefined });
  const result = await memorySave({ text: '记住：端口是 8080' }, ctx);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(vault.appended.length, 1);
  assert.equal(result.deriveStatus, 'pending');
  assert.equal(result.memoryId, null);
});

test('memory_save: 参数错误码 E_BAD_ARGS', async () => {
  const { ctx } = makeCtx();
  const empty = await memorySave({ text: '   ' }, ctx);
  assert.equal(empty.ok, false);
  if (empty.ok) return;
  assert.equal(empty.error.code, 'E_BAD_ARGS');
  const badKind = await memorySave({ text: 'x', kind: 'nope' }, ctx);
  assert.equal(badKind.ok, false);
});

test('memory_status: 汇总健康/统计/层/捕获/派生', async () => {
  const { ctx } = makeCtx();
  const result = await memoryStatus({ verbose: true }, ctx);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.dataDir, 'C:\\x\\life-memory');
  const vault = result.vault as Record<string, unknown>;
  assert.equal(vault.records, 10);
  const layers = result.layers as Array<Record<string, unknown>>;
  assert.equal(layers.length, 3);
  const capture = result.capture as CaptureStats;
  assert.equal(capture.captured, 10);
  assert.deepEqual((result.derive as { cursors: Record<string, number> }).cursors, { L1: 10, L2: 8, L3: 6 });
  assert.ok(result.integrityRuns);
});

test('memory_get_raw: 读取 + 哈希校验 + 截断 + 不存在错误', async () => {
  const { ctx, vault, store } = makeCtx();
  const record = rawRecord({ text: 'x'.repeat(9000) });
  const appended = await vault.append([record as never]);
  store.indexRawRecords(appended.items);
  // FakeVault 重新分配了 id，这里直接用实际 id
  const actual = vault.appended[0];
  const result = await memoryGetRaw({ id: actual.id }, ctx);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal((result.verify as { hashOk: boolean }).hashOk, true);
  assert.equal(result.truncated, true);
  const location = result.location as Record<string, unknown>;
  assert.ok(location.segment);

  const missing = await memoryGetRaw({ id: '2026-10-25-999999' }, ctx);
  assert.equal(missing.ok, false);
  if (missing.ok) return;
  assert.equal(missing.error.code, 'E_RAW_NOT_FOUND');

  const bad = await memoryGetRaw({ id: 'not-an-id' }, ctx);
  assert.equal(bad.ok, false);
  if (bad.ok) return;
  assert.equal(bad.error.code, 'E_BAD_ARGS');
});

test('memory_layers: 层注册表', async () => {
  const { ctx } = makeCtx();
  const result = await memoryLayers({}, ctx);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const layers = result.layers as Array<Record<string, unknown>>;
  assert.deepEqual(layers.map((l) => l.id), ['L1', 'L2', 'L3']);
  assert.deepEqual(layers[2].dependsOn, ['L1', 'L2']);
});

test('handleTool: 未知工具 / 禁用 / 异常兜底', async () => {
  const { ctx } = makeCtx();
  assert.equal((await handleTool('nope', {}, ctx)).ok, false);
  const disabled = await handleTool('memory_status', {}, { ...ctx, config: { ...ctx.config, enabled: false } });
  assert.equal(disabled.ok, false);
  if (disabled.ok) return;
  assert.equal(disabled.error.code, 'E_DISABLED');

  const throwing = await handleTool('memory_recall', { query: 'x' }, { ...ctx, recaller: { recall: async () => { throw new Error('SQLITE_BUSY: database is locked'); } } as never });
  assert.equal(throwing.ok, false);
  if (throwing.ok) return;
  assert.equal(throwing.error.code, 'E_DB_BUSY');
});

test('formatHitCitation: 引用行格式', () => {
  const hit: RecallHit = {
    layer: 'L3',
    memory: memory(),
    score: 0.8,
    components: { vector: 0.5, lexical: 0.5, recency: 0.5, importance: 0.5 },
    citations: [],
  };
  assert.match(formatHitCitation(hit), /- \[mem:L3-preference-abc-12345678\] 用户偏好深色主题（来源 raw:2026-10-25-000001）/);
});

// ---------------------------------------------------------------------------
// v5：人格 CRUD / 会话开关 / memory_status 库字段
// ---------------------------------------------------------------------------

function fakePersonaHost() {
  return {
    list: () => [],
    roster: () => ({ definitions: [], errors: [], activeId: null, loadedAt: 1 }),
    active: () => null,
    getByRef: () => undefined,
    activate: async () => ({ ok: true as const, activeId: null, persona: null }),
    reload: async () => ({ definitions: [], errors: [], activeId: null, loadedAt: 1 }),
    lastError: () => null,
  };
}

test('memory_persona_create/update/delete: 走 personaAdmin，错误码透传', async () => {
  const created: Array<Record<string, unknown>> = [];
  const personaAdmin = {
    async create(input: { id?: string; name: string; body: string; description?: string; tags?: string[] }) {
      created.push(input as Record<string, unknown>);
      return {
        persona: {
          id: input.id ?? 'generated',
          name: input.name,
          description: input.description ?? '',
          tags: input.tags ?? [],
          valid: true,
          invalidReason: null,
          mtime: 1,
        },
        created: true,
      };
    },
    async update() {
      throw Object.assign(new Error('persona not found: nope'), { code: 'E_PERSONA_NOT_FOUND', status: 404 });
    },
    async remove(id: string) {
      return { deleted: true, backupFile: `.trash/${id}-1.md` };
    },
  };
  const { ctx } = makeCtx({ persona: fakePersonaHost() as never, personaAdmin });
  const okCreate = await handleTool('memory_persona_create', { id: 'crud-a', name: 'CRUD A', body: '你是 A' }, ctx);
  assert.equal(okCreate.ok, true);
  if (!okCreate.ok) return;
  assert.equal((okCreate.persona as { id: string }).id, 'crud-a');
  assert.equal(okCreate.created, true);
  assert.equal(created.length, 1);

  const badCreate = await handleTool('memory_persona_create', { name: '', body: '' }, ctx);
  assert.equal(badCreate.ok, false);
  if (badCreate.ok) return;
  assert.equal(badCreate.error.code, 'E_BAD_ARGS');

  const missing = await handleTool('memory_persona_update', { id: 'nope', name: 'B' }, ctx);
  assert.equal(missing.ok, false);
  if (missing.ok) return;
  assert.equal(missing.error.code, 'E_PERSONA_NOT_FOUND');

  const removed = await handleTool('memory_persona_delete', { id: 'crud-a' }, ctx);
  assert.equal(removed.ok, true);
  if (!removed.ok) return;
  assert.equal(removed.deleted, true);
  assert.match(String(removed.backupFile), /\.trash\/crud-a-1\.md/);

  // 未接线 → 结构化禁用
  const { ctx: bare } = makeCtx();
  const disabled = await handleTool('memory_persona_create', { name: 'A', body: 'b' }, bare);
  assert.equal(disabled.ok, false);
  if (disabled.ok) return;
  assert.equal(disabled.error.code, 'E_PERSONA_DISABLED');
});

test('memory_session_config: 读取/更新会话开关并返回库引用', async () => {
  const state = { memoryEnabled: true, personaEnabled: false, personaId: null as string | null, updatedAt: 1 };
  const host = {
    get: (sessionId: string) => ({ sessionId, ...state, isDefault: false }),
    set: (sessionId: string, patch: { memoryEnabled?: boolean; personaEnabled?: boolean; personaId?: string | null }) => {
      if (patch.memoryEnabled !== undefined) state.memoryEnabled = patch.memoryEnabled;
      if (patch.personaEnabled !== undefined) state.personaEnabled = patch.personaEnabled;
      if (patch.personaId !== undefined) state.personaId = patch.personaId;
      state.updatedAt = 2;
      return { sessionId, ...state, isDefault: false };
    },
  };
  const { ctx } = makeCtx({
    sessionConfig: host,
    resolveVault: () => ({ id: 'shared', name: '共享记忆库' }),
  });
  const read = await handleTool('memory_session_config', { sessionId: 'sess-1' }, ctx);
  assert.equal(read.ok, true);
  if (!read.ok) return;
  assert.equal(read.memory, true);
  assert.equal(read.persona, false);
  assert.deepEqual(read.vault, { id: 'shared', name: '共享记忆库' });

  const updated = await handleTool('memory_session_config', { sessionId: 'sess-1', persona: true, memory: true }, ctx);
  assert.equal(updated.ok, true);
  if (!updated.ok) return;
  assert.equal(updated.persona, true);

  const missingSession = await handleTool('memory_session_config', {}, makeCtx({ sessionConfig: host }).ctx);
  assert.equal(missingSession.ok, false);
  if (missingSession.ok) return;
  assert.equal(missingSession.error.code, 'E_BAD_ARGS');
});

test('handleTool: v5 memory=false 时所有工具统一返回结构化禁用', async () => {
  const { ctx } = makeCtx({ disabled: { code: 'E_MEMORY_DISABLED', message: '本会话已关闭记忆（memory=false）' } });
  for (const name of ['memory_recall', 'memory_save', 'memory_status', 'memory_layers', 'memory_persona_list']) {
    const result = await handleTool(name, name === 'memory_recall' ? { query: 'x' } : {}, ctx);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.code, 'E_MEMORY_DISABLED');
  }
  // 未知工具仍优先报 E_BAD_ARGS
  const unknown = await handleTool('nope', {}, ctx);
  assert.equal(unknown.ok, false);
  if (!unknown.ok) assert.equal(unknown.error.code, 'E_BAD_ARGS');
});

test('memory_status: v5 返回当前库 id/名称、vaults 与 session', async () => {
  const { ctx } = makeCtx({
    vaultScope: { id: 'shared', name: '共享记忆库', personaId: null, sessionId: 'sess-1', memoryEnabled: true },
    sessionConfig: {
      get: (sessionId: string) => ({
        sessionId,
        memoryEnabled: true,
        personaEnabled: false,
        personaId: null,
        updatedAt: 0,
        isDefault: true,
      }),
      set: () => {
        throw new Error('not used');
      },
    },
    listVaults: async () => [{ id: 'shared', name: '共享记忆库', isPersona: false }],
  });
  const result = await memoryStatus({}, ctx);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const vault = result.vault as Record<string, unknown>;
  assert.equal(vault.id, 'shared');
  assert.equal(vault.name, '共享记忆库');
  assert.equal(vault.records, 10);
  assert.deepEqual(result.vaults, [{ id: 'shared', name: '共享记忆库', isPersona: false }]);
  assert.deepEqual((result.session as Record<string, unknown>).memory, true);
});

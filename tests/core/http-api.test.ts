/** 只读 HTTP API 测试（fake store/vault/recaller） */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createReadOnlyApi } from '../../src/http/handlers.ts';
import type { HttpApiDeps, HttpScopeResolver, HttpSessionConfigView } from '../../src/http/handlers.ts';
import { DEFAULT_CONFIG } from '../../src/config.ts';
import type {
  CaptureStats,
  LayerRegistryRow,
  MemoryRecord,
  MemoryStore,
  RawIndexRow,
  RawRecord,
  RawVault,
  RecallHit,
  RecallQuery,
  Recaller,
  VaultHealth,
  VaultManifest,
  VerifyResult,
  VaultStats,
} from '../../src/core/contracts.ts';

const rawRow = (i: number): RawIndexRow => ({
  id: `2026-10-25-${String(i).padStart(6, '0')}`,
  seq: i,
  ts: 1761390000000 + i,
  iso: new Date(1761390000000 + i).toISOString(),
  day: '2026-10-25',
  timezone: 'Asia/Shanghai',
  kind: i % 2 === 0 ? 'user' : 'assistant',
  sessionId: 's1',
  workspace: 'D:\\work\\proj',
  personaId: null,
  turnId: null,
  stepId: null,
  role: i % 2 === 0 ? 'user' : 'assistant',
  text: `第 ${i} 条消息内容`,
  textSeg: '',
  payloadJson: '{}',
  hash: 'a'.repeat(64),
  prevHash: '0'.repeat(64),
  segment: 'segments/2026-10-25/seg-wabcdef-000001.jsonl',
  lineNo: i,
  byteOffset: 0,
  byteLen: 100,
  recordVersion: 1,
  ingestKey: `s1:${i}`,
  createdAt: 0,
});

const memory: MemoryRecord = {
  id: 'L3-preference-abc-12345678',
  layer: 'L3',
  kind: 'preference',
  text: '用户偏好深色主题',
  summary: '深色主题偏好',
  importance: 0.8,
  confidence: 0.9,
  sourceRawIds: ['2026-10-25-000001'],
  tags: ['theme'],
  createdAt: 1761390000000,
  updatedAt: 1761390000000,
  revision: 1,
  contentHash: 'h1',
  status: 'active',
};

class FakeStore {
  rows: RawIndexRow[] = Array.from({ length: 120 }, (_, i) => rawRow(i + 1));
  layers: LayerRegistryRow[] = [
    { id: 'L1', name: 'L1 短期/工作层', version: 1, dependsOn: [], kind: 'builtin', enabled: true, rebuildable: true, count: 10, active: 9, archived: 1, latestUpdatedAt: 1761390000000 },
    { id: 'L3', name: 'L3 长期/语义层', version: 1, dependsOn: ['L1'], kind: 'builtin', enabled: true, rebuildable: true, count: 1, active: 1, archived: 0, latestUpdatedAt: 1761390000000 },
  ];
  listRawIndex(query: { offset?: number; limit?: number; desc?: boolean; day?: string }): { records: RawIndexRow[]; total: number } {
    let rows = [...this.rows];
    if (query.day) rows = rows.filter((r) => r.day === query.day);
    if (query.desc) rows.reverse();
    const total = rows.length;
    const offset = query.offset ?? 0;
    return { records: rows.slice(offset, offset + (query.limit ?? 50)), total };
  }
  getRawIndex(id: string): RawIndexRow | null {
    return this.rows.find((r) => r.id === id) ?? null;
  }
  listLayers(): LayerRegistryRow[] {
    return this.layers;
  }
  embeddingCoverage(): Record<string, number> {
    return { L1: 9, L3: 1 };
  }
  listIntegrityRuns(limit?: number) {
    return [{ id: 1, kind: 'raw_chain', startedAt: 1, finishedAt: 2, recordsChecked: 100, segmentsChecked: 1, ok: true }].slice(0, limit ?? 10);
  }
  getLastIntegrityRun() {
    return this.listIntegrityRuns(1)[0];
  }
  listRepairLog() {
    return [];
  }
  getRawIndexBySeq(seq: number): RawIndexRow | null {
    return this.rows.find((r) => r.seq === seq) ?? null;
  }
  listMemories(): MemoryRecord[] {
    return [memory];
  }
  getMemory(id: string): MemoryRecord | null {
    return id === memory.id ? memory : null;
  }
  listSources() {
    return [{ rawId: '2026-10-25-000001', relation: 'derived_from', weight: 1 }];
  }
  listRevisions() {
    return [];
  }
  getL3Semantic() {
    return { memoryId: memory.id, category: 'preference', canonicalKey: 'user.pref.theme=dark' };
  }
  searchLexical(): { id: string; layer: string; score: number }[] {
    return [{ id: memory.id, layer: 'L3', score: 1 }];
  }
}

class FakeVault implements RawVault {
  records = new Map<string, RawRecord>();
  constructor() {
    this.records.set('2026-10-25-000001', {
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
      payload: { type: 'user/message' },
      hash: 'a'.repeat(64),
      prevHash: '0'.repeat(64),
      v: 1,
    });
  }
  async append(): Promise<never> {
    throw new Error('read-only test vault');
  }
  async get(id: string): Promise<RawRecord | null> {
    return this.records.get(id) ?? null;
  }
  async list(): Promise<{ records: RawRecord[]; total: number }> {
    return { records: [...this.records.values()], total: this.records.size };
  }
  async *iterate(): AsyncIterable<RawRecord> {}
  async verify(): Promise<VerifyResult> {
    return { ok: true, checked: 1 };
  }
  async stats(): Promise<VaultStats> {
    return { records: 120, segments: 1, days: 1, bytes: 2048 };
  }
  async manifest(): Promise<VaultManifest> {
    return { formatVersion: 1, vaultId: 'vault-1', updatedAt: 1, segments: [], stats: { records: 120, days: 1, bytes: 2048 } };
  }
  async close(): Promise<void> {}
}

class FakeRecaller implements Recaller {
  lastQuery: RecallQuery | null = null;
  async recall(query: RecallQuery): Promise<RecallHit[]> {
    this.lastQuery = query;
    return [
      {
        layer: 'L3',
        memory,
        score: 0.84,
        components: { vector: 0.71, lexical: 0.95, recency: 0.99, importance: 0.8 },
        citations: ['L3-preference-abc-12345678', '2026-10-25-000001'],
      },
    ];
  }
  async buildPromptSection(): Promise<string> {
    return '';
  }
  formatHit(): string {
    return '';
  }
}

const captureStats: CaptureStats = { captured: 120, failed: 0, queued: 0, lastCaptureAt: 1, dropped: 0 };

function makeApi() {
  const store = new FakeStore();
  const vault = new FakeVault();
  const recaller = new FakeRecaller();
  const health: VaultHealth = {
    ok: true,
    dataDir: 'C:\\x\\life-memory',
    vault: { records: 120, segments: 1, days: 1, bytes: 2048 },
    storage: { dbPath: 'vault.db', dbBytes: 4096, rawCount: 120, memoryCount: 3, activeMemoryCount: 3, vectorCount: 3, segmentCount: 1, embedding: { model: 'dsh-local-hash-v1', dim: 512, version: '1' }, schemaVersion: 1 },
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
  const deps: HttpApiDeps = {
    config: { ...DEFAULT_CONFIG, timezone: 'Asia/Shanghai', http: { enabled: true, basePath: '/api/life-memory' } },
    store: store as unknown as MemoryStore,
    vault,
    recaller,
    health: async () => health,
    captureStats: () => captureStats,
    deriveStats: () => ({ cursors: { L1: 120 }, pendingJobs: 0, lastDeriveAt: 1 }),
    now: () => 1761390001000,
  };
  return { api: createReadOnlyApi(deps), store, vault, recaller, deps };
}

const BASE = '/api/life-memory';

test('health/status/layers/stats', async () => {
  const { api } = makeApi();
  const health = await api.handle({ method: 'GET', url: `${BASE}/health` });
  assert.equal(health.status, 200);
  assert.equal((health.body as { data: { readonly: boolean } }).data.readonly, true);

  const status = await api.handle({ method: 'GET', url: `${BASE}/status` });
  assert.equal(status.status, 200);
  const statusData = (status.body as { data: Record<string, unknown> }).data;
  assert.equal(statusData.scope, 'global');
  assert.deepEqual((statusData.derive as { cursors: Record<string, number> }).cursors, { L1: 120 });

  const layers = await api.handle({ method: 'GET', url: `${BASE}/layers` });
  assert.equal(layers.status, 200);
  assert.equal(((layers.body as { data: { layers: unknown[] } }).data.layers).length, 2);

  const stats = await api.handle({ method: 'GET', url: `${BASE}/stats-layers` });
  assert.equal(stats.status, 200);
  const statsData = (stats.body as { data: { layers: Array<Record<string, unknown>>; raw: Record<string, unknown> } }).data;
  assert.equal(statsData.layers[0].embeddingCoverage, 9);
  assert.equal(statsData.raw.records, 120);
});

test('raw 列表：分页 cursor、筛选、预览', async () => {
  const { api } = makeApi();
  const page1 = await api.handle({ method: 'GET', url: `${BASE}/raw?limit=50` });
  assert.equal(page1.status, 200);
  const d1 = (page1.body as { data: { items: unknown[]; total: number; nextCursor: string | null } }).data;
  assert.equal(d1.items.length, 50);
  assert.equal(d1.total, 120);
  assert.ok(d1.nextCursor);

  const page2 = await api.handle({ method: 'GET', url: `${BASE}/raw?limit=50&cursor=${encodeURIComponent(d1.nextCursor!)}` });
  const d2 = (page2.body as { data: { items: Array<{ id: string }>; nextCursor: string | null } }).data;
  assert.equal(d2.items.length, 50);
  assert.notEqual(d2.items[0].id, (d1.items[0] as { id: string }).id);

  const page3 = await api.handle({ method: 'GET', url: `${BASE}/raw?limit=50&cursor=${encodeURIComponent(d2.nextCursor!)}` });
  const d3 = (page3.body as { data: { items: unknown[]; nextCursor: string | null } }).data;
  assert.equal(d3.items.length, 20);
  assert.equal(d3.nextCursor, null);

  const dayQuery = await api.handle({ method: 'GET', url: `${BASE}/raw?day=2026-10-25&limit=2&desc=true` });
  const dd = (dayQuery.body as { data: { items: Array<{ id: string }> } }).data;
  assert.equal(dd.items.length, 2);
  assert.equal(dd.items[0].id, '2026-10-25-000120');
});

test('raw 详情/校验与 404', async () => {
  const { api } = makeApi();
  const detail = await api.handle({ method: 'GET', url: `${BASE}/raw-detail?id=2026-10-25-000001` });
  assert.equal(detail.status, 200);
  const data = (detail.body as { data: { record: { id: string }; location: { segment: string } } }).data;
  assert.equal(data.record.id, '2026-10-25-000001');
  assert.ok(data.location.segment);

  const verify = await api.handle({ method: 'GET', url: `${BASE}/raw-verify?id=2026-10-25-000001` });
  assert.equal(verify.status, 200);

  const missing = await api.handle({ method: 'GET', url: `${BASE}/raw-detail?id=2026-10-25-999999` });
  assert.equal(missing.status, 404);
});

test('memories 列表/详情', async () => {
  const { api } = makeApi();
  const list = await api.handle({ method: 'GET', url: `${BASE}/memories?limit=10` });
  assert.equal(list.status, 200);
  const items = (list.body as { data: { items: Array<{ id: string }> } }).data.items;
  assert.equal(items[0].id, memory.id);

  const detail = await api.handle({ method: 'GET', url: `${BASE}/memory-detail?id=${memory.id}` });
  assert.equal(detail.status, 200);
  const data = (detail.body as { data: { sources: unknown[]; l3Semantic: { canonicalKey: string } } }).data;
  assert.equal(data.sources.length, 1);
  assert.equal(data.l3Semantic.canonicalKey, 'user.pref.theme=dark');

  const missing = await api.handle({ method: 'GET', url: `${BASE}/memory-detail?id=nope` });
  assert.equal(missing.status, 404);
});

test('search：只读（trackAccess=false）与参数校验', async () => {
  const { api, recaller } = makeApi();
  const res = await api.handle({ method: 'GET', url: `${BASE}/search?q=${encodeURIComponent('深色主题')}&limit=3` });
  assert.equal(res.status, 200);
  assert.equal(recaller.lastQuery?.trackAccess, false);
  const data = (res.body as { data: { items: Array<{ score: number; components: unknown }> } }).data;
  assert.equal(data.items[0].score, 0.84);
  assert.ok(data.items[0].components);
  const bad = await api.handle({ method: 'GET', url: `${BASE}/search` });
  assert.equal(bad.status, 400);
});

test('manifest/integrity', async () => {
  const { api } = makeApi();
  const manifest = await api.handle({ method: 'GET', url: `${BASE}/manifest` });
  assert.equal(manifest.status, 200);
  assert.equal((manifest.body as { data: { vaultId: string } }).data.vaultId, 'vault-1');
  const integrity = await api.handle({ method: 'GET', url: `${BASE}/integrity` });
  assert.equal(integrity.status, 200);
  assert.equal((integrity.body as { data: { runs: unknown[] } }).data.runs.length, 1);
});

test('契约：405 / 404 / 禁用', async () => {
  const { api, deps } = makeApi();
  // POST 到只读路径：宿主注册了 POST 方法，插件 handler 内写路由表未知 → 404
  const post = await api.handle({ method: 'POST', url: `${BASE}/raw` });
  assert.equal(post.status, 404);
  const put = await api.handle({ method: 'PUT', url: `${BASE}/raw` });
  assert.equal(put.status, 405);
  const unknown = await api.handle({ method: 'GET', url: `${BASE}/nope` });
  assert.equal(unknown.status, 404);
  const otherPath = await api.handle({ method: 'GET', url: '/other/api/health' });
  assert.equal(otherPath.status, 404);

  const disabled = createReadOnlyApi({ ...deps, config: { ...deps.config, http: { enabled: false, basePath: BASE } } });
  const res = await disabled.handle({ method: 'GET', url: `${BASE}/health` });
  assert.equal(res.status, 404);
});

// ---------------------------------------------------------------------------
// v5：/vaults、/session-config、POST 写路由（fake resolver）
// ---------------------------------------------------------------------------

function makeResolverApi() {
  const base = makeApi();
  const sessionState = new Map<
    string,
    { memoryEnabled: boolean; personaEnabled: boolean; personaId: string | null; updatedAt: number }
  >();
  const personas: Array<{ id: string; name: string; description?: string; tags?: string[]; valid?: boolean; invalidReason?: string | null }> = [];
  const defaultState = { memoryEnabled: true, personaEnabled: false, personaId: null as string | null, updatedAt: 0 };
  const viewOf = (sessionId: string | null): HttpSessionConfigView => {
    const stored = sessionId ? sessionState.get(sessionId) : undefined;
    return {
      sessionId: sessionId ?? '',
      memoryEnabled: stored?.memoryEnabled ?? true,
      personaEnabled: stored?.personaEnabled ?? false,
      personaId: stored?.personaId ?? null,
      updatedAt: stored?.updatedAt ?? 0,
      isDefault: stored === undefined,
    };
  };
  const resolver: HttpScopeResolver = {
    async resolve({ vault }) {
      return {
        vaultId: vault ?? 'shared',
        vaultName: vault ?? '共享记忆库',
        personaId: vault && vault !== 'shared' ? vault : null,
        store: base.deps.store,
        vault: base.deps.vault,
        recaller: base.deps.recaller,
        health: base.deps.health,
        captureStats: base.deps.captureStats,
        deriveStats: base.deps.deriveStats,
      };
    },
    async listVaults() {
      return [
        {
          id: 'shared',
          name: '共享记忆库',
          isPersona: false,
          isActive: true,
          dir: 'C:\\x\\life-memory\\vaults\\shared',
          stats: {
            rawRecords: 120,
            memoryCount: 3,
            activeMemoryCount: 3,
            dbBytes: 4096,
            segments: 1,
            lastUpdatedAt: 123,
          },
        },
      ];
    },
    activeVaultId: () => 'shared',
    activePersonaId: () => null,
    routingForSession: () => ({ vaultId: 'shared', vaultName: '共享记忆库' }),
    sessionConfig: (sessionId) => viewOf(sessionId),
    sessionDefaults: () => ({
      sessionId: '',
      memoryEnabled: defaultState.memoryEnabled,
      personaEnabled: defaultState.personaEnabled,
      personaId: defaultState.personaId,
      updatedAt: defaultState.updatedAt,
      isDefault: true,
    }),
    setSessionDefaults(patch) {
      if (patch.memoryEnabled !== undefined) defaultState.memoryEnabled = patch.memoryEnabled;
      if (patch.personaEnabled !== undefined) defaultState.personaEnabled = patch.personaEnabled;
      if (patch.personaId !== undefined) defaultState.personaId = patch.personaId;
      defaultState.updatedAt = 200;
      return {
        sessionId: '',
        memoryEnabled: defaultState.memoryEnabled,
        personaEnabled: defaultState.personaEnabled,
        personaId: defaultState.personaId,
        updatedAt: defaultState.updatedAt,
        isDefault: true,
      };
    },
    setSessionConfig(sessionId, patch) {
      const prev = viewOf(sessionId);
      const next = {
        ...prev,
        memoryEnabled: patch.memoryEnabled ?? prev.memoryEnabled,
        personaEnabled: patch.personaEnabled ?? prev.personaEnabled,
        personaId: patch.personaId !== undefined ? patch.personaId : prev.personaId,
        updatedAt: 100,
        isDefault: false,
      };
      sessionState.set(sessionId, {
        memoryEnabled: next.memoryEnabled,
        personaEnabled: next.personaEnabled,
        personaId: next.personaId,
        updatedAt: next.updatedAt,
      });
      return next;
    },
    persona: {
      list: () => personas,
      active: () => null,
      async create(input) {
        const id = String(input.id ?? 'generated');
        if (personas.some((persona) => persona.id === id)) {
          throw Object.assign(new Error(`persona already exists: ${id}`), { code: 'E_PERSONA_EXISTS', status: 409 });
        }
        const persona = {
          id,
          name: String(input.name ?? ''),
          description: String(input.description ?? ''),
          tags: [],
          valid: true,
          invalidReason: null,
        };
        personas.push(persona);
        return { persona, created: true };
      },
      async update(id, patch) {
        const persona = personas.find((item) => item.id === id);
        if (!persona) throw Object.assign(new Error(`persona not found: ${id}`), { code: 'E_PERSONA_NOT_FOUND', status: 404 });
        Object.assign(persona, patch);
        return { persona, updated: true };
      },
      async remove(id) {
        const index = personas.findIndex((item) => item.id === id);
        if (index < 0) throw Object.assign(new Error(`persona not found: ${id}`), { code: 'E_PERSONA_NOT_FOUND', status: 404 });
        personas.splice(index, 1);
        return { deleted: true, backupFile: `.trash/${id}-1.md` };
      },
      async activate(ref) {
        if (ref === null) return { ok: true, activeId: null, persona: null };
        const persona = personas.find((item) => item.id === ref);
        if (!persona) return { ok: false, activeId: null, persona: null, error: `persona not found: ${ref}` };
        return { ok: true, activeId: ref, persona };
      },
    },
  };
  return { api: createReadOnlyApi({ ...base.deps, resolver }), personas, sessionState };
}

test('v5 GET /vaults 与 /session-config：客户端契约形状', async () => {
  const { api } = makeResolverApi();
  const vaults = await api.handle({ method: 'GET', url: `${BASE}/vaults` });
  assert.equal(vaults.status, 200);
  const vaultsData = (vaults.body as { data: Record<string, unknown> }).data;
  const list = vaultsData.vaults as Array<Record<string, unknown>>;
  assert.equal(list.length, 1);
  assert.equal(list[0].id, 'shared');
  assert.equal((list[0].stats as Record<string, unknown>).rawRecords, 120);
  assert.equal(vaultsData.activeVaultId, 'shared');
  assert.equal(vaultsData.activePersonaId, null);
  assert.equal(vaultsData.readonly, true);

  const session = await api.handle({ method: 'GET', url: `${BASE}/session-config` });
  assert.equal(session.status, 200);
  const sessionData = (session.body as { data: Record<string, unknown> }).data;
  assert.equal(sessionData.memory, true);
  assert.equal(sessionData.persona, false);
  assert.equal(sessionData.personaId, null);
  assert.equal(sessionData.isDefault, true);
  assert.deepEqual(sessionData.vault, { id: 'shared', name: '共享记忆库' });

  // 无 sessionId → 新会话默认值（hero/面板读写）
  assert.equal(sessionData.defaults, true);
  assert.equal(sessionData.sessionId, null);

  const scoped = await api.handle({ method: 'GET', url: `${BASE}/session-config?sessionId=s1` });
  assert.equal((scoped.body as { data: { sessionId: string } }).data.sessionId, 's1');
  assert.equal((scoped.body as { data: { defaults?: boolean } }).data.defaults, undefined);

  // 既有 GET 支持 ?vault= 作用域（回显库 id）
  const scopedStatus = await api.handle({ method: 'GET', url: `${BASE}/status?vault=shared` });
  assert.equal(scopedStatus.status, 200);
  const badVault = await api.handle({ method: 'GET', url: `${BASE}/status?vault=../etc` });
  assert.equal(badVault.status, 400);
});

test('v5 POST：/personas CRUD、activate、session-config 与错误码', async () => {
  const { api } = makeResolverApi();
  const post = (path: string, body: unknown) =>
    api.handle({ method: 'POST', url: `${BASE}${path}`, body });

  const created = await post('/personas', { id: 'crud-a', name: 'CRUD A', body: '你是 A' });
  assert.equal(created.status, 200);
  assert.equal((created.body as { data: { created: boolean } }).data.created, true);
  const duplicate = await post('/personas', { id: 'crud-a', name: 'CRUD A', body: '你是 A' });
  assert.equal(duplicate.status, 409);
  assert.equal((duplicate.body as { error: { code: string } }).error.code, 'E_PERSONA_EXISTS');

  const badJson = await api.handle({ method: 'POST', url: `${BASE}/personas`, body: '{not-json' });
  assert.equal(badJson.status, 400);
  const missingName = await post('/personas', { body: 'x' });
  assert.equal(missingName.status, 400);

  // POST /session-config（无 sessionId / defaults:true）→ 更新"新会话默认"
  const defaultsWrite = await post('/session-config', { defaults: true, memory: false, persona: true, personaId: 'crud-a' });
  assert.equal(defaultsWrite.status, 200);
  const defaultsData = (defaultsWrite.body as { data: Record<string, unknown> }).data;
  assert.equal(defaultsData.defaults, true);
  assert.equal(defaultsData.sessionId, null);
  assert.equal(defaultsData.memory, false);
  assert.equal(defaultsData.persona, true);
  const defaultsRead = await api.handle({ method: 'GET', url: `${BASE}/session-config` });
  const defaultsReadData = (defaultsRead.body as { data: Record<string, unknown> }).data;
  assert.equal(defaultsReadData.memory, false);
  assert.equal(defaultsReadData.persona, true);

  const updated = await post('/personas/update', { id: 'crud-a', name: 'CRUD A2' });
  assert.equal(updated.status, 200);
  const updateMissing = await post('/personas/update', { id: 'nope', name: 'x' });
  assert.equal(updateMissing.status, 404);

  const activated = await post('/personas/activate', { persona: 'crud-a' });
  assert.equal(activated.status, 200);
  const activateUnknown = await post('/personas/activate', { persona: 'nope' });
  assert.equal(activateUnknown.status, 404);
  const deactivated = await post('/personas/activate', { persona: null });
  assert.equal((deactivated.body as { data: { activeId: string | null } }).data.activeId, null);

  const saved = await post('/session-config', { sessionId: 's1', memory: true, persona: true });
  assert.equal(saved.status, 200);
  assert.equal((saved.body as { data: { persona: boolean } }).data.persona, true);
  const readBack = await api.handle({ method: 'GET', url: `${BASE}/session-config?sessionId=s1` });
  assert.equal((readBack.body as { data: { persona: boolean; isDefault: boolean } }).data.persona, true);
  assert.equal((readBack.body as { data: { isDefault: boolean } }).data.isDefault, false);

  const removed = await post('/personas/delete', { id: 'crud-a' });
  assert.equal(removed.status, 200);
  assert.match(String((removed.body as { data: { backupFile: string } }).data.backupFile), /crud-a-1\.md/);
  const deleteMissing = await post('/personas/delete', { id: 'crud-a' });
  assert.equal(deleteMissing.status, 404);
});

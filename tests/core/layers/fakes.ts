/**
 * 派生层测试用 fake：内存版 MemoryStore / Embedder / readRaw / config / raw 工厂。
 *
 * FakeMemoryStore 严格按 `src/core/contracts.ts` 的语义实现关键行为：
 * - upsert 幂等：同 id 同 contentHash 不新建行（仅合并溯源）；
 * - §8.4-1 重述：不同 id 但同 (layer, content_hash) 活跃行 → 合并到已有行 + revision++；
 * - §8.4 revision 语义：同 id 的 text/importance/confidence/validTo/status 变更 → 旧版本快照 + revision++；
 * - clearLayer：L1/L2 物理删除并重置该层游标；L3 仅 archive（不删）；
 * - searchVector=余弦；searchLexical 返回**原始 bm25 风格负分**（-命中词数），验证 recall 端归一化。
 */
import type {
  AppendResult,
  Embedder,
  EmbeddingRef,
  IntegrityRunRow,
  L2EpisodeRow,
  L3SemanticRow,
  LayerId,
  LayerRegistryRow,
  LayerStatsRow,
  MemoryKind,
  MemoryQuery,
  MemoryRecord,
  MemoryRevisionRow,
  MemoryStatus,
  MemoryStore,
  NewMemoryRecord,
  RawAppendItem,
  RawIndexRow,
  RawQuery,
  RawRecord,
  RawRecordInput,
  RawVault,
  RepairLogRow,
  SearchLexicalOptions,
  SearchVectorOptions,
  SourceLinkRow,
  StorageStats,
  VaultStats,
  VecHit,
  LexHit,
  VerifyResult,
  VectorOwnerKind,
  MemoryVaultConfig,
  VaultManifest,
  DeriveInput,
  DeriveReason,
  LayerRunResult,
  RetentionState,
  RetentionStats,
  RetentionTier,
  RawVecHit,
  RawVectorStats,
  ForgettingStats,
} from '../../../src/core/contracts.ts';
import { mergeConfig } from '../../../src/config.ts';
import { silentLogger } from '../../../src/core/logger.ts';
import { contentHash as computeContentHash } from '../../../src/core/hash.ts';
import { deriveMemoryId } from '../../../src/core/ids.ts';
import { normalizeForTextSeg, tokenizeTextSeg, tokenizeWeighted } from '../../../src/core/text.ts';
import { fnv1a32, FNV_OFFSET, FNV_SEED2 } from '../../../src/core/hash.ts';
import { createLayerRegistry, type LayerRegistry } from '../../../src/layers/registry.ts';
import { createL1Layer } from '../../../src/layers/l1-episode.ts';
import { createL2Layer } from '../../../src/layers/l2-summary.ts';
import { createL3Layer } from '../../../src/layers/l3-semantic.ts';

export const TEST_NOW = 1_761_400_000_000; // 2025-10-25 左右（固定，测试确定性）
export const TEST_TZ = 'Asia/Shanghai';

/** 测试配置：64 维 fake embedder + 默认权重 */
export function testConfig(partial: Record<string, unknown> = {}): MemoryVaultConfig {
  return mergeConfig({
    embedding: { provider: 'local', dim: 64, model: 'fake-hash-v1', version: '1' },
    ...partial,
  } as never);
}

/** raw 记录工厂（seq 从 1 开始，ts 随 seq 递增） */
export function makeRaw(seq: number, overrides: Partial<RawRecord> = {}): RawRecord {
  const ts = overrides.ts ?? TEST_NOW + seq * 60_000;
  const id = overrides.id ?? `2026-10-25-${String(seq).padStart(6, '0')}`;
  return {
    id,
    day: '2026-10-25',
    seq,
    ts,
    iso: new Date(ts).toISOString(),
    timezone: TEST_TZ,
    kind: 'user',
    sessionId: 's1',
    workspace: 'D:\\work\\proj',
    turnId: null,
    stepId: null,
    role: null,
    text: null,
    payload: {},
    tags: [],
    v: 1,
    hash: '0'.repeat(64),
    prevHash: '0'.repeat(64),
    ...overrides,
  };
}

/** readRaw 的数组实现（支持 offset/limit/desc/kinds/sessionId/ids/from/to；每次调用重新读取数组，便于测试追加） */
export function makeReadRaw(raws: RawRecord[]): (query?: RawQuery) => Promise<RawRecord[]> {
  return async (query: RawQuery = {}) => {
    let list = [...raws].sort((a, b) => a.seq - b.seq);
    if (query.ids && query.ids.length > 0) {
      const set = new Set(query.ids);
      list = list.filter((raw) => set.has(raw.id));
    }
    if (query.kinds && query.kinds.length > 0) list = list.filter((raw) => query.kinds!.includes(raw.kind));
    if (query.sessionId) list = list.filter((raw) => raw.sessionId === query.sessionId);
    if (query.personaId !== undefined) {
      list = list.filter((raw) => (raw.personaId ?? null) === query.personaId);
    }
    if (query.day) list = list.filter((raw) => raw.day === query.day);
    if (query.from !== undefined) list = list.filter((raw) => raw.ts >= query.from!);
    if (query.to !== undefined) list = list.filter((raw) => raw.ts <= query.to!);
    if (query.desc === true) list = [...list].reverse();
    const offset = Math.max(0, query.offset ?? 0);
    const limit = query.limit ?? list.length;
    return list.slice(offset, offset + limit);
  };
}

/** fake embedder：signed feature hashing（与本地嵌入同构，保证中文 2 字/中英混合可命中） */
export function createFakeEmbedder(dim = 64): Embedder {
  const ref: EmbeddingRef = { model: 'fake-hash-v1', dim, version: '1' };
  return {
    ref,
    async embed(texts: string[]): Promise<Float32Array[]> {
      return texts.map((text) => hashEmbed(text, dim));
    },
  };
}

/** 总是失败的 embedder（验证"嵌入失败仍写记录"） */
export function createFailingEmbedder(dim = 64): Embedder {
  const ref: EmbeddingRef = { model: 'fake-hash-v1', dim, version: '1' };
  return {
    ref,
    async embed(): Promise<Float32Array[]> {
      throw new Error('simulated embedding outage');
    },
  };
}

/** 词袋哈希向量（归一化；空文本 vec[0]=1） */
export function hashEmbed(text: string, dim: number): Float32Array {
  const vec = new Float32Array(dim);
  const counts = new Map<string, { count: number; weight: number }>();
  for (const token of tokenizeWeighted(text)) {
    const entry = counts.get(token.token);
    if (entry) entry.count += 1;
    else counts.set(token.token, { count: 1, weight: token.kindWeight });
  }
  for (const [token, { count, weight }] of counts) {
    const bytes = Buffer.from(token, 'utf8');
    const index = fnv1a32(bytes, FNV_OFFSET) % dim;
    const sign = (fnv1a32(bytes, FNV_SEED2) & 1) === 0 ? 1 : -1;
    vec[index] += sign * weight * (1 + Math.log(count));
  }
  let norm = 0;
  for (let i = 0; i < dim; i += 1) norm += vec[i] * vec[i];
  norm = Math.sqrt(norm);
  if (norm === 0) {
    vec[0] = 1;
  } else {
    for (let i = 0; i < dim; i += 1) vec[i] /= norm;
  }
  return vec;
}

interface StoredMemory extends MemoryRecord {
  revision: number;
  contentHash: string;
}

/** 内存版 MemoryStore（见文件头语义说明） */
export class FakeMemoryStore implements MemoryStore {
  readonly dbPath = ':memory:';
  readonly db = null;
  /** 内部时钟（测试可改） */
  nowValue = TEST_NOW;
  /** 向量写入所用 ref（通常等于 fake embedder 的 ref） */
  vectorRef: EmbeddingRef;
  readonly memories = new Map<string, StoredMemory>();
  readonly vectors = new Map<string, { ref: EmbeddingRef; vec: Float32Array }>();
  readonly l2Rows = new Map<string, L2EpisodeRow>();
  readonly l3Rows = new Map<string, L3SemanticRow>();
  readonly revisions = new Map<string, MemoryRevisionRow[]>();
  readonly cursors = new Map<string, number>();
  readonly metas = new Map<string, string>();
  readonly rawIndex = new Map<string, RawIndexRow>();
  readonly integrityRuns: IntegrityRunRow[] = [];
  readonly repairLog: RepairLogRow[] = [];
  transactionCalls = 0;
  clearLayerCalls: Array<{ layer: LayerId; archive?: boolean }> = [];

  constructor(options: { dim?: number } = {}) {
    this.vectorRef = { model: 'fake-hash-v1', dim: options.dim ?? 64, version: '1' };
  }

  // -- 派生记忆 ------------------------------------------------------------

  private snapshot(memory: StoredMemory, changeKind: string): void {
    const list = this.revisions.get(memory.id) ?? [];
    const revision = memory.revision;
    if (list.some((entry) => entry.revision === revision)) return;
    list.push({
      memoryId: memory.id,
      revision,
      text: memory.text,
      summary: memory.summary ?? null,
      importance: memory.importance,
      confidence: memory.confidence,
      validFrom: memory.validFrom ?? null,
      validTo: memory.validTo ?? null,
      status: memory.status ?? 'active',
      changeKind,
      changedAt: this.nowValue,
    });
    this.revisions.set(memory.id, list);
  }

  private rebuildRecord(memory: StoredMemory): StoredMemory {
    return { ...memory, sourceRawIds: [...memory.sourceRawIds], tags: [...memory.tags], meta: { ...(memory.meta ?? {}) } };
  }

  upsertMemory(record: NewMemoryRecord, embedding?: Float32Array): MemoryRecord {
    const hash = computeContentHash(record.layer, record.kind, record.text);
    const createdAt = typeof record.createdAt === 'number' ? record.createdAt : this.nowValue;
    const id = record.id ?? deriveMemoryId(record.layer, record.kind, createdAt, hash);
    const existing = this.memories.get(id);
    if (existing) {
      // pinned 是治理标记（不直接改 tier；晋升由 retention 引擎完成，与真实 store 一致）
      if (record.pinned === true) existing.pinned = true;
      // 人格归属：显式传入时更新（undefined = 不改变）
      if (record.personaId !== undefined) existing.personaId = record.personaId;
      const sameContent =
        existing.contentHash === hash &&
        (record.summary ?? null) === (existing.summary ?? null) &&
        (record.importance === undefined ? existing.importance : record.importance) === existing.importance &&
        (record.confidence === undefined ? existing.confidence : record.confidence) === existing.confidence &&
        (record.validFrom === undefined ? existing.validFrom ?? null : record.validFrom) === (existing.validFrom ?? null) &&
        (record.validTo === undefined ? existing.validTo ?? null : record.validTo) === (existing.validTo ?? null) &&
        (record.status === undefined ? existing.status ?? 'active' : record.status) === (existing.status ?? 'active');
      // 来源合并（幂等路径也合并，符合 docs §8.4-1）
      for (const rawId of record.sourceRawIds) if (!existing.sourceRawIds.includes(rawId)) existing.sourceRawIds.push(rawId);
      if (sameContent) {
        if (embedding) this.putVector('memory', id, this.vectorRef, embedding);
        return this.rebuildRecord(existing);
      }
      this.snapshot(existing, 'update');
      existing.revision += 1;
      existing.updatedAt = this.nowValue;
      existing.text = record.text;
      existing.summary = record.summary ?? null;
      existing.importance = record.importance ?? existing.importance;
      existing.confidence = record.confidence ?? existing.confidence;
      existing.validFrom = record.validFrom ?? existing.validFrom ?? null;
      existing.validTo = record.validTo ?? existing.validTo ?? null;
      existing.status = record.status ?? existing.status ?? 'active';
      existing.supersedes = record.supersedes && record.supersedes.length > 0 ? [...record.supersedes] : existing.supersedes;
      existing.meta = { ...(existing.meta ?? {}), ...(record.meta ?? {}) };
      existing.contentHash = hash;
      if (embedding) this.putVector('memory', id, this.vectorRef, embedding);
      return this.rebuildRecord(existing);
    }
    // §8.4-1 重述：不同 id 但同层同 contentHash 的活跃行
    const restated = [...this.memories.values()].find(
      (memory) =>
        memory.layer === record.layer &&
        memory.contentHash === hash &&
        (memory.status ?? 'active') === 'active',
    );
    if (restated) {
      this.snapshot(restated, 'restate');
      restated.revision += 1;
      restated.updatedAt = this.nowValue;
      for (const rawId of record.sourceRawIds) if (!restated.sourceRawIds.includes(rawId)) restated.sourceRawIds.push(rawId);
      if (embedding) this.putVector('memory', restated.id, this.vectorRef, embedding);
      return this.rebuildRecord(restated);
    }
    const created: StoredMemory = {
      id,
      layer: record.layer,
      kind: record.kind,
      text: record.text,
      summary: record.summary ?? null,
      importance: record.importance ?? 0.5,
      confidence: record.confidence ?? 0.5,
      sourceRawIds: [...record.sourceRawIds],
      sessionId: record.sessionId ?? null,
      workspace: record.workspace ?? null,
      personaId: record.personaId ?? null,
      tags: [...(record.tags ?? [])],
      createdAt,
      updatedAt: this.nowValue,
      validFrom: record.validFrom ?? null,
      validTo: record.validTo ?? null,
      supersedes: [...(record.supersedes ?? [])],
      revision: 1,
      contentHash: hash,
      embedding: embedding ? this.vectorRef : null,
      status: record.status ?? 'active',
      heat: 0,
      accessCount: 0,
      lastAccessAt: null,
      createdSeq: record.createdSeq ?? 0,
      meta: { ...(record.meta ?? {}) },
      // 保留期治理列默认值（docs/23-memory-models §5）：新建默认 short；
      // pinned 只是治理标记，归入 long 由 RetentionEngine 的 next tick 完成（与真实 store 一致）
      retentionTier: 'short',
      retentionScore: 0,
      pinned: record.pinned === true,
      promotedAt: null,
      longTermAt: null,
    };
    this.memories.set(id, created);
    if (embedding) this.putVector('memory', id, this.vectorRef, embedding);
    return this.rebuildRecord(created);
  }

  getMemory(id: string): MemoryRecord | null {
    const memory = this.memories.get(id);
    return memory ? this.rebuildRecord(memory) : null;
  }

  listMemories(query: MemoryQuery = {}): MemoryRecord[] {
    let list = [...this.memories.values()];
    if (query.layers && query.layers.length > 0) list = list.filter((memory) => query.layers!.includes(memory.layer));
    if (query.kinds && query.kinds.length > 0) list = list.filter((memory) => query.kinds!.includes(memory.kind));
    if (query.sessionId !== undefined) list = list.filter((memory) => memory.sessionId === query.sessionId);
    if (query.workspace !== undefined) list = list.filter((memory) => memory.workspace === query.workspace);
    if (query.personaId !== undefined) {
      const target = query.personaId ?? null;
      const includeShared = query.includeSharedPersona !== false;
      list = list.filter((memory) => {
        const persona = memory.personaId ?? null;
        return persona === target || (includeShared && persona === null);
      });
    }
    if (query.status && query.status.length > 0) {
      list = list.filter((memory) => query.status!.includes((memory.status ?? 'active') as MemoryStatus));
    }
    if (query.retentionTiers && query.retentionTiers.length > 0) {
      list = list.filter((memory) => query.retentionTiers!.includes(memory.retentionTier ?? 'short'));
    }
    if (query.pinned === true) list = list.filter((memory) => memory.pinned === true);
    if (query.pinned === false) list = list.filter((memory) => memory.pinned !== true);
    if (query.onlyValid === true) list = list.filter((memory) => memory.validTo == null || memory.validTo > this.nowValue);
    if (query.tags && query.tags.length > 0) {
      list = list.filter((memory) => query.tags!.every((tag) => memory.tags.includes(tag)));
    }
    if (query.ids && query.ids.length > 0) {
      const set = new Set(query.ids);
      list = list.filter((memory) => set.has(memory.id));
    }
    if (query.from !== undefined) list = list.filter((memory) => memory.updatedAt >= query.from!);
    if (query.to !== undefined) list = list.filter((memory) => memory.updatedAt <= query.to!);
    list.sort((a, b) => (query.desc === false ? a.updatedAt - b.updatedAt : b.updatedAt - a.updatedAt));
    const offset = Math.max(0, query.offset ?? 0);
    const limit = query.limit ?? list.length;
    return list.slice(offset, offset + limit).map((memory) => this.rebuildRecord(memory));
  }

  countByLayer(): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const memory of this.memories.values()) counts[memory.layer] = (counts[memory.layer] ?? 0) + 1;
    return counts;
  }

  // -- 人格（docs/25） ------------------------------------------------------

  getActivePersonaId(): string | null {
    const value = this.metas.get('persona.active');
    return value !== undefined && value.length > 0 ? value : null;
  }

  setActivePersonaId(personaId: string | null, _now?: number): void {
    if (personaId === null) this.metas.delete('persona.active');
    else this.metas.set('persona.active', personaId);
  }

  countMemoriesByPersona(): { counts: Record<string, { total: number; L1: number; L2: number; L3: number }>; shared: number } {
    const counts: Record<string, { total: number; L1: number; L2: number; L3: number }> = {};
    let shared = 0;
    for (const memory of this.memories.values()) {
      const personaId = memory.personaId ?? null;
      if (personaId === null) {
        shared += 1;
        continue;
      }
      const bucket = counts[personaId] ?? { total: 0, L1: 0, L2: 0, L3: 0 };
      bucket.total += 1;
      if (memory.layer === 'L1') bucket.L1 += 1;
      else if (memory.layer === 'L2') bucket.L2 += 1;
      else if (memory.layer === 'L3') bucket.L3 += 1;
      counts[personaId] = bucket;
    }
    return { counts, shared };
  }

  // -- 向量 ---------------------------------------------------------------

  putVector(_ownerKind: VectorOwnerKind, ownerId: string, ref: EmbeddingRef, vec: Float32Array): void {
    this.vectors.set(ownerId, { ref: { ...ref }, vec: new Float32Array(vec) });
  }

  getVector(ownerId: string): { ref: EmbeddingRef; vec: Float32Array } | null {
    const row = this.vectors.get(ownerId);
    return row ? { ref: { ...row.ref }, vec: new Float32Array(row.vec) } : null;
  }

  searchVector(query: Float32Array, ref: EmbeddingRef, options: SearchVectorOptions = {}): VecHit[] {
    const hits: VecHit[] = [];
    for (const [id, row] of this.vectors) {
      if (row.ref.model !== ref.model || row.ref.dim !== ref.dim || row.ref.version !== ref.version) continue;
      const memory = this.memories.get(id);
      if (!memory) continue;
      if (options.layers && options.layers.length > 0 && !options.layers.includes(memory.layer)) continue;
      if (options.kinds && options.kinds.length > 0 && !options.kinds.includes(memory.kind)) continue;
      if (row.vec.length !== query.length) continue;
      let dot = 0;
      for (let i = 0; i < query.length; i += 1) dot += query[i] * row.vec[i];
      if (options.minScore !== undefined && dot < options.minScore) continue;
      hits.push({ id, layer: memory.layer, score: dot });
    }
    hits.sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : 1));
    return hits.slice(0, options.limit ?? hits.length);
  }

  searchLexical(query: string, options: SearchLexicalOptions = {}): LexHit[] {
    const queryTokens = [...new Set(tokenizeTextSeg(query))];
    if (queryTokens.length === 0) return [];
    const rows = [...this.memories.values()].filter((memory) => {
      if (options.layers && options.layers.length > 0 && !options.layers.includes(memory.layer)) return false;
      if (options.kinds && options.kinds.length > 0 && !options.kinds.includes(memory.kind)) return false;
      return true;
    });
    const matched = (memory: StoredMemory, tokens: string[]): number => {
      const textTokens = new Set(tokenizeTextSeg(memory.text));
      let count = 0;
      for (const token of tokens) if (textTokens.has(token)) count += 1;
      return count;
    };
    const andHits = rows
      .map((memory) => ({ memory, count: matched(memory, queryTokens) }))
      .filter((entry) => entry.count === queryTokens.length);
    const pool = andHits.length > 0 ? andHits : rows
      .map((memory) => ({ memory, score: matched(memory, queryTokens) }))
      .map((entry) => ({ memory: entry.memory, count: entry.score }))
      .filter((entry) => entry.count > 0);
    // 原始 bm25 风格负分（越负越好），recall 端按 §10.3 归一化
    const hits = pool.map((entry) => ({ id: entry.memory.id, layer: entry.memory.layer, score: -entry.count }));
    hits.sort((a, b) => a.score - b.score || (a.id < b.id ? -1 : 1));
    return hits.slice(0, options.limit ?? hits.length);
  }

  // -- raw 索引（只读镜像） -------------------------------------------------

  indexRawRecord(item: RawAppendItem): void {
    this.indexRawRecords([item]);
  }

  indexRawRecords(items: RawAppendItem[]): void {
    for (const item of items) {
      const { record, location } = item;
      if (this.rawIndex.has(record.id)) continue; // 只插入（幂等）
      this.rawIndex.set(record.id, {
        id: record.id,
        seq: record.seq,
        ts: record.ts,
        iso: record.iso,
        day: record.day,
        timezone: record.timezone,
        kind: record.kind,
        sessionId: record.sessionId,
        workspace: record.workspace ?? null,
        personaId: record.personaId ?? null,
        turnId: record.turnId ?? null,
        stepId: record.stepId ?? null,
        role: record.role ?? null,
        text: record.text ?? null,
        textSeg: normalizeForTextSeg(record.text ?? ''),
        payloadJson: JSON.stringify(record.payload ?? null),
        hash: record.hash,
        prevHash: record.prevHash,
        segment: location.segment,
        lineNo: location.lineNo,
        byteOffset: location.byteOffset,
        byteLen: location.byteLen,
        recordVersion: record.v,
        ingestKey: location.ingestKey,
        createdAt: record.ts,
      });
    }
  }

  hasRawIngestKey(ingestKey: string): boolean {
    for (const row of this.rawIndex.values()) if (row.ingestKey === ingestKey) return true;
    return false;
  }

  listRawIndex(query: RawQuery = {}): { records: RawIndexRow[]; total: number } {
    let list = [...this.rawIndex.values()];
    if (query.ids && query.ids.length > 0) {
      const set = new Set(query.ids);
      list = list.filter((row) => set.has(row.id));
    }
    if (query.kinds && query.kinds.length > 0) list = list.filter((row) => query.kinds!.includes(row.kind));
    if (query.sessionId) list = list.filter((row) => row.sessionId === query.sessionId);
    if (query.personaId !== undefined) {
      list = list.filter((row) => (row.personaId ?? null) === query.personaId);
    }
    if (query.from !== undefined) list = list.filter((row) => row.ts >= query.from!);
    if (query.to !== undefined) list = list.filter((row) => row.ts <= query.to!);
    list.sort((a, b) => (query.desc === true ? b.seq - a.seq : a.seq - b.seq));
    const total = list.length;
    const offset = Math.max(0, query.offset ?? 0);
    const limit = query.limit ?? total;
    return { records: list.slice(offset, offset + limit), total };
  }

  getRawIndex(id: string): RawIndexRow | null {
    return this.rawIndex.get(id) ?? null;
  }

  // -- 层治理 -------------------------------------------------------------

  layerStats(): LayerStatsRow[] {
    const names: Record<string, string> = { L1: 'L1 工作记忆层', L2: 'L2 情景记忆层', L3: 'L3 语义记忆层' };
    const out: LayerStatsRow[] = [];
    const layers = new Set<string>(['L1', 'L2', 'L3']);
    for (const memory of this.memories.values()) layers.add(memory.layer);
    for (const layer of [...layers].sort()) {
      const list = [...this.memories.values()].filter((memory) => memory.layer === layer);
      out.push({
        layer,
        name: names[layer] ?? layer,
        count: list.length,
        latestUpdatedAt: list.length > 0 ? Math.max(...list.map((memory) => memory.updatedAt)) : null,
      });
    }
    return out;
  }

  storageStats(): StorageStats {
    return {
      dbPath: this.dbPath,
      dbBytes: 0,
      rawCount: this.rawIndex.size,
      memoryCount: this.memories.size,
      activeMemoryCount: [...this.memories.values()].filter((memory) => (memory.status ?? 'active') === 'active').length,
      vectorCount: this.vectors.size,
      segmentCount: 0,
      embedding: this.vectorRef,
      schemaVersion: 1,
    };
  }

  touchMemories(ids: string[], now = this.nowValue): void {
    for (const id of ids) {
      const memory = this.memories.get(id);
      if (!memory) continue;
      memory.accessCount = (memory.accessCount ?? 0) + 1;
      memory.lastAccessAt = now;
      memory.updatedAt = now;
      memory.heat = computeHeatForTest(memory, now);
    }
  }

  // -- 保留期治理（docs/23-memory-models；只改治理列，**只升不降**） ---------

  retentionBatchCalls = 0;
  retentionWriteCalls = 0;

  private readRetention(memory: StoredMemory): RetentionState {
    return {
      tier: memory.retentionTier ?? 'short',
      score: memory.retentionScore ?? 0,
      pinned: memory.pinned === true,
      promotedAt: memory.promotedAt ?? null,
      longTermAt: memory.longTermAt ?? null,
    };
  }

  private writeRetention(memory: StoredMemory, state: RetentionState): void {
    memory.retentionTier = state.tier;
    memory.retentionScore = state.score;
    memory.pinned = state.pinned;
    memory.promotedAt = state.promotedAt;
    memory.longTermAt = state.longTermAt;
  }

  private static retentionRank(tier: RetentionTier): number {
    return tier === 'long' ? 2 : tier === 'mid' ? 1 : 0;
  }

  /** 契约语义：target 低于当前层时忽略降级（只升不降） */
  setRetention(id: string, state: RetentionState, _now?: number): void {
    const memory = this.memories.get(id);
    if (!memory) return;
    this.retentionWriteCalls += 1;
    const current = this.readRetention(memory);
    if (FakeMemoryStore.retentionRank(state.tier) < FakeMemoryStore.retentionRank(current.tier)) {
      this.writeRetention(memory, { ...state, tier: current.tier });
      return;
    }
    this.writeRetention(memory, state);
  }

  setRetentionBatch(updates: Array<{ id: string } & RetentionState>, now?: number): void {
    this.retentionBatchCalls += 1;
    for (const update of updates) this.setRetention(update.id, update, now);
  }

  getRetention(id: string): RetentionState | null {
    const memory = this.memories.get(id);
    return memory ? this.readRetention(memory) : null;
  }

  retentionStats(): RetentionStats {
    const counts: RetentionStats = { short: 0, mid: 0, long: 0, pinned: 0, lastTickAt: null };
    const rawLastTick = this.getRetentionMeta('retention.lastTickAt');
    if (rawLastTick !== null) {
      const parsed = Number.parseInt(rawLastTick, 10);
      counts.lastTickAt = Number.isFinite(parsed) ? parsed : null;
    }
    for (const memory of this.memories.values()) {
      const tier = memory.retentionTier ?? 'short';
      if (tier === 'long') counts.long += 1;
      else if (tier === 'mid') counts.mid += 1;
      else counts.short += 1;
      if (memory.pinned === true) counts.pinned += 1;
    }
    return counts;
  }

  listByRetention(tier: RetentionTier, options: { limit?: number; offset?: number } = {}): MemoryRecord[] {
    const list = [...this.memories.values()].filter((memory) => (memory.retentionTier ?? 'short') === tier);
    list.sort(
      (a, b) =>
        (b.retentionScore ?? 0) - (a.retentionScore ?? 0) ||
        b.updatedAt - a.updatedAt ||
        (a.id < b.id ? -1 : 1),
    );
    const offset = Math.max(0, options.offset ?? 0);
    const limit = options.limit ?? list.length;
    return list.slice(offset, offset + limit).map((memory) => this.rebuildRecord(memory));
  }

  listRetentionCandidates(options: { since?: number; limit?: number; offset?: number } = {}): MemoryRecord[] {
    // 契约：未到 long 的记录（短期/中期）+ 最近更新
    const list = [...this.memories.values()].filter((memory) => {
      if ((memory.status ?? 'active') === 'archived') return false;
      if ((memory.retentionTier ?? 'short') === 'long') return false;
      if (options.since !== undefined && memory.updatedAt < options.since) return false;
      return true;
    });
    list.sort((a, b) => b.updatedAt - a.updatedAt || (a.id < b.id ? -1 : 1));
    const offset = Math.max(0, options.offset ?? 0);
    const limit = options.limit ?? list.length;
    return list.slice(offset, offset + limit).map((memory) => this.rebuildRecord(memory));
  }

  getRetentionMeta(key: string): string | null {
    return this.metas.get(key) ?? null;
  }

  setRetentionMeta(key: string, value: string, _now?: number): void {
    this.metas.set(key, value);
  }

  // -- 原始层向量（永久向量模型，docs/24 §3；append-only） ------------------

  readonly rawVectors = new Map<string, { ref: EmbeddingRef; vec: Float32Array }>();
  readonly rawVectorMeta = new Map<string, string>();

  putRawVector(rawId: string, ref: EmbeddingRef, vec: Float32Array): void {
    if (this.rawVectors.has(`${rawId}\u0000${ref.model}\u0000${ref.version}`)) return; // 只追加，不更新
    this.rawVectors.set(`${rawId}\u0000${ref.model}\u0000${ref.version}`, { ref: { ...ref }, vec: new Float32Array(vec) });
  }

  getRawVector(rawId: string): { ref: EmbeddingRef; vec: Float32Array } | null {
    for (const [key, row] of this.rawVectors) {
      if (!key.startsWith(`${rawId}\u0000`)) continue;
      return { ref: { ...row.ref }, vec: new Float32Array(row.vec) };
    }
    return null;
  }

  searchRawVector(query: Float32Array, ref: EmbeddingRef, options: { limit?: number; minScore?: number } = {}): RawVecHit[] {
    const hits: RawVecHit[] = [];
    for (const [key, row] of this.rawVectors) {
      if (row.ref.model !== ref.model || row.ref.dim !== ref.dim || row.ref.version !== ref.version) continue;
      const rawId = key.split('\u0000')[0];
      if (!this.rawIndex.has(rawId)) continue;
      if (row.vec.length !== query.length) continue;
      let dot = 0;
      for (let i = 0; i < query.length; i += 1) dot += query[i] * row.vec[i];
      if (options.minScore !== undefined && dot < options.minScore) continue;
      hits.push({ rawId, score: dot });
    }
    hits.sort((a, b) => b.score - a.score || (a.rawId < b.rawId ? -1 : 1));
    return hits.slice(0, options.limit ?? hits.length);
  }

  searchRawLexical(query: string, options: { limit?: number; minScore?: number } = {}): RawVecHit[] {
    const queryTokens = [...new Set(tokenizeTextSeg(query))];
    if (queryTokens.length === 0) return [];
    const rows = [...this.rawIndex.values()].filter((row) => typeof row.text === 'string' && row.text.length > 0);
    const count = (row: RawIndexRow): number => {
      const tokens = new Set(tokenizeTextSeg(row.text ?? ''));
      let matched = 0;
      for (const token of queryTokens) if (tokens.has(token)) matched += 1;
      return matched;
    };
    const andHits = rows.map((row) => ({ row, matched: count(row) })).filter((entry) => entry.matched === queryTokens.length);
    const pool = andHits.length > 0
      ? andHits
      : rows.map((row) => ({ row, matched: count(row) })).filter((entry) => entry.matched > 0);
    const hits = pool.map((entry) => ({ rawId: entry.row.id, score: -entry.matched }));
    hits.sort((a, b) => a.score - b.score || (a.rawId < b.rawId ? -1 : 1));
    const filtered = options.minScore !== undefined ? hits.filter((hit) => hit.score >= options.minScore!) : hits;
    return filtered.slice(0, options.limit ?? filtered.length);
  }

  listRawWithoutVectors(ref: EmbeddingRef, limit = 100): Array<{ id: string; text: string | null }> {
    return [...this.rawIndex.values()]
      .filter((row) => !this.rawVectors.has(`${row.id}\u0000${ref.model}\u0000${ref.version}`))
      .slice(0, limit)
      .map((row) => ({ id: row.id, text: row.text }));
  }

  rawVectorStats(ref?: EmbeddingRef): RawVectorStats {
    const target = ref ?? this.vectorRef;
    let total = 0;
    for (const row of this.rawVectors.values()) {
      if (row.ref.model === target.model && row.ref.version === target.version && row.ref.dim === target.dim) total += 1;
    }
    const pending = [...this.rawIndex.keys()].filter(
      (id) => !this.rawVectors.has(`${id}\u0000${target.model}\u0000${target.version}`),
    ).length;
    let embedded = 0;
    for (const row of this.rawVectors.values()) {
      if (row.ref.model === target.model && row.ref.version === target.version && row.ref.dim === target.dim) embedded += 1;
    }
    const lastRaw = this.rawVectorMeta.get('raw_vectors.lastBackfillAt');
    const parsedLast = lastRaw === undefined ? null : Number.parseInt(lastRaw, 10);
    return { total, embedded, pending, ref: target, lastBackfillAt: Number.isFinite(parsedLast as number) ? (parsedLast as number) : null };
  }

  rebuildRawVectors(): { removed: number } {
    const removed = this.rawVectors.size;
    this.rawVectors.clear();
    return { removed };
  }

  setRawVectorMeta(key: string, value: string, _now?: number): void {
    this.rawVectorMeta.set(key, value);
  }

  getRawVectorMeta(key: string): string | null {
    return this.rawVectorMeta.get(key) ?? null;
  }

  // -- 遗忘（docs/24 §2；只作用于派生层） ---------------------------------

  forgetDerivedMemories(options: {
    layers?: LayerId[];
    tiers?: RetentionTier[];
    olderThan: number;
    mode: 'delete' | 'archive';
    limit?: number;
    protectPinned?: boolean;
    protectImportance?: number;
    now?: number;
  }): { deleted: number; archived: number; ids: string[] } {
    const now = options.now ?? this.nowValue;
    const layers = options.layers && options.layers.length > 0 ? new Set(options.layers) : null;
    const tiers = options.tiers && options.tiers.length > 0 ? new Set(options.tiers) : null;
    const limit = options.limit ?? Number.POSITIVE_INFINITY;
    const protectPinned = options.protectPinned !== false;
    const protectImportance = options.protectImportance ?? 1;
    const ids: string[] = [];
    let deleted = 0;
    let archived = 0;
    const candidates = [...this.memories.values()].filter((memory) => {
      if ((memory.status ?? 'active') !== 'active') return false;
      if (layers && !layers.has(memory.layer)) return false;
      if (tiers && !tiers.has(memory.retentionTier ?? 'short')) return false;
      const lastActive = Math.max(memory.createdAt, memory.updatedAt);
      if (lastActive >= options.olderThan) return false;
      if (protectPinned && memory.pinned === true) return false;
      if ((memory.importance ?? 0) >= protectImportance) return false;
      return true;
    });
    for (const memory of candidates) {
      if (ids.length >= limit) break;
      ids.push(memory.id);
      if (options.mode === 'delete') {
        this.memories.delete(memory.id);
        this.vectors.delete(memory.id);
        this.revisions.delete(memory.id);
        this.l2Rows.delete(memory.id);
        this.l3Rows.delete(memory.id);
        deleted += 1;
      } else {
        this.snapshot(memory, 'archive');
        memory.status = 'archived';
        memory.validTo = now;
        memory.updatedAt = now;
        if (this.l3Rows.has(memory.id)) {
          const row = this.l3Rows.get(memory.id)!;
          this.l3Rows.set(memory.id, { ...row, validTo: now });
        }
        archived += 1;
      }
    }
    return { deleted, archived, ids };
  }

  forgettingStats(): ForgettingStats {
    const shortDeleted = Number.parseInt(this.metas.get('forgetting.deletedShort') ?? '0', 10) || 0;
    const midArchived = Number.parseInt(this.metas.get('forgetting.archivedMid') ?? '0', 10) || 0;
    const lastRaw = this.metas.get('forgetting.lastForgetAt');
    const parsed = lastRaw === undefined ? null : Number.parseInt(lastRaw, 10);
    return {
      shortDeleted,
      midArchived,
      lastForgetAt: parsed !== null && Number.isFinite(parsed) ? parsed : null,
    };
  }

  recordForgetting(stats: { deletedShort?: number; archivedMid?: number }, now = this.nowValue): void {
    if ((stats.deletedShort ?? 0) > 0) {
      const prev = Number.parseInt(this.metas.get('forgetting.deletedShort') ?? '0', 10) || 0;
      this.metas.set('forgetting.deletedShort', String(prev + (stats.deletedShort ?? 0)));
    }
    if ((stats.archivedMid ?? 0) > 0) {
      const prev = Number.parseInt(this.metas.get('forgetting.archivedMid') ?? '0', 10) || 0;
      this.metas.set('forgetting.archivedMid', String(prev + (stats.archivedMid ?? 0)));
    }
    this.metas.set('forgetting.lastForgetAt', String(now));
  }

  getDeriveCursor(layer: LayerId): number {
    return this.cursors.get(layer) ?? 0;
  }

  setDeriveCursor(layer: LayerId, lastRawSeq: number): void {
    const current = this.cursors.get(layer) ?? 0;
    if (lastRawSeq < current) return; // 契约：水位只前进（重建由 clearLayer 归零）
    this.cursors.set(layer, lastRawSeq);
  }

  clearLayer(layer: LayerId, options: { archive?: boolean; now?: number } = {}): { removed: number; archived: number } {
    this.clearLayerCalls.push({ layer, ...(options.archive !== undefined ? { archive: options.archive } : {}) });
    const now = options.now ?? this.nowValue;
    const targets = [...this.memories.values()].filter((memory) => memory.layer === layer);
    this.cursors.set(layer, 0);
    if (layer === 'L3') {
      if (options.archive !== true) throw new Error('L3 physical delete refused (trg_l3_no_delete)');
      for (const memory of targets) {
        this.snapshot(memory, 'archive');
        memory.status = 'archived';
        memory.validTo = now;
        memory.updatedAt = now;
        if (this.l3Rows.has(memory.id)) {
          const row = this.l3Rows.get(memory.id)!;
          this.l3Rows.set(memory.id, { ...row, validTo: now });
        }
      }
      return { removed: 0, archived: targets.length };
    }
    for (const memory of targets) {
      this.memories.delete(memory.id);
      this.vectors.delete(memory.id);
      this.revisions.delete(memory.id);
      this.l2Rows.delete(memory.id);
    }
    return { removed: targets.length, archived: 0 };
  }

  putL2Episode(row: L2EpisodeRow): void {
    this.l2Rows.set(row.memoryId, { ...row, pageIds: [...(row.pageIds ?? [])] });
  }

  putL3Semantic(row: L3SemanticRow): void {
    this.l3Rows.set(row.memoryId, { ...row });
  }

  getL3Semantic(memoryId: string): L3SemanticRow | null {
    const row = this.l3Rows.get(memoryId);
    return row ? { ...row } : null;
  }

  getMeta(key: string): string | null {
    return this.metas.get(key) ?? null;
  }

  setMeta(key: string, value: string, _now?: number): void {
    this.metas.set(key, value);
  }

  listLayers(): LayerRegistryRow[] {
    const stats = new Map(this.layerStats().map((row) => [row.layer, row]));
    const ids = ['L1', 'L2', 'L3'];
    for (const id of this.memories.keys()) if (!ids.includes(this.memories.get(id)!.layer)) ids.push(this.memories.get(id)!.layer);
    return ids.map((id) => {
      const stat = stats.get(id);
      const list = [...this.memories.values()].filter((memory) => memory.layer === id);
      return {
        id,
        name: stat?.name ?? id,
        version: 1,
        dependsOn: id === 'L1' ? [] : id === 'L2' ? ['L1'] : id === 'L3' ? ['L1', 'L2'] : [],
        kind: id.startsWith('L') && /^L\d+$/.test(id) ? 'builtin' : 'extension',
        enabled: true,
        rebuildable: true,
        count: list.length,
        active: list.filter((memory) => (memory.status ?? 'active') === 'active').length,
        archived: list.filter((memory) => memory.status === 'archived').length,
        latestUpdatedAt: stat?.latestUpdatedAt ?? null,
      };
    });
  }

  listSources(memoryId: string): SourceLinkRow[] {
    const memory = this.memories.get(memoryId);
    if (!memory) return [];
    return memory.sourceRawIds.map((rawId) => ({ rawId, relation: 'derived_from', weight: 1 }));
  }

  listRevisions(memoryId: string): MemoryRevisionRow[] {
    return [...(this.revisions.get(memoryId) ?? [])];
  }

  listIntegrityRuns(limit = 20): IntegrityRunRow[] {
    return this.integrityRuns.slice(-limit);
  }

  listRepairLog(limit = 20): RepairLogRow[] {
    return this.repairLog.slice(-limit);
  }

  embeddingCoverage(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const [id] of this.vectors) {
      const memory = this.memories.get(id);
      if (!memory) continue;
      out[memory.layer] = (out[memory.layer] ?? 0) + 1;
    }
    return out;
  }

  getLastIntegrityRun(): IntegrityRunRow | null {
    return this.integrityRuns.length > 0 ? this.integrityRuns[this.integrityRuns.length - 1] : null;
  }

  recordIntegrityRun(_run: {
    kind: string;
    startedAt: number;
    finishedAt?: number;
    recordsChecked?: number;
    segmentsChecked?: number;
    ok: boolean;
    details?: Record<string, unknown>;
  }): void {
    /* 测试不关心 */
  }

  transaction<T>(fn: () => T): T {
    this.transactionCalls += 1;
    return fn();
  }

  close(): void {
    /* no-op */
  }
}

/** 计算 heat（与 src/layers/util.ts 公式一致；测试断言用） */
export function computeHeatForTest(
  memory: { updatedAt: number; accessCount?: number; importance: number; sourceRawIds: string[] },
  now: number,
): number {
  const halfLife = memory.sourceRawIds.length >= 0 && now !== undefined ? 14 : 14;
  const recency = 0.5 ** (Math.max(0, now - memory.updatedAt) / 86_400_000 / halfLife);
  const freq = Math.min(1, Math.log1p(memory.accessCount ?? 0) / Math.log1p(20));
  const recurrence = Math.min(1, memory.sourceRawIds.length / 5);
  return Math.min(1, Math.max(0, 0.35 * recency + 0.25 * freq + 0.3 * memory.importance + 0.1 * recurrence));
}

/** 最小 RawVault fake（仅用于需要 vault 的集成场景；测试一般直接造 RawRecord） */
export class FakeRawVault implements RawVault {
  records: RawRecord[] = [];
  async append(batch: RawRecordInput[]): Promise<AppendResult> {
    const items: RawAppendItem[] = batch.map((input, index) => {
      const seq = this.records.length + index + 1;
      const ts = input.ts;
      const record: RawRecord = {
        ...input,
        id: `2026-10-25-${String(seq).padStart(6, '0')}`,
        day: '2026-10-25',
        seq,
        ts,
        iso: new Date(ts).toISOString(),
        hash: '0'.repeat(64),
        prevHash: '0'.repeat(64),
        v: 1,
      };
      return {
        record,
        location: { ingestKey: input.ingestKey ?? `auto:${seq}`, segment: 'segments/x.jsonl', lineNo: seq, byteOffset: 0, byteLen: 0 },
      };
    });
    this.records.push(...items.map((item) => item.record));
    return { items, skipped: 0, segmentsWritten: ['segments/x.jsonl'] };
  }
  async get(id: string): Promise<RawRecord | null> {
    return this.records.find((record) => record.id === id) ?? null;
  }
  async list(query: RawQuery = {}): Promise<{ records: RawRecord[]; total: number }> {
    const records = await makeReadRaw(this.records)(query);
    return { records, total: records.length };
  }
  async *iterate(query: RawQuery = {}): AsyncIterable<RawRecord> {
    const { records } = await this.list(query);
    for (const record of records) yield record;
  }
  async verify(): Promise<VerifyResult> {
    return { ok: true, checked: this.records.length };
  }
  async stats(): Promise<VaultStats> {
    return { records: this.records.length, segments: 1, days: 1, bytes: 0 };
  }
  async manifest(): Promise<VaultManifest> {
    return {
      formatVersion: 1,
      vaultId: 'fake-vault',
      updatedAt: this.records.length > 0 ? this.records[this.records.length - 1].ts : 0,
      segments: [],
      stats: { records: this.records.length, days: 1, bytes: 0 },
    };
  }
  async close(): Promise<void> {
    /* no-op */
  }
}

/** 便捷：一块可变时钟（同时喂 store 与派生 now） */
export function createClock(start = TEST_NOW): { now(): number; set(value: number): void; advance(ms: number): void } {
  let value = start;
  return {
    now: () => value,
    set(next: number) {
      value = next;
    },
    advance(ms: number) {
      value += ms;
    },
  };
}

export type { MemoryKind };

// ---------------------------------------------------------------------------
// 测试装配：fake store + 内置三层 + 可追加 raw 的 readRaw
// ---------------------------------------------------------------------------

export interface LayerHarness {
  store: FakeMemoryStore;
  embedder: Embedder;
  config: MemoryVaultConfig;
  clock: ReturnType<typeof createClock>;
  raws: RawRecord[];
  registry: LayerRegistry;
  /** 追加一批 raw（模拟 L0 落盘） */
  pushRaws(...raws: RawRecord[]): void;
  /** 跑一次增量派生（now 由 clock 提供） */
  run(partial?: Partial<DeriveInput> & { layers?: LayerId[] }): Promise<LayerRunResult[]>;
}

/** 装配 L1/L2/L3 + fake store 的测试环境 */
export function createHarness(options: {
  raws?: RawRecord[];
  config?: MemoryVaultConfig;
  embedder?: Embedder;
  layers?: Array<ReturnType<typeof createL1Layer> | ReturnType<typeof createL2Layer> | ReturnType<typeof createL3Layer>>;
  now?: number;
} = {}): LayerHarness {
  const clock = createClock(options.now ?? TEST_NOW);
  const store = new FakeMemoryStore();
  store.nowValue = clock.now();
  const raws = [...(options.raws ?? [])];
  const readRaw = makeReadRaw(raws);
  const embedder = options.embedder ?? createFakeEmbedder(64);
  const config = options.config ?? testConfig();
  const registry = createLayerRegistry({
    store,
    embedder,
    config,
    logger: silentLogger,
    readRaw,
    now: () => clock.now(),
  });
  for (const layer of options.layers ?? [createL1Layer(), createL2Layer(), createL3Layer()]) {
    registry.register(layer as never);
  }
  return {
    store,
    embedder,
    config,
    clock,
    raws,
    registry,
    pushRaws(...incoming: RawRecord[]) {
      raws.push(...incoming);
    },
    async run(partial: Partial<DeriveInput> & { layers?: LayerId[] } = {}) {
      store.nowValue = clock.now();
      const input: DeriveInput = {
        raws: partial.raws ?? [],
        ...(partial.pendingRaws !== undefined ? { pendingRaws: partial.pendingRaws } : {}),
        reason: (partial.reason ?? 'capture') as DeriveReason,
        ...(partial.sessionId !== undefined ? { sessionId: partial.sessionId } : {}),
        now: clock.now(),
      };
      return registry.run(input, partial.layers);
    },
  };
}

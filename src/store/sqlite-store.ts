// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hanxustu (dsh-life-memory)
/**
 * SQLite `MemoryStore` 实现（docs/20 §7/§8，DDL 见 docs/21-schema.sql → schema.ts）。
 *
 * 设计要点：
 *   - L0 原始记录只读镜像：`raw_index`/`raw_fts`/`raw_segments` 只 INSERT/IGNORE，
 *     不可 UPDATE/DELETE（DB 触发器兜底）；事实来源永远是 vault 段文件；
 *   - 派生记忆统一信封 `memory_records` + 层私有表 + 溯源 + 版本快照 + 向量；
 *     中文检索用 `text_seg` 二元组影子列（docs §7.4）；
 *   - `upsertMemory` 在一个事务内完成：校验 → 去重/取代判定 → 旧版快照 →
 *     INSERT/UPDATE → 溯源 → 向量，实现幂等与可追溯；
 *   - `transaction<T>(fn)` 支持嵌套调用（层内部一次事务里写记录+私有行+向量）；
 *   - 所有读方法只读；治理列（access/heat）只由 `touchMemories` 更新。
 */

import { randomUUID } from 'node:crypto';
import { mkdirSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { StatementSync } from 'node:sqlite';

import type {
  RetentionState,
  RetentionStats,
  RetentionTier,
  EmbeddingRef,
  ForgettingStats,
  LayerId,
  IntegrityRunRow,
  L2EpisodeRow,
  L3SemanticRow,
  LayerRegistryRow,
  LayerStatsRow,
  LexHit,
  Logger,
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
  RawVecHit,
  RawVectorStats,
  RepairLogRow,
  SearchLexicalOptions,
  SearchVectorOptions,
  SourceLinkRow,
  StorageStats,
  VecHit,
  VectorOwnerKind,
} from '../core/contracts.ts';
import { contentHash as computeContentHash, sha256Hex } from '../core/hash.ts';
import { deriveMemoryId, isMemoryId, parseRawId } from '../core/ids.ts';
import { silentLogger } from '../core/logger.ts';
import { textToTextSeg, tokenizeTextSeg } from '../core/text.ts';
import { cosineSimilarity, isNormalized, normalize } from '../search/cosine.ts';

import { applyConnectionPragmas, ensureSchema, readSchemaVersion } from './migrations.ts';
import {
  blobToFloat32,
  buildAndMatch,
  buildOrMatch,
  clamp01,
  computeHeat,
  escapeLikePattern,
  float32ToBlob,
  normalizeFtsTokens,
  normalizeVector,
  parseJsonArray,
  parseJsonObject,
  stringifyJsonArray,
  stringifyJsonObject,
  validateVector,
  vectorNorm,
} from './store-utils.ts';

/** 派生记忆 kind 合法值（contracts.ts MemoryKind） */
const MEMORY_KINDS: ReadonlySet<string> = new Set<MemoryKind>([
  'atom',
  'episode',
  'summary',
  'fact',
  'preference',
  'decision',
  'profile',
  'entity',
  'relation',
  'custom',
]);

/** 派生记忆状态合法值 */
const MEMORY_STATUSES: ReadonlySet<string> = new Set<MemoryStatus>([
  'active',
  'archived',
  'pending_validation',
]);

/** 派生 memory text 上限（docs/20 §8.1：≤8 KB；按 UTF-8 字节计） */
const MEMORY_TEXT_MAX_BYTES = 8 * 1024;
/** 控制字符（除 \n \t）不允许出现在派生文本/摘要中（docs/20 §8.1） */
const CONTROL_CHARS_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
/** 默认向量检索条数 */
const DEFAULT_VECTOR_LIMIT = 20;
/** 默认词法检索条数 */
const DEFAULT_LEXICAL_LIMIT = 20;

/** Store 打开参数（由 src/store/index.ts 的 openStore 归一化） */
export interface SqliteStoreOptions {
  /** SQLite 文件路径（':memory:' 支持内存库，测试用） */
  dbPath: string;
  /** 默认嵌入引用（写入向量的维度/模型校验） */
  embedding: EmbeddingRef;
  /** embedding_models.provider 值 */
  provider: string;
  /** 建库时记录的时区 */
  timezone?: string;
  logger?: Logger;
  /** 注入时钟（测试） */
  now?: () => number;
  /**
   * 是否强制校验 sourceRawIds 全部存在于 raw_index（docs/20 §8.5 建议开启；
   * 默认关闭以兼容派生层在 raw 索引补齐前的测试/重放场景）。
   */
  strictProvenance?: boolean;
}

/** DB 行形状：memory_records（snake_case） */
interface MemoryRow {
  id: string;
  layer: string;
  kind: string;
  text: string;
  text_seg: string;
  summary: string | null;
  importance: number;
  confidence: number;
  session_id: string | null;
  workspace: string | null;
  tags_json: string;
  created_at: number;
  updated_at: number;
  valid_from: number | null;
  valid_to: number | null;
  supersedes_json: string;
  superseded_by: string | null;
  revision: number;
  content_hash: string;
  embedding_model: string | null;
  embedding_dim: number | null;
  embedding_version: string | null;
  status: string;
  heat: number;
  access_count: number;
  last_access_at: number | null;
  created_seq: number;
  meta_json: string;
  // migration 2（docs/23-memory-models §5）：保留期（short/mid/long）治理列
  retention_tier: string;
  retention_score: number;
  pinned: number;
  promoted_at: number | null;
  long_term_at: number | null;
  // migration 4（docs/25-persona §7）：人格归属（NULL = 共享）
  persona_id: string | null;
}

/** DB 行形状：保留期治理列（只读保留期状态/内部事务用） */
interface RetentionRow {
  retention_tier: string;
  retention_score: number;
  pinned: number;
  promoted_at: number | null;
  long_term_at: number | null;
}

/** DB 行形状：raw_index */
interface RawIndexDbRow {
  id: string;
  seq: number;
  ts: number;
  iso: string;
  day: string;
  timezone: string;
  kind: string;
  session_id: string;
  workspace: string | null;
  turn_id: string | null;
  step_id: string | null;
  role: string | null;
  text: string | null;
  text_seg: string;
  payload_json: string;
  hash: string;
  prev_hash: string;
  segment: string;
  line_no: number;
  byte_offset: number;
  byte_len: number;
  record_version: number;
  ingest_key: string;
  created_at: number;
  // migration 4（docs/25-persona §7）：原始记录人格归属（索引元数据；NULL = 共享）
  persona_id: string | null;
}

/** 校验并归一化后的派生记忆输入 */
interface ValidatedMemory {
  id: string;
  layer: string;
  kind: string;
  text: string;
  textSeg: string;
  summary: string | null;
  importance: number;
  confidence: number;
  sourceRawIds: string[];
  sessionId: string | null;
  workspace: string | null;
  tags: string[];
  createdAt: number;
  validFrom: number | null;
  validTo: number | null;
  supersedes: string[];
  status: MemoryStatus;
  /** 保留期钉住：undefined = 调用方未指定（更新时保留既有 pinned） */
  pinned?: boolean;
  /** 人格归属：undefined = 未指定（更新时保留既有 persona_id；新记录 = NULL 共享） */
  personaId?: string | null;
  createdSeq: number;
  meta: Record<string, unknown>;
  metaJson: string;
  contentHash: string;
}

/**
 * SQLite 存储实现（contracts.MemoryStore）。
 * 通过 `openStore()` 创建；不要直接 new（构造函数会打开连接/执行迁移）。
 */
export class SqliteMemoryStore implements MemoryStore {
  private readonly connection: DatabaseSync;
  private readonly dbPathValue: string;
  private readonly log: Logger;
  private readonly clock: () => number;
  private readonly defaultEmbedding: EmbeddingRef;
  private readonly provider: string;
  private readonly timezone: string;
  private readonly strictProvenance: boolean;
  private readonly statements = new Map<string, StatementSync>();
  private txDepth = 0;
  private closing = false;

  constructor(options: SqliteStoreOptions) {
    this.dbPathValue = options.dbPath;
    this.log = options.logger ?? silentLogger;
    this.clock = options.now ?? (() => Date.now());
    this.defaultEmbedding = options.embedding;
    this.provider = options.provider;
    this.timezone = options.timezone ?? 'UTC';
    this.strictProvenance = options.strictProvenance === true;
    if (options.dbPath !== ':memory:') {
      mkdirSync(dirname(options.dbPath), { recursive: true });
    }
    this.connection = new DatabaseSync(options.dbPath);
    try {
      applyConnectionPragmas(this.connection, { memory: options.dbPath === ':memory:' });
      ensureSchema(this.connection, this.clock());
      this.initializeMeta();
      // docs/23-memory-models §2：内置层显示名统一（覆盖"已迁移到 v2 但名字仍旧"的历史库）
      this.normalizeBuiltinLayerNames();
    } catch (error) {
      try {
        this.connection.close();
      } catch {
        /* ignore */
      }
      throw error;
    }
  }

  // -------------------------------------------------------------------------
  // 基础：连接 / 语句缓存 / 事务
  // -------------------------------------------------------------------------

  /** 当前 SQLite 连接（仅供扩展层建私有表/查询；禁止直接改 raw_index / memory_records） */
  get db(): DatabaseSync {
    return this.connection;
  }

  /** 数据库文件路径 */
  get dbPath(): string {
    return this.dbPathValue;
  }

  private assertOpen(label: string): void {
    if (this.closing) {
      throw new Error(`[dsh-life-memory] store: cannot ${label} after close()`);
    }
  }

  private stmt(sql: string): StatementSync {
    const cached = this.statements.get(sql);
    if (cached !== undefined) return cached;
    const statement = this.connection.prepare(sql);
    this.statements.set(sql, statement);
    return statement;
  }

  private getRow<T>(sql: string, ...params: unknown[]): T | null {
    const row = this.stmt(sql).get(...(params as never[]));
    return row === undefined ? null : (row as T);
  }

  private allRows<T>(sql: string, ...params: unknown[]): T[] {
    return this.stmt(sql).all(...(params as never[])) as unknown as T[];
  }

  private run(sql: string, ...params: unknown[]): { changes: number } {
    const result = this.stmt(sql).run(...(params as never[]));
    return { changes: Number(result.changes ?? 0) };
  }

  /**
   * 在 SQLite 事务内执行（BEGIN IMMEDIATE；fn 抛错则 ROLLBACK）。
   * 支持嵌套：内层直接执行 fn（同一事务），由最外层统一提交/回滚。
   */
  transaction<T>(fn: () => T): T {
    this.assertOpen('begin transaction');
    if (this.txDepth > 0) {
      this.txDepth += 1;
      try {
        return fn();
      } finally {
        this.txDepth -= 1;
      }
    }
    this.connection.exec('BEGIN IMMEDIATE');
    this.txDepth = 1;
    try {
      const result = fn();
      this.connection.exec('COMMIT');
      return result;
    } catch (error) {
      try {
        this.connection.exec('ROLLBACK');
      } catch {
        /* ignore */
      }
      throw error;
    } finally {
      this.txDepth = 0;
    }
  }

  /** 关闭连接（先尝试 WAL checkpoint；幂等） */
  close(): void {
    if (this.closing) return;
    this.closing = true;
    this.statements.clear();
    try {
      this.connection.exec('PRAGMA wal_checkpoint(TRUNCATE);');
    } catch {
      /* checkpoint 失败不阻止关闭（WAL 仍由下次打开恢复） */
    }
    this.connection.close();
  }

  // -------------------------------------------------------------------------
  // 元数据初始化 / meta
  // -------------------------------------------------------------------------

  private initializeMeta(): void {
    const now = this.clock();
    const vaultId = this.getMeta('vault_id');
    if (vaultId === null || vaultId.length === 0 || vaultId === '""') {
      this.setMeta('vault_id', randomUUID(), now);
    }
    const createdAt = this.getMeta('created_at');
    if (createdAt === null || createdAt === '0') {
      this.setMeta('created_at', String(now), now);
    }
    this.setMeta('timezone', this.timezone, now);
    this.setMeta('record_format_version', '1', now);
    this.setMeta('raw_id_policy', 'local-date+seq', now);
    this.ensureEmbeddingModel(this.defaultEmbedding);
    this.updateMetaRaw('embedding_model', JSON.stringify(this.defaultEmbedding.model), now);
    this.updateMetaRaw('embedding_dim', String(this.defaultEmbedding.dim), now);
    this.updateMetaRaw('embedding_version', JSON.stringify(this.defaultEmbedding.version), now);
    // 内置层派生水位行（docs/21 §11 初始化提示 3）
    this.stmt(
      'INSERT OR IGNORE INTO derive_cursors(layer, last_raw_seq, updated_at) ' +
        "SELECT id, 0, ? FROM layers WHERE kind = 'builtin'",
    ).run(now);
    // counters raw.seq 与已有 raw_index 对齐（幂等）
    this.stmt(
      "UPDATE counters SET value = MAX(value, COALESCE((SELECT MAX(seq) FROM raw_index), 0)), updated_at = ? " +
        "WHERE name = 'raw.seq'",
    ).run(now);
  }

  /**
   * 幂等修正内置层显示名（docs/23-memory-models §2）：
   * L1 工作记忆层 / L2 情景记忆层 / L3 语义记忆层。
   *
   * layers 行是**治理元数据**（tool memory_layers / UI 的显示名来源），不是内容；
   * 只改 name，不动 enabled/version/depends_on/kind。migration 2 尾部已对升级库修正，
   * 这里再兜底一次，保证"已迁移到 v2 但名称仍是旧值"的历史库打开即纠正。
   */
  private normalizeBuiltinLayerNames(): void {
    this.run("UPDATE layers SET name = 'L1 工作记忆层' WHERE id = 'L1' AND kind = 'builtin'");
    this.run("UPDATE layers SET name = 'L2 情景记忆层' WHERE id = 'L2' AND kind = 'builtin'");
    this.run("UPDATE layers SET name = 'L3 语义记忆层' WHERE id = 'L3' AND kind = 'builtin'");
  }

  /** 读取元数据：value 是 JSON 字符串；字符串原样返回，数字/布尔转字符串，缺失/null 返回 null */
  getMeta(key: string): string | null {
    this.assertOpen('getMeta');
    const row = this.getRow<{ value: string }>('SELECT value FROM meta WHERE key = ?', key);
    if (row === null) return null;
    try {
      const parsed: unknown = JSON.parse(row.value);
      if (typeof parsed === 'string') return parsed;
      if (typeof parsed === 'number' || typeof parsed === 'boolean') return String(parsed);
      if (parsed === null) return null;
      return row.value;
    } catch {
      return row.value;
    }
  }

  /** 写入元数据（value 以 JSON 字符串编码存 meta.value） */
  setMeta(key: string, value: string, now: number = this.clock()): void {
    this.assertOpen('setMeta');
    if (typeof key !== 'string' || key.length === 0) {
      throw new TypeError('[dsh-life-memory] store.setMeta: key must be a non-empty string');
    }
    if (typeof value !== 'string') {
      throw new TypeError('[dsh-life-memory] store.setMeta: value must be a string');
    }
    this.updateMetaRaw(key, JSON.stringify(value), now);
  }

  private updateMetaRaw(key: string, jsonValue: string, now: number): void {
    this.run(
      'INSERT INTO meta(key, value, updated_at) VALUES (?, ?, ?) ' +
        'ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
      key,
      jsonValue,
      now,
    );
  }

  /** 确保 embedding_models 中登记了该向量空间；同 model 但 dim/version 不同则拒绝（避免混用向量空间） */
  private ensureEmbeddingModel(ref: EmbeddingRef): void {
    if (typeof ref.model !== 'string' || ref.model.length === 0) {
      throw new TypeError('[dsh-life-memory] store: embedding ref.model must be a non-empty string');
    }
    if (!Number.isSafeInteger(ref.dim) || ref.dim <= 0) {
      throw new RangeError('[dsh-life-memory] store: embedding ref.dim must be a positive integer');
    }
    if (typeof ref.version !== 'string' || ref.version.length === 0) {
      throw new TypeError('[dsh-life-memory] store: embedding ref.version must be a non-empty string');
    }
    const existing = this.getRow<{ dim: number; version: string }>(
      'SELECT dim, version FROM embedding_models WHERE model_id = ?',
      ref.model,
    );
    if (existing === null) {
      this.run(
        'INSERT INTO embedding_models(model_id, provider, dim, version, config_json, created_at) VALUES (?, ?, ?, ?, ?, ?)',
        ref.model,
        this.provider,
        ref.dim,
        ref.version,
        '{}',
        this.clock(),
      );
      return;
    }
    if (existing.dim !== ref.dim || existing.version !== ref.version) {
      throw new Error(
        `[dsh-life-memory] store: embedding model "${ref.model}" is registered as ` +
          `dim=${existing.dim}/version=${existing.version}, but config says dim=${ref.dim}/version=${ref.version}; ` +
          'a (model, dim, version) triple identifies one vector space and must not be mixed',
      );
    }
  }

  // -------------------------------------------------------------------------
  // raw_index / raw_fts / raw_segments（L0 只读镜像，append-only）
  // -------------------------------------------------------------------------

  indexRawRecord(item: RawAppendItem): void {
    this.indexRawRecords([item]);
  }

  /**
   * 把原始记录写入 raw 索引（docs/20 §7.1.1）：只 INSERT OR IGNORE；
   * 同一事务内同步 raw_fts（contentless，rowid=seq）与 raw_segments 清单。
   */
  indexRawRecords(items: RawAppendItem[]): void {
    this.assertOpen('indexRawRecords');
    if (!Array.isArray(items) || items.length === 0) return;
    this.transaction(() => {
      const now = this.clock();
      let maxSeq = 0;
      const daySeqs = new Map<string, number>();
      const segmentAgg = new Map<
        string,
        {
          day: string;
          writerId: string;
          firstSeq: number;
          lastSeq: number;
          headHash: string;
          tailHash: string;
          records: number;
          bytes: number;
          headLineNo: number;
          tailLineNo: number;
        }
      >();
      for (const item of items) {
        const record = item.record;
        const location = item.location;
        if (!Number.isSafeInteger(record.seq) || record.seq < 1) {
          throw new Error(`[dsh-life-memory] store: raw record ${String(record.id)} has invalid seq`);
        }
        const payloadJson = JSON.stringify(record.payload);
        const textSeg = textToTextSeg(record.text ?? '');
        const inserted = this.run(
          'INSERT OR IGNORE INTO raw_index(' +
            'id, seq, ts, iso, day, timezone, kind, session_id, workspace, persona_id, turn_id, step_id, role, ' +
            'text, text_seg, payload_json, hash, prev_hash, segment, line_no, byte_offset, byte_len, ' +
            'record_version, ingest_key, created_at' +
            ') VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
          record.id,
          record.seq,
          record.ts,
          record.iso,
          record.day,
          record.timezone,
          record.kind,
          record.sessionId,
          record.workspace ?? null,
          record.personaId ?? null,
          record.turnId ?? null,
          record.stepId ?? null,
          record.role ?? null,
          record.text ?? null,
          textSeg,
          payloadJson,
          record.hash,
          record.prevHash,
          location.segment,
          location.lineNo,
          location.byteOffset,
          location.byteLen,
          record.v,
          location.ingestKey,
          now,
        );
        if (inserted.changes > 0) {
          this.run('INSERT INTO raw_fts(rowid, seg) VALUES (?, ?)', record.seq, textSeg);
        }
        if (record.seq > maxSeq) maxSeq = record.seq;
        const idParts = parseRawId(record.id);
        if (idParts !== null) {
          const current = daySeqs.get(record.day) ?? 0;
          if (idParts.daySeq > current) daySeqs.set(record.day, idParts.daySeq);
        }
        // 段聚合（仅对本事务新插入的行计数，保证幂等）
        if (inserted.changes > 0) {
          const segment = location.segment;
          const match = /seg-w([0-9a-f]{6})-/.exec(segment);
          const writerId = match === null ? '' : `w${match[1]}`;
          let agg = segmentAgg.get(segment);
          if (agg === undefined) {
            agg = {
              day: record.day,
              writerId,
              firstSeq: record.seq,
              lastSeq: record.seq,
              headHash: record.hash,
              tailHash: record.hash,
              records: 0,
              bytes: 0,
              headLineNo: location.lineNo,
              tailLineNo: location.lineNo,
            };
            segmentAgg.set(segment, agg);
          }
          if (record.seq < agg.firstSeq) agg.firstSeq = record.seq;
          if (record.seq > agg.lastSeq) agg.lastSeq = record.seq;
          if (location.lineNo < agg.headLineNo) {
            agg.headLineNo = location.lineNo;
            agg.headHash = record.hash;
          }
          if (location.lineNo > agg.tailLineNo) {
            agg.tailLineNo = location.lineNo;
            agg.tailHash = record.hash;
          }
          agg.records += 1;
          agg.bytes += location.byteLen;
        }
      }
      // counters：raw.seq 与 day.<date>
      this.run(
        "UPDATE counters SET value = MAX(value, ?), updated_at = ? WHERE name = 'raw.seq'",
        maxSeq,
        now,
      );
      for (const [day, daySeq] of daySeqs) {
        this.run(
          'INSERT INTO counters(name, value, updated_at) VALUES (?, ?, ?) ' +
            'ON CONFLICT(name) DO UPDATE SET value = MAX(counters.value, excluded.value), updated_at = excluded.updated_at',
          `day.${day}`,
          daySeq,
          now,
        );
      }
      // raw_segments 清单镜像（manifest 的 DB 副本）
      for (const [segment, agg] of segmentAgg) {
        this.run(
          'INSERT INTO raw_segments(' +
            'segment, day, writer_id, first_seq, last_seq, records, bytes, head_hash, tail_hash, sealed, created_at, updated_at' +
            ') VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?) ' +
            'ON CONFLICT(segment) DO UPDATE SET ' +
            'first_seq = CASE WHEN raw_segments.first_seq IS NULL THEN excluded.first_seq ' +
            'ELSE MIN(raw_segments.first_seq, excluded.first_seq) END, ' +
            'last_seq = CASE WHEN raw_segments.last_seq IS NULL THEN excluded.last_seq ' +
            'ELSE MAX(raw_segments.last_seq, excluded.last_seq) END, ' +
            'records = raw_segments.records + excluded.records, ' +
            'bytes = raw_segments.bytes + excluded.bytes, ' +
            'head_hash = COALESCE(raw_segments.head_hash, excluded.head_hash), ' +
            'tail_hash = CASE WHEN excluded.last_seq >= COALESCE(raw_segments.last_seq, -1) ' +
            'THEN excluded.tail_hash ELSE raw_segments.tail_hash END, ' +
            'updated_at = excluded.updated_at',
          segment,
          agg.day,
          agg.writerId,
          agg.firstSeq,
          agg.lastSeq,
          agg.records,
          agg.bytes,
          agg.headHash,
          agg.tailHash,
          now,
          now,
        );
      }
    });
  }

  hasRawIngestKey(ingestKey: string): boolean {
    this.assertOpen('hasRawIngestKey');
    if (typeof ingestKey !== 'string' || ingestKey.length === 0) return false;
    const row = this.getRow<{ one: number }>(
      'SELECT 1 AS one FROM raw_index WHERE ingest_key = ? LIMIT 1',
      ingestKey,
    );
    return row !== null;
  }

  listRawIndex(query: RawQuery = {}): { records: RawIndexRow[]; total: number } {
    this.assertOpen('listRawIndex');
    const { where, params } = this.buildRawWhere(query);
    const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
    const totalRow = this.getRow<{ total: number }>(
      `SELECT COUNT(*) AS total FROM raw_index ${whereSql}`,
      ...params,
    );
    const total = Number(totalRow?.total ?? 0);
    const order = query.desc === true ? 'DESC' : 'ASC';
    let sql = `SELECT * FROM raw_index ${whereSql} ORDER BY seq ${order}`;
    const listParams = [...params];
    if (typeof query.limit === 'number' && Number.isFinite(query.limit) && query.limit >= 0) {
      sql += ' LIMIT ?';
      listParams.push(Math.floor(query.limit));
      if (typeof query.offset === 'number' && Number.isFinite(query.offset) && query.offset > 0) {
        sql += ' OFFSET ?';
        listParams.push(Math.floor(query.offset));
      }
    } else if (typeof query.offset === 'number' && Number.isFinite(query.offset) && query.offset > 0) {
      sql += ' LIMIT -1 OFFSET ?';
      listParams.push(Math.floor(query.offset));
    }
    const rows = this.allRows<RawIndexDbRow>(sql, ...listParams);
    const records = rows.map((row) => mapRawIndexRow(row, false));
    return { records, total };
  }

  getRawIndex(id: string): RawIndexRow | null {
    this.assertOpen('getRawIndex');
    if (typeof id !== 'string' || id.length === 0) return null;
    const row = this.getRow<RawIndexDbRow>('SELECT * FROM raw_index WHERE id = ?', id);
    return row === null ? null : mapRawIndexRow(row, true);
  }

  private buildRawWhere(query: RawQuery): { where: string[]; params: unknown[] } {
    const where: string[] = [];
    const params: unknown[] = [];
    if (Array.isArray(query.ids) && query.ids.length > 0) {
      const ids = query.ids.filter((id) => typeof id === 'string' && id.length > 0);
      if (ids.length > 0) {
        where.push(`id IN (${ids.map(() => '?').join(', ')})`);
        params.push(...ids);
      }
    }
    if (typeof query.from === 'number' && Number.isFinite(query.from)) {
      where.push('ts >= ?');
      params.push(query.from);
    }
    if (typeof query.to === 'number' && Number.isFinite(query.to)) {
      where.push('ts <= ?');
      params.push(query.to);
    }
    if (typeof query.day === 'string' && query.day.length > 0) {
      where.push('day = ?');
      params.push(query.day);
    }
    if (typeof query.sessionId === 'string' && query.sessionId.length > 0) {
      where.push('session_id = ?');
      params.push(query.sessionId);
    }
    if (typeof query.workspace === 'string' && query.workspace.length > 0) {
      where.push('workspace = ?');
      params.push(query.workspace);
    }
    // docs/25-persona §4：raw_index.persona_id 过滤（null = 共享；不传 = 不过滤）
    if (query.personaId !== undefined) {
      if (query.personaId === null) {
        where.push('persona_id IS NULL');
      } else {
        where.push('persona_id = ?');
        params.push(query.personaId);
      }
    }
    if (Array.isArray(query.kinds) && query.kinds.length > 0) {
      const kinds = query.kinds.filter((kind) => typeof kind === 'string');
      if (kinds.length > 0) {
        where.push(`kind IN (${kinds.map(() => '?').join(', ')})`);
        params.push(...kinds);
      }
    }
    return { where, params };
  }

  // -------------------------------------------------------------------------
  // 派生记忆写入（upsertMemory 及辅助）
  // -------------------------------------------------------------------------

  upsertMemory(record: NewMemoryRecord, embedding?: Float32Array): MemoryRecord {
    this.assertOpen('upsertMemory');
    return this.transaction(() => {
      const now = this.clock();
      const validated = this.validateNewMemory(record, now);
      const existing = this.getRow<MemoryRow>('SELECT * FROM memory_records WHERE id = ?', validated.id);
      if (existing !== null) {
        if (existing.layer !== validated.layer || existing.kind !== validated.kind) {
          throw new Error(
            `[dsh-life-memory] store.upsertMemory: id ${validated.id} belongs to ` +
              `${existing.layer}/${existing.kind}, cannot change to ${validated.layer}/${validated.kind}`,
          );
        }
        const addedSources = this.linkSources(validated.id, validated.sourceRawIds, now);
        const pinnedChanged =
          validated.pinned !== undefined && validated.pinned !== (existing.pinned === 1);
        const personaChanged =
          validated.personaId !== undefined &&
          (validated.personaId ?? null) !== (existing.persona_id ?? null);
        if (!memoryRowChanged(existing, validated)) {
          // 纯幂等路径：内容一致；仅当有新溯源时按 §8.4-1 "重述" 处理（revision++ + 快照）
          if (addedSources > 0) {
            this.snapshotRevision(existing, 'restate', now);
            this.updateGovernanceAfterRestate(existing.id, existing, now);
          }
          // pinned / persona 都是治理列：不写 memory_revisions、不 bump revision
          if (pinnedChanged) this.applyPinnedGovernance(existing.id, validated.pinned === true, now);
          if (personaChanged) this.applyPersonaGovernance(existing.id, validated.personaId ?? null);
          return this.getMemoryOrThrow(validated.id);
        }
        const changeKind = validated.supersedes.length > 0 ? 'supersede' : 'update';
        this.snapshotRevision(existing, changeKind, now);
        this.updateMemoryRow(existing, validated, now);
        if (pinnedChanged) this.applyPinnedGovernance(validated.id, validated.pinned === true, now);
        this.applySupersedeLinks(validated.id, validated.supersedes, validated.validFrom, now);
        if (embedding !== undefined) this.applyEmbedding(validated.id, embedding);
        return this.getMemoryOrThrow(validated.id);
      }
      const duplicate = this.findActiveDuplicate(validated.layer, validated.contentHash);
      if (duplicate !== null) {
        // docs §8.4-1：同层同内容命中活跃行 => 不新增行，做"重述"（加来源/revision++/heat 更新）
        const addedSources = this.linkSources(duplicate.id, validated.sourceRawIds, now);
        if (addedSources > 0) {
          this.snapshotRevision(duplicate, 'restate', now);
          this.updateGovernanceAfterRestate(duplicate.id, duplicate, now);
        }
        return this.getMemoryOrThrow(duplicate.id);
      }
      this.insertMemoryRow(validated, now);
      this.linkSources(validated.id, validated.sourceRawIds, now);
      this.applySupersedeLinks(validated.id, validated.supersedes, validated.validFrom, now);
      if (embedding !== undefined) this.applyEmbedding(validated.id, embedding);
      return this.getMemoryOrThrow(validated.id);
    });
  }

  private validateNewMemory(record: NewMemoryRecord, now: number): ValidatedMemory {
    if (typeof record !== 'object' || record === null) {
      throw new TypeError('[dsh-life-memory] store.upsertMemory: record must be an object');
    }
    if (typeof record.layer !== 'string' || record.layer.length === 0) {
      throw new TypeError('[dsh-life-memory] store.upsertMemory: layer must be a non-empty string');
    }
    if (typeof record.kind !== 'string' || !MEMORY_KINDS.has(record.kind)) {
      throw new TypeError(
        `[dsh-life-memory] store.upsertMemory: invalid kind ${String(record.kind)}`,
      );
    }
    const layerRow = this.getRow<{ enabled: number; rebuildable: number }>(
      'SELECT enabled, rebuildable FROM layers WHERE id = ?',
      record.layer,
    );
    if (layerRow === null) {
      throw new Error(
        `[dsh-life-memory] store.upsertMemory: layer "${record.layer}" is not registered in layers table`,
      );
    }
    if (layerRow.enabled !== 1) {
      throw new Error(`[dsh-life-memory] store.upsertMemory: layer "${record.layer}" is disabled`);
    }
    if (typeof record.text !== 'string' || record.text.length === 0) {
      throw new TypeError('[dsh-life-memory] store.upsertMemory: text must be a non-empty string');
    }
    if (Buffer.byteLength(record.text, 'utf8') > MEMORY_TEXT_MAX_BYTES) {
      throw new RangeError(
        `[dsh-life-memory] store.upsertMemory: text exceeds ${MEMORY_TEXT_MAX_BYTES} bytes; ` +
          'truncate and set meta.truncated=true (docs/20 §8.1)',
      );
    }
    if (CONTROL_CHARS_RE.test(record.text)) {
      throw new Error('[dsh-life-memory] store.upsertMemory: text contains control characters');
    }
    if (record.summary !== undefined && record.summary !== null) {
      if (typeof record.summary !== 'string') {
        throw new TypeError('[dsh-life-memory] store.upsertMemory: summary must be string or null');
      }
      if (CONTROL_CHARS_RE.test(record.summary)) {
        throw new Error('[dsh-life-memory] store.upsertMemory: summary contains control characters');
      }
    }
    const sourceRawIds = record.sourceRawIds;
    if (!Array.isArray(sourceRawIds)) {
      throw new TypeError('[dsh-life-memory] store.upsertMemory: sourceRawIds must be an array');
    }
    const meta = record.meta ?? {};
    if (typeof meta !== 'object' || meta === null || Array.isArray(meta)) {
      throw new TypeError('[dsh-life-memory] store.upsertMemory: meta must be an object');
    }
    const cleanedSources: string[] = [];
    for (const rawId of sourceRawIds) {
      if (typeof rawId !== 'string' || rawId.length === 0) {
        throw new TypeError('[dsh-life-memory] store.upsertMemory: sourceRawIds must be non-empty strings');
      }
      cleanedSources.push(rawId);
    }
    if (cleanedSources.length === 0 && meta.sourcePolicy !== 'constructed') {
      throw new Error(
        '[dsh-life-memory] store.upsertMemory: sourceRawIds must contain at least 1 id ' +
          '(or meta.sourcePolicy="constructed" for pure profiles, docs/20 §8.1)',
      );
    }
    if (this.strictProvenance) {
      const missing: string[] = [];
      for (const rawId of cleanedSources) {
        const exists = this.getRow<{ one: number }>(
          'SELECT 1 AS one FROM raw_index WHERE id = ? LIMIT 1',
          rawId,
        );
        if (exists === null) missing.push(rawId);
      }
      if (missing.length > 0) {
        throw new Error(
          `[dsh-life-memory] store.upsertMemory: sourceRawIds not found in raw_index: ${missing.join(', ')}`,
        );
      }
    }
    const tags = record.tags ?? [];
    if (!Array.isArray(tags) || tags.some((tag) => typeof tag !== 'string')) {
      throw new TypeError('[dsh-life-memory] store.upsertMemory: tags must be a string array');
    }
    const status = record.status ?? 'active';
    if (!MEMORY_STATUSES.has(status)) {
      throw new TypeError(`[dsh-life-memory] store.upsertMemory: invalid status ${String(status)}`);
    }
    if (record.pinned !== undefined && typeof record.pinned !== 'boolean') {
      throw new TypeError('[dsh-life-memory] store.upsertMemory: pinned must be boolean');
    }
    let personaId: string | null | undefined;
    if (record.personaId !== undefined) {
      if (record.personaId !== null && typeof record.personaId !== 'string') {
        throw new TypeError('[dsh-life-memory] store.upsertMemory: personaId must be a string or null');
      }
      const trimmed = typeof record.personaId === 'string' ? record.personaId.trim() : '';
      if (trimmed.length > 128) {
        throw new RangeError('[dsh-life-memory] store.upsertMemory: personaId exceeds 128 chars');
      }
      personaId = trimmed.length === 0 ? null : trimmed;
    }
    const importance = clamp01(record.importance ?? 0.5);
    const confidence = clamp01(record.confidence ?? 0.5);
    const sessionId = normalizeOptionalString(record.sessionId, 'sessionId');
    const workspace = normalizeOptionalString(record.workspace, 'workspace');
    let validFrom = toOptionalTimestamp(record.validFrom, 'validFrom');
    const validTo = toOptionalTimestamp(record.validTo, 'validTo');
    if (validFrom !== null && validTo !== null && validFrom > validTo) {
      throw new RangeError('[dsh-life-memory] store.upsertMemory: validFrom must be <= validTo');
    }
    const createdAt =
      typeof record.createdAt === 'number' && Number.isFinite(record.createdAt)
        ? Math.floor(record.createdAt)
        : now;
    if (validFrom === null) validFrom = null;
    const supersedes = Array.isArray(record.supersedes)
      ? record.supersedes.filter((id): id is string => typeof id === 'string' && id.length > 0)
      : [];
    const createdSeq =
      typeof record.createdSeq === 'number' && Number.isSafeInteger(record.createdSeq) && record.createdSeq >= 0
        ? record.createdSeq
        : 0;
    const contentHashValue = computeContentHash(record.layer, record.kind, record.text);
    let id: string;
    if (typeof record.id === 'string' && record.id.length > 0) {
      if (!isMemoryId(record.id)) {
        throw new RangeError(
          `[dsh-life-memory] store.upsertMemory: explicit id "${record.id}" does not match ` +
            'docs/20 §8.1 id format',
        );
      }
      id = record.id;
    } else {
      id = deriveMemoryId(record.layer, record.kind, createdAt, contentHashValue);
    }
    const metaJson = stringifyJsonObject(meta);
    return {
      id,
      layer: record.layer,
      kind: record.kind,
      text: record.text,
      textSeg: textToTextSeg(record.text),
      summary: record.summary ?? null,
      importance,
      confidence,
      sourceRawIds: cleanedSources,
      sessionId,
      workspace,
      tags: [...tags],
      createdAt,
      validFrom,
      validTo,
      supersedes,
      status,
      pinned: record.pinned,
      personaId,
      createdSeq,
      meta,
      metaJson,
      contentHash: contentHashValue,
    };
  }

  private findActiveDuplicate(layer: string, contentHashValue: string): MemoryRow | null {
    return this.getRow<MemoryRow>(
      "SELECT * FROM memory_records WHERE layer = ? AND content_hash = ? AND status = 'active' LIMIT 1",
      layer,
      contentHashValue,
    );
  }

  private insertMemoryRow(validated: ValidatedMemory, now: number): void {
    // docs/23-memory-models §3.2：新记忆默认 retention tier = short；pinned 只是治理标记，
    // 归入 long 由 RetentionEngine 调用 setRetention 完成（store 只存标记 + 层）。
    const pinned = validated.pinned === true;
    const retentionTier: RetentionTier = 'short';
    this.run(
      'INSERT INTO memory_records(' +
        'id, layer, kind, text, text_seg, summary, importance, confidence, session_id, workspace, ' +
        'tags_json, created_at, updated_at, valid_from, valid_to, supersedes_json, revision, ' +
        'content_hash, status, heat, access_count, last_access_at, created_seq, meta_json, ' +
        'retention_tier, retention_score, pinned, promoted_at, long_term_at, persona_id' +
        ') VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, 0, NULL, ?, ?, ?, 0, ?, ?, NULL, ?)',
      validated.id,
      validated.layer,
      validated.kind,
      validated.text,
      validated.textSeg,
      validated.summary,
      validated.importance,
      validated.confidence,
      validated.sessionId,
      validated.workspace,
      stringifyJsonArray(validated.tags),
      validated.createdAt,
      now,
      validated.validFrom,
      validated.validTo,
      stringifyJsonArray(validated.supersedes),
      validated.contentHash,
      validated.status,
      computeHeat({
        layer: validated.layer,
        importance: validated.importance,
        lastAccessAt: null,
        updatedAt: now,
        accessCount: 0,
        sourceCount: validated.sourceRawIds.length,
        now,
      }),
      validated.createdSeq,
      validated.metaJson,
      retentionTier,
      pinned ? 1 : 0,
      null,
      validated.personaId ?? null,
    );
  }

  /**
   * 更新 pinned 治理列（不写 memory_revisions、不 bump revision；docs/23-memory-models §3.2）：
   * pinned 只是治理标记；归入 long 由 RetentionEngine 调 setRetention 完成，store 不改 tier。
   */
  private applyPinnedGovernance(memoryId: string, pinned: boolean, now: number): void {
    void now;
    this.run('UPDATE memory_records SET pinned = ? WHERE id = ?', pinned ? 1 : 0, memoryId);
  }

  private updateMemoryRow(existing: MemoryRow, validated: ValidatedMemory, now: number): void {
    this.run(
      'UPDATE memory_records SET text = ?, text_seg = ?, summary = ?, importance = ?, confidence = ?, ' +
        'session_id = ?, workspace = ?, tags_json = ?, valid_from = ?, valid_to = ?, supersedes_json = ?, ' +
        'content_hash = ?, revision = ?, updated_at = ?, status = ?, created_seq = ?, meta_json = ?, ' +
'persona_id = ? WHERE id = ?',
      validated.text,
      validated.textSeg,
      validated.summary,
      validated.importance,
      validated.confidence,
      validated.sessionId,
      validated.workspace,
      stringifyJsonArray(validated.tags),
      validated.validFrom,
      validated.validTo,
      stringifyJsonArray(validated.supersedes),
      validated.contentHash,
      existing.revision + 1,
      now,
      validated.status,
      validated.createdSeq > 0 ? validated.createdSeq : existing.created_seq,
      validated.metaJson,
      validated.personaId !== undefined ? validated.personaId : existing.persona_id,
      existing.id,
    );
  }

  /**
   * 更新 persona_id 治理列（docs/25-persona §7）：
   * 不写 memory_revisions、不 bump revision、不改 updated_at（人格归属是作用域元数据）。
   */
  private applyPersonaGovernance(memoryId: string, personaId: string | null): void {
    this.run('UPDATE memory_records SET persona_id = ? WHERE id = ?', personaId, memoryId);
  }

  /** 写旧版本快照到 memory_revisions（append-only，docs §8.4 revision 语义） */
  private snapshotRevision(row: MemoryRow, changeKind: string, now: number): void {
    this.run(
      'INSERT OR IGNORE INTO memory_revisions(' +
        'memory_id, revision, text, summary, importance, confidence, valid_from, valid_to, status, ' +
        'content_hash, change_kind, changed_at, meta_json' +
        ') VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      row.id,
      row.revision,
      row.text,
      row.summary,
      row.importance,
      row.confidence,
      row.valid_from,
      row.valid_to,
      row.status,
      row.content_hash,
      changeKind,
      now,
      row.meta_json,
    );
  }

  /** 重述后更新治理列（revision++ / updated_at / heat 重算；不动内容） */
  private updateGovernanceAfterRestate(memoryId: string, row: MemoryRow, now: number): void {
    const sourceCount = this.countSources(memoryId);
    const heat = computeHeat({
      layer: row.layer,
      importance: row.importance,
      lastAccessAt: row.last_access_at,
      updatedAt: now,
      accessCount: row.access_count,
      sourceCount,
      now,
    });
    this.run(
      'UPDATE memory_records SET revision = revision + 1, updated_at = ?, heat = ? WHERE id = ?',
      now,
      heat,
      memoryId,
    );
  }

  /** 建立溯源链接；返回新插入的条数（幂等 INSERT OR IGNORE） */
  private linkSources(memoryId: string, rawIds: readonly string[], now: number): number {
    let inserted = 0;
    for (const rawId of rawIds) {
      const result = this.run(
        'INSERT OR IGNORE INTO memory_sources(memory_id, raw_id, relation, weight, created_at) ' +
          "VALUES (?, ?, 'derived_from', 1.0, ?)",
        memoryId,
        rawId,
        now,
      );
      inserted += result.changes;
    }
    return inserted;
  }

  /**
   * 处理新记录取代旧记录（docs §8.4-2）：旧行 valid_to = new.validFrom-1（或 now-1）、
   * superseded_by = 新 id，并写 supersede 快照；旧行不删除。
   */
  private applySupersedeLinks(
    newId: string,
    supersedes: readonly string[],
    newValidFrom: number | null,
    now: number,
  ): void {
    for (const oldId of supersedes) {
      if (oldId === newId) continue;
      const old = this.getRow<MemoryRow>('SELECT * FROM memory_records WHERE id = ?', oldId);
      if (old === null) {
        this.log.warn(`[store] supersede target ${oldId} not found (ignored)`);
        continue;
      }
      if (old.superseded_by === newId && old.valid_to !== null) continue; // 已处理
      this.snapshotRevision(old, 'supersede', now);
      const validTo = newValidFrom !== null ? Math.max(0, newValidFrom - 1) : now - 1;
      this.run(
        'UPDATE memory_records SET valid_to = COALESCE(valid_to, ?), superseded_by = ?, updated_at = ?, ' +
          'revision = revision + 1 WHERE id = ?',
        validTo,
        newId,
        now,
        oldId,
      );
    }
  }

  private applyEmbedding(memoryId: string, vec: Float32Array): void {
    const ref = this.defaultEmbedding;
    this.ensureEmbeddingModel(ref);
    this.putVectorInternal('memory', memoryId, ref, vec);
  }

  private getMemoryOrThrow(id: string): MemoryRecord {
    const memory = this.getMemory(id);
    if (memory === null) {
      throw new Error(`[dsh-life-memory] store: memory ${id} disappeared during write (internal error)`);
    }
    return memory;
  }

  private countSources(memoryId: string): number {
    const row = this.getRow<{ total: number }>(
      'SELECT COUNT(*) AS total FROM memory_sources WHERE memory_id = ?',
      memoryId,
    );
    return Number(row?.total ?? 0);
  }

  // -------------------------------------------------------------------------
  // 派生记忆读取
  // -------------------------------------------------------------------------

  getMemory(id: string): MemoryRecord | null {
    this.assertOpen('getMemory');
    if (typeof id !== 'string' || id.length === 0) return null;
    const row = this.getRow<MemoryRow>('SELECT * FROM memory_records WHERE id = ?', id);
    if (row === null) return null;
    const sources = this.loadSources([id]).get(id) ?? [];
    return mapMemoryRow(row, sources);
  }

  listMemories(query: MemoryQuery = {}): MemoryRecord[] {
    this.assertOpen('listMemories');
    const where: string[] = [];
    const params: unknown[] = [];
    if (Array.isArray(query.layers) && query.layers.length > 0) {
      where.push(`layer IN (${query.layers.map(() => '?').join(', ')})`);
      params.push(...query.layers);
    }
    if (Array.isArray(query.kinds) && query.kinds.length > 0) {
      where.push(`kind IN (${query.kinds.map(() => '?').join(', ')})`);
      params.push(...query.kinds);
    }
    if (typeof query.sessionId === 'string' && query.sessionId.length > 0) {
      where.push('session_id = ?');
      params.push(query.sessionId);
    }
    if (typeof query.workspace === 'string' && query.workspace.length > 0) {
      where.push('workspace = ?');
      params.push(query.workspace);
    }
    if (Array.isArray(query.ids) && query.ids.length > 0) {
      const ids = query.ids.filter((id) => typeof id === 'string' && id.length > 0);
      if (ids.length > 0) {
        where.push(`id IN (${ids.map(() => '?').join(', ')})`);
        params.push(...ids);
      }
    }
    if (Array.isArray(query.status) && query.status.length > 0) {
      where.push(`status IN (${query.status.map(() => '?').join(', ')})`);
      params.push(...query.status);
    }
    // docs/25-persona §4：人格作用域（不传 = 不过滤；null = 仅共享；string = 人格 + 默认含共享）
    if (query.personaId !== undefined) {
      if (query.personaId === null) {
        where.push('persona_id IS NULL');
      } else if (query.includeSharedPersona === false) {
        where.push('persona_id = ?');
        params.push(query.personaId);
      } else {
        where.push('(persona_id = ? OR persona_id IS NULL)');
        params.push(query.personaId);
      }
    }
    if (Array.isArray(query.retentionTiers) && query.retentionTiers.length > 0) {
      const tiers = query.retentionTiers.filter((tier) => RETENTION_TIERS.has(tier));
      if (tiers.length > 0) {
        where.push('retention_tier IN (' + tiers.map(() => '?').join(', ') + ')');
        params.push(...tiers);
      }
    }
    if (typeof query.pinned === 'boolean') {
      where.push('pinned = ?');
      params.push(query.pinned ? 1 : 0);
    }
    if (query.onlyValid === true) {
      where.push('(valid_to IS NULL OR valid_to > ?)');
      params.push(this.clock());
    }
    if (Array.isArray(query.tags) && query.tags.length > 0) {
      where.push(
        `EXISTS (SELECT 1 FROM json_each(memory_records.tags_json) WHERE value IN (${query.tags
          .map(() => '?')
          .join(', ')}))`,
      );
      params.push(...query.tags);
    }
    if (typeof query.from === 'number' && Number.isFinite(query.from)) {
      where.push('created_at >= ?');
      params.push(query.from);
    }
    if (typeof query.to === 'number' && Number.isFinite(query.to)) {
      where.push('created_at <= ?');
      params.push(query.to);
    }
    const whereSql = where.length > 0 ? ` WHERE ${where.join(' AND ')}` : '';
    const order = query.desc === false ? 'ASC' : 'DESC';
    let sql = `SELECT * FROM memory_records${whereSql} ORDER BY updated_at ${order}`;
    const listParams = [...params];
    if (typeof query.limit === 'number' && Number.isFinite(query.limit) && query.limit >= 0) {
      sql += ' LIMIT ?';
      listParams.push(Math.floor(query.limit));
      if (typeof query.offset === 'number' && Number.isFinite(query.offset) && query.offset > 0) {
        sql += ' OFFSET ?';
        listParams.push(Math.floor(query.offset));
      }
    } else if (typeof query.offset === 'number' && Number.isFinite(query.offset) && query.offset > 0) {
      sql += ' LIMIT -1 OFFSET ?';
      listParams.push(Math.floor(query.offset));
    }
    const rows = this.allRows<MemoryRow>(sql, ...listParams);
    const sources = this.loadSources(rows.map((row) => row.id));
    return rows.map((row) => mapMemoryRow(row, sources.get(row.id) ?? []));
  }

  private loadSources(memoryIds: readonly string[]): Map<string, string[]> {
    const result = new Map<string, string[]>();
    if (memoryIds.length === 0) return result;
    for (const id of memoryIds) result.set(id, []);
    const chunkSize = 500;
    for (let offset = 0; offset < memoryIds.length; offset += chunkSize) {
      const chunk = memoryIds.slice(offset, offset + chunkSize);
      const rows = this.allRows<{ memory_id: string; raw_id: string }>(
        `SELECT memory_id, raw_id FROM memory_sources WHERE memory_id IN (${chunk
          .map(() => '?')
          .join(', ')}) ORDER BY memory_id, rowid`,
        ...chunk,
      );
      for (const row of rows) {
        result.get(row.memory_id)?.push(row.raw_id);
      }
    }
    return result;
  }

  countByLayer(): Record<string, number> {
    this.assertOpen('countByLayer');
    const rows = this.allRows<{ layer: string; total: number }>(
      'SELECT layer, COUNT(*) AS total FROM memory_records GROUP BY layer ORDER BY layer',
    );
    const out: Record<string, number> = {};
    for (const row of rows) out[row.layer] = Number(row.total);
    return out;
  }

  layerStats(): LayerStatsRow[] {
    this.assertOpen('layerStats');
    const rows = this.allRows<{
      layer: string;
      name: string;
      total: number;
      latest_updated_at: number | null;
    }>('SELECT layer, name, total, latest_updated_at FROM v_layer_stats ORDER BY layer');
    return rows.map((row) => ({
      layer: row.layer,
      name: row.name,
      count: Number(row.total ?? 0),
      latestUpdatedAt: row.latest_updated_at ?? null,
    }));
  }

  listLayers(): LayerRegistryRow[] {
    this.assertOpen('listLayers');
    const rows = this.allRows<{
      id: string;
      name: string;
      version: number;
      depends_on_json: string;
      kind: string;
      enabled: number;
      rebuildable: number;
      total: number | null;
      active: number | null;
      archived: number | null;
      latest_updated_at: number | null;
    }>(
      'SELECT l.id, l.name, l.version, l.depends_on_json, l.kind, l.enabled, l.rebuildable, ' +
        'COALESCE(s.total, 0) AS total, COALESCE(s.active, 0) AS active, ' +
        'COALESCE(s.archived, 0) AS archived, s.latest_updated_at ' +
        'FROM layers l LEFT JOIN v_layer_stats s ON s.layer = l.id ORDER BY l.id',
    );
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      version: Number(row.version),
      dependsOn: parseJsonArray<string>(row.depends_on_json),
      kind: row.kind === 'extension' ? 'extension' : 'builtin',
      enabled: row.enabled === 1,
      rebuildable: row.rebuildable === 1,
      count: Number(row.total ?? 0),
      active: Number(row.active ?? 0),
      archived: Number(row.archived ?? 0),
      latestUpdatedAt: row.latest_updated_at ?? null,
    }));
  }

  listSources(memoryId: string): SourceLinkRow[] {
    this.assertOpen('listSources');
    const rows = this.allRows<{ raw_id: string; relation: string; weight: number }>(
      'SELECT raw_id, relation, weight FROM memory_sources WHERE memory_id = ? ORDER BY relation, raw_id',
      memoryId,
    );
    return rows.map((row) => ({ rawId: row.raw_id, relation: row.relation, weight: Number(row.weight) }));
  }

  listRevisions(memoryId: string): MemoryRevisionRow[] {
    this.assertOpen('listRevisions');
    const rows = this.allRows<{
      memory_id: string;
      revision: number;
      text: string;
      summary: string | null;
      importance: number;
      confidence: number;
      valid_from: number | null;
      valid_to: number | null;
      status: string;
      change_kind: string;
      changed_at: number;
    }>(
      'SELECT memory_id, revision, text, summary, importance, confidence, valid_from, valid_to, status, ' +
        'change_kind, changed_at FROM memory_revisions WHERE memory_id = ? ORDER BY revision DESC',
      memoryId,
    );
    return rows.map((row) => ({
      memoryId: row.memory_id,
      revision: Number(row.revision),
      text: row.text,
      summary: row.summary,
      importance: Number(row.importance),
      confidence: Number(row.confidence),
      validFrom: row.valid_from,
      validTo: row.valid_to,
      status: row.status,
      changeKind: row.change_kind,
      changedAt: Number(row.changed_at),
    }));
  }

  // -------------------------------------------------------------------------
  // 层私有表 / 水位 / 治理
  // -------------------------------------------------------------------------

  putL2Episode(row: L2EpisodeRow): void {
    this.assertOpen('putL2Episode');
    if (typeof row.memoryId !== 'string' || row.memoryId.length === 0) {
      throw new TypeError('[dsh-life-memory] store.putL2Episode: memoryId is required');
    }
    this.run(
      'INSERT INTO layer_l2_episodes(' +
        'memory_id, session_id, topic, start_ts, end_ts, turn_count, raw_first_id, raw_last_id, ' +
        'page_ids_json, heat, promoted_at' +
        ') VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ' +
        'ON CONFLICT(memory_id) DO UPDATE SET session_id = excluded.session_id, topic = excluded.topic, ' +
        'start_ts = excluded.start_ts, end_ts = excluded.end_ts, turn_count = excluded.turn_count, ' +
        'raw_first_id = excluded.raw_first_id, raw_last_id = excluded.raw_last_id, ' +
        'page_ids_json = excluded.page_ids_json, heat = excluded.heat, promoted_at = excluded.promoted_at',
      row.memoryId,
      row.sessionId ?? null,
      row.topic ?? null,
      Math.floor(row.startTs),
      Math.floor(row.endTs),
      Number.isFinite(row.turnCount) ? Math.max(0, Math.floor(row.turnCount as number)) : 0,
      row.rawFirstId ?? null,
      row.rawLastId ?? null,
      stringifyJsonArray(row.pageIds),
      clamp01(row.heat ?? 0),
      row.promotedAt ?? null,
    );
  }

  putL3Semantic(row: L3SemanticRow): void {
    this.assertOpen('putL3Semantic');
    if (typeof row.memoryId !== 'string' || row.memoryId.length === 0) {
      throw new TypeError('[dsh-life-memory] store.putL3Semantic: memoryId is required');
    }
    try {
      this.run(
        'INSERT INTO layer_l3_semantic(' +
          'memory_id, category, subject, predicate, object, canonical_key, valid_from, valid_to, ' +
          'superseded_by, source_kind, extracted_by' +
          ') VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ' +
          'ON CONFLICT(memory_id) DO UPDATE SET category = excluded.category, subject = excluded.subject, ' +
          'predicate = excluded.predicate, object = excluded.object, canonical_key = excluded.canonical_key, ' +
          'valid_from = excluded.valid_from, valid_to = excluded.valid_to, ' +
          'superseded_by = excluded.superseded_by, source_kind = excluded.source_kind, ' +
          'extracted_by = excluded.extracted_by',
        row.memoryId,
        row.category,
        row.subject ?? null,
        row.predicate ?? null,
        row.object ?? null,
        row.canonicalKey ?? null,
        row.validFrom ?? null,
        row.validTo ?? null,
        row.supersededBy ?? null,
        row.sourceKind ?? 'deterministic',
        row.extractedBy ?? null,
      );
    } catch (error) {
      throw new Error(
        `[dsh-life-memory] store.putL3Semantic: failed to write ${row.memoryId} ` +
          `(canonicalKey=${String(row.canonicalKey)}): ${(error as Error).message}`,
      );
    }
  }

  getL3Semantic(memoryId: string): L3SemanticRow | null {
    this.assertOpen('getL3Semantic');
    const row = this.getRow<{
      memory_id: string;
      category: string;
      subject: string | null;
      predicate: string | null;
      object: string | null;
      canonical_key: string | null;
      valid_from: number | null;
      valid_to: number | null;
      superseded_by: string | null;
      source_kind: string;
      extracted_by: string | null;
    }>('SELECT * FROM layer_l3_semantic WHERE memory_id = ?', memoryId);
    if (row === null) return null;
    return {
      memoryId: row.memory_id,
      category: row.category as L3SemanticRow['category'],
      subject: row.subject,
      predicate: row.predicate,
      object: row.object,
      canonicalKey: row.canonical_key,
      validFrom: row.valid_from,
      validTo: row.valid_to,
      supersededBy: row.superseded_by,
      sourceKind: row.source_kind as L3SemanticRow['sourceKind'],
      extractedBy: row.extracted_by,
    };
  }

  getDeriveCursor(layer: string): number {
    this.assertOpen('getDeriveCursor');
    const row = this.getRow<{ last_raw_seq: number }>(
      'SELECT last_raw_seq FROM derive_cursors WHERE layer = ?',
      layer,
    );
    return row === null ? 0 : Number(row.last_raw_seq);
  }

  setDeriveCursor(layer: string, lastRawSeq: number): void {
    this.assertOpen('setDeriveCursor');
    if (typeof layer !== 'string' || layer.length === 0) {
      throw new TypeError('[dsh-life-memory] store.setDeriveCursor: layer is required');
    }
    if (!Number.isSafeInteger(lastRawSeq) || lastRawSeq < 0) {
      throw new RangeError('[dsh-life-memory] store.setDeriveCursor: lastRawSeq must be a non-negative integer');
    }
    const current = this.getDeriveCursor(layer);
    if (lastRawSeq < current) {
      throw new Error(
        `[dsh-life-memory] store.setDeriveCursor: cursor must move forward ` +
          `(layer ${layer}: current ${current}, requested ${lastRawSeq}); ` +
          'use clearLayer() to reset a layer before rebuilding',
      );
    }
    this.run(
      'INSERT INTO derive_cursors(layer, last_raw_seq, updated_at) VALUES (?, ?, ?) ' +
        'ON CONFLICT(layer) DO UPDATE SET last_raw_seq = excluded.last_raw_seq, updated_at = excluded.updated_at',
      layer,
      lastRawSeq,
      this.clock(),
    );
  }

  touchMemories(ids: string[], now: number = this.clock()): void {
    this.assertOpen('touchMemories');
    if (!Array.isArray(ids) || ids.length === 0) return;
    const unique = [...new Set(ids.filter((id) => typeof id === 'string' && id.length > 0))];
    if (unique.length === 0) return;
    this.transaction(() => {
      const sourceCounts = this.countSourcesBatch(unique);
      for (const id of unique) {
        const row = this.getRow<MemoryRow>('SELECT * FROM memory_records WHERE id = ?', id);
        if (row === null) continue;
        const accessCount = row.access_count + 1;
        const heat = computeHeat({
          layer: row.layer,
          importance: row.importance,
          lastAccessAt: now,
          updatedAt: row.updated_at,
          accessCount,
          sourceCount: sourceCounts.get(id) ?? 0,
          now,
        });
        this.run(
          'UPDATE memory_records SET access_count = ?, last_access_at = ?, heat = ? WHERE id = ?',
          accessCount,
          now,
          heat,
          id,
        );
      }
    });
  }

  // -------------------------------------------------------------------------
  // 保留期分层（短期 short / 中期 mid / 长期 long，docs/23-memory-models）
  // -------------------------------------------------------------------------

  /**
   * 写入单条保留期状态（docs/23-memory-models §3.2/§6）：**只改治理列**
   * （retention_tier/retention_score/pinned/promoted_at/long_term_at），
   * 不动内容字段、不 bump revision、不改 updated_at（内容更新时间语义保持不变）。
   * **只升不降**：target tier 低于当前 tier 时忽略；晋升时维护 promoted_at / long_term_at。
   */
  setRetention(id: string, state: RetentionState, now: number = this.clock()): void {
    this.assertOpen('setRetention');
    if (typeof id !== 'string' || id.length === 0) {
      throw new TypeError('[dsh-life-memory] store.setRetention: id must be a non-empty string');
    }
    validateRetentionState(state, 'setRetention');
    this.transaction(() => {
      this.applyRetentionState(id, state, now);
    });
  }

  /** 批量写保留期状态（tick 用；单事务；不存在的 id 跳过；任一条非法则整体回滚） */
  setRetentionBatch(updates: Array<{ id: string } & RetentionState>, now: number = this.clock()): void {
    this.assertOpen('setRetentionBatch');
    if (!Array.isArray(updates) || updates.length === 0) return;
    this.transaction(() => {
      for (const update of updates) {
        if (typeof update !== 'object' || update === null) {
          throw new TypeError('[dsh-life-memory] store.setRetentionBatch: update must be an object');
        }
        if (typeof update.id !== 'string' || update.id.length === 0) {
          throw new TypeError('[dsh-life-memory] store.setRetentionBatch: each update needs a non-empty id');
        }
        validateRetentionState(update, 'setRetentionBatch');
        this.applyRetentionState(update.id, update, now);
      }
    });
  }

  /** 读取单条保留期状态；记录不存在返回 null */
  getRetention(id: string): RetentionState | null {
    this.assertOpen('getRetention');
    if (typeof id !== 'string' || id.length === 0) return null;
    const row = this.getRow<RetentionRow>(
      'SELECT retention_tier, retention_score, pinned, promoted_at, long_term_at ' +
        'FROM memory_records WHERE id = ?',
      id,
    );
    return row === null ? null : mapRetentionRow(row);
  }

  /** 保留期层统计（短期/中期/长期计数 + 钉住数 + 最近 tick 时间） */
  retentionStats(): RetentionStats {
    this.assertOpen('retentionStats');
    const rows = this.allRows<{ retention_tier: string; total: number }>(
      'SELECT retention_tier, COUNT(*) AS total FROM memory_records GROUP BY retention_tier',
    );
    const counts: Record<string, number> = {};
    for (const row of rows) counts[String(row.retention_tier)] = Number(row.total);
    const pinnedRow = this.getRow<{ total: number }>(
      'SELECT COUNT(*) AS total FROM memory_records WHERE pinned = 1',
    );
    const lastTickRaw = this.getRetentionMeta('retention.lastTickAt');
    const parsedLastTick = lastTickRaw === null ? Number.NaN : Number(lastTickRaw);
    return {
      short: counts.short ?? 0,
      mid: counts.mid ?? 0,
      long: counts.long ?? 0,
      pinned: Number(pinnedRow?.total ?? 0),
      lastTickAt: Number.isFinite(parsedLastTick) ? Math.floor(parsedLastTick) : null,
    };
  }

  /**
   * 按保留期层列出记忆（docs/23-memory-models §4/§6；UI 用）：retention_score DESC, updated_at DESC。
   * 只返回 status='active' 的记录（archived/pending 不进入保留期列表/引擎候选）。
   */
  listByRetention(tier: RetentionTier, options: { limit?: number; offset?: number } = {}): MemoryRecord[] {
    this.assertOpen('listByRetention');
    if (!RETENTION_TIERS.has(tier)) {
      throw new TypeError('[dsh-life-memory] store.listByRetention: invalid tier ' + String(tier));
    }
    const limit = normalizePageLimit(options.limit, 100, 1000);
    const offset = normalizePageOffset(options.offset);
    const rows = this.allRows<MemoryRow>(
      "SELECT * FROM memory_records WHERE retention_tier = ? AND status = 'active' " +
        'ORDER BY retention_score DESC, updated_at DESC LIMIT ? OFFSET ?',
      tier,
      limit,
      offset,
    );
    const sources = this.loadSources(rows.map((row) => row.id));
    return rows.map((row) => mapMemoryRow(row, sources.get(row.id) ?? []));
  }

  /**
   * 列出需要重算保留期状态的候选记录（docs/23-memory-models §6）：
   * 未到 long 的记录（short/mid）始终参与 + 最近 `since`（默认 now-30d）内更新过的 long；
   * 按 updated_at DESC 分页（引擎 tick 候选集）。
   */
  listRetentionCandidates(options: { since?: number; limit?: number; offset?: number } = {}): MemoryRecord[] {
    this.assertOpen('listRetentionCandidates');
    const since =
      typeof options.since === 'number' && Number.isFinite(options.since)
        ? Math.floor(options.since)
        : this.clock() - 30 * 86_400_000;
    const limit = normalizePageLimit(options.limit, 500, 5000);
    const offset = normalizePageOffset(options.offset);
    const rows = this.allRows<MemoryRow>(
      "SELECT * FROM memory_records WHERE status = 'active' AND " +
        "(retention_tier != 'long' OR updated_at >= ?) " +
        'ORDER BY updated_at DESC LIMIT ? OFFSET ?',
      since,
      limit,
      offset,
    );
    const sources = this.loadSources(rows.map((row) => row.id));
    return rows.map((row) => mapMemoryRow(row, sources.get(row.id) ?? []));
  }

  /** 读取保留期治理元数据（meta 表，key 如 'retention.lastTickAt'） */
  getRetentionMeta(key: string): string | null {
    this.assertOpen('getRetentionMeta');
    if (typeof key !== 'string' || key.length === 0) return null;
    return this.getMeta(key);
  }

  /** 写入保留期治理元数据（meta 表；不触发任何内容/版本变更） */
  setRetentionMeta(key: string, value: string, now: number = this.clock()): void {
    this.assertOpen('setRetentionMeta');
    if (typeof key !== 'string' || key.length === 0) {
      throw new TypeError('[dsh-life-memory] store.setRetentionMeta: key must be a non-empty string');
    }
    this.setMeta(key, value, now);
  }

  /**
   * 应用一条保留期状态（事务内用）：
   * - **只升不降**（docs/23-memory-models §3.2）：target tier 低于当前 tier 时整条忽略；
   * - 晋升时写 promotedAt（进入当前层时间）；晋升到 long 时写 longTermAt；
   * - 同层重复写入允许更新 score/pinned，但不覆盖已有时间戳（幂等 tick 不写库）。
   */
  private applyRetentionState(id: string, state: RetentionState, now: number): void {
    const row = this.getRow<RetentionRow>(
      'SELECT retention_tier, retention_score, pinned, promoted_at, long_term_at ' +
        'FROM memory_records WHERE id = ?',
      id,
    );
    if (row === null) {
      this.log.warn('[store] setRetention: memory ' + id + ' not found (ignored)');
      return;
    }
    const currentTier = row.retention_tier as RetentionTier;
    const targetTier = state.tier;
    const currentRank = RETENTION_TIER_RANK[currentTier] ?? 0;
    const targetRank = RETENTION_TIER_RANK[targetTier] ?? 0;
    if (targetRank < currentRank) {
      // 保留期只升不降：降级请求整条忽略（不修改 score/pinned/时间戳）
      return;
    }
    const promoted = targetRank > currentRank;
    let promotedAt = row.promoted_at;
    if (promoted) promotedAt = state.promotedAt ?? now;
    else if (state.promotedAt !== null && state.promotedAt !== undefined) promotedAt = state.promotedAt;
    let longTermAt = row.long_term_at;
    if (targetTier === 'long') {
      if (state.longTermAt !== null && state.longTermAt !== undefined) longTermAt = state.longTermAt;
      else if (longTermAt === null) longTermAt = now;
    }
    this.run(
      'UPDATE memory_records SET retention_tier = ?, retention_score = ?, pinned = ?, ' +
        'promoted_at = ?, long_term_at = ? WHERE id = ?',
      targetTier,
      clamp01(state.score),
      state.pinned === true ? 1 : 0,
      promotedAt,
      longTermAt,
      id,
    );
  }

  private countSourcesBatch(ids: readonly string[]): Map<string, number> {
    const result = new Map<string, number>();
    const chunkSize = 500;
    for (let offset = 0; offset < ids.length; offset += chunkSize) {
      const chunk = ids.slice(offset, offset + chunkSize);
      const rows = this.allRows<{ memory_id: string; total: number }>(
        `SELECT memory_id, COUNT(*) AS total FROM memory_sources WHERE memory_id IN (${chunk
          .map(() => '?')
          .join(', ')}) GROUP BY memory_id`,
        ...chunk,
      );
      for (const row of rows) result.set(row.memory_id, Number(row.total));
    }
    return result;
  }

  // -------------------------------------------------------------------------
  // 人格（persona）作用域（docs/25-persona §4/§7）
  // -------------------------------------------------------------------------

  /** 读取当前激活人格 id（meta `persona.active`；null = 未激活） */
  getActivePersonaId(): string | null {
    this.assertOpen('getActivePersonaId');
    const value = this.getMeta(PERSONA_ACTIVE_META_KEY);
    if (value === null) return null;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }

  /** 写入当前激活人格 id（meta；null/空串 = 清除） */
  setActivePersonaId(personaId: string | null, now: number = this.clock()): void {
    this.assertOpen('setActivePersonaId');
    if (personaId === null || personaId === '') {
      this.run('DELETE FROM meta WHERE key = ?', PERSONA_ACTIVE_META_KEY);
      return;
    }
    if (typeof personaId !== 'string') {
      throw new TypeError('[dsh-life-memory] store.setActivePersonaId: personaId must be string or null');
    }
    const trimmed = personaId.trim();
    if (trimmed.length === 0) {
      this.run('DELETE FROM meta WHERE key = ?', PERSONA_ACTIVE_META_KEY);
      return;
    }
    this.setMeta(PERSONA_ACTIVE_META_KEY, trimmed, now);
  }

  /**
   * 按人格统计派生记忆数量（docs/25-persona §7；UI/status 用）：
   * 只统计 status='active'；`counts` 键 = 人格 id（total + L1/L2/L3），`shared` = 共享记录总数。
   */
  countMemoriesByPersona(): { counts: Record<string, { total: number; L1: number; L2: number; L3: number }>; shared: number } {
    this.assertOpen('countMemoriesByPersona');
    const rows = this.allRows<{ persona_id: string | null; layer: string; total: number }>(
      "SELECT persona_id, layer, COUNT(*) AS total FROM memory_records " +
        "WHERE status = 'active' GROUP BY persona_id, layer",
    );
    const counts: Record<string, { total: number; L1: number; L2: number; L3: number }> = {};
    let shared = 0;
    for (const row of rows) {
      const total = Number(row.total ?? 0);
      if (row.persona_id === null) {
        shared += total;
        continue;
      }
      const entry = counts[row.persona_id] ?? { total: 0, L1: 0, L2: 0, L3: 0 };
      entry.total += total;
      if (row.layer === 'L1') entry.L1 += total;
      else if (row.layer === 'L2') entry.L2 += total;
      else if (row.layer === 'L3') entry.L3 += total;
      counts[row.persona_id] = entry;
    }
    return { counts, shared };
  }
  /**
   * 清空某层派生数据（重建用，docs/20 §7.1.1）：
   * - L1/L2（以及其他可重建扩展层）：物理 DELETE（子表 ON DELETE CASCADE，FTS 触发器同步），
   *   向量按 owner 显式删除；光标归零；
   * - L3：拒绝物理删除，archive=true 时归档（status=archived、valid_to=now）+ 快照，光标归零。
   */
  clearLayer(layer: string, options: { archive?: boolean; now?: number } = {}): { removed: number; archived: number } {
    this.assertOpen('clearLayer');
    if (typeof layer !== 'string' || layer.length === 0) {
      throw new TypeError('[dsh-life-memory] store.clearLayer: layer is required');
    }
    const now = typeof options.now === 'number' && Number.isFinite(options.now) ? Math.floor(options.now) : this.clock();
    return this.transaction(() => {
      const layerRow = this.getRow<{ rebuildable: number | null }>(
        'SELECT l.rebuildable AS rebuildable FROM layers l WHERE l.id = ?',
        layer,
      );
      if (layerRow === null) {
        throw new Error(`[dsh-life-memory] store.clearLayer: layer "${layer}" is not registered`);
      }
      if (layer === 'L3') {
        if (options.archive !== true) {
          throw new Error(
            '[dsh-life-memory] store.clearLayer: L3 semantic records must not be physically deleted ' +
              '(trg_l3_no_delete); pass { archive: true } for generational rebuild (docs/20 §9.7)',
          );
        }
        const rows = this.allRows<MemoryRow>(
          "SELECT * FROM memory_records WHERE layer = 'L3' AND status = 'active'",
        );
        for (const row of rows) {
          this.snapshotRevision(row, 'archive', now);
          this.run(
            'UPDATE memory_records SET status = ?, valid_to = COALESCE(valid_to, ?), ' +
              'revision = revision + 1, updated_at = ? WHERE id = ?',
            'archived',
            now,
            now,
            row.id,
          );
          // 关键：L3 私有表也要关闭有效期，否则 ux_l3_canonical_active 仍占着
          // canonical_key，新代际 putL3Semantic 会撞 UNIQUE（docs/20 §7.1.1/§9.7）。
          this.run(
            'UPDATE layer_l3_semantic SET valid_to = COALESCE(valid_to, ?) ' +
              'WHERE memory_id = ? AND valid_to IS NULL',
            now,
            row.id,
          );
        }
        this.resetDeriveCursor(layer, now);
        return { removed: 0, archived: rows.length };
      }
      if (layerRow.rebuildable === 0) {
        throw new Error(
          `[dsh-life-memory] store.clearLayer: layer "${layer}" is not rebuildable from L0; refusing to clear`,
        );
      }
      const ids = this.allRows<{ id: string }>(
        'SELECT id FROM memory_records WHERE layer = ?',
        layer,
      ).map((row) => row.id);
      // 向量无 FK 到 memory_records：必须显式删除（docs/20 §7.1.1）
      for (let offset = 0; offset < ids.length; offset += 500) {
        const chunk = ids.slice(offset, offset + 500);
        this.stmt(
          `DELETE FROM vectors WHERE owner_kind = 'memory' AND owner_id IN (${chunk
            .map(() => '?')
            .join(', ')})`,
        ).run(...(chunk as never[]));
      }
      // 子表（memory_sources / memory_revisions / layer_l2_episodes / layer_l3_semantic）
      // 由 docs/21 DDL 的 ON DELETE CASCADE 清理；memory_fts 由触发器同步
      this.run('DELETE FROM memory_records WHERE layer = ?', layer);
      this.resetDeriveCursor(layer, now);
      return { removed: ids.length, archived: 0 };
    });
  }

  private resetDeriveCursor(layer: string, now: number): void {
    this.run(
      'INSERT INTO derive_cursors(layer, last_raw_seq, updated_at) VALUES (?, 0, ?) ' +
        'ON CONFLICT(layer) DO UPDATE SET last_raw_seq = 0, updated_at = excluded.updated_at',
      layer,
      now,
    );
  }

  // -------------------------------------------------------------------------
  // 遗忘（只作用于三层记忆/派生层；绝不触碰 L0 / raw_index / 原始层向量；docs/24 §2）
  // -------------------------------------------------------------------------

  /**
   * 遗忘三层记忆（派生层）：
   * - `mode='delete'`（短期到期）：物理删除 `memory_records`（`memory_sources`/`memory_revisions`
   *   由 FK CASCADE 清理，FTS 由触发器同步，临时向量 `owner_kind='memory'` 显式删除）；
   * - `mode='archive'`（中期到期）：`status='archived'`、`valid_to=now`、`updated_at=now`，
   *   并写 `memory_revisions` 快照 + revision++（保留内容可追溯）；
   * - 保护：默认 `protectPinned`（pinned=0 才处理）、`protectImportance`（importance < 阈值）；
   * - **L3 long 永不物理删除**（DB 触发器 `tr_l3_long_no_delete` 兜底，候选集也排除）；
   * - 绝不写 `raw_index` / `raw_fts` / `vectors.owner_kind='raw'`。
   *
   * tiers 默认：delete → ['short']；archive → ['mid']。返回 ids 便于上层审计/测试。
   */
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
    this.assertOpen('forgetDerivedMemories');
    if (typeof options !== 'object' || options === null) {
      throw new TypeError('[dsh-life-memory] store.forgetDerivedMemories: options are required');
    }
    const mode = options.mode;
    if (mode !== 'delete' && mode !== 'archive') {
      throw new TypeError(
        '[dsh-life-memory] store.forgetDerivedMemories: mode must be "delete" or "archive"',
      );
    }
    if (typeof options.olderThan !== 'number' || !Number.isFinite(options.olderThan)) {
      throw new TypeError(
        '[dsh-life-memory] store.forgetDerivedMemories: olderThan must be a finite epoch-ms number',
      );
    }
    const now =
      typeof options.now === 'number' && Number.isFinite(options.now) ? Math.floor(options.now) : this.clock();
    const defaultTiers: RetentionTier[] = mode === 'delete' ? ['short'] : ['mid'];
    const tiers = (options.tiers ?? defaultTiers).filter((tier) => RETENTION_TIERS.has(tier));
    if (tiers.length === 0) {
      throw new Error('[dsh-life-memory] store.forgetDerivedMemories: tiers must contain short/mid/long');
    }
    const limit = normalizePageLimit(options.limit, 200, 5000);
    const protectPinned = options.protectPinned !== false;
    const protectImportance =
      typeof options.protectImportance === 'number' && Number.isFinite(options.protectImportance)
        ? clamp01(options.protectImportance)
        : undefined;

    return this.transaction(() => {
      const where: string[] = [
        "status = 'active'",
        'retention_tier IN (' + tiers.map(() => '?').join(', ') + ')',
        'updated_at <= ?',
      ];
      const params: unknown[] = [...tiers, Math.floor(options.olderThan)];
      if (Array.isArray(options.layers) && options.layers.length > 0) {
        where.push('layer IN (' + options.layers.map(() => '?').join(', ') + ')');
        params.push(...options.layers);
      }
      if (protectPinned) where.push('pinned = 0');
      if (protectImportance !== undefined) {
        where.push('importance < ?');
        params.push(protectImportance);
      }
      if (mode === 'delete') {
        // L3 long 永久保留：候选集先排除（触发器再兜底）
        where.push("NOT (layer = 'L3' AND retention_tier = 'long')");
      }
      const ids = this.allRows<{ id: string }>(
        'SELECT id FROM memory_records WHERE ' +
          where.join(' AND ') +
          ' ORDER BY updated_at ASC, rowid ASC LIMIT ?',
        ...params,
        limit,
      ).map((row) => row.id);
      if (ids.length === 0) return { deleted: 0, archived: 0, ids: [] };

      if (mode === 'delete') {
        for (let offset = 0; offset < ids.length; offset += 500) {
          const chunk = ids.slice(offset, offset + 500);
          const placeholders = chunk.map(() => '?').join(', ');
          // 临时向量（非永久向量模型）：随派生记录一起删除；raw 向量不受影响
          this.stmt(
            "DELETE FROM vectors WHERE owner_kind = 'memory' AND owner_id IN (" + placeholders + ')',
          ).run(...(chunk as never[]));
          // 物理删除：memory_sources/memory_revisions/layer_l2_episodes 由 FK CASCADE 清理，
          // memory_fts 由删除触发器同步；L3 long 已被 WHERE 排除 + 触发器兜底
          this.run('DELETE FROM memory_records WHERE id IN (' + placeholders + ')', ...chunk);
        }
        return { deleted: ids.length, archived: 0, ids };
      }

      for (let offset = 0; offset < ids.length; offset += 500) {
        const chunk = ids.slice(offset, offset + 500);
        const rows = this.allRows<MemoryRow>(
          'SELECT * FROM memory_records WHERE id IN (' + chunk.map(() => '?').join(', ') + ')',
          ...chunk,
        );
        for (const row of rows) {
          this.snapshotRevision(row, 'archive', now);
          this.run(
            'UPDATE memory_records SET status = ?, valid_to = COALESCE(valid_to, ?), ' +
              'revision = revision + 1, updated_at = ? WHERE id = ?',
            'archived',
            now,
            now,
            row.id,
          );
        }
      }
      return { deleted: 0, archived: ids.length, ids };
    });
  }

  /** 遗忘统计（meta 计数器：forgetting.shortDeleted / midArchived / lastForgetAt） */
  forgettingStats(): ForgettingStats {
    this.assertOpen('forgettingStats');
    const readCounter = (key: string): number => {
      const raw = this.getMeta(key);
      if (raw === null) return 0;
      const value = Number(raw);
      return Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
    };
    const lastRaw = this.getMeta(FORGETTING_LAST_KEY);
    const lastValue = lastRaw === null ? Number.NaN : Number(lastRaw);
    return {
      shortDeleted: readCounter(FORGETTING_SHORT_DELETED_KEY),
      midArchived: readCounter(FORGETTING_MID_ARCHIVED_KEY),
      lastForgetAt: Number.isFinite(lastValue) ? Math.floor(lastValue) : null,
    };
  }

  /** 原子累加遗忘审计计数 + 最近遗忘时间（meta；单事务） */
  recordForgetting(stats: { deletedShort?: number; archivedMid?: number }, now: number = this.clock()): void {
    this.assertOpen('recordForgetting');
    if (typeof stats !== 'object' || stats === null) {
      throw new TypeError('[dsh-life-memory] store.recordForgetting: stats are required');
    }
    const assertDelta = (value: unknown, label: string): number => {
      if (value === undefined) return 0;
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
        throw new TypeError(
          '[dsh-life-memory] store.recordForgetting: ' + label + ' must be a non-negative number',
        );
      }
      return Math.floor(value);
    };
    const deletedShort = assertDelta(stats.deletedShort, 'deletedShort');
    const archivedMid = assertDelta(stats.archivedMid, 'archivedMid');
    this.transaction(() => {
      const current = this.forgettingStats();
      if (deletedShort > 0) {
        this.setMeta(FORGETTING_SHORT_DELETED_KEY, String(current.shortDeleted + deletedShort), now);
      }
      if (archivedMid > 0) {
        this.setMeta(FORGETTING_MID_ARCHIVED_KEY, String(current.midArchived + archivedMid), now);
      }
      this.setMeta(FORGETTING_LAST_KEY, String(Math.floor(now)), now);
    });
  }

  // -------------------------------------------------------------------------
  // 原始层永久向量模型（owner_kind='raw'：只追加、不可改删、可从 L0 重建；docs/24 §3）
  // -------------------------------------------------------------------------

  /**
   * 写入原始层向量（append-only，永久向量模型）：
   * - 同 `(rawId, model, version)` 已存在则 **INSERT OR IGNORE 忽略**，绝不更新（docs/24 §3）；
   * - raw 必须已存在于 raw_index（捕获落盘 → indexRawRecords → 异步嵌入）；
   * - 写入前 L2 归一化；`text_hash` = raw_index.text 的 sha256（文本变化重算判据）。
   */
  putRawVector(rawId: string, ref: EmbeddingRef, vec: Float32Array): void {
    this.assertOpen('putRawVector');
    if (typeof rawId !== 'string' || rawId.length === 0) {
      throw new TypeError('[dsh-life-memory] store.putRawVector: rawId must be a non-empty string');
    }
    this.transaction(() => {
      this.ensureEmbeddingModel(ref);
      validateVector(vec, ref.dim, 'putRawVector(' + rawId + ')');
      const rawRow = this.getRow<{ text: string | null }>(
        'SELECT text FROM raw_index WHERE id = ?',
        rawId,
      );
      if (rawRow === null) {
        throw new Error(
          '[dsh-life-memory] store.putRawVector: raw record ' + rawId +
            ' is not in raw_index; index it before embedding',
        );
      }
      let normal = vec;
      if (!isNormalized(vec)) {
        normal = normalizeVector(vec);
        this.log.warn(
          '[store] putRawVector(' + rawId + '): vector was not L2-normalized; normalized before store',
        );
      }
      this.run(
        'INSERT OR IGNORE INTO vectors(owner_kind, owner_id, model, version, dim, vec, norm, text_hash, created_at) ' +
          'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        'raw',
        rawId,
        ref.model,
        ref.version,
        ref.dim,
        float32ToBlob(normal),
        vectorNorm(normal),
        sha256Hex(rawRow.text ?? ''),
        this.clock(),
      );
    });
  }

  /** 读取某条 raw 的原始层向量（最新一行；不存在返回 null） */
  getRawVector(rawId: string): { ref: EmbeddingRef; vec: Float32Array } | null {
    this.assertOpen('getRawVector');
    if (typeof rawId !== 'string' || rawId.length === 0) return null;
    const row = this.getRow<{ model: string; version: string; dim: number; vec: Uint8Array }>(
      "SELECT model, version, dim, vec FROM vectors WHERE owner_kind = 'raw' AND owner_id = ? " +
        'ORDER BY created_at DESC, rowid DESC LIMIT 1',
      rawId,
    );
    if (row === null) return null;
    return {
      ref: { model: row.model, version: row.version, dim: Number(row.dim) },
      vec: blobToFloat32(row.vec),
    };
  }

  /** 原始层向量余弦检索（docs/24 §3；cosine 从高到低；只读） */
  searchRawVector(
    query: Float32Array,
    ref: EmbeddingRef,
    options: { limit?: number; minScore?: number } = {},
  ): RawVecHit[] {
    this.assertOpen('searchRawVector');
    validateVector(query, ref.dim, 'searchRawVector(query)');
    const limit = normalizePageLimit(options.limit, 20, 500);
    const minScore =
      typeof options.minScore === 'number' && Number.isFinite(options.minScore)
        ? options.minScore
        : undefined;
    const rows = this.allRows<{ owner_id: string; vec: Uint8Array }>(
      "SELECT owner_id, vec FROM vectors WHERE owner_kind = 'raw' AND model = ? AND version = ? AND dim = ?",
      ref.model,
      ref.version,
      ref.dim,
    );
    const normalizedQuery = normalize(query);
    const hits: RawVecHit[] = [];
    for (const row of rows) {
      const vec = blobToFloat32(row.vec);
      if (vec.length !== ref.dim) continue;
      const score = cosineSimilarity(normalizedQuery, vec);
      if (minScore !== undefined && score < minScore) continue;
      hits.push({ rawId: row.owner_id, score });
    }
    hits.sort((a, b) => b.score - a.score);
    return hits.slice(0, limit);
  }

  /**
   * 缺少原始层向量的 raw 记录（启动回填用，docs/24 §3）。
   *
   * 只返回**有文本且缺向量**的 raw：`text IS NOT NULL AND TRIM(text) <> ''`。
   * 空文本 raw（turn/session/permission 等事件）无需向量（docs/24 §3「text 为空则跳过」），
   * 若把它们算进来会永久占据回填窗口造成饥饿；返回 `{id, text}`，调用方按 rawTextMaxChars 裁剪。
   */
  listRawWithoutVectors(ref: EmbeddingRef, limit = 64): Array<{ id: string; text: string | null }> {
    this.assertOpen('listRawWithoutVectors');
    const pageLimit = normalizePageLimit(limit, 64, 5000);
    const rows = this.allRows<{ id: string; text: string | null }>(
      'SELECT r.id AS id, r.text AS text FROM raw_index r ' +
        "LEFT JOIN vectors v ON v.owner_kind = 'raw' AND v.owner_id = r.id " +
        'AND v.model = ? AND v.version = ? AND v.dim = ? ' +
        "WHERE v.owner_id IS NULL AND r.text IS NOT NULL AND TRIM(r.text) <> '' " +
        'ORDER BY r.seq ASC LIMIT ?',
      ref.model,
      ref.version,
      ref.dim,
      pageLimit,
    );
    return rows.map((row) => ({ id: row.id, text: row.text }));
  }

  /**
   * 原始层向量统计：
   * - `total`      = raw_index 总数（含空文本 raw）；
   * - `embedded`   = 该 ref 已写入的 raw 向量数（`vectors WHERE owner_kind='raw' AND model/version/dim=ref`）；
   * - `pending`    = **有文本**（text 非空）但缺该 ref 向量的 raw 数（空文本无需向量，不计入，
   *                   docs/24 §3）——回填完成时 pending 归零；
   *   恒等式：`embedded + pending === 有文本 raw 数`，且 `embedded + pending <= total`；
   *   空文本 raw 只计入 total（`total - pending` 不等于已嵌入数，UI 请用 embedded）；
   * - `lastBackfillAt` 来自 meta `raw_vectors.lastBackfillAt`。
   */
  rawVectorStats(ref?: EmbeddingRef): RawVectorStats {
    this.assertOpen('rawVectorStats');
    const effectiveRef = ref ?? this.defaultEmbedding;
    const totalRow = this.getRow<{ n: number }>('SELECT COUNT(*) AS n FROM raw_index');
    const total = Number(totalRow?.n ?? 0);
    const embeddedRow = this.getRow<{ n: number }>(
      "SELECT COUNT(*) AS n FROM vectors WHERE owner_kind = 'raw' AND model = ? AND version = ? AND dim = ?",
      effectiveRef.model,
      effectiveRef.version,
      effectiveRef.dim,
    );
    const embedded = Number(embeddedRow?.n ?? 0);
    const pendingRow = this.getRow<{ n: number }>(
      'SELECT COUNT(*) AS n FROM raw_index r ' +
        "LEFT JOIN vectors v ON v.owner_kind = 'raw' AND v.owner_id = r.id " +
        'AND v.model = ? AND v.version = ? AND v.dim = ? ' +
        "WHERE v.owner_id IS NULL AND r.text IS NOT NULL AND TRIM(r.text) <> ''",
      effectiveRef.model,
      effectiveRef.version,
      effectiveRef.dim,
    );
    const pending = Number(pendingRow?.n ?? 0);
    const lastRaw = this.getMeta(RAW_VECTORS_LAST_BACKFILL_KEY);
    const parsed = lastRaw === null ? Number.NaN : Number(lastRaw);
    return {
      total,
      embedded,
      pending,
      ref: effectiveRef,
      lastBackfillAt: Number.isFinite(parsed) ? Math.floor(parsed) : null,
    };
  }

  /**
   * 显式重建原始层向量（docs/24 §3，唯一允许清空 raw 向量的入口）：
   * 单事务内临时 DROP 两个不可变触发器 → DELETE owner_kind='raw' → 恢复触发器。
   * 返回清空条数；重新嵌入由调用方（回填流程）随后执行。
   */
  rebuildRawVectors(): { removed: number } {
    this.assertOpen('rebuildRawVectors');
    return this.transaction(() => {
      this.connection.exec('DROP TRIGGER IF EXISTS tr_raw_vectors_no_update;');
      this.connection.exec('DROP TRIGGER IF EXISTS tr_raw_vectors_no_delete;');
      try {
        return { removed: this.run("DELETE FROM vectors WHERE owner_kind = 'raw'").changes };
      } finally {
        this.connection.exec(RAW_VECTOR_UPDATE_TRIGGER_SQL);
        this.connection.exec(RAW_VECTOR_DELETE_TRIGGER_SQL);
      }
    });
  }

  /** 写入原始层向量回填 meta（key 必须以 `raw_vectors.` 开头，docs/24 §3） */
  setRawVectorMeta(key: string, value: string, now: number = this.clock()): void {
    this.assertOpen('setRawVectorMeta');
    this.assertRawVectorMetaKey(key);
    this.setMeta(key, value, now);
  }

  /** 读取原始层向量回填 meta（非法 key 返回 null） */
  getRawVectorMeta(key: string): string | null {
    this.assertOpen('getRawVectorMeta');
    if (typeof key !== 'string' || !key.startsWith(RAW_VECTORS_META_PREFIX)) return null;
    return this.getMeta(key);
  }

  private assertRawVectorMetaKey(key: string): void {
    if (typeof key !== 'string' || !key.startsWith(RAW_VECTORS_META_PREFIX)) {
      throw new TypeError(
        '[dsh-life-memory] store: raw vector meta key must start with "' + RAW_VECTORS_META_PREFIX + '"',
      );
    }
  }

  // -------------------------------------------------------------------------
  // 向量
  // -------------------------------------------------------------------------

  putVector(ownerKind: VectorOwnerKind, ownerId: string, ref: EmbeddingRef, vec: Float32Array): void {
    this.assertOpen('putVector');
    this.transaction(() => {
      this.putVectorInternal(ownerKind, ownerId, ref, vec);
    });
  }

  /** 无事务包装的内部写入；docs §7.1.1：ownerKind=memory 时同事务更新 embedding_* 列 */
  private putVectorInternal(
    ownerKind: VectorOwnerKind,
    ownerId: string,
    ref: EmbeddingRef,
    vec: Float32Array,
  ): void {
    if (ownerKind !== 'memory' && ownerKind !== 'raw') {
      throw new TypeError(`[dsh-life-memory] store.putVector: invalid ownerKind ${String(ownerKind)}`);
    }
    if (typeof ownerId !== 'string' || ownerId.length === 0) {
      throw new TypeError('[dsh-life-memory] store.putVector: ownerId is required');
    }
    this.ensureEmbeddingModel(ref);
    validateVector(vec, ref.dim, `putVector(${ownerKind}:${ownerId})`);
    let normal = vec;
    if (!isNormalized(vec)) {
      normal = normalizeVector(vec);
      this.log.warn(
        `[store] putVector(${ownerKind}:${ownerId}): vector was not L2-normalized; normalized before store`,
      );
    }
    const blob = float32ToBlob(normal);
    const norm = vectorNorm(normal);
    // docs §7.5：text_hash = 被嵌入文本的 sha256（文本变了才重算向量）。
    // putVector 契约不传文本，这里按 owner 回查：memory => memory_records.text，
    // raw => raw_index.text；查不到时退化为向量字节哈希（仅作完整性标记）。
    let textHash = sha256OfBytes(blob);
    if (ownerKind === 'memory') {
      const memoryRow = this.getRow<{ text: string }>('SELECT text FROM memory_records WHERE id = ?', ownerId);
      if (memoryRow !== null) textHash = sha256Hex(memoryRow.text);
    } else {
      const rawRow = this.getRow<{ text: string | null }>('SELECT text FROM raw_index WHERE id = ?', ownerId);
      if (rawRow !== null) textHash = sha256Hex(rawRow.text ?? '');
    }
    const now = this.clock();
    this.run(
      'INSERT INTO vectors(owner_kind, owner_id, model, version, dim, vec, norm, text_hash, created_at) ' +
        'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ' +
        'ON CONFLICT(owner_kind, owner_id, model, version) DO UPDATE SET dim = excluded.dim, ' +
        'vec = excluded.vec, norm = excluded.norm, text_hash = excluded.text_hash, created_at = excluded.created_at',
      ownerKind,
      ownerId,
      ref.model,
      ref.version,
      ref.dim,
      blob,
      norm,
      textHash,
      now,
    );
    if (ownerKind === 'memory') {
      this.run(
        'UPDATE memory_records SET embedding_model = ?, embedding_dim = ?, embedding_version = ? ' +
          'WHERE id = ?',
        ref.model,
        ref.dim,
        ref.version,
        ownerId,
      );
    }
  }

  getVector(ownerId: string): { ref: EmbeddingRef; vec: Float32Array } | null {
    this.assertOpen('getVector');
    if (typeof ownerId !== 'string' || ownerId.length === 0) return null;
    const row = this.getRow<{ model: string; version: string; dim: number; vec: Uint8Array }>(
      "SELECT model, version, dim, vec FROM vectors WHERE owner_id = ? " +
        "ORDER BY CASE owner_kind WHEN 'memory' THEN 0 ELSE 1 END, created_at DESC, rowid DESC LIMIT 1",
      ownerId,
    );
    if (row === null) return null;
    return {
      ref: { model: row.model, version: row.version, dim: Number(row.dim) },
      vec: blobToFloat32(row.vec),
    };
  }

  searchVector(query: Float32Array, ref: EmbeddingRef, options: SearchVectorOptions = {}): VecHit[] {
    this.assertOpen('searchVector');
    validateVector(query, ref.dim, 'searchVector(query)');
    const limit =
      typeof options.limit === 'number' && Number.isFinite(options.limit) && options.limit > 0
        ? Math.floor(options.limit)
        : DEFAULT_VECTOR_LIMIT;
    const where = ['v.owner_kind = ?', 'v.model = ?', 'v.version = ?', 'v.dim = ?', "m.status = 'active'"];
    const params: unknown[] = ['memory', ref.model, ref.version, ref.dim];
    if (Array.isArray(options.layers) && options.layers.length > 0) {
      where.push(`m.layer IN (${options.layers.map(() => '?').join(', ')})`);
      params.push(...options.layers);
    }
    if (Array.isArray(options.kinds) && options.kinds.length > 0) {
      where.push(`m.kind IN (${options.kinds.map(() => '?').join(', ')})`);
      params.push(...options.kinds);
    }
    const rows = this.allRows<{ id: string; layer: string; vec: Uint8Array }>(
      'SELECT m.id, m.layer, v.vec FROM vectors v JOIN memory_records m ON m.id = v.owner_id ' +
        `WHERE ${where.join(' AND ')}`,
      ...params,
    );
    const normalizedQuery = normalize(query);
    const hits: VecHit[] = [];
    for (const row of rows) {
      const vec = blobToFloat32(row.vec);
      if (vec.length !== ref.dim) continue; // 维度不匹配的脏行跳过（防御）
      const score = cosineSimilarity(normalizedQuery, vec);
      if (typeof options.minScore === 'number' && Number.isFinite(options.minScore) && score < options.minScore) {
        continue;
      }
      hits.push({ id: row.id, layer: row.layer, score });
    }
    hits.sort((a, b) => b.score - a.score);
    return hits.slice(0, limit);
  }

  // -------------------------------------------------------------------------
  // 词法检索（中文二元组影子列，docs §7.4）
  // -------------------------------------------------------------------------

  searchLexical(query: string, options: SearchLexicalOptions = {}): LexHit[] {
    this.assertOpen('searchLexical');
    if (typeof query !== 'string' || query.length === 0) return [];
    const tokens = normalizeFtsTokens(tokenizeTextSeg(query));
    if (tokens.length === 0) return [];
    const limit =
      typeof options.limit === 'number' && Number.isFinite(options.limit) && options.limit > 0
        ? Math.floor(options.limit)
        : DEFAULT_LEXICAL_LIMIT;
    const fetchLimit = Math.min(Math.max(limit * 4, limit), 400);
    const filters: string[] = ["m.status = 'active'"];
    const filterParams: unknown[] = [];
    if (Array.isArray(options.layers) && options.layers.length > 0) {
      filters.push(`m.layer IN (${options.layers.map(() => '?').join(', ')})`);
      filterParams.push(...options.layers);
    }
    if (Array.isArray(options.kinds) && options.kinds.length > 0) {
      filters.push(`m.kind IN (${options.kinds.map(() => '?').join(', ')})`);
      filterParams.push(...options.kinds);
    }
    const filterSql = filters.length > 0 ? ` AND ${filters.join(' AND ')}` : '';
    const runMatch = (matchExpression: string): LexHit[] => {
      const rows = this.allRows<{ id: string; layer: string; b: number }>(
        'SELECT m.id AS id, m.layer AS layer, bm25(memory_fts) AS b ' +
          'FROM memory_fts JOIN memory_records m ON m.rowid = memory_fts.rowid ' +
          `WHERE memory_fts MATCH ?${filterSql} ORDER BY b LIMIT ?`,
        matchExpression,
        ...filterParams,
        fetchLimit,
      );
      return rows.map((row) => ({
        id: row.id,
        layer: row.layer,
        score: lexicalScoreFromRank(Number(row.b)),
      }));
    };
    let hits = runMatch(buildAndMatch(tokens));
    if (hits.length === 0 && tokens.length > 1) {
      hits = runMatch(buildOrMatch(tokens)); // docs §7.4：AND 0 命中降级 OR
    }
    if (hits.length === 0) {
      // 极短 CJK 查询（如单字）在二元组索引下无法命中 >=2 字文本：LIKE 降级（低分标记）
      hits = this.fallbackLikeSearch(query, limit, options);
    }
    hits.sort((a, b) => b.score - a.score);
    return hits.slice(0, limit);
  }

  private fallbackLikeSearch(query: string, limit: number, options: SearchLexicalOptions): LexHit[] {
    const where: string[] = ["status = 'active'", "text LIKE ? ESCAPE '\\'"];
    const params: unknown[] = [`%${escapeLikePattern(query.trim())}%`];
    if (Array.isArray(options.layers) && options.layers.length > 0) {
      where.push(`layer IN (${options.layers.map(() => '?').join(', ')})`);
      params.push(...options.layers);
    }
    if (Array.isArray(options.kinds) && options.kinds.length > 0) {
      where.push(`kind IN (${options.kinds.map(() => '?').join(', ')})`);
      params.push(...options.kinds);
    }
    const rows = this.allRows<{ id: string; layer: string }>(
      `SELECT id, layer FROM memory_records WHERE ${where.join(' AND ')} ORDER BY updated_at DESC LIMIT ?`,
      ...params,
      limit,
    );
    return rows.map((row) => ({ id: row.id, layer: row.layer, score: 0.25 }));
  }

  /**
   * 原始层词法检索（显式检索用，docs/24 §3）：raw_fts FTS5 → `RawVecHit{rawId, score}`。
   * - MATCH 构造与 memory 词法一致（§7.4：quoted AND → 0 命中 OR 降级 → 单字 CJK LIKE 兜底）；
   * - score 归一化 `b/(1+b)`；**退化保护**：小语料下 bm25 量纲可能退化到 ~1e-6，
   *   此时改用名次分 `1/(1+rank)`，避免 lexical≈0 淹没词法信号（QA D3 同类问题）；
   * - 只读：raw_fts / raw_index 均不做任何写。
   */
  searchRawLexical(query: string, options: { limit?: number; minScore?: number } = {}): RawVecHit[] {
    this.assertOpen('searchRawLexical');
    if (typeof query !== 'string' || query.length === 0) return [];
    const tokens = normalizeFtsTokens(tokenizeTextSeg(query));
    if (tokens.length === 0) return [];
    const limit = normalizePageLimit(options.limit, 20, 500);
    const fetchLimit = Math.min(Math.max(limit * 4, limit), 400);
    const minScore =
      typeof options.minScore === 'number' && Number.isFinite(options.minScore)
        ? options.minScore
        : undefined;
    const runMatch = (matchExpression: string): Array<{ rawId: string; b: number }> =>
      this.allRows<{ rawId: string; b: number }>(
        'SELECT r.id AS rawId, bm25(raw_fts) AS b FROM raw_fts JOIN raw_index r ON r.seq = raw_fts.rowid ' +
          'WHERE raw_fts MATCH ? ORDER BY b LIMIT ?',
        matchExpression,
        fetchLimit,
      );
    let rows = runMatch(buildAndMatch(tokens));
    if (rows.length === 0 && tokens.length > 1) {
      rows = runMatch(buildOrMatch(tokens)); // 与 memory 词法一致的 OR 降级
    }
    if (rows.length === 0) {
      // 极短 CJK 查询（如单字）在 bigram 索引下无法命中：LIKE 兜底（固定低分，显式标记）
      return this.fallbackLikeRawSearch(query, limit, minScore);
    }
    const magnitudes = rows.map((row) => Math.max(0, -Number(row.b)));
    const maxMagnitude = Math.max(0, ...magnitudes);
    const degenerate = maxMagnitude < LEXICAL_DEGENERATE_THRESHOLD;
    const hits = rows.map((row, index) => ({
      rawId: row.rawId,
      score: degenerate ? 1 / (1 + index) : lexicalScoreFromRank(Number(row.b)),
    }));
    const filtered = minScore === undefined ? hits : hits.filter((hit) => hit.score >= minScore);
    filtered.sort((a, b) => b.score - a.score);
    return filtered.slice(0, limit);
  }

  private fallbackLikeRawSearch(query: string, limit: number, minScore?: number): RawVecHit[] {
    const pattern = '%' + escapeLikePattern(query.trim()) + '%';
    const rows = this.allRows<{ id: string }>(
      "SELECT id FROM raw_index WHERE text LIKE ? ESCAPE '\\' ORDER BY seq DESC LIMIT ?",
      pattern,
      limit,
    );
    const score = 0.25; // 固定低分：明确标记为兜底命中，避免与 FTS 命中混淆
    if (minScore !== undefined && score < minScore) return [];
    return rows.map((row) => ({ rawId: row.id, score }));
  }

  // -------------------------------------------------------------------------
  // 完整性 / 修复 / 覆盖率（只读工具/UI）
  // -------------------------------------------------------------------------

  listIntegrityRuns(limit = 10): IntegrityRunRow[] {
    this.assertOpen('listIntegrityRuns');
    const rows = this.allRows<{
      id: number;
      kind: string;
      started_at: number;
      finished_at: number | null;
      records_checked: number;
      segments_checked: number;
      ok: number | null;
    }>(
      'SELECT id, kind, started_at, finished_at, records_checked, segments_checked, ok ' +
        'FROM integrity_runs ORDER BY id DESC LIMIT ?',
      clampLimit(limit, 10, 200),
    );
    return rows.map((row) => ({
      id: Number(row.id),
      kind: row.kind,
      startedAt: Number(row.started_at),
      finishedAt: row.finished_at ?? null,
      recordsChecked: Number(row.records_checked ?? 0),
      segmentsChecked: Number(row.segments_checked ?? 0),
      ok: row.ok === null ? null : row.ok === 1,
    }));
  }

  getLastIntegrityRun(): IntegrityRunRow | null {
    this.assertOpen('getLastIntegrityRun');
    const runs = this.listIntegrityRuns(1);
    return runs.length > 0 ? runs[0] : null;
  }

  recordIntegrityRun(run: {
    kind: string;
    startedAt: number;
    finishedAt?: number;
    recordsChecked?: number;
    segmentsChecked?: number;
    ok: boolean;
    details?: Record<string, unknown>;
  }): void {
    this.assertOpen('recordIntegrityRun');
    if (typeof run.kind !== 'string' || run.kind.length === 0) {
      throw new TypeError('[dsh-life-memory] store.recordIntegrityRun: kind is required');
    }
    this.run(
      'INSERT INTO integrity_runs(kind, started_at, finished_at, records_checked, segments_checked, ok, details_json) ' +
        'VALUES (?, ?, ?, ?, ?, ?, ?)',
      run.kind,
      Math.floor(run.startedAt),
      run.finishedAt === undefined ? null : Math.floor(run.finishedAt),
      Number.isFinite(run.recordsChecked) ? Math.max(0, Math.floor(run.recordsChecked as number)) : 0,
      Number.isFinite(run.segmentsChecked) ? Math.max(0, Math.floor(run.segmentsChecked as number)) : 0,
      run.ok ? 1 : 0,
      JSON.stringify(run.details ?? {}),
    );
  }

  listRepairLog(limit = 20): RepairLogRow[] {
    this.assertOpen('listRepairLog');
    const rows = this.allRows<{ id: number; ts: number; action: string; target: string | null }>(
      'SELECT id, ts, action, target FROM repair_log ORDER BY id DESC LIMIT ?',
      clampLimit(limit, 20, 500),
    );
    return rows.map((row) => ({
      id: Number(row.id),
      ts: Number(row.ts),
      action: row.action,
      target: row.target ?? null,
    }));
  }

  embeddingCoverage(): Record<string, number> {
    this.assertOpen('embeddingCoverage');
    const rows = this.allRows<{ layer: string; embedded: number | null }>(
      'SELECT layer, embedded FROM v_embedding_coverage ORDER BY layer',
    );
    const out: Record<string, number> = {};
    for (const row of rows) out[row.layer] = Number(row.embedded ?? 0);
    return out;
  }

  storageStats(): StorageStats {
    this.assertOpen('storageStats');
    const one = (sql: string): number => Number(this.getRow<{ n: number }>(sql)?.n ?? 0);
    const rawCount = one('SELECT COUNT(*) AS n FROM raw_index');
    const memoryCount = one('SELECT COUNT(*) AS n FROM memory_records');
    const activeMemoryCount = one("SELECT COUNT(*) AS n FROM memory_records WHERE status = 'active'");
    const vectorCount = one('SELECT COUNT(*) AS n FROM vectors');
    const segmentCount = one('SELECT COUNT(*) AS n FROM raw_segments');
    return {
      dbPath: this.dbPathValue,
      dbBytes: this.measureDbBytes(),
      rawCount,
      memoryCount,
      activeMemoryCount,
      vectorCount,
      segmentCount,
      embedding: { ...this.defaultEmbedding },
      schemaVersion: readSchemaVersion(this.connection),
    };
  }

  private measureDbBytes(): number {
    if (this.dbPathValue === ':memory:') return 0;
    let total = 0;
    for (const suffix of ['', '-wal', '-shm']) {
      try {
        total += statSync(`${this.dbPathValue}${suffix}`).size;
      } catch {
        /* 文件不存在忽略 */
      }
    }
    return total;
  }
}

// ---------------------------------------------------------------------------
// 行映射与纯函数工具
// ---------------------------------------------------------------------------

/** memory_records 行 -> MemoryRecord（sourceRawIds 由调用方批量查好） */
function mapMemoryRow(row: MemoryRow, sourceRawIds: string[]): MemoryRecord {
  const record: MemoryRecord = {
    id: row.id,
    layer: row.layer,
    kind: row.kind as MemoryRecord['kind'],
    text: row.text,
    summary: row.summary,
    importance: Number(row.importance),
    confidence: Number(row.confidence),
    sourceRawIds: [...sourceRawIds],
    sessionId: row.session_id,
    workspace: row.workspace,
    tags: parseJsonArray<string>(row.tags_json),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    validFrom: row.valid_from,
    validTo: row.valid_to,
    supersedes: parseJsonArray<string>(row.supersedes_json),
    revision: Number(row.revision),
    contentHash: row.content_hash,
    status: row.status as MemoryStatus,
    heat: Number(row.heat),
    accessCount: Number(row.access_count),
    lastAccessAt: row.last_access_at,
    createdSeq: Number(row.created_seq),
    meta: parseJsonObject(row.meta_json),
  };
  record.retentionTier = row.retention_tier as RetentionTier;
  record.retentionScore = Number(row.retention_score ?? 0);
  record.pinned = row.pinned === 1;
  record.promotedAt = row.promoted_at ?? null;
  record.longTermAt = row.long_term_at ?? null;
  record.personaId = row.persona_id ?? null;
  if (row.embedding_model !== null && row.embedding_dim !== null && row.embedding_version !== null) {
    record.embedding = {
      model: row.embedding_model,
      dim: Number(row.embedding_dim),
      version: row.embedding_version,
    };
  } else {
    record.embedding = null;
  }
  return record;
}

/** raw_index 行 -> RawIndexRow（posix 即 DB 内 segment 值） */
function mapRawIndexRow(row: RawIndexDbRow, includePayload: boolean): RawIndexRow {
  return {
    id: row.id,
    seq: Number(row.seq),
    ts: Number(row.ts),
    iso: row.iso,
    day: row.day,
    timezone: row.timezone,
    kind: row.kind as RawIndexRow['kind'],
    sessionId: row.session_id,
    workspace: row.workspace,
    personaId: row.persona_id ?? null,
    turnId: row.turn_id,
    stepId: row.step_id,
    role: row.role,
    text: row.text,
    textSeg: row.text_seg,
    payloadJson: includePayload ? row.payload_json : '',
    hash: row.hash,
    prevHash: row.prev_hash,
    segment: row.segment,
    lineNo: Number(row.line_no),
    byteOffset: Number(row.byte_offset),
    byteLen: Number(row.byte_len),
    recordVersion: Number(row.record_version),
    ingestKey: row.ingest_key,
    createdAt: Number(row.created_at),
  };
}

/** 判断同 id 的更新是否真的需要写库（内容/有效期/状态/标签/元数据等） */
function memoryRowChanged(existing: MemoryRow, validated: ValidatedMemory): boolean {
  return (
    existing.text !== validated.text ||
    (existing.summary ?? null) !== validated.summary ||
    Number(existing.importance) !== validated.importance ||
    Number(existing.confidence) !== validated.confidence ||
    (existing.session_id ?? null) !== validated.sessionId ||
    (existing.workspace ?? null) !== validated.workspace ||
    existing.valid_from !== validated.validFrom ||
    existing.valid_to !== validated.validTo ||
    existing.status !== validated.status ||
    existing.created_seq !== (validated.createdSeq > 0 ? validated.createdSeq : existing.created_seq) ||
    existing.content_hash !== validated.contentHash ||
    existing.tags_json !== stringifyJsonArray(validated.tags) ||
    existing.supersedes_json !== stringifyJsonArray(validated.supersedes) ||
    existing.meta_json !== validated.metaJson
  );
}

/** 合法保留期层（与 contracts.ts RetentionTier 同步） */
const RETENTION_TIERS: ReadonlySet<string> = new Set<RetentionTier>(['short', 'mid', 'long']);

/** 保留期层级顺序：晋升只升不降（docs/23-memory-models §3.2） */
const RETENTION_TIER_RANK: Readonly<Record<RetentionTier, number>> = { short: 0, mid: 1, long: 2 };

/** 原始层向量 meta 前缀 / 最近回填时间 key（docs/24 §3） */
const RAW_VECTORS_META_PREFIX = 'raw_vectors.';
const RAW_VECTORS_LAST_BACKFILL_KEY = RAW_VECTORS_META_PREFIX + 'lastBackfillAt';

/** 激活人格 meta key（docs/25-persona §5：SQLite meta.persona.active） */
const PERSONA_ACTIVE_META_KEY = 'persona.active';

/** 词法分退化阈值：整批 max(b) 低于该值时改用名次分（避免小语料 lexical≈0） */
const LEXICAL_DEGENERATE_THRESHOLD = 1e-3;

/** 原始层向量不可变触发器（与 migration 3 定义逐字一致；rebuildRawVectors 临时移除后恢复） */
const RAW_VECTOR_UPDATE_TRIGGER_SQL =
  "CREATE TRIGGER IF NOT EXISTS tr_raw_vectors_no_update BEFORE UPDATE ON vectors " +
  "WHEN old.owner_kind = 'raw' BEGIN SELECT RAISE(ABORT, 'raw vectors are append-only: UPDATE forbidden'); END;";
const RAW_VECTOR_DELETE_TRIGGER_SQL =
  "CREATE TRIGGER IF NOT EXISTS tr_raw_vectors_no_delete BEFORE DELETE ON vectors " +
  "WHEN old.owner_kind = 'raw' BEGIN SELECT RAISE(ABORT, 'raw vectors are append-only: DELETE forbidden'); END;";

/** 遗忘审计计数 meta keys（docs/24 §2） */
const FORGETTING_SHORT_DELETED_KEY = 'forgetting.shortDeleted';
const FORGETTING_MID_ARCHIVED_KEY = 'forgetting.midArchived';
const FORGETTING_LAST_KEY = 'forgetting.lastForgetAt';

/** 校验 RetentionState 形状/取值（docs/23） */
function validateRetentionState(state: RetentionState, label: string): void {
  if (typeof state !== 'object' || state === null) {
    throw new TypeError('[dsh-life-memory] store.' + label + ': state must be an object');
  }
  if (typeof state.tier !== 'string' || !RETENTION_TIERS.has(state.tier)) {
    throw new TypeError('[dsh-life-memory] store.' + label + ': invalid retention tier ' + String(state.tier));
  }
  if (typeof state.score !== 'number' || !Number.isFinite(state.score)) {
    throw new TypeError('[dsh-life-memory] store.' + label + ': score must be a finite number');
  }
  if (typeof state.pinned !== 'boolean') {
    throw new TypeError('[dsh-life-memory] store.' + label + ': pinned must be boolean');
  }
  for (const field of ['promotedAt', 'longTermAt'] as const) {
    const value = state[field];
    if (value !== null && (typeof value !== 'number' || !Number.isFinite(value))) {
      throw new TypeError('[dsh-life-memory] store.' + label + ': ' + field + ' must be a finite number or null');
    }
  }
}

/** RetentionRow -> RetentionState */
function mapRetentionRow(row: RetentionRow): RetentionState {
  return {
    tier: row.retention_tier as RetentionTier,
    score: Number(row.retention_score ?? 0),
    pinned: row.pinned === 1,
    promotedAt: row.promoted_at ?? null,
    longTermAt: row.long_term_at ?? null,
  };
}

/** 分页 limit 归一化（默认值 + 上限） */
function normalizePageLimit(value: unknown, fallback: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return fallback;
  return Math.min(Math.floor(value), max);
}

/** 分页 offset 归一化（>=0） */
function normalizePageOffset(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return 0;
  return Math.floor(value);
}

/** bm25 原始分 -> [0,1) 归一化词法分（docs §10.3：b=max(0,-bm25)；b/(1+b)） */
export function lexicalScoreFromRank(bm25: number): number {
  if (!Number.isFinite(bm25)) return 0;
  const b = Math.max(0, -bm25);
  return b / (1 + b);
}

function normalizeOptionalString(value: unknown, field: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') {
    throw new TypeError(`[dsh-life-memory] store.upsertMemory: ${field} must be string or null`);
  }
  return value;
}

function toOptionalTimestamp(value: unknown, field: string): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TypeError(`[dsh-life-memory] store.upsertMemory: ${field} must be a finite number or null`);
  }
  return Math.floor(value);
}

function clampLimit(value: unknown, fallback: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return fallback;
  return Math.min(Math.floor(value), max);
}

function sha256OfBytes(bytes: Uint8Array): string {
  return sha256Hex(bytes);
}

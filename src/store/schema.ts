// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hanxustu (dsh-life-memory)
/**
 * SQLite schema —— **自动生成，请勿手工编辑**。
 *
 * 来源：
 *   - migration 1：`docs/21-schema.sql`（逐字节提取 §1 起的 DDL；§0 连接 PRAGMA 单独导出）；
 *   - migration 2：`docs/23-memory-models.md` §5
 *     （记忆分层模型 short/mid/long retention 的治理列/索引/视图）。
 *
 * 迁移规则（docs/20 §7.7）：迁移只增不改；已发布 migration 的 SQL 永不编辑，
 * checksum 写入 schema_migrations 用于检测手改。`tests/core/store.test.ts` 对账：
 *   - `sha256(SCHEMA_V1_SQL) === SCHEMA_V1_SHA256` 且 docs/21 包含该 SQL；
 *   - `sha256(MIGRATION_2_SQL) === MIGRATION_2_SHA256` 且 docs/23-memory-models §5 的关键 DDL 片段存在。
 * 变更流程：改 docs → 新增 migration N（追加到 MIGRATIONS）→ 重新生成本文件。
 *
 * PRAGMA user_version 不在连接初始化阶段设置，由 migrations.ts 在迁移事务成功后设置。
 */

/** SQLite 文件身份：'DSV1' = 0x44535631 */
export const STORE_APPLICATION_ID = 1146312241;
/** 当前 schema 版本（= PRAGMA user_version） */
export const STORE_SCHEMA_VERSION = 4 as const;

/**
 * 连接级 PRAGMA（按 docs/21-schema.sql §0 原文顺序执行，page_size 必须最先）。
 * 不含 `PRAGMA user_version`（由迁移完成后设置）。
 */
export const CONNECTION_PRAGMAS: readonly string[] = [
  'PRAGMA page_size = 8192;',
  'PRAGMA journal_mode = WAL;',
  'PRAGMA synchronous = NORMAL;',
  'PRAGMA foreign_keys = ON;',
  'PRAGMA busy_timeout = 5000;',
  'PRAGMA temp_store = MEMORY;',
  'PRAGMA cache_size = -64000;',
  'PRAGMA mmap_size = 268435456;',
  'PRAGMA wal_autocheckpoint = 1000;',
  'PRAGMA auto_vacuum = NONE;',
  'PRAGMA application_id = 1146312241;',
  'PRAGMA user_version = 1;',
];

/** migration 1：docs/21-schema.sql §1 起的 DDL（逐字节原样） */
export const SCHEMA_V1_SQL = String.raw`-- ============================================================================
-- 1. 元数据 / 迁移 / 计数器
-- ============================================================================

-- 库级键值元数据。value 为 JSON 字符串（字符串也按 JSON 编码，读取统一 JSON.parse）。
CREATE TABLE IF NOT EXISTS meta (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;

INSERT OR IGNORE INTO meta(key, value, updated_at) VALUES
  ('schema_version',          '1',            0),
  ('vault_id',                '""',           0),  -- 首次初始化时写入 UUID v4（实现负责）
  ('record_format_version',   '1',            0),  -- L0 原始记录格式版本（永不回写旧记录）
  ('created_at',              '0',            0),
  ('timezone',                '""',           0),  -- 建库时 IANA 时区，仅作记录
  ('embedding_model',         '"dsh-local-hash-v1"', 0),
  ('embedding_dim',           '512',          0),
  ('embedding_version',       '"1"',          0),
  ('raw_id_policy',           '"local-date+seq"', 0);

-- 迁移账本：每次 schema 变更一行；不可修改/删除。
CREATE TABLE IF NOT EXISTS schema_migrations (
  version     INTEGER PRIMARY KEY,
  applied_at  INTEGER NOT NULL,
  description TEXT NOT NULL,
  checksum    TEXT NOT NULL              -- 迁移 SQL 的 sha256，用于检测手改
) STRICT;

INSERT OR IGNORE INTO schema_migrations(version, applied_at, description, checksum) VALUES
  (1, 0, 'initial schema: raw mirror + derived layers + vectors + fts5 + jobs', '');

-- 持久计数器：原始序号、当日序号等。分配必须在 BEGIN IMMEDIATE 事务内完成。
CREATE TABLE IF NOT EXISTS counters (
  name       TEXT PRIMARY KEY,
  value      INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
) STRICT;

INSERT OR IGNORE INTO counters(name, value, updated_at) VALUES
  ('raw.seq', 0, 0);   -- 全局单调递增序号（永不复用）；当日序号键为 'day.YYYY-MM-DD'

-- 嵌入模型注册表：向量空间由 (model, version, dim) 三元组唯一确定。
CREATE TABLE IF NOT EXISTS embedding_models (
  model_id     TEXT PRIMARY KEY,          -- 例如 dsh-local-hash-v1 / text-embedding-3-small
  provider     TEXT NOT NULL,             -- local | openai-compatible | other
  dim          INTEGER NOT NULL CHECK (dim > 0),
  version      TEXT NOT NULL,             -- 算法版本；变更即代表不兼容的向量空间
  config_json  TEXT NOT NULL DEFAULT '{}',
  created_at   INTEGER NOT NULL,
  active       INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1))
) STRICT;

INSERT OR IGNORE INTO embedding_models(model_id, provider, dim, version, config_json, created_at) VALUES
  ('dsh-local-hash-v1', 'local', 512, '1', '{}', 0);

-- ============================================================================
-- 2. 分层注册表（L1/L2/L3 内置；L4+ 扩展层在这里注册）
-- ============================================================================

-- 层定义与版本。id 对应 contracts.ts 的 LayerId；L0 不在此表（L0 是固定原始层）。
CREATE TABLE IF NOT EXISTS layers (
  id              TEXT PRIMARY KEY,        -- L1 / L2 / L3 / L4 / project / procedural ...
  name            TEXT NOT NULL,           -- 展示名（中文）
  version         INTEGER NOT NULL DEFAULT 1,  -- 派生算法版本；提升即允许重建该层
  depends_on_json TEXT NOT NULL DEFAULT '[]',
  rebuildable     INTEGER NOT NULL DEFAULT 1 CHECK (rebuildable IN (0, 1)),
  enabled         INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  kind            TEXT NOT NULL DEFAULT 'builtin' CHECK (kind IN ('builtin', 'extension')),
  schema_version  INTEGER NOT NULL DEFAULT 1,  -- 扩展层私有表的版本
  config_json     TEXT NOT NULL DEFAULT '{}',
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
) STRICT;

INSERT OR IGNORE INTO layers(id, name, version, depends_on_json, rebuildable, enabled, kind, created_at, updated_at) VALUES
  ('L1', 'L1 短期/工作层', 1, '[]',        1, 1, 'builtin', 0, 0),
  ('L2', 'L2 中期/情节层', 1, '["L1"]',    1, 1, 'builtin', 0, 0),
  ('L3', 'L3 长期/语义层', 1, '["L1","L2"]', 1, 1, 'builtin', 0, 0);

-- ============================================================================
-- 3. L0 原始层：SQLite 只读镜像（事实来源是 segments/*.jsonl）
-- ============================================================================

-- 原始记录索引镜像。行由 append 流程写入；行内容必须与 JSONL 文件逐字节一致。
-- 不可 UPDATE / 不可 DELETE（见 §9 触发器）；重建索引只能 DROP TABLE 后重放文件。
CREATE TABLE IF NOT EXISTS raw_index (
  id             TEXT PRIMARY KEY,          -- 'YYYY-MM-DD-NNNNNN'：本地日期 + 当日 6 位序号
  seq            INTEGER NOT NULL UNIQUE,   -- 全局单调序号（跨日不重置），哈希链顺序依据
  ts             INTEGER NOT NULL,          -- epoch ms（UTC 语义）
  iso            TEXT NOT NULL,             -- ISO 8601 含偏移，便于人读
  day            TEXT NOT NULL,             -- 本地日期 YYYY-MM-DD（id 前缀来源）
  timezone       TEXT NOT NULL,             -- 生成时 IANA 时区
  kind           TEXT NOT NULL,             -- session/turn/user/assistant/tool_call/tool_result/system/compaction/event/note
  session_id     TEXT NOT NULL,
  workspace      TEXT,
  turn_id        TEXT,
  step_id        TEXT,
  role           TEXT,                      -- user/assistant/tool/system
  text           TEXT,                      -- 规范化纯文本（FTS/嵌入用）；可为 NULL
  text_seg       TEXT NOT NULL DEFAULT '',  -- 中文二元组切分后的检索串（见文件头注 5）
  payload_json   TEXT NOT NULL DEFAULT '{}',-- 完整原始事件 JSON（无损；镜像用，权威在文件）
  hash           TEXT NOT NULL,             -- sha256(canonicalJson(记录去掉 hash/prev_hash))
  prev_hash      TEXT NOT NULL,             -- 上一条记录 hash；链首为 64 个 '0'
  segment        TEXT NOT NULL,             -- 相对 vault_root 的文件路径（posix 分隔符）
  line_no        INTEGER NOT NULL,          -- 段内行号（1 起）
  byte_offset    INTEGER NOT NULL,          -- 段文件内起始字节偏移
  byte_len       INTEGER NOT NULL,          -- 该行字节长度（含换行）
  record_version INTEGER NOT NULL DEFAULT 1,
  ingest_key     TEXT NOT NULL,             -- 传输层幂等键：重复投递同一事件不二次追加
  created_at     INTEGER NOT NULL           -- 写入索引时间（epoch ms）
) STRICT;

CREATE UNIQUE INDEX IF NOT EXISTS ux_raw_ingest_key ON raw_index(ingest_key);
CREATE UNIQUE INDEX IF NOT EXISTS ux_raw_segment_line ON raw_index(segment, line_no);
CREATE INDEX IF NOT EXISTS ix_raw_ts        ON raw_index(ts);
CREATE INDEX IF NOT EXISTS ix_raw_day       ON raw_index(day, seq);
CREATE INDEX IF NOT EXISTS ix_raw_session   ON raw_index(session_id, ts);
CREATE INDEX IF NOT EXISTS ix_raw_workspace ON raw_index(workspace, ts);
CREATE INDEX IF NOT EXISTS ix_raw_kind      ON raw_index(kind, ts);
CREATE INDEX IF NOT EXISTS ix_raw_seq       ON raw_index(seq);

-- 段文件清单镜像（manifest.json 的数据库副本，便于 UI/巡检；权威仍是文件）。
CREATE TABLE IF NOT EXISTS raw_segments (
  segment     TEXT PRIMARY KEY,             -- 相对路径，例：segments/2026-10-25/seg-w01-000001.jsonl
  day         TEXT NOT NULL,
  writer_id   TEXT NOT NULL,                -- 写者分片 id（避免多进程追加交织）
  first_seq   INTEGER,
  last_seq    INTEGER,
  records     INTEGER NOT NULL DEFAULT 0,
  bytes       INTEGER NOT NULL DEFAULT 0,
  head_hash   TEXT,                         -- 段首记录 hash
  tail_hash   TEXT,                         -- 段尾记录 hash
  sealed      INTEGER NOT NULL DEFAULT 0 CHECK (sealed IN (0, 1)),
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS ix_raw_segments_day ON raw_segments(day, segment);

-- 原始记录 FTS5：contentless（content=''），rowid 复用 raw_index.seq。
-- 只插入、永不更新/删除，天然满足 append-only；文本存 text_seg 切分结果。
CREATE VIRTUAL TABLE IF NOT EXISTS raw_fts USING fts5(
  seg,
  content = '',
  tokenize = 'unicode61 remove_diacritics 2'
);

-- ============================================================================
-- 4. 派生层通用信封（L1/L2/L3/L4+ 共用一张表）
-- ============================================================================

-- 所有派生记忆的统一信封，字段与 contracts.ts 的 MemoryRecord 一一对应
-- （camelCase JSON ↔ snake_case 列）。层私有字段放 meta_json / 扩展层私有表。
-- 允许 UPDATE（修订/取代/归档），但永不物理删除语义历史：旧版本写入 memory_revisions。
CREATE TABLE IF NOT EXISTS memory_records (
  id                TEXT PRIMARY KEY,        -- 例 'L3-fact-m9k2x1-a1b2c3d4'
  layer             TEXT NOT NULL REFERENCES layers(id),
  kind              TEXT NOT NULL,           -- atom/episode/summary/fact/preference/decision/profile/entity/relation/custom
  text              TEXT NOT NULL,
  text_seg          TEXT NOT NULL DEFAULT '',-- 中文二元组切分检索串
  summary           TEXT,
  importance        REAL NOT NULL DEFAULT 0.5 CHECK (importance BETWEEN 0 AND 1),
  confidence        REAL NOT NULL DEFAULT 0.5 CHECK (confidence BETWEEN 0 AND 1),
  session_id        TEXT,
  workspace         TEXT,
  tags_json         TEXT NOT NULL DEFAULT '[]',
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL,
  valid_from        INTEGER,                 -- 语义有效期起点（epoch ms；NULL=未知）
  valid_to          INTEGER,                 -- 语义有效期终点（NULL=仍有效）；被取代时写入
  supersedes_json   TEXT NOT NULL DEFAULT '[]', -- 本记录取代的旧记录 id 数组
  superseded_by     TEXT,                    -- 反向指针：取代本记录的新 id（内部字段）
  revision          INTEGER NOT NULL DEFAULT 1,
  content_hash      TEXT NOT NULL,           -- 同层同内容去重键
  embedding_model   TEXT REFERENCES embedding_models(model_id),
  embedding_dim     INTEGER,
  embedding_version TEXT,
  status            TEXT NOT NULL DEFAULT 'active'
                    CHECK (status IN ('active', 'archived', 'pending_validation')),
  -- 内部治理字段（检索/晋升用，不暴露给模型；status 工具可汇总）
  heat              REAL NOT NULL DEFAULT 0 CHECK (heat BETWEEN 0 AND 1),
  access_count      INTEGER NOT NULL DEFAULT 0,
  last_access_at    INTEGER,
  created_seq       INTEGER NOT NULL DEFAULT 0, -- 产生该记录的 raw 水位（重建/增量依据）
  meta_json         TEXT NOT NULL DEFAULT '{}'
) STRICT;

-- 同一层"活跃"内容去重：重复陈述命中已有记录时做 revision++（不新增行）。
CREATE UNIQUE INDEX IF NOT EXISTS ux_mem_active_dedup
  ON memory_records(layer, content_hash) WHERE status = 'active';

CREATE INDEX IF NOT EXISTS ix_mem_layer_status   ON memory_records(layer, status, updated_at);
CREATE INDEX IF NOT EXISTS ix_mem_layer_kind     ON memory_records(layer, kind);
CREATE INDEX IF NOT EXISTS ix_mem_session        ON memory_records(session_id, updated_at);
CREATE INDEX IF NOT EXISTS ix_mem_workspace      ON memory_records(workspace, updated_at);
CREATE INDEX IF NOT EXISTS ix_mem_valid          ON memory_records(valid_to, valid_from);
CREATE INDEX IF NOT EXISTS ix_mem_hash           ON memory_records(content_hash);
CREATE INDEX IF NOT EXISTS ix_mem_importance     ON memory_records(importance DESC, updated_at DESC);
CREATE INDEX IF NOT EXISTS ix_mem_access         ON memory_records(last_access_at DESC);
CREATE INDEX IF NOT EXISTS ix_mem_created_seq    ON memory_records(created_seq);

-- 派生记忆 FTS5：external content 模式，内容列 text_seg，rowid 跟随 memory_records.rowid。
-- 由 §9 触发器维护；MATCH 查询 JOIN memory_records ON rowid 取回记录。
CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
  text_seg,
  content = 'memory_records',
  content_rowid = 'rowid',
  tokenize = 'unicode61 remove_diacritics 2'
);

-- 派生记忆修订历史（append-only）：每次 text/importance/confidence/有效期 变更前，
-- 先把旧版本快照写入本表，保证"新记忆取代旧记忆"时历史可追溯、可审计。
CREATE TABLE IF NOT EXISTS memory_revisions (
  id          INTEGER PRIMARY KEY,
  memory_id   TEXT NOT NULL REFERENCES memory_records(id) ON DELETE CASCADE,
  revision    INTEGER NOT NULL,
  text        TEXT NOT NULL,
  summary     TEXT,
  importance  REAL NOT NULL,
  confidence  REAL NOT NULL,
  valid_from  INTEGER,
  valid_to    INTEGER,
  status      TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  change_kind TEXT NOT NULL,               -- supersede | update | archive | merge | rebuild
  changed_at  INTEGER NOT NULL,
  meta_json   TEXT NOT NULL DEFAULT '{}',
  UNIQUE(memory_id, revision)
) STRICT;

CREATE INDEX IF NOT EXISTS ix_memrev_memory ON memory_revisions(memory_id, revision DESC);

-- 溯源：派生记录 → 原始记录（多对多）。正常写入只追加；重建该层时随层内容一起重置。
CREATE TABLE IF NOT EXISTS memory_sources (
  memory_id  TEXT NOT NULL REFERENCES memory_records(id) ON DELETE CASCADE,
  raw_id     TEXT NOT NULL,                -- raw_index.id（逻辑外键：索引可能滞后于文件）
  relation   TEXT NOT NULL DEFAULT 'derived_from'
             CHECK (relation IN ('derived_from', 'supports', 'cites', 'supersedes')),
  weight     REAL NOT NULL DEFAULT 1.0 CHECK (weight > 0),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (memory_id, raw_id, relation)
) STRICT;

CREATE INDEX IF NOT EXISTS ix_memsrc_raw ON memory_sources(raw_id);

-- ============================================================================
-- 5. 层私有扩展表（L2 情节 / L3 语义）
-- ============================================================================

-- L2 情节层：一段会话/时间窗的分页摘要等结构信息；主文本仍在 memory_records.text。
CREATE TABLE IF NOT EXISTS layer_l2_episodes (
  memory_id     TEXT PRIMARY KEY REFERENCES memory_records(id) ON DELETE CASCADE,
  session_id    TEXT,
  topic         TEXT,
  start_ts      INTEGER NOT NULL,
  end_ts        INTEGER NOT NULL,
  turn_count    INTEGER NOT NULL DEFAULT 0,
  raw_first_id  TEXT,
  raw_last_id   TEXT,
  page_ids_json TEXT NOT NULL DEFAULT '[]',   -- 组成该情节的 L1 记录 id
  heat          REAL NOT NULL DEFAULT 0 CHECK (heat BETWEEN 0 AND 1),
  promoted_at   INTEGER
) STRICT;

CREATE INDEX IF NOT EXISTS ix_l2_session ON layer_l2_episodes(session_id, start_ts);

-- L3 语义层：事实/偏好/决策/画像的结构化主体-谓词-客体与有效期。
-- 一条 memory_record 至多一行；entity_id 可空（纯偏好可能无实体）。
CREATE TABLE IF NOT EXISTS layer_l3_semantic (
  memory_id     TEXT PRIMARY KEY REFERENCES memory_records(id) ON DELETE CASCADE,
  category      TEXT NOT NULL
                CHECK (category IN ('fact', 'preference', 'decision', 'profile')),
  subject       TEXT,
  predicate     TEXT,
  object        TEXT,
  canonical_key TEXT,                      -- 规范化去重键，例 'user.pref.theme=dark'
  valid_from    INTEGER,
  valid_to      INTEGER,
  superseded_by TEXT REFERENCES memory_records(id) ON DELETE SET NULL,
  source_kind   TEXT NOT NULL DEFAULT 'deterministic'
                CHECK (source_kind IN ('deterministic', 'llm', 'manual')),
  extracted_by  TEXT                       -- 抽取器 id/版本，例 'rule:zh-preference@1'
) STRICT;

CREATE UNIQUE INDEX IF NOT EXISTS ux_l3_canonical_active
  ON layer_l3_semantic(canonical_key) WHERE valid_to IS NULL AND canonical_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS ix_l3_category ON layer_l3_semantic(category, valid_from);

-- ============================================================================
-- 6. 实体 / 关系（可选图，v1 可不启用；由 L3 派生，可重建）
-- ============================================================================

CREATE TABLE IF NOT EXISTS entities (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  canonical_name TEXT NOT NULL,            -- 小写/去空白后的规范化名
  type          TEXT NOT NULL,             -- person/project/tool/file/concept/org/...
  aliases_json  TEXT NOT NULL DEFAULT '[]',
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  meta_json     TEXT NOT NULL DEFAULT '{}'
) STRICT;

CREATE UNIQUE INDEX IF NOT EXISTS ux_entity_type_name ON entities(type, canonical_name);

CREATE TABLE IF NOT EXISTS entity_mentions (
  entity_id  TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  memory_id  TEXT NOT NULL REFERENCES memory_records(id) ON DELETE CASCADE,
  span_start INTEGER,
  span_end   INTEGER,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (entity_id, memory_id)
) STRICT;

CREATE INDEX IF NOT EXISTS ix_entity_mention_memory ON entity_mentions(memory_id);

CREATE TABLE IF NOT EXISTS relations (
  id              TEXT PRIMARY KEY,
  from_entity     TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  predicate       TEXT NOT NULL,
  to_entity       TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  valid_from      INTEGER,
  valid_to        INTEGER,
  confidence      REAL NOT NULL DEFAULT 0.5 CHECK (confidence BETWEEN 0 AND 1),
  source_memory_id TEXT REFERENCES memory_records(id) ON DELETE SET NULL,
  created_at      INTEGER NOT NULL,
  meta_json       TEXT NOT NULL DEFAULT '{}'
) STRICT;

CREATE INDEX IF NOT EXISTS ix_rel_from ON relations(from_entity, predicate);
CREATE INDEX IF NOT EXISTS ix_rel_to   ON relations(to_entity, predicate);
CREATE INDEX IF NOT EXISTS ix_rel_valid ON relations(valid_to);

-- ============================================================================
-- 7. 向量存储（Float32 BLOB，无向量扩展；维度/模型/版本随行存）
-- ============================================================================

-- vec = dim × float32 小端序，长度必须 = dim*4；norm = 写入时 L2 范数（应为 1，冗余校验）。
-- 同 (owner_kind, owner_id, model, version) 幂等覆盖（重算向量不产生重复行）。
CREATE TABLE IF NOT EXISTS vectors (
  owner_kind  TEXT NOT NULL CHECK (owner_kind IN ('memory', 'raw')),
  owner_id    TEXT NOT NULL,               -- memory_records.id 或 raw_index.id
  model       TEXT NOT NULL,               -- 对应 embedding_models.model_id
  version     TEXT NOT NULL,
  dim         INTEGER NOT NULL CHECK (dim > 0),
  vec         BLOB NOT NULL,               -- Float32 小端 BLOB
  norm        REAL NOT NULL DEFAULT 1.0,
  text_hash   TEXT NOT NULL,               -- 被嵌入文本的 sha256：文本变了才重算
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (owner_kind, owner_id, model, version)
) STRICT;

CREATE INDEX IF NOT EXISTS ix_vec_owner ON vectors(owner_kind, owner_id);
CREATE INDEX IF NOT EXISTS ix_vec_model ON vectors(model, version);
CREATE INDEX IF NOT EXISTS ix_vec_text_hash ON vectors(text_hash);

-- ============================================================================
-- 8. 派生任务 / 水位 / 巡检 / 修复（崩溃恢复与可重建性的支撑）
-- ============================================================================

-- 增量派生水位：每层记录已处理到的 raw seq；rebuild 时清空该层数据并把水位归零。
CREATE TABLE IF NOT EXISTS derive_cursors (
  layer       TEXT PRIMARY KEY REFERENCES layers(id),
  last_raw_seq INTEGER NOT NULL DEFAULT 0,
  updated_at  INTEGER NOT NULL,
  meta_json   TEXT NOT NULL DEFAULT '{}'
) STRICT;

-- 派生任务队列（含可选 LLM 整理任务）。dedup_key 保证同一输入的重复入队幂等。
CREATE TABLE IF NOT EXISTS derive_jobs (
  job_id      TEXT PRIMARY KEY,
  layer       TEXT NOT NULL,
  job_kind    TEXT NOT NULL,               -- derive | consolidate_summary | consolidate_semantic | llm_extract | embed_backfill
  dedup_key   TEXT NOT NULL,               -- 例 'L1:seq=1..64'；同一 key 只执行一次
  payload_json TEXT NOT NULL DEFAULT '{}',
  status      TEXT NOT NULL DEFAULT 'pending'
              CHECK (status IN ('pending', 'running', 'done', 'failed', 'skipped')),
  attempts    INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  priority    INTEGER NOT NULL DEFAULT 100,
  scheduled_at INTEGER NOT NULL,
  started_at  INTEGER,
  finished_at INTEGER,
  heartbeat_at INTEGER,                    -- running 超时视为崩溃，可重试
  last_error  TEXT,
  result_json TEXT
) STRICT;

CREATE UNIQUE INDEX IF NOT EXISTS ux_job_dedup ON derive_jobs(dedup_key);
CREATE INDEX IF NOT EXISTS ix_job_status ON derive_jobs(status, priority, scheduled_at);
CREATE INDEX IF NOT EXISTS ix_job_layer ON derive_jobs(layer, status);

-- 完整性巡检记录（启动 quick_check / 手动 verify / fsck 的结果，append-only）。
CREATE TABLE IF NOT EXISTS integrity_runs (
  id               INTEGER PRIMARY KEY,
  kind             TEXT NOT NULL,          -- sqlite_quick_check | raw_chain | manifest | full_fsck
  started_at       INTEGER NOT NULL,
  finished_at      INTEGER,
  records_checked  INTEGER NOT NULL DEFAULT 0,
  segments_checked INTEGER NOT NULL DEFAULT 0,
  ok               INTEGER,
  details_json     TEXT NOT NULL DEFAULT '{}'
) STRICT;

-- 修复日志（append-only）：崩溃恢复/截断半写行/补索引/同步 manifest 等动作。
CREATE TABLE IF NOT EXISTS repair_log (
  id         INTEGER PRIMARY KEY,
  ts         INTEGER NOT NULL,
  action     TEXT NOT NULL,                -- truncate_torn_tail | adopt_orphan | rebuild_index | sync_manifest | ...
  target     TEXT,                         -- segment / raw id / layer
  detail_json TEXT NOT NULL DEFAULT '{}'
) STRICT;

-- ============================================================================
-- 9. 触发器：不可变性与 FTS 同步
-- ============================================================================

-- 9.1 raw_index 不可变：任何 UPDATE 视为篡改，直接 ABORT。
CREATE TRIGGER IF NOT EXISTS tr_raw_index_no_update
BEFORE UPDATE ON raw_index
BEGIN
  SELECT RAISE(ABORT, 'raw_index is append-only: UPDATE forbidden');
END;

-- 9.2 raw_index 不可删除（重建索引请 DROP TABLE + 重放文件，见 docs/20 §6.5）。
CREATE TRIGGER IF NOT EXISTS tr_raw_index_no_delete
BEFORE DELETE ON raw_index
BEGIN
  SELECT RAISE(ABORT, 'raw_index is append-only: DELETE forbidden');
END;

-- 9.3 派生修订历史不可修改（只允许新增/随层重建删除）。
CREATE TRIGGER IF NOT EXISTS tr_memory_revisions_no_update
BEFORE UPDATE ON memory_revisions
BEGIN
  SELECT RAISE(ABORT, 'memory_revisions is append-only: UPDATE forbidden');
END;

-- 9.4 溯源链接不可修改（新增/删除仅由写入与重建流程控制）。
CREATE TRIGGER IF NOT EXISTS tr_memory_sources_no_update
BEFORE UPDATE ON memory_sources
BEGIN
  SELECT RAISE(ABORT, 'memory_sources is append-only: UPDATE forbidden');
END;

-- 9.5 memory_fts（external content）同步：INSERT / DELETE / UPDATE 三支。
CREATE TRIGGER IF NOT EXISTS tr_memory_fts_ai
AFTER INSERT ON memory_records
BEGIN
  INSERT INTO memory_fts(rowid, text_seg) VALUES (new.rowid, new.text_seg);
END;

CREATE TRIGGER IF NOT EXISTS tr_memory_fts_ad
AFTER DELETE ON memory_records
BEGIN
  INSERT INTO memory_fts(memory_fts, rowid, text_seg) VALUES ('delete', old.rowid, old.text_seg);
END;

CREATE TRIGGER IF NOT EXISTS tr_memory_fts_au
AFTER UPDATE OF text_seg ON memory_records
BEGIN
  INSERT INTO memory_fts(memory_fts, rowid, text_seg) VALUES ('delete', old.rowid, old.text_seg);
  INSERT INTO memory_fts(rowid, text_seg) VALUES (new.rowid, new.text_seg);
END;

-- 9.6 派生记录被删除前，必须已把旧版本写入 memory_revisions（由 store 层保证），
--     这里仅保护"L3 语义条目禁止物理删除"，避免误删长期记忆历史。
CREATE TRIGGER IF NOT EXISTS tr_l3_no_delete
BEFORE DELETE ON memory_records
WHEN old.layer = 'L3'
BEGIN
  SELECT RAISE(ABORT, 'L3 semantic memory must not be deleted; use status=archived / valid_to instead');
END;

-- 9.7 级联说明（与 docs/20 §7.1.1 clearLayer / §14.4 rebuild 对应）：
--     memory_sources / memory_revisions / layer_l2_episodes / layer_l3_semantic / entity_mentions
--     对 memory_records(id) 使用 ON DELETE CASCADE，目的是让 clearLayer('L1'|'L2') 的物理重建
--     能一次性清理子行（L3 记录受 tr_l3_no_delete 保护，永远不会走到级联删除）；
--     relations.source_memory_id / layer_l3_semantic.superseded_by 使用 ON DELETE SET NULL，
--     保留图/版本指针语义。vectors 不设外键（owner 可为 memory 或 raw），由 clearLayer 显式删除。

-- ============================================================================
-- 10. 只读视图（供 status 工具 / 只读 Web UI / 巡检使用）
-- ============================================================================

CREATE VIEW IF NOT EXISTS v_layer_stats AS
SELECT l.id                         AS layer,
       l.name                       AS name,
       l.version                    AS version,
       COUNT(m.id)                  AS total,
       SUM(CASE WHEN m.status = 'active' THEN 1 ELSE 0 END) AS active,
       SUM(CASE WHEN m.status = 'archived' THEN 1 ELSE 0 END) AS archived,
       MAX(m.updated_at)            AS latest_updated_at
FROM layers l
LEFT JOIN memory_records m ON m.layer = l.id
GROUP BY l.id, l.name, l.version;

CREATE VIEW IF NOT EXISTS v_memory_active AS
SELECT id, layer, kind, text, summary, importance, confidence, valid_from, valid_to,
       revision, session_id, workspace, updated_at, heat, access_count
FROM memory_records
WHERE status = 'active';

CREATE VIEW IF NOT EXISTS v_raw_recent AS
SELECT id, seq, ts, iso, day, kind, session_id, workspace, role,
       substr(COALESCE(text, ''), 1, 200) AS text_preview, segment, line_no
FROM raw_index
ORDER BY seq DESC;

-- 溯源完整性巡检：指向不存在的 raw id 的派生链接（应为空）。
CREATE VIEW IF NOT EXISTS v_orphan_sources AS
SELECT s.memory_id, s.raw_id, s.relation
FROM memory_sources s
LEFT JOIN raw_index r ON r.id = s.raw_id
WHERE r.id IS NULL;

-- 向量覆盖率：每层有多少记录已嵌入（embed_backfill 任务依据；空层也返回 0 行）。
CREATE VIEW IF NOT EXISTS v_embedding_coverage AS
SELECT l.id AS layer,
       COUNT(m.id) AS total,
       SUM(CASE WHEN v.owner_id IS NOT NULL THEN 1 ELSE 0 END) AS embedded
FROM layers l
LEFT JOIN memory_records m ON m.layer = l.id
LEFT JOIN vectors v
  ON v.owner_kind = 'memory' AND v.owner_id = m.id
     AND v.model = COALESCE(m.embedding_model, 'dsh-local-hash-v1')
GROUP BY l.id;

-- 待补算向量的记录（UI / 任务用）。
CREATE VIEW IF NOT EXISTS v_missing_vectors AS
SELECT m.id, m.layer, m.text, m.embedding_model, m.embedding_dim, m.embedding_version
FROM memory_records m
LEFT JOIN vectors v ON v.owner_kind = 'memory' AND v.owner_id = m.id
WHERE v.owner_id IS NULL;

-- ============================================================================
-- 11. 初始化提示（实现层在 migration 1 之后执行，不属于 DDL）
-- ----------------------------------------------------------------------------
-- 1) 生成 vault_id（crypto.randomUUID）写入 meta：
--      UPDATE meta SET value = json_quote(?), updated_at = ? WHERE key = 'vault_id';
-- 2) 写入 created_at / timezone / embedding_model / embedding_dim / embedding_version。
-- 3) 创建派生层水位行：
--      INSERT OR IGNORE INTO derive_cursors(layer, last_raw_seq, updated_at)
--        SELECT id, 0, ? FROM layers WHERE kind = 'builtin';
-- 4) 启动时 QuickCheck：PRAGMA quick_check; 失败则进入只读/修复流程（docs/20 §5.7）。
-- ============================================================================
`;

/** migration 1 DDL 的 sha256（写入 schema_migrations.checksum） */
export const SCHEMA_V1_SHA256 = '7f0e4b81421bb330c4aef18d49581655d3713cca0c75e36245c471d9bfbeca01';

/** docs/21-schema.sql 整文件的 sha256（测试对账用） */
export const SCHEMA_V1_DOC_SHA256 = '2dd8fa7a969eb50251f55fdc1cdd1fd4b82b8d741a94353cef1e23858e77dd24';

/** migration 1 描述 */
export const SCHEMA_V1_DESCRIPTION = 'initial schema: raw mirror + derived layers + vectors + fts5 + jobs';

/** migration 2：记忆分层模型（short/mid/long）治理列/索引/视图（docs/23-memory-models §5） */
export const MIGRATION_2_SQL = String.raw`-- ============================================================================
-- migration 2: 记忆分层模型（短期 / 中期 / 长期 retention）治理列
-- 来源：docs/23-memory-models.md §5（docs/21 保持 migration 1 不变，只增不改）
-- 只给 memory_records 增加 retention 治理列/索引/视图 + 修正内置层显示名；不修改历史 migration。
-- ============================================================================
ALTER TABLE memory_records ADD COLUMN retention_tier  TEXT NOT NULL DEFAULT 'short'
  CHECK (retention_tier IN ('short', 'mid', 'long'));
ALTER TABLE memory_records ADD COLUMN retention_score REAL NOT NULL DEFAULT 0
  CHECK (retention_score BETWEEN 0 AND 1);
ALTER TABLE memory_records ADD COLUMN pinned           INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0, 1));
ALTER TABLE memory_records ADD COLUMN promoted_at      INTEGER;
ALTER TABLE memory_records ADD COLUMN long_term_at     INTEGER;

CREATE INDEX IF NOT EXISTS ix_mem_retention
  ON memory_records(retention_tier, retention_score DESC, updated_at DESC);
CREATE INDEX IF NOT EXISTS ix_mem_pinned
  ON memory_records(pinned, layer) WHERE pinned = 1;

CREATE VIEW IF NOT EXISTS v_retention_stats AS
SELECT retention_tier       AS tier,
       COUNT(*)             AS total,
       MAX(retention_score) AS max_score,
       AVG(retention_score) AS avg_score,
       MAX(updated_at)      AS last_updated
FROM memory_records
GROUP BY retention_tier;

-- docs/23-memory-models §2 内置层显示名统一（治理元数据，非内容；幂等）
-- migration 1 是逐字节锁定的历史迁移，不修改其 seed；升级路径在本 migration 尾部修正。
UPDATE layers SET name = 'L1 工作记忆层' WHERE id = 'L1' AND kind = 'builtin';
UPDATE layers SET name = 'L2 情景记忆层' WHERE id = 'L2' AND kind = 'builtin';
UPDATE layers SET name = 'L3 语义记忆层' WHERE id = 'L3' AND kind = 'builtin';
`;

/** migration 2 DDL 的 sha256 */
export const MIGRATION_2_SHA256 = 'a9c8d8834e50fa6719fa02cce1dcd900d8403abca668f764774dad070571bc7f';

/** migration 2 描述 */
export const MIGRATION_2_DESCRIPTION = 'retention tiers: short/mid/long governance columns + indexes + stats view + builtin layer display names';

/** migration 3：原始层永久向量索引 + 遗忘策略（docs/24-memory-access-forgetting.md） */
export const MIGRATION_3_SQL = String.raw`-- ============================================================================
-- migration 3: 访问分工与遗忘（docs/24-memory-access-forgetting.md）
--   - 原始层向量索引：owner_kind='raw' 永久、只追加（触发器禁 UPDATE/DELETE）
--   - 三层记忆遗忘：short 到期物理删除 / mid 到期归档 / long 永久（只强化 L3 long 保护）
-- 只增索引/触发器，不改历史 migration 字节。
-- ============================================================================
CREATE INDEX IF NOT EXISTS ix_vectors_owner_kind ON vectors(owner_kind, model, dim, version);
CREATE INDEX IF NOT EXISTS ix_mem_forget ON memory_records(retention_tier, layer, updated_at)
  WHERE status = 'active';

-- 原始层向量不可变：raw 向量只追加，禁止 UPDATE/DELETE（重建走 rebuildRawVectors）
CREATE TRIGGER IF NOT EXISTS tr_raw_vectors_no_update BEFORE UPDATE ON vectors
  WHEN old.owner_kind = 'raw'
BEGIN
  SELECT RAISE(ABORT, 'raw vectors are append-only: UPDATE forbidden');
END;
CREATE TRIGGER IF NOT EXISTS tr_raw_vectors_no_delete BEFORE DELETE ON vectors
  WHEN old.owner_kind = 'raw'
BEGIN
  SELECT RAISE(ABORT, 'raw vectors are append-only: DELETE forbidden');
END;

-- L3 保护收窄：仅长期（long）禁止物理删除；short/mid 允许随遗忘删除（docs/24 §2）
DROP TRIGGER IF EXISTS tr_l3_no_delete;
CREATE TRIGGER IF NOT EXISTS tr_l3_long_no_delete BEFORE DELETE ON memory_records
  WHEN old.layer = 'L3' AND old.retention_tier = 'long'
BEGIN
  SELECT RAISE(ABORT, 'long-term L3 memory must not be deleted');
END;
`;

/** migration 3 DDL 的 sha256 */
export const MIGRATION_3_SHA256 = '73ce8725144a132713d1174ce99be3f09d8f7680b9cf1b67e7214c3e0d8b2672';

/** migration 3 描述 */
export const MIGRATION_3_DESCRIPTION = 'access split + forgetting: raw vector immutable indexes/triggers + L3 long-term delete guard';

/** migration 4：人格（persona）记忆作用域列/索引（docs/25-persona.md §7） */
export const MIGRATION_4_SQL = String.raw`-- ============================================================================
-- migration 4: 人格（persona）记忆作用域（docs/25-persona.md §7）
--   - memory_records.persona_id：派生记忆的人格归属（NULL = 共享）
--   - raw_index.persona_id：原始记录的索引元数据（NULL = 共享；**不进 L0 行/哈希**）
-- 只增列/索引，不改历史 migration 字节；历史行 persona_id 保持 NULL（共享）。
-- ============================================================================
ALTER TABLE memory_records ADD COLUMN persona_id TEXT;
ALTER TABLE raw_index      ADD COLUMN persona_id TEXT;

CREATE INDEX IF NOT EXISTS ix_mem_persona ON memory_records(persona_id, layer, status);
CREATE INDEX IF NOT EXISTS ix_raw_persona ON raw_index(persona_id, ts);
`;

/** migration 4 DDL 的 sha256 */
export const MIGRATION_4_SHA256 = 'c322e88ce686bd38498c01760ff34de7188770c9563beb9047973641a62e4cef';

/** migration 4 描述 */
export const MIGRATION_4_DESCRIPTION = 'persona memory scope: memory_records.persona_id + raw_index.persona_id + indexes';

/** 迁移定义（按 version 升序；只追加，不修改已发布项） */
export interface SchemaMigration {
  version: number;
  description: string;
  sql: string;
  sha256: string;
}

/** 全部已知 migration（migrations.ts 按 version 顺序应用缺失项） */
export const MIGRATIONS: readonly SchemaMigration[] = [
  { version: 1, description: SCHEMA_V1_DESCRIPTION, sql: SCHEMA_V1_SQL, sha256: SCHEMA_V1_SHA256 },
  { version: 2, description: MIGRATION_2_DESCRIPTION, sql: MIGRATION_2_SQL, sha256: MIGRATION_2_SHA256 },
  { version: 3, description: MIGRATION_3_DESCRIPTION, sql: MIGRATION_3_SQL, sha256: MIGRATION_3_SHA256 },
  { version: 4, description: MIGRATION_4_DESCRIPTION, sql: MIGRATION_4_SQL, sha256: MIGRATION_4_SHA256 },
];

/** `PRAGMA user_version` 语句（所有 migration 成功后执行） */
export const USER_VERSION_PRAGMA = `PRAGMA user_version = ${STORE_SCHEMA_VERSION};`;

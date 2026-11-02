# `src/store/` — SQLite 存储层实现说明（给层实现/集成/QA）

本目录实现 `contracts.ts` 的 `MemoryStore`。数据库文件：`<config.dataDir>/vault.db`。
DDL 权威来源：`docs/21-schema.sql`（`src/store/schema.ts` 由脚本逐字节嵌入为 migration 1，
`tests/core/store.test.ts` 用 sha256 对账，禁止手改 schema.ts）。

## 公共入口

```ts
import { openStore } from '../store/index.ts';

// 1) 生产：直接吃 MemoryVaultConfig
const store = openStore(config, { logger });

// 2) 测试/最小输入
const store = openStore({ dataDir, timezone: 'Asia/Shanghai', embedding }, { logger, now, strictProvenance });
const mem = openStore({ dataDir: ':memory:' });   // 仅测试
```

- `openStore` 同步执行：连接 PRAGMA（docs §7.2）→ migration（user_version）→ meta 初始化。
- 重复打开同一目录是幂等的（schema checksum 校验；mismatch 立即抛错，防手改 migration）。
- `store.db` 是原始 `DatabaseSync`（给扩展层建私有表/查询）；**禁止**直接改
  `raw_index`/`raw_fts`/`memory_records`（前者有触发器；后者请走 API）。
- `store.transaction(fn)`：`BEGIN IMMEDIATE`；嵌套调用合并为外层事务。
  layers 应写成 `store.transaction(() => { upsertMemory(...); putL2Episode(...); putVector(...); })`。

## 表/视图与本实现的行为

| 表 | 本实现职责 |
|---|---|
| `meta` | 初始化 `vault_id`/`created_at`/`timezone`/`embedding_model/dim/version`/`schema_version`；`getMeta/setMeta` 以 JSON 字符串存 value |
| `schema_migrations` | migration 1 登记；checksum = schema DDL sha256 |
| `counters` | `indexRawRecords` 时把 `raw.seq`、`day.<date>` 推进到 max（幂等） |
| `embedding_models` | 打开时登记配置的 `EmbeddingRef`；同 model 不同 dim/version 抛错（不混向量空间） |
| `layers` | 读 `listLayers()`；扩展层由调用方自行 INSERT（`db` 或注册表） |
| `raw_index` / `raw_fts` / `raw_segments` | **只插入**；`indexRawRecords(RawAppendItem[])` 幂等收养；UPDATE/DELETE 被触发器 ABORT |
| `memory_records` | `upsertMemory` 写入；`content_hash` 由 `sha256(layer\0kind\0normalizeText(text))` 计算 |
| `memory_fts` | external content + 触发器自动同步；无需手写 |
| `memory_revisions` | 同 id 内容/有效期/状态变化前快照旧版本（`update/supersede/archive/restate`） |
| `memory_sources` | `sourceRawIds` 规范化为行；重述时 `INSERT OR IGNORE` 追加 |
| `layer_l2_episodes` / `layer_l3_semantic` | `putL2Episode`/`putL3Semantic`/`getL3Semantic`（幂等 ON CONFLICT） |
| `vectors` | Float32 小端 BLOB；PK(owner_kind,owner_id,model,version) 幂等覆盖；写前 L2 归一化 |
| `derive_cursors` | `get/setDeriveCursor`（只允许前进；`clearLayer` 归零） |
| `integrity_runs` / `repair_log` | `recordIntegrityRun`/`listIntegrityRuns`/`getLastIntegrityRun`/`listRepairLog` |
| 视图 | `v_layer_stats`（layerStats/listLayers）、`v_embedding_coverage`（embeddingCoverage）等 |

## `upsertMemory` 语义（docs §8.4）

1. 校验：id 格式（§8.1）/layer 已注册且 enabled/kind/text 长度与控制字符/tags/sourceRawIds/
   validFrom ≤ validTo/importance,confidence clamp 到 0..1。
2. 显式 `id` 权威，不重分配；无 id 时确定性派生 `<layer>-<kind>-<base36(createdAt)>-<contentHash8>`。
3. 同 id 命中：
   - 内容相关字段完全一致 → **NOOP**（revision 不变；仅当新增 sourcing 时按"重述"处理）；
   - 有变化（text/summary/importance/confidence/validFrom/validTo/status/tags/meta/…）→
     快照旧版本到 `memory_revisions`，UPDATE，`revision++`，`updated_at=now`。
4. 同层同 kind 同 `content_hash` 且状态 active 的**不同 id** → 不新增行（重述：追加来源、
   revision++、heat 更新），返回已有记录。（L1 若需"一 raw 一 atom 且文本相同"，请在
   层内 contentHash 种子中加入 raw id，避免碰撞。）
5. `supersedes`：把旧记录 `valid_to=now-1`（或新 validFrom-1）、`superseded_by=newId`，
   写 `supersede` 快照；**旧行永不删除**。
6. 传 `embedding` 时同事务写 `vectors` 并更新 `memory_records.embedding_*`。

## 检索语义（与 docs §10.3 对齐）

- `searchLexical(query)`：`tokenizeTextSeg` 切 token → FTS5 MATCH `"tok" "tok"`（AND）；
  0 命中降级 OR；仍 0 且为极短 CJK（如单字）→ `LIKE` 降级（固定 score 0.25）。
  **返回的 `LexHit.score` 已是归一化 [0,1)**：`b=max(0,-bm25)`，`score=b/(1+b)`。
  只返回 `status='active'` 的记录。
- `searchVector(query, ref, opts)`：暴力余弦（全量扫 `vectors` + JOIN 过滤），`VecHit.score`
  是**原始 cosine ∈ [-1,1]**（未 clamp）；只返回 active；`minScore` 按原始 cosine 过滤。
- `listMemories` 默认 `updated_at DESC`；`onlyValid` 用 `valid_to IS NULL OR valid_to > now`。
- `touchMemories` 只更新治理列（access_count/last_access_at/heat，heat 公式 docs §4.3）。
- `clearLayer('L1'|'L2')` 物理删除（CASCADE + FTS 触发器 + vectors 显式删），光标归零；
  `clearLayer('L3')` 默认抛错，必须 `{ archive: true }`（archive + 快照 + 光标归零）。

## 记忆分层模型（retention：短期/中期/长期，migration 2）

两套模型**正交**：每条记忆同时有 `layer ∈ {L1,L2,L3}`（工作/情景/语义，内容类型）与
`retentionTier ∈ {short,mid,long}`（保留期阶梯）。retention 只升不降、永不删除。

| 存储/API | 说明 |
|---|---|
| 列 | `retention_tier`（默认 `short`）、`retention_score`（0..1）、`pinned`、`promoted_at`（晋升到当前层时间）、`long_term_at`（晋升到 long 的时间） |
| 索引 | `ix_mem_retention(retention_tier, retention_score DESC, updated_at DESC)`、`ix_mem_pinned(pinned, layer) WHERE pinned=1` |
| 视图 | `v_retention_stats(tier,total,max_score,avg_score,last_updated)` |
| `setRetention(id, state, now?)` / `setRetentionBatch(updates, now?)` | 只改治理列；**target tier 低于当前时整条忽略（不降级）**；晋升写 `promoted_at`，进 `long` 写 `long_term_at`；同层写允许刷新 score/pinned 但不覆盖已有时间戳（tick 幂等）；batch 单事务 |
| `getRetention(id)` / `retentionStats()` | `{tier,score,pinned,promotedAt,longTermAt}` / `{short,mid,long,pinned,lastTickAt}`（lastTickAt 读 meta `retention.lastTickAt`） |
| `listByRetention(tier,{limit,offset})` | `status='active'`，按 score DESC, updated_at DESC（默认 limit 100） |
| `listRetentionCandidates({since?,limit,offset})` | 引擎 tick 候选：`retention_tier != 'long'` 或 `updated_at >= since`（默认 now-30d），按 updated_at DESC |
| `getRetentionMeta/setRetentionMeta` | meta 表键值（如 `retention.lastTickAt`） |
| `upsertMemory({...,pinned})` | 新记录默认 `short`；pinned 只是治理标记（store 不改 tier）；更新时未传 pinned 则保留既有值，pinned 变更不 bump revision |
| `MemoryQuery.retentionTiers?/pinned?` | `listMemories` 过滤；所有返回的 `MemoryRecord` 都带 retention 字段 |

Migration 2：v1 旧库打开时**原地 ALTER** 加列/索引/视图（历史行默认 `short`），幂等、单事务；
`user_version=2`、`schema_migrations` v2 行、checksum 守卫。migration 2 尾部还会幂等修正内置层显示名为 `L1 工作记忆层 / L2 情景记忆层 / L3 语义记忆层`
（docs/23-memory-models §2；`layers` 是治理元数据，打开时 `openStore` 也会再兜底一次）；migration 1 字节内容不变
（`docs/21-schema.sql` 仍是 v1 权威；v2 以 `docs/23-memory-models.md` §5 与本文件为准）。

## 原始层永久向量模型（owner_kind='raw'，migration 3）

L0 原始层的向量索引是**永久、只追加、不可改删**的底座（docs/24 §3）；它与派生层的
"临时向量"（owner_kind='memory'，随遗忘删除）区分开。

| 项 | 说明 |
|---|---|
| 存储 | 复用 `vectors` 表：`owner_kind='raw'`、`owner_id=<raw id>`、`(model,version,dim)` 绑定向量空间 |
| 不可变性 | migration 3 触发器 `tr_raw_vectors_no_update/delete` 对 raw 行 UPDATE/DELETE 直接 ABORT |
| 写入 | `putRawVector(rawId, ref, vec)`：`INSERT OR IGNORE`（同 raw+model 只写一次、不更新）；raw 必须已在 raw_index |
| 读取/检索 | `getRawVector(rawId)`；`searchRawVector(query, ref, {limit,minScore})`（cosine 降序） |
| 词法 | `searchRawLexical(query, {limit,minScore})`：raw_fts BM25 归一化；小语料 bm25 量纲退化时用名次分 `1/(1+rank)` 兜底；单字 CJK 走 LIKE 兜底（0.25） |
| 回填 | `listRawWithoutVectors(ref, limit)`（**有文本**且缺向量的 raw，含 text；空文本 raw 按 docs/24 §3 跳过，不会造成回填饥饿）；`rawVectorStats(ref?)` → `{total,embedded,pending,ref,lastBackfillAt}`：`total`=raw 总数（含空文本）、`embedded`=该 ref 已写入的 raw 向量数、`pending`=有文本但缺向量（回填完成归零）；恒等式 `embedded + pending === 有文本 raw 数`、`embedded + pending <= total`（空文本 raw 只计入 total，**`total - pending` 不等于已嵌入数，UI 用 `embedded`**）；时间戳写 meta `raw_vectors.lastBackfillAt` |
| 重建 | `rebuildRawVectors()`：单事务内 DROP 两个触发器 → 清空 raw 向量 → 恢复触发器；返回 removed（随后由回填流程重嵌入） |

## 遗忘（三层记忆 short/mid/long，migration 3）

只作用于**派生层**，绝不触碰 L0 / raw_index / raw_fts / raw 向量（docs/24 §2）：

- `forgetDerivedMemories({tiers,layers,olderThan,mode,limit,protectPinned,protectImportance,now})`
  - `mode='delete'`（short 到期）：物理删除 `memory_records`（FK CASCADE 清理 sources/revisions/L2 私有行，
    FTS 由触发器同步，临时向量 `owner_kind='memory'` 显式删除），返回 `{deleted,archived:0,ids}`；
  - `mode='archive'`（mid 到期）：`status='archived'` + `valid_to=now` + `updated_at=now` +
    `memory_revisions` 快照 + revision++，返回 `{deleted:0,archived,ids}`；
  - 默认 tiers：delete→`['short']`，archive→`['mid']`；候选条件 `status='active'` 且 `updated_at <= olderThan`；
  - 默认保护 pinned 与 `importance >= protectImportance`；**L3 long 永不物理删除**（候选集排除 + DB 触发器兜底）。
- `forgettingStats()` / `recordForgetting({deletedShort?,archivedMid?}, now?)`：meta 计数器
  `forgetting.shortDeleted / midArchived / lastForgetAt`，recordForgetting 单事务原子累加。

## 人格（persona）记忆作用域（migration 4）

人格是**记忆作用域与身份注入层**（docs/25-persona）：每条派生记忆/原始记录可归属一个 persona，
与 layer / retention 正交。人格定义本身由 Host 层的 markdown 注册表管理（本 store 只存归属与激活 id）。

| 项 | 说明 |
|---|---|
| 列 | `memory_records.persona_id`、`raw_index.persona_id`（均可 NULL = 共享；migration 4 只加列/索引，历史行保持 NULL） |
| 索引 | `ix_mem_persona(persona_id, layer, status)`、`ix_raw_persona(persona_id, ts)` |
| L0 不变量 | persona 只是 **raw_index 索引元数据**：不写入 L0 行 JSON、不参与哈希/verify 字节比较（vault 只在内存 RawRecord 上携带 personaId 供索引） |
| 写入 | `upsertMemory({personaId})`：新记录显式值写入，未传 = NULL（共享）；**更新时显式传才改归属，不传保留旧值**；persona 变更属治理列（不 bump revision、不改 updated_at、不写 memory_revisions） |
| 读取 | `MemoryRecord.personaId` / `RawIndexRow.personaId` |
| memory 查询 | `listMemories({personaId})`：不传 = 不过滤；string 默认含共享（`includeSharedPersona` 默认 true）；`includeSharedPersona:false` = 仅该人格；`personaId:null` = 仅共享 |
| raw 查询 | `listRawIndex({personaId})`（`RawQuery.personaId`）：不传 = 不过滤；string = 该人格；null = 共享（精确匹配） |
| 激活人格 | `getActivePersonaId()` / `setActivePersonaId(id\|null)`：SQLite `meta.persona.active`；null/空串清除；重启保持 |
| 统计 | `countMemoriesByPersona()` → `{counts:{<personaId>:{total,L1,L2,L3}}, shared}`（仅 status='active'） |

migration 4：v1–v3 字节不变；旧库原地 ALTER 加两列/两索引（历史行 persona_id=NULL），幂等、单事务；sha 见 `schema.ts` 的 `MIGRATION_4_SHA256`。

## 已知取舍 / 注意

- `raw_index` 的 `created_at` 是**索引写入时间**（不是记录 ts）。
- `listRawIndex` 为省带宽**不返回 payload_json**（返回空串，docs §7.1.1：详情走文件）；
  `getRawIndex(id)` 返回完整 `payloadJson`。
- `raw_segments.sealed` 由 vault 的 manifest 权威维护；store 只做聚合 upsert（默认 0）。
- `putVector` 的 `text_hash` 取 owner 文本的 sha256（memory→text，raw→raw_index.text；
  查不到时退化为向量字节哈希）。
- `strictProvenance` 默认 **false**：`sourceRawIds` 只校验非空，不强制存在于 `raw_index`
  （便于派生层在索引补齐前重放/单测）；生产可开启 `openStore(..., { strictProvenance: true })`。
- 向量检索 v1 全量暴力（`docs §10.4` 允许）；`BruteForceIndex` 接口已在
  `src/search/cosine.ts` 预留，后续可替换 ANN。

// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hanxustu (dsh-life-memory)
/**
 * dsh-life-memory — 核心契约（Core contracts）
 * ---------------------------------------------------------------------------
 * 本文件是插件内部所有实现共同遵守的类型契约。任何实现（vault/store/embed/
 * search/layers/capture/tools/http）都必须以这里的类型为准，不得私自改变
 * 数据形状。改动契约必须先改本文件并通知所有实现者。
 *
 * 记忆架构：两套模型并存、正交组合（详见 docs/23-memory-models.md）
 * ---------------------------------------------------------------------------
 * A. 三层记忆模型（layer，内容类型/粒度；对应 CoALA 的 working/episodic/semantic）：
 *   L1  Working      工作记忆层：当前/近期的事件原子（每轮上下文的工作集来源）。
 *   L2  Episodic     情景记忆层：按会话/时间窗聚合的情节与摘要。
 *   L3  Semantic     语义记忆层：偏好/事实/决策/画像（版本化 + 取代链）。
 *   L4+              通过 LayerDefinition 注册的扩展类型层（procedural/project 等）。
 *
 * B. 记忆分层模型（retention，保留期；对应 STM/MTM/LTM）：
 *   short → mid → long  单调晋升（1 天 / 30 天等阈值 + 重要度/复述/钉住/种类驱动），
 *                       不自动降级、永不删除；每条记忆同时拥有 (layer, retentionTier)。
 *
 * L0 原始层（append-only JSONL）独立且不可变，是唯一事实来源，不属于上述任何模型。
 *
 * 不变量（invariants）：
 *   - L0 只追加；程序不得覆写、截断、删除已有原始记录。
 *   - 所有派生层可从 L0 重建；派生数据与原始数据分开存储。
 *   - 派生层永远保存 sourceRawIds 指回原始记录，可追溯（citation）。
 *   - retention 晋升只改治理列（retention_* / pinned），不改内容、不碰 L0。
 */

/** 插件 id / 存储命名空间 */
export const PLUGIN_ID = 'dsh-life-memory';

/** 原始记录格式版本（用于未来无损迁移；旧记录永不重写） */
export const RAW_RECORD_VERSION = 1 as const;

/** SQLite schema 版本（递增迁移；见 store/migrations.ts） */
export const STORE_SCHEMA_VERSION = 4;

/** 哈希链创世前驱值（64 个 0） */
export const GENESIS_HASH = '0'.repeat(64);

// ---------------------------------------------------------------------------
// 原始记忆层 L0
// ---------------------------------------------------------------------------

/** 原始记录种类。捕获端把 DSH 事件映射成这些种类；未知事件用 'event' 保底。 */
export type RawKind =
  | 'session' // 会话生命周期（created / loaded / resumed / forked / ended）
  | 'turn' // 一轮对话边界
  | 'user' // 用户消息（含附件引用）
  | 'assistant' // 助手消息（可能只含 reasoning/tool_call）
  | 'tool_call' // 工具调用请求
  | 'tool_result' // 工具执行结果
  | 'system' // 系统/环境事件（prompt 变更、compaction 等）
  | 'compaction' // 上下文压缩事件（压缩前的原始内容尤其重要）
  | 'event' // 其它宿主事件（原样保存 payload）
  | 'note'; // 程序/用户显式追加的备注类原始记录

/** 待追加的原始记录（由捕获层生成，尚未分配 id/hash） */
export interface RawRecordInput {
  /** 记录种类 */
  kind: RawKind;
  /** 捕获时间（epoch ms，UTC 毫秒） */
  ts: number;
  /** 生成该记录时的 IANA 时区，例如 Asia/Shanghai；用于计算日期编号 */
  timezone: string;
  /** DSH 会话 id（必填；非会话事件用 `system` 等固定值） */
  sessionId: string;
  /** 工作目录（DSH workspace 根），用于按工作区检索 */
  workspace?: string | null;
  /** DSH 轮次 id（若宿主提供） */
  turnId?: string | null;
  /** DSH step id（若宿主提供） */
  stepId?: string | null;
  /** 角色：user / assistant / tool / system（若适用） */
  role?: string | null;
  /** 模型可见的规范化纯文本（用户消息、助手文本、工具名+参数、工具结果文本） */
  text?: string | null;
  /**
   * 完整原始事件 JSON（无损原样保存，不做裁剪）。
   * 这是"原始记忆全保留"的载体：任何 DSH 事件字段都在这里。
   */
  payload: unknown;
  /** 附加标签（可选，例如 ['compaction','pre-before']） */
  tags?: string[];
  /**
   * 幂等投递键（推荐 `${sessionId}:${seq}` 或 `${sessionId}:${eventType}:${seq}`）。
   * 该键不写入 L0 行（docs/20 §5.2 的字节级格式不含传输元数据），由 SQLite
   * raw_index.ingest_key 唯一索引承担幂等；捕获层写入前用
   * `MemoryStore.hasRawIngestKey()` 判重。为空时由捕获层生成
   * `auto:${ts}:${sha256(payload)}`。
   */
  ingestKey?: string;
  /** 捕获端附加的元数据（不影响无损 payload；如 eventType/surfaceOp/turn/step） */
  meta?: Record<string, unknown>;
  /**
   * 捕获时的人格归属（人格 id；null/省略 = 共享记忆）。
   * 仅作为 raw_index 的检索元数据与派生层继承依据，**不写入 L0 行 JSON、不参与哈希**。
   */
  personaId?: string | null;
}

/**
 * 已落盘的原始记录（不可变）——即 docs/20 §5.2 的"行 JSON 字段"，
 * 字段顺序固定且参与哈希。传输元数据（ingestKey/段位置）不在此类型中，
 * 见 {@link RawAppendItem} / {@link RawIndexRow}。
 */
export interface RawRecord extends RawRecordInput {
  /** 原始记录 id：`YYYY-MM-DD-NNNNNN`（本地日期 + 当日 6 位序号） */
  id: string;
  /** 本地日期 YYYY-MM-DD（id 前缀，按 timezone 计算） */
  day: string;
  /** 全局单调递增序号（从 1 开始，永不复用，跨日不重置） */
  seq: number;
  /** ISO 8601 时间戳（含时区偏移），与 ts 对应 */
  iso: string;
  /** sha256(prevHash + "\n" + recordJsonWithoutHash) 十六进制（docs/20 §5.2） */
  hash: string;
  /** 上一条原始记录的 hash（哈希链）；第一条为 GENESIS_HASH */
  prevHash: string;
  /** 记录格式版本 */
  v: typeof RAW_RECORD_VERSION;
}

/** 落盘位置与传输元数据（不参与 L0 行哈希；镜像到 raw_index） */
export interface RawRecordLocation {
  ingestKey: string;
  /** 段文件相对路径（posix 分隔符） */
  segment: string;
  /** 段内行号（1 起） */
  lineNo: number;
  /** 段文件内起始字节偏移 */
  byteOffset: number;
  /** 该行字节长度（含换行符） */
  byteLen: number;
}

/** 一条已落盘原始记录 + 其位置 */
export interface RawAppendItem {
  record: RawRecord;
  location: RawRecordLocation;
}

/** 原始记录检索条件（文件层/索引层通用） */
export interface RawQuery {
  /** 起始时间（epoch ms，含） */
  from?: number;
  /** 结束时间（epoch ms，含） */
  to?: number;
  /** 本地日期（YYYY-MM-DD） */
  day?: string;
  sessionId?: string;
  workspace?: string;
  /** 按人格归属过滤（null = 共享；不传 = 不过滤） */
  personaId?: string | null;
  kinds?: RawKind[];
  /** 精确 id 列表（优先于其他条件） */
  ids?: string[];
  /** 按 id/seq 升序内的偏移与数量 */
  offset?: number;
  limit?: number;
  /** 是否按时间倒序（默认升序） */
  desc?: boolean;
}

/** 追加结果 */
export interface AppendResult {
  /** 本次实际新落盘的记录 + 位置（顺序与输入一致，已过滤掉重复 ingestKey） */
  items: RawAppendItem[];
  /** 本次因 ingestKey 已存在而跳过的数量 */
  skipped: number;
  /** 本次写入的分段文件相对路径 */
  segmentsWritten: string[];
}

/** L0 原始库构造参数 */
export interface RawVaultOptions {
  /** 数据根目录（vault 文件位于 <rootDir>/segments、<rootDir>/manifest.json 等） */
  rootDir: string;
  /** 日期编号时区（IANA） */
  timezone: string;
  /** 写者分片 id（6 位小写十六进制，如 w1a2b3c；默认随机生成一次并持久化到 locks/writer.json） */
  writerId?: string;
  /** 段文件轮转阈值：最大字节数（默认 8 MiB） */
  segmentMaxBytes?: number;
  /** 段文件轮转阈值：最大记录数（默认 2000） */
  segmentMaxRecords?: number;
  /** 是否 fsync（默认 true；测试可关掉） */
  fsync?: boolean;
  /**
   * 幂等判重回调（通常由 SQLite raw_index 提供；捕获层/集成层注入）。
   * append 时对每个输入先查该回调，已存在的 ingestKey 直接跳过（skipped++），
   * 保证重启/补采重复投递不会产生重复原始行。
   */
  seenIngestKeys?: (ingestKey: string) => boolean;
}

/** 原始库统计 */
export interface VaultStats {
  records: number;
  segments: number;
  days: number;
  bytes: number;
  firstId?: string;
  lastId?: string;
  firstTs?: number;
  lastTs?: number;
}

/** 哈希链校验结果 */
export interface VerifyResult {
  ok: boolean;
  checked: number;
  /** 首个损坏位置与原因（ok=true 时不存在） */
  error?: { id: string; seq: number; reason: string };
}

/** 段文件清单条目（manifest.json / raw_segments） */
export interface VaultSegmentInfo {
  segment: string;
  day: string;
  writerId: string;
  records: number;
  bytes: number;
  headHash?: string | null;
  tailHash?: string | null;
  sealed: boolean;
  /**
   * 段所属会话的原始 id（v2 会话分目录布局）。
   * v1 旧布局的段（可能混写多个会话）为 null/省略；目录名可由 sanitizeSessionKey
   * 推导，但截断/替换字符后不可逆，因此这里保存原始值。
   */
  sessionId?: string | null;
}

/** 顶层清单（manifest.json；可重建缓存） */
export interface VaultManifest {
  formatVersion: number;
  vaultId: string;
  updatedAt: number;
  segments: VaultSegmentInfo[];
  stats: { records: number; days: number; bytes: number };
}

/**
 * L0 原始记忆库（append-only）。
 * 实现必须保证：append 之外没有任何修改既有记录的方法；文件永不重写。
 */
export interface RawVault {
  /** 追加一批原始记录（单次原子、fsync、失败不留半条记录） */
  append(batch: RawRecordInput[]): Promise<AppendResult>;
  /** 按 id 读取单条 */
  get(id: string): Promise<RawRecord | null>;
  /** 条件检索（升/降序） */
  list(query?: RawQuery): Promise<{ records: RawRecord[]; total: number }>;
  /** 流式遍历（重建/索引用） */
  iterate(query?: RawQuery): AsyncIterable<RawRecord>;
  /** 校验哈希链与分段完整性（tamper detection） */
  verify(): Promise<VerifyResult>;
  /** 统计信息 */
  stats(): Promise<VaultStats>;
  /** 读取 manifest（可重建缓存；只读 API/UI 用） */
  manifest(): Promise<VaultManifest>;
  /** 关闭（无句柄时可为空实现） */
  close(): Promise<void>;
}

// ---------------------------------------------------------------------------
// 向量 / 嵌入
// ---------------------------------------------------------------------------

/** 嵌入模型引用（向量必须与生成它的模型/维度/版本绑定） */
export interface EmbeddingRef {
  /** 模型标识，例如 dsh-local-hash-v1 / text-embedding-3-small */
  model: string;
  /** 维度 */
  dim: number;
  /** 嵌入算法/配置版本（算法改动会改变向量空间，必须递增） */
  version: string;
}

/** 嵌入提供方 */
export interface Embedder {
  readonly ref: EmbeddingRef;
  /** 批量嵌入：返回与输入等长的单位化向量数组 */
  embed(texts: string[]): Promise<Float32Array[]>;
}

// ---------------------------------------------------------------------------
// 派生记忆层（L1+）
// ---------------------------------------------------------------------------

/** 派生记忆种类 */
export type MemoryKind =
  | 'atom' // L1 原子事件/片段
  | 'episode' // L2 情节（会话片段）
  | 'summary' // L2/L3 摘要
  | 'fact' // L3 事实
  | 'preference' // L3 偏好/协作约定
  | 'decision' // L3 决策
  | 'profile' // L3 用户/项目画像
  | 'entity' // 实体（可选图谱）
  | 'relation' // 实体关系（可选图谱）
  | 'custom'; // 扩展层自定义

/** 派生记忆记录（可版本化、可重建；永远不修改 L0） */
export interface MemoryRecord {
  /** 派生 id，例如 `L3-fact-<base36时间>-<hash8>` */
  id: string;
  /** 所属层（L1/L2/L3/自定义） */
  layer: LayerId;
  /** 种类 */
  kind: MemoryKind;
  /** 主文本（召回/注入用；不得包含会破坏上下文的控制字符） */
  text: string;
  /** 更短摘要（可选） */
  summary?: string | null;
  /** 重要度 0..1（越高越优先注入/保留） */
  importance: number;
  /** 置信度 0..1 */
  confidence: number;
  /** 来源原始记录 id（可追溯；至少 1 个，除非是纯画像） */
  sourceRawIds: string[];
  /** 来源会话 */
  sessionId?: string | null;
  /** 来源工作区 */
  workspace?: string | null;
  /** 标签（用于过滤/召回） */
  tags: string[];
  /** 创建时间（epoch ms） */
  createdAt: number;
  /** 最近更新时间（epoch ms） */
  updatedAt: number;
  /** 生效时间区间（语义层用于 supersede；null 表示未知/永久） */
  validFrom?: number | null;
  validTo?: number | null;
  /** 本记录取代的旧记录 id（版本链，不删除旧版本） */
  supersedes?: string[];
  /** 修订号（1 开始；每次内容更新 +1） */
  revision: number;
  /** 内容哈希（同层同内容去重） */
  contentHash: string;
  /** 是否已写入向量（用于补算任务） */
  embedding?: EmbeddingRef | null;
  /** 状态：有效(active) / 归档(archived，被取代，永不物理删除语义历史) / 待校验 */
  status?: MemoryStatus;
  /** 热度 0..1（检索/晋升用，内部治理字段） */
  heat?: number;
  /** 被检索/引用次数 */
  accessCount?: number;
  /** 最近一次被检索/引用的时间（epoch ms） */
  lastAccessAt?: number | null;
  /** 产生该记录时的原始记录水位（raw seq；增量派生/重建依据） */
  createdSeq?: number;
  /**
   * 保留期分层（记忆分层模型，见 docs/23-memory-models.md）：
   * - `short` 短期记忆：新产生/未巩固（默认层）
   * - `mid`   中期记忆：已保留一段时间且被巩固
   * - `long`  长期记忆：高重要度/高复述/被钉住的稳定记忆
   * 晋升阶梯 short→mid→long（不自动降级、永不删除）；与 layer（L1/L2/L3 三层记忆模型）正交。
   */
  retentionTier?: RetentionTier;
  /** 保留期得分 0..1（由 RetentionEngine 计算，可解释） */
  retentionScore?: number;
  /** 是否被钉住（钉住的记忆直接归入长期记忆；`memory_save pin=true` 或显式设置） */
  pinned?: boolean;
  /** 晋升到当前层的时间（epoch ms） */
  promotedAt?: number | null;
  /** 晋升到长期层的时间（epoch ms；未到长期层为 null） */
  longTermAt?: number | null;
  /**
   * 人格归属（人格 id；null = 共享记忆）。
   * 派生层从来源 raw 的 personaId 继承；人格切换后同一人格的记忆互相隔离。
   */
  personaId?: string | null;
  /** 扩展字段（各层自定义；JSON 可序列化） */
  meta?: Record<string, unknown>;
}

/**
 * 记忆分层模型（短期/中期/长期，retention）：
 * short → mid → long 的保留期晋升阶梯。
 *
 * 与三层记忆模型（L1/L2/L3 = 工作/情景/语义）是两个正交维度：
 * - layer 决定「这条记忆是什么类型的记忆」（工作/情景/语义）；
 * - retentionTier 决定「这条记忆已经保留/巩固到哪个期限层级」。
 */
export type RetentionTier = 'short' | 'mid' | 'long';

/** 保留期状态（层 + 分数 + 钉住标记 + 时间） */
export interface RetentionState {
  tier: RetentionTier;
  score: number;
  pinned: boolean;
  promotedAt: number | null;
  longTermAt: number | null;
}

/** 保留期分层统计（status/UI 用） */
export interface RetentionStats {
  short: number;
  mid: number;
  long: number;
  /** 被钉住的记忆数（归入 long） */
  pinned: number;
  /** 最近一次 tick 的时间 */
  lastTickAt: number | null;
}

/** 一次保留期重算（tick）的结果 */
export interface RetentionTickResult {
  evaluated: number;
  /** short → mid 的数量 */
  promotedToMid: number;
  /** mid → long 的数量 */
  promotedToLong: number;
  durationMs: number;
  now: number;
}

/** 派生记忆状态 */
export type MemoryStatus = 'active' | 'archived' | 'pending_validation';

/** 层注册表行（layers 表 + 统计视图；只读 UI/工具用） */
export interface LayerRegistryRow {
  id: LayerId;
  name: string;
  version: number;
  dependsOn: LayerId[];
  kind: 'builtin' | 'extension';
  enabled: boolean;
  rebuildable: boolean;
  /** 该层记忆总数 */
  count: number;
  /** active 条数 */
  active: number;
  /** archived 条数 */
  archived: number;
  latestUpdatedAt: number | null;
}

/** 溯源链接行（memory_sources） */
export interface SourceLinkRow {
  rawId: string;
  relation: string;
  weight: number;
}

/** 修订历史行（memory_revisions；append-only） */
export interface MemoryRevisionRow {
  memoryId: string;
  revision: number;
  text: string;
  summary?: string | null;
  importance: number;
  confidence: number;
  validFrom?: number | null;
  validTo?: number | null;
  status: string;
  changeKind: string;
  changedAt: number;
}

/** 完整性巡检行（integrity_runs） */
export interface IntegrityRunRow {
  id: number;
  kind: string;
  startedAt: number;
  finishedAt?: number | null;
  recordsChecked: number;
  segmentsChecked: number;
  ok: boolean | null;
}

/** 修复审计行（repair_log） */
export interface RepairLogRow {
  id: number;
  ts: number;
  action: string;
  target?: string | null;
}

/** 待写入的派生记忆（store 负责分配 id/时间/hash） */
export interface NewMemoryRecord {
  id?: string;
  layer: LayerId;
  kind: MemoryKind;
  text: string;
  summary?: string | null;
  importance?: number;
  confidence?: number;
  sourceRawIds: string[];
  sessionId?: string | null;
  /** 人格归属（默认由集成层填当前激活人格；null = 共享） */
  personaId?: string | null;
  workspace?: string | null;
  tags?: string[];
  createdAt?: number;
  validFrom?: number | null;
  validTo?: number | null;
  supersedes?: string[];
  status?: MemoryStatus;
  /** 产生该记录时的原始记录水位（raw seq） */
  createdSeq?: number;
  /** 写入时直接钉住到长期层（memory_save pin=true） */
  pinned?: boolean;
  meta?: Record<string, unknown>;
}

/** 派生记忆检索条件 */
export interface MemoryQuery {
  layers?: LayerId[];
  kinds?: MemoryKind[];
  sessionId?: string;
  /** 按人格过滤（null = 共享记忆）；不传 = 不过滤 */
  personaId?: string | null;
  /** personaId 指定时是否包含共享记忆（默认 true） */
  includeSharedPersona?: boolean;
  workspace?: string;
  tags?: string[];
  /** 按状态过滤（默认不过滤=全部） */
  status?: MemoryStatus[];
  /** 按保留期层过滤（短期/中期/长期） */
  retentionTiers?: RetentionTier[];
  /** 只看被钉住的记忆 */
  pinned?: boolean;
  /** 只看当前有效（validTo 为空或 > now） */
  onlyValid?: boolean;
  from?: number;
  to?: number;
  ids?: string[];
  limit?: number;
  offset?: number;
  desc?: boolean;
}

/** 词法检索命中 */
export interface LexHit {
  id: string;
  layer: LayerId;
  score: number;
}

/** 向量检索命中 */
export interface VecHit {
  id: string;
  layer: LayerId;
  score: number; // cosine similarity, -1..1
}
/** 显式检索走 L0+原始层向量；隐式检索走三层记忆 */
export type RecallMode = 'explicit' | 'implicit';

/** 原始层向量检索命中（永久向量模型） */
export interface RawVecHit {
  rawId: string;
  score: number; // cosine similarity, -1..1
}

/** 原始层向量索引统计 */
export interface RawVectorStats {
  /** raw_index 总数（含空文本 raw；空文本永不嵌入） */
  total: number;
  /** 已嵌入的原始层向量数（= 有文本 raw 中已嵌入的数量） */
  embedded: number;
  /** 有文本但尚未嵌入的数量（回填队列） */
  pending: number;
  ref: EmbeddingRef | null;
  lastBackfillAt: number | null;
}

/** 遗忘统计（status/UI 用） */
export interface ForgettingStats {
  shortDeleted: number;
  midArchived: number;
  lastForgetAt: number | null;
}

/** 原始层向量索引配置（永久向量模型） */
export interface RawVectorConfig {
  enabled: boolean;
  /** 参与嵌入的 raw 文本最大字符数（payload 不参与） */
  rawTextMaxChars: number;
  /** 回填批大小 */
  backfillBatchSize: number;
  /** 回填调度间隔（ms） */
  backfillIntervalMs: number;
}

/** 三层记忆遗忘配置（L0 与原始层向量永不遗忘） */
export interface ForgettingConfig {
  enabled: boolean;
  /** 遗忘检查间隔（ms） */
  checkIntervalMs: number;
  /** 单轮最多处理的派生记忆数 */
  batchSize: number;
  /** 钉住记忆不遗忘 */
  protectPinned: boolean;
  /** 重要度 ≥ 该值的记忆不遗忘 */
  protectImportance: number;
}

/** 一次遗忘运行结果 */
export interface ForgettingRunResult {
  evaluated: number;
  deletedShort: number;
  archivedMid: number;
  protectedCount: number;
  durationMs: number;
  now: number;
}

/** 遗忘引擎：只作用于三层记忆（派生层），绝不触碰 L0/原始层向量 */
export interface ForgettingEngine {
  run(options?: { now?: number; dryRun?: boolean; limit?: number }): Promise<ForgettingRunResult>;
  stats(): Promise<ForgettingStats>;
  lastForgetAt(): number | null;
}

/** L1+ 派生记忆存储（SQLite）。原始记录在 raw_* 表中只读镜像。 */
export interface MemoryStore {
  /** 写入/更新一条派生记忆（同 id 同 contentHash 幂等；更新时保留 revision 链） */
  upsertMemory(record: NewMemoryRecord, embedding?: Float32Array): MemoryRecord;
  getMemory(id: string): MemoryRecord | null;
  listMemories(query?: MemoryQuery): MemoryRecord[];
  countByLayer(): Record<string, number>;
  /** 写入向量（Float32 BLOB），同 owner+模型幂等覆盖 */
  putVector(ownerKind: VectorOwnerKind, ownerId: string, ref: EmbeddingRef, vec: Float32Array): void;
  /** 读取向量 */
  getVector(ownerId: string): { ref: EmbeddingRef; vec: Float32Array } | null;
  /** 暴力余弦检索（可选 ANN 索引实现同样的接口） */
  searchVector(query: Float32Array, ref: EmbeddingRef, options?: SearchVectorOptions): VecHit[];
  /** FTS5 词法检索 */
  searchLexical(query: string, options?: SearchLexicalOptions): LexHit[];  /** 原始层词法检索（raw_fts；显式检索用） */
  searchRawLexical(query: string, options?: { limit?: number; minScore?: number }): RawVecHit[];
  /** 写入原始层向量（append-only：同 raw+模型已存在则忽略，不更新） */
  putRawVector(rawId: string, ref: EmbeddingRef, vec: Float32Array): void;
  /** 读取原始层向量 */
  getRawVector(rawId: string): { ref: EmbeddingRef; vec: Float32Array } | null;
  /** 原始层向量余弦检索（永久向量模型） */
  searchRawVector(query: Float32Array, ref: EmbeddingRef, options?: { limit?: number; minScore?: number }): RawVecHit[];
  /** 缺少原始层向量的 raw 记录（回填用；返回 id + text） */
  listRawWithoutVectors(ref: EmbeddingRef, limit?: number): Array<{ id: string; text: string | null }>;
  /** 原始层向量统计 */
  rawVectorStats(ref?: EmbeddingRef): RawVectorStats;
  /** 显式重建原始层向量（临时解除不可变触发器→清空→由调用方重新嵌入）；返回清空条数 */
  rebuildRawVectors(): { removed: number };
  /** 原始层向量回填时间戳（meta） */
  setRawVectorMeta(key: string, value: string, now?: number): void;
  getRawVectorMeta(key: string): string | null;
  /**
   * 遗忘三层记忆（派生层）。
   * - short 到期：mode='delete' 物理删除该派生记录（含临时向量/FTS/溯源）
   * - mid 到期：mode='archive' 置 archived + valid_to（保留内容，不参与隐式上下文）
   * 绝不触碰 L0 / raw_index / 原始层向量。
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
  }): { deleted: number; archived: number; ids: string[] };
  /** 读取遗忘统计 */
  forgettingStats(): ForgettingStats;
  /** 写入遗忘审计计数（meta） */
  recordForgetting(stats: { deletedShort?: number; archivedMid?: number }, now?: number): void;
  /** 读取当前激活人格 id（meta `persona.active`；null = 未激活） */
  getActivePersonaId(): string | null;
  /** 写入当前激活人格 id（meta；null 清除） */
  setActivePersonaId(personaId: string | null, now?: number): void;
  /** 按人格统计派生记忆数量（UI/状态用；不含共享则 shared 单独返回） */
  countMemoriesByPersona(): { counts: Record<string, { total: number; L1: number; L2: number; L3: number }>; shared: number };
  /** 把原始记录写入 raw 索引表（只读镜像，供 UI/回溯；不可 UPDATE/DELETE） */
  indexRawRecord(item: RawAppendItem): void;
  indexRawRecords(items: RawAppendItem[]): void;
  /** 是否已索引过该幂等键（捕获层写入前判重） */
  hasRawIngestKey(ingestKey: string): boolean;
  /** 读取 raw 索引（只读） */
  listRawIndex(query?: RawQuery): { records: RawIndexRow[]; total: number };
  getRawIndex(id: string): RawIndexRow | null;
  /** 层统计（UI 用） */
  layerStats(): LayerStatsRow[];
  /** 存储状态（UI 用） */
  storageStats(): StorageStats;
  /** 记录被检索/引用：heat/access_count/last_access_at 治理字段（只动派生治理列，不动内容） */
  touchMemories(ids: string[], now?: number): void;
  /** 写入单条保留期状态（tier/score/pinned/时间；只改治理列，不降级） */
  setRetention(id: string, state: RetentionState, now?: number): void;
  /** 批量写入保留期状态（tick 用；单事务） */
  setRetentionBatch(updates: Array<{ id: string } & RetentionState>, now?: number): void;
  /** 读取单条保留期状态 */
  getRetention(id: string): RetentionState | null;
  /** 保留期层统计（短/中/长） */
  retentionStats(): RetentionStats;
  /** 按保留期层列出记忆（按 score 降序；UI 用） */
  listByRetention(tier: RetentionTier, options?: { limit?: number; offset?: number }): MemoryRecord[];
  /** 列出需要重算保留期的候选记录（未到 long 的记录 + 最近更新，分页） */
  listRetentionCandidates(options?: { since?: number; limit?: number; offset?: number }): MemoryRecord[];
  /** 读写保留期治理元数据（meta 表；如 `retention.lastTickAt`） */
  getRetentionMeta(key: string): string | null;
  setRetentionMeta(key: string, value: string, now?: number): void;
  /** 读取某层的增量派生水位（已处理到的 raw seq，0 表示尚未处理） */
  getDeriveCursor(layer: LayerId): number;
  /** 写入某层的增量派生水位 */
  setDeriveCursor(layer: LayerId, lastRawSeq: number): void;
  /**
   * 清空某层派生数据（重建用）。
   * - L1/L2：物理删除该层 memory_records + 溯源/向量/FTS（可重建）
   * - L3：默认拒绝物理删除（schema 触发器保护）；archive=true 时把旧记录置为
   *   archived/valid_to 并保留历史，再重新派生新记录。
   * 绝不触碰 L0 原始记录。
   */
  clearLayer(layer: LayerId, options?: { archive?: boolean; now?: number }): { removed: number; archived: number };
  /** 写入 L2 情节层私有表（layer_l2_episodes） */
  putL2Episode(row: L2EpisodeRow): void;
  /** 写入 L3 语义层私有表（layer_l3_semantic） */
  putL3Semantic(row: L3SemanticRow): void;
  /** 读取 L3 语义层私有行 */
  getL3Semantic(memoryId: string): L3SemanticRow | null;
  /** 元数据键值（schema/meta 表） */
  getMeta(key: string): string | null;
  setMeta(key: string, value: string, now?: number): void;
  /** 层注册表 + 统计（只读工具/UI 用） */
  listLayers(): LayerRegistryRow[];
  /** 某条派生记忆的溯源链接（只读 UI/工具用） */
  listSources(memoryId: string): SourceLinkRow[];
  /** 某条派生记忆的修订历史（只读 UI/工具用） */
  listRevisions(memoryId: string): MemoryRevisionRow[];
  /** 最近完整性巡检记录（只读 UI/工具用） */
  listIntegrityRuns(limit?: number): IntegrityRunRow[];
  /** 最近修复审计记录（只读 UI/工具用） */
  listRepairLog(limit?: number): RepairLogRow[];
  /** 每层已嵌入向量条数（只读 UI/工具用） */
  embeddingCoverage(): Record<string, number>;
  /** 最近一次完整性巡检（只读 UI/工具用；无记录返回 null） */
  getLastIntegrityRun(): IntegrityRunRow | null;
  /**
   * 记录一次完整性巡检（verify/fsck 后由集成层写入；append-only）。
   * rowsChecked/segmentsChecked/ok/details 写入 integrity_runs。
   */
  recordIntegrityRun(run: {
    kind: string;
    startedAt: number;
    finishedAt?: number;
    recordsChecked?: number;
    segmentsChecked?: number;
    ok: boolean;
    details?: Record<string, unknown>;
  }): void;
  /**
   * 在一个 SQLite 事务内执行（BEGIN IMMEDIATE；出错 ROLLBACK）。
   * 用于"写 memory_records + 私有层行 + 溯源 + 向量"原子化，避免半写。
   */
  transaction<T>(fn: () => T): T;
  /** 当前 SQLite 连接（仅供扩展层创建私有表/查询；禁止直接修改 raw_* 与 memory_records） */
  readonly db: unknown;
  /** 数据库文件路径（UI/文档用） */
  readonly dbPath: string;
  /** 关闭连接（flush WAL） */
  close(): void;
}

/** L2 情节层私有行（layer_l2_episodes） */
export interface L2EpisodeRow {
  memoryId: string;
  sessionId?: string | null;
  topic?: string | null;
  startTs: number;
  endTs: number;
  turnCount?: number;
  rawFirstId?: string | null;
  rawLastId?: string | null;
  /** 组成该情节的 L1 记录 id */
  pageIds?: string[];
  heat?: number;
  promotedAt?: number | null;
}

/** L3 语义层私有行（layer_l3_semantic） */
export interface L3SemanticRow {
  memoryId: string;
  category: 'fact' | 'preference' | 'decision' | 'profile';
  subject?: string | null;
  predicate?: string | null;
  object?: string | null;
  /** 规范化去重键，例 'user.pref.theme=dark' */
  canonicalKey?: string | null;
  validFrom?: number | null;
  validTo?: number | null;
  supersededBy?: string | null;
  sourceKind?: 'deterministic' | 'llm' | 'manual';
  extractedBy?: string | null;
}

/** 向量所有者种类 */
export type VectorOwnerKind = 'memory' | 'raw';

export interface SearchVectorOptions {
  layers?: LayerId[];
  kinds?: MemoryKind[];
  limit?: number;
  /** 最低 cosine 阈值 */
  minScore?: number;
}

export interface SearchLexicalOptions {
  layers?: LayerId[];
  kinds?: MemoryKind[];
  limit?: number;
}

/** raw 索引行（SQLite 镜像，只读；字段与 docs/21-schema.sql 的 raw_index 对应） */
export interface RawIndexRow {
  id: string;
  seq: number;
  ts: number;
  iso: string;
  day: string;
  timezone: string;
  kind: RawKind;
  sessionId: string;
  workspace: string | null;
  /** 捕获时的人格归属（索引元数据，不参与 L0 哈希；null = 共享） */
  personaId: string | null;
  turnId: string | null;
  stepId: string | null;
  role: string | null;
  text: string | null;
  /** 中文二元组切分后的检索串（FTS 用） */
  textSeg: string;
  /** 完整原始事件 JSON（无损镜像；权威副本在 segment 文件） */
  payloadJson: string;
  hash: string;
  prevHash: string;
  segment: string;
  lineNo: number;
  byteOffset: number;
  byteLen: number;
  recordVersion: number;
  ingestKey: string;
  createdAt: number;
}

export interface LayerStatsRow {
  layer: LayerId;
  name: string;
  count: number;
  latestUpdatedAt: number | null;
}

export interface StorageStats {
  dbPath: string;
  dbBytes: number;
  rawCount: number;
  memoryCount: number;
  activeMemoryCount: number;
  vectorCount: number;
  segmentCount: number;
  embedding: EmbeddingRef | null;
  schemaVersion: number;
}

// ---------------------------------------------------------------------------
// 分层架构（可扩展 N 层）
// ---------------------------------------------------------------------------

/** 层 id：默认 L1 / L2 / L3；扩展层可注册任意 id（如 L4、project、procedural） */
export type LayerId = string;

/** 层定义 —— 新增一层只需要注册一个 LayerDefinition，不修改既有数据 */
export interface LayerDefinition {
  /** 层 id（唯一） */
  readonly id: LayerId;
  /** 展示名（中文） */
  readonly name: string;
  /** 层版本（派生算法版本；变更导致该层可重建） */
  readonly version: number;
  /** 依赖的层（derive 时这些层已就绪；L1 依赖空数组，即直接读 L0） */
  readonly dependsOn: LayerId[];
  /** 是否可以从 L0 完整重建（默认 true） */
  readonly rebuildableFromRaw?: boolean;
  /** 启停（接收完整插件配置，便于扩展层自定义开关） */
  enabled(config: MemoryVaultConfig): boolean;
  /**
   * 派生：读取原始记录（含依赖层已有结果）产出新记忆。
   * 必须幂等：重复运行同样输入不应产生重复记录（用 contentHash/sourceRawIds 去重）。
   */
  derive(input: DeriveInput, ctx: DeriveContext): Promise<NewMemoryRecord[]>;
  /** 可选的层内召回（默认走通用 hybrid 检索；扩展层可自定义） */
  retrieve?(query: RecallQuery, ctx: DeriveContext): Promise<RecallHit[]>;
}

/** 派生触发原因 */
export type DeriveReason = 'capture' | 'session_end' | 'timer' | 'manual' | 'rebuild';

export interface DeriveInput {
  /** 本次新增的原始记录（增量） */
  raws: RawRecord[];
  /** 自上次派生以来未处理完的原始记录（用于补齐，通常等于 raws） */
  pendingRaws?: RawRecord[];
  reason: DeriveReason;
  /** 会话结束时的 sessionId */
  sessionId?: string;
  /** 当前时间 */
  now: number;
}

/** 派生上下文（层实现可用的服务） */
export interface DeriveContext {
  store: MemoryStore;
  embedder: Embedder;
  config: MemoryVaultConfig;
  logger: Logger;
  /** 读取任意原始记录（重建/跨时间窗时用） */
  readRaw(query?: RawQuery): Promise<RawRecord[]>;
  /** 当前层已有记忆（用于去重/合并） */
  listLayerMemories(layer: LayerId, query?: MemoryQuery): MemoryRecord[];
  now(): number;
}

/** 层运行结果 */
export interface LayerRunResult {
  layer: LayerId;
  written: number;
  updated: number;
  skipped: number;
  errors: string[];
  durationMs: number;
}

/** 层运行器：注册 + 增量派生 + 重建 */
export interface LayerRunner {
  register(definition: LayerDefinition): void;
  list(): LayerDefinition[];
  /** 增量运行（默认按依赖顺序运行所有已启用层；可指定 layers 子集） */
  run(input: DeriveInput, layers?: LayerId[]): Promise<LayerRunResult[]>;
  /**
   * 从 L0 全量重建指定层（绝不触碰 L0）。
   * L1/L2 清空后重跑；L3 走"归档旧记录 + 重新派生"（语义历史不可物理删除）。
   */
  rebuild(layer: LayerId, options?: { batchSize?: number }): Promise<LayerRunResult>;
}

// ---------------------------------------------------------------------------
// 召回（retrieval）
// ---------------------------------------------------------------------------

export interface RecallQuery {
  /** 查询文本（用户问题/当前上下文） */
  text: string;
  /** 返回条数上限 */
  limit?: number;
  /** 限定层 */
  layers?: LayerId[];
  /** 限定种类 */
  kinds?: MemoryKind[];
  /** 限定会话/工作区 */
  sessionId?: string;
  workspace?: string;
  /** 时间范围（epoch ms） */
  from?: number;
  to?: number;
  /** 是否包含 L0 原始记录命中（默认 true，用于引用原文） */
  includeRaw?: boolean;
  /** 最低综合分 */
  minScore?: number;
  /**
   * 是否把命中记录计入治理统计（access_count/heat）。
   * 工具检索=true（默认）；只读 HTTP/UI=false（浏览不得污染治理数据）。
   */
  trackAccess?: boolean;
  /**
   * 检索模式（v3）：
   * - `explicit`（默认）：显式检索 → L0 原始层 + 原始层向量索引（永不受遗忘影响）
   * - `implicit`：隐式上下文 → 三层记忆（可遗忘；prompt 注入/自动召回用）
   */
  mode?: RecallMode;
  /** 只检索指定保留期层（implicit 模式有效；默认不限制） */
  retentionTiers?: RetentionTier[];
  /** 按人格过滤（explicit 原始层 / implicit 派生层；null = 共享） */
  personaId?: string | null;
  /** personaId 指定时是否包含共享记忆（默认 true） */
  includeSharedPersona?: boolean;
}

/** 召回命中 */
export interface RecallHit {
  /** 'raw' 表示命中 L0 原始记录，其它为层 id */
  layer: LayerId | 'raw';
  /** 派生记忆（layer!=='raw' 时存在） */
  memory?: MemoryRecord;
  /** 原始记录（layer==='raw' 或作为证据时存在） */
  raw?: RawRecord;
  /** 综合分 0..1 */
  score: number;
  /** 各因子得分（可解释性） */
  components: {
    vector: number;
    lexical: number;
    recency: number;
    importance: number;
  };
  /** 引用/来源（raw id 列表 + 说明） */
  citations: string[];
}

/** 召回服务 */
export interface Recaller {
  recall(query: RecallQuery): Promise<RecallHit[]>;
  /** 生成注入 system prompt 的常驻片段（预算内、稳定、可缓存） */
  buildPromptSection(options?: { budgetTokens?: number }): Promise<string>;
  /** 生成单条记忆的可读引用（工具输出用） */
  formatHit(hit: RecallHit): string;
}

// ---------------------------------------------------------------------------
// 捕获（capture）
// ---------------------------------------------------------------------------

/** 捕获入口（DSH 事件 -> 原始记录） */
export interface CaptureSink {
  /** 入队并尽快落盘（批量合并写）；返回已落盘记录 */
  ingest(batch: RawRecordInput[], options?: { reason?: DeriveReason }): Promise<RawRecord[]>;
  /** 等待队列清空（关闭/测试用） */
  flush(): Promise<void>;
  /** 停止并 flush */
  close(): Promise<void>;
  /** 统计（调试/状态工具用） */
  stats(): CaptureStats;
}

export interface CaptureStats {
  captured: number;
  failed: number;
  queued: number;
  lastCaptureAt: number | null;
  dropped: number;
}

// ---------------------------------------------------------------------------
// 配置 / 日志 / 健康检查
// ---------------------------------------------------------------------------

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface Logger {
  debug(msg: string, extra?: unknown): void;
  info(msg: string, extra?: unknown): void;
  warn(msg: string, extra?: unknown): void;
  error(msg: string, extra?: unknown): void;
}

export interface EmbeddingConfig {
  provider: 'local' | 'openai-compatible';
  /** 维度（local 默认 512；remote 由模型决定，可显式指定用于校验） */
  dim: number;
  /** 模型名（local 固定 dsh-local-hash-v1） */
  model: string;
  /** openai-compatible 的 baseURL，例如 https://api.openai.com/v1 或 http://127.0.0.1:11434/v1 */
  baseURL?: string;
  /** 存放 API key 的环境变量名（避免把密钥写进配置） */
  apiKeyEnv?: string;
  /** 请求超时（ms） */
  timeoutMs: number;
  /** 批量大小 */
  batchSize: number;
}

export interface CaptureConfig {
  userMessages: boolean;
  assistantMessages: boolean;
  toolCalls: boolean;
  toolResults: boolean;
  /** 需要排除的工作区（前缀匹配） */
  excludeWorkspaces: string[];
  /** 单批最多记录数（合并写） */
  maxBatchSize: number;
  /** 落盘节流（ms） */
  flushIntervalMs: number;
}

export interface LayersConfig {
  /** 启用的层 id（按依赖拓扑排序执行） */
  enabled: LayerId[];
  /** 自动后台合并/提升（定时器） */
  autoConsolidate: boolean;
  consolidationIntervalMs: number;
  /** 单次派生最多处理的原始记录数 */
  maxBatchRaws: number;
}

export interface RecallConfig {
  enabled: boolean;
  /** 是否把常驻记忆片段注入 system prompt */
  injectSystemPrompt: boolean;
  /** 注入片段 token 预算 */
  promptBudgetTokens: number;
  /** memory_recall 工具默认返回条数 */
  toolDefaultLimit: number;
  /** 混合检索权重 */
  hybrid: {
    vectorWeight: number;
    lexicalWeight: number;
    recencyWeight: number;
    importanceWeight: number;
    /** 时间衰减半衰期（天） */
    halfLifeDays: number;
  };
  /** 分层层先验（乘在综合分上；未列出的层默认 1） */
  layerPrior: Record<string, number>;
  /** 候选池上限（向量/词法各取 top min(4*limit, maxCandidates)） */
  maxCandidates: number;
  /** 近重复压制阈值（结果内余弦 ≥ 该值只保留高分） */
  dedupSimilarity: number;
  /** MMR 去冗余（默认开） */
  mmr: { enabled: boolean; lambda: number };
  /** 向量缓存上限（条；超出走流式扫描） */
  vectorCacheMaxItems: number;
  /** 是否开启"按当前用户输入自动检索"（默认关闭；v1 仅画像注入+工具检索） */
  autoRecall: boolean;
  /** 保留期层先验（乘在综合分上；默认 short 0.95 / mid 1.0 / long 1.0，轻微偏好已巩固记忆） */
  retentionPrior: { short: number; mid: number; long: number };
}

export interface HttpConfig {
  enabled: boolean;
  /** 路由前缀，例如 /dsh-life-memory（须以 / 开头） */
  basePath: string;
}

export interface UiConfig {
  enabled: boolean;
}

export interface SafetyConfig {
  /** 派生层/注入文本中遮蔽疑似密钥（原始层永不遮蔽） */
  redactSecretsInDerived: boolean;
  /**
   * 是否允许插件发起网络请求（远程嵌入 / 可选 LLM 整理）。
   * 默认 false：纯本地可用；未开启而配置了 openai-compatible 嵌入会在启动时报错。
   */
  allowNetwork: boolean;
}

/** 可选 LLM 整理（默认关闭；v1 只实现确定性管线，接口留给宿主接线） */
export interface ConsolidationConfig {
  enabled: boolean;
  /** 单次最多整理的条目数 */
  maxItemsPerRun: number;
  timeoutMs: number;
}

/**
 * 记忆分层配置（短期 / 中期 / 长期 retention 模型）。
 *
 * 设计依据：docs/23-memory-models.md（MemoryOS 的 STM/MTM/LTM 晋升、MemoryBank/Ebbinghaus
 * 遗忘曲线、ACT-R base-level activation）；三层记忆模型 L1/L2/L3（工作/情景/语义）见 docs/20。
 *
 * 晋升阶梯（**单调不降、永不删除**）：
 *   - 新记录 → short
 *   - short → mid：age ≥ shortTermDays（默认 1 天）
 *   - mid → long：age ≥ longTermAfterDays（默认 30 天）且满足其一：
 *       importance ≥ longTermMinImportance、sourceRawIds.length ≥ longTermMinRecurrence、
 *       pinned、kind ∈ autoLongTermKinds（默认 ['profile']）、retentionScore ≥ longTermMinScore
 *   - pinned 且 pinnedIsLongTerm=true → 直接 long
 */
export interface RetentionConfig {
  enabled: boolean;
  /** short → mid 的年龄阈值（天；达到且满足晋升条件才会升，否则到期遗忘） */
  shortTermDays: number;
  /** short → mid 晋升条件之一：最低重要度（默认 0.45） */
  promoteMidMinImportance: number;
  /** short → mid 晋升条件之一：最低访问次数（默认 1） */
  promoteMidMinAccess: number;
  /** mid → long 的最短年龄（天） */
  longTermAfterDays: number;
  /** 晋升长期层的最低重要度（与其它条件之一组合） */
  longTermMinImportance: number;
  /** 晋升长期层的最低来源复述数（sourceRawIds 数量） */
  longTermMinRecurrence: number;
  /** 晋升长期层的最低保留期分数（与其它条件之一组合） */
  longTermMinScore: number;
  /** 后台重算间隔（ms） */
  tickIntervalMs: number;
  /** 新建即长期（并自动钉住）的记忆种类；默认 ['profile'] */
  autoLongTermKinds: MemoryKind[];
  /** 钉住的记忆是否直接归入长期层（默认 true） */
  pinnedIsLongTerm: boolean;
  /** 保留期分数权重（归一化前，和为 1） */
  weights: {
    recency: number;
    importance: number;
    recurrence: number;
    frequency: number;
  };
}

// ---------------------------------------------------------------------------
// 人格（persona）：markdown 定义 + 激活 + 记忆作用域
// 参考 dsh-agents-md 的 markdown 人格定义语义；记忆按人格隔离/共享。
// ---------------------------------------------------------------------------

/** 一个人格定义（来自 personas 目录下的 `*.md`；文件名 = id） */
export interface PersonaDefinition {
  /** 文件名（不含 .md），也是 mention/激活用的 id */
  id: string;
  /** 展示名（frontmatter name ?? id） */
  name: string;
  /** 描述（frontmatter description；roster/UI 用） */
  description: string;
  aliases: string[];
  tags: string[];
  /** 参考项目的路由字段（本插件只记录，不调度模型） */
  model?: string | null;
  provider?: string | null;
  /** 人格正文 = system prompt */
  body: string;
  sourcePath: string;
  contentHash: string;
  mtime: number;
  valid: boolean;
  invalidReason?: string | null;
  /** 正文是否因 maxBodyChars 被截断 */
  truncated?: boolean;
}

export interface PersonaLoadError {
  file: string;
  reason: string;
}

/** 人格注册表快照 */
export interface PersonaRoster {
  definitions: PersonaDefinition[];
  errors: PersonaLoadError[];
  activeId: string | null;
  loadedAt: number;
}

/** 人格摘要（status/UI/HTTP 用；不含完整正文） */
export interface PersonaSummary {
  id: string;
  name: string;
  description: string;
  tags: string[];
  valid: boolean;
  invalidReason?: string | null;
  mtime: number;
}

/** 人格健康状态 */
export interface PersonaHealth {
  enabled: boolean;
  activeId: string | null;
  activeName: string | null;
  definitions: PersonaSummary[];
  /** 每个人格的派生记忆数量（键 = persona id） */
  memoryCounts: Record<string, { total: number; L1: number; L2: number; L3: number }>;
  /** 共享（无人格）派生记忆数 */
  sharedCount: number;
  lastError: string | null;
}

/** 人格激活结果 */
export interface PersonaActivationResult {
  ok: boolean;
  activeId: string | null;
  persona: PersonaSummary | null;
  error?: string;
}

/** 人格注册表（文件系统为源；热重载） */
export interface PersonaRegistry {
  roster(): PersonaRoster;
  list(): PersonaDefinition[];
  get(id: string): PersonaDefinition | undefined;
  active(): PersonaDefinition | null;
  activate(id: string | null, options?: { now?: number }): Promise<PersonaActivationResult>;
  reload(): Promise<PersonaRoster>;
  lastError(): string | null;
  dispose(): void;
}

/** 人格配置（markdown 定义目录 + 热重载 + 注入） */
export interface PersonaConfig {
  enabled: boolean;
  /** 人格定义目录（空 = <DSH_HOME>/personas） */
  dir: string;
  /** 是否监听目录热重载（~200ms 防抖） */
  watch: boolean;
  /** 人格定义新增/变更是否归档为 L0 原始记录（note；永久保留） */
  archiveDefinitions: boolean;
  /** 正文最大字符数（超出截断并记录） */
  maxBodyChars: number;
  /** 激活人格是否注入 system prompt（身份块） */
  injectSystemPrompt: boolean;
}

export interface MemoryVaultConfig {
  enabled: boolean;
  scope: 'global' | 'workspace';
  /** 数据目录（空 = 自动：<dsh-home>/life-memory 或 workspace 下 .dsh-life-memory） */
  dataDir: string;
  /** IANA 时区（日期编号用；空 = 宿主本地时区） */
  timezone: string;
  capture: CaptureConfig;
  embedding: EmbeddingConfig;
  layers: LayersConfig;
  recall: RecallConfig;
  /** 记忆分层模型（短期/中期/长期 retention；与 L1/L2/L3 三层记忆模型正交） */
  retention: RetentionConfig;
  /** 原始层向量索引（永久向量模型：只追加、不可删除） */
  vectors: RawVectorConfig;
  /** 三层记忆遗忘策略（L0/原始层向量永不遗忘） */
  forgetting: ForgettingConfig;
  /** 人格（markdown 定义 + 激活 + 记忆作用域） */
  persona: PersonaConfig;
  http: HttpConfig;
  ui: UiConfig;
  safety: SafetyConfig;
  consolidation: ConsolidationConfig;
}

/** 插件运行时健康状态（status 工具/UI 用） */
export interface VaultHealth {
  ok: boolean;
  dataDir: string;
  vault: VaultStats;
  storage: StorageStats;
  layers: LayerRegistryRow[];
  capture: CaptureStats;
  embedder: EmbeddingRef;
  /** 保留期分层统计（短/中/长期） */
  retention: RetentionStats;
  /** 原始层向量索引统计（永久向量模型） */
  vectors: RawVectorStats;
  /** 三层记忆遗忘统计 */
  forgetting: ForgettingStats;
  /** 人格状态（markdown 定义 + 激活人格 + 每人格记忆数） */
  persona: PersonaHealth;
  lastDeriveAt: number | null;
  lastError: string | null;
  verify?: VerifyResult;
  uptimeMs: number;
}

// ---------------------------------------------------------------------------
// 记忆分层模型（短/中/长期）引擎 —— docs/23-memory-models.md
// ---------------------------------------------------------------------------

/**
 * 保留期引擎：把派生记忆在「短期 / 中期 / 长期」保留期层之间**晋升**。
 *
 * 职责边界：
 * - 只读写治理列（retention_* / pinned），**不修改** memory_records 的内容字段，
 *   更不触碰 L0 原始记录；
 * - **单调不降、永不删除**：只做 short→mid、mid→long 的晋升；
 * - 确定性：同样的记录 + 同样的 now ⇒ 同样的 tier/score（无随机）；
 * - 可解释：score 由 recency（年龄衰减）/importance/recurrence/frequency 四项组成。
 */
export interface RetentionEngine {
  /** 计算一条记录的保留期分数（0..1，不写库） */
  score(record: MemoryRecord, now?: number): number;
  /** 由分数 + 年龄 + 钉住/种类规则推导目标状态（只升不降，不写库） */
  evaluate(record: MemoryRecord, now?: number): RetentionState;
  /**
   * 重算一批记录的保留期（默认取 listRetentionCandidates 的候选集）。
   * 写入 setRetentionBatch，并记录 `retention.lastTickAt`。
   */
  tick(options?: { now?: number; limit?: number; dryRun?: boolean }): Promise<RetentionTickResult>;
  /** 三层（短/中/长）统计 */
  stats(): Promise<RetentionStats>;
  /** 按保留期层列出记忆（已晋升到该层的记录；供 prompt/UI 展示） */
  byTier(tier: RetentionTier, options?: { limit?: number; offset?: number }): MemoryRecord[];
  /** 显式设置某条记忆的保留期层（如 pin/unpin、显式提升为长期） */
  setTier(id: string, tier: RetentionTier, options?: { pinned?: boolean; now?: number }): RetentionState | null;
  /** 最近一次 tick 时间（meta） */
  lastTickAt(): number | null;
}

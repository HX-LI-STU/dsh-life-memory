// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hanxustu (dsh-life-memory)
/**
 * 客户端只读数据模型 —— 与 src/core/contracts.ts / src/http/handlers.ts 的返回对齐。
 *
 * 这里刻意全部使用可选字段（`?`）：宿主端仍在演进，缺字段时 UI 必须能降级渲染，
 * 不允许因为一个字段被重命名而让整个面板崩溃。
 */

// ---------------------------------------------------------------------------
// 通用响应包络
// ---------------------------------------------------------------------------

export interface ApiErrorBody {
  code: string;
  message: string;
}

export interface ApiEnvelope<T> {
  ok: boolean;
  data?: T;
  error?: ApiErrorBody;
}

// ---------------------------------------------------------------------------
// 原始档案（L0）
// ---------------------------------------------------------------------------

export type RawKind =
  | 'session'
  | 'turn'
  | 'user'
  | 'assistant'
  | 'tool_call'
  | 'tool_result'
  | 'system'
  | 'compaction'
  | 'event'
  | 'note';

/** `GET /api/raw` 的 items 元素（RawIndexRow 的 UI 投影） */
export interface RawIndexRowPreview {
  id: string;
  seq?: number;
  ts?: number;
  iso?: string;
  day?: string;
  kind?: RawKind | string;
  sessionId?: string | null;
  workspace?: string | null;
  role?: string | null;
  textPreview?: string | null;
  hash?: string;
  segment?: string;
  lineNo?: number;
  /** 人格归属（v4；null = 共享） */
  personaId?: string | null;
}

export interface RawListData {
  items: RawIndexRowPreview[];
  total: number;
  nextCursor: string | null;
}

/** `GET /api/raw/:id` 内的完整记录（字段宽松，原样展示） */
export interface RawRecord {
  id: string;
  kind: string;
  ts?: number;
  iso?: string;
  day?: string;
  timezone?: string;
  sessionId?: string | null;
  workspace?: string | null;
  turnId?: string | null;
  stepId?: string | null;
  role?: string | null;
  text?: string | null;
  payload?: unknown;
  tags?: string[];
  meta?: Record<string, unknown>;
  /** 人格归属（v4 索引元数据；不写入 L0 行；null = 共享） */
  personaId?: string | null;
  seq?: number;
  hash?: string;
  prevHash?: string;
  v?: number;
}

export interface RawLocation {
  ingestKey?: string;
  segment?: string;
  lineNo?: number;
  byteOffset?: number;
  byteLen?: number;
}

export interface RawDetailData {
  record: RawRecord;
  location: RawLocation | null;
  verify?: unknown;
}

export interface RawVerifyData {
  id?: string;
  exists?: boolean;
  hashPresent?: boolean;
  prevHashPresent?: boolean;
  checked?: string;
  note?: string;
  hashOk?: boolean | null;
  chainOk?: boolean | null;
  error?: string;
}

// ---------------------------------------------------------------------------
// 派生记忆层
// ---------------------------------------------------------------------------

export interface LayerRegistryRow {
  id: string;
  name?: string;
  version?: number;
  dependsOn?: string[];
  kind?: 'builtin' | 'extension' | string;
  enabled?: boolean;
  rebuildable?: boolean;
  count?: number;
  active?: number;
  archived?: number;
  latestUpdatedAt?: number | null;
}

export interface LayerStatRow {
  id: string;
  name?: string;
  version?: number;
  total?: number;
  active?: number;
  archived?: number;
  latestUpdatedAt?: number | null;
  embeddingCoverage?: number;
}

export interface LayerStatsData {
  layers: LayerStatRow[];
  raw?: { records?: number; segments?: number; days?: number; bytes?: number };
}

export interface LayersData {
  layers: LayerRegistryRow[];
}

// ---------------------------------------------------------------------------
// 记忆分层模型：短期 / 中期 / 长期（retention 维度：短 → 中 → 长期晋升阶梯）
//
// 与「三层记忆模型」（L1 工作记忆层 / L2 情景记忆层 / L3 语义记忆层，按内容类型）
// 是两个正交维度，共同描述每条记忆：
//   retention = 这条记忆该保留多久（short 短期 / mid 中期 / long 长期）；
//   layer     = 这条记忆是什么类型（L1 工作 / L2 情景 / L3 语义）。
// ---------------------------------------------------------------------------

export type RetentionTier = 'short' | 'mid' | 'long';

/** 一条记忆的分层状态（`/memories`、`/search`、`/memory-detail` 内嵌） */
export interface RetentionState {
  tier: RetentionTier;
  score?: number;
  pinned?: boolean;
  promotedAt?: number | null;
  demotedAt?: number | null;
}

/** 记忆分层统计（`/retention`、`/status`、`/health`） */
export interface RetentionStats {
  short?: number;
  mid?: number;
  long?: number;
  pinned?: number;
  lastTickAt?: number | null;
}

/** `GET /api/life-memory/retention` 的 data（统计为主；列表走 /memories?retention=） */
export interface RetentionData {
  stats?: RetentionStats;
  /** 内容层计数（L1/L2/L3 → 条数） */
  countsByLayer?: Record<string, number>;
  generatedAt?: number;
  readonly?: boolean;
}

export interface MemoryRecordPreview {
  id: string;
  layer: string;
  kind?: string;
  text?: string;
  summary?: string | null;
  importance?: number;
  confidence?: number;
  status?: string;
  validFrom?: number | null;
  validTo?: number | null;
  updatedAt?: number;
  tags?: string[];
  /** 只有部分投影会带 canonicalKey；扩展层可能放在 meta 里 */
  canonicalKey?: string | null;
  meta?: Record<string, unknown> | null;
  /** 人格归属（v4；null = 共享记忆） */
  personaId?: string | null;
  /** 记忆分层状态（新契约：嵌套对象）。扁平字段为兼容中间版本/旧 mock。 */
  retention?: RetentionState | null;
  retentionTier?: RetentionTier;
  retentionScore?: number;
  pinned?: boolean;
  promotedAt?: number | null;
  demotedAt?: number | null;
}

export interface MemoryListData {
  items: MemoryRecordPreview[];
  total: number;
  nextCursor: string | null;
}

export interface SourceLink {
  rawId?: string;
  relation?: string;
  weight?: number;
}

export interface MemoryRevision {
  revision?: number;
  text?: string;
  summary?: string | null;
  status?: string;
  changeKind?: string;
  changedAt?: number;
  [k: string]: unknown;
}

export interface MemoryDetailData {
  memory: MemoryRecordPreview & { sourceRawIds?: string[]; supersedes?: string[]; revision?: number };
  sources?: SourceLink[];
  revisions?: MemoryRevision[];
  l3Semantic?: Record<string, unknown> | null;
}

// ---------------------------------------------------------------------------
// 检索
// ---------------------------------------------------------------------------

export interface ScoreComponents {
  vector?: number;
  lexical?: number;
  recency?: number;
  importance?: number;
}

export interface RecallHit {
  layer: string;
  score?: number;
  components?: ScoreComponents;
  memory?: MemoryRecordPreview | null;
  raw?: RawRecord | null;
  citations?: string[];
}

/**
 * 检索模式（v3，见 docs/24）：
 * - `explicit`（默认）：显式检索 → L0 原始层 + 原始层向量索引（原文永远完整，不受遗忘影响）
 * - `implicit`：隐式上下文 → 三层记忆（可遗忘）
 */
export type SearchMode = 'explicit' | 'implicit';

export interface SearchData {
  items: RecallHit[];
  truncated?: boolean;
  latencyMs?: number;
  /** 宿主回显的检索模式（可选） */
  mode?: SearchMode | string;
}

// ---------------------------------------------------------------------------
// v3：原始层向量索引（永久向量模型）与三层记忆遗忘统计
// ---------------------------------------------------------------------------

/** 原始层向量索引统计（只追加、不可更新/删除；从 L0 可重建） */
export interface RawVectorStats {
  /** raw_index 总数（含空文本 raw：turn/session 等纯事件，按设计永不嵌入） */
  total?: number;
  /** 实际已嵌入的原始层向量数（Host v3 契约字段；UI 直接使用，旧构建缺失时不得用 total-pending 推算） */
  embedded?: number;
  /** 有文本但尚未嵌入的 raw 数（回填队列；不含空文本 raw，回填完成后为 0） */
  pending?: number;
  /** 向量绑定的嵌入模型 */
  ref?: EmbeddingRef | null;
  /** 最近一次回填时间（epoch ms） */
  lastBackfillAt?: number | null;
}

/** 三层记忆遗忘统计（L0 与原始层向量永不遗忘） */
export interface ForgettingStats {
  /** 已物理删除的短期记忆数 */
  shortDeleted?: number;
  /** 已归档的中期记忆数 */
  midArchived?: number;
  /** 最近一次遗忘时间（epoch ms） */
  lastForgetAt?: number | null;
}

// ---------------------------------------------------------------------------
// v4：人格（Persona）—— markdown 人格定义 × 人格记忆读取（见 docs/25）
// 人格是记忆作用域与注入的上层维度（正交于 layer / retention）。
// ---------------------------------------------------------------------------

/** 一个人格的派生记忆计数（total = L1+L2+L3） */
export interface PersonaMemoryCount {
  total?: number;
  L1?: number;
  L2?: number;
  L3?: number;
}

/** 人格摘要（`/personas` definitions 与 `status.persona.definitions`） */
export interface PersonaSummary {
  id: string;
  name?: string;
  description?: string;
  tags?: string[];
  valid: boolean;
  invalidReason?: string | null;
  truncated?: boolean;
  mtime?: number;
  /** 每个人格的派生记忆数（`/personas` definitions 内嵌；status 里在 memoryCounts 映射） */
  memories?: PersonaMemoryCount;
  /** 正文预览（Host 暴露时才有；通常 `*` 摘要不含正文） */
  body?: string;
  bodyPreview?: string;
  sourcePath?: string;
}

/** `GET /api/life-memory/personas` 的 data（第 14 条只读路由） */
export interface PersonaData {
  /** 当前激活人格（null = 未激活） */
  activeId?: string | null;
  definitions?: PersonaSummary[];
  memoryCounts?: Record<string, PersonaMemoryCount>;
  sharedCount?: number;
  generatedAt?: number;
  readonly?: boolean;
  /** 人格定义目录（Host 暴露时用于 UI 空态提示） */
  dir?: string | null;
}

/** `status.persona` / `health.persona` 块 */
export interface PersonaHealth {
  enabled?: boolean;
  activeId?: string | null;
  activeName?: string | null;
  definitions?: PersonaSummary[];
  memoryCounts?: Record<string, PersonaMemoryCount>;
  sharedCount?: number;
  lastError?: string | null;
  dir?: string | null;
}

// ---------------------------------------------------------------------------
// v5：人格写操作、会话级开关、记忆库（vault）总览
// POST：/personas、/personas/update、/personas/delete、/personas/activate、/session-config
// GET：/vaults、/session-config（新增 @lsh；既有 14 条 GET 支持 vault/sessionId 可选参数）
// ---------------------------------------------------------------------------

/** POST /personas 的 body（创建人格；写 persona.dir/<id>.md） */
export interface PersonaCreateInput {
  /** 缺省由 Host 从 name 派生（客户端也会自动生成可手改） */
  id?: string;
  name: string;
  description?: string;
  tags?: string[];
  aliases?: string[];
  /** 人格正文 = system prompt */
  body: string;
}

/** POST /personas/update 的 body（部分字段更新） */
export interface PersonaUpdateInput {
  id: string;
  name?: string;
  description?: string;
  tags?: string[];
  aliases?: string[];
  body?: string;
}

/** POST /personas/delete 的 body */
export interface PersonaDeleteInput {
  id: string;
}

/** POST /personas/activate 的 body（persona=null 表示取消人格、使用共享库） */
export interface PersonaActivateInput {
  persona: string | null;
}

/** POST /personas 的响应 data */
export interface PersonaCreateData {
  persona: PersonaSummary;
  created: boolean;
}

/** POST /personas/update 的响应 data */
export interface PersonaUpdateData {
  persona: PersonaSummary;
  updated: boolean;
}

/** POST /personas/delete 的响应 data（文件移入 personas/.trash/） */
export interface PersonaDeleteData {
  deleted: boolean;
  backupFile?: string;
}

/** POST /personas/activate 的响应 data */
export interface PersonaActivateData {
  activeId: string | null;
  persona: PersonaSummary | null;
  vault?: { id?: string; name?: string };
}

/** 记忆库引用（vault） */
export interface VaultRef {
  id?: string;
  name?: string;
}

/** GET /vaults 的 vault 条目 */
export interface VaultInfo {
  id: string;
  name?: string;
  isPersona?: boolean;
  isActive?: boolean;
  stats?: {
    rawRecords?: number;
    memoryCount?: number;
    dbBytes?: number;
    lastUpdatedAt?: number | null;
  };
}

/** GET /vaults 的 data */
export interface VaultsData {
  vaults?: VaultInfo[];
  activeVaultId?: string | null;
  /** 全局激活人格 id（v5 Host 字段；null = 无激活人格/共享库） */
  activePersonaId?: string | null;
  generatedAt?: number;
  readonly?: boolean;
  /** 共享库 id（Host v5 返回 'shared'） */
  sharedVaultId?: string | null;
}

/** 会话级记忆配置（GET/POST /session-config） */
export interface SessionConfig {
  sessionId: string;
  /** 本会话是否使用记忆（默认 true） */
  memory?: boolean;
  /** 本会话是否使用人格（默认 false） */
  persona?: boolean;
  /** 指定人格（可选；空 = 当前激活人格） */
  personaId?: string | null;
  vault?: VaultRef;
  updatedAt?: number;
  /** GET 缺省时标记（未保存过配置） */
  isDefault?: boolean;
}

/** POST /session-config 的 body */
export interface SessionConfigInput {
  sessionId: string;
  memory?: boolean;
  persona?: boolean;
  personaId?: string | null;
}

/**
 * 新会话默认（v5.1：GET /session-config 不带 sessionId）。
 *
 * Host 返回形状：`{sessionId:null, memory, persona, personaId, isDefault:true,
 * defaults:true, vault:{id,name}, memoryEnabled, personaEnabled}`。
 * `memoryEnabled`/`personaEnabled` 是 Host 的别名字段（与 memory/persona 同值），
 * UI 优先读 memory/persona，缺失时回退别名字段（新旧 Host 兼容）。
 */
export interface SessionDefaults {
  sessionId: null;
  memory?: boolean;
  persona?: boolean;
  personaId?: string | null;
  /** 尚未保存过默认（与 isDefault 同义；true = 显示内置默认值） */
  isDefault?: boolean;
  /** 标记该响应/请求是"新会话默认"作用域（而不是某个 sessionId） */
  defaults?: boolean;
  vault?: VaultRef;
  vaultId?: string | null;
  memoryEnabled?: boolean;
  personaEnabled?: boolean;
  updatedAt?: number;
}

/** POST /session-config 保存"新会话默认"的 body（不带 sessionId，带 defaults:true） */
export interface SessionDefaultsInput {
  defaults: true;
  memory?: boolean;
  persona?: boolean;
  personaId?: string | null;
}

export interface HealthData {
  ok?: boolean;
  uptimeMs?: number;
  readonly?: boolean;
  lastError?: string | null;
  lastVerify?: VerifyResult | null;
  /** 记忆分层统计（短期/中期/长期；宿主新版本才带） */
  retention?: RetentionStats | null;
  /** 原始层向量索引统计（v3；宿主新版本才带） */
  vectors?: RawVectorStats | null;
  /** 三层记忆遗忘统计（v3；宿主新版本才带） */
  forgetting?: ForgettingStats | null;
  /** 人格状态（v4；宿主新版本才带） */
  persona?: PersonaHealth | null;
}

export interface StatusData {
  dataDir?: string;
  scope?: string;
  vault?: VaultStats;
  storage?: StorageStats;
  layers?: LayerRegistryRow[];
  capture?: CaptureStats;
  derive?: DeriveStats;
  health?: { ok?: boolean; lastError?: string | null; lastVerify?: VerifyResult | null };
  uptimeMs?: number;
  readonly?: boolean;
  embeddingCoverage?: Record<string, number>;
  /** 记忆分层统计（短期/中期/长期） */
  retention?: RetentionStats | null;
  /** 原始层向量索引统计（v3） */
  vectors?: RawVectorStats | null;
  /** 三层记忆遗忘统计（v3） */
  forgetting?: ForgettingStats | null;
  /** 人格状态（v4） */
  persona?: PersonaHealth | null;
}

// ---------------------------------------------------------------------------
// 状态 / 统计 / 健康 / 完整性
// ---------------------------------------------------------------------------

export interface VaultStats {
  records?: number;
  segments?: number;
  days?: number;
  bytes?: number;
  firstId?: string;
  lastId?: string;
  firstTs?: number;
  lastTs?: number;
}

export interface EmbeddingRef {
  model?: string;
  dim?: number;
  version?: string;
}

export interface StorageStats {
  dbPath?: string;
  dbBytes?: number;
  rawCount?: number;
  memoryCount?: number;
  activeMemoryCount?: number;
  vectorCount?: number;
  segmentCount?: number;
  embedding?: EmbeddingRef | null;
  schemaVersion?: number;
}

export interface CaptureStats {
  captured?: number;
  failed?: number;
  queued?: number;
  lastCaptureAt?: number | null;
  dropped?: number;
}

export interface DeriveStats {
  cursors?: Record<string, number>;
  pendingJobs?: number;
  lastDeriveAt?: number | null;
}

export interface VerifyResult {
  ok?: boolean;
  checked?: number;
  error?: { id?: string; seq?: number; reason?: string } | null;
}

export interface IntegrityRunRow {
  id?: number;
  kind?: string;
  startedAt?: number;
  finishedAt?: number | null;
  recordsChecked?: number;
  segmentsChecked?: number;
  ok?: boolean | null;
}

export interface RepairLogRow {
  id?: number;
  ts?: number;
  action?: string;
  target?: string | null;
}

export interface IntegrityData {
  runs?: IntegrityRunRow[];
  lastRun?: IntegrityRunRow | null;
  repairs?: RepairLogRow[];
}

export interface SegmentInfo {
  segment?: string;
  day?: string;
  records?: number;
  bytes?: number;
  sealed?: boolean;
  headHash?: string | null;
  tailHash?: string | null;
}

export interface ManifestData {
  formatVersion?: number;
  vaultId?: string;
  updatedAt?: number;
  segments?: SegmentInfo[];
  stats?: { records?: number; days?: number; bytes?: number };
}

export type TabId = 'overview' | 'retention' | 'persona' | 'raw' | 'layers' | 'search' | 'transfer' | 'integrity';
// ── v6：导入导出（只追加）与原始数据库重构 ─────────────────────────────
export type TransferAction =
  | 'export-session'
  | 'import-session'
  | 'export-vault'
  | 'import-vault'
  | 'export-db'
  | 'import-db'
  | 'export-raw'
  | 'import-raw'
  | 'list-archives';

export interface TransferInput {
  action: TransferAction;
  sessionId?: string | null;
  vault?: string | null;
  path?: string;
  includeMemories?: boolean;
  derive?: boolean;
  targetVault?: string;
  newSessionId?: string | null;
}

export interface TransferResult {
  ok?: boolean;
  file?: string;
  dir?: string;
  bytes?: number;
  sha256?: string;
  rawCount?: number;
  memoryCount?: number;
  newSessionId?: string;
  rawDelta?: number;
  vaultId?: string;
  files?: unknown[];
  [key: string]: unknown;
}

export interface RebuildResult {
  ok?: boolean;
  checked?: number;
  storeBefore?: number;
  indexed?: number;
  reconciled?: boolean;
  vaultId?: string;
  vaultName?: string;
  sessionId?: string | null;
  [key: string]: unknown;
}
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hanxustu (dsh-life-memory)
/**
 * 5 个记忆工具的实现（宿主无关）。
 *
 * 宿主集成层只需：把工具定义（src/tools/schemas.ts）注册给 DSH，收到工具调用后
 * 调用 `handleTool(name, input, ctx)`，把返回的 JSON 作为工具文本结果（或
 * structuredContent）返回给模型。
 *
 * 错误约定（docs/20 §11.3）：失败返回 `{ok:false,error:{code,message,retryable?,detail?}}`，
 * 不抛异常给宿主（异常在 handleTool 内兜底为 E_INTERNAL）。
 */
import { randomUUID } from 'node:crypto';
import type {
  CaptureStats,
  ForgettingStats,
  LayerId,
  MemoryKind,
  MemoryRecord,
  MemoryStore,
  MemoryVaultConfig,
  PersonaActivationResult,
  PersonaDefinition,
  PersonaRoster,
  PersonaSummary,
  RawRecord,
  RawAppendItem,
  RawVectorStats,
  RawVault,
  RecallHit,
  RecallMode,
  RecallQuery,
  Recaller,
  RetentionEngine,
  RetentionStats,
  RetentionTier,
  VaultHealth,
} from '../core/contracts.ts';
import { estimateTokens, truncateToTokens } from '../core/text.ts';
import { maybeRedact } from './redact.ts';
import type { SessionConfigView } from '../session/index.ts';
import {
  SessionArchiveError,
  exportSessionArchive,
  exportVaultArchive,
  importSessionArchive,
  importVaultArchive,
} from '../export/index.ts';
import { resolveVaultDir } from '../vaults/index.ts';

/** 显式保存（memory_save）回调——由 src/layers 的 L3 实现提供 */
export interface SaveExplicitInput {
  text: string;
  kind: MemoryKind;
  importance?: number;
  confidence?: number;
  tags?: string[];
  workspace?: string | null;
  sessionId?: string | null;
  canonicalKey?: string;
  validFrom?: number | null;
  supersedes?: string[];
  sourceRawIds: string[];
  /** 写入时钉住到长期层（memory_save pin=true 默认） */
  pinned?: boolean;
  /** 人格归属（v4；null=共享；undefined=由 layers 决定/共享） */
  personaId?: string | null;
}

export interface SaveExplicitResult {
  memoryId: string;
  layer: LayerId;
  revision: number;
  /** 去重结果：新建 / 重述 / 取代 / 无操作 */
  dedup: 'created' | 'restated' | 'superseded' | 'noop';
  supersededIds?: string[];
  warnings?: string[];
}

export type SaveExplicitFn = (input: SaveExplicitInput) => Promise<SaveExplicitResult>;

/** 人格宿主控制面（集成层注入；工具不直接依赖文件系统） */
export interface PersonaToolHost {
  /** 全部定义（含无效） */
  list(): PersonaDefinition[];
  roster(): PersonaRoster;
  active(): PersonaDefinition | null;
  /** id / name / alias 解析（大小写：id 精确，name/alias 忽略大小写） */
  getByRef(ref: string): PersonaDefinition | undefined;
  /** 激活（持久化 + L0 note 由集成层完成）；null = 取消激活 */
  activate(id: string | null): Promise<PersonaActivationResult>;
  reload(): Promise<PersonaRoster>;
  lastError(): string | null;
}

/** v5：人格 CRUD 控制面（由集成层用 persona/manage.ts + registry.reload + L0 归档实现） */
export interface PersonaAdminHost {
  create(input: {
    id?: string;
    name: string;
    description?: string;
    tags?: string[];
    aliases?: string[];
    body: string;
  }): Promise<{ persona: PersonaSummary; created: boolean }>;
  update(
    id: string,
    patch: { name?: string; description?: string; tags?: string[]; aliases?: string[]; body?: string },
  ): Promise<{ persona: PersonaSummary; updated: boolean }>;
  remove(id: string): Promise<{ deleted: boolean; backupFile?: string }>;
}

/** v5：工具上下文里"当前记忆库"的描述（bundle 已隔离；工具据此做默认作用域） */
export interface ToolVaultScope {
  id: string;
  name: string;
  /** shared → null */
  personaId: string | null;
  sessionId: string | null;
  memoryEnabled: boolean;
  /** v6：库目录绝对路径（导出/导入用；缺省由 dataDir + id 推导） */
  dir?: string;
}

/** v5：会话开关读写（集成层用 session-config 服务实现） */
export interface ToolSessionConfigHost {
  get(sessionId: string): SessionConfigView;
  set(
    sessionId: string,
    patch: {
      memoryEnabled?: boolean;
      personaEnabled?: boolean;
      personaId?: string | null;
      fullCapture?: boolean;
    },
    options?: { backfillHistory?: boolean },
  ): SessionConfigView;
  /** v1.1.8：全局默认（开启记忆时默认是否补档） */
  getDefaults?(): { backfillOnEnable?: boolean; fullCapture?: boolean };
}

/** 共享记忆库的只读视图（人格会话仍可读取共享库；其它人格库不可访问） */
export interface ToolSharedVaultView {
  store: MemoryStore;
  vault: RawVault;
  recaller: Recaller;
  scope: ToolVaultScope;
}

/** 工具运行上下文（由宿主集成层构造） */
export interface ToolContext {
  config: MemoryVaultConfig;
  store: MemoryStore;
  vault: RawVault;
  recaller: Recaller;
  /** 记忆分层引擎（短期/中期/长期 retention；缺失时工具退化为 v1 行为） */
  retention?: RetentionEngine;
  /** 人格宿主控制面（缺失 = 人格功能关闭/未接线：工具退化为无人格作用域） */
  persona?: PersonaToolHost;
  /** 健康状态（含 vault/storage/capture/retention/vectors/forgetting/persona 等） */
  health(): Promise<VaultHealth>;
  /** 捕获计数 */
  captureStats(): CaptureStats;
  /** 派生水位/最近派生时间 */
  deriveStats?(): { cursors: Record<string, number>; pendingJobs: number; lastDeriveAt: number | null };
  /** 显式保存回调（layers 提供；缺失时 memory_save 返回 E_DERIVE_PENDING） */
  saveExplicit?: SaveExplicitFn;
  /**
   * 原始记录落盘后的回调（集成层用于原始层永久向量嵌入；memory_save 直接写 L0 note 时也会触发）。
   * 可选：缺失时仅表示该链路不触发即时向量嵌入（回填 worker 仍会补齐）。
   */
  onRawAppended?: (items: RawAppendItem[]) => void;
  /** L0 行哈希重算（vault 提供；用于 memory_get_raw 校验） */
  hashRawRecord?: (record: RawRecord) => string;
  now?: () => number;
  /** v5：当前解析到的记忆库（缺省 = v4 单库行为） */
  vaultScope?: ToolVaultScope;
  /** v6：导入后运行派生（layers 增量派生；缺失时只做向量回调） */
  deriveNow?: (options?: { reason?: string; sessionId?: string }) => Promise<void>;
  /** v5：结构化禁用（memory=false）；handleTool 统一返回该错误 */
  disabled?: { code: string; message: string };
  /** v5：会话开关读写（memory_session_config 用） */
  sessionConfig?: ToolSessionConfigHost;
  /** v5：人格 CRUD（memory_persona_create/update/delete 用） */
  personaAdmin?: PersonaAdminHost;
  /** v5：记忆库列表统计（memory_status.vaults 用） */
  listVaults?: () => Promise<Array<Record<string, unknown>>>;
  /** v5：按会话解析库 id/名称（memory_session_config 返回当前库用） */
  resolveVault?: (sessionId: string) => { id: string; name: string };
  /** v6：只读访问共享库（人格开启的会话也可读取共享记忆；其它人格库不可访问） */
  sharedVault?: () => Promise<ToolSharedVaultView>;
}

export interface ToolError {
  ok: false;
  error: { code: string; message: string; retryable: boolean; detail?: unknown };
}

export type ToolOk = { ok: true; [key: string]: unknown };
export type ToolResult = ToolOk | ToolError;

const TEXT_LIMIT = 600;
const EXCERPT_LIMIT = 200;
const PAYLOAD_JSON_LIMIT = 64 * 1024;
const RAW_TEXT_LIMIT = 8 * 1024;

/** 解析工具的可选 vault 参数：只允许 "shared"（用于人格会话读取共享记忆） */
async function requestedVault(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<{ view?: ToolSharedVaultView; error?: ToolResult }> {
  const requested = typeof args.vault === 'string' ? args.vault.trim() : '';
  if (requested.length === 0 || requested === ctx.vaultScope?.id) return {};
  if (requested !== 'shared') {
    return {
      error: fail(
        'E_BAD_ARGS',
        'vault 只允许 "shared"（跨人格记忆库不可访问；共享库对所有人格会话可读）',
        false,
        { field: 'vault', allowed: ['shared'] },
      ),
    };
  }
  if (!ctx.sharedVault) {
    return { error: fail('E_UNAVAILABLE', '共享库访问未启用（宿主未提供 sharedVault）', true) };
  }
  return { view: await ctx.sharedVault() };
}

function fail(code: string, message: string, retryable = false, detail?: unknown): ToolError {
  return { ok: false, error: { code, message, retryable, ...(detail !== undefined ? { detail } : {}) } };
}

function nowOf(ctx: ToolContext): number {
  return ctx.now?.() ?? Date.now();
}

function intInRange(value: unknown, min: number, max: number, fallback: number): number {
  const num = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(num)));
}

function numInRange(value: unknown, min: number, max: number, fallback: number): number {
  const num = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.min(max, Math.max(min, num));
}

function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out = value.filter((v): v is string => typeof v === 'string' && v.length > 0);
  return out.length > 0 ? out : undefined;
}

function truncateText(text: string, limit: number): { text: string; truncated: boolean } {
  if (text.length <= limit) return { text, truncated: false };
  return { text: `${text.slice(0, limit)}…`, truncated: true };
}

function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

/** 保留期层视图（memory_recall/save/status 统一形状） */
function retentionViewOf(record: MemoryRecord): { tier: RetentionTier; score: number; pinned: boolean } {
  return {
    tier: record.retentionTier ?? 'short',
    score: typeof record.retentionScore === 'number' ? record.retentionScore : 0,
    pinned: record.pinned === true,
  };
}

/** 派生记忆 -> 工具可返回的精简对象（脱敏 + 长度限制） */
function summarizeMemory(record: MemoryRecord, redact: boolean): Record<string, unknown> {
  const text = truncateText(record.text, TEXT_LIMIT);
  const redacted = maybeRedact(text.text, redact);
  const retention = retentionViewOf(record);
  return {
    id: record.id,
    layer: record.layer,
    kind: record.kind,
    text: redacted.text,
    summary: record.summary ? maybeRedact(record.summary, redact).text : null,
    importance: record.importance,
    confidence: record.confidence,
    validFrom: record.validFrom ?? null,
    validTo: record.validTo ?? null,
    updatedAt: record.updatedAt,
    revision: record.revision,
    tags: record.tags,
    retention,
    retentionTier: retention.tier,
    retentionScore: retention.score,
    pinned: retention.pinned,
    truncations: {
      text: text.truncated,
      ...(redacted.hits.length > 0 ? { secrets: redacted.hits } : {}),
    },
  };
}

/** 读取保留期分层统计（engine 优先；缺失时回退 store；失败给零值） */
async function retentionStatsOf(ctx: ToolContext): Promise<RetentionStats> {
  const empty: RetentionStats = { short: 0, mid: 0, long: 0, pinned: 0, lastTickAt: null };
  try {
    if (ctx.retention) return { ...empty, ...(await ctx.retention.stats()) };
    const stats = ctx.store.retentionStats();
    if (stats && typeof stats === 'object') return { ...empty, ...stats };
  } catch {
    /* 保留期引擎/存储尚未就绪时退化为零值 */
  }
  return empty;
}

// ---------------------------------------------------------------------------
// 人格（persona）工具辅助
// ---------------------------------------------------------------------------

/** 人格摘要（PersonaSummary；UI/工具统一形状） */
function personaSummaryOf(def: PersonaDefinition): PersonaSummary {
  return {
    id: def.id,
    name: def.name,
    description: def.description ?? '',
    tags: def.tags ?? [],
    valid: def.valid === true,
    invalidReason: def.invalidReason ?? null,
    mtime: def.mtime,
  };
}

/** 每个（或共享）人格的派生记忆数量（store.countMemoriesByPersona；失败零值） */
function personaMemoryCountsOf(
  ctx: ToolContext,
  personaId: string | null,
): { total: number; L1: number; L2: number; L3: number } {
  const empty = { total: 0, L1: 0, L2: 0, L3: 0 };
  try {
    const result = ctx.store.countMemoriesByPersona();
    if (personaId === null) return { ...empty, total: Number(result.shared ?? 0) };
    const entry = result.counts?.[personaId];
    return entry ? { total: entry.total, L1: entry.L1, L2: entry.L2, L3: entry.L3 } : empty;
  } catch {
    return empty;
  }
}

/** 当前激活人格 id（同步、无异常） */
function activePersonaIdOf(ctx: ToolContext): string | null {
  try {
    return ctx.persona?.active()?.id ?? null;
  } catch {
    return null;
  }
}

/** 按 id/name/alias 解析人格（无效/未知返回结构化错误） */
function resolvePersonaRef(ctx: ToolContext, ref: string): { def?: PersonaDefinition; error?: ToolError } {
  if (!ctx.persona) return { error: fail('E_PERSONA_DISABLED', '人格功能未启用（persona.enabled=false 或未接线）') };
  const def = ctx.persona.getByRef(ref);
  if (!def) return { error: fail('E_PERSONA_NOT_FOUND', `未知人格：${ref}`, false, { persona: ref }) };
  if (def.valid !== true) {
    return { error: fail('E_PERSONA_INVALID', `人格无效：${def.id}（${def.invalidReason ?? 'unknown'}）`, false, { persona: def.id }) };
  }
  return { def };
}

/** 人格正文预览（脱敏 + 截断） */
function personaBodyPreviewOf(ctx: ToolContext, def: PersonaDefinition, limit = 400): string {
  const redact = ctx.config.safety.redactSecretsInDerived;
  return maybeRedact(truncateText(def.body ?? '', limit).text, redact).text;
}

/** 原文片段（脱敏；来源位置） */
async function rawExcerpts(
  ctx: ToolContext,
  hit: RecallHit,
  redact: boolean,
): Promise<Array<Record<string, unknown>>> {
  const out: Array<Record<string, unknown>> = [];
  const ids = new Set<string>(hit.citations ?? []);
  if (hit.citations) {
    // citations 可能是 raw id 或 memory id；只挑 raw id 形态（日期-序号）
    for (const cite of hit.citations) {
      if (/^\d{4}-\d{2}-\d{2}-\d{6,}$/.test(cite)) ids.add(cite);
    }
  }
  if (hit.raw) {
    ids.add(hit.raw.id);
  }
  for (const id of [...ids].slice(0, 3)) {
    let raw: RawRecord | null = hit.raw && hit.raw.id === id ? hit.raw : null;
    if (!raw) raw = await ctx.vault.get(id);
    if (!raw) continue;
    const index = ctx.store.getRawIndex(id);
    const excerpt = maybeRedact(truncateText(raw.text ?? '', EXCERPT_LIMIT).text, redact);
    out.push({
      id: raw.id,
      excerpt: excerpt.text,
      kind: raw.kind,
      ts: raw.ts,
      segment: index?.segment ?? null,
      lineNo: index?.lineNo ?? null,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// memory_recall
// ---------------------------------------------------------------------------

export async function memoryRecall(input: unknown, ctx: ToolContext): Promise<ToolResult> {
  const startedAt = nowOf(ctx);
  const args = (input ?? {}) as Record<string, unknown>;
  const query = typeof args.query === 'string' ? args.query.trim() : '';
  if (query.length === 0) return fail('E_BAD_ARGS', 'query 不能为空', false, { field: 'query' });
  if (query.length > 2000) return fail('E_BAD_ARGS', 'query 长度超过 2000', false, { field: 'query' });

  const vaultSelection = await requestedVault(args, ctx);
  if (vaultSelection.error) return vaultSelection.error;
  const usingSharedVault = vaultSelection.view !== undefined;
  const effectiveCtx: ToolContext = vaultSelection.view
    ? {
        ...ctx,
        store: vaultSelection.view.store,
        vault: vaultSelection.view.vault,
        recaller: vaultSelection.view.recaller,
      }
    : ctx;

  const limit = intInRange(args.limit, 1, 50, ctx.config.recall.toolDefaultLimit);
  const budgetTokens = intInRange(args.budgetTokens, 200, 8000, 1200);
  const includeRaw = args.includeRaw !== false;
  const includeArchived = args.includeArchived === true;
  const layers = asStringArray(args.layers);
  const kinds = asStringArray(args.kinds);
  // 检索模式（v3）：explicit=原始层（L0+原始层永久向量，默认，永不受遗忘影响）；
  // implicit=三层记忆（可遗忘；调试/兼容旧语义用）
  const mode: RecallMode = args.mode === 'implicit' ? 'implicit' : 'explicit';
  // 保留期层参数（implicit 模式有效）：retentionTiers 只检索指定保留期层
  const retentionTiers = asStringArray(args.retentionTiers) as RetentionTier[] | undefined;
  // 人格作用域（v4）：默认当前激活人格 + 共享；persona=null → 仅共享；allPersonas → 跨人格
  const allPersonas = usingSharedVault ? true : args.allPersonas === true;
  let personaId: string | null | undefined;
  let includeSharedPersona = args.includeSharedPersona !== false;
  if (!allPersonas) {
    if (ctx.vaultScope) {
      // v5：bundle 已按库隔离。缺省不做 persona 过滤（库内记录都属于该库）；
      // 显式 persona=null → 只看共享记录；显式其它人格 → 返回空（跨库不可见）。
      if (args.persona === null || args.persona === '') {
        personaId = null;
        includeSharedPersona = false;
      } else if (typeof args.persona === 'string') {
        const resolved = resolvePersonaRef(ctx, args.persona);
        if (resolved.error) return resolved.error;
        const requestedId = resolved.def!.id;
        personaId = requestedId === ctx.vaultScope.personaId ? requestedId : '__v5_other_vault__';
        includeSharedPersona = false;
      } else {
        personaId = undefined;
      }
    } else if (args.persona === null || args.persona === '') {
      personaId = null;
    } else if (typeof args.persona === 'string') {
      const resolved = resolvePersonaRef(ctx, args.persona);
      if (resolved.error) return resolved.error;
      personaId = resolved.def!.id;
    } else {
      personaId = activePersonaIdOf(ctx) ?? null;
    }
  }
  const recallQuery: RecallQuery = {
    text: query,
    limit: Math.max(limit, 20),
    mode,
    layers: layers as LayerId[] | undefined,
    kinds: kinds as MemoryKind[] | undefined,
    retentionTiers,
    personaId,
    includeSharedPersona,
    sessionId: typeof args.sessionId === 'string' ? args.sessionId : undefined,
    workspace: typeof args.workspace === 'string' ? args.workspace : undefined,
    from: typeof args.from === 'number' ? args.from : undefined,
    to: typeof args.to === 'number' ? args.to : undefined,
    includeRaw,
    minScore: typeof args.minScore === 'number' ? numInRange(args.minScore, 0, 1, 0) : undefined,
    // 工具检索计入治理统计（access_count/heat；原始向量不可变，不受影响）
    trackAccess: true,
  };

  const hits = await effectiveCtx.recaller.recall(recallQuery);
  const filtered =
    mode === 'explicit' || includeArchived
      ? hits
      : hits.filter((hit) => hit.layer === 'raw' || !hit.memory || hit.memory.status !== 'archived');

  const redact = ctx.config.safety.redactSecretsInDerived;
  const items: Array<Record<string, unknown>> = [];
  let usedTokens = 0;
  let truncated = false;
  for (const hit of filtered) {
    if (items.length >= limit) {
      truncated = true;
      break;
    }
    const item = mode === 'explicit' ? explicitItem(hit, redact) : implicitItem(hit, redact);
    if (!item) continue;
    if (includeRaw) {
      // explicit 的原始层命中本身已带 raw 对象；implicit（含 legacy/fake 回退）附原文片段数组
      const hasRawObject = mode === 'explicit' && item.raw !== undefined && !Array.isArray(item.raw);
      if (!hasRawObject) item.raw = await rawExcerpts(ctx, hit, redact);
    }
    const cost = estimateTokens(JSON.stringify(item));
    if (usedTokens + cost > budgetTokens && items.length > 0) {
      truncated = true;
      break;
    }
    usedTokens += cost;
    items.push(item);
  }

  const latencyMs = Math.max(0, nowOf(ctx) - startedAt);
  return {
    ok: true,
    query,
    mode,
    ...(usingSharedVault && vaultSelection.view
      ? { vault: { id: vaultSelection.view.scope.id, name: vaultSelection.view.scope.name } }
      : {}),
    persona: allPersonas ? 'all' : personaId,
    items,
    totalCandidates: filtered.length,
    returned: items.length,
    truncated,
    budgetTokens,
    usedTokens,
    latencyMs,
  };
}

/** 显式检索命中项（原始层原文 + 引用；永不受遗忘影响） */
function explicitItem(hit: RecallHit, redact: boolean): Record<string, unknown> | null {
  const raw = hit.raw;
  // 兼容：召回器未返回 raw 时（例如 fake/旧实现或降级）退回三层记忆形状，避免整条丢失
  if (!raw) return implicitItem(hit, redact);
  const previewText = truncateText(raw.text ?? '', 300);
  const fullText = truncateText(raw.text ?? '', RAW_TEXT_LIMIT);
  return {
    layer: 'raw',
    id: raw.id,
    score: round4(hit.score),
    components: {
      vector: round4(hit.components.vector),
      lexical: round4(hit.components.lexical),
      recency: round4(hit.components.recency),
      importance: round4(hit.components.importance),
    },
    citations: [raw.id],
    raw: {
      id: raw.id,
      ts: raw.ts,
      day: raw.day,
      iso: raw.iso,
      kind: raw.kind,
      sessionId: raw.sessionId,
      workspace: raw.workspace ?? null,
      role: raw.role ?? null,
      textPreview: maybeRedact(previewText.text, redact).text,
      text: maybeRedact(fullText.text, redact).text,
      truncated: previewText.truncated || fullText.truncated,
    },
  };
}

/** 隐式检索命中项（三层记忆；保留期/遗忘影响） */
function implicitItem(hit: RecallHit, redact: boolean): Record<string, unknown> | null {
  const memory = hit.memory;
  if (!memory) return null;
  const item: Record<string, unknown> = {
    ...summarizeMemory(memory, redact),
    score: round4(hit.score),
    components: {
      vector: round4(hit.components.vector),
      lexical: round4(hit.components.lexical),
      recency: round4(hit.components.recency),
      importance: round4(hit.components.importance),
    },
    citations: [
      {
        memoryId: memory.id,
        rawIds: (memory.sourceRawIds ?? []).slice(0, 10),
      },
    ],
    retention: retentionViewOf(memory),
  };
  return item;
}

// ---------------------------------------------------------------------------
// memory_save
// ---------------------------------------------------------------------------

export async function memorySave(input: unknown, ctx: ToolContext): Promise<ToolResult> {
  const args = (input ?? {}) as Record<string, unknown>;
  const rawText = typeof args.text === 'string' ? args.text : '';
  if (rawText.trim().length === 0) return fail('E_BAD_ARGS', 'text 不能为空', false, { field: 'text' });
  if (rawText.length > 4000) return fail('E_BAD_ARGS', 'text 长度超过 4000', false, { field: 'text' });
  const kind = (asStringArray([args.kind])?.[0] ?? 'fact') as MemoryKind;
  const allowed: MemoryKind[] = ['fact', 'preference', 'decision', 'profile', 'summary', 'custom'];
  if (!allowed.includes(kind)) return fail('E_BAD_ARGS', `kind 必须是 ${allowed.join('/')}`, false, { field: 'kind' });

  const now = nowOf(ctx);
  // 会话归属：显式传参优先；否则跟随当前会话（保证"记录属于哪个会话"可追溯、可分组）
  const sessionId =
    typeof args.sessionId === 'string' && args.sessionId.trim().length > 0
      ? args.sessionId.trim()
      : (ctx.vaultScope?.sessionId ?? 'memory_save');
  const workspace = typeof args.workspace === 'string' ? args.workspace : null;
  const tags = asStringArray(args.tags) ?? [];
  // 显式保存默认钉住（pin=true → 直接归入长期记忆层）；pin=false 时从短期层开始按规则晋升
  const pin = args.pin !== false;
  // 人格归属（v4/v5）：缺省 = 当前激活人格；null/空串 = 共享；字符串 = id/name/alias
  let personaId: string | null = null;
  if (ctx.vaultScope) {
    // v5：库已隔离；缺省归属 = 该库代表的人格（shared 库为 null）
    if (args.persona === undefined) {
      personaId = ctx.vaultScope.personaId;
    } else if (args.persona === null || args.persona === '') {
      personaId = null;
    } else if (typeof args.persona === 'string') {
      const resolved = resolvePersonaRef(ctx, args.persona);
      if (resolved.error) return resolved.error;
      if (resolved.def!.id !== ctx.vaultScope.personaId) {
        return fail(
          'E_PERSONA_SCOPE',
          `当前会话使用记忆库 ${ctx.vaultScope.id}（persona=${ctx.vaultScope.personaId ?? 'shared'}），不能写入人格 ${resolved.def!.id} 的库`,
          false,
          { persona: resolved.def!.id, vault: ctx.vaultScope.id },
        );
      }
      personaId = resolved.def!.id;
    } else {
      personaId = ctx.vaultScope.personaId;
    }
  } else if (args.persona === null || args.persona === '') {
    personaId = null;
  } else if (typeof args.persona === 'string') {
    const resolved = resolvePersonaRef(ctx, args.persona);
    if (resolved.error) return resolved.error;
    personaId = resolved.def!.id;
  } else {
    personaId = activePersonaIdOf(ctx);
  }
  const personaTag = personaId ? [`persona:${personaId}`] : [];

  // ① 先写 L0 原始记录（note）——不可变事实来源
  let rawRecord: RawRecord;
  try {
    const result = await ctx.vault.append([
      {
        kind: 'note',
        ts: now,
        timezone: ctx.config.timezone,
        sessionId,
        workspace,
        role: 'system',
        text: rawText,
        // 人格归属：raw_index 索引元数据（不进入 L0 行、不参与哈希）
        personaId,
        payload: {
          source: 'memory_save',
          kind,
          text: rawText,
          workspace,
          tags,
          ...(personaId ? { personaId } : {}),
          ...(typeof args.canonicalKey === 'string' ? { canonicalKey: args.canonicalKey } : {}),
        },
        tags: ['memory_save', `kind:${kind}`, ...personaTag],
        ingestKey: `note:${sessionId}:${now}:${randomUUID()}`,
        meta: { eventType: 'memory_save' },
      },
    ]);
    if (result.items.length === 0) return fail('E_INTERNAL', '写入原始记录失败（无落盘结果）', true);
    rawRecord = result.items[0].record;
    ctx.store.indexRawRecords(result.items);
    // 原始层永久向量：显式保存也走与捕获相同的异步嵌入链路（失败不影响保存）
    try {
      ctx.onRawAppended?.(result.items);
    } catch {
      /* 向量链路失败不影响已保存内容 */
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return fail(message.includes('SQLITE_BUSY') ? 'E_DB_BUSY' : 'E_INTERNAL', `写入原始记录失败：${message}`, true);
  }

  const redact = ctx.config.safety.redactSecretsInDerived;
  const redacted = maybeRedact(rawText, redact);
  const warnings: string[] = [];
  if (redacted.hits.length > 0) {
    warnings.push(`secret:${redacted.hits.join(',')} redacted in derived text（原始记录保留原文）`);
  }

  // ② 派生 L3（layers 提供的回调）；不可用时返回 E_DERIVE_PENDING（raw 已落盘）
  if (!ctx.saveExplicit) {
    return {
      ok: true,
      memoryId: null,
      layer: 'L3',
      revision: 0,
      dedup: 'noop',
      rawId: rawRecord.id,
      supersededIds: [],
      pin,
      warnings: [...warnings, 'derive:pending — L3 派生器不可用，原始记录已保存'],
      deriveStatus: 'pending',
    };
  }

  try {
    const saved = await ctx.saveExplicit({
      text: redacted.text,
      kind,
      importance: numInRange(args.importance, 0, 1, 0.8),
      confidence: numInRange(args.confidence, 0, 1, 0.9),
      tags,
      workspace,
      sessionId,
      canonicalKey: typeof args.canonicalKey === 'string' ? args.canonicalKey : undefined,
      validFrom: typeof args.validFrom === 'number' ? args.validFrom : now,
      supersedes: asStringArray(args.supersedes),
      sourceRawIds: [rawRecord.id],
      // layers 的新签名会据此把新记录写为 pinned/long；旧实现忽略该字段
      pinned: pin,
      // 人格归属（v4；layers 新签名写入 memory_records.persona_id；旧实现忽略）
      personaId,
    });
    // 保留期分层：pin=true → 直接长期层；否则新记忆从短期层开始（tick 单调晋升）
    let retention: { tier: RetentionTier; score: number; pinned: boolean } = {
      tier: pin ? 'long' : 'short',
      score: 0,
      pinned: pin,
    };
    if (ctx.retention && saved.memoryId) {
      try {
        const state = ctx.retention.setTier(saved.memoryId, retention.tier, { pinned: pin, now });
        if (state) retention = { tier: state.tier, score: state.score, pinned: state.pinned };
      } catch {
        /* 保留期写入失败不影响已保存内容 */
      }
    }
    return {
      ok: true,
      memoryId: saved.memoryId,
      layer: saved.layer,
      revision: saved.revision,
      dedup: saved.dedup,
      rawId: rawRecord.id,
      supersededIds: saved.supersededIds ?? [],
      retention,
      pin,
      persona: personaId ? { id: personaId } : null,
      warnings: [...warnings, ...(saved.warnings ?? [])],
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: true,
      memoryId: null,
      layer: 'L3',
      revision: 0,
      dedup: 'noop',
      rawId: rawRecord.id,
      supersededIds: [],
      pin,
      warnings: [...warnings, `derive:failed — ${message}`],
      deriveStatus: 'pending',
    };
  }
}

// ---------------------------------------------------------------------------
// memory_status
// ---------------------------------------------------------------------------

export async function memoryStatus(input: unknown, ctx: ToolContext): Promise<ToolResult> {
  const args = (input ?? {}) as Record<string, unknown>;
  const verbose = args.verbose === true;
  const health = await ctx.health();
  const layers = ctx.store.listLayers();
  const derive = ctx.deriveStats?.() ?? { cursors: {}, pendingJobs: 0, lastDeriveAt: null };
  const retention = await retentionStatsOf(ctx);
  const data: Record<string, unknown> = {
    ok: health.ok,
    dataDir: health.dataDir,
    scope: ctx.config.scope,
    // v5：当前库 id/名称 + 原始库统计（保留 records/segments/days/bytes 既有字段）
    vault: {
      id: ctx.vaultScope?.id ?? 'shared',
      name: ctx.vaultScope?.name ?? '共享记忆库',
      personaId: ctx.vaultScope?.personaId ?? null,
      sessionId: ctx.vaultScope?.sessionId ?? null,
      records: health.vault.records,
      segments: health.vault.segments,
      days: health.vault.days,
      bytes: health.vault.bytes,
      firstId: health.vault.firstId ?? null,
      lastId: health.vault.lastId ?? null,
    },
    storage: {
      dbPath: health.storage.dbPath,
      dbBytes: health.storage.dbBytes,
      rawCount: health.storage.rawCount,
      memoryCount: health.storage.memoryCount,
      activeMemoryCount: health.storage.activeMemoryCount,
      vectorCount: health.storage.vectorCount,
      schemaVersion: health.storage.schemaVersion,
      embedding: health.embedder,
    },
    layers: layers.map((l) => ({
      layer: l.id,
      name: l.name,
      count: l.count,
      active: l.active,
      archived: l.archived,
      latestUpdatedAt: l.latestUpdatedAt,
    })),
    capture: ctx.captureStats(),
    derive,
    retention: {
      short: retention.short,
      mid: retention.mid,
      long: retention.long,
      pinned: retention.pinned,
      lastTickAt: retention.lastTickAt,
    },
    // v3：原始层永久向量索引（只增不改；只读统计，不暴露向量内容）
    vectors: {
      rawIndex: {
        total: health.vectors?.total ?? 0,
        embedded: health.vectors?.embedded ?? 0,
        pending: health.vectors?.pending ?? 0,
        ref: health.vectors?.ref ?? null,
        lastBackfillAt: health.vectors?.lastBackfillAt ?? null,
      },
    },
    // v3：三层记忆遗忘统计（L0/原始层向量永不遗忘）
    forgetting: {
      shortDeleted: health.forgetting?.shortDeleted ?? 0,
      midArchived: health.forgetting?.midArchived ?? 0,
      lastForgetAt: health.forgetting?.lastForgetAt ?? null,
    },
    // v4：人格状态（激活人格 + 定义摘要 + 每人格记忆数）
    persona: health.persona ?? null,
    health: {
      ok: health.ok,
      lastError: health.lastError,
      lastVerify: health.verify ?? null,
    },
    uptimeMs: health.uptimeMs,
  };
  if (verbose) {
    data.integrityRuns = ctx.store.listIntegrityRuns(5);
    data.repairLog = ctx.store.listRepairLog(10);
    data.embeddingCoverage = ctx.store.embeddingCoverage();
  }
  // v5：会话开关 + 各库统计（缺失 provider 时省略，保持 v4 形状兼容）
  if (ctx.sessionConfig && ctx.vaultScope) {
    try {
      const view = ctx.sessionConfig.get(ctx.vaultScope.sessionId ?? '');
      data.session = {
        sessionId: view.sessionId,
        memory: view.memoryEnabled,
        persona: view.personaEnabled,
        personaId: view.personaId,
        memoryEnabled: view.memoryEnabled,
        personaEnabled: view.personaEnabled,
        isDefault: view.isDefault,
        updatedAt: view.updatedAt,
      };
    } catch {
      /* 会话配置不可读时省略 */
    }
  }
  if (ctx.listVaults) {
    try {
      data.vaults = await ctx.listVaults();
    } catch {
      /* 库统计不可读时省略 */
    }
  }
  return { ok: true, ...data };
}

// ---------------------------------------------------------------------------
// memory_get_raw
// ---------------------------------------------------------------------------

export async function memoryGetRaw(input: unknown, ctx: ToolContext): Promise<ToolResult> {
  const args = (input ?? {}) as Record<string, unknown>;
  const id = typeof args.id === 'string' ? args.id.trim() : '';
  if (!/^\d{4}-\d{2}-\d{2}-\d{6,}$/.test(id)) {
    return fail('E_BAD_ARGS', 'id 必须是 YYYY-MM-DD-NNNNNN 格式', false, { field: 'id' });
  }
  const vaultSelection = await requestedVault(args, ctx);
  if (vaultSelection.error) return vaultSelection.error;
  const effectiveCtx: ToolContext = vaultSelection.view
    ? {
        ...ctx,
        store: vaultSelection.view.store,
        vault: vaultSelection.view.vault,
        recaller: vaultSelection.view.recaller,
      }
    : ctx;

  const record = await effectiveCtx.vault.get(id);
  if (!record) return fail('E_RAW_NOT_FOUND', `原始记录不存在：${id}`, false, { id });

  const index = effectiveCtx.store.getRawIndex(id);
  let hashOk: boolean | null = null;
  if (ctx.hashRawRecord) {
    try {
      hashOk = ctx.hashRawRecord(record) === record.hash;
    } catch {
      hashOk = false;
    }
  }

  const text = truncateText(record.text ?? '', RAW_TEXT_LIMIT);
  let payload: unknown = record.payload;
  let payloadTruncated = false;
  try {
    const payloadJson = JSON.stringify(record.payload ?? null);
    if (payloadJson.length > PAYLOAD_JSON_LIMIT) {
      payload = payloadJson.slice(0, PAYLOAD_JSON_LIMIT);
      payloadTruncated = true;
    }
  } catch {
    payload = '[payload not serializable]';
    payloadTruncated = true;
  }

  return {
    ok: true,
    ...(vaultSelection.view ? { vault: { id: vaultSelection.view.scope.id, name: vaultSelection.view.scope.name } } : {}),
    record: {
      ...record,
      text: text.text,
      payload,
    },
    location: index
      ? {
          ingestKey: index.ingestKey,
          segment: index.segment,
          lineNo: index.lineNo,
          byteOffset: index.byteOffset,
          byteLen: index.byteLen,
        }
      : null,
    verify: { hashOk, chainOk: null, checked: ctx.hashRawRecord ? 'hash' : 'skipped' },
    truncated: text.truncated || payloadTruncated,
  };
}

// ---------------------------------------------------------------------------
// memory_layers
// ---------------------------------------------------------------------------

export async function memoryLayers(_input: unknown, ctx: ToolContext): Promise<ToolResult> {
  const layers = ctx.store.listLayers();
  const retention = await retentionStatsOf(ctx);
  return {
    ok: true,
    // 三层记忆模型（L1 工作 / L2 情景 / L3 语义；id/名称来自层注册表）
    layers: layers.map((l) => ({
      id: l.id,
      name: l.name,
      version: l.version,
      dependsOn: l.dependsOn,
      kind: l.kind,
      enabled: l.enabled,
      rebuildable: l.rebuildable,
      count: l.count,
      active: l.active,
      archived: l.archived,
    })),
    // 记忆分层模型（短期/中期/长期 retention；与上面的类型层正交）
    retentionTiers: [
      { id: 'short', name: '短期记忆层', count: retention.short },
      { id: 'mid', name: '中期记忆层', count: retention.mid },
      { id: 'long', name: '长期记忆层', count: retention.long },
    ],
    pinned: retention.pinned,
    lastTickAt: retention.lastTickAt,
  };
}

// ---------------------------------------------------------------------------
// memory_persona_* （v4 人格工具）
// ---------------------------------------------------------------------------

/** 人格列表 + 每人格记忆统计 + 当前激活 */
export async function memoryPersonaList(_input: unknown, ctx: ToolContext): Promise<ToolResult> {
  if (!ctx.persona) return fail('E_PERSONA_DISABLED', '人格功能未启用（persona.enabled=false 或未接线）');
  const roster = ctx.persona.roster();
  const activeId = activePersonaIdOf(ctx);
  const definitions = roster.definitions ?? [];
  const personas = definitions.map((def) => ({
    id: def.id,
    name: def.name,
    description: def.description ?? '',
    tags: def.tags ?? [],
    valid: def.valid === true,
    invalidReason: def.invalidReason ?? null,
    truncated: def.truncated === true,
    memories: personaMemoryCountsOf(ctx, def.id),
  }));
  let shared = 0;
  try {
    shared = Number(ctx.store.countMemoriesByPersona().shared ?? 0);
  } catch {
    shared = 0;
  }
  return {
    ok: true,
    activeId,
    personas,
    sharedMemories: shared,
    errors: roster.errors ?? [],
    loadedAt: roster.loadedAt,
  };
}

/** 切换激活人格（id/name/alias；null/空串 = 取消） */
export async function memoryPersonaUse(input: unknown, ctx: ToolContext): Promise<ToolResult> {
  if (!ctx.persona) return fail('E_PERSONA_DISABLED', '人格功能未启用（persona.enabled=false 或未接线）');
  const args = (input ?? {}) as Record<string, unknown>;
  let targetId: string | null = null;
  let targetDef: PersonaDefinition | null = null;
  if (args.persona !== null && args.persona !== undefined && args.persona !== '') {
    if (typeof args.persona !== 'string') return fail('E_BAD_ARGS', 'persona 必须是字符串或 null', false, { field: 'persona' });
    const resolved = resolvePersonaRef(ctx, args.persona);
    if (resolved.error) return resolved.error;
    targetDef = resolved.def!;
    targetId = targetDef.id;
  }
  const result = await ctx.persona.activate(targetId);
  if (!result.ok) {
    return fail('E_PERSONA_ACTIVATE', result.error ?? '人格激活失败', false, { persona: targetId });
  }
  const activeDef = result.persona ? ctx.persona.getByRef(result.persona.id) ?? targetDef : null;
  const redact = ctx.config.safety.redactSecretsInDerived;
  return {
    ok: true,
    activeId: result.activeId,
    persona: activeDef
      ? {
          id: activeDef.id,
          name: activeDef.name,
          description: activeDef.description ?? '',
          bodyPreview: maybeRedact(truncateText(activeDef.body ?? '', 400).text, redact).text,
          tags: activeDef.tags ?? [],
          aliases: activeDef.aliases ?? [],
        }
      : null,
    memories: result.activeId ? personaMemoryCountsOf(ctx, result.activeId) : null,
  };
}

/** 当前激活人格（定义摘要 + 正文预览 + 记忆统计）；无激活 = null */
export async function memoryPersonaCurrent(_input: unknown, ctx: ToolContext): Promise<ToolResult> {
  if (!ctx.persona) return fail('E_PERSONA_DISABLED', '人格功能未启用（persona.enabled=false 或未接线）');
  const active = ctx.persona.active();
  if (!active) return { ok: true, activeId: null, persona: null, memories: null, lastError: ctx.persona.lastError() };
  const redact = ctx.config.safety.redactSecretsInDerived;
  return {
    ok: true,
    activeId: active.id,
    persona: {
      ...personaSummaryOf(active),
      aliases: active.aliases ?? [],
      model: active.model ?? null,
      provider: active.provider ?? null,
      truncated: active.truncated === true,
      contentHash: active.contentHash,
      sourcePath: active.sourcePath,
      bodyPreview: maybeRedact(truncateText(active.body ?? '', 600).text, redact).text,
      bodyChars: (active.body ?? '').length,
    },
    memories: personaMemoryCountsOf(ctx, active.id),
    lastError: ctx.persona.lastError(),
  };
}

/** 重新扫描人格目录（手工编辑 md 后无需重启） */
export async function memoryPersonaReload(_input: unknown, ctx: ToolContext): Promise<ToolResult> {
  if (!ctx.persona) return fail('E_PERSONA_DISABLED', '人格功能未启用（persona.enabled=false 或未接线）');
  const roster = await ctx.persona.reload();
  const definitions = roster.definitions ?? [];
  return {
    ok: true,
    activeId: roster.activeId ?? activePersonaIdOf(ctx),
    defined: definitions.length,
    valid: definitions.filter((def) => def.valid === true).length,
    invalid: definitions.filter((def) => def.valid !== true).length,
    errors: roster.errors ?? [],
    loadedAt: roster.loadedAt,
    lastError: ctx.persona.lastError(),
  };
}

// ---------------------------------------------------------------------------
// v5：人格 CRUD + 会话开关（docs/26 §4/§3）
// ---------------------------------------------------------------------------

/** 把集成层抛出的带 code 的业务错误转成工具错误（不向宿主抛异常） */
function toolErrorOf(error: unknown, fallbackCode = 'E_INTERNAL'): ToolError {
  const asAny = error as { code?: unknown; message?: unknown } | null;
  const code = typeof asAny?.code === 'string' && asAny.code.length > 0 ? asAny.code : fallbackCode;
  const message = typeof asAny?.message === 'string' ? asAny.message : String(error);
  return fail(code, message, false);
}

function personaAdminOf(ctx: ToolContext): { admin?: PersonaAdminHost; error?: ToolError } {
  if (!ctx.persona || !ctx.personaAdmin) {
    return { error: fail('E_PERSONA_DISABLED', '人格功能未启用（persona.enabled=false 或未接线）') };
  }
  return { admin: ctx.personaAdmin };
}

/** 新建人格（v5）：写 markdown + 热重载 + 定义归档进该人格库 */
export async function memoryPersonaCreate(input: unknown, ctx: ToolContext): Promise<ToolResult> {
  const { admin, error } = personaAdminOf(ctx);
  if (!admin) return error!;
  const args = (input ?? {}) as Record<string, unknown>;
  const name = typeof args.name === 'string' ? args.name.trim() : '';
  const body = typeof args.body === 'string' ? args.body : '';
  if (name.length === 0) return fail('E_BAD_ARGS', 'name 不能为空', false, { field: 'name' });
  if (body.trim().length === 0) return fail('E_BAD_ARGS', 'body 不能为空', false, { field: 'body' });
  const id = typeof args.id === 'string' && args.id.trim().length > 0 ? args.id.trim() : undefined;
  try {
    const result = await admin.create({
      ...(id !== undefined ? { id } : {}),
      name,
      description: typeof args.description === 'string' ? args.description : undefined,
      tags: asStringArray(args.tags),
      aliases: asStringArray(args.aliases),
      body,
    });
    return {
      ok: true,
      created: result.created,
      persona: result.persona,
      vault: { id: result.persona.id, name: result.persona.name },
    };
  } catch (err) {
    return toolErrorOf(err);
  }
}

/** 编辑人格（v5）：部分字段更新 */
export async function memoryPersonaUpdate(input: unknown, ctx: ToolContext): Promise<ToolResult> {
  const { admin, error } = personaAdminOf(ctx);
  if (!admin) return error!;
  const args = (input ?? {}) as Record<string, unknown>;
  const id = typeof args.id === 'string' ? args.id.trim() : '';
  if (id.length === 0) return fail('E_BAD_ARGS', 'id 不能为空', false, { field: 'id' });
  const patch: { name?: string; description?: string; tags?: string[]; aliases?: string[]; body?: string } = {};
  if (typeof args.name === 'string') patch.name = args.name;
  if (typeof args.description === 'string') patch.description = args.description;
  if (args.tags !== undefined) patch.tags = asStringArray(args.tags) ?? [];
  if (args.aliases !== undefined) patch.aliases = asStringArray(args.aliases) ?? [];
  if (typeof args.body === 'string') patch.body = args.body;
  try {
    const result = await admin.update(id, patch);
    return {
      ok: true,
      updated: result.updated,
      persona: result.persona,
      vault: { id: result.persona.id, name: result.persona.name },
    };
  } catch (err) {
    return toolErrorOf(err);
  }
}

/** 删除人格（v5）：markdown 移入 .trash（历史库保留） */
export async function memoryPersonaDelete(input: unknown, ctx: ToolContext): Promise<ToolResult> {
  const { admin, error } = personaAdminOf(ctx);
  if (!admin) return error!;
  const args = (input ?? {}) as Record<string, unknown>;
  const id = typeof args.id === 'string' ? args.id.trim() : '';
  if (id.length === 0) return fail('E_BAD_ARGS', 'id 不能为空', false, { field: 'id' });
  try {
    const result = await admin.remove(id);
    return { ok: true, deleted: result.deleted, id, backupFile: result.backupFile ?? null };
  } catch (err) {
    return toolErrorOf(err);
  }
}

/** 会话级记忆/人格开关（v5）：查看或更新；返回客户端契约形状 */
export async function memorySessionConfig(input: unknown, ctx: ToolContext): Promise<ToolResult> {
  if (!ctx.sessionConfig) return fail('E_DISABLED', '会话配置服务不可用');
  const args = (input ?? {}) as Record<string, unknown>;
  const explicit = typeof args.sessionId === 'string' ? args.sessionId.trim() : '';
  const sessionId = explicit.length > 0 ? explicit : (ctx.vaultScope?.sessionId ?? '');
  if (sessionId.length === 0) {
    return fail('E_BAD_ARGS', '缺少 sessionId（无当前会话上下文时必须显式传入）', false, { field: 'sessionId' });
  }
  const patch: {
    memoryEnabled?: boolean;
    personaEnabled?: boolean;
    personaId?: string | null;
    fullCapture?: boolean;
  } = {};
  if (args.memory !== undefined) patch.memoryEnabled = args.memory === true;
  else if (args.memoryEnabled !== undefined) patch.memoryEnabled = args.memoryEnabled === true;
  if (args.persona !== undefined) patch.personaEnabled = args.persona === true;
  else if (args.personaEnabled !== undefined) patch.personaEnabled = args.personaEnabled === true;
  if (args.fullCapture !== undefined) patch.fullCapture = args.fullCapture === true;
  else if (args.full !== undefined) patch.fullCapture = args.full === true;
  if (args.personaId !== undefined) {
    patch.personaId =
      args.personaId === null
        ? null
        : typeof args.personaId === 'string' && args.personaId.trim().length > 0
          ? args.personaId.trim()
          : null;
  }
  let view: SessionConfigView;
  // v1.1.8：显式 backfill 优先；否则跟随全局偏好（默认 false）。
  const backfillHistory =
    typeof args.backfill === 'boolean'
      ? args.backfill
      : ctx.sessionConfig.getDefaults?.().backfillOnEnable === true;
  try {
    view =
      Object.keys(patch).length > 0
        ? ctx.sessionConfig.set(sessionId, patch, { backfillHistory })
        : ctx.sessionConfig.get(sessionId);
  } catch (err) {
    return fail('E_INTERNAL', `会话配置写入失败：${err instanceof Error ? err.message : String(err)}`, true);
  }
  const resolved = ctx.resolveVault?.(sessionId);
  return {
    ok: true,
    sessionId: view.sessionId,
    memory: view.memoryEnabled,
    persona: view.personaEnabled,
    personaId: view.personaId,
    fullCapture: view.fullCapture,
    backfill: backfillHistory,
    memoryEnabled: view.memoryEnabled,
    personaEnabled: view.personaEnabled,
    isDefault: view.isDefault,
    updatedAt: view.updatedAt,
    vault: { id: resolved?.id ?? 'shared', name: resolved?.name ?? '共享记忆库' },
  };
}

// ---------------------------------------------------------------------------
// v6：会话 / 整库 原始数据导入导出
// ---------------------------------------------------------------------------

/** 归档错误 -> 工具错误（保留 code；未知异常按 E_INTERNAL + retryable） */
function archiveErrorOf(error: unknown): ToolError {
  if (error instanceof SessionArchiveError) return fail(error.code, error.message, false);
  const code = (error as { code?: unknown } | null)?.code;
  return fail(
    typeof code === 'string' && code.length > 0 ? code : 'E_INTERNAL',
    error instanceof Error ? error.message : String(error),
    true,
  );
}

/** 解析库目录（当前库优先用 scope.dir；其它库按 dataDir/vaults/<id>） */
function vaultDirOf(ctx: ToolContext, vaultId?: string): string {
  const scope = ctx.vaultScope;
  const id = vaultId !== undefined && vaultId.length > 0 ? vaultId : (scope?.id ?? 'shared');
  if (scope !== undefined && id === scope.id && typeof scope.dir === 'string' && scope.dir.length > 0) {
    return scope.dir;
  }
  try {
    return resolveVaultDir(ctx.config.dataDir, id);
  } catch {
    return resolveVaultDir(ctx.config.dataDir, 'shared');
  }
}

/** 导出当前/指定会话的原始归档（JSONL） */
export async function memoryExportSession(input: unknown, ctx: ToolContext): Promise<ToolResult> {
  const args = (input ?? {}) as Record<string, unknown>;
  const explicit = typeof args.sessionId === 'string' ? args.sessionId.trim() : '';
  const sessionId = explicit.length > 0 ? explicit : (ctx.vaultScope?.sessionId ?? '');
  if (sessionId.length === 0) {
    return fail('E_BAD_ARGS', '缺少 sessionId（无当前会话上下文时必须显式传入）', false, { field: 'sessionId' });
  }
  try {
    const result = await exportSessionArchive({
      vaultDir: vaultDirOf(ctx),
      store: ctx.store,
      vault: ctx.vault,
      sessionId,
      includeMemories: args.includeMemories !== false,
      dataDir: ctx.config.dataDir,
      vaultId: ctx.vaultScope?.id,
      personaId: ctx.vaultScope?.personaId ?? null,
      now: nowOf(ctx),
      ...(typeof args.path === 'string' && args.path.trim().length > 0 ? { path: args.path.trim() } : {}),
    });
    return { ...result };
  } catch (error) {
    return archiveErrorOf(error);
  }
}

/** 导入会话归档（只追加；生成新 sessionId，返回 id 映射） */
export async function memoryImportSession(input: unknown, ctx: ToolContext): Promise<ToolResult> {
  const args = (input ?? {}) as Record<string, unknown>;
  const file = typeof args.path === 'string' ? args.path.trim() : '';
  if (file.length === 0) return fail('E_BAD_ARGS', 'path 不能为空', false, { field: 'path' });
  const explicitSession = typeof args.sessionId === 'string' ? args.sessionId.trim() : '';
  const derive = args.derive !== false;
  const before = (await ctx.vault.stats()).records;
  try {
    const result = await importSessionArchive({
      targetVaultDir: vaultDirOf(ctx),
      store: ctx.store,
      vault: ctx.vault,
      file,
      now: nowOf(ctx),
      ...(explicitSession.length > 0 ? { newSessionId: explicitSession } : {}),
      deriveHook: (items) => {
        try {
          ctx.onRawAppended?.(items);
        } catch {
          /* 向量链路失败不影响已落盘内容 */
        }
      },
    });
    let derived = false;
    if (derive && ctx.deriveNow) {
      try {
        await ctx.deriveNow({ reason: 'capture', sessionId: result.newSessionId });
        derived = true;
      } catch {
        derived = false;
      }
    }
    const after = (await ctx.vault.stats()).records;
    return { ...result, rawDelta: after - before, derived };
  } catch (error) {
    return archiveErrorOf(error);
  }
}

/** 导出整库目录快照（原始数据库） */
export async function memoryExportVault(input: unknown, ctx: ToolContext): Promise<ToolResult> {
  const args = (input ?? {}) as Record<string, unknown>;
  const requested = typeof args.vault === 'string' ? args.vault.trim() : '';
  const vaultId = requested.length > 0 ? requested : (ctx.vaultScope?.id ?? 'shared');
  try {
    const result = await exportVaultArchive({
      dataDir: ctx.config.dataDir,
      vaultId,
      vaultDir: vaultDirOf(ctx, vaultId),
      now: nowOf(ctx),
      ...(vaultId === (ctx.vaultScope?.id ?? 'shared') ? { store: ctx.store } : {}),
      ...(typeof args.path === 'string' && args.path.trim().length > 0 ? { path: args.path.trim() } : {}),
    });
    return { ...result };
  } catch (error) {
    return archiveErrorOf(error);
  }
}

/** 导入整库归档为新库（目标必须不存在，绝不覆盖） */
export async function memoryImportVault(input: unknown, ctx: ToolContext): Promise<ToolResult> {
  const args = (input ?? {}) as Record<string, unknown>;
  const dir = typeof args.path === 'string' ? args.path.trim() : '';
  const targetId = typeof args.vault === 'string' ? args.vault.trim() : '';
  if (dir.length === 0) return fail('E_BAD_ARGS', 'path 不能为空', false, { field: 'path' });
  if (targetId.length === 0) return fail('E_BAD_ARGS', 'vault 不能为空', false, { field: 'vault' });
  try {
    const result = await importVaultArchive({
      dataDir: ctx.config.dataDir,
      targetVaultId: targetId,
      path: dir,
      timezone: ctx.config.timezone,
      now: nowOf(ctx),
    });
    return { ...result };
  } catch (error) {
    return archiveErrorOf(error);
  }
}

// ---------------------------------------------------------------------------
// 分发 + 文本渲染
// ---------------------------------------------------------------------------

export const TOOL_HANDLERS: Record<string, (input: unknown, ctx: ToolContext) => Promise<ToolResult>> = {
  memory_recall: memoryRecall,
  memory_save: memorySave,
  memory_status: memoryStatus,
  memory_get_raw: memoryGetRaw,
  memory_layers: memoryLayers,
  memory_persona_list: memoryPersonaList,
  memory_persona_use: memoryPersonaUse,
  memory_persona_current: memoryPersonaCurrent,
  memory_persona_reload: memoryPersonaReload,
  memory_persona_create: memoryPersonaCreate,
  memory_persona_update: memoryPersonaUpdate,
  memory_persona_delete: memoryPersonaDelete,
  memory_session_config: memorySessionConfig,
  memory_export_session: memoryExportSession,
  memory_import_session: memoryImportSession,
  memory_export_vault: memoryExportVault,
  memory_import_vault: memoryImportVault,
};

/** 统一入口：按工具名分发；任何异常兜底为 E_INTERNAL（不向宿主抛错） */
/**
 * 递归清洗为 **lossless JSON**。
 *
 * DSH 宿主会校验工具返回值：`isJsonValue` 要求值能被 JSON.stringify 无损往返，
 * 因此 `undefined`（作为对象属性）、`NaN`、`Infinity`、`BigInt`、函数/符号都不合法。
 * 这里统一清洗：对象里丢弃 undefined/function/symbol 属性，数组里 undefined→null，
 * 非有限数字→null，BigInt→字符串，Float32Array→普通数组，Date→ISO 字符串。
 */
export function toLosslessJson(value: unknown, depth = 0): unknown {
  if (depth > 32) return '[max-depth]';
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'undefined') return null;
  if (typeof value === 'function' || typeof value === 'symbol') return null;
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Float32Array || value instanceof Float64Array) return Array.from(value);
  if (Array.isArray(value)) return value.map((item) => toLosslessJson(item, depth + 1));
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (item === undefined || typeof item === 'function' || typeof item === 'symbol') continue;
      out[key] = toLosslessJson(item, depth + 1);
    }
    return out;
  }
  return null;
}

/** 统一入口：按工具名分发；任何异常兜底为 E_INTERNAL（不向宿主抛错） */
export async function handleTool(name: string, input: unknown, ctx: ToolContext): Promise<ToolResult> {
  const handler = TOOL_HANDLERS[name];
  if (!handler) return fail('E_BAD_ARGS', `未知工具：${name}`, false);
  if (!ctx.config.enabled) return fail('E_DISABLED', 'dsh-life-memory 已被配置禁用', false);
  // v5：会话关闭记忆时统一返回结构化禁用（不碰任何库）
  if (ctx.disabled) return fail(ctx.disabled.code, ctx.disabled.message, false);
  try {
    const result = await handler(input, ctx);
    // 宿主对工具返回值做 lossless-JSON 校验，这里保证任何分支都合法
    return toLosslessJson(result) as ToolResult;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return fail(message.includes('SQLITE_BUSY') ? 'E_DB_BUSY' : 'E_INTERNAL', message, true);
  }
}

/** 模型可读的文本渲染（JSON；宿主的工具结果接受字符串） */
export function formatToolResult(result: ToolResult): string {
  return JSON.stringify(result, null, 2);
}

/** 一条命中的人类可读引用行（工具/日志/调试用） */
export function formatHitCitation(hit: RecallHit): string {
  if (hit.memory) {
    const rawRef = hit.memory.sourceRawIds.length > 0 ? `（来源 raw:${hit.memory.sourceRawIds.join(',')}）` : '';
    return `- [mem:${hit.memory.id}] ${truncateToTokens(hit.memory.text, 120)}${rawRef}`;
  }
  if (hit.raw) {
    return `- [raw:${hit.raw.id}] ${truncateToTokens(hit.raw.text ?? '', 120)}`;
  }
  return '- [unknown]';
}
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hanxustu (dsh-life-memory)
/**
 * 记忆库 HTTP API（v6：16 条 GET + 7 条 POST）——宿主无关实现。
 *
 * 宿主集成层负责把请求（method/path/query/body）交给 `handle()`，再把返回的
 * `{status, body}` 写到 DSH 的 HTTP 响应上。
 *
 * 契约（docs/26 §5）：
 * - GET 16 条：既有 14 条 + `/vaults` + `/session-config`；
 * - POST 7 条：`/personas`、`/personas/update`、`/personas/delete`、`/personas/activate`、
 *   `/session-config`（v5），以及 `/transfer`（导入/导出、只追加）与 `/rebuild`（从 L0 重构 raw_index）；
 *   （同源认证由宿主 connection 层保证；handler 只做业务校验）
 * - 既有 GET 支持可选 `vault=` 与 `sessionId=` 作用域参数（缺省按会话配置解析；
 *   无会话上下文时使用共享库）。
 *
 * 只读保证：GET 不调用任何 store 写方法；search 使用 `trackAccess:false`（不污染治理数据）。
 * 响应包络：成功 `{ok:true,data:…}`；失败 `{ok:false,error:{code,message}}`。
 */
import type {
  CaptureStats,
  MemoryQuery,
  MemoryRecord,
  MemoryStore,
  MemoryVaultConfig,
  RawQuery,
  RawVault,
  RecallQuery,
  Recaller,
  RetentionStats,
  RetentionTier,
  VaultHealth,
} from '../core/contracts.ts';
import { truncateToTokens } from '../core/text.ts';
import { SHARED_VAULT_ID, VAULT_ID_RE } from '../vaults/index.ts';

// ---------------------------------------------------------------------------
// v5：按会话/库解析的 HTTP 上下文
// ---------------------------------------------------------------------------

/** 单个记忆库的只读上下文（由集成层按 `sessionId`/`vault` 解析） */
export interface HttpVaultContext {
  vaultId: string;
  vaultName: string;
  /** shared → null */
  personaId: string | null;
  store: MemoryStore;
  vault: RawVault;
  recaller: Recaller;
  health(): Promise<VaultHealth>;
  captureStats(): CaptureStats;
  deriveStats?(): { cursors: Record<string, number>; pendingJobs: number; lastDeriveAt: number | null };
}

/** GET /session-config 的返回形状（同时含 memory/persona 与 memoryEnabled/personaEnabled 别名） */
export interface HttpSessionConfigView {
  sessionId: string;
  memoryEnabled: boolean;
  personaEnabled: boolean;
  personaId: string | null;
  /** v1.2.0：是否记录完整原始事件（思考/工具调用/系统事件等）；false = 只记最终输入/回复 */
  fullCapture: boolean;
  updatedAt: number;
  isDefault: boolean;
  /** v1.1.8：开启记忆时默认补档历史的全局偏好 */
  backfillOnEnable?: boolean;
}

/** GET /vaults 的单库条目（stats.lastUpdatedAt 可由打开的库补齐） */
export interface HttpVaultSummaryLike {
  id: string;
  name: string;
  isPersona: boolean;
  isActive: boolean;
  dir: string;
  stats: {
    rawRecords: number;
    memoryCount: number;
    activeMemoryCount: number;
    dbBytes: number;
    segments: number;
    days?: number;
    vectorCount?: number;
    lastUpdatedAt: number | null;
  };
}

export interface HttpPersonaSummaryLike {
  id: string;
  name: string;
  description?: string;
  tags?: string[];
  valid?: boolean;
  invalidReason?: string | null;
}

export interface HttpPersonaController {
  list(): HttpPersonaSummaryLike[];
  active(): HttpPersonaSummaryLike | null;
  create(input: Record<string, unknown>): Promise<{ persona: HttpPersonaSummaryLike; created: boolean }>;
  update(id: string, patch: Record<string, unknown>): Promise<{ persona: HttpPersonaSummaryLike; updated: boolean }>;
  remove(id: string): Promise<{ deleted: boolean; backupFile?: string }>;
  activate(ref: string | null): Promise<{
    ok: boolean;
    activeId: string | null;
    persona: HttpPersonaSummaryLike | null;
    error?: string;
  }>;
}

/**
 * 集成层实现的作用域解析器（v5）。
 * - `resolve` / `listVaults` / `routingForSession` 只读；
 * - `persona.*` 与 `setSessionConfig` 为写操作（仅 POST 路由调用）。
 */
export interface HttpScopeResolver {
  resolve(options: {
    sessionId: string | null;
    vault: string | null;
    ignoreMemoryDisabled?: boolean;
  }): Promise<HttpVaultContext | null>;
  listVaults(): Promise<HttpVaultSummaryLike[]>;
  activeVaultId(): string;
  activePersonaId(): string | null;
  /** 同步解析会话默认库（GET /session-config 的 vault 字段） */
  routingForSession(sessionId: string | null): { vaultId: string; vaultName: string };
  sessionConfig(sessionId: string | null): HttpSessionConfigView;
  setSessionConfig(
    sessionId: string,
    patch: {
      memoryEnabled?: boolean;
      personaEnabled?: boolean;
      personaId?: string | null;
      fullCapture?: boolean;
    },
    options?: { backfillHistory?: boolean },
  ): HttpSessionConfigView;
  /** "新会话默认"（面板/hero 选项读写；新会话无显式配置时生效） */
  sessionDefaults(): HttpSessionConfigView;
  setSessionDefaults(
    patch: {
      memoryEnabled?: boolean;
      personaEnabled?: boolean;
      personaId?: string | null;
      fullCapture?: boolean;
      backfillOnEnable?: boolean;
    },
  ): HttpSessionConfigView;
  persona: HttpPersonaController;
  /** v6：导入/导出（只追加，不删改历史记忆）；实现由集成层注入 */
  transfer?(input: HttpTransferInput): Promise<unknown>;
  /** v6：从 L0 原始归档重构原始数据库（raw_index 对账/补齐），只增不删 */
  rebuildRaw?(input: { sessionId: string | null; vault: string | null }): Promise<unknown>;
}

/** POST /transfer 的输入（action 四选一） */
export interface HttpTransferInput {
  action:
    | 'export-session'
    | 'import-session'
    | 'export-vault'
    | 'import-vault'
    | 'export-db'
    | 'import-db'
    | 'export-raw'
    | 'import-raw'
    | 'list-archives';
  sessionId?: string | null;
  vault?: string | null;
  /** 导入文件/目录路径；导出可留空用默认位置 */
  path?: string;
  includeMemories?: boolean;
  derive?: boolean;
  /** import-vault：目标新库 id */
  targetVault?: string;
  /** import-session：导入后的新 sessionId */
  newSessionId?: string | null;
}

export interface HttpApiDeps {
  config: MemoryVaultConfig;
  store: MemoryStore;
  vault: RawVault;
  recaller: Recaller;
  health(): Promise<VaultHealth>;
  captureStats(): CaptureStats;
  deriveStats?(): { cursors: Record<string, number>; pendingJobs: number; lastDeriveAt: number | null };
  now?: () => number;
  /** v5：多库/人格/会话解析（缺失 = v4 单库模式，仅用于测试/降级） */
  resolver?: HttpScopeResolver;
}

export interface HttpApiRequest {
  method: string;
  /** 原始 URL 或 path（含 query string） */
  url: string;
  /** v5 POST：已解析的 JSON body（也可传 JSON 字符串，handler 会防御性解析） */
  body?: unknown;
}

export interface HttpApiResponse {
  status: number;
  body: unknown;
}

const RAW_LIMIT_MAX = 200;
const MEMORY_LIMIT_MAX = 100;
/** 保留期分层（短期/中期/长期）合法值 */
const RETENTION_TIERS: readonly RetentionTier[] = ['short', 'mid', 'long'];
const DEFAULT_VAULT_NAME = '共享记忆库';

const DEFAULT_SESSION_CONFIG: HttpSessionConfigView = {
  sessionId: '',
  memoryEnabled: true,
  personaEnabled: false,
  personaId: null,
  fullCapture: false,
  updatedAt: 0,
  isDefault: true,
};

/**
 * 人格作用域解析（v4；v5 在库内仍兼容该过滤）：
 * - `persona=all` / `allPersonas=true` → 不限人格（跨人格）
 * - `persona=<id>` → 指定人格（memories/search 默认含共享；raw 仅该人格）
 * - `persona=shared|none|''` → 仅共享记忆
 * - 缺省：`defaultCurrent=true`（search）→ 当前激活人格 + 共享；否则不过滤（raw/memories 浏览默认全量）
 * - 未知 persona id → 400 E_BAD_REQUEST（与 retention 非法值一致）
 */
type PersonaScope = { all: true } | { all: false; personaId: string | null; includeShared: boolean };

function personaScopeOf(
  query: URLSearchParams,
  health: VaultHealth,
  options: { defaultCurrent: boolean },
): { scope?: PersonaScope; response?: HttpApiResponse } {
  const raw = query.get('persona');
  const allFlag = query.get('allPersonas');
  if (raw === 'all' || allFlag === '1' || allFlag === 'true') return { scope: { all: true } };
  if (raw === null) {
    if (!options.defaultCurrent) return { scope: { all: true } };
    return { scope: { all: false, personaId: health.persona?.activeId ?? null, includeShared: true } };
  }
  const value = raw.trim();
  const lower = value.toLowerCase();
  if (value === '' || lower === 'shared' || lower === 'none') {
    return { scope: { all: false, personaId: null, includeShared: false } };
  }
  const definitions = health.persona?.definitions ?? [];
  if (!definitions.some((definition) => definition.id === value)) {
    return { response: error(400, 'E_BAD_REQUEST', `未知人格：${value}`) };
  }
  return { scope: { all: false, personaId: value, includeShared: true } };
}

/** 单条记忆的嵌套保留期信息（client/UI 统一消费的形状） */
export interface RetentionView {
  tier: RetentionTier;
  score: number;
  pinned: boolean;
}

/**
 * 把 MemoryRecord 归一化为只读预览。
 * 同时提供嵌套 `retention` 与扁平 `retentionTier/retentionScore/pinned`
 * （扁平字段来自 contracts，便于中间版本/其它消费者兼容）。
 */
function retentionViewOf(memory: MemoryRecord): RetentionView {
  return {
    tier: memory.retentionTier ?? 'short',
    score: typeof memory.retentionScore === 'number' ? memory.retentionScore : 0,
    pinned: memory.pinned === true,
  };
}

function memoryPreview(memory: MemoryRecord): Record<string, unknown> {
  const retention = retentionViewOf(memory);
  return {
    id: memory.id,
    layer: memory.layer,
    kind: memory.kind,
    // v5：人格归属（null=共享）+ 会话归属（用于区分"哪些内容在一起"）
    personaId: memory.personaId ?? null,
    sessionId: memory.sessionId ?? null,
    text: truncateToTokens(memory.text, 400),
    summary: memory.summary ?? null,
    importance: memory.importance,
    confidence: memory.confidence,
    status: memory.status ?? 'active',
    validFrom: memory.validFrom ?? null,
    validTo: memory.validTo ?? null,
    updatedAt: memory.updatedAt,
    tags: memory.tags,
    // 嵌套（推荐）+ 扁平（兼容）两套字段
    retention,
    retentionTier: retention.tier,
    retentionScore: retention.score,
    pinned: retention.pinned,
  };
}

function ok(data: unknown): HttpApiResponse {
  return { status: 200, body: { ok: true, data } };
}

function error(status: number, code: string, message: string): HttpApiResponse {
  return { status, body: { ok: false, error: { code, message } } };
}

/** 把集成层抛出的带 code/status 的业务错误转成响应（未知错误 500） */
function errorOf(thrown: unknown): HttpApiResponse {
  const asAny = thrown as { code?: unknown; status?: unknown; message?: unknown } | null;
  const status = typeof asAny?.status === 'number' && asAny.status >= 400 && asAny.status < 600 ? asAny.status : 500;
  const code = typeof asAny?.code === 'string' && asAny.code.length > 0 ? asAny.code : status === 500 ? 'E_INTERNAL' : 'E_BAD_REQUEST';
  const message = typeof asAny?.message === 'string' ? asAny.message : String(thrown);
  return error(status, code, message);
}

function encodeCursor(offset: number): string {
  return Buffer.from(`o:${offset}`, 'utf8').toString('base64url');
}

function decodeCursor(cursor: string | null): number {
  if (!cursor) return 0;
  try {
    const text = Buffer.from(cursor, 'base64url').toString('utf8');
    const match = /^o:(\d{1,9})$/.exec(text);
    return match ? Number(match[1]) : 0;
  } catch {
    return 0;
  }
}

function intParam(value: string | null, fallback: number, min: number, max: number): number {
  if (value === null || value === '') return fallback;
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(num)));
}

function boolParam(value: string | null, fallback: boolean): boolean {
  if (value === null) return fallback;
  const lower = value.toLowerCase();
  if (lower === 'true' || lower === '1') return true;
  if (lower === 'false' || lower === '0') return false;
  return fallback;
}

function listParam(value: string | null): string[] | undefined {
  if (!value) return undefined;
  const items = value
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return items.length > 0 ? items : undefined;
}

function preview(text: string | null, limit = 200): string | null {
  if (!text) return null;
  return truncateToTokens(text, Math.min(200, limit));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** POST body 归一化：对象 / JSON 字符串；缺失 → {}；非法 JSON 抛 E_BAD_REQUEST */
function parseBody(body: unknown): Record<string, unknown> {
  if (body === undefined || body === null) return {};
  if (isRecord(body)) return body;
  if (typeof body === 'string') {
    if (body.trim().length === 0) return {};
    try {
      const parsed: unknown = JSON.parse(body);
      if (isRecord(parsed)) return parsed;
    } catch {
      throw Object.assign(new Error('请求体不是合法 JSON'), { code: 'E_BAD_REQUEST', status: 400 });
    }
    throw Object.assign(new Error('请求体必须是 JSON 对象'), { code: 'E_BAD_REQUEST', status: 400 });
  }
  throw Object.assign(new Error('请求体必须是 JSON 对象'), { code: 'E_BAD_REQUEST', status: 400 });
}

function stringField(body: Record<string, unknown>, field: string, options: { required?: boolean } = {}): string | undefined {
  const value = body[field];
  if (value === undefined || value === null) {
    if (options.required) {
      throw Object.assign(new Error(`缺少字段 ${field}`), { code: 'E_BAD_REQUEST', status: 400 });
    }
    return undefined;
  }
  if (typeof value !== 'string') {
    throw Object.assign(new Error(`字段 ${field} 必须是字符串`), { code: 'E_BAD_REQUEST', status: 400 });
  }
  const trimmed = value.trim();
  if (options.required && trimmed.length === 0) {
    throw Object.assign(new Error(`字段 ${field} 不能为空`), { code: 'E_BAD_REQUEST', status: 400 });
  }
  return trimmed.length > 0 ? trimmed : undefined;
}

/** 解析 path：返回 basePath 之后的路径段 + query；不匹配 basePath 返回 null */
function matchPath(basePath: string, url: string): { segments: string[]; query: URLSearchParams } | null {
  let parsed: URL;
  try {
    parsed = new URL(url, 'http://localhost');
  } catch {
    return null;
  }
  let pathname = parsed.pathname;
  if (pathname.length > 1 && pathname.endsWith('/')) pathname = pathname.slice(0, -1);
  if (pathname === basePath) return { segments: [], query: parsed.searchParams };
  if (!pathname.startsWith(`${basePath}/`)) return null;
  const rest = pathname.slice(basePath.length + 1);
  return { segments: rest.split('/').filter(Boolean), query: parsed.searchParams };
}

function isValidVaultId(value: string): boolean {
  return value === SHARED_VAULT_ID || VAULT_ID_RE.test(value);
}

interface ResolvedRequestContext {
  ctx: HttpVaultContext;
  sessionId: string | null;
}

export class ReadOnlyMemoryApi {
  readonly #deps: HttpApiDeps;
  #now: () => number;

  constructor(deps: HttpApiDeps) {
    this.#deps = deps;
    this.#now = deps.now ?? (() => Date.now());
  }

  async handle(request: HttpApiRequest): Promise<HttpApiResponse> {
    if (!this.#deps.config.enabled || !this.#deps.config.http.enabled) {
      return error(404, 'E_DISABLED', 'HTTP API 已禁用');
    }
    const matched = matchPath(this.#deps.config.http.basePath, request.url);
    if (!matched) return error(404, 'E_NOT_FOUND', '未知接口');
    const method = (request.method || 'GET').toUpperCase();
    if (method !== 'GET' && method !== 'HEAD' && method !== 'POST') {
      return error(405, 'E_METHOD_NOT_ALLOWED', '仅支持 GET/HEAD/POST');
    }
    const { segments, query } = matched;
    try {
      if (method === 'POST') return await this.#writeRoute(segments, request.body);
      return await this.#readRoute(segments, query);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const asAny = err as { code?: unknown; status?: unknown } | null;
      if (typeof asAny?.code === 'string' && typeof asAny?.status === 'number') return errorOf(err);
      if (message.includes('SQLITE_BUSY')) return error(503, 'E_BUSY', '数据库忙，请重试');
      return error(500, 'E_INTERNAL', message);
    }
  }

  /** 解析本请求作用域（会话/库）→ 只读上下文；无 resolver 时退化为 v4 单库 */
  async #context(query: URLSearchParams): Promise<ResolvedRequestContext> {
    const sessionIdRaw = (query.get('sessionId') ?? '').trim();
    const sessionId = sessionIdRaw.length > 0 ? sessionIdRaw : null;
    const vaultRaw = (query.get('vault') ?? '').trim();
    const vault = vaultRaw.length > 0 ? vaultRaw : null;
    if (vault !== null && !isValidVaultId(vault)) {
      throw Object.assign(new Error(`非法记忆库 id：${vault}`), { code: 'E_BAD_REQUEST', status: 400 });
    }
    if (this.#deps.resolver) {
      const ctx = await this.#deps.resolver.resolve({ sessionId, vault, ignoreMemoryDisabled: true });
      if (ctx) return { ctx, sessionId };
    }
    return {
      sessionId,
      ctx: {
        vaultId: SHARED_VAULT_ID,
        vaultName: DEFAULT_VAULT_NAME,
        personaId: null,
        store: this.#deps.store,
        vault: this.#deps.vault,
        recaller: this.#deps.recaller,
        health: this.#deps.health,
        captureStats: this.#deps.captureStats,
        deriveStats: this.#deps.deriveStats,
      },
    };
  }

  // -------------------------------------------------------------------------
  // GET 路由
  // -------------------------------------------------------------------------

  async #readRoute(segments: string[], query: URLSearchParams): Promise<HttpApiResponse> {
    if (segments.length === 0) return error(404, 'E_NOT_FOUND', '缺少接口路径');
    const key = segments.join('/');
    const id = query.get('id') ?? '';
    // 无需库上下文的端点先处理
    if (key === 'vaults') return this.#vaults();
    if (key === 'session-config') return this.#sessionConfig(query);
    const resolved = await this.#context(query);
    const ctx = resolved.ctx;
    switch (key) {
      case 'health':
        return this.#health(ctx, query);
      case 'status':
        return this.#status(ctx, query);
      case 'layers':
        return this.#layers(ctx);
      case 'stats-layers':
        return this.#layerStats(ctx);
      case 'raw':
        return this.#rawList(ctx, query);
      case 'retention':
        return this.#retention(ctx);
      case 'personas':
        return this.#personas(ctx);
      case 'raw-detail':
        if (!id) return error(400, 'E_BAD_REQUEST', 'raw-detail 需要 ?id= 参数');
        return this.#rawDetail(ctx, id);
      case 'raw-verify':
        if (!id) return error(400, 'E_BAD_REQUEST', 'raw-verify 需要 ?id= 参数');
        return this.#rawVerify(ctx, id);
      case 'memories':
        return this.#memoryList(ctx, query);
      case 'memory-detail':
        if (!id) return error(400, 'E_BAD_REQUEST', 'memory-detail 需要 ?id= 参数');
        return this.#memoryDetail(ctx, id);
      case 'search':
        return this.#search(ctx, query);
      case 'manifest':
        return this.#manifest(ctx);
      case 'integrity':
        return this.#integrity(ctx);
      default:
        return error(404, 'E_NOT_FOUND', `未知接口：${key}`);
    }
  }

  /**
   * 记忆库总览（v5 第 15 条只读路由）：
   * `{vaults:[{id,name,isPersona,isActive,dir,stats}], activeVaultId, activePersonaId, generatedAt, readonly}`
   */
  async #vaults(): Promise<HttpApiResponse> {
    let vaults: HttpVaultSummaryLike[] = [];
    if (this.#deps.resolver) {
      try {
        vaults = await this.#deps.resolver.listVaults();
      } catch {
        vaults = [];
      }
    }
    let activeVaultId: string = SHARED_VAULT_ID;
    let activePersonaId: string | null = null;
    try {
      activeVaultId = this.#deps.resolver?.activeVaultId() ?? SHARED_VAULT_ID;
      activePersonaId = this.#deps.resolver?.activePersonaId() ?? null;
    } catch {
      activeVaultId = SHARED_VAULT_ID;
      activePersonaId = null;
    }
    return ok({
      vaults: vaults.map((vault) => ({
        id: vault.id,
        name: vault.name,
        isPersona: vault.isPersona,
        isActive: vault.isActive,
        dir: vault.dir,
        stats: {
          rawRecords: Number(vault.stats?.rawRecords ?? 0),
          memoryCount: Number(vault.stats?.memoryCount ?? 0),
          activeMemoryCount: Number(vault.stats?.activeMemoryCount ?? 0),
          dbBytes: Number(vault.stats?.dbBytes ?? 0),
          segments: Number(vault.stats?.segments ?? 0),
          days: Number(vault.stats?.days ?? 0),
          vectorCount: Number(vault.stats?.vectorCount ?? 0),
          lastUpdatedAt: vault.stats?.lastUpdatedAt ?? null,
        },
      })),
      activeVaultId,
      activePersonaId,
      sharedVaultId: SHARED_VAULT_ID,
      generatedAt: this.#now(),
      readonly: true,
    });
  }

  /**
   * 会话级开关（v5 第 16 条只读路由）：
   * - 带 `?sessionId=` → 该会话配置（缺省 = 新会话默认值 + isDefault:true）
   * - 不带 sessionId → **新会话默认值**（面板/hero 选项读取）+ defaults:true
   */
  #sessionConfig(query: URLSearchParams): HttpApiResponse {
    const sessionId = (query.get('sessionId') ?? '').trim();
    const isDefaults = sessionId.length === 0;
    let view: HttpSessionConfigView = { ...DEFAULT_SESSION_CONFIG, sessionId };
    let routing: { vaultId: string; vaultName: string } = { vaultId: SHARED_VAULT_ID, vaultName: DEFAULT_VAULT_NAME };
    try {
      if (this.#deps.resolver) {
        view = isDefaults ? this.#deps.resolver.sessionDefaults() : this.#deps.resolver.sessionConfig(sessionId);
        routing = this.#deps.resolver.routingForSession(isDefaults ? null : sessionId);
      }
    } catch {
      view = { ...DEFAULT_SESSION_CONFIG, sessionId };
    }
    return ok({
      ...this.#sessionConfigShape(view, sessionId),
      ...(isDefaults ? { sessionId: null, defaults: true } : {}),
      vault: { id: routing.vaultId, name: routing.vaultName },
      generatedAt: this.#now(),
      readonly: true,
    });
  }

  #sessionConfigShape(view: HttpSessionConfigView, fallbackSessionId: string): Record<string, unknown> {
    return {
      sessionId: view.sessionId.length > 0 ? view.sessionId : fallbackSessionId,
      memory: view.memoryEnabled,
      persona: view.personaEnabled,
      personaId: view.personaId,
      memoryEnabled: view.memoryEnabled,
      personaEnabled: view.personaEnabled,
      fullCapture: view.fullCapture,
      updatedAt: view.updatedAt,
      isDefault: view.isDefault,
      ...(view.backfillOnEnable !== undefined ? { backfillOnEnable: view.backfillOnEnable } : {}),
    };
  }

  async #health(ctx: HttpVaultContext, query: URLSearchParams): Promise<HttpApiResponse> {
    const health = await ctx.health();
    const sessionId = (query.get('sessionId') ?? '').trim();
    // v5：当前会话开关 + 各库列表（UI/诊断；失败不影响 health 可用性）
    let session: Record<string, unknown> | null = null;
    let vaults: HttpVaultSummaryLike[] = [];
    if (this.#deps.resolver) {
      try {
        const view = this.#deps.resolver.sessionConfig(sessionId.length > 0 ? sessionId : null);
        const routing = this.#deps.resolver.routingForSession(sessionId.length > 0 ? sessionId : null);
        session = {
          ...this.#sessionConfigShape(view, sessionId),
          vault: { id: routing.vaultId, name: routing.vaultName },
        };
      } catch {
        session = null;
      }
      try {
        vaults = await this.#deps.resolver.listVaults();
      } catch {
        vaults = [];
      }
    }
    return ok({
      ok: health.ok,
      uptimeMs: health.uptimeMs,
      readonly: true,
      lastError: health.lastError,
      lastVerify: health.verify ?? null,
      vaultId: ctx.vaultId,
      vaultName: ctx.vaultName,
      session,
      vaults: vaults.map((vault) => ({
        id: vault.id,
        name: vault.name,
        isPersona: vault.isPersona,
        isActive: vault.isActive,
        stats: vault.stats,
      })),
      retention: health.retention,
      vectors: health.vectors,
      forgetting: health.forgetting,
      persona: health.persona,
    });
  }

  async #status(ctx: HttpVaultContext, query: URLSearchParams): Promise<HttpApiResponse> {
    const verbose = boolParam(query.get('verbose'), false);
    const health = await ctx.health();
    const layers = ctx.store.listLayers();
    const derive = ctx.deriveStats?.() ?? { cursors: {}, pendingJobs: 0, lastDeriveAt: null };
    const data: Record<string, unknown> = {
      dataDir: health.dataDir,
      scope: this.#deps.config.scope,
      vault: health.vault,
      vaultId: ctx.vaultId,
      vaultName: ctx.vaultName,
      storage: health.storage,
      layers,
      capture: ctx.captureStats(),
      derive,
      retention: health.retention,
      vectors: health.vectors,
      forgetting: health.forgetting,
      persona: health.persona,
      health: { ok: health.ok, lastError: health.lastError, lastVerify: health.verify ?? null },
      uptimeMs: health.uptimeMs,
      readonly: true,
    };
    if (verbose) {
      data.integrityRuns = ctx.store.listIntegrityRuns(5);
      data.repairLog = ctx.store.listRepairLog(10);
      data.embeddingCoverage = ctx.store.embeddingCoverage();
    }
    return ok(data);
  }

  /**
   * 保留期分层总览（第 13 条只读路由）：
   * stats = {short,mid,long,pinned,lastTickAt} + countsByLayer + generatedAt + forgetting 摘要。
   * 只读：不写 access/retention 治理数据。
   */
  async #retention(ctx: HttpVaultContext): Promise<HttpApiResponse> {
    const health = await ctx.health();
    const stats: RetentionStats = health.retention;
    let countsByLayer: Record<string, number> = {};
    try {
      countsByLayer = ctx.store.countByLayer();
    } catch {
      countsByLayer = {};
    }
    return ok({
      stats,
      countsByLayer,
      forgetting: health.forgetting,
      vaultId: ctx.vaultId,
      generatedAt: this.#now(),
      readonly: true,
    });
  }

  /**
   * 人格总览（第 14 条只读路由，v4/v5）：
   * activeId + definitions（PersonaSummary + 每人格记忆数）+ memoryCounts + sharedCount。
   * 只读：不写 meta/L0/治理数据。
   */
  async #personas(ctx: HttpVaultContext): Promise<HttpApiResponse> {
    const health = await ctx.health();
    const persona = health.persona;
    const memoryCounts = persona?.memoryCounts ?? {};
    const empty = { total: 0, L1: 0, L2: 0, L3: 0 };
    let definitions: HttpPersonaSummaryLike[] = [];
    let activeId: string | null = persona?.activeId ?? null;
    let activeName: string | null = persona?.activeName ?? null;
    if (this.#deps.resolver) {
      try {
        definitions = this.#deps.resolver.persona.list();
        activeId = this.#deps.resolver.activePersonaId();
        const active = this.#deps.resolver.persona.active();
        activeName = active?.name ?? activeName;
      } catch {
        definitions = (persona?.definitions ?? []) as HttpPersonaSummaryLike[];
      }
    } else {
      definitions = (persona?.definitions ?? []) as HttpPersonaSummaryLike[];
    }
    return ok({
      activeId,
      activeName,
      definitions: definitions.map((definition) => ({
        ...definition,
        memories: memoryCounts[definition.id] ?? empty,
      })),
      memoryCounts,
      sharedCount: Number(persona?.sharedCount ?? 0),
      lastError: persona?.lastError ?? null,
      vaultId: ctx.vaultId,
      generatedAt: this.#now(),
      readonly: true,
    });
  }

  #layers(ctx: HttpVaultContext): HttpApiResponse {
    return ok({ layers: ctx.store.listLayers(), vaultId: ctx.vaultId });
  }

  async #layerStats(ctx: HttpVaultContext): Promise<HttpApiResponse> {
    const layers = ctx.store.listLayers();
    const coverage = ctx.store.embeddingCoverage();
    const vaultStats = await ctx.vault.stats();
    return ok({
      layers: layers.map((l) => ({
        id: l.id,
        name: l.name,
        version: l.version,
        total: l.count,
        active: l.active,
        archived: l.archived,
        latestUpdatedAt: l.latestUpdatedAt,
        embeddingCoverage: coverage[l.id] ?? 0,
      })),
      raw: { records: vaultStats.records, segments: vaultStats.segments, days: vaultStats.days, bytes: vaultStats.bytes },
      vaultId: ctx.vaultId,
    });
  }

  async #rawList(ctx: HttpVaultContext, query: URLSearchParams): Promise<HttpApiResponse> {
    const limit = intParam(query.get('limit'), 50, 1, RAW_LIMIT_MAX);
    const offset = decodeCursor(query.get('cursor'));
    const health = await ctx.health();
    const scopeResult = personaScopeOf(query, health, { defaultCurrent: false });
    if (scopeResult.response) return scopeResult.response;
    const scope = scopeResult.scope!;
    const rawQuery: RawQuery = {
      from: query.get('from') ? Number(query.get('from')) : undefined,
      to: query.get('to') ? Number(query.get('to')) : undefined,
      day: query.get('day') ?? undefined,
      sessionId: query.get('sessionId') ?? undefined,
      workspace: query.get('workspace') ?? undefined,
      kinds: listParam(query.get('kind')) as RawQuery['kinds'],
      ...(scope.all ? {} : { personaId: scope.personaId ?? null }),
      desc: boolParam(query.get('desc'), false),
      offset,
      limit,
    };
    const { records, total } = ctx.store.listRawIndex(rawQuery);
    const nextOffset = offset + records.length;
    return ok({
      items: records.map((r) => ({
        id: r.id,
        seq: r.seq,
        ts: r.ts,
        iso: r.iso,
        day: r.day,
        kind: r.kind,
        sessionId: r.sessionId,
        workspace: r.workspace,
        role: r.role,
        personaId: r.personaId ?? null,
        textPreview: preview(r.text),
        hash: r.hash,
        segment: r.segment,
        lineNo: r.lineNo,
      })),
      total,
      nextCursor: nextOffset < total ? encodeCursor(nextOffset) : null,
      vaultId: ctx.vaultId,
    });
  }

  async #rawDetail(ctx: HttpVaultContext, id: string): Promise<HttpApiResponse> {
    const record = await ctx.vault.get(id);
    if (!record) return error(404, 'E_NOT_FOUND', `原始记录不存在：${id}`);
    const index = ctx.store.getRawIndex(id);
    return ok({
      record,
      location: index
        ? {
            ingestKey: index.ingestKey,
            segment: index.segment,
            lineNo: index.lineNo,
            byteOffset: index.byteOffset,
            byteLen: index.byteLen,
          }
        : null,
      verify: { hashOk: null, chainOk: null, checked: 'not-run（UI 可调用 /raw/:id/verify）' },
      vaultId: ctx.vaultId,
    });
  }

  async #rawVerify(ctx: HttpVaultContext, id: string): Promise<HttpApiResponse> {
    const record = await ctx.vault.get(id);
    if (!record) return error(404, 'E_NOT_FOUND', `原始记录不存在：${id}`);
    return ok({
      id,
      exists: true,
      hashPresent: typeof record.hash === 'string' && record.hash.length === 64,
      prevHashPresent: typeof record.prevHash === 'string' && record.prevHash.length === 64,
      checked: 'record-fields',
      note: '完整哈希链校验请调用 memory_status(verbose) 或后台 fsck',
      vaultId: ctx.vaultId,
    });
  }

  async #memoryList(ctx: HttpVaultContext, query: URLSearchParams): Promise<HttpApiResponse> {
    const limit = intParam(query.get('limit'), 50, 1, MEMORY_LIMIT_MAX);
    const offset = decodeCursor(query.get('cursor'));
    const q = query.get('q');
    const statusParam = query.get('status');
    // 保留期过滤：?retention=short|mid|long（可逗号分隔多个）；非法值 400
    const retentionParam = query.get('retention');
    let retentionTiers: RetentionTier[] | undefined;
    if (retentionParam) {
      const requested = retentionParam
        .split(',')
        .map((value) => value.trim())
        .filter((value) => value.length > 0);
      const invalid = requested.filter((value) => !RETENTION_TIERS.includes(value as RetentionTier));
      if (invalid.length > 0) {
        return error(400, 'E_BAD_REQUEST', `retention 只支持 ${RETENTION_TIERS.join('/')}（收到：${invalid.join(',')}）`);
      }
      retentionTiers = requested as RetentionTier[];
    }
    // 人格作用域（v4）：?persona=<id>|shared|all；缺省浏览全量
    const health = await ctx.health();
    const scopeResult = personaScopeOf(query, health, { defaultCurrent: false });
    if (scopeResult.response) return scopeResult.response;
    const scopeMemory = scopeResult.scope!;
    const memoryQuery: MemoryQuery = {
      layers: listParam(query.get('layer')),
      kinds: listParam(query.get('kind')) as MemoryQuery['kinds'],
      workspace: query.get('workspace') ?? undefined,
      sessionId: query.get('sessionId') ?? undefined,
      ...(scopeMemory.all
        ? {}
        : { personaId: scopeMemory.personaId ?? null, includeSharedPersona: scopeMemory.includeShared }),
      onlyValid: boolParam(query.get('onlyValid'), true),
      status: statusParam && statusParam !== 'all' ? ([statusParam] as MemoryQuery['status']) : undefined,
      retentionTiers,
      pinned: query.get('pinned') === null ? undefined : boolParam(query.get('pinned'), false),
      offset: q ? 0 : offset,
      limit: q ? 200 : limit,
      desc: true,
    };
    let records = ctx.store.listMemories(memoryQuery);
    if (q) {
      // 词法检索：先取命中 id，再按原查询过滤
      const hits = ctx.store.searchLexical(q, { layers: memoryQuery.layers, kinds: memoryQuery.kinds, limit: 200 });
      const byId = new Map(records.map((r) => [r.id, r]));
      records = hits.map((h) => byId.get(h.id)).filter((r): r is NonNullable<typeof r> => Boolean(r));
      if (records.length === 0) records = ctx.store.listMemories({ ...memoryQuery, ids: hits.map((h) => h.id) });
    }
    const page = records.slice(offset, offset + limit);
    return ok({
      items: page.map(memoryPreview),
      total: records.length,
      nextCursor: offset + limit < records.length ? encodeCursor(offset + limit) : null,
      vaultId: ctx.vaultId,
    });
  }

  async #memoryDetail(ctx: HttpVaultContext, id: string): Promise<HttpApiResponse> {
    const memory = ctx.store.getMemory(id);
    if (!memory) return error(404, 'E_NOT_FOUND', `派生记忆不存在：${id}`);
    return ok({
      memory: { ...memory, retention: retentionViewOf(memory) },
      retention: retentionViewOf(memory),
      sources: ctx.store.listSources(id),
      revisions: ctx.store.listRevisions(id),
      l3Semantic: memory.layer === 'L3' ? ctx.store.getL3Semantic(id) : null,
      vaultId: ctx.vaultId,
    });
  }

  async #search(ctx: HttpVaultContext, query: URLSearchParams): Promise<HttpApiResponse> {
    const startedAt = this.#now();
    const q = (query.get('q') ?? '').trim();
    if (!q) return error(400, 'E_BAD_REQUEST', '缺少查询参数 q');
    const limit = intParam(query.get('limit'), 10, 1, 50);
    const modeParam = query.get('mode');
    if (modeParam !== null && modeParam !== 'explicit' && modeParam !== 'implicit') {
      return error(400, 'E_BAD_REQUEST', `mode 只支持 explicit/implicit（收到：${modeParam}）`);
    }
    const mode = (modeParam ?? 'explicit') as 'explicit' | 'implicit';
    const retentionTiers = listParam(query.get('retention')) as RetentionTier[] | undefined;
    // 人格作用域（v4）：/search 缺省 = 当前激活人格 + 共享；persona=<id>|shared|all
    const health = await ctx.health();
    const scopeResult = personaScopeOf(query, health, { defaultCurrent: true });
    if (scopeResult.response) return scopeResult.response;
    const scope = scopeResult.scope!;
    const recallQuery: RecallQuery = {
      text: q,
      limit,
      mode,
      layers: listParam(query.get('layers')),
      includeRaw: true,
      ...(scope.all ? {} : { personaId: scope.personaId ?? null, includeSharedPersona: scope.includeShared }),
      // 只读 HTTP/UI：浏览不得改变治理数据（access/heat/retention）
      trackAccess: false,
      minScore: query.get('minScore') ? Number(query.get('minScore')) : undefined,
      retentionTiers,
    };
    const hits = await ctx.recaller.recall(recallQuery);
    return ok({
      mode,
      persona: scope.all ? 'all' : (scope.personaId ?? null),
      vaultId: ctx.vaultId,
      items: hits.map((hit) => ({
        layer: hit.layer,
        score: Math.round(hit.score * 10_000) / 10_000,
        components: hit.components,
        memory: hit.memory ? { ...hit.memory, retention: retentionViewOf(hit.memory) } : null,
        // 显式检索：原始记录原文（永久，不受遗忘影响）
        raw: hit.raw
          ? {
              id: hit.raw.id,
              ts: hit.raw.ts,
              day: hit.raw.day,
              iso: hit.raw.iso,
              kind: hit.raw.kind,
              sessionId: hit.raw.sessionId,
              workspace: hit.raw.workspace ?? null,
              role: hit.raw.role ?? null,
              personaId: hit.raw.personaId ?? null,
              text: truncateToTokens(hit.raw.text ?? '', 2000),
            }
          : null,
        citations: hit.citations,
      })),
      truncated: hits.length >= limit,
      latencyMs: Math.max(0, this.#now() - startedAt),
    });
  }

  async #manifest(ctx: HttpVaultContext): Promise<HttpApiResponse> {
    // 注意：manifest.vaultId 是 L0 库 UUID（不是记忆库 id），不要覆盖
    return ok(await ctx.vault.manifest());
  }

  #integrity(ctx: HttpVaultContext): HttpApiResponse {
    return ok({
      runs: ctx.store.listIntegrityRuns(20),
      lastRun: ctx.store.getLastIntegrityRun(),
      repairs: ctx.store.listRepairLog(20),
      vaultId: ctx.vaultId,
    });
  }

  // -------------------------------------------------------------------------
  // POST 路由（v5 写操作；同源认证由宿主 connection 层保证）
  // -------------------------------------------------------------------------

  async #writeRoute(segments: string[], rawBody: unknown): Promise<HttpApiResponse> {
    const key = segments.join('/');
    const body = parseBody(rawBody);
    const resolver = this.#deps.resolver;
    switch (key) {
      case 'personas':
        return this.#personaCreate(body, resolver);
      case 'personas/update':
        return this.#personaUpdate(body, resolver);
      case 'personas/delete':
        return this.#personaDelete(body, resolver);
      case 'personas/activate':
        return this.#personaActivate(body, resolver);
      case 'session-config':
        return this.#sessionConfigWrite(body, resolver);
      case 'transfer':
        return this.#transferWrite(body, resolver);
      case 'rebuild':
        return this.#rebuildWrite(body, resolver);
      default:
        return error(404, 'E_NOT_FOUND', `未知写接口：${key}`);
    }
  }

  async #personaCreate(body: Record<string, unknown>, resolver: HttpScopeResolver | undefined): Promise<HttpApiResponse> {
    if (!resolver) return error(404, 'E_NOT_FOUND', '人格写接口未就绪');
    const name = stringField(body, 'name', { required: true })!;
    const personaBody = stringField(body, 'body', { required: true })!;
    const input: Record<string, unknown> = { name, body: personaBody };
    const id = stringField(body, 'id');
    if (id) input.id = id;
    const description = stringField(body, 'description');
    if (description !== undefined) input.description = description;
    if (Array.isArray(body.tags)) input.tags = body.tags.filter((item): item is string => typeof item === 'string');
    if (Array.isArray(body.aliases)) input.aliases = body.aliases.filter((item): item is string => typeof item === 'string');
    const result = await resolver.persona.create(input);
    return ok({ persona: result.persona, created: result.created, vault: { id: result.persona.id, name: result.persona.name } });
  }

  async #personaUpdate(body: Record<string, unknown>, resolver: HttpScopeResolver | undefined): Promise<HttpApiResponse> {
    if (!resolver) return error(404, 'E_NOT_FOUND', '人格写接口未就绪');
    const id = stringField(body, 'id', { required: true })!;
    const patch: Record<string, unknown> = {};
    if (body.name !== undefined) patch.name = stringField(body, 'name');
    if (body.description !== undefined) patch.description = typeof body.description === 'string' ? body.description : '';
    if (Array.isArray(body.tags)) patch.tags = body.tags.filter((item): item is string => typeof item === 'string');
    if (Array.isArray(body.aliases)) patch.aliases = body.aliases.filter((item): item is string => typeof item === 'string');
    if (body.body !== undefined) {
      const value = stringField(body, 'body');
      if (!value) throw Object.assign(new Error('字段 body 不能为空'), { code: 'E_BAD_REQUEST', status: 400 });
      patch.body = value;
    }
    const result = await resolver.persona.update(id, patch);
    return ok({ persona: result.persona, updated: result.updated });
  }

  async #personaDelete(body: Record<string, unknown>, resolver: HttpScopeResolver | undefined): Promise<HttpApiResponse> {
    if (!resolver) return error(404, 'E_NOT_FOUND', '人格写接口未就绪');
    const id = stringField(body, 'id', { required: true })!;
    const result = await resolver.persona.remove(id);
    return ok({ deleted: result.deleted, id, backupFile: result.backupFile ?? null });
  }

  async #personaActivate(body: Record<string, unknown>, resolver: HttpScopeResolver | undefined): Promise<HttpApiResponse> {
    if (!resolver) return error(404, 'E_NOT_FOUND', '人格写接口未就绪');
    if (!('persona' in body)) {
      return error(400, 'E_BAD_REQUEST', '缺少字段 persona（null 表示取消激活）');
    }
    const raw = body.persona;
    if (raw !== null && typeof raw !== 'string') {
      return error(400, 'E_BAD_REQUEST', '字段 persona 必须是字符串或 null');
    }
    const ref = typeof raw === 'string' && raw.trim().length > 0 ? raw.trim() : null;
    const result = await resolver.persona.activate(ref);
    if (!result.ok) {
      const notFound = /not found|不存在/i.test(result.error ?? '');
      return error(notFound ? 404 : 400, notFound ? 'E_PERSONA_NOT_FOUND' : 'E_PERSONA_INVALID', result.error ?? '人格激活失败');
    }
    const routing = resolver.routingForSession(null);
    return ok({
      activeId: result.activeId,
      persona: result.persona,
      vault: { id: routing.vaultId, name: routing.vaultName },
    });
  }

  #sessionConfigWrite(body: Record<string, unknown>, resolver: HttpScopeResolver | undefined): HttpApiResponse {
    if (!resolver) return error(404, 'E_NOT_FOUND', '会话配置写接口未就绪');
    const patch: {
      memoryEnabled?: boolean;
      personaEnabled?: boolean;
      personaId?: string | null;
      fullCapture?: boolean;
    } = {};
    const defaultsPatch: {
      memoryEnabled?: boolean;
      personaEnabled?: boolean;
      personaId?: string | null;
      fullCapture?: boolean;
      backfillOnEnable?: boolean;
    } = {};
    if (body.memory !== undefined) patch.memoryEnabled = body.memory === true;
    else if (body.memoryEnabled !== undefined) patch.memoryEnabled = body.memoryEnabled === true;
    if (body.persona !== undefined) patch.personaEnabled = body.persona === true;
    else if (body.personaEnabled !== undefined) patch.personaEnabled = body.personaEnabled === true;
    if (body.fullCapture !== undefined) patch.fullCapture = body.fullCapture === true;
    else if (body.full !== undefined) patch.fullCapture = body.full === true;
    if (body.personaId !== undefined) {
      patch.personaId = body.personaId === null ? null : typeof body.personaId === 'string' && body.personaId.trim().length > 0 ? body.personaId.trim() : null;
    }
    defaultsPatch.memoryEnabled = patch.memoryEnabled;
    defaultsPatch.personaEnabled = patch.personaEnabled;
    defaultsPatch.personaId = patch.personaId;
    defaultsPatch.fullCapture = patch.fullCapture;
    if (body.backfillOnEnable !== undefined) defaultsPatch.backfillOnEnable = body.backfillOnEnable === true;
    const rawSessionId = typeof body.sessionId === 'string' ? body.sessionId.trim() : '';
    const isDefaults = body.defaults === true || rawSessionId.length === 0;
    if (isDefaults) {
      const hasDefaultsPatch = Object.values(defaultsPatch).some((value) => value !== undefined);
      const view = hasDefaultsPatch ? resolver.setSessionDefaults(defaultsPatch) : resolver.sessionDefaults();
      const routing = resolver.routingForSession(null);
      return ok({
        ...this.#sessionConfigShape(view, ''),
        sessionId: null,
        defaults: true,
        vault: { id: routing.vaultId, name: routing.vaultName },
      });
    }
    const sessionId = rawSessionId;
    // v1.1.8：backfill=true/false 明确选择是否补档；缺省由宿主使用全局偏好。
    const backfillHistory =
      body.backfill === true || body.backfillHistory === true
        ? true
        : body.backfill === false || body.backfillHistory === false
          ? false
          : undefined;
    const view =
      Object.keys(patch).length > 0
        ? resolver.setSessionConfig(sessionId, patch, backfillHistory === undefined ? undefined : { backfillHistory })
        : resolver.sessionConfig(sessionId);
    const routing = resolver.routingForSession(sessionId);
    return ok({
      ...this.#sessionConfigShape(view, sessionId),
      vault: { id: routing.vaultId, name: routing.vaultName },
    });
  }
  /** POST /transfer：会话/整库 导入导出（导入只追加，绝不删改已有记忆） */
  async #transferWrite(
    body: Record<string, unknown>,
    resolver: HttpScopeResolver | undefined,
  ): Promise<HttpApiResponse> {
    if (!resolver?.transfer) return error(404, 'E_NOT_FOUND', '导入导出接口未就绪');
    const action = stringField(body, 'action', { required: true })!;
    const allowed: HttpTransferInput['action'][] = [
      'export-session',
      'import-session',
      'export-vault',
      'import-vault',
      'export-db',
      'import-db',
      'export-raw',
      'import-raw',
      'list-archives',
    ];
    if (!(allowed as string[]).includes(action)) {
      return error(400, 'E_BAD_REQUEST', `action 必须是 ${allowed.join(' / ')}`);
    }
    const input: HttpTransferInput = { action: action as HttpTransferInput['action'] };
    const sessionId = stringField(body, 'sessionId');
    if (sessionId !== undefined) input.sessionId = sessionId;
    const vault = stringField(body, 'vault');
    if (vault !== undefined) input.vault = vault;
    const pathValue = stringField(body, 'path');
    if (pathValue !== undefined) input.path = pathValue;
    if (body.includeMemories !== undefined) input.includeMemories = body.includeMemories === true;
    if (body.derive !== undefined) input.derive = body.derive === true;
    const targetVault = stringField(body, 'targetVault');
    if (targetVault !== undefined) input.targetVault = targetVault;
    const newSessionId = stringField(body, 'newSessionId');
    if (newSessionId !== undefined) input.newSessionId = newSessionId;
    const isImport = action.startsWith('import-');
    const isVaultImport = action === 'import-vault' || action === 'import-db' || action === 'import-raw';
    if (isImport && (input.path === undefined || input.path.length === 0)) {
      return error(400, 'E_BAD_REQUEST', '导入必须提供 path');
    }
    if (isVaultImport && (input.targetVault === undefined || input.targetVault.length === 0)) {
      return error(400, 'E_BAD_REQUEST', 'import-vault 必须提供 targetVault（新库 id）');
    }
    try {
      const result = await resolver.transfer(input);
      return ok(result);
    } catch (err) {
      return archiveErrorOf(err);
    }
  }

  /** POST /rebuild：从 L0 重构原始数据库（raw_index 对账/补齐；只增不删） */
  async #rebuildWrite(
    body: Record<string, unknown>,
    resolver: HttpScopeResolver | undefined,
  ): Promise<HttpApiResponse> {
    if (!resolver?.rebuildRaw) return error(404, 'E_NOT_FOUND', '重构接口未就绪');
    const sessionId = stringField(body, 'sessionId');
    const vault = stringField(body, 'vault');
    try {
      const result = await resolver.rebuildRaw({ sessionId: sessionId ?? null, vault: vault ?? null });
      return ok(result);
    } catch (err) {
      return archiveErrorOf(err);
    }
  }
}


/** 把导入导出/重构异常映射为 HTTP 包络（code 优先，其次 status） */
function archiveErrorOf(thrown: unknown): HttpApiResponse {
  const asAny = thrown as { code?: unknown; status?: unknown; message?: unknown } | null;
  const code = typeof asAny?.code === 'string' && asAny.code.length > 0 ? asAny.code : 'E_INTERNAL';
  const message = typeof asAny?.message === 'string' && asAny.message.length > 0 ? asAny.message : '导入导出失败';
  const status =
    typeof asAny?.status === 'number' && asAny.status >= 400 && asAny.status < 600
      ? asAny.status
      : code === 'E_BAD_ARGS' || code === 'E_BAD_REQUEST' || code === 'E_ARCHIVE_INVALID'
        ? 400
        : code === 'E_ARCHIVE_NOT_FOUND' || code === 'E_VAULT_NOT_FOUND' || code === 'E_NOT_FOUND'
          ? 404
          : code === 'E_EXPORT_EXISTS' || code === 'E_VAULT_EXISTS'
            ? 409
            : 500;
  return error(status, code, message);
}

/** 便捷：创建 API 实例 */
export function createReadOnlyApi(deps: HttpApiDeps): ReadOnlyMemoryApi {
  return new ReadOnlyMemoryApi(deps);
}

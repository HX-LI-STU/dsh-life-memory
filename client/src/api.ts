// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hanxustu (dsh-life-memory)
/**
 * 只读 HTTP API 客户端（浏览器同源 fetch）。
 *
 * 权威路由方案（Lead 2026-10-25 决定，已实现在 src/http/register.ts）：
 *   base = `/api/life-memory`（`config.http.basePath` 的默认值）
 *   GET /api/life-memory/{health,status,layers,stats-layers,retention,raw,raw-detail?id=,
 *       raw-verify?id=,memories,memory-detail?id=,search,manifest,integrity}
 *   包络 `{ok:true,data}` / `{ok:false,error:{code,message}}`，仅 GET/HEAD。
 *
 * 设计约束：
 * - 不写任何宿主状态；只发 GET；不把数据写进 localStorage/sessionStorage。
 * - base 在首次调用时探测一次（health），失败则尝试 `dsh-life-memory` 变体；
 *   全部失败时抛 {@link ApiUnavailableError}，由 UI 渲染空态/横幅，不崩溃。
 * - 单请求超时 + AbortController，避免网络挂起让面板一直转圈。
 * - 错误信息只保留 code + message（不展示 stack trace）。
 */
import type {
  ApiEnvelope,
  HealthData,
  IntegrityData,
  LayerStatsData,
  LayersData,
  ManifestData,
  MemoryDetailData,
  MemoryListData,
  PersonaActivateData,
  PersonaActivateInput,
  PersonaCreateData,
  PersonaCreateInput,
  PersonaData,
  PersonaDeleteData,
  PersonaDeleteInput,
  PersonaUpdateData,
  PersonaUpdateInput,
  RawDetailData,
  RawListData,
  RawVerifyData,
  RetentionData,
  SearchData,
  SessionConfig,
  SessionConfigInput,
  SessionDefaults,
  SessionDefaultsInput,
  StatusData,
  VaultsData,
} from './types.ts';
import type { RebuildResult, TransferInput, TransferResult } from './types.ts';

/** 候选 base（顺序即优先级；与宿主 register.ts 的 clientBasePath 对齐） */
const CANDIDATE_BASES = ['/api/life-memory', '/api/dsh-life-memory'] as const;

const REQUEST_TIMEOUT_MS = 12_000;

/** API 错误：code/message 面向 UI；不携带 stack */
export class ApiError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status = 0) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
  }
}

/** 所有候选 base 都不可用（API 未启用 / 路由未挂载 / 未认证） */
export class ApiUnavailableError extends ApiError {
  readonly attempts: string[];

  constructor(message: string, attempts: string[]) {
    super('E_UNAVAILABLE', message, 0);
    this.name = 'ApiUnavailableError';
    this.attempts = attempts;
  }
}

/** 当前解析到的 base（模块级缓存；刷新页面即重新探测） */
let resolvedBase: string | null = null;
let resolvePromise: Promise<string> | null = null;
let lastAttempts: string[] = [];
let lastResolvedAt = 0;

/** 供 UI 显示（诊断用；不含敏感内容） */
export function apiDiagnostics(): { base: string | null; attempts: string[]; resolvedAt: number } {
  return { base: resolvedBase, attempts: [...lastAttempts], resolvedAt: lastResolvedAt };
}

interface RawResponse {
  status: number;
  body: unknown;
  text: string;
  contentType: string;
}

async function request(url: string): Promise<RawResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: { accept: 'application/json' },
      credentials: 'same-origin',
      cache: 'no-store',
      signal: controller.signal,
    });
    const text = await response.text();
    let body: unknown = null;
    try {
      body = text.length > 0 ? JSON.parse(text) : null;
    } catch {
      body = null;
    }
    return {
      status: response.status,
      body,
      text,
      contentType: response.headers.get('content-type') ?? '',
    };
  } catch (error) {
    const aborted = error instanceof Error && error.name === 'AbortError';
    throw new ApiError(
      aborted ? 'E_TIMEOUT' : 'E_NETWORK',
      aborted ? `请求超时（${REQUEST_TIMEOUT_MS}ms）` : '无法连接宿主（网络错误或服务未启动）',
      0,
    );
  } finally {
    clearTimeout(timer);
  }
}

function isEnvelope(value: unknown): value is ApiEnvelope<unknown> {
  return typeof value === 'object' && value !== null && 'ok' in value;
}

/** 把一个已完成的 HTTP 响应解释为 data 或抛 ApiError（不展示 stack） */
function unwrap<T>(response: RawResponse): T {
  const { status, body } = response;
  if (isEnvelope(body)) {
    if (body.ok === true) return body.data as T;
    const code = body.error?.code ?? `E_HTTP_${status}`;
    const message = body.error?.message ?? `HTTP ${status}`;
    throw new ApiError(code, message, status);
  }
  if (status >= 200 && status < 300) {
    // 非包络但 2xx：宽松接受（例如宿主直接返回 JSON 对象）
    return body as T;
  }
  let hint = '';
  if (status === 401 || status === 403) hint = '未认证或无权访问该接口（检查 DSH web 登录态）';
  else if (status === 404) hint = '接口未挂载（宿主 http.enabled 关闭或路由未注册）';
  else if (status === 405) hint = '只读接口仅支持 GET';
  throw new ApiError(`E_HTTP_${status}`, hint || `HTTP ${status}`, status);
}

/** 探测可用 base；成功会缓存 */
export function resolveApiBase(force = false): Promise<string> {
  if (resolvedBase !== null && !force) return Promise.resolve(resolvedBase);
  if (resolvePromise !== null) return resolvePromise;
  lastAttempts = [];
  const attempt = (async (): Promise<string> => {
    for (const base of CANDIDATE_BASES) {
      const url = `${base}/health`;
      lastAttempts.push(url);
      try {
        const response = await request(url);
        // 健康接口返回 200 + {ok:true,data:{...}}；其他情况视为不可用继续探测
        const data = unwrap<HealthData>(response);
        if (typeof data === 'object' && data !== null) {
          resolvedBase = base;
          lastResolvedAt = Date.now();
          return base;
        }
      } catch {
        // 该候选不可用（404/401/超时/网络错误）：继续下一个候选
      }
    }
    throw new ApiUnavailableError(
      '只读 HTTP API 不可用：宿主插件 HTTP 接口未启用、未挂载或未认证',
      [...lastAttempts],
    );
  })();
  resolvePromise = attempt;
  // 成功则长期缓存；失败/完成后允许后续重试重新探测（并发调用共享同一个探测 promise）
  attempt.then(
    () => {
      if (resolvePromise === attempt) resolvePromise = null;
    },
    () => {
      if (resolvePromise === attempt) resolvePromise = null;
    },
  );
  return attempt;
}

function withQuery(path: string, query?: Record<string, string | number | boolean | null | undefined>): string {
  if (!query) return path;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === '') continue;
    params.set(key, String(value));
  }
  const suffix = params.toString();
  return suffix.length > 0 ? `${path}?${suffix}` : path;
}

/** 带 base 解析的 GET：resolve base -> request -> unwrap */
export async function apiGet<T>(
  path: string,
  query?: Record<string, string | number | boolean | null | undefined>,
): Promise<T> {
  const base = await resolveApiBase();
  const url = withQuery(`${base}${path}`, query);
  const response = await request(url);
  return unwrap<T>(response);
}

/**
 * 写操作（v5）：同源 POST + JSON body。
 * - 仅用于 Host 明确提供的写路由（人格 CRUD / 激活 / 会话配置）；
 * - 与 GET 共用 base 探测、超时、包络解析与错误归一（不展示 stack）；
 * - `content-type: application/json`，`credentials: same-origin`（浏览器 cookie 自动携带）。
 */
async function postRequest(url: string, payload: unknown): Promise<RawResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      credentials: 'same-origin',
      cache: 'no-store',
      body: JSON.stringify(payload ?? {}),
      signal: controller.signal,
    });
    const text = await response.text();
    let body: unknown = null;
    try {
      body = text.length > 0 ? JSON.parse(text) : null;
    } catch {
      body = null;
    }
    return {
      status: response.status,
      body,
      text,
      contentType: response.headers.get('content-type') ?? '',
    };
  } catch (error) {
    const aborted = error instanceof Error && error.name === 'AbortError';
    throw new ApiError(
      aborted ? 'E_TIMEOUT' : 'E_NETWORK',
      aborted ? `请求超时（${REQUEST_TIMEOUT_MS}ms）` : '无法连接宿主（网络错误或服务未启动）',
      0,
    );
  } finally {
    clearTimeout(timer);
  }
}

/** 带 base 解析的 POST（写操作；仅用于 v5 写路由） */
export async function apiPost<T>(path: string, body: unknown): Promise<T> {
  const base = await resolveApiBase();
  const response = await postRequest(`${base}${path}`, body);
  return unwrap<T>(response);
}

/** POST 是否代表"Host 写接口尚未就绪"（用于 UI 优雅提示而非崩溃） */
export function isHostWritePending(error: unknown): boolean {
  if (!(error instanceof ApiError)) return false;
  // 人格业务错误（缺失/无效）不是“Host 写接口未就绪”，应展示真实错误
  if (error.code.startsWith('E_PERSONA')) return false;
  if (error.code === 'E_NOT_FOUND' || error.code === 'E_UNAVAILABLE') return true;
  return error.status === 404 || error.status === 405;
}

// ---------------------------------------------------------------------------
// 16 个 GET 端点（只读）+ 5 个 POST 端点（v5 写操作）
//
// GET 新增 v5 可选作用域参数：`vault=shared|<personaId>`、`sessionId=<id>`
// （默认由 Host 按当前会话配置解析；不传则使用全局默认/当前激活人格）。
// POST 仅覆盖：/personas、/personas/update、/personas/delete、/personas/activate、
// /session-config —— 其余接口仍 GET-only。
// ---------------------------------------------------------------------------

/** GET 可选作用域参数（v5） */
export interface ScopeQuery {
  /** 记忆库：'shared' 或人格 id（缺省 = 当前会话配置/全局默认） */
  vault?: string;
  /** 会话 id（缺省 = 当前会话） */
  sessionId?: string;
}

export const api = {
  health: (): Promise<HealthData> => apiGet<HealthData>('/health'),

  status: (verbose = false, scope?: ScopeQuery): Promise<StatusData> =>
    apiGet<StatusData>('/status', { ...(verbose ? { verbose: true } : {}), ...(scope ?? {}) }),

  layers: (scope?: ScopeQuery): Promise<LayersData> => apiGet<LayersData>('/layers', scope),

  layerStats: (scope?: ScopeQuery): Promise<LayerStatsData> => apiGet<LayerStatsData>('/stats-layers', scope),

  /** 记忆分层（短期/中期/长期）：三层统计 + 内容层计数 + 最近 tick（只读） */
  retention: (scope?: ScopeQuery): Promise<RetentionData> => apiGet<RetentionData>('/retention', scope),

  /**
   * 人格（v4/v5）：第 14 条 GET 路由。
   * 返回 activeId + 人格定义摘要（含每人记忆数）+ memoryCounts + sharedCount。
   */
  personas: (scope?: ScopeQuery): Promise<PersonaData> => apiGet<PersonaData>('/personas', scope),

  /** 记忆库总览（v5，GET /vaults）：共享库 + 每个人格库（stats/当前库高亮） */
  vaults: (): Promise<VaultsData> => apiGet<VaultsData>('/vaults'),

  /** 会话级记忆配置（v5，GET /session-config?sessionId=；未保存过时 isDefault=true） */
  sessionConfig: (sessionId?: string): Promise<SessionConfig> =>
    apiGet<SessionConfig>('/session-config', sessionId ? { sessionId } : undefined),

  /**
   * 新会话默认（v5.1，GET /session-config **不带 sessionId**）：
   * 返回"下一个新会话"的默认记忆/人格设置；Host 侧以 `defaults:true` + `sessionId:null` 标记。
   * 与 {@link sessionConfig} 复用同一条 GET 路由（不新增路由）。
   */
  sessionDefaults: (): Promise<SessionDefaults> => apiGet<SessionDefaults>('/session-config'),

  raw: (query: {
    day?: string;
    from?: number;
    to?: number;
    sessionId?: string;
    workspace?: string;
    kind?: string;
    /** 人格过滤（v4）；不传 = 不过滤 */
    persona?: string;
    /** 记忆库作用域（v5） */
    vault?: string;
    desc?: boolean;
    limit?: number;
    cursor?: string;
  }): Promise<RawListData> => apiGet<RawListData>('/raw', { ...query, desc: query.desc ?? true }),

  rawDetail: (id: string, scope?: ScopeQuery): Promise<RawDetailData> =>
    apiGet<RawDetailData>('/raw-detail', { id, ...(scope ?? {}) }),

  rawVerify: (id: string, scope?: ScopeQuery): Promise<RawVerifyData> =>
    apiGet<RawVerifyData>('/raw-verify', { id, ...(scope ?? {}) }),

  memories: (query: {
    layer?: string;
    kind?: string;
    status?: string;
    q?: string;
    workspace?: string;
    sessionId?: string;
    /** 记忆分层过滤：short | mid | long */
    retention?: string;
    /** 人格过滤（v4）；不传 = 不过滤；'all' = 跨人格 */
    persona?: string;
    /** 记忆库作用域（v5） */
    vault?: string;
    onlyValid?: boolean;
    limit?: number;
    cursor?: string;
  }): Promise<MemoryListData> => apiGet<MemoryListData>('/memories', { ...query }),

  memoryDetail: (id: string, scope?: ScopeQuery): Promise<MemoryDetailData> =>
    apiGet<MemoryDetailData>('/memory-detail', { id, ...(scope ?? {}) }),

  /**
   * 检索（v3/v4，docs/24 §25）：
   * - mode='explicit'（默认）：显式检索 → L0 原始层 + 原始层向量索引，返回原文（永不遗忘）；
   * - mode='implicit'：隐式上下文 → 三层记忆（可遗忘）。
   * 人格：默认服务端按当前激活人格 + 共享过滤；`persona='all'`/`allPersonas=true` 跨人格，
   * `persona=<id>` 指定人格。v5 支持 `vault`/`sessionId` 作用域。
   */
  search: (query: {
    q: string;
    /** 检索模式：explicit（默认，原始层）| implicit（三层记忆） */
    mode?: 'explicit' | 'implicit';
    layers?: string;
    /** 人格过滤（v4）：<id> | 'all' */
    persona?: string;
    /** 跨人格检索（v4） */
    allPersonas?: boolean;
    /** 记忆库作用域（v5） */
    vault?: string;
    sessionId?: string;
    limit?: number;
    budgetTokens?: number;
    minScore?: number;
  }): Promise<SearchData> => apiGet<SearchData>('/search', { ...query }),

  manifest: (scope?: ScopeQuery): Promise<ManifestData> => apiGet<ManifestData>('/manifest', scope),

  integrity: (scope?: ScopeQuery): Promise<IntegrityData> => apiGet<IntegrityData>('/integrity', scope),

  // ── 写操作（v5，POST；仅以下 5 个路径）─────────────────────────────────

  /** 创建人格（写 persona.dir/<id>.md） */
  personaCreate: (input: PersonaCreateInput): Promise<PersonaCreateData> => apiPost<PersonaCreateData>('/personas', input),

  /** 编辑人格（部分字段更新） */
  personaUpdate: (input: PersonaUpdateInput): Promise<PersonaUpdateData> =>
    apiPost<PersonaUpdateData>('/personas/update', input),

  /** 删除人格（文件移入 personas/.trash/；非物理删除历史） */
  personaDelete: (input: PersonaDeleteInput): Promise<PersonaDeleteData> =>
    apiPost<PersonaDeleteData>('/personas/delete', input),

  /** 切换全局激活人格（= 切换独立记忆库；persona=null 取消人格/用共享库） */
  personaActivate: (input: PersonaActivateInput): Promise<PersonaActivateData> =>
    apiPost<PersonaActivateData>('/personas/activate', input),

  /** 保存会话级记忆开关/人格设置 */
  saveSessionConfig: (input: SessionConfigInput): Promise<SessionConfig> =>
    apiPost<SessionConfig>('/session-config', input),

  /**
   * 保存"新会话默认值"（v5.1，POST /session-config **不带 sessionId**）：
   * body = `{defaults:true, memory?, persona?, personaId?}`。
   * 与 {@link saveSessionConfig} 复用同一条 POST 路由（不新增路由）。
   */
  saveSessionDefaults: (input: Omit<SessionDefaultsInput, 'defaults'> = {}): Promise<SessionDefaults> =>
    apiPost<SessionDefaults>('/session-config', {
      memory: input.memory,
      persona: input.persona,
      personaId: input.personaId,
      backfillOnEnable: input.backfillOnEnable,
      fullCapture: input.fullCapture,
      defaults: true,
    }),

  // ── v6：导入导出 + 原始数据库重构（POST 写路由，导入只追加、绝不删改已有记忆）──

  /** 会话/整库 导入导出（导出只读；导入只追加） */
  transfer: (input: TransferInput): Promise<TransferResult> => apiPost<TransferResult>('/transfer', input),

  /** 从 L0 原始归档重构原始数据库（raw_index 对账/补齐；只增不删） */
  rebuildRaw: (input: { sessionId?: string | null; vault?: string | null } = {}): Promise<RebuildResult> =>
    apiPost<RebuildResult>('/rebuild', input),
};

// ---------------------------------------------------------------------------
// React 数据 hook（此处只用 React 的 useCallback/useEffect/useState/useRef）
// ---------------------------------------------------------------------------
import { useCallback, useEffect, useRef, useState } from 'react';

export interface AsyncState<T> {
  phase: 'loading' | 'ready' | 'error';
  data: T | null;
  error: ApiError | null;
  /** 最近一次成功刷新的时间（ms） */
  updatedAt: number | null;
}

export interface AsyncResult<T> extends AsyncState<T> {
  reload: () => void;
}

/**
 * 通用只读加载 hook：组件卸载后不再 setState；错误统一为 ApiError。
 * `deps` 变化会重新加载（用于筛选/分页参数）。
 */
export function useApi<T>(loader: () => Promise<T>, deps: readonly unknown[]): AsyncResult<T> {
  const [state, setState] = useState<AsyncState<T>>({ phase: 'loading', data: null, error: null, updatedAt: null });
  const mounted = useRef(true);
  const seq = useRef(0);
  const loaderRef = useRef(loader);
  loaderRef.current = loader;

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const run = useCallback(() => {
    const ticket = ++seq.current;
    setState((prev) => ({ phase: 'loading', data: prev.data, error: null, updatedAt: prev.updatedAt }));
    loaderRef.current().then(
      (data) => {
        if (!mounted.current || ticket !== seq.current) return;
        setState({ phase: 'ready', data, error: null, updatedAt: Date.now() });
      },
      (error: unknown) => {
        if (!mounted.current || ticket !== seq.current) return;
        const apiError =
          error instanceof ApiError
            ? error
            : new ApiError('E_INTERNAL', error instanceof Error ? error.message : String(error));
        setState({ phase: 'error', data: null, error: apiError, updatedAt: null });
      },
    );
  }, []);

  // eslint-disable-next-line react-hooks/exhaustive-deps -- deps 由调用方显式给出
  useEffect(run, deps);

  return { ...state, reload: run };
}

/** 主动触发的一次性动作（详情、校验等）：带 loading/error，不自动执行 */
export interface ActionState<T> {
  pending: boolean;
  data: T | null;
  error: ApiError | null;
}

export function useApiAction<T>(): {
  state: ActionState<T>;
  run: (loader: () => Promise<T>) => Promise<T | null>;
  reset: () => void;
} {
  const [state, setState] = useState<ActionState<T>>({ pending: false, data: null, error: null });
  const mounted = useRef(true);
  const seq = useRef(0);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const run = useCallback(async (loader: () => Promise<T>): Promise<T | null> => {
    const ticket = ++seq.current;
    setState({ pending: true, data: null, error: null });
    try {
      const data = await loader();
      if (mounted.current && ticket === seq.current) setState({ pending: false, data, error: null });
      return data;
    } catch (error) {
      const apiError =
        error instanceof ApiError
          ? error
          : new ApiError('E_INTERNAL', error instanceof Error ? error.message : String(error));
      if (mounted.current && ticket === seq.current) setState({ pending: false, data: null, error: apiError });
      return null;
    }
  }, []);

  const reset = useCallback(() => {
    seq.current += 1;
    setState({ pending: false, data: null, error: null });
  }, []);

  return { state, run, reset };
}

/** 把任意错误收敛成展示文案（绝不展示 stack） */
export function describeError(error: ApiError | null | undefined): { code: string; message: string; attempts?: string[] } {
  if (!error) return { code: 'E_UNKNOWN', message: '未知错误' };
  if (error instanceof ApiUnavailableError) {
    return { code: error.code, message: error.message, attempts: error.attempts };
  }
  return { code: error.code, message: error.message };
}

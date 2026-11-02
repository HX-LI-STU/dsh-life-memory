// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hanxustu (dsh-life-memory)
/**
 * 把记忆库 HTTP API 挂到 DSH 的跨载体 `connection.fetch` 路由上（Web + Desktop 通用）。
 *
 * ── 已核实的宿主 API 语义（从同版本 SDK 与 asar 实现核对）──
 *   interface ConnectionFetchRoute { path; methods: ('GET'|'HEAD'|'POST')[]; requestBody; fetch(request): Promise<Response> }
 *   connection.fetch.register(route): () => void
 * 限制：
 * 1. **精确匹配**（`fetchRoutes.get(url.pathname)`）：不支持前缀/通配/`:id` 路径参数；
 * 2. `path` 必须以 `/api/` 开头且每段匹配 `[A-Za-z0-9_$.-]+`，否则 `assertFetchRoute` 抛错；
 * 3. 只有 owner Peer 能命中（浏览器同源 fetch 自动带认证）。
 *
 * v5 路由方案（basePath 默认 `/api/life-memory`）：
 *   GET 16 条（只读路由表见 READ_ONLY_ROUTES）：health/status/layers/stats-layers/raw/raw-detail/raw-verify/
 *     memories/memory-detail/search/manifest/integrity/retention/personas + v5 `/vaults`、`/session-config`
 *   POST 7 条（写路由表见导出 `WRITE_ROUTES`）：/personas、/personas/update、/personas/delete、
 *     /personas/activate、/session-config
 * 注册策略：按**唯一 path** 合并 GET+POST（同一 path 只注册一次 route，methods:['GET','HEAD','POST']）；
 * POST-only 路径（personas/update|delete|activate）额外各注册一条。
 *
 * `registered` 只统计 GET 路由数（宿主/QA/E2E 的历史契约 = 16）；写路由数见 `writeRegistered`。
 */
import type { Logger } from '../core/contracts.ts';
import type { HttpApiResponse } from './handlers.ts';

/** API 的最小接口（ReadOnlyMemoryApi 满足） */
export interface ReadOnlyApiLike {
  handle(request: { method: string; url: string; body?: unknown }): Promise<HttpApiResponse>;
}

/** dsh-client-connection Host 半的最小子集 */
export interface ConnectionFetchRouteLike {
  path: string;
  methods: Array<'GET' | 'HEAD' | 'POST'>;
  requestBody: 'buffered' | 'streaming';
  fetch(request: Request): Promise<Response>;
}

export interface ConnectionLike {
  fetch?: {
    register(route: ConnectionFetchRouteLike): (() => void) | (() => Promise<void>);
  };
}

/** 一个端点定义（GET/POST 共用） */
export interface ReadOnlyRouteSpec {
  /** 稳定端点键（诊断/客户端对齐用） */
  key: string;
  /** 客户端可见的完整路径（= 注册给宿主的路径），例如 `/api/life-memory/health` */
  path: string;
  /** `http.basePath` 之后的后缀，例如 `/health` */
  suffix: string;
}

export interface RegisterHttpOptions {
  api: ReadOnlyApiLike;
  /** 客户端可见基址；默认 `/api/life-memory`，必须以 `/api/` 开头 */
  basePath: string;
  logger: Logger;
  /** 允许的 HTTP methods（DSH 只支持 GET/HEAD/POST；默认 ['GET','HEAD','POST']） */
  methods?: Array<'GET' | 'HEAD' | 'POST'>;
  /** 是否同时注册 5 条 POST 写路由（默认 true；兼容包装 registerReadOnlyHttp 传 false） */
  includeWrite?: boolean;
}

export interface HttpRegistration {
  dispose(): void;
  /** 实际注册成功的 **GET** 路由数（0 表示宿主不支持/未挂载；客户端/QA 的历史契约） */
  registered: number;
  /** 实际注册成功的 **POST** 路由数（5 = /personas CRUD + activate + session-config） */
  writeRegistered: number;
  /** 注册成功的 GET 路由表（客户端可据此拼 URL） */
  routes: ReadOnlyRouteSpec[];
  /** 注册成功的 POST 路由表 */
  writeRoutes: ReadOnlyRouteSpec[];
  /** 客户端调用基址（= basePath），例如 `/api/life-memory` */
  clientBasePath: string;
  /** 挂载失败原因（registered=0 时说明原因） */
  reason?: string;
}

export const DEFAULT_HTTP_BASE_PATH = '/api/life-memory';
const SEGMENT_RE = /^[A-Za-z0-9_$.-]+$/;

/** 16 条只读端点（与 src/http/handlers.ts 的 GET `#readRoute` 一一对应） */
export const READ_ONLY_ROUTES: readonly ReadOnlyRouteSpec[] = Object.freeze([
  { key: 'health', suffix: '/health' },
  { key: 'status', suffix: '/status' },
  { key: 'layers', suffix: '/layers' },
  { key: 'layerStats', suffix: '/stats-layers' },
  { key: 'rawList', suffix: '/raw' },
  { key: 'rawDetail', suffix: '/raw-detail' },
  { key: 'rawVerify', suffix: '/raw-verify' },
  { key: 'memoryList', suffix: '/memories' },
  { key: 'memoryDetail', suffix: '/memory-detail' },
  { key: 'search', suffix: '/search' },
  { key: 'manifest', suffix: '/manifest' },
  { key: 'integrity', suffix: '/integrity' },
  { key: 'retention', suffix: '/retention' },
  { key: 'personas', suffix: '/personas' },
  // v5：多库总览 + 会话级开关
  { key: 'vaults', suffix: '/vaults' },
  { key: 'sessionConfig', suffix: '/session-config' },
].map((route) => ({ ...route, path: '' })) as ReadOnlyRouteSpec[]);

/** 7 条写端点（与 src/http/handlers.ts 的 POST `#writeRoute` 一一对应） */
export const WRITE_ROUTES: readonly ReadOnlyRouteSpec[] = Object.freeze([
  { key: 'personaCreate', suffix: '/personas' },
  { key: 'personaUpdate', suffix: '/personas/update' },
  { key: 'personaDelete', suffix: '/personas/delete' },
  { key: 'personaActivate', suffix: '/personas/activate' },
  { key: 'sessionConfigSave', suffix: '/session-config' },
  // v6：导入导出（只追加）+ 原始数据库重构
  { key: 'transfer', suffix: '/transfer' },
  { key: 'rebuild', suffix: '/rebuild' },
].map((route) => ({ ...route, path: '' })) as ReadOnlyRouteSpec[]);

/** basePath 规范化（保证以 / 开头、无尾斜杠） */
export function normalizeBasePath(input: unknown): string {
  let path = typeof input === 'string' ? input.trim() : '';
  if (path.length === 0) return DEFAULT_HTTP_BASE_PATH;
  if (!path.startsWith('/')) path = `/${path}`;
  while (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1);
  return path;
}

/** basePath 是否可安全映射为宿主路由（以 /api/ 开头且每段字符合法） */
export function isMountableBasePath(basePath: string): boolean {
  const normalized = normalizeBasePath(basePath);
  if (!normalized.startsWith('/api/')) return false;
  const segments = normalized.slice(1).split('/');
  return segments.length > 0 && segments.every((segment) => segment.length > 0 && SEGMENT_RE.test(segment));
}

/** 计算完整 GET 路由表（含 path），供注册与客户端对齐使用 */
export function buildRouteTable(basePath: string): ReadOnlyRouteSpec[] {
  const normalized = normalizeBasePath(basePath);
  return READ_ONLY_ROUTES.map((route) => ({ ...route, path: `${normalized}${route.suffix}` }));
}

/** 计算完整 POST 路由表（含 path） */
export function buildWriteRouteTable(basePath: string): ReadOnlyRouteSpec[] {
  const normalized = normalizeBasePath(basePath);
  return WRITE_ROUTES.map((route) => ({ ...route, path: `${normalized}${route.suffix}` }));
}

/** 客户端可见基址（= 规范化后的 basePath） */
export function clientBasePathOf(basePath: string): string {
  return normalizeBasePath(basePath);
}

/** 把宿主 Request 映射为内部 API 的 `{method,url}`（直接透传 path+query） */
export function mapRequestToInternalUrl(
  request: Request,
  _basePath: string,
): { method: string; url: string } {
  const method = (request.method || 'GET').toUpperCase();
  let url: string;
  try {
    const parsed = new URL(request.url);
    url = `${parsed.pathname}${parsed.search}`;
  } catch {
    // 相对 URL（部分宿主实现）：原样使用
    const index = (request.url || '').indexOf('?');
    url = index >= 0 ? request.url : request.url || '/';
  }
  return { method, url };
}

function responseOf(result: HttpApiResponse, method: string): Response {
  const headers = {
    'cache-control': 'no-store',
    'content-type': 'application/json; charset=utf-8',
  };
  if (method === 'HEAD') return new Response(null, { status: result.status, headers });
  return Response.json(result.body, { status: result.status, headers });
}

function methodNotAllowed(method: string): Response {
  return Response.json(
    { ok: false, error: { code: 'E_METHOD_NOT_ALLOWED', message: `记忆库 HTTP 接口仅支持 GET/HEAD/POST（收到 ${method}）` } },
    { status: 405 },
  );
}

function badJson(): Response {
  return Response.json(
    { ok: false, error: { code: 'E_BAD_REQUEST', message: '请求体不是合法 JSON' } },
    { status: 400, headers: { 'cache-control': 'no-store' } },
  );
}

/**
 * 挂载完整 HTTP API（16 GET + 5 POST）到 DSH connection.fetch 路由。
 * @param connection `ctx.get('connection')`（缺失/无 fetch.register 时优雅降级）
 */
export function registerHttpRoutes(
  connection: ConnectionLike | undefined | null,
  options: RegisterHttpOptions,
): HttpRegistration {
  const { api, logger } = options;
  const basePath = normalizeBasePath(options.basePath);
  const clientBasePath = clientBasePathOf(basePath);
  const includeWrite = options.includeWrite !== false;
  const methods: Array<'GET' | 'HEAD' | 'POST'> =
    options.methods && options.methods.length > 0 ? [...new Set(options.methods)] : ['GET', 'HEAD', 'POST'];
  const disposers: Array<() => void> = [];
  const registeredPaths = new Set<string>();
  const readTable = buildRouteTable(basePath);
  const writeTable = includeWrite ? buildWriteRouteTable(basePath) : [];
  const disposeAll = (): void => {
    for (const dispose of disposers.reverse()) {
      try {
        dispose();
      } catch {
        /* 释放失败不影响其他路由 */
      }
    }
    disposers.length = 0;
  };
  // 唯一 path 合并：GET 表 + POST 表（同一 path 只注册一次）
  const merged = new Map<string, { path: string; methods: Array<'GET' | 'HEAD' | 'POST'> }>();
  for (const route of readTable) {
    const entry = merged.get(route.path) ?? { path: route.path, methods: [] };
    if (!entry.methods.includes('GET')) entry.methods.push('GET');
    if (!entry.methods.includes('HEAD')) entry.methods.push('HEAD');
    merged.set(route.path, entry);
  }
  for (const route of writeTable) {
    const entry = merged.get(route.path) ?? { path: route.path, methods: [] };
    if (!entry.methods.includes('POST')) entry.methods.push('POST');
    merged.set(route.path, entry);
  }

  const register = connection?.fetch?.register;
  if (typeof register !== 'function') {
    const reason = 'connection.fetch.register 不可用（服务缺失或无 Host 半）：HTTP API 未挂载';
    logger.warn(reason);
    return { dispose: disposeAll, registered: 0, writeRegistered: 0, routes: [], writeRoutes: [], clientBasePath, reason };
  }
  if (!isMountableBasePath(basePath)) {
    const reason = `http.basePath ${JSON.stringify(basePath)} 不是合法的宿主路由（必须以 /api/ 开头，段字符集 [A-Za-z0-9_$.-]）：HTTP API 未挂载`;
    logger.warn(reason);
    return { dispose: disposeAll, registered: 0, writeRegistered: 0, routes: [], writeRoutes: [], clientBasePath, reason };
  }

  const handler = async (request: Request): Promise<Response> => {
    const method = (request.method || 'GET').toUpperCase();
    try {
      if (!methods.includes(method as 'GET' | 'HEAD' | 'POST')) return methodNotAllowed(method);
      const mapped = mapRequestToInternalUrl(request, basePath);
      let body: unknown;
      if (method === 'POST') {
        const text = await request.text();
        if (text.trim().length === 0) {
          body = {};
        } else {
          try {
            body = JSON.parse(text);
          } catch {
            return badJson();
          }
        }
      }
      const result = await api.handle({ method, url: mapped.url, body });
      return responseOf(result, method);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn(`http api handler failed (${method} ${request.url}): ${message}`);
      return Response.json(
        { ok: false, error: { code: 'E_INTERNAL', message: 'internal error' } },
        { status: 500, headers: { 'cache-control': 'no-store' } },
      );
    }
  };

  for (const entry of merged.values()) {
    const registeredMethods = entry.methods.filter((method) => methods.includes(method));
    if (registeredMethods.length === 0) continue;
    try {
      const dispose = register.call(connection?.fetch, {
        path: entry.path,
        // v5：同一 path 合并 GET+POST（默认 methods:['GET','HEAD','POST']）
        methods: registeredMethods,
        requestBody: 'buffered',
        fetch: handler,
      });
      disposers.push(() => {
        try {
          void dispose?.();
        } catch {
          /* ignore */
        }
      });
      registeredPaths.add(entry.path);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn(`HTTP 路由注册失败 ${entry.path}: ${message}`);
    }
  }

  const routes = readTable.filter((route) => registeredPaths.has(route.path));
  const writeRoutes = writeTable.filter((route) => registeredPaths.has(route.path));
  if (routes.length === 0 && writeRoutes.length === 0) {
    const reason = 'connection.fetch.register 拒绝了全部路由（宿主可能已注册同名路径）';
    logger.warn(reason);
    return { dispose: disposeAll, registered: 0, writeRegistered: 0, routes, writeRoutes, clientBasePath, reason };
  }
  logger.info(
    `HTTP API 已注册 ${routes.length} 条 GET + ${writeRoutes.length} 条 POST（${merged.size} 条唯一 path；clientBasePath=${clientBasePath}）`,
  );
  return {
    dispose: disposeAll,
    registered: routes.length,
    writeRegistered: writeRoutes.length,
    routes,
    writeRoutes,
    clientBasePath,
  };
}

/**
 * 兼容包装（v4 及以前调用方）：只注册只读 GET/HEAD 路由。
 * v5 集成层应使用 `registerHttpRoutes`（含 5 条 POST 写路由）。
 */
export function registerReadOnlyHttp(
  connection: ConnectionLike | undefined | null,
  options: RegisterHttpOptions,
): HttpRegistration {
  return registerHttpRoutes(connection, {
    ...options,
    includeWrite: false,
    methods: options.methods && options.methods.length > 0 ? options.methods : ['GET', 'HEAD'],
  });
}

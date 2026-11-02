// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hanxustu (dsh-life-memory)
/**
 * 配置：默认值、合并、校验、路径解析。
 *
 * 本文件不依赖 DSH API（Host 集成层只负责把 cordis/schemastery 配置转成
 * Partial<MemoryVaultConfig> 再调用 resolveConfig）。这样配置逻辑可以脱离宿主单测。
 */
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import type {
  CaptureConfig,
  ConsolidationConfig,
  EmbeddingConfig,
  ForgettingConfig,
  HttpConfig,
  LayersConfig,
  MemoryVaultConfig,
  PersonaConfig,
  RawVectorConfig,
  RecallConfig,
  RetentionConfig,
  SafetyConfig,
  UiConfig,
} from './core/contracts.ts';

export const DEFAULT_CAPTURE: CaptureConfig = {
  userMessages: true,
  assistantMessages: true,
  toolCalls: true,
  toolResults: true,
  excludeWorkspaces: [],
  maxBatchSize: 64,
  flushIntervalMs: 250,
};

export const DEFAULT_EMBEDDING: EmbeddingConfig = {
  provider: 'local',
  dim: 512,
  model: 'dsh-local-hash-v1',
  timeoutMs: 20_000,
  batchSize: 32,
};

export const DEFAULT_LAYERS: LayersConfig = {
  enabled: ['L1', 'L2', 'L3'],
  autoConsolidate: true,
  consolidationIntervalMs: 10 * 60_000,
  maxBatchRaws: 500,
};

export const DEFAULT_RECALL: RecallConfig = {
  enabled: true,
  injectSystemPrompt: true,
  promptBudgetTokens: 800,
  toolDefaultLimit: 8,
  hybrid: {
    vectorWeight: 0.55,
    lexicalWeight: 0.25,
    recencyWeight: 0.12,
    importanceWeight: 0.08,
    halfLifeDays: 30,
  },
  layerPrior: { L1: 0.9, L2: 0.98, L3: 1.0, raw: 1.0 },
  maxCandidates: 200,
  dedupSimilarity: 0.97,
  mmr: { enabled: true, lambda: 0.7 },
  vectorCacheMaxItems: 50_000,
  autoRecall: false,
  retentionPrior: { short: 0.95, mid: 1.0, long: 1.0 },
};

/**
 * 记忆分层模型默认值（短期 / 中期 / 长期）。
 * 晋升阶梯单调不降：short→mid→long；由年龄、重要度、复述数、钉住/种类驱动。
 */
export const DEFAULT_RETENTION: RetentionConfig = {
  enabled: true,
  shortTermDays: 7,
  promoteMidMinImportance: 0.45,
  promoteMidMinAccess: 1,
  longTermAfterDays: 90,
  longTermMinImportance: 0.6,
  longTermMinRecurrence: 2,
  longTermMinScore: 0.75,
  tickIntervalMs: 10 * 60_000,
  autoLongTermKinds: ['profile'],
  pinnedIsLongTerm: true,
  weights: { recency: 0.35, importance: 0.3, recurrence: 0.2, frequency: 0.15 },
};

/** 原始层向量索引（永久向量模型）：只追加、不可删除、可从 L0 重建 */
export const DEFAULT_VECTORS: RawVectorConfig = {
  enabled: true,
  rawTextMaxChars: 2000,
  backfillBatchSize: 64,
  backfillIntervalMs: 5_000,
};

/** 三层记忆遗忘（短期删除 / 中期归档 / 长期永久；L0 不遗忘） */
export const DEFAULT_FORGETTING: ForgettingConfig = {
  enabled: true,
  checkIntervalMs: 30 * 60_000,
  batchSize: 200,
  protectPinned: true,
  protectImportance: 0.9,
};

/**
 * 人格（persona）：markdown 定义 + 激活 + 记忆作用域。
 * 参考 dsh-agents-md：每个 `*.md` 一个人格（frontmatter description/model/provider，正文=system prompt），
 * 目录热重载；本插件在此基础上把人格与记忆绑定（派生记忆 personaId、按人格注入画像/工作记忆）。
 */
export const DEFAULT_PERSONA: PersonaConfig = {
  enabled: true,
  dir: '',
  watch: true,
  archiveDefinitions: true,
  maxBodyChars: 20_000,
  injectSystemPrompt: true,
};

export const DEFAULT_HTTP: HttpConfig = { enabled: true, basePath: '/api/life-memory' };
export const DEFAULT_UI: UiConfig = { enabled: true };
export const DEFAULT_SAFETY: SafetyConfig = { redactSecretsInDerived: true, allowNetwork: false };
export const DEFAULT_CONSOLIDATION: ConsolidationConfig = { enabled: false, maxItemsPerRun: 20, timeoutMs: 30_000 };

export const DEFAULT_CONFIG: MemoryVaultConfig = {
  enabled: true,
  scope: 'global',
  dataDir: '',
  timezone: '',
  capture: DEFAULT_CAPTURE,
  embedding: DEFAULT_EMBEDDING,
  layers: DEFAULT_LAYERS,
  recall: DEFAULT_RECALL,
  retention: DEFAULT_RETENTION,
  vectors: DEFAULT_VECTORS,
  forgetting: DEFAULT_FORGETTING,
  persona: DEFAULT_PERSONA,
  http: DEFAULT_HTTP,
  ui: DEFAULT_UI,
  safety: DEFAULT_SAFETY,
  consolidation: DEFAULT_CONSOLIDATION,
};

/** 宿主机信息，用于路径/时区解析（由集成层提供） */
export interface HostEnv {
  /** DSH home（例如 <DSH_HOME>） */
  dshHome: string;
  /** 当前会话工作区根（scope=workspace 时用） */
  workspace?: string | null;
  /** 宿主本地时区（IANA；默认 Intl.DateTimeFormat().resolvedOptions().timeZone） */
  timezone?: string;
  /** 环境变量访问器（测试可注入） */
  env?: Record<string, string | undefined>;
}

type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends object ? (T[K] extends unknown[] ? T[K] : DeepPartial<T[K]>) : T[K];
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function merge<T>(base: T, override: unknown): T {
  if (override === undefined || override === null) return base;
  if (Array.isArray(base)) {
    return (Array.isArray(override) ? [...override] : base) as T;
  }
  if (isPlainObject(base)) {
    const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
    if (isPlainObject(override)) {
      for (const [k, v] of Object.entries(override)) {
        if (v === undefined) continue;
        out[k] = merge((base as Record<string, unknown>)[k], v);
      }
    }
    return out as T;
  }
  return (override === undefined ? base : override) as T;
}

function clamp01(value: number | undefined, fallback: number): number {
  if (typeof value !== 'number' || Number.isNaN(value)) return fallback;
  return Math.min(1, Math.max(0, value));
}

function positiveInt(value: number | undefined, fallback: number, max = 1_000_000): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return fallback;
  return Math.min(max, Math.floor(value));
}

/** 深合并用户配置与默认值（数组整体替换） */
export function mergeConfig(partial: DeepPartial<MemoryVaultConfig> | Record<string, unknown> | undefined): MemoryVaultConfig {
  return merge(DEFAULT_CONFIG, partial ?? {});
}

/**
 * 解析最终配置：合并默认值、校验数值、解析数据目录。
 * - scope=global  -> <dshHome>/life-memory（默认，跨会话/跨项目）
 * - scope=workspace -> <workspace>/.dsh-life-memory
 * - dataDir 非空且为相对路径 -> 相对 dshHome 解析
 */
export function resolveConfig(partial: unknown, host: HostEnv): MemoryVaultConfig {
  const merged = mergeConfig((partial ?? {}) as Record<string, unknown>);
  const env = host.env ?? process.env;

  const timezone = merged.timezone || host.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  if (!isValidTimeZone(timezone)) {
    throw new Error(`[dsh-life-memory] invalid timezone: ${timezone}`);
  }

  const dim = positiveInt(merged.embedding.dim, DEFAULT_EMBEDDING.dim, 8192);
  const embedding = {
    ...merged.embedding,
    dim,
    model: merged.embedding.model || (merged.embedding.provider === 'local' ? 'dsh-local-hash-v1' : 'remote-embedding'),
    timeoutMs: positiveInt(merged.embedding.timeoutMs, DEFAULT_EMBEDDING.timeoutMs, 600_000),
    batchSize: positiveInt(merged.embedding.batchSize, DEFAULT_EMBEDDING.batchSize, 512),
  };
  if (embedding.provider === 'openai-compatible' && !embedding.baseURL) {
    throw new Error('[dsh-life-memory] embedding.provider=openai-compatible requires embedding.baseURL');
  }

  const safety = {
    redactSecretsInDerived: merged.safety?.redactSecretsInDerived !== false,
    allowNetwork: merged.safety?.allowNetwork === true,
  };
  if (embedding.provider === 'openai-compatible' && !safety.allowNetwork) {
    throw new Error(
      '[dsh-life-memory] embedding.provider=openai-compatible requires safety.allowNetwork=true（默认离线，开启联网需显式授权）',
    );
  }
  if (embedding.apiKeyEnv && !env[embedding.apiKeyEnv] && embedding.provider === 'openai-compatible') {
    // 不直接抛错：允许宿主注入鉴权（例如本地 Ollama 无需 key）。但记录在日志由集成层处理。
  }

  const layerPriorInput = isPlainObject(merged.recall?.layerPrior) ? merged.recall.layerPrior : {};
  const layerPrior: Record<string, number> = { ...DEFAULT_RECALL.layerPrior };
  for (const [key, value] of Object.entries(layerPriorInput)) {
    const num = Number(value);
    if (Number.isFinite(num)) layerPrior[key] = Math.min(1, Math.max(0, num));
  }

  const recall = {
    ...merged.recall,
    promptBudgetTokens: positiveInt(merged.recall.promptBudgetTokens, DEFAULT_RECALL.promptBudgetTokens, 200_000),
    toolDefaultLimit: positiveInt(merged.recall.toolDefaultLimit, DEFAULT_RECALL.toolDefaultLimit, 100),
    autoRecall: merged.recall?.autoRecall === true,
    maxCandidates: positiveInt(merged.recall?.maxCandidates, DEFAULT_RECALL.maxCandidates, 5000),
    dedupSimilarity: clamp01(merged.recall?.dedupSimilarity, DEFAULT_RECALL.dedupSimilarity),
    vectorCacheMaxItems: positiveInt(merged.recall?.vectorCacheMaxItems, DEFAULT_RECALL.vectorCacheMaxItems, 1_000_000),
    layerPrior,
    mmr: {
      enabled: merged.recall?.mmr?.enabled !== false,
      lambda: clamp01(merged.recall?.mmr?.lambda, DEFAULT_RECALL.mmr.lambda),
    },
    hybrid: {
      vectorWeight: clamp01(merged.recall.hybrid?.vectorWeight, DEFAULT_RECALL.hybrid.vectorWeight),
      lexicalWeight: clamp01(merged.recall.hybrid?.lexicalWeight, DEFAULT_RECALL.hybrid.lexicalWeight),
      recencyWeight: clamp01(merged.recall.hybrid?.recencyWeight, DEFAULT_RECALL.hybrid.recencyWeight),
      importanceWeight: clamp01(merged.recall.hybrid?.importanceWeight, DEFAULT_RECALL.hybrid.importanceWeight),
      halfLifeDays: Math.max(0.1, merged.recall.hybrid?.halfLifeDays || DEFAULT_RECALL.hybrid.halfLifeDays),
    },
  };
  const weightSum =
    recall.hybrid.vectorWeight + recall.hybrid.lexicalWeight + recall.hybrid.recencyWeight + recall.hybrid.importanceWeight;
  if (weightSum <= 0) throw new Error('[dsh-life-memory] recall.hybrid weights sum must be > 0');

  const capture = {
    ...merged.capture,
    excludeWorkspaces: Array.isArray(merged.capture.excludeWorkspaces)
      ? merged.capture.excludeWorkspaces.filter((x) => typeof x === 'string' && x.length > 0)
      : [],
    maxBatchSize: positiveInt(merged.capture.maxBatchSize, DEFAULT_CAPTURE.maxBatchSize, 4096),
    flushIntervalMs: positiveInt(merged.capture.flushIntervalMs, DEFAULT_CAPTURE.flushIntervalMs, 60_000),
  };

  const layers = {
    ...merged.layers,
    enabled: Array.isArray(merged.layers.enabled)
      ? merged.layers.enabled.filter((x) => typeof x === 'string' && x.length > 0)
      : [...DEFAULT_LAYERS.enabled],
    consolidationIntervalMs: positiveInt(
      merged.layers.consolidationIntervalMs,
      DEFAULT_LAYERS.consolidationIntervalMs,
      24 * 3600_000,
    ),
    maxBatchRaws: positiveInt(merged.layers.maxBatchRaws, DEFAULT_LAYERS.maxBatchRaws, 100_000),
  };

  const http = {
    ...merged.http,
    basePath: normalizeBasePath(merged.http.basePath || DEFAULT_HTTP.basePath),
  };
  // DSH connection.fetch 路由只接受 /api/ 之下的精确路径（client-ui-dev 实测 assertFetchRoute）
  if (!http.basePath.startsWith('/api/')) {
    throw new Error(`[dsh-life-memory] http.basePath 必须以 /api/ 开头（当前：${http.basePath}）`);
  }

  const consolidation = {
    enabled: merged.consolidation?.enabled === true,
    maxItemsPerRun: positiveInt(merged.consolidation?.maxItemsPerRun, DEFAULT_CONSOLIDATION.maxItemsPerRun, 1000),
    timeoutMs: positiveInt(merged.consolidation?.timeoutMs, DEFAULT_CONSOLIDATION.timeoutMs, 600_000),
  };
  if (consolidation.enabled && !safety.allowNetwork) {
    throw new Error('[dsh-life-memory] consolidation.enabled=true 需要 safety.allowNetwork=true（LLM 整理会联网）');
  }

  const retention = {
    ...merged.retention,
    enabled: merged.retention?.enabled !== false,
    shortTermDays: Math.max(0, merged.retention?.shortTermDays ?? DEFAULT_RETENTION.shortTermDays),
    longTermAfterDays: Math.max(0.1, merged.retention?.longTermAfterDays || DEFAULT_RETENTION.longTermAfterDays),
    longTermMinImportance: clamp01(merged.retention?.longTermMinImportance, DEFAULT_RETENTION.longTermMinImportance),
    longTermMinRecurrence: positiveInt(
      merged.retention?.longTermMinRecurrence,
      DEFAULT_RETENTION.longTermMinRecurrence,
      1000,
    ),
    longTermMinScore: clamp01(merged.retention?.longTermMinScore, DEFAULT_RETENTION.longTermMinScore),
    tickIntervalMs: positiveInt(merged.retention?.tickIntervalMs, DEFAULT_RETENTION.tickIntervalMs, 24 * 3600_000),
    autoLongTermKinds: Array.isArray(merged.retention?.autoLongTermKinds)
      ? merged.retention.autoLongTermKinds.filter((kind) => typeof kind === 'string' && kind.length > 0)
      : [...DEFAULT_RETENTION.autoLongTermKinds],
    pinnedIsLongTerm: merged.retention?.pinnedIsLongTerm !== false,
    weights: {
      recency: clamp01(merged.retention?.weights?.recency, DEFAULT_RETENTION.weights.recency),
      importance: clamp01(merged.retention?.weights?.importance, DEFAULT_RETENTION.weights.importance),
      recurrence: clamp01(merged.retention?.weights?.recurrence, DEFAULT_RETENTION.weights.recurrence),
      frequency: clamp01(merged.retention?.weights?.frequency, DEFAULT_RETENTION.weights.frequency),
    },
  };
  // 晋升阶梯必须有序：短期窗口 < 长期年龄阈值
  if (!(retention.shortTermDays < retention.longTermAfterDays)) {
    throw new Error(
      `[dsh-life-memory] retention 要求 shortTermDays(${retention.shortTermDays}) < longTermAfterDays(${retention.longTermAfterDays})`,
    );
  }
  const weightSumRetention =
    retention.weights.recency + retention.weights.importance + retention.weights.recurrence + retention.weights.frequency;
  if (weightSumRetention <= 0) throw new Error('[dsh-life-memory] retention.weights 之和必须 > 0');

  const retentionPrior = {
    short: clamp01(merged.recall?.retentionPrior?.short, DEFAULT_RECALL.retentionPrior.short),
    mid: clamp01(merged.recall?.retentionPrior?.mid, DEFAULT_RECALL.retentionPrior.mid),
    long: clamp01(merged.recall?.retentionPrior?.long, DEFAULT_RECALL.retentionPrior.long),
  };

  const vectors = {
    ...merged.vectors,
    enabled: merged.vectors?.enabled !== false,
    rawTextMaxChars: positiveInt(merged.vectors?.rawTextMaxChars, DEFAULT_VECTORS.rawTextMaxChars, 100_000),
    backfillBatchSize: positiveInt(merged.vectors?.backfillBatchSize, DEFAULT_VECTORS.backfillBatchSize, 2048),
    backfillIntervalMs: positiveInt(
      merged.vectors?.backfillIntervalMs,
      DEFAULT_VECTORS.backfillIntervalMs,
      3600_000,
    ),
  };

  const forgetting = {
    ...merged.forgetting,
    enabled: merged.forgetting?.enabled !== false,
    checkIntervalMs: positiveInt(merged.forgetting?.checkIntervalMs, DEFAULT_FORGETTING.checkIntervalMs, 24 * 3600_000),
    batchSize: positiveInt(merged.forgetting?.batchSize, DEFAULT_FORGETTING.batchSize, 10_000),
    protectPinned: merged.forgetting?.protectPinned !== false,
    protectImportance: clamp01(merged.forgetting?.protectImportance, DEFAULT_FORGETTING.protectImportance),
  };

  const persona = {
    ...merged.persona,
    enabled: merged.persona?.enabled !== false,
    dir: resolvePersonaDir(merged.persona?.dir, host, env),
    watch: merged.persona?.watch !== false,
    archiveDefinitions: merged.persona?.archiveDefinitions !== false,
    maxBodyChars: positiveInt(merged.persona?.maxBodyChars, DEFAULT_PERSONA.maxBodyChars, 200_000),
    injectSystemPrompt: merged.persona?.injectSystemPrompt !== false,
  };

  const scope = merged.scope === 'workspace' ? 'workspace' : 'global';
  const dataDir = resolveDataDir(merged.dataDir, scope, host, env);

  return {
    ...merged,
    scope,
    dataDir,
    timezone,
    embedding,
    recall: { ...recall, retentionPrior },
    capture,
    layers,
    retention,
    vectors,
    forgetting,
    persona,
    http,
    ui: { ...merged.ui, enabled: merged.ui?.enabled !== false },
    safety,
    consolidation,
  };
}

function normalizeBasePath(input: string): string {
  let path = input.trim();
  if (!path.startsWith('/')) path = `/${path}`;
  if (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1);
  return path;
}

function resolvePersonaDir(dir: string | undefined, host: HostEnv, env: Record<string, string | undefined>): string {
  const trim = typeof dir === 'string' ? dir.trim() : '';
  if (trim.length > 0) {
    const expanded = trim === '~' ? homedir() : trim.startsWith('~/') || trim.startsWith('~\\') ? join(homedir(), trim.slice(2)) : trim;
    return isAbsolute(expanded) ? resolve(expanded) : resolve(host.dshHome, expanded);
  }
  const home = host.dshHome && host.dshHome.trim().length > 0 ? host.dshHome : env.DSH_HOME || join(homedir(), '.dsh');
  return join(resolve(home), 'personas');
}

function resolveDataDir(dataDir: string, scope: 'global' | 'workspace', host: HostEnv, env: Record<string, string | undefined>): string {
  const expand = (p: string): string => {
    if (p === '~') return homedir();
    if (p.startsWith('~/') || p.startsWith('~\\')) return join(homedir(), p.slice(2));
    return p;
  };
  if (dataDir && dataDir.trim().length > 0) {
    const expanded = expand(dataDir.trim());
    if (isAbsolute(expanded)) return resolve(expanded);
    return resolve(host.dshHome, expanded);
  }
  if (scope === 'workspace') {
    const ws = host.workspace && host.workspace.trim().length > 0 ? host.workspace : process.cwd();
    return join(resolve(ws), '.dsh-life-memory');
  }
  const home = host.dshHome && host.dshHome.trim().length > 0 ? host.dshHome : env.DSH_HOME || join(homedir(), '.dsh');
  return join(resolve(home), 'life-memory');
}

const tzCache = new Map<string, boolean>();
function isValidTimeZone(timezone: string): boolean {
  const cached = tzCache.get(timezone);
  if (cached !== undefined) return cached;
  let ok = true;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format(new Date());
  } catch {
    ok = false;
  }
  tzCache.set(timezone, ok);
  return ok;
}

/** 配置摘要（写日志/状态用；不含密钥） */
export function configSummary(config: MemoryVaultConfig): Record<string, unknown> {
  return {
    enabled: config.enabled,
    scope: config.scope,
    dataDir: config.dataDir,
    timezone: config.timezone,
    embedding: {
      provider: config.embedding.provider,
      model: config.embedding.model,
      dim: config.embedding.dim,
      baseURL: config.embedding.baseURL ? '<configured>' : null,
    },
    layers: config.layers.enabled,
    retention: {
      enabled: config.retention.enabled,
      shortTermDays: config.retention.shortTermDays,
      longTermAfterDays: config.retention.longTermAfterDays,
      longTermMinImportance: config.retention.longTermMinImportance,
      longTermMinRecurrence: config.retention.longTermMinRecurrence,
      pinnedIsLongTerm: config.retention.pinnedIsLongTerm,
      autoLongTermKinds: config.retention.autoLongTermKinds,
    },
    vectors: { enabled: config.vectors.enabled, rawTextMaxChars: config.vectors.rawTextMaxChars },
    forgetting: {
      enabled: config.forgetting.enabled,
      checkIntervalMs: config.forgetting.checkIntervalMs,
      protectImportance: config.forgetting.protectImportance,
    },
    persona: {
      enabled: config.persona.enabled,
      dir: config.persona.dir,
      watch: config.persona.watch,
      archiveDefinitions: config.persona.archiveDefinitions,
      injectSystemPrompt: config.persona.injectSystemPrompt,
    },
    recall: {
      injectSystemPrompt: config.recall.injectSystemPrompt,
      promptBudgetTokens: config.recall.promptBudgetTokens,
      autoRecall: config.recall.autoRecall,
    },
    http: config.http,
    ui: config.ui,
    safety: { allowNetwork: config.safety.allowNetwork, redactSecretsInDerived: config.safety.redactSecretsInDerived },
    consolidation: { enabled: config.consolidation.enabled },
  };
}

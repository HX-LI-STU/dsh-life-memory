// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hanxustu (dsh-life-memory)
/**
 * dsh-life-memory — DSH Host 插件入口（Cordis 4，v5 manager 驱动）。
 *
 * 导出契约（docs/10 §0/§2）：
 *   export const name / inject / Config；export function apply(ctx, config)
 * 注意：必须是**具名导出**（default 导出不会被 Loader 识别）。
 *
 * v5（docs/26）职责：
 * 1. 解析配置与数据目录（`ctx.get('dshHomePath')` → `<DSH_HOME>/life-memory`，可用 config.dataDir 覆盖）；
 * 2. 初始化：persona registry → session config → runtime vault manager
 *    （旧根库迁移到 `legacy-<ts>/`，vaults/shared 从零）→ 打开 shared / 激活人格库；
 * 3. 注册 13 个工具、按会话解析的动态 system prompt section、会话事件捕获钩子、
 *    16 条 GET + 5 条 POST HTTP API；
 * 4. 生命周期：定时器遍历所有已打开库（retention/forgetting/raw vector backfill/派生）、
 *    启动标记、可选自检（LIFE_MEMORY_SELFTEST=1）、dispose 关闭所有库。
 *
 * 会话语义矩阵（docs/26 §3）：
 *   memory=false → 不捕获、prompt 为空、工具结构化禁用；
 *   memory=true, persona=false → shared；
 *   memory=true, persona=true → 激活/会话指定人格库（懒创建、复用、LRU 关闭）。
 */
import { mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

import z from '@deepseek-ai/schemastery';

import { configSummary, resolveConfig } from './config.ts';
import { createLogger } from './core/logger.ts';
import type {
  CaptureStats,
  ForgettingEngine,
  Logger,
  MemoryVaultConfig,
  PersonaActivationResult,
  PersonaDefinition,
  PersonaHealth,
  PersonaRoster,
  PersonaSummary,
  RetentionEngine,
} from './core/contracts.ts';
import { hashRawRecord } from './vault/record.ts';
import { createPersonaRegistry, toPersonaSummary } from './persona/index.ts';
import { createPersonaFile, deletePersonaFile, updatePersonaFile } from './persona/manage.ts';
import type { PersonaFileUpdatePatch } from './persona/manage.ts';
import { createSessionConfigService, sessionConfigFilePath } from './session/index.ts';
import type { SessionConfigService } from './session/index.ts';
import { registerCaptureHooks } from './capture/hooks.ts';
import type { CaptureHooksHandle } from './capture/hooks.ts';
import { registerMemoryTools } from './tools/register.ts';
import type { ToolRegistryLike } from './tools/register.ts';
import { handleTool } from './tools/handlers.ts';
import type { PersonaAdminHost, PersonaToolHost, ToolContext } from './tools/handlers.ts';
import { registerKeyedPromptSection } from './prompt/register.ts';
import type { PromptRegistration, PromptRegistryLike } from './prompt/register.ts';
import { createHealthReporter } from './health.ts';
import type { HealthReporter } from './health.ts';
import { createReadOnlyApi } from './http/handlers.ts';
import type {
  HttpPersonaSummaryLike,
  HttpScopeResolver,
  HttpSessionConfigView,
  HttpTransferInput,
  HttpVaultSummaryLike,
} from './http/handlers.ts';
import { registerHttpRoutes } from './http/register.ts';
import type { ConnectionLike, HttpRegistration } from './http/register.ts';
import { createRuntimeVaultManager } from './runtime/vault-manager.ts';
import type { RuntimeVaultManager } from './runtime/vault-manager.ts';
import type { VaultBundle } from './runtime/vault-bundle.ts';
import { SHARED_VAULT_ID } from './vaults/index.ts';
import {
  exportSessionArchive,
  exportVaultArchive,
  importSessionArchive,
  importVaultArchive,
  listTransferArchives,
} from './export/index.ts';

// ===========================================================================
// Config schema（Schemastery；字段/默认值与 src/config.ts 对齐）
// ===========================================================================

const CaptureSchema = z.object({
  userMessages: z.boolean().default(true),
  assistantMessages: z.boolean().default(true),
  toolCalls: z.boolean().default(true),
  toolResults: z.boolean().default(true),
  excludeWorkspaces: z.array(z.string()).default([]),
  maxBatchSize: z.natural().default(64),
  flushIntervalMs: z.natural().default(250),
});
const EmbeddingSchema = z.object({
  provider: z.union([z.const('local'), z.const('openai-compatible')]).default('local'),
  dim: z.natural().default(512),
  model: z.string().default(''),
  baseURL: z.string().default(''),
  apiKeyEnv: z.string().default(''),
  timeoutMs: z.natural().default(20_000),
  batchSize: z.natural().default(32),
});
const LayersSchema = z.object({
  enabled: z.array(z.string()).default(['L1', 'L2', 'L3']),
  autoConsolidate: z.boolean().default(true),
  consolidationIntervalMs: z.natural().default(600_000),
  maxBatchRaws: z.natural().default(500),
});
const HybridSchema = z.object({
  vectorWeight: z.percent().default(0.55),
  lexicalWeight: z.percent().default(0.25),
  recencyWeight: z.percent().default(0.12),
  importanceWeight: z.percent().default(0.08),
  halfLifeDays: z.natural().default(30),
});
const RetentionWeightsSchema = z.object({
  recency: z.percent().default(0.35),
  importance: z.percent().default(0.3),
  recurrence: z.percent().default(0.2),
  frequency: z.percent().default(0.15),
});
const RetentionSchema = z.object({
  enabled: z.boolean().default(true),
  shortTermDays: z.number().min(0).default(7),
  promoteMidMinImportance: z.percent().default(0.45),
  promoteMidMinAccess: z.natural().default(1),
  longTermAfterDays: z.number().min(0.1).default(90),
  longTermMinImportance: z.percent().default(0.6),
  longTermMinRecurrence: z.natural().default(2),
  longTermMinScore: z.percent().default(0.75),
  tickIntervalMs: z.natural().default(600_000),
  autoLongTermKinds: z.array(z.string()).default(['profile']),
  pinnedIsLongTerm: z.boolean().default(true),
  weights: RetentionWeightsSchema.default({}),
});
/** 原始层向量索引（永久向量模型：只追加、不可删除、可从 L0 重建） */
const VectorsSchema = z.object({
  enabled: z.boolean().default(true),
  rawTextMaxChars: z.natural().default(2000),
  backfillBatchSize: z.natural().default(64),
  backfillIntervalMs: z.natural().default(5_000),
});
/** 三层记忆遗忘（短期删除 / 中期归档 / 长期永久；L0 与原始层向量永不遗忘） */
const ForgettingSchema = z.object({
  enabled: z.boolean().default(true),
  checkIntervalMs: z.natural().default(1_800_000),
  batchSize: z.natural().default(200),
  protectPinned: z.boolean().default(true),
  protectImportance: z.percent().default(0.9),
});
/** 人格（markdown 定义 + 激活 + 记忆作用域；docs/25-persona.md / docs/26 §2） */
const PersonaSchema = z.object({
  enabled: z.boolean().default(true),
  dir: z.string().default('').description('人格定义目录；空 = <DSH_HOME>/personas'),
  watch: z.boolean().default(true),
  archiveDefinitions: z.boolean().default(true),
  maxBodyChars: z.natural().default(20_000),
  injectSystemPrompt: z.boolean().default(true),
});
const RecallSchema = z.object({
  enabled: z.boolean().default(true),
  injectSystemPrompt: z.boolean().default(true),
  promptBudgetTokens: z.natural().default(800),
  toolDefaultLimit: z.natural().default(8),
  hybrid: HybridSchema.default({}),
  layerPrior: z.dict(z.number()).default({ L1: 0.9, L2: 0.98, L3: 1.0, raw: 1.0 }),
  retentionPrior: z
    .object({
      short: z.percent().default(0.95),
      mid: z.percent().default(1.0),
      long: z.percent().default(1.0),
    })
    .default({}),
  maxCandidates: z.natural().default(200),
  dedupSimilarity: z.percent().default(0.97),
  mmr: z.object({ enabled: z.boolean().default(true), lambda: z.percent().default(0.7) }).default({}),
  vectorCacheMaxItems: z.natural().default(50_000),
  autoRecall: z.boolean().default(false),
});
const HttpSchema = z.object({
  enabled: z.boolean().default(true),
  basePath: z.string().default('/api/life-memory'),
});
const SafetySchema = z.object({
  redactSecretsInDerived: z.boolean().default(true),
  allowNetwork: z.boolean().default(false),
});
const ConsolidationSchema = z.object({
  enabled: z.boolean().default(false),
  maxItemsPerRun: z.natural().default(20),
  timeoutMs: z.natural().default(30_000),
});

/** 插件配置 schema（Schemastery 原生；不能使用 zod 作为插件 Config） */
export const Config = z.object({
  enabled: z.boolean().default(true),
  scope: z.union([z.const('global'), z.const('workspace')]).default('global'),
  dataDir: z.string().default('').description('数据目录；空 = <DSH_HOME>/life-memory'),
  timezone: z.string().default('').description('IANA 时区；空 = 宿主本地时区'),
  capture: CaptureSchema.default({}),
  embedding: EmbeddingSchema.default({}),
  layers: LayersSchema.default({}),
  recall: RecallSchema.default({}),
  retention: RetentionSchema.default({}),
  vectors: VectorsSchema.default({}),
  forgetting: ForgettingSchema.default({}),
  persona: PersonaSchema.default({}),
  http: HttpSchema.default({}),
  ui: z.object({ enabled: z.boolean().default(true) }).default({}),
  safety: SafetySchema.default({}),
  consolidation: ConsolidationSchema.default({}),
});

/** 插件显示名 */
export const name = 'dsh-life-memory';

/** 静态服务依赖：apply 只在这些服务就绪后执行 */
export const inject = ['tools', 'systemPrompt', 'sessions'];

// ===========================================================================
// 宿主 Context 的最小结构子集（避免编译期强依赖 SDK 类型）
// ===========================================================================

interface SessionLike {
  readonly id: unknown;
  readonly header: { createdAt: number; cwd?: string };
  snapshotEvents?(): readonly never[];
  append(type: string, data: unknown, options?: unknown): unknown;
}

interface HostContextLike {
  logger?: ((name: string) => Logger) | Logger;
  get?(key: string): unknown;
  on(event: string, handler: (...args: never[]) => void): () => void;
  effect(disposer: () => void | (() => void), label?: string): void;
  inject(names: string[], callback: (ctx: HostContextLike) => void): void;
  tools: ToolRegistryLike & { schemas?(): Array<{ name: string }>; execute?(input: unknown): Promise<unknown> };
  systemPrompt: PromptRegistryLike & { assemble?(context?: unknown): Promise<unknown> };
  sessions?: { create?(id?: unknown, options?: unknown): SessionLike };
  [key: string]: unknown;
}

const SELFTEST_ENV = 'LIFE_MEMORY_SELFTEST';

/** 简短等待（自检/异步补档用） */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 从宿主 ctx 解析 logger */
function resolveLogger(ctx: HostContextLike): Logger {
  try {
    const factory = ctx.logger;
    if (typeof factory === 'function') return factory(name);
    if (factory && typeof (factory as Logger).info === 'function') return factory as Logger;
  } catch {
    /* fall through */
  }
  return createLogger({ level: 'info' });
}

/** 从宿主 ctx 解析 DSH home */
function resolveDshHome(ctx: HostContextLike): string {
  try {
    const homePath = ctx.get?.('dshHomePath');
    if (typeof homePath === 'function') {
      const dir = (homePath as (...segments: string[]) => unknown)();
      if (typeof dir === 'string' && dir.length > 0) return dir;
    }
  } catch {
    /* fall through */
  }
  const envHome = process.env.DSH_HOME;
  return envHome && envHome.trim().length > 0 ? envHome : join(homedir(), '.dsh');
}

function writeJsonFile(file: string, value: unknown): void {
  try {
    writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  } catch {
    /* 标记文件失败不影响插件 */
  }
}

/** 从工具入参里取显式 sessionId（v5：工具允许显式传会话） */
function explicitSessionIdOf(args: unknown): string | null {
  if (typeof args !== 'object' || args === null) return null;
  const value = (args as Record<string, unknown>).sessionId;
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

/** v7：按 sessionId 从 DSH sessions store 取当前会话对象（补档/热加载恢复用） */
function sessionOf(ctx: HostContextLike, sessionId: string): SessionLike | null {
  try {
    const store = (ctx.sessions as { store?: Map<string, SessionLike> } | undefined)?.store;
    return store?.get(sessionId) ?? null;
  } catch {
    return null;
  }
}

/** 轮询某个 bundle 的原始层向量 pending 归零（自检/收尾用；最多等 timeoutMs） */
async function drainRawVectors(bundle: VaultBundle, timeoutMs = 8_000): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (bundle.rawVectors.pending() === 0) {
      try {
        await bundle.rawVectors.backfill();
      } catch {
        /* ignore */
      }
      if (bundle.rawVectors.pending() === 0) return 0;
    }
    await sleep(200);
  }
  return bundle.rawVectors.pending();
}

// ===========================================================================
// 插件主体
// ===========================================================================

export async function apply(ctx: HostContextLike, rawConfig: Record<string, unknown>): Promise<void> {
  const logger = resolveLogger(ctx);
  const startedAt = Date.now();
  const dshHome = resolveDshHome(ctx);
  const config: MemoryVaultConfig = resolveConfig(rawConfig ?? {}, {
    dshHome,
    workspace: undefined,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  });

  if (!config.enabled) {
    logger.info('dsh-life-memory is disabled by config');
    return;
  }
  mkdirSync(config.dataDir, { recursive: true });
  const markerPath = join(config.dataDir, 'runtime-load.json');

  try {
    logger.info(`starting: ${JSON.stringify(configSummary(config))}`);

    // ── 1. v5 运行时：persona registry → session config → vault manager ──
    let currentSessionId: string | null = null;
    let vaultManager!: RuntimeVaultManager;
    let promptRegistration: PromptRegistration | null = null;
    /** v7：capture hooks 在 session-config 服务之后初始化；用 ref 打破声明顺序 */
    let captureHooksRef: CaptureHooksHandle | null = null;
    const refreshPrompt = async (): Promise<void> => {
      try {
        await promptRegistration?.refresh();
      } catch (error) {
        logger.warn('prompt refresh failed', error);
      }
    };

    const sessionConfigService: SessionConfigService = createSessionConfigService({
      filePath: sessionConfigFilePath(config.dataDir),
      logger,
      now: () => Date.now(),
      // v7：从关闭切回开启时，补档当前会话已有的历史事件（用户消息、回复等），
      // 否则会出现"只记录开启后的内容、漏掉之前发送的用户消息"。
      onEnabled: (sessionId) => {
        const session = sessionOf(ctx, sessionId);
        if (!session || !captureHooksRef) return;
        void captureHooksRef.backfillSession(session as never).catch((error) => {
          logger.warn(`session-config: backfill after enable failed for ${sessionId}`, error);
        });
      },
    });

    const personaRegistry = createPersonaRegistry({
      dir: config.persona.dir,
      config: { watch: config.persona.enabled && config.persona.watch, maxBodyChars: config.persona.maxBodyChars },
      logger,
      getActiveId: () => vaultManager.getActivePersonaId(),
      setActiveId: (id, at) => {
        vaultManager.setActivePersonaId(id, at ?? Date.now());
      },
      onReloaded: () => {
        void archivePersonaDefinitions();
        void refreshPrompt();
      },
    });

    vaultManager = createRuntimeVaultManager({
      dataDir: config.dataDir,
      config,
      logger,
      personaRegistry,
      sessionConfig: sessionConfigService,
      now: () => Date.now(),
      getSessionId: () => currentSessionId,
      onChanged: () => {
        void refreshPrompt();
      },
    });
    const ensureInfo = await vaultManager.ensure();
    const sharedBundle = await vaultManager.openVault(SHARED_VAULT_ID);
    // 已激活人格库：启动即打开（会话 persona=true 时可直接使用）
    const startupActivePersona = vaultManager.getActivePersonaId();
    if (startupActivePersona && config.persona.enabled) {
      try {
        await vaultManager.openVault(startupActivePersona);
      } catch (error) {
        logger.warn(`failed to open active persona vault: ${startupActivePersona}`, error);
      }
    }

    // ── 2. 人格定义归档（每个人格 → 自己的库 L0 note；切换事件 → 共享库）──
    const appendNote = async (
      bundle: VaultBundle,
      input: { text: string; tags: string[]; ingestKey: string; payload: Record<string, unknown>; personaId?: string | null },
    ): Promise<void> => {
      try {
        await bundle.queue.ingest(
          [
            {
              kind: 'note',
              ts: Date.now(),
              timezone: config.timezone,
              sessionId: 'persona',
              role: 'system',
              text: input.text,
              // 人格库内的定义归档：raw_index 元数据标记归属（不进入 L0 行/哈希）
              ...(input.personaId ? { personaId: input.personaId } : {}),
              payload: input.payload,
              tags: input.tags,
              ingestKey: input.ingestKey,
            },
          ],
          { reason: 'capture' },
        );
        await bundle.flush();
      } catch (error) {
        logger.warn('persona note append failed', error);
      }
    };
    const archiveDefinitionIntoVault = async (definition: PersonaDefinition): Promise<boolean> => {
      if (!config.persona.enabled || !config.persona.archiveDefinitions || !definition.valid) return false;
      const bundle = await vaultManager.openVault(definition.id);
      let archived: string | null = null;
      try {
        archived = bundle.store.getRetentionMeta(`persona.archive.${definition.id}`);
      } catch {
        archived = null;
      }
      if (archived === definition.contentHash) return false;
      await appendNote(bundle, {
        text: `人格定义: ${definition.name} (${definition.id})`,
        tags: ['persona:def', `persona:${definition.id}`],
        ingestKey: `persona-def:${definition.id}:${definition.contentHash}`,
        personaId: definition.id,
        payload: {
          personaId: definition.id,
          name: definition.name,
          description: definition.description,
          tags: definition.tags,
          aliases: definition.aliases,
          model: definition.model,
          provider: definition.provider,
          contentHash: definition.contentHash,
          body: definition.body,
        },
      });
      try {
        bundle.store.setRetentionMeta(`persona.archive.${definition.id}`, definition.contentHash);
      } catch (error) {
        logger.warn('persona archive meta write failed (will retry on next reload)', error);
      }
      return true;
    };
    async function archivePersonaDefinitions(): Promise<void> {
      if (!config.persona.enabled || !config.persona.archiveDefinitions) return;
      for (const definition of personaRegistry.list()) {
        if (!definition.valid) continue;
        try {
          await archiveDefinitionIntoVault(definition);
        } catch (error) {
          logger.warn(`persona definition archive failed: ${definition.id}`, error);
        }
      }
    }

    // 首次加载人格定义 + 归档（热重载由 onReloaded 处理）
    try {
      await personaRegistry.reload();
    } catch (error) {
      logger.warn('persona initial load failed', error);
    }
    await archivePersonaDefinitions();
    ctx.effect(() => () => personaRegistry.dispose(), `${name}: persona registry`);

    // ── 3. 人格控制面（tools / HTTP 共用）────────────────────────────────
    const resolvePersonaRef = (ref: string): PersonaDefinition | undefined => {
      const needle = ref.trim().toLowerCase();
      if (needle.length === 0) return undefined;
      const definitions = personaRegistry.list();
      return (
        definitions.find((definition) => definition.id === ref || definition.id.toLowerCase() === needle) ??
        definitions.find((definition) => definition.name.toLowerCase() === needle) ??
        definitions.find((definition) => definition.aliases.some((alias) => alias.toLowerCase() === needle))
      );
    };
    const appendPersonaSwitchNote = async (previous: string | null, activation: PersonaActivationResult): Promise<void> => {
      await appendNote(sharedBundle, {
        text: activation.activeId
          ? `人格切换: ${activation.persona?.name ?? activation.activeId} (${activation.activeId})`
          : '人格切换: 取消激活',
        tags: ['persona:switch'],
        ingestKey: `persona-switch:${Date.now()}:${previous ?? '-'}->${activation.activeId ?? '-'}`,
        payload: { from: previous, to: activation.activeId, at: Date.now() },
      });
    };
    const activatePersona = async (ref: string | null): Promise<PersonaActivationResult> => {
      if (!config.persona.enabled) {
        return { ok: false, activeId: vaultManager.getActivePersonaId(), persona: null, error: 'persona disabled' };
      }
      let targetId: string | null = null;
      if (ref !== null && ref.trim().length > 0) {
        const definition = resolvePersonaRef(ref);
        if (!definition) {
          return { ok: false, activeId: vaultManager.getActivePersonaId(), persona: null, error: `persona not found: ${ref}` };
        }
        if (!definition.valid) {
          return {
            ok: false,
            activeId: vaultManager.getActivePersonaId(),
            persona: null,
            error: `persona is invalid: ${definition.invalidReason ?? 'unknown'}`,
          };
        }
        targetId = definition.id;
      }
      const previous = vaultManager.getActivePersonaId();
      const activation = await personaRegistry.activate(targetId);
      if (activation.ok && activation.activeId !== previous) {
        // 先确保目标人格库存在（persona=true 会话可立即使用），再写切换 note（共享库）
        if (activation.activeId) {
          try {
            await vaultManager.openVault(activation.activeId);
          } catch (error) {
            logger.warn(`failed to open activated persona vault: ${activation.activeId}`, error);
          }
        }
        await appendPersonaSwitchNote(previous, activation);
        // "打开人格后"立即生效：当前会话 + 新会话默认都强制开启「人格 + 记忆」
        const personaOn = activation.activeId !== null;
        const sessionPatch = { memoryEnabled: true, personaEnabled: personaOn, personaId: activation.activeId };
        try {
          if (currentSessionId) sessionConfigService.set(currentSessionId, sessionPatch);
          sessionConfigService.setDefaults(sessionPatch);
        } catch (error) {
          logger.warn('apply persona activation to session/defaults failed', error);
        }
        await refreshPrompt();
      }
      return activation;
    };
    const personaToolHost: PersonaToolHost = {
      list: () => personaRegistry.list(),
      roster: () => personaRegistry.roster(),
      active: () => personaRegistry.active(),
      getByRef: (ref) => resolvePersonaRef(ref),
      lastError: () => personaRegistry.lastError(),
      activate: (id) => activatePersona(id),
      reload: async () => {
        const roster = await personaRegistry.reload();
        await archivePersonaDefinitions();
        await refreshPrompt();
        return roster;
      },
    };
    const personaAdmin: PersonaAdminHost = {
      async create(input) {
        const result = createPersonaFile(
          {
            ...(input.id !== undefined ? { id: input.id } : {}),
            name: input.name,
            description: input.description,
            tags: input.tags,
            aliases: input.aliases,
            body: input.body,
          },
          { dir: config.persona.dir, maxBodyChars: config.persona.maxBodyChars, now: () => Date.now() },
        );
        await personaRegistry.reload();
        await archiveDefinitionIntoVault(result.persona);
        await refreshPrompt();
        return { persona: toPersonaSummary(result.persona), created: true };
      },
      async update(id, patch) {
        const result = updatePersonaFile(id, patch as PersonaFileUpdatePatch, {
          dir: config.persona.dir,
          maxBodyChars: config.persona.maxBodyChars,
          now: () => Date.now(),
        });
        await personaRegistry.reload();
        await archiveDefinitionIntoVault(result.persona);
        await refreshPrompt();
        return { persona: toPersonaSummary(result.persona), updated: true };
      },
      async remove(id) {
        const result = deletePersonaFile(id, {
          dir: config.persona.dir,
          maxBodyChars: config.persona.maxBodyChars,
          now: () => Date.now(),
        });
        // registry.reload() 会在激活人格被删除后自动清除激活（写 active-persona.json）
        await personaRegistry.reload();
        await refreshPrompt();
        return { deleted: result.deleted, backupFile: result.backupFile };
      },
    };
    const personaHealthSnapshot = (): PersonaHealth => {
      let counts: Record<string, { total: number; L1: number; L2: number; L3: number }> = {};
      let shared = 0;
      try {
        const result = sharedBundle.store.countMemoriesByPersona();
        counts = result.counts ?? {};
        shared = Number(result.shared ?? 0);
      } catch (error) {
        logger.debug?.('persona memory counts unavailable', error);
      }
      const active = personaRegistry.active();
      return {
        enabled: config.persona.enabled,
        activeId: active?.id ?? null,
        activeName: active?.name ?? null,
        definitions: personaRegistry.list().map((definition) => toPersonaSummary(definition)),
        memoryCounts: counts,
        sharedCount: shared,
        lastError: personaRegistry.lastError(),
      };
    };

    // ── 4. 会话追踪（currentSessionId 同步；切换时刷新 prompt）────────────
    const trackSession = (session: { id?: unknown } | undefined): void => {
      if (!session || session.id === undefined || session.id === null) return;
      const next = String(session.id);
      if (next === currentSessionId) return;
      currentSessionId = next;
      void refreshPrompt();
    };
    const disposeSessionCreatedTrack = ctx.on('session/created', ((session: { id?: unknown }) => trackSession(session)) as never);
    const disposeSessionEventTrack = ctx.on('session/event', ((session: { id?: unknown }) => trackSession(session)) as never);
    ctx.effect(
      () => () => {
        disposeSessionCreatedTrack();
        disposeSessionEventTrack();
      },
      `${name}: current session tracking`,
    );

    // ── 5. 动态 system prompt（按会话解析库；memory=false 注入空）─────────
    const promptKeyOf = (): string => {
      const routing = vaultManager.resolveRouting(currentSessionId);
      return `${routing.enabled ? routing.vaultId : ':disabled'}:${currentSessionId ?? '-'}`;
    };
    promptRegistration = registerKeyedPromptSection(
      ctx.systemPrompt,
      {
        currentKey: promptKeyOf,
        build: async () => {
          const key = promptKeyOf();
          const routing = vaultManager.resolveRouting(currentSessionId);
          if (!routing.enabled) return { key, text: '' };
          const resolved = await vaultManager.resolveForSession(currentSessionId);
          if (!resolved.bundle) return { key, text: '' };
          const text = await resolved.bundle.promptBuilder.build();
          return { key, text };
        },
      },
      { logger, refreshOnRegister: true },
    );
    ctx.effect(() => () => promptRegistration?.dispose(), `${name}: system prompt section`);

    // ── 6. 工具上下文（按会话/显式 sessionId 解析库；memory=false 禁用）──
    const baseToolContext = (resolved: Awaited<ReturnType<RuntimeVaultManager['resolveForSession']>>): ToolContext => {
      const bundle = resolved.bundle!;
      return {
        config,
        store: bundle.store,
        vault: bundle.vault,
        recaller: bundle.recaller,
        retention: bundle.retention,
        persona: personaToolHost,
        health: () => bundle.health.health(),
        captureStats: (): CaptureStats => bundle.queue.stats(),
        deriveStats: () => bundle.health.deriveStats(),
        saveExplicit: bundle.memoryRuntime.saveExplicit,
        hashRawRecord: (record) => hashRawRecord(record),
        onRawAppended: (items) => bundle.rawVectors.enqueue(items.map((item) => item.record)),
        now: () => Date.now(),
        vaultScope: {
          id: resolved.vaultId,
          name: resolved.vaultName,
          personaId: resolved.personaId,
          sessionId: resolved.sessionId,
          memoryEnabled: resolved.enabled,
          // v6：库目录（导入导出按库定位；bundle 已解析到具体库）
          dir: bundle.dir,
        },
        // v6：导入后立即派生（layers 增量派生；失败不影响已落盘 raw）
        deriveNow: async (options) => {
          await bundle.runDerivation({ ...(options?.sessionId ? { sessionId: options.sessionId } : {}) });
        },
        sessionConfig: sessionConfigService,
        personaAdmin,
        listVaults: async () => {
          const summaries = await vaultManager.statsAll();
          return summaries.map((summary) => ({
            id: summary.id,
            name: summary.name,
            isPersona: summary.isPersona,
            isActive: summary.isActive,
            dir: summary.dir,
            stats: summary.stats,
          }));
        },
        resolveVault: (sessionId) => {
          const routing = vaultManager.resolveRouting(sessionId);
          return { id: routing.vaultId, name: vaultManager.vaultName(routing.vaultId) };
        },
        // v6：人格会话也可只读访问共享记忆库
        sharedVault: async () => {
          const shared = await vaultManager.openVault('shared');
          return {
            store: shared.store,
            vault: shared.vault,
            recaller: shared.recaller,
            scope: {
              id: 'shared',
              name: vaultManager.vaultName('shared'),
              personaId: null,
              sessionId: resolved.sessionId,
              memoryEnabled: true,
              dir: shared.dir,
            },
          };
        },
      };
    };
    const toolContextFor = async (args?: unknown): Promise<ToolContext> => {
      const sessionId = explicitSessionIdOf(args) ?? currentSessionId;
      const resolved = await vaultManager.resolveForSession(sessionId);
      if (resolved.enabled && resolved.bundle) return baseToolContext(resolved);
      // memory=false：用 shared（忽略禁用）构造上下文，但 handleTool 会先返回结构化禁用
      const fallback = await vaultManager.resolveForSession(sessionId, { ignoreMemoryDisabled: true });
      const ctxFallback = baseToolContext(fallback);
      return {
        ...ctxFallback,
        disabled: {
          code: 'E_MEMORY_DISABLED',
          message: '本会话已关闭记忆（memory=false）：不捕获新记录、不注入 prompt；可用 memory_session_config 重新开启',
        },
      };
    };
    ctx.effect(() => registerMemoryTools(ctx.tools, { getContext: toolContextFor, logger }), `${name}: tools`);

    // ── 7. 健康 / 定时器脏标记 ───────────────────────────────────────────
    const health: HealthReporter = sharedBundle.health;
    let forgettingTimeout: ReturnType<typeof setTimeout> | null = null;
    const runForgettingAll = async (): Promise<void> => {
      if (!config.forgetting.enabled) return;
      await vaultManager.runForgettingAll();
      await refreshPrompt();
    };
    const markForgettingDirty = (): void => {
      if (!config.forgetting.enabled) return;
      if (forgettingTimeout) return;
      forgettingTimeout = setTimeout(() => {
        forgettingTimeout = null;
        void runForgettingAll();
      }, 1500);
      forgettingTimeout.unref?.();
    };

    // ── 8. 捕获钩子（按会话路由到对应库；memory=false 不捕获）─────────────
    const hooks: CaptureHooksHandle = registerCaptureHooks(ctx, {
      config,
      logger,
      timezone: config.timezone,
      getPersonaId: () => (config.persona.enabled ? vaultManager.getActivePersonaId() : null),
      getVaultForSession: (sessionId) => vaultManager.captureRoute(sessionId),
      flushSinks: () => vaultManager.flushAll(),
      derive: async (raws, reason, sessionId) => {
        const target = await vaultManager.resolveForSession(sessionId ?? currentSessionId);
        if (!target.bundle) return;
        await target.bundle.memoryRuntime.runDerivation({ raws, reason, sessionId, now: Date.now() });
        target.bundle.health.noteDerived();
        await refreshPrompt();
      },
    });
    ctx.effect(() => () => hooks.dispose(), `${name}: session capture hooks`);
    captureHooksRef = hooks;
    // v7：插件热加载/升级发生在会话进行中时，session/created 不会重放；
    // 对当前 store 中仍启用的会话做一次幂等补档，避免漏掉此前的用户消息。
    try {
      const store = (ctx.sessions as unknown as { store?: Map<string, unknown> } | undefined)?.store;
      for (const session of store?.values() ?? []) {
        void hooks.backfillSession(session as never).catch((error) => {
          logger.warn('startup session backfill failed', error);
        });
      }
    } catch (error) {
      logger.warn('startup session backfill skipped', error);
    }
    const disposeRetentionHook = ctx.on('session/disposed', () => {
      vaultManager.markDirtyTick();
      markForgettingDirty();
      void refreshPrompt();
    });
    ctx.effect(() => () => disposeRetentionHook(), `${name}: retention/forgetting on session dispose`);

    // ── 9. HTTP API（16 GET + 5 POST；失败不阻塞核心功能）────────────────
    const toHttpSessionView = (view: ReturnType<SessionConfigService['get']>): HttpSessionConfigView => ({
      sessionId: view.sessionId,
      memoryEnabled: view.memoryEnabled,
      personaEnabled: view.personaEnabled,
      personaId: view.personaId,
      fullCapture: view.fullCapture,
      updatedAt: view.updatedAt,
      isDefault: view.isDefault,
      // v1.1.8：全局偏好（面板默认开关；每次开启仍可弹窗覆盖）
      backfillOnEnable: sessionConfigService.getDefaults().backfillOnEnable,
    });
    const resolveVaultName = (vaultId: string): string => vaultManager.vaultName(vaultId);
    const httpResolver: HttpScopeResolver = {
      async resolve({ sessionId, vault, ignoreMemoryDisabled }) {
        // 显式 vault= 只允许已知库（已有目录或存在的人格定义），避免 GET 凭空创建库目录
        if (vault && vault !== SHARED_VAULT_ID) {
          const known = vaultManager.listVaultIds().includes(vault) || Boolean(personaRegistry.get(vault));
          if (!known) {
            throw Object.assign(new Error(`未知记忆库：${vault}`), { code: 'E_NOT_FOUND', status: 404 });
          }
        }
        const resolved = await vaultManager.resolveForSession(sessionId, {
          vault,
          ignoreMemoryDisabled: ignoreMemoryDisabled ?? true,
        });
        if (!resolved.bundle) return null;
        const bundle = resolved.bundle;
        return {
          vaultId: resolved.vaultId,
          vaultName: resolved.vaultName,
          personaId: resolved.personaId,
          store: bundle.store,
          vault: bundle.vault,
          recaller: bundle.recaller,
          health: () => bundle.health.health(),
          captureStats: () => bundle.queue.stats(),
          deriveStats: () => bundle.health.deriveStats(),
        };
      },
      async listVaults(): Promise<HttpVaultSummaryLike[]> {
        const summaries = await vaultManager.statsAll();
        return summaries.map((summary) => ({
          id: summary.id,
          name: summary.name,
          isPersona: summary.isPersona,
          isActive: summary.isActive,
          dir: summary.dir,
          stats: {
            rawRecords: summary.stats.rawRecords,
            memoryCount: summary.stats.memoryCount,
            activeMemoryCount: summary.stats.activeMemoryCount,
            dbBytes: summary.stats.dbBytes,
            segments: summary.stats.segments,
            days: summary.stats.days,
            lastUpdatedAt: summary.stats.lastUpdatedAt,
          },
        }));
      },
      activeVaultId: () => vaultManager.activeVaultId(),
      activePersonaId: () => vaultManager.getActivePersonaId(),
      routingForSession: (sessionId) => {
        const routing = vaultManager.resolveRouting(sessionId);
        return { vaultId: routing.vaultId, vaultName: resolveVaultName(routing.vaultId) };
      },
      sessionConfig: (sessionId) => toHttpSessionView(sessionConfigService.get(sessionId ?? '')),
      setSessionConfig: (sessionId, patch, options) => {
        // v1.1.8：未显式传 backfillHistory 时跟随全局偏好；UI 弹窗会显式传选择。
        const backfillHistory = options?.backfillHistory ?? sessionConfigService.getDefaults().backfillOnEnable;
        const view = sessionConfigService.set(sessionId, patch, { backfillHistory });
        void refreshPrompt();
        return toHttpSessionView(view);
      },
      sessionDefaults: () => {
        const defaults = sessionConfigService.getDefaults();
        return toHttpSessionView({ sessionId: '', ...defaults, updatedAt: 0, isDefault: true });
      },
      setSessionDefaults: (patch) => {
        const defaults = sessionConfigService.setDefaults(patch);
        void refreshPrompt();
        return toHttpSessionView({ sessionId: '', ...defaults, updatedAt: 0, isDefault: true });
      },      transfer: async (input: HttpTransferInput) => {
        if (input.action === 'list-archives') {
          return listTransferArchives(config.dataDir);
        }
        const sessionId =
          typeof input.sessionId === 'string' && input.sessionId.trim().length > 0
            ? input.sessionId.trim()
            : currentSessionId;
        const vault =
          typeof input.vault === 'string' && input.vault.trim().length > 0 ? input.vault.trim() : null;
        const resolved = await vaultManager.resolveForSession(sessionId, { vault, ignoreMemoryDisabled: true });
        const bundle = resolved.bundle;
        if (!bundle) {
          throw Object.assign(new Error('当前会话记忆已关闭或记忆库不可用'), {
            code: 'E_MEMORY_DISABLED',
            status: 400,
          });
        }
        if (input.action === 'export-session') {
          if (!sessionId) {
            throw Object.assign(new Error('缺少 sessionId（无当前会话上下文时必须显式传入）'), {
              code: 'E_BAD_REQUEST',
              status: 400,
            });
          }
          return exportSessionArchive({
            vaultDir: bundle.dir,
            dataDir: config.dataDir,
            store: bundle.store,
            vault: bundle.vault,
            sessionId,
            vaultId: resolved.vaultId,
            personaId: resolved.personaId,
            includeMemories: input.includeMemories !== false,
            now: Date.now(),
            ...(input.path ? { path: input.path } : {}),
          });
        }
        if (input.action === 'import-session') {
          if (!input.path) {
            throw Object.assign(new Error('导入会话必须提供 path'), { code: 'E_BAD_REQUEST', status: 400 });
          }
          const result = await importSessionArchive({
            targetVaultDir: bundle.dir,
            store: bundle.store,
            vault: bundle.vault,
            file: input.path,
            ...(typeof input.newSessionId === 'string' && input.newSessionId.trim().length > 0
              ? { newSessionId: input.newSessionId.trim() }
              : {}),
            now: Date.now(),
            deriveHook: (items) => {
              try {
                bundle.rawVectors.enqueue(items.map((item) => item.record));
              } catch {
                /* 向量链路失败不影响已落盘内容 */
              }
            },
          });
          if (input.derive !== false) {
            try {
              await bundle.runDerivation({ reason: 'capture', sessionId: result.newSessionId });
            } catch {
              /* 派生失败不阻塞导入结果 */
            }
          }
          return { ...result, vaultId: resolved.vaultId };
        }
        if (input.action === 'export-vault' || input.action === 'export-db' || input.action === 'export-raw') {
          const include =
            input.action === 'export-db' ? 'db' : input.action === 'export-raw' ? 'raw' : 'all';
          return exportVaultArchive({
            dataDir: config.dataDir,
            vaultId: resolved.vaultId,
            vaultDir: bundle.dir,
            store: bundle.store,
            include,
            ...(input.path ? { path: input.path } : {}),
          });
        }
        if (!input.targetVault) {
          throw Object.assign(new Error('导入整库必须提供 targetVault（新库 id）'), {
            code: 'E_BAD_REQUEST',
            status: 400,
          });
        }
        if (!input.path) {
          throw Object.assign(new Error('导入整库必须提供 path'), { code: 'E_BAD_REQUEST', status: 400 });
        }
        const mode =
          input.action === 'import-db' ? 'db' : input.action === 'import-raw' ? 'raw' : 'all';
        return importVaultArchive({
          dataDir: config.dataDir,
          targetVaultId: input.targetVault,
          path: input.path,
          mode,
          timezone: config.timezone,
          now: Date.now(),
        });
      },
      rebuildRaw: async (input) => {
        const sessionId =
          typeof input.sessionId === 'string' && input.sessionId.trim().length > 0
            ? input.sessionId.trim()
            : currentSessionId;
        const resolved = await vaultManager.resolveForSession(sessionId, {
          vault: input.vault ?? null,
          ignoreMemoryDisabled: true,
        });
        if (!resolved.bundle) {
          throw Object.assign(new Error('记忆库不可用'), { code: 'E_MEMORY_DISABLED', status: 400 });
        }
        const reconcile = await resolved.bundle.reconcile();
        return {
          ok: true,
          ...reconcile,
          vaultId: resolved.vaultId,
          vaultName: resolved.vaultName,
          sessionId: sessionId ?? null,
        };
      },
      persona: {
        list: () => personaRegistry.list().map((definition) => toPersonaSummary(definition) as HttpPersonaSummaryLike),
        active: () => {
          const active = personaRegistry.active();
          return active ? (toPersonaSummary(active) as HttpPersonaSummaryLike) : null;
        },
        create: (input) =>
          personaAdmin.create({
            id: typeof input.id === 'string' ? input.id : undefined,
            name: String(input.name ?? ''),
            description: typeof input.description === 'string' ? input.description : undefined,
            tags: Array.isArray(input.tags) ? input.tags.filter((tag): tag is string => typeof tag === 'string') : undefined,
            aliases: Array.isArray(input.aliases) ? input.aliases.filter((alias): alias is string => typeof alias === 'string') : undefined,
            body: String(input.body ?? ''),
          }),
        update: (id, patch) =>
          personaAdmin.update(id, {
            name: typeof patch.name === 'string' ? patch.name : undefined,
            description: typeof patch.description === 'string' ? patch.description : undefined,
            tags: Array.isArray(patch.tags) ? patch.tags.filter((tag): tag is string => typeof tag === 'string') : undefined,
            aliases: Array.isArray(patch.aliases) ? patch.aliases.filter((alias): alias is string => typeof alias === 'string') : undefined,
            body: typeof patch.body === 'string' ? patch.body : undefined,
          }),
        remove: (id) => personaAdmin.remove(id),
        activate: (ref) => activatePersona(ref),
      },
    };
    const httpState: { registration: HttpRegistration | null; attempts: number; reason: string | null } = {
      registration: null,
      attempts: 0,
      reason: null,
    };
    if (config.http.enabled) {
      const api = createReadOnlyApi({
        config,
        store: sharedBundle.store,
        vault: sharedBundle.vault,
        recaller: sharedBundle.recaller,
        health: () => sharedBundle.health.health(),
        captureStats: () => sharedBundle.queue.stats(),
        deriveStats: () => sharedBundle.health.deriveStats(),
        now: () => Date.now(),
        resolver: httpResolver,
      });
      let mountAttempts = 0;
      const tryMountHttp = (hostCtx: HostContextLike): void => {
        mountAttempts += 1;
        httpState.attempts = mountAttempts;
        try {
          const connection = (hostCtx.get?.('connection') ?? hostCtx.connection) as ConnectionLike | undefined;
          const registration = registerHttpRoutes(connection, {
            api,
            basePath: config.http.basePath,
            logger,
            includeWrite: true,
          });
          httpState.registration = registration;
          httpState.reason = registration.reason ?? null;
          if (registration.registered === 0 && mountAttempts < 4) {
            const retry = setTimeout(() => {
              tryMountHttp(hostCtx);
            }, 1500);
            retry.unref?.();
          } else if (registration.registered > 0) {
            hostCtx.effect(() => () => httpState.registration?.dispose(), `${name}: http routes`);
          }
        } catch (error) {
          httpState.reason = error instanceof Error ? error.message : String(error);
          logger.warn('http api mount failed', error);
        }
      };
      try {
        ctx.inject(['connection'], tryMountHttp);
        const probe = setTimeout(() => {
          if (httpState.registration === null && httpState.reason === null) {
            httpState.reason = 'connection service did not become available';
          }
        }, 8_000);
        probe.unref?.();
      } catch (error) {
        httpState.reason = error instanceof Error ? error.message : String(error);
        logger.warn('connection service unavailable; http api skipped', error);
      }
    }

    // ── 10. 后台定时器（遍历 manager.allOpen()）──────────────────────────
    let consolidationTimer: ReturnType<typeof setInterval> | null = null;
    if (config.layers.autoConsolidate && config.layers.consolidationIntervalMs > 0) {
      consolidationTimer = setInterval(() => {
        void vaultManager
          .runDerivationAll('timer')
          .then(() => refreshPrompt())
          .catch((error) => logger.warn('scheduled derivation failed', error));
      }, config.layers.consolidationIntervalMs);
      consolidationTimer.unref?.();
    }
    let retentionTimer: ReturnType<typeof setInterval> | null = null;
    let startupRetentionTick: ReturnType<typeof setTimeout> | null = null;
    if (config.retention.enabled && config.retention.tickIntervalMs > 0) {
      retentionTimer = setInterval(() => {
        void vaultManager
          .runRetentionTickAll()
          .then(() => refreshPrompt())
          .catch((error) => logger.warn('retention tick failed', error));
      }, config.retention.tickIntervalMs);
      retentionTimer.unref?.();
      startupRetentionTick = setTimeout(() => {
        void vaultManager
          .runRetentionTickAll()
          .then(() => refreshPrompt())
          .catch((error) => logger.warn('startup retention tick failed', error));
      }, 5_000);
      startupRetentionTick.unref?.();
    }
    let rawVectorBackfillTimer: ReturnType<typeof setInterval> | null = null;
    let startupRawVectorBackfill: ReturnType<typeof setTimeout> | null = null;
    if (config.vectors.enabled && config.vectors.backfillIntervalMs > 0) {
      rawVectorBackfillTimer = setInterval(() => {
        void vaultManager.runRawVectorBackfillAll();
      }, config.vectors.backfillIntervalMs);
      rawVectorBackfillTimer.unref?.();
      startupRawVectorBackfill = setTimeout(() => {
        void vaultManager.runRawVectorBackfillAll();
      }, 3_000);
      startupRawVectorBackfill.unref?.();
    }
    let forgettingTimer: ReturnType<typeof setInterval> | null = null;
    let startupForgetting: ReturnType<typeof setTimeout> | null = null;
    if (config.forgetting.enabled && config.forgetting.checkIntervalMs > 0) {
      forgettingTimer = setInterval(() => {
        void runForgettingAll();
      }, config.forgetting.checkIntervalMs);
      forgettingTimer.unref?.();
      startupForgetting = setTimeout(() => {
        void runForgettingAll();
      }, 10_000);
      startupForgetting.unref?.();
    }

    // ── 11. 生命周期清理 ────────────────────────────────────────────────
    let closed = false;
    const cleanup = async (): Promise<void> => {
      if (closed) return;
      closed = true;
      try {
        if (consolidationTimer) clearInterval(consolidationTimer);
        if (retentionTimer) clearInterval(retentionTimer);
        if (startupRetentionTick) clearTimeout(startupRetentionTick);
        if (rawVectorBackfillTimer) clearInterval(rawVectorBackfillTimer);
        if (startupRawVectorBackfill) clearTimeout(startupRawVectorBackfill);
        if (forgettingTimer) clearInterval(forgettingTimer);
        if (startupForgetting) clearTimeout(startupForgetting);
        if (forgettingTimeout) clearTimeout(forgettingTimeout);
      } catch {
        /* ignore */
      }
      try {
        httpState.registration?.dispose();
      } catch {
        /* ignore */
      }
      try {
        promptRegistration?.dispose();
      } catch {
        /* ignore */
      }
      try {
        hooks.dispose();
      } catch {
        /* ignore */
      }
      try {
        personaRegistry.dispose();
      } catch {
        /* ignore */
      }
      try {
        await vaultManager.dispose();
      } catch (error) {
        logger.warn('vault manager dispose failed', error);
      }
      logger.info('stopped');
    };
    ctx.effect(
      () => () => {
        void cleanup();
      },
      `${name}: lifecycle cleanup`,
    );

    // ── 12. 加载标记（E2E 断言用；info 日志不进 stderr）──────────────────
    const registeredTools = (() => {
      try {
        return ctx.tools.schemas?.().map((tool) => tool.name) ?? [];
      } catch {
        return [];
      }
    })();
    const vaultSummaries = await vaultManager.statsAll().catch(() => []);
    const currentSessionView = sessionConfigService.get(currentSessionId ?? '');
    const currentRouting = vaultManager.resolveRouting(currentSessionId);
    const marker = {
      plugin: name,
      loadedAt: new Date().toISOString(),
      pid: process.pid,
      node: process.version,
      dataDir: config.dataDir,
      dbPath: sharedBundle.store.dbPath,
      scope: config.scope,
      embedding: sharedBundle.embedder.ref,
      layers: sharedBundle.memoryRuntime.layers.map((layer) => layer.id),
      registeredTools,
      promptSection: 'dsh-life-memory:profile',
      promptPreview: promptRegistration.current().slice(0, 500),
      httpRegistered: httpState.registration?.registered ?? 0,
      httpWriteRegistered: httpState.registration?.writeRegistered ?? 0,
      httpPath: httpState.registration?.clientBasePath ?? null,
      httpReason: httpState.reason,
      httpAttempts: httpState.attempts,
      retention: {
        enabled: config.retention.enabled,
        tickIntervalMs: config.retention.tickIntervalMs,
        stats: null,
      },
      vectors: {
        enabled: config.vectors.enabled,
        rawTextMaxChars: config.vectors.rawTextMaxChars,
        backfillIntervalMs: config.vectors.backfillIntervalMs,
        stats: null,
      },
      forgetting: {
        enabled: config.forgetting.enabled,
        checkIntervalMs: config.forgetting.checkIntervalMs,
        stats: null,
      },
      persona: {
        enabled: config.persona.enabled,
        dir: config.persona.dir,
        activeId: vaultManager.getActivePersonaId(),
        count: personaRegistry.list().length,
        stats: null,
      },
      // v5：库列表 / 会话开关 / 旧数据迁移
      vaults: vaultSummaries.map((summary) => ({
        id: summary.id,
        name: summary.name,
        isPersona: summary.isPersona,
        isActive: summary.isActive,
        dir: summary.dir,
        stats: summary.stats,
      })),
      vaultsDir: vaultManager.layout().vaultsDir,
      legacy: {
        migrated: ensureInfo.migrated,
        dir: ensureInfo.legacyDir,
        movedEntries: ensureInfo.movedEntries,
      },
      session: {
        id: currentSessionId,
        memory: currentSessionView.memoryEnabled,
        persona: currentSessionView.personaEnabled,
        personaId: currentSessionView.personaId,
        isDefault: currentSessionView.isDefault,
        vault: { id: currentRouting.vaultId, name: vaultManager.vaultName(currentRouting.vaultId) },
      },
      captureHooks: ['session/created', 'session/event', 'session/flush', 'session/disposed'],
      loadedMs: Date.now() - startedAt,
    };
    writeJsonFile(markerPath, marker);
    logger.info(
      `loaded: dataDir=${config.dataDir} tools=${registeredTools.length} vaults=${marker.vaults.length} layers=${marker.layers.join(',')} (${marker.loadedMs}ms)`,
    );
    // 动态注入（connection 等）在 apply 返回后才 settle；稍后重写一次标记，反映真实 HTTP 路由状态
    const markerRefresh = setTimeout(() => {
      void (async () => {
        let retentionStats: unknown = null;
        try {
          retentionStats = await sharedBundle.retention.stats();
        } catch {
          retentionStats = null;
        }
        let vectorStats: unknown = null;
        try {
          vectorStats = sharedBundle.rawVectors.stats();
        } catch {
          vectorStats = null;
        }
        let forgettingStats: unknown = null;
        try {
          forgettingStats = await sharedBundle.forgetting.stats();
        } catch {
          forgettingStats = null;
        }
        let personaStats: unknown = null;
        try {
          personaStats = personaHealthSnapshot();
        } catch {
          personaStats = null;
        }
        let refreshedVaults: unknown = null;
        try {
          refreshedVaults = (await vaultManager.statsAll()).map((summary) => ({
            id: summary.id,
            name: summary.name,
            isPersona: summary.isPersona,
            isActive: summary.isActive,
            dir: summary.dir,
            stats: summary.stats,
          }));
        } catch {
          refreshedVaults = null;
        }
        if (httpState.attempts > 0 || httpState.reason !== null || retentionStats !== null) {
          writeJsonFile(markerPath, {
            ...marker,
            httpRegistered: httpState.registration?.registered ?? 0,
            httpWriteRegistered: httpState.registration?.writeRegistered ?? 0,
            httpPath: httpState.registration?.clientBasePath ?? null,
            httpReason: httpState.reason,
            httpAttempts: httpState.attempts,
            retention: { ...marker.retention, stats: retentionStats },
            vectors: { ...marker.vectors, stats: vectorStats },
            forgetting: { ...marker.forgetting, stats: forgettingStats },
            persona: {
              ...marker.persona,
              activeId: vaultManager.getActivePersonaId(),
              count: personaRegistry.list().length,
              stats: personaStats,
            },
            vaults: refreshedVaults ?? marker.vaults,
            session: {
              ...marker.session,
              memory: sessionConfigService.get(currentSessionId ?? '').memoryEnabled,
              persona: sessionConfigService.get(currentSessionId ?? '').personaEnabled,
              personaId: sessionConfigService.get(currentSessionId ?? '').personaId,
              vault: (() => {
                const routing = vaultManager.resolveRouting(currentSessionId);
                return { id: routing.vaultId, name: vaultManager.vaultName(routing.vaultId) };
              })(),
            },
          });
        }
      })();
    }, 4_000);
    markerRefresh.unref?.();

    // ── 13. 可选自检（无模型依赖的端到端证据）───────────────────────────
    if (process.env[SELFTEST_ENV] === '1') {
      void runSelftest({
        ctx,
        config,
        dataDir: config.dataDir,
        manager: vaultManager,
        shared: sharedBundle,
        sessionConfig: sessionConfigService,
        persona: personaToolHost,
        personaAdmin,
        personaDir: config.persona.dir,
        hooks,
        promptRegistration,
        health,
        toolContext: toolContextFor,
        refreshPrompt,
        httpState: () => ({
          registered: httpState.registration?.registered ?? 0,
          writeRegistered: httpState.registration?.writeRegistered ?? 0,
          clientBasePath: httpState.registration?.clientBasePath ?? null,
          reason: httpState.reason,
          attempts: httpState.attempts,
          routes: httpState.registration?.routes?.map((route) => route.path) ?? [],
          writeRoutes: httpState.registration?.writeRoutes?.map((route) => route.path) ?? [],
        }),
        logger,
      });
    }

    // 启动后异步做一次廉价的完整性自检（不阻塞加载；仅在环境变量开启时执行全量 verify）
    if (process.env.LIFE_MEMORY_VERIFY_ON_START === '1') {
      setTimeout(() => {
        void sharedBundle.health.runVerify();
      }, 2_000).unref?.();
    }
  } catch (error) {
    logger.error('plugin init failed', error);
    writeJsonFile(markerPath, {
      plugin: name,
      loadedAt: new Date().toISOString(),
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

// ===========================================================================
// 自检（LIFE_MEMORY_SELFTEST=1）
// ===========================================================================

interface SelftestDeps {
  ctx: HostContextLike;
  config: MemoryVaultConfig;
  dataDir: string;
  manager: RuntimeVaultManager;
  /** 常开共享库 bundle（大部分自检步骤的默认库） */
  shared: VaultBundle;
  sessionConfig: SessionConfigService;
  /** 人格工具宿主（定义列表/激活/重载；docs/25） */
  persona: PersonaToolHost;
  /** v5：人格 CRUD 控制面 */
  personaAdmin: PersonaAdminHost;
  /** 人格定义目录（selftest 写入临时 fixture） */
  personaDir: string;
  hooks: CaptureHooksHandle;
  promptRegistration: PromptRegistration | null;
  health: HealthReporter;
  /** 按会话/显式 sessionId 解析工具上下文（v5） */
  toolContext: (args?: unknown) => Promise<ToolContext>;
  refreshPrompt: () => Promise<void>;
  /** HTTP 路由注册真实状态（connection 动态注入在 apply 返回后才 settle） */
  httpState: () => {
    registered: number;
    writeRegistered: number;
    clientBasePath: string | null;
    reason: string | null;
    attempts: number;
    routes: string[];
    writeRoutes: string[];
  };
  logger: Logger;
}

/** 真实宿主进程内自检：会话事件捕获、工具执行、prompt 注入、幂等、校验、v5 隔离 */
async function runSelftest(deps: SelftestDeps): Promise<void> {
  const {
    ctx,
    config,
    manager,
    shared,
    sessionConfig,
    persona,
    personaAdmin,
    personaDir,
    hooks,
    promptRegistration,
    health,
    toolContext,
    refreshPrompt,
    logger,
  } = deps;
  const queue = shared.queue;
  const store = shared.store;
  const vault = shared.vault;
  const retention: RetentionEngine = shared.retention;
  const forgetting: ForgettingEngine = shared.forgetting;
  const result: Record<string, unknown> = { startedAt: new Date().toISOString(), steps: {} as Record<string, unknown> };
  const steps = result.steps as Record<string, unknown>;
  const tool = <T>(label: string, fx: () => Promise<T>): Promise<T | null> =>
    fx()
      .then((value) => {
        steps[label] = value;
        return value;
      })
      .catch((error) => {
        let detail: unknown;
        if (error instanceof Error) {
          detail = { error: error.message, stack: error.stack?.split('\n').slice(0, 4).join(' | ') };
        } else {
          let json = '';
          try {
            json = JSON.stringify(error)?.slice(0, 3000) ?? '';
          } catch {
            json = '';
          }
          detail = { error: String(error), json };
        }
        steps[label] = detail;
        logger.warn(`selftest ${label} failed`, detail);
        return null;
      });
  const executeTool = async (toolName: string, args: Record<string, unknown>): Promise<unknown> => {
    if (typeof ctx.tools.execute !== 'function') throw new Error('ctx.tools.execute unavailable');
    return ctx.tools.execute({
      callId: `selftest-${toolName}-${Date.now()}`,
      name: toolName,
      arguments: args,
      signal: new AbortController().signal,
    });
  };
  /** ctx.tools.execute 返回 ToolCallResult 包络（{content,value}）；自检需要取内部业务值 */
  const unwrapToolValue = (result: unknown): Record<string, unknown> => {
    if (result !== null && typeof result === 'object' && 'value' in (result as Record<string, unknown>)) {
      const value = (result as Record<string, unknown>).value;
      if (value !== null && typeof value === 'object') return value as Record<string, unknown>;
    }
    return (result ?? {}) as Record<string, unknown>;
  };

  try {
    await sleep(300); // 等插件各行注册完成

    // 1) 会话事件 → L0（共享库）
    const session = await tool('sessionCapture', async () => {
      const created = ctx.sessions?.create?.();
      if (!created) throw new Error('ctx.sessions.create unavailable');
      created.append('turn/start', { turn: 1 });
      created.append(
        'user/message',
        {
          id: 'msg-selftest-1',
          role: 'user',
          content: [{ type: 'text', text: '记住：我偏好深色主题，本地端口用 8080。' }],
          source: { kind: 'user' },
        },
        { surfaceOp: 'append' },
      );
      created.append('turn/end', { turn: 1, reason: { kind: 'completed' } });
      await sleep(500);
      await queue.flush();
      const stats = await vault.stats();
      const listed = await vault.list({ sessionId: String(created.id), limit: 100 });
      return {
        sessionId: String(created.id),
        vaultId: shared.id,
        vaultRecords: stats.records,
        capturedForSession: listed.total,
        kinds: listed.records.map((record) => record.kind),
        payloadHasData: listed.records.every((record) => record.payload !== undefined && record.payload !== null),
      };
    });

    // 1.1) 事件覆盖：assistant / tool_call / tool_result 也要进入 L0（验证"应存尽存"）
    await tool('eventCoverage', async () => {
      const created = ctx.sessions?.create?.();
      if (!created) throw new Error('ctx.sessions.create unavailable');
      const appended: string[] = [];
      const errors: string[] = [];
      const tryAppend = (type: string, data: Record<string, unknown>, options?: Record<string, unknown>): void => {
        try {
          created.append(type, data, options);
          appended.push(type);
        } catch (error) {
          errors.push(`${type}: ${error instanceof Error ? error.message : String(error)}`);
        }
      };
      tryAppend('turn/start', { turn: 1 });
      tryAppend(
        'user/message',
        {
          id: 'msg-selftest-tools-1',
          role: 'user',
          content: [{ type: 'text', text: '请帮我检查一下构建脚本。' }],
          source: { kind: 'user' },
        },
        { surfaceOp: 'append' },
      );
      tryAppend(
        'assistant/message',
        {
          turn: 1,
          step: 1,
          message: {
            id: 'msg-selftest-assistant-1',
            role: 'assistant',
            content: [
              { type: 'text', text: '好的，我先看一眼 build.mjs。' },
              { type: 'tool-call', id: 'selftest-call-1', name: 'read', arguments: '{"path":"build.mjs"}' },
            ],
            source: { kind: 'model', provider: 'selftest', model: 'selftest-model' },
          },
          stream: [],
        },
        { surfaceOp: 'append' },
      );
      tryAppend('tool/call', { turn: 1, step: 1, callId: 'selftest-call-1', name: 'read', arguments: '{"path":"build.mjs"}' });
      tryAppend(
        'tool/result',
        {
          turn: 1,
          step: 1,
          callId: 'selftest-call-1',
          message: {
            id: 'msg-selftest-tool-result-1',
            role: 'tool',
            toolCallId: 'selftest-call-1',
            isError: false,
            content: [{ type: 'text', text: 'build.mjs: 100 lines' }],
            source: { kind: 'tool', callId: 'selftest-call-1' },
          },
        },
        { surfaceOp: 'append' },
      );
      tryAppend('turn/end', { turn: 1, reason: { kind: 'completed' } });
      await sleep(500);
      await queue.flush();
      const listed = await vault.list({ sessionId: String(created.id), limit: 200 });
      const kinds = listed.records.map((record) => record.kind);
      return {
        sessionId: String(created.id),
        appended,
        errors,
        captured: listed.total,
        kinds,
        hasAssistant: kinds.includes('assistant'),
        hasToolCall: kinds.includes('tool_call'),
        hasToolResult: kinds.includes('tool_result'),
      };
    });

    // 2) 补档幂等：再次 backfill 不应新增原始行
    await tool('backfillIdempotent', async () => {
      const created = ctx.sessions?.create?.();
      if (!created) throw new Error('ctx.sessions.create unavailable');
      created.append('turn/start', { turn: 1 });
      created.append('turn/end', { turn: 1, reason: { kind: 'completed' } });
      await sleep(300);
      await queue.flush();
      const before = (await vault.stats()).records;
      await hooks.backfillSession(created as never);
      await queue.flush();
      const after = (await vault.stats()).records;
      return { before, after, noDuplicates: after === before };
    });

    // 3) 工具：memory_status / memory_layers / memory_recall / memory_get_raw
    await tool('toolStatus', async () => summarizeToolResult(await executeTool('memory_status', {})));
    await tool('toolLayers', async () => summarizeToolResult(await executeTool('memory_layers', {})));
    await tool('toolSave', async () =>
      summarizeToolResult(await executeTool('memory_save', { text: '用户偏好深色主题（自检保存）', kind: 'preference' })),
    );
    await tool('toolRecall', async () => {
      try {
        const recallResult = (await executeTool('memory_recall', { query: '深色主题 端口', limit: 5, includeRaw: true })) as
          | Record<string, unknown>
          | undefined;
        return {
          ok: true,
          isError: recallResult && typeof recallResult === 'object' ? (recallResult.isError ?? null) : null,
          keys: recallResult && typeof recallResult === 'object' ? Object.keys(recallResult) : [],
          textPreview: String(
            ((recallResult as { content?: Array<{ text?: string }> } | undefined)?.content?.[0]?.text ?? ''),
          ).slice(0, 400),
        };
      } catch (error) {
        const asAny = error as { message?: string; code?: string; name?: string; info?: unknown; stack?: string };
        return {
          caught: true,
          name: asAny?.name ?? typeof error,
          code: asAny?.code ?? null,
          message: asAny?.message ?? String(error),
          info: (() => {
            try {
              return JSON.stringify(asAny?.info ?? null).slice(0, 1000);
            } catch {
              return null;
            }
          })(),
          stack: String(asAny?.stack ?? '').split('\n').slice(0, 4).join(' | '),
        };
      }
    });
    // 4.0) 直接调用工具处理器（绕过宿主包装），便于定位协议层/运行时问题
    await tool('toolRecallDirect', async () => {
      const direct = await handleTool(
        'memory_recall',
        { query: '深色主题 端口', limit: 5, includeRaw: true },
        await toolContext(),
      );
      return summarizeToolResult(direct);
    });
    await tool('toolGetRaw', async () => {
      const first = (await vault.list({ limit: 1 })).records[0];
      if (!first) throw new Error('vault is empty');
      return summarizeToolResult(await executeTool('memory_get_raw', { id: first.id }));
    });

    // 4) prompt 注入块（当前会话 = 共享库）
    await tool('promptSection', async () => {
      await refreshPrompt();
      return {
        currentLength: promptRegistration?.current().length ?? 0,
        hasHeader: (promptRegistration?.current() ?? '').includes('记忆库'),
        vaultId: shared.id,
        assembledHasSection: await (async () => {
          try {
            const assembly = await ctx.systemPrompt.assemble?.();
            const text = JSON.stringify(assembly ?? {});
            return text.includes('dsh-life-memory') || (promptRegistration?.current().length ?? 0) > 0;
          } catch {
            return null;
          }
        })(),
      };
    });

    // 4.1) HTTP 路由状态（connection 动态注入在 apply 返回后才 settle）
    await tool('httpRoutes', async () => {
      await sleep(3_500);
      return deps.httpState();
    });

    // 5) 完整性校验（共享库）
    await tool('vaultVerify', async () => health.runVerify());

    // 5.1) 记忆分层模型（短期/中期/长期 retention）
    await tool('retention', async () => {
      const statsBefore = await retention.stats();
      const saveResult = (await handleTool(
        'memory_save',
        {
          text: `自检记忆分层 run-${Date.now()}: 长期保留的重要事实（深色主题 / 本地端口 8080）`,
          kind: 'fact',
          pin: false,
          importance: 0.95,
        },
        await toolContext(),
      )) as Record<string, unknown>;
      const memoryId = typeof saveResult.memoryId === 'string' ? saveResult.memoryId : null;
      const retentionAfterSave = memoryId ? store.getRetention(memoryId) : null;
      const statsAfterSave = await retention.stats();
      if (!memoryId) {
        throw new Error(`memory_save 未返回 memoryId，无法绑定本次新建记录：${JSON.stringify(saveResult).slice(0, 300)}`);
      }
      if (!retentionAfterSave) {
        throw new Error(`store.getRetention(${memoryId}) 为空：保留期状态未写入`);
      }
      if (retentionAfterSave.tier !== 'short') {
        throw new Error(`新建记忆默认层应为 short，实际 ${retentionAfterSave.tier}（memoryId=${memoryId}）`);
      }
      if (!(statsAfterSave.short >= 1)) {
        throw new Error(`新建记忆应默认进入短期层 short（>=1），实际 ${JSON.stringify(statsAfterSave)}`);
      }
      await sleep(300);
      const layerCountsBefore = store.listLayers().map((layer) => ({ id: layer.id, count: layer.count }));
      const tickMid = await retention.tick({ now: Date.now() + 8 * 86_400_000 });
      const statsAfterMid = await retention.stats();
      if (!(tickMid.promotedToMid >= 1 && statsAfterMid.mid >= 1)) {
        throw new Error(`tick(+8d) 应把 short 晋升到 mid（promotedToMid>=1），实际 tick=${JSON.stringify(tickMid)} stats=${JSON.stringify(statsAfterMid)}`);
      }
      const tickLong = await retention.tick({ now: Date.now() + 100 * 86_400_000 });
      const statsAfterLong = await retention.stats();
      if (!(tickLong.promotedToLong >= 1 && statsAfterLong.long >= 1)) {
        throw new Error(`tick(+100d) 应把高重要度记忆晋升到 long（promotedToLong>=1），实际 tick=${JSON.stringify(tickLong)} stats=${JSON.stringify(statsAfterLong)}`);
      }
      const finalTier = memoryId ? store.getRetention(memoryId)?.tier ?? null : null;
      const layerCountsAfter = store.listLayers().map((layer) => ({ id: layer.id, count: layer.count }));
      const layerCountsUnchanged = JSON.stringify(layerCountsBefore) === JSON.stringify(layerCountsAfter);
      if (!layerCountsUnchanged) {
        throw new Error(`retention tick 不应改变 L1/L2/L3 类型层计数：before=${JSON.stringify(layerCountsBefore)} after=${JSON.stringify(layerCountsAfter)}`);
      }
      return {
        short: statsAfterSave.short,
        promotedToMid: tickMid.promotedToMid,
        promotedToLong: tickLong.promotedToLong,
        layerCountsUnchanged,
        statsBefore,
        statsAfterSave,
        statsAfterMid,
        statsAfterLong,
        memoryId,
        defaultTier: retentionAfterSave?.tier ?? null,
        finalTier,
        tickMid,
        tickLong,
        layerCountsBefore,
        layerCountsAfter,
      };
    });

    // 5.2) 显式检索（v3/v5，默认 mode=explicit）：L0 原始层 + 原始层永久向量
    await tool('explicitRecall', async () => {
      const marker = `自检显式检索-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const saved = (await handleTool(
        'memory_save',
        { text: `事实：${marker}（显式检索验证）`, kind: 'fact', pin: false, importance: 0.2 },
        await toolContext(),
      )) as Record<string, unknown>;
      const rawId = typeof saved.rawId === 'string' ? saved.rawId : null;
      await queue.flush();
      await sleep(300);
      const recall = (await handleTool(
        'memory_recall',
        { query: marker, mode: 'explicit', limit: 5, includeRaw: false },
        await toolContext(),
      )) as Record<string, unknown>;
      const items = Array.isArray(recall.items) ? (recall.items as Array<Record<string, unknown>>) : [];
      const hit = items.find((item) => {
        const raw = item.raw as Record<string, unknown> | undefined;
        const rawText = raw ? String(raw.text ?? '') : '';
        const citations = Array.isArray(item.citations) ? item.citations.map((value) => String(value)) : [];
        return rawText.includes(marker) || (rawId !== null && citations.includes(rawId));
      });
      if (!hit) {
        throw new Error(`explicit recall 未命中唯一 n-gram（marker=${marker} rawId=${rawId} items=${items.length}）`);
      }
      return {
        mode: recall.mode ?? null,
        marker,
        rawId,
        returned: items.length,
        hitLayer: hit.layer,
        hitRawId: (hit.raw as { id?: string } | undefined)?.id ?? null,
        citations: hit.citations,
      };
    });

    // 5.3) 隐式检索（mode=implicit）：只返回三层记忆（带 retention；受遗忘影响）
    await tool('implicitRecall', async () => {
      const recall = (await handleTool(
        'memory_recall',
        { query: '深色主题 端口', mode: 'implicit', limit: 5 },
        await toolContext(),
      )) as Record<string, unknown>;
      const items = Array.isArray(recall.items) ? (recall.items as Array<Record<string, unknown>>) : [];
      const memoryItems = items.filter((item) => typeof item.id === 'string' && typeof item.retention === 'object');
      if (items.length < 1) throw new Error('implicit recall 未返回三层记忆命中');
      if (memoryItems.length !== items.length) {
        throw new Error(`implicit recall 只应返回三层记忆（items=${items.length} withRetention=${memoryItems.length}）`);
      }
      const first = memoryItems[0]!;
      return {
        mode: recall.mode ?? null,
        returned: items.length,
        first: { id: first.id, layer: first.layer, retention: first.retention },
      };
    });

    // 5.4) 原始层永久向量：回填完成后 pending 归零，embedded 覆盖所有有文本的 raw
    await tool('rawVectors', async () => {
      const startedAt = Date.now();
      const before = store.rawVectorStats();
      let stats = before;
      let expected = 0;
      const deadline = Date.now() + 25_000;
      while (Date.now() < deadline) {
        const rawIndex = store.listRawIndex({ limit: 5000 });
        expected = rawIndex.records.filter((row) => (row.text ?? '').trim().length > 0).length;
        stats = store.rawVectorStats();
        if (expected > 0 && stats.pending === 0 && stats.embedded >= expected) break;
        await sleep(500);
      }
      if (expected <= 0) throw new Error('raw 文本记录为 0，无法验证原始层向量回填');
      if (stats.pending !== 0 || stats.embedded < expected) {
        throw new Error(
          `原始层向量回填未完成：embedded=${stats.embedded} pending=${stats.pending} expected(有文本 raw)=${expected} total=${stats.total} lastBackfillAt=${stats.lastBackfillAt}`,
        );
      }
      return {
        total: stats.total,
        embedded: stats.embedded,
        pending: stats.pending,
        expected,
        ref: stats.ref,
        lastBackfillAt: stats.lastBackfillAt,
        before,
        waitedMs: Date.now() - startedAt,
      };
    });

    // 5.5) 遗忘（v3，注入时钟）：short 到期物理删除；mid 到期归档；L0/raw 索引/原始层向量只增不减
    await tool('forgetting', async () => {
      const now = Date.now();
      const unique = Math.random().toString(36).slice(2, 8);
      const saveFact = async (text: string, importance: number): Promise<Record<string, unknown>> =>
        (await handleTool('memory_save', { text, kind: 'fact', pin: false, importance }, await toolContext())) as Record<string, unknown>;
      const shortSave = await saveFact(`自检遗忘-短期-${now}-${unique}: 低重要度临时记忆（应被遗忘删除）`, 0.1);
      const midSave = await saveFact(`自检遗忘-中期-${now}-${unique}: 中重要度记忆（应被归档）`, 0.5);
      const idShort = typeof shortSave.memoryId === 'string' ? shortSave.memoryId : null;
      const idMid = typeof midSave.memoryId === 'string' ? midSave.memoryId : null;
      if (!idShort || !idMid) throw new Error(`forgetting fixture 保存失败：short=${JSON.stringify(shortSave).slice(0, 200)} mid=${JSON.stringify(midSave).slice(0, 200)}`);
      await queue.flush();
      const promoteTick = await retention.tick({ now: now + 8 * 86_400_000 });
      const statsBefore = await forgetting.stats();
      const rawBefore = (await vault.stats()).records;
      const rawIndexBefore = store.listRawIndex({ limit: 10_000 }).total;
      const vectorsBefore = store.rawVectorStats();
      const verifyBefore = await vault.verify();
      const runShort = await forgetting.run({ now: now + 8 * 86_400_000 });
      const shortGone = store.getMemory(idShort) === null && store.getRetention(idShort) === null;
      if (!(runShort.deletedShort >= 1 && shortGone)) {
        throw new Error(`short 到期应物理删除：deletedShort=${runShort.deletedShort} shortGone=${shortGone} run=${JSON.stringify(runShort)}`);
      }
      const runMid = await forgetting.run({ now: now + 100 * 86_400_000 });
      const archived = store.getMemory(idMid);
      if (!(runMid.archivedMid >= 1 && archived && (archived.status ?? 'active') !== 'active')) {
        throw new Error(`mid 到期应归档：archivedMid=${runMid.archivedMid} record=${JSON.stringify(archived)?.slice(0, 300)}`);
      }
      const verifyAfter = await vault.verify();
      const rawAfter = (await vault.stats()).records;
      const rawIndexAfter = store.listRawIndex({ limit: 10_000 }).total;
      const vectorsAfter = store.rawVectorStats();
      const statsAfter = await forgetting.stats();
      const l0RecordsUnchanged = rawAfter === rawBefore;
      const rawIndexUnchanged = rawIndexAfter === rawIndexBefore;
      const rawVectorsNotDecreased = vectorsAfter.total >= vectorsBefore.total;
      if (!(verifyBefore.ok && verifyAfter.ok && l0RecordsUnchanged && rawIndexUnchanged && rawVectorsNotDecreased)) {
        throw new Error(
          `遗忘不变量被破坏：verify=${verifyBefore.ok}/${verifyAfter.ok} l0=${rawBefore}->${rawAfter} rawIndex=${rawIndexBefore}->${rawIndexAfter} rawVectors=${vectorsBefore.total}->${vectorsAfter.total}`,
        );
      }
      return {
        deletedShort: runShort.deletedShort,
        archivedMid: runMid.archivedMid,
        protectedCount: runShort.protectedCount + runMid.protectedCount,
        idShort,
        idMid,
        shortGone,
        midArchived: true,
        l0VerifyOk: verifyAfter.ok,
        l0RecordsUnchanged,
        rawIndexUnchanged,
        rawVectorsNotDecreased,
        promoteTick,
        statsBefore,
        statsAfter,
        vaultId: shared.id,
      };
    });

    // 5.6) 人格（v4/v5）：markdown 定义 + 严格 {{…}} + 激活 + L0 归档 + 库隔离 + prompt 注入
    await tool('persona', async () => {
      if (!config.persona.enabled) return { skipped: true, reason: 'persona.enabled=false' };
      const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const personaA = `selftest-persona-a-${stamp}`;
      const personaB = `selftest-persona-b-${stamp}`;
      const badId = `selftest-bad-${stamp}`;
      const fileA = join(personaDir, `${personaA}.md`);
      const fileB = join(personaDir, `${personaB}.md`);
      const fileBad = join(personaDir, `${badId}.md`);
      const sessionCfgSession = (() => {
        try {
          return String(ctx.sessions?.create?.()?.id ?? '');
        } catch {
          return '';
        }
      })();
      mkdirSync(personaDir, { recursive: true });
      writeFileSync(fileA, `---\nname: 自检人格A\ndescription: 自检临时人格 A\ntags: [selftest]\n---\n你是自检人格 A（${personaA}），回答简洁。\n`, 'utf8');
      writeFileSync(fileB, `---\nname: 自检人格B\ndescription: 自检临时人格 B\ntags: [selftest]\n---\n你是自检人格 B（${personaB}），回答简洁。\n`, 'utf8');
      writeFileSync(fileBad, `---\ndescription: 模板组应被拒绝\n---\n你是一个 {{name}} 人格。\n`, 'utf8');
      try {
        await persona.reload();
        const definitions = persona.list();
        const defA = definitions.find((definition) => definition.id === personaA);
        const defBad = definitions.find((definition) => definition.id === badId);
        if (!defA || !defA.valid) throw new Error(`合法人格未加载：${JSON.stringify(defA)?.slice(0, 300)}`);
        const invalidSkipped = Boolean(defBad && !defBad.valid && defBad.invalidReason);
        if (!invalidSkipped) throw new Error(`含 {{…}} 的人格应无效：${JSON.stringify(defBad)?.slice(0, 300)}`);
        const listResult = (await handleTool('memory_persona_list', {}, await toolContext())) as Record<string, unknown>;
        const listed = Array.isArray(listResult.personas) ? (listResult.personas as Array<Record<string, unknown>>) : [];
        if (!listed.some((item) => item.id === personaA && item.valid === true)) {
          throw new Error('memory_persona_list 未列出合法人格');
        }
        // 激活 A（写 active-persona.json + 共享库 L0 note；定义归档进 A 库）
        const activation = (await handleTool('memory_persona_use', { persona: personaA }, await toolContext())) as Record<string, unknown>;
        if (activation.ok !== true || activation.activeId !== personaA) {
          throw new Error(`激活人格失败：${JSON.stringify(activation)?.slice(0, 300)}`);
        }
        await queue.flush();
        const vaultA = await manager.openVault(personaA);
        await vaultA.flush();
        const defNotes = vaultA.store.listRawIndex({ kinds: ['note'], limit: 5000 }).records;
        const defArchived = defNotes.some((row) => row.ingestKey.startsWith(`persona-def:${personaA}:`));
        const switchNotes = store.listRawIndex({ kinds: ['note'], limit: 5000 }).records;
        const switchNote = switchNotes.some((row) => row.ingestKey.startsWith('persona-switch:'));
        if (!defArchived) throw new Error(`人格定义未归档到 A 库 L0（缺 persona-def:${personaA}）`);
        if (!switchNote) throw new Error('人格切换未写入共享库 L0 note');
        // 会话 persona=true → 写 A 库
        if (sessionCfgSession) sessionConfig.set(sessionCfgSession, { memoryEnabled: true, personaEnabled: true, personaId: null });
        await refreshPrompt();
        const personaContext = await toolContext(sessionCfgSession ? { sessionId: sessionCfgSession } : undefined);
        const marker = `自检人格记忆-${stamp}`;
        const saved = (await handleTool(
          'memory_save',
          { text: `事实：${marker}`, kind: 'fact', pin: false, importance: 0.6 },
          personaContext,
        )) as Record<string, unknown>;
        const memoryId = typeof saved.memoryId === 'string' ? saved.memoryId : null;
        if (!memoryId) throw new Error(`memory_save 未返回 memoryId：${JSON.stringify(saved)?.slice(0, 200)}`);
        await vaultA.flush();
        const stored = vaultA.store.getMemory(memoryId);
        if (!stored || stored.personaId !== personaA) {
          throw new Error(`记忆未归属当前人格库：personaId=${JSON.stringify(stored?.personaId)} vault=${vaultA.id}`);
        }
        await sleep(200);
        const recallMine = (await handleTool(
          'memory_recall',
          { query: marker, mode: 'implicit', limit: 10 },
          personaContext,
        )) as Record<string, unknown>;
        const mineItems = Array.isArray(recallMine.items) ? (recallMine.items as Array<Record<string, unknown>>) : [];
        const recallScoped = mineItems.some((item) => item.id === memoryId);
        if (!recallScoped) throw new Error(`当前人格库召回未命中本人记忆（marker=${marker}）`);
        // 切换到 B 后（persona=true），A 的记忆不再返回（库隔离）
        const switching = (await handleTool('memory_persona_use', { persona: personaB }, await toolContext())) as Record<string, unknown>;
        if (switching.ok !== true || switching.activeId !== personaB) {
          throw new Error(`切换人格 B 失败：${JSON.stringify(switching)?.slice(0, 300)}`);
        }
        await sleep(200);
        const recallOther = (await handleTool(
          'memory_recall',
          { query: marker, mode: 'implicit', limit: 10 },
          await toolContext(sessionCfgSession ? { sessionId: sessionCfgSession } : undefined),
        )) as Record<string, unknown>;
        const otherItems = Array.isArray(recallOther.items) ? (recallOther.items as Array<Record<string, unknown>>) : [];
        const excludedAfterSwitch = !otherItems.some((item) => item.id === memoryId);
        if (!excludedAfterSwitch) throw new Error('切换人格后仍召回其他人格记忆（库隔离失效）');
        // prompt 注入：激活 A + 会话 persona=true 时人格身份块出现
        await handleTool('memory_persona_use', { persona: personaA }, await toolContext());
        await refreshPrompt();
        const promptText = promptRegistration?.current() ?? '';
        const promptHasPersona = promptText.includes('自检人格A') && promptText.includes(personaA);
        if (!promptHasPersona) throw new Error(`prompt 未注入人格身份块（len=${promptText.length}）`);
        await drainRawVectors(vaultA);
        await drainRawVectors(shared);
        return {
          created: true,
          personaId: personaA,
          personaBId: personaB,
          vaultId: vaultA.id,
          invalidSkipped,
          listed: true,
          activated: true,
          defArchived,
          switchNote,
          memoryScoped: true,
          recallScoped,
          excludedAfterSwitch,
          promptHasPersona,
        };
      } finally {
        try {
          unlinkSync(fileA);
        } catch {
          /* ignore */
        }
        try {
          unlinkSync(fileB);
        } catch {
          /* ignore */
        }
        try {
          unlinkSync(fileBad);
        } catch {
          /* ignore */
        }
        try {
          if (sessionCfgSession) sessionConfig.remove(sessionCfgSession);
          await handleTool('memory_persona_use', { persona: null }, await toolContext());
          await persona.reload();
          await queue.flush();
          await manager.flushAll();
          await refreshPrompt();
        } catch (cleanupError) {
          logger.warn('persona selftest cleanup failed', cleanupError);
        }
      }
    });

    // 6) v5：记忆库列表（shared 必在）
    await tool('vaults', async () => {
      const ids = manager.listVaultIds();
      const summaries = await manager.statsAll();
      const sharedSummary = summaries.find((summary) => summary.id === SHARED_VAULT_ID);
      if (!ids.includes(SHARED_VAULT_ID)) throw new Error(`listVaultIds 缺少 shared：${JSON.stringify(ids)}`);
      if (!sharedSummary) throw new Error('statsAll 缺少 shared');
      if (sharedSummary.dir !== shared.dir) {
        throw new Error(`shared 目录不一致：${sharedSummary.dir} != ${shared.dir}`);
      }
      return {
        ok: true,
        ids,
        vaults: summaries.map((summary) => ({
          id: summary.id,
          name: summary.name,
          isPersona: summary.isPersona,
          isActive: summary.isActive,
          dir: summary.dir,
          stats: summary.stats,
        })),
        vaultsDir: manager.layout().vaultsDir,
        sharedDir: shared.dir,
        sharedStats: sharedSummary.stats,
      };
    });

    // 6.1) v5：会话配置（默认值 → 更新 → 回读 → 工具 → 清理）
    await tool('sessionConfig', async () => {
      const sessionId = String(ctx.sessions?.create?.()?.id ?? `selftest-session-config-${Date.now()}`);
      const before = sessionConfig.get(sessionId);
      if (!(before.memoryEnabled === true && before.personaEnabled === false && before.personaId === null && before.isDefault === true)) {
        throw new Error(`会话默认值应为 memory=true/persona=false/personaId=null/isDefault=true：${JSON.stringify(before)}`);
      }
      const updated = sessionConfig.set(sessionId, { memoryEnabled: true, personaEnabled: true, personaId: null });
      const readback = sessionConfig.get(sessionId);
      if (!(updated.personaEnabled === true && readback.personaEnabled === true && readback.isDefault === false)) {
        throw new Error(`会话配置回读失败：updated=${JSON.stringify(updated)} readback=${JSON.stringify(readback)}`);
      }
      const toolResult = (await handleTool(
        'memory_session_config',
        { sessionId, memory: true, persona: false },
        await toolContext({ sessionId }),
      )) as Record<string, unknown>;
      if (toolResult.ok !== true || toolResult.persona !== false || toolResult.memory !== true) {
        throw new Error(`memory_session_config 工具结果异常：${JSON.stringify(toolResult)?.slice(0, 400)}`);
      }
      // ── memory=false 的活体验证：不捕获新 raw、工具结构化禁用、prompt 为空 ──
      const offSession = ctx.sessions?.create?.();
      const offSessionId = String(offSession?.id ?? `selftest-memory-off-${Date.now()}`);
      sessionConfig.set(offSessionId, { memoryEnabled: false, personaEnabled: false });
      // 先等"会话创建时点"的 backfill/header 落盘（它发生在设置开关之前，按当时策略走）
      await sleep(300);
      await manager.flushAll();
      const rawBeforeOff = shared.store.listRawIndex({ limit: 1 }).total;
      try {
        offSession?.append('turn/start', { turn: 1 });
      } catch {
        /* 宿主不支持 append 时跳过捕获断言 */
      }
      await sleep(300);
      await manager.flushAll();
      const rawAfterOff = shared.store.listRawIndex({ limit: 1 }).total;
      const offContext = await toolContext({ sessionId: offSessionId });
      const blocked = (await handleTool(
        'memory_save',
        { text: '本会话已关闭记忆（不应落盘）', sessionId: offSessionId },
        offContext,
      )) as Record<string, unknown>;
      const blockedError = blocked.ok === false ? ((blocked.error as { code?: string } | undefined)?.code ?? null) : null;
      await refreshPrompt();
      const promptEmpty = (promptRegistration?.current() ?? '') === '';
      if (!(rawAfterOff === rawBeforeOff)) {
        throw new Error(`memory=false 仍新增 raw：${rawBeforeOff} -> ${rawAfterOff}（session=${offSessionId}）`);
      }
      if (blockedError !== 'E_MEMORY_DISABLED') {
        throw new Error(`memory=false 工具应返回 E_MEMORY_DISABLED，实际 ${JSON.stringify(blocked)?.slice(0, 300)}`);
      }
      if (!promptEmpty) {
        throw new Error(`memory=false 时应注入空 prompt（实际长度 ${(promptRegistration?.current() ?? '').length}）`);
      }
      sessionConfig.remove(offSessionId);
      await refreshPrompt();
      sessionConfig.remove(sessionId);
      const removed = sessionConfig.get(sessionId);
      return {
        ok: true,
        sessionId,
        defaults: {
          memory: before.memoryEnabled,
          persona: before.personaEnabled,
          personaId: before.personaId,
          isDefault: before.isDefault,
        },
        updated: { memory: updated.memoryEnabled, persona: updated.personaEnabled, personaId: updated.personaId },
        readback: {
          memory: readback.memoryEnabled,
          persona: readback.personaEnabled,
          personaId: readback.personaId,
          isDefault: readback.isDefault,
        },
        tool: { memory: toolResult.memory, persona: toolResult.persona, vault: toolResult.vault },
        offSessionId,
        memoryOffNoNewRaw: rawAfterOff === rawBeforeOff,
        memoryOffToolCode: blockedError,
        memoryOffPromptEmpty: promptEmpty,
        removedToDefault: removed.isDefault === true,
      };
    });

    // 6.2) v5：人格 CRUD（创建 → 列表可见 → 更新 → 删除到 .trash → roster 移除）
    await tool('personaCrud', async () => {
      if (!config.persona.enabled) return { skipped: true, reason: 'persona.enabled=false' };
      const id = `selftest-crud-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const created = await personaAdmin.create({
        id,
        name: '自检CRUD人格',
        description: '自检临时人格（CRUD）',
        tags: ['selftest'],
        body: '你是自检 CRUD 人格，回答简洁。',
      });
      const listedAfterCreate = persona.list().some((definition) => definition.id === id && definition.valid);
      if (!listedAfterCreate) throw new Error(`创建后 roster 未见人格：${id}`);
      const updated = await personaAdmin.update(id, { name: '自检CRUD人格（改）', body: '你是自检 CRUD 人格（已编辑）。' });
      if (updated.persona.name !== '自检CRUD人格（改）') {
        throw new Error(`更新后名称不一致：${JSON.stringify(updated.persona)}`);
      }
      const deleted = await personaAdmin.remove(id);
      const trashFile = deleted.backupFile ?? null;
      const listedAfterDelete = persona.list().some((definition) => definition.id === id);
      if (listedAfterDelete) throw new Error(`删除后 roster 仍含人格：${id}`);
      if (!trashFile) throw new Error('删除未返回 .trash 备份路径');
      return {
        ok: true,
        id,
        created: created.created,
        listedAfterCreate,
        updated: updated.updated,
        deleted: deleted.deleted,
        backupFile: trashFile,
        trashDir: join(personaDir, '.trash'),
        removedFromRoster: !listedAfterDelete,
      };
    });

    // 6.3) v5：人格库隔离（A 库写一条 memory + raw → shared/B 均检索不到；清理并恢复 active=null）
    await tool('isolation', async () => {
      if (!config.persona.enabled) return { skipped: true, reason: 'persona.enabled=false' };
      const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const personaA = `selftest-iso-a-${stamp}`;
      const personaB = `selftest-iso-b-${stamp}`;
      const sessionId = String(ctx.sessions?.create?.()?.id ?? `selftest-iso-${stamp}`);
      const marker = `自检隔离记忆-${markerSafe(stamp)}`;
      try {
        await personaAdmin.create({ id: personaA, name: '自检隔离A', body: '你是自检隔离人格 A。' });
        await personaAdmin.create({ id: personaB, name: '自检隔离B', body: '你是自检隔离人格 B。' });
        const activation = await persona.activate(personaA);
        if (!activation.ok || activation.activeId !== personaA) {
          throw new Error(`激活隔离人格 A 失败：${JSON.stringify(activation)}`);
        }
        sessionConfig.set(sessionId, { memoryEnabled: true, personaEnabled: true, personaId: null });
        const bundleA = await manager.openVault(personaA);
        const bundleB = await manager.openVault(personaB);
        const contextA = await toolContext({ sessionId });
        const saved = (await handleTool(
          'memory_save',
          { text: `事实：${marker}`, kind: 'fact', pin: false, importance: 0.6, sessionId },
          contextA,
        )) as Record<string, unknown>;
        const rawId = typeof saved.rawId === 'string' ? saved.rawId : null;
        const memoryId = typeof saved.memoryId === 'string' ? saved.memoryId : null;
        if (!rawId || !memoryId) throw new Error(`隔离 fixture 保存失败：${JSON.stringify(saved)?.slice(0, 300)}`);
        await manager.flushAll();
        await drainRawVectors(bundleA);
        const rawIndexA = bundleA.store.listRawIndex({ limit: 10_000 });
        const memA = bundleA.store.listMemories({ limit: 1000 });
        const rawInA = rawIndexA.records.some((row) => row.id === rawId);
        const memoryInA = memA.some((row) => row.id === memoryId);
        if (!rawInA || !memoryInA) throw new Error('隔离 fixture 未写入 A 库');
        const containsMarker = (rows: Array<{ text?: string | null }>): boolean =>
          rows.some((row) => (row.text ?? '').includes(marker));
        const sharedRaw = shared.store.listRawIndex({ limit: 10_000 });
        const sharedMem = shared.store.listMemories({ limit: 5000 });
        const rawInShared = containsMarker(sharedRaw.records);
        const memoryInShared = containsMarker(sharedMem);
        const bRaw = bundleB.store.listRawIndex({ limit: 10_000 });
        const bMem = bundleB.store.listMemories({ limit: 5000 });
        const rawInB = containsMarker(bRaw.records);
        const memoryInB = containsMarker(bMem);
        // 直接检索也验证：A 命中，shared/B 不命中
        const recallA = await bundleA.recaller.recall({ text: marker, limit: 5, mode: 'explicit', trackAccess: false });
        const recallShared = await shared.recaller.recall({ text: marker, limit: 5, mode: 'explicit', trackAccess: false });
        const recallB = await bundleB.recaller.recall({ text: marker, limit: 5, mode: 'explicit', trackAccess: false });
        const recallHit = (hits: Array<{ raw?: { text?: string | null } | null }>): boolean =>
          hits.some((hit) => (hit.raw?.text ?? '').includes(marker));
        const recallVisibleToA = recallHit(recallA);
        const recallVisibleToShared = recallHit(recallShared);
        const recallVisibleToB = recallHit(recallB);
        const dirsDistinct =
          bundleA.dir !== bundleB.dir && bundleA.dir !== shared.dir && bundleB.dir !== shared.dir;
        const isolated =
          !rawInShared && !memoryInShared && !rawInB && !memoryInB && !recallVisibleToShared && !recallVisibleToB;
        if (!recallVisibleToA) throw new Error('A 库自身检索未命中隔离 fixture');
        if (!isolated) {
          throw new Error(
            `人格库隔离失败：rawInShared=${rawInShared} memoryInShared=${memoryInShared} rawInB=${rawInB} memoryInB=${memoryInB} recallShared=${recallVisibleToShared} recallB=${recallVisibleToB}`,
          );
        }
        return {
          ok: true,
          personaA,
          personaB,
          sessionId,
          marker,
          rawId,
          memoryId,
          vaultA: bundleA.dir,
          vaultB: bundleB.dir,
          sharedDir: shared.dir,
          dirsDistinct,
          rawInA,
          memoryInA,
          rawInShared,
          memoryInShared,
          rawInB,
          memoryInB,
          recallVisibleToA,
          recallVisibleToShared,
          recallVisibleToB,
          isolated,
          l0VerifyA: (await bundleA.vault.verify()).ok,
        };
      } finally {
        try {
          sessionConfig.remove(sessionId);
          await persona.activate(null);
          await personaAdmin.remove(personaA);
          await personaAdmin.remove(personaB);
          await manager.flushAll();
          await refreshPrompt();
        } catch (cleanupError) {
          logger.warn('isolation selftest cleanup failed', cleanupError);
        }
      }
    });

    // 6.3b) v6：会话原始隔离（segments/<day>/<sessionKey>/）+ 会话/整库 导入导出
    await tool('storage', async () => {
      const { sanitizeSessionKey } = await import('./vault/index.ts');
      const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const sessionId = `selftest-storage-${stamp}`;
      const saved = unwrapToolValue(await executeTool('memory_save', {
        text: `自检存储隔离 ${stamp}`,
        kind: 'fact',
        sessionId,
        pin: true,
      }));
      const rawId = typeof saved.rawId === 'string' ? saved.rawId : '';
      if (saved.ok !== true || rawId.length === 0) {
        throw new Error(`memory_save failed for storage selftest: ${JSON.stringify(saved).slice(0, 800)}`);
      }
      const resolved = await manager.resolveForSession(sessionId, { ignoreMemoryDisabled: true });
      const bundle = resolved.bundle;
      if (!bundle) throw new Error(`no bundle resolved for selftest session ${sessionId}`);
      const sessionKey = sanitizeSessionKey(sessionId);

      // (1) 当前会话的 raw 段文件必须落在 segments/<day>/<sessionKey>/
      const segmentList =
        (bundle.vault as unknown as { segmentList?: Array<{ segment: string; sessionId?: string | null }> })
          .segmentList ?? [];
      const sessionSegments = segmentList.filter((segment) => segment.sessionId === sessionId);
      const dirsOk =
        sessionSegments.length > 0 &&
        sessionSegments.every((segment) => {
          const parts = segment.segment.split('/');
          return parts.length === 4 && parts[0] === 'segments' && parts[2] === sessionKey;
        });
      let located = 0;
      let misplaced = 0;
      let foreign = 0;
      for await (const record of bundle.vault.iterate({ sessionId })) {
        located += 1;
        const segment = bundle.store.getRawIndex(record.id)?.segment ?? '';
        if (segment.split('/')[2] !== sessionKey) misplaced += 1;
        const entry = segmentList.find((candidate) => candidate.segment === segment);
        // 其它会话目录（sessionId 非本会话）不得包含本会话记录；v1 旧段（null）允许
        if (entry && entry.sessionId !== null && entry.sessionId !== sessionId) foreign += 1;
      }
      const sessionRawIsolation = {
        ok: dirsOk && located > 0 && misplaced === 0 && foreign === 0,
        dirsOk,
        sessionKey,
        segments: sessionSegments.length,
        located,
        misplaced,
        foreign,
      };

      // (2) 导出会话 → 导入到同库新 session：raw 增加、原数据不变、importedFrom 映射正确
      const exported = unwrapToolValue(await executeTool('memory_export_session', {
        sessionId,
        includeMemories: true,
      }));
      if (exported.ok !== true || typeof exported.file !== 'string') {
        throw new Error(`memory_export_session failed: ${JSON.stringify(exported).slice(0, 800)}`);
      }
      const beforeRecords = (await bundle.vault.stats()).records;
      const imported = unwrapToolValue(await executeTool('memory_import_session', {
        path: exported.file,
        derive: false,
      }));
      const afterRecords = (await bundle.vault.stats()).records;
      const mapping = Array.isArray(imported.mapping) ? imported.mapping : [];
      const firstMap = mapping[0] as { from?: string; to?: string } | undefined;
      const originalStillThere = (await bundle.vault.get(rawId)) !== null;
      const importedRecord = firstMap?.to ? await bundle.vault.get(firstMap.to) : null;
      const importedPayload = (importedRecord?.payload ?? null) as
        | { importedFrom?: unknown; originalSessionId?: unknown }
        | null;
      const importedFromOk =
        importedPayload?.importedFrom === firstMap?.from && importedPayload?.originalSessionId === sessionId;
      const exportImportSession = {
        ok:
          exported.ok === true &&
          imported.ok === true &&
          typeof exported.rawCount === 'number' &&
          exported.rawCount > 0 &&
          afterRecords > beforeRecords &&
          originalStillThere &&
          importedFromOk,
        exportedRaw: exported.rawCount,
        exportedBytes: exported.bytes,
        exportedSha256: exported.sha256,
        file: exported.file,
        newSessionId: imported.newSessionId,
        mappingSize: imported.mappingCount,
        rawDelta: afterRecords - beforeRecords,
        originalStillThere,
        importedFromOk,
        sourceIntact: firstMap?.from === rawId,
      };

      // (3) 导出整库 → 导入为新库 id：可打开、raw/memory 计数一致
      const exportedVault = unwrapToolValue(await executeTool('memory_export_vault', {}));
      const targetId = `selftest-imp-${stamp.replace(/[^A-Za-z0-9._-]/g, '-')}`.slice(0, 64);
      const importedVault = unwrapToolValue(await executeTool('memory_import_vault', {
        path: exportedVault.dir,
        vault: targetId,
      }));
      const countsMatch =
        importedVault.ok === true &&
        importedVault.rawCount === exportedVault.rawCount &&
        importedVault.memoryCount === exportedVault.memoryCount;
      // 自检自建的库目录：断言后清理，避免污染 /vaults 列表（不触碰用户已有库）
      try {
        const { rmSync } = await import('node:fs');
        rmSync(join(config.dataDir, 'vaults', targetId), { recursive: true, force: true });
      } catch {
        /* 清理失败不影响自检结论 */
      }
      const exportImportVault = {
        ok: exportedVault.ok === true && importedVault.ok === true && countsMatch,
        files: Array.isArray(exportedVault.files) ? exportedVault.files.length : 0,
        bytes: exportedVault.bytes,
        sha256: exportedVault.sha256,
        rawCount: exportedVault.rawCount,
        memoryCount: exportedVault.memoryCount,
        importedRaw: importedVault.rawCount,
        importedMemory: importedVault.memoryCount,
        importedSegments: importedVault.segments,
        countsMatch,
        targetId,
      };

      return {
        ok: sessionRawIsolation.ok && exportImportSession.ok && exportImportVault.ok,
        sessionRawIsolation,
        exportImportSession,
        exportImportVault,
      };
    });

    // 6.4) v5 汇总（供 QA/E2E 快速断言）
    steps.v5 = {
      ok: true,
      vaults: summarizeStep(steps.vaults),
      sessionConfig: summarizeStep(steps.sessionConfig),
      personaCrud: summarizeStep(steps.personaCrud),
      isolation: summarizeStep(steps.isolation),
      storageOk: (steps.storage as { ok?: unknown } | null)?.ok === true,
    };

    // 7) 统计摘要（共享库 + 各库）
    result.summary = {
      vaultRecords: (await vault.stats()).records,
      storage: store.storageStats(),
      layers: store.listLayers(),
      capture: queue.stats(),
      derive: health.deriveStats(),
      retention: await retention.stats(),
      vectors: store.rawVectorStats(),
      forgetting: await forgetting.stats(),
      persona: await health.personaHealth(),
      vaults: (await manager.statsAll().catch(() => [])).map((summary) => ({
        id: summary.id,
        name: summary.name,
        stats: summary.stats,
      })),
      session: (() => {
        const view = sessionConfig.get('');
        return { memory: view.memoryEnabled, persona: view.personaEnabled, personaId: view.personaId };
      })(),
    };
    result.ok = true;
    logger.info('selftest finished');
  } catch (error) {
    result.ok = false;
    result.error = error instanceof Error ? error.message : String(error);
    logger.error('selftest crashed', error);
  } finally {
    result.finishedAt = new Date().toISOString();
    writeJsonFile(join(deps.dataDir, 'selftest.json'), result);
  }
}

/** 自检临时标记的安全字符（避免特殊字符进入文件名/查询串） */
function markerSafe(input: string): string {
  return input.replace(/[^A-Za-z0-9._-]+/g, '-');
}

/** 只保留 v5 子步骤的关键布尔/统计字段（避免 selftest.json 过大） */
function summarizeStep(value: unknown): unknown {
  if (!value || typeof value !== 'object') return value ?? null;
  const record = value as Record<string, unknown>;
  const keepBoolean = ['ok', 'created', 'listedAfterCreate', 'updated', 'deleted', 'removedFromRoster', 'isolated', 'dirsDistinct', 'memoryOffNoNewRaw', 'memoryOffPromptEmpty'];
  const out: Record<string, unknown> = {};
  for (const key of keepBoolean) if (key in record) out[key] = record[key];
  for (const key of ['ids', 'vaults', 'defaults', 'updated', 'readback', 'tool', 'personaA', 'personaB', 'sessionId', 'offSessionId', 'memoryOffToolCode', 'vaultA', 'vaultB', 'sharedDir', 'rawId', 'memoryId']) {
    if (key in record) out[key] = record[key];
  }
  return out;
}

/** 工具执行结果摘要（避免自检文件过大；保证 JSON 可序列化且不因截断丢结构） */
function summarizeToolResult(value: unknown): unknown {
  try {
    const asRecord = value as Record<string, unknown> | null;
    if (asRecord && typeof asRecord === 'object' && 'ok' in asRecord) return asRecord;
    if (asRecord && typeof asRecord === 'object' && 'value' in asRecord) {
      const content = Array.isArray(asRecord.content) ? asRecord.content : [];
      const text = content
        .map((item) => (item && typeof item === 'object' && typeof (item as { text?: unknown }).text === 'string' ? String((item as { text: string }).text) : ''))
        .join('\n');
      return {
        isError: asRecord.isError === true,
        keys: Object.keys(asRecord),
        contentText: text.length > 2000 ? `${text.slice(0, 2000)}…` : text,
        value: asRecord.value,
      };
    }
    const json = JSON.stringify(value);
    return json.length <= 4000 ? JSON.parse(json) : { truncated: true, textPreview: json.slice(0, 2000) };
  } catch {
    return { text: String(value).slice(0, 2000) };
  }
}

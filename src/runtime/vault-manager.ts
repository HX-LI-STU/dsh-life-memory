// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hanxustu (dsh-life-memory)
/**
 * 运行时记忆库管理器（v5，docs/26 §2/§3/§7.3）。
 *
 * 职责：
 * - 初始化布局：`createVaultManager` + `migrateLegacy()`（旧根库 → `legacy-<ts>/`，vaults 从零）
 *   + `ensureLayout()` + **常开 shared bundle**；
 * - 按会话解析目标库：`memory=false` → 结构化禁用；`persona=false`/无激活人格 → shared；
 *   `persona=true` → 全局/会话指定人格库（懒打开、复用、必要时关闭最久未用）；
 * - 支持 `vault=` 显式库参数（HTTP 用）；
 * - 统一 tick/遗忘/回填/flush/dispose（遍历所有已打开库）。
 *
 * 并发口径（docs/26 §7.6）：全局激活人格唯一；同一人格库被多个会话同时写时按库串行
 * （每库独立 CaptureQueue + L0 writer lock）。
 */
import type {
  CaptureSink,
  Embedder,
  Logger,
  MemoryVaultConfig,
  PersonaRegistry,
} from '../core/contracts.ts';
import type { SessionConfigService, SessionConfigView } from '../session/index.ts';
import { applyPendingReset, createVaultManager, VAULT_ID_RE } from '../vaults/index.ts';
import type { LegacyMigrationResult, VaultLayout, VaultManager, VaultSummary } from '../vaults/index.ts';
import { SHARED_VAULT_ID } from '../vaults/index.ts';
import { createVaultBundle } from './vault-bundle.ts';
import type { VaultBundle } from './vault-bundle.ts';

/** 共享库展示名（UI/HTTP 契约） */
export const SHARED_VAULT_NAME = '共享记忆库';
/** 常开库上限（shared + 最多 7 个人格库；超出按 LRU 关闭） */
export const MAX_OPEN_BUNDLES = 8;

/** 会话路由（仅布局/配置，不含已打开 bundle） */
export interface SessionRouting {
  /** false = 本会话关闭记忆（工具结构化禁用、不捕获） */
  enabled: boolean;
  vaultId: string;
  isPersona: boolean;
  personaId: string | null;
  sessionId: string | null;
  sessionConfig: SessionConfigView;
  /** 解析说明（诊断；正常为 null） */
  reason: string | null;
}

/** 会话解析结果（含已打开 bundle；enabled=false 时 bundle 可能为 null） */
export interface ResolvedSessionVault extends SessionRouting {
  vaultName: string;
  bundle: VaultBundle | null;
}

/** 捕获路由（hooks 用；queue 为懒打开后 resolve 的队列） */
export interface CaptureRoute {
  enabled: boolean;
  vaultId: string;
  personaId: string | null;
  queue: Promise<CaptureSink | null>;
}

export interface RuntimeVaultManagerOptions {
  dataDir: string;
  config: MemoryVaultConfig;
  logger: Logger;
  personaRegistry: PersonaRegistry;
  sessionConfig: SessionConfigService;
  now?: () => number;
  /** 当前会话 id（prompt 工作记忆块用；同步追踪） */
  getSessionId?: () => string | null;
  /** 共享 embedder（缺省每库按配置创建/复用缓存实例） */
  embedder?: Embedder;
  /** 库数据变更回调（集成层刷新 system prompt 等） */
  onChanged?: (bundle: VaultBundle) => void;
  /** 单进程最多同时打开的库数（默认 MAX_OPEN_BUNDLES） */
  maxOpen?: number;
}

export interface RuntimeVaultManager {
  /** 布局 + 旧数据迁移 + 常开 shared bundle（幂等） */
  ensure(): Promise<LegacyMigrationResult & { sharedDir: string; dbPath: string }>;
  layout(): VaultLayout;
  listVaultIds(): string[];
  vaultDir(vaultId: string): string;
  /** 同步解析会话路由（捕获钩子/工具上下文用） */
  resolveRouting(
    sessionId: string | null | undefined,
    options?: { vault?: string | null; ignoreMemoryDisabled?: boolean },
  ): SessionRouting;
  /** 捕获路由：按会话返回目标库队列（memory=false → enabled:false） */
  captureRoute(sessionId: string): CaptureRoute;
  /** 异步解析会话运行库（必要时懒打开；memory=false 时 bundle=null） */
  resolveForSession(
    sessionId: string | null | undefined,
    options?: { vault?: string | null; ignoreMemoryDisabled?: boolean },
  ): Promise<ResolvedSessionVault>;
  openVault(vaultId: string): Promise<VaultBundle>;
  bundleOf(vaultId: string): VaultBundle | null;
  allOpen(): VaultBundle[];
  /** 库展示名（shared → 共享记忆库；人格 → 定义 name 或 id） */
  vaultName(vaultId: string): string;
  /** 各库摘要（打开中的库带 lastUpdatedAt；其余为 null） */
  statsAll(): Promise<VaultSummary[]>;
  /** 当前会话/全局默认库 id（shared 或激活人格） */
  activeVaultId(): string;
  flushAll(): Promise<void>;
  /** 所有已打开的库各跑一次保留期 tick（防抖合并由 bundle 内部处理） */
  markDirtyTick(): void;
  runRetentionTickAll(at?: number): Promise<void>;
  runForgettingAll(at?: number): Promise<void>;
  runRawVectorBackfillAll(): Promise<void>;
  runDerivationAll(reason: 'timer' | 'session_end'): Promise<void>;
  getActivePersonaId(): string | null;
  setActivePersonaId(personaId: string | null, at?: number): void;
  readonly sessionConfig: SessionConfigService;
  legacyDir(): string | null;
  dispose(): Promise<void>;
}

function normalizeSessionId(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function isValidVaultId(value: string): boolean {
  return value === SHARED_VAULT_ID || VAULT_ID_RE.test(value);
}

export function createRuntimeVaultManager(options: RuntimeVaultManagerOptions): RuntimeVaultManager {
  const { dataDir, config, logger, personaRegistry, sessionConfig } = options;
  const now = options.now ?? (() => Date.now());
  const maxOpen = Math.max(2, options.maxOpen ?? MAX_OPEN_BUNDLES);

  const vaultManager: VaultManager = createVaultManager({
    dataDir,
    config,
    logger,
    now,
    listPersonaIds: () => personaRegistry.list().map((definition) => definition.id),
    personaNameOf: (id) => personaRegistry.get(id)?.name ?? null,
  });

  const bundles = new Map<string, VaultBundle>();
  const opening = new Map<string, Promise<VaultBundle>>();
  const lastUsed = new Map<string, number>();
  let disposed = false;
  let migration: LegacyMigrationResult | null = null;

  const touch = (vaultId: string): void => {
    lastUsed.set(vaultId, now());
  };

  const vaultNameOf = (vaultId: string): string => {
    if (vaultId === SHARED_VAULT_ID) return SHARED_VAULT_NAME;
    return personaRegistry.get(vaultId)?.name ?? vaultId;
  };

  const personaIdOf = (vaultId: string): string | null => (vaultId === SHARED_VAULT_ID ? null : vaultId);

  const resolvePersonaForSession = (view: SessionConfigView): { personaId: string | null; reason: string | null } => {
    if (!config.persona.enabled) return { personaId: null, reason: 'persona disabled' };
    if (!view.personaEnabled) return { personaId: null, reason: null };
    // 1) 会话显式指定的人格（必须仍存在且有效）
    if (view.personaId) {
      const definition = personaRegistry.get(view.personaId);
      if (definition && definition.valid) return { personaId: definition.id, reason: null };
    }
    // 2) 全局激活人格
    const active = vaultManager.getActivePersonaId();
    if (active) {
      const definition = personaRegistry.get(active);
      if (definition && definition.valid) return { personaId: definition.id, reason: null };
      return { personaId: null, reason: `active persona unavailable: ${active}` };
    }
    // 3) persona=true 但无激活人格 → 共享库
    return { personaId: null, reason: null };
  };

  const resolveRouting: RuntimeVaultManager['resolveRouting'] = (sessionIdInput, routeOptions = {}) => {
    const sessionId = normalizeSessionId(sessionIdInput);
    const view = sessionConfig.get(sessionId ?? '');
    const explicitVault =
      typeof routeOptions.vault === 'string' && routeOptions.vault.trim().length > 0 ? routeOptions.vault.trim() : null;
    if (explicitVault) {
      if (!isValidVaultId(explicitVault)) {
        return {
          enabled: view.memoryEnabled || routeOptions.ignoreMemoryDisabled === true,
          vaultId: SHARED_VAULT_ID,
          isPersona: false,
          personaId: null,
          sessionId,
          sessionConfig: view,
          reason: `invalid vault id: ${explicitVault}`,
        };
      }
      return {
        enabled: view.memoryEnabled || routeOptions.ignoreMemoryDisabled === true,
        vaultId: explicitVault,
        isPersona: explicitVault !== SHARED_VAULT_ID,
        personaId: personaIdOf(explicitVault),
        sessionId,
        sessionConfig: view,
        reason: null,
      };
    }
    if (!view.memoryEnabled && routeOptions.ignoreMemoryDisabled !== true) {
      return {
        enabled: false,
        vaultId: SHARED_VAULT_ID,
        isPersona: false,
        personaId: null,
        sessionId,
        sessionConfig: view,
        reason: '本会话已关闭记忆',
      };
    }
    const { personaId, reason } = resolvePersonaForSession(view);
    const vaultId = personaId ?? SHARED_VAULT_ID;
    return {
      enabled: view.memoryEnabled || routeOptions.ignoreMemoryDisabled === true,
      vaultId,
      isPersona: personaId !== null,
      personaId,
      sessionId,
      sessionConfig: view,
      reason,
    };
  };

  const evictIfNeeded = async (): Promise<void> => {
    while (bundles.size > maxOpen) {
      const activePersona = vaultManager.getActivePersonaId();
      const candidates = [...bundles.values()]
        .filter((bundle) => bundle.id !== SHARED_VAULT_ID && bundle.id !== activePersona)
        .sort((a, b) => (lastUsed.get(a.id) ?? 0) - (lastUsed.get(b.id) ?? 0));
      const victim = candidates[0];
      if (!victim) break;
      bundles.delete(victim.id);
      lastUsed.delete(victim.id);
      try {
        await victim.dispose();
        logger.info(`vault bundle evicted (LRU): ${victim.id}`);
      } catch (error) {
        logger.warn(`vault bundle eviction failed: ${victim.id}`, error);
      }
    }
  };

  const openVault = async (vaultId: string): Promise<VaultBundle> => {
    if (disposed) throw new Error('[dsh-life-memory] vault manager is disposed');
    if (!isValidVaultId(vaultId)) throw new TypeError(`[dsh-life-memory] invalid vault id: ${JSON.stringify(vaultId)}`);
    const existing = bundles.get(vaultId);
    if (existing && !existing.isClosed()) {
      touch(vaultId);
      return existing;
    }
    const pending = opening.get(vaultId);
    if (pending) return pending;
    const dir = vaultManager.resolveVaultDir(vaultId);
    const promise = createVaultBundle({
      dataDir: dir,
      config,
      logger,
      now,
      embedder: options.embedder,
      getSessionId: options.getSessionId,
      getPersonaById: (id) => personaRegistry.get(id) ?? null,
      getPersonaRoster: () => personaRegistry.list(),
      onChanged: options.onChanged,
    })
      .then(async (bundle) => {
        if (disposed) {
          await bundle.dispose();
          throw new Error('[dsh-life-memory] vault manager disposed during open');
        }
        // 启动对账：L0 是事实来源（补齐 append 与 raw_index 之间崩溃的缺口）
        try {
          const reconcile = await bundle.reconcile();
          if (reconcile.reconciled) {
            logger.info(`vault ${vaultId}: raw_index reconciled (${reconcile.indexed} records)`);
          }
        } catch (error) {
          logger.warn(`vault ${vaultId}: raw_index reconcile failed (L0 remains authoritative)`, error);
        }
        bundles.set(vaultId, bundle);
        touch(vaultId);
        await evictIfNeeded();
        return bundle;
      })
      .finally(() => {
        opening.delete(vaultId);
      });
    opening.set(vaultId, promise);
    return promise;
  };

  const resolveForSession: RuntimeVaultManager['resolveForSession'] = async (sessionId, routeOptions = {}) => {
    const routing = resolveRouting(sessionId, routeOptions);
    if (!routing.enabled) {
      return { ...routing, vaultName: vaultNameOf(routing.vaultId), bundle: null };
    }
    const bundle = await openVault(routing.vaultId);
    return { ...routing, vaultName: vaultNameOf(routing.vaultId), bundle };
  };

  const captureRoute: RuntimeVaultManager['captureRoute'] = (sessionId) => {
    const routing = resolveRouting(sessionId);
    if (!routing.enabled) {
      return { enabled: false, vaultId: routing.vaultId, personaId: routing.personaId, queue: Promise.resolve(null) };
    }
    const queue = openVault(routing.vaultId)
      .then((bundle) => bundle.queue as CaptureSink)
      .catch((error) => {
        logger.warn(`capture route open failed (vault=${routing.vaultId})`, error);
        return null;
      });
    return { enabled: true, vaultId: routing.vaultId, personaId: routing.personaId, queue };
  };

  return {
    async ensure() {
      const reset = applyPendingReset(dataDir, { now });
      if (reset.applied) {
        logger.info(
          `pending reset applied: backed up ${reset.movedEntries.join(',') || '(none)'} -> ${reset.backupDir ?? '(unknown)'} (starting from empty)`,
        );
      }
      migration = vaultManager.migrateLegacy();
      vaultManager.ensureLayout();
      const shared = await openVault(SHARED_VAULT_ID);
      if (migration.migrated) {
        logger.info(`legacy vault migrated -> ${migration.legacyDir ?? '(unknown)'} (moved: ${migration.movedEntries.join(',') || 'none'})`);
      }
      return {
        ...migration,
        sharedDir: shared.dir,
        dbPath: shared.store.dbPath,
      };
    },
    layout: () => vaultManager.layout(),
    listVaultIds: () => vaultManager.listVaultIds(),
    vaultDir: (vaultId) => vaultManager.resolveVaultDir(vaultId),
    resolveRouting,
    captureRoute,
    resolveForSession,
    openVault,
    bundleOf: (vaultId) => bundles.get(vaultId) ?? null,
    allOpen: () => [...bundles.values()].filter((bundle) => !bundle.isClosed()),
    vaultName: (vaultId) => vaultNameOf(vaultId),
    async statsAll() {
      const summaries = await vaultManager.listVaults({ openStats: true });
      const result: VaultSummary[] = [];
      for (const summary of summaries) {
        const bundle = bundles.get(summary.id);
        if (!bundle || bundle.isClosed()) {
          result.push(summary);
          continue;
        }
        const stats = await bundle.stats().catch(() => null);
        result.push({
          ...summary,
          name: vaultNameOf(summary.id),
          stats: stats
            ? {
                rawRecords: stats.rawRecords,
                memoryCount: stats.memoryCount,
                activeMemoryCount: stats.activeMemoryCount,
                dbBytes: stats.dbBytes,
                segments: stats.segments,
                days: stats.days,
                lastUpdatedAt: stats.lastUpdatedAt,
              }
            : summary.stats,
        });
      }
      return result;
    },
    activeVaultId() {
      const active = vaultManager.getActivePersonaId();
      if (active && personaRegistry.get(active)?.valid) return active;
      return SHARED_VAULT_ID;
    },
    async flushAll() {
      await Promise.all(
        [...bundles.values()].map(async (bundle) => {
          try {
            await bundle.flush();
          } catch (error) {
            logger.warn(`flush failed (vault=${bundle.id})`, error);
          }
        }),
      );
    },
    markDirtyTick() {
      for (const bundle of bundles.values()) {
        if (!bundle.isClosed()) bundle.markRetentionDirty();
      }
    },
    async runRetentionTickAll(at) {
      for (const bundle of [...bundles.values()]) {
        if (!bundle.isClosed()) await bundle.runRetentionTick(at);
      }
    },
    async runForgettingAll(at) {
      for (const bundle of [...bundles.values()]) {
        if (!bundle.isClosed()) await bundle.runForgetting(at);
      }
    },
    async runRawVectorBackfillAll() {
      for (const bundle of [...bundles.values()]) {
        if (!bundle.isClosed()) await bundle.rawVectors.backfill();
      }
    },
    async runDerivationAll(reason) {
      for (const bundle of [...bundles.values()]) {
        if (!bundle.isClosed()) await bundle.runDerivation({ reason });
      }
    },
    getActivePersonaId: () => vaultManager.getActivePersonaId(),
    setActivePersonaId: (personaId, at) => vaultManager.setActivePersonaId(personaId, at),
    sessionConfig,
    legacyDir: () => vaultManager.legacyDir(),
    async dispose() {
      if (disposed) return;
      disposed = true;
      const all = [...bundles.values()];
      bundles.clear();
      lastUsed.clear();
      await Promise.all(
        all.map(async (bundle) => {
          try {
            await bundle.dispose();
          } catch (error) {
            logger.warn(`vault bundle dispose failed (vault=${bundle.id})`, error);
          }
        }),
      );
    },
  };
}

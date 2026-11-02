// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hanxustu (dsh-life-memory)
/**
 * 运行时健康/状态汇总（memory_status 工具、HTTP /api/health|status、启动自检共用）。
 *
 * 只做读取与少量审计写入（integrity_runs）；不改变记忆内容。
 */
import type {
  CaptureStats,
  EmbeddingRef,
  ForgettingStats,
  LayerDefinition,
  MemoryStore,
  MemoryVaultConfig,
  PersonaHealth,
  RawVault,
  RawVectorStats,
  RetentionStats,
  VaultHealth,
  VerifyResult,
} from './core/contracts.ts';
import type { Logger } from './core/contracts.ts';

export interface HealthReporterDeps {
  config: MemoryVaultConfig;
  vault: RawVault;
  store: MemoryStore;
  captureStats: () => CaptureStats;
  embedder: () => EmbeddingRef | null;
  layers: () => LayerDefinition[];
  logger: Logger;
  /**
   * 保留期分层统计提供者（通常是 RetentionEngine.stats；缺省时回退到 store.retentionStats()）。
   * 可选：不传也不会破坏既有调用方（健康报告里 retention 会是安全的零值）。
   */
  retention?: () => Promise<RetentionStats> | RetentionStats;
  /** 原始层向量索引统计提供者（缺省时回退 store.rawVectorStats(embedderRef)） */
  vectors?: () => RawVectorStats | Promise<RawVectorStats>;
  /** 遗忘统计提供者（缺省时回退 store.forgettingStats()） */
  forgetting?: () => ForgettingStats | Promise<ForgettingStats>;
  /** 人格健康状态提供者（通常是集成层从 registry+store 组装的 PersonaHealth） */
  persona?: () => Promise<PersonaHealth> | PersonaHealth;
  now?: () => number;
}

/** 安全零值（store/engine 尚未实现对应方法时退化使用） */
const EMPTY_RETENTION_STATS: RetentionStats = { short: 0, mid: 0, long: 0, pinned: 0, lastTickAt: null };
const EMPTY_RAW_VECTOR_STATS: RawVectorStats = { total: 0, embedded: 0, pending: 0, ref: null, lastBackfillAt: null };
const EMPTY_FORGETTING_STATS: ForgettingStats = { shortDeleted: 0, midArchived: 0, lastForgetAt: null };
const EMPTY_PERSONA_HEALTH: PersonaHealth = {
  enabled: false,
  activeId: null,
  activeName: null,
  definitions: [],
  memoryCounts: {},
  sharedCount: 0,
  lastError: null,
};

export class HealthReporter {
  readonly #deps: HealthReporterDeps;
  #startedAt: number;
  #lastError: string | null = null;
  #lastVerify: VerifyResult | null = null;
  #lastDeriveAt: number | null = null;
  #readonlyReason: string | null = null;

  constructor(deps: HealthReporterDeps) {
    this.#deps = deps;
    this.#startedAt = deps.now?.() ?? Date.now();
  }

  /** 记录最近一次错误（不记录原文；只记 message 截断） */
  setError(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    this.#lastError = message.length > 500 ? `${message.slice(0, 500)}…` : message;
    this.#deps.logger.error('vault runtime error', this.#lastError);
  }

  clearError(): void {
    this.#lastError = null;
  }

  /** 进入只读降级（完整性校验失败时） */
  setReadonly(reason: string): void {
    this.#readonlyReason = reason;
    this.setError(new Error(`readonly: ${reason}`));
  }

  get readonly(): boolean {
    return this.#readonlyReason !== null;
  }

  get lastVerify(): VerifyResult | null {
    return this.#lastVerify;
  }

  noteDerived(at?: number): void {
    this.#lastDeriveAt = at ?? this.#deps.now?.() ?? Date.now();
  }

  /** 派生水位/最近派生时间（memory_status / deriveStats） */
  deriveStats(): { cursors: Record<string, number>; pendingJobs: number; lastDeriveAt: number | null } {
    const cursors: Record<string, number> = {};
    for (const layer of this.#deps.layers()) {
      try {
        cursors[layer.id] = this.#deps.store.getDeriveCursor(layer.id);
      } catch {
        cursors[layer.id] = 0;
      }
    }
    return { cursors, pendingJobs: 0, lastDeriveAt: this.#lastDeriveAt };
  }

  /** 执行一次哈希链校验并写入 integrity_runs（不修改任何原始记录） */
  async runVerify(): Promise<VerifyResult> {
    const startedAt = this.#deps.now?.() ?? Date.now();
    try {
      const result = await this.#deps.vault.verify();
      this.#lastVerify = result;
      try {
        this.#deps.store.recordIntegrityRun({
          kind: 'raw_chain',
          startedAt,
          finishedAt: this.#deps.now?.() ?? Date.now(),
          recordsChecked: result.checked,
          segmentsChecked: (await this.#deps.vault.stats()).segments,
          ok: result.ok,
          details: result.error ? { error: result.error } : {},
        });
      } catch {
        /* 审计写入失败不影响校验结果 */
      }
      if (!result.ok) this.setReadonly(`hash chain broken at ${result.error?.id ?? '?'}`);
      return result;
    } catch (error) {
      this.setError(error);
      return { ok: false, checked: 0, error: { id: '?', seq: 0, reason: String(error) } };
    }
  }

  async health(): Promise<VaultHealth> {
    const [vaultStats, storage, retention, vectors, forgetting, persona] = await Promise.all([
      this.#deps.vault.stats(),
      Promise.resolve().then(() => this.#deps.store.storageStats()),
      this.retentionStats(),
      this.rawVectorStats(),
      this.forgettingStats(),
      this.personaHealth(),
    ]);
    return {
      ok: !this.readonly && this.#lastError === null ? true : !this.readonly,
      dataDir: this.#deps.config.dataDir,
      vault: vaultStats,
      storage,
      layers: this.#deps.store.listLayers(),
      capture: this.#deps.captureStats(),
      embedder: this.#deps.embedder() ?? { model: this.#deps.config.embedding.model, dim: this.#deps.config.embedding.dim, version: '1' },
      retention,
      vectors,
      forgetting,
      persona,
      lastDeriveAt: this.#lastDeriveAt,
      lastError: this.#lastError,
      verify: this.#lastVerify ?? undefined,
      uptimeMs: Math.max(0, (this.#deps.now?.() ?? Date.now()) - this.#startedAt),
    };
  }

  /** 保留期分层统计（provider 优先；任何失败都退化为零值，不影响健康接口可用性） */
  async retentionStats(): Promise<RetentionStats> {
    try {
      if (this.#deps.retention) {
        return { ...EMPTY_RETENTION_STATS, ...(await this.#deps.retention()) };
      }
      const stats = this.#deps.store.retentionStats();
      if (stats && typeof stats === 'object') return { ...EMPTY_RETENTION_STATS, ...stats };
    } catch (error) {
      this.#deps.logger.debug?.('retention stats unavailable', error);
    }
    return { ...EMPTY_RETENTION_STATS };
  }

  /** 原始层向量索引统计（provider 优先；缺省回退 store.rawVectorStats(embedderRef)） */
  async rawVectorStats(): Promise<RawVectorStats> {
    try {
      if (this.#deps.vectors) return { ...EMPTY_RAW_VECTOR_STATS, ...(await this.#deps.vectors()) };
      const embedder = this.#deps.embedder();
      const stats = embedder ? this.#deps.store.rawVectorStats(embedder) : this.#deps.store.rawVectorStats();
      if (stats && typeof stats === 'object') return { ...EMPTY_RAW_VECTOR_STATS, ...stats };
    } catch (error) {
      this.#deps.logger.debug?.('raw vector stats unavailable', error);
    }
    return { ...EMPTY_RAW_VECTOR_STATS };
  }

  /** 三层记忆遗忘统计 */
  async forgettingStats(): Promise<ForgettingStats> {
    try {
      if (this.#deps.forgetting) return { ...EMPTY_FORGETTING_STATS, ...(await this.#deps.forgetting()) };
      const stats = this.#deps.store.forgettingStats();
      if (stats && typeof stats === 'object') return { ...EMPTY_FORGETTING_STATS, ...stats };
    } catch (error) {
      this.#deps.logger.debug?.('forgetting stats unavailable', error);
    }
    return { ...EMPTY_FORGETTING_STATS };
  }

  /** 人格状态（provider 优先；缺省回退 store 的激活 id + 每人格记忆计数） */
  async personaHealth(): Promise<PersonaHealth> {
    try {
      if (this.#deps.persona) return { ...EMPTY_PERSONA_HEALTH, ...(await this.#deps.persona()) };
      if (this.#deps.config.persona?.enabled === false) return { ...EMPTY_PERSONA_HEALTH, enabled: false };
      const activeId = this.#deps.store.getActivePersonaId();
      const { counts, shared } = this.#deps.store.countMemoriesByPersona();
      return {
        enabled: true,
        activeId,
        activeName: activeId,
        definitions: [],
        memoryCounts: counts ?? {},
        sharedCount: Number(shared ?? 0),
        lastError: null,
      };
    } catch (error) {
      this.#deps.logger.debug?.('persona health unavailable', error);
    }
    return { ...EMPTY_PERSONA_HEALTH };
  }
}

/** 便捷工厂 */
export function createHealthReporter(deps: HealthReporterDeps): HealthReporter {
  return new HealthReporter(deps);
}

// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hanxustu (dsh-life-memory)
/**
 * DSH 会话事件 → 捕获队列（宿主无关适配层，docs/10 §3.3 / docs/20 §6）。
 *
 * 订阅：
 * - `session/created`：新会话 + 恢复/重启后的会话都会经过发布 → 补档
 *   （session.snapshotEvents() 已存在的事件，按 ingestKey 去重，不会重复落盘）。
 * - `session/event`：提交后的每一条持久事件（含未知扩展类型）→ 原样归档。
 * - `session/flush`：await 队列 drain + 落盘（durability checkpoint）。
 * - `session/disposed`：会话结束 → 触发一次 session_end 派生。
 *
 * 任何钩子错误都被捕获并记录，绝不影响宿主会话流程。
 */
import type { CaptureSink, DeriveReason, Logger, RawRecord } from '../core/contracts.ts';
import type { DshSessionEventLike, DshSessionHeaderLike, DshSessionLike } from './dsh-types.ts';
import { mapSessionEvent, mapSessionEvents, sessionHeaderToRawInput } from './mapper.ts';
import type { MapOptions } from './mapper.ts';
import type { MemoryVaultConfig } from '../core/contracts.ts';

/** Cordis Context 的最小子集 */
export interface SessionEventTargetLike {
  on(event: string, handler: (...args: never[]) => void, options?: { prepend?: boolean }): () => void;
}

/** DSH Session 的最小子集 */
export interface DshSessionObjectLike {
  readonly id: unknown;
  readonly header: DshSessionHeaderLike;
  snapshotEvents?(fromSeq?: number, toSeqExclusive?: number): readonly DshSessionEventLike[];
}

/**
 * 按会话解析出的目标库（v5）：`memory=false` 时 enabled=false（不捕获）；
 * `queue` 是懒打开后的队列 Promise（捕获钩子不阻塞事件处理）。
 */
export interface CaptureRouteLike {
  enabled: boolean;
  vaultId: string;
  personaId: string | null;
  queue: Promise<CaptureSink | null>;
}

export interface CaptureHooksDeps {
  /** 单库模式（v4/测试）：所有事件写入该队列（v5 用 getVaultForSession 覆盖） */
  queue?: CaptureSink;
  /** v5：按会话解析目标库（优先于 queue）；返回 null = 不捕获 */
  getVaultForSession?: (sessionId: string) => CaptureRouteLike | null;
  config: MemoryVaultConfig;
  logger: Logger;
  timezone: string;
  /** 派生触发（append 后 / 会话结束）；错误必须被内部吞掉 */
  derive?: (raws: RawRecord[], reason: DeriveReason, sessionId?: string) => void | Promise<void>;
  /**
   * 当前激活人格 id（v4）：在事件钩子**同步**调用取快照，随 RawRecordInput.personaId
   * 写入 raw_index（索引元数据；null=共享）。缺省 = 始终共享。
   */
  getPersonaId?: () => string | null;
  /** v5：flush 所有已打开库（缺省 = 单库 queue.flush） */
  flushSinks?: () => Promise<void>;
}

export interface CaptureHooksHandle {
  dispose(): void;
  /** 补档一个会话（session/created 处理逻辑；也可手动调用做历史导入） */
  backfillSession(session: DshSessionObjectLike): Promise<void>;
}

function toSessionLike(session: DshSessionObjectLike): DshSessionLike {
  return { id: String(session.id), header: session.header };
}

/** 构造映射选项 */
export function mapOptionsOf(config: MemoryVaultConfig, timezone: string): MapOptions {
  return { timezone, capture: config.capture };
}

/** 注册捕获钩子，返回聚合 disposer */
export function registerCaptureHooks(target: SessionEventTargetLike, deps: CaptureHooksDeps): CaptureHooksHandle {
  const { config, logger, timezone } = deps;
  const mapOptions = mapOptionsOf(config, timezone);
  const disposers: Array<() => void> = [];
  const backfilling = new Set<string>();

  /** 同步解析一个会话的目标库路由（v5）或回退单库（v4/测试） */
  const routeOf = (sessionId: string): CaptureRouteLike | null => {
    if (!deps.getVaultForSession) {
      return deps.queue ? { enabled: true, vaultId: 'shared', personaId: null, queue: Promise.resolve(deps.queue) } : null;
    }
    try {
      return deps.getVaultForSession(sessionId);
    } catch (error) {
      logger.warn(`capture route resolution failed for session ${sessionId}`, error);
      return null;
    }
  };

  const flushAll = async (): Promise<void> => {
    if (deps.flushSinks) return deps.flushSinks();
    if (deps.queue) return deps.queue.flush();
  };

  const runDerive = (raws: RawRecord[], reason: DeriveReason, sessionId?: string): void => {
    if (!deps.derive || raws.length === 0) {
      if (deps.derive && reason !== 'capture' && raws.length === 0) {
        void Promise.resolve(deps.derive([], reason, sessionId)).catch((error) => logger.warn('derive failed', error));
      }
      return;
    }
    try {
      void Promise.resolve(deps.derive(raws, reason, sessionId)).catch((error) => logger.warn('derive failed', error));
    } catch (error) {
      logger.warn('derive failed (sync)', error);
    }
  };

  const backfillSession = async (session: DshSessionObjectLike): Promise<void> => {
    const sessionLike = toSessionLike(session);
    const sessionId = sessionLike.id;
    if (backfilling.has(sessionId)) return;
    backfilling.add(sessionId);
    // 人格快照：补档发生在会话创建时，取当时的激活人格（同步、一次）
    const route = routeOf(sessionId);
    if (!route || route.enabled === false) {
      backfilling.delete(sessionId);
      return;
    }
    const personaId = route.personaId ?? deps.getPersonaId?.() ?? null;
    try {
      const headerInput = sessionHeaderToRawInput(sessionLike, { timezone, now: Date.now(), personaId });
      let events: readonly DshSessionEventLike[] = [];
      try {
        events = typeof session.snapshotEvents === 'function' ? session.snapshotEvents() : [];
      } catch (error) {
        logger.warn(`snapshotEvents failed for session ${sessionId}`, error);
      }
      const eventInputs = mapSessionEvents(sessionLike, events, { ...mapOptions, personaId });
      const inputs = [headerInput, ...eventInputs];
      const queue = await route.queue;
      if (!queue) {
        logger.warn(`capture queue unavailable for session ${sessionId} (vault=${route.vaultId})`);
        return;
      }
      const records = await queue.ingest(inputs, { reason: 'capture' });
      if (records.length > 0) {
        logger.info(`backfilled ${records.length} raw records for session ${sessionId}`);
        runDerive(records, 'capture', sessionId);
      }
    } catch (error) {
      logger.warn(`backfill failed for session ${sessionId}`, error);
    } finally {
      backfilling.delete(sessionId);
    }
  };

  const onCreated = (session: DshSessionObjectLike): void => {
    void backfillSession(session);
  };

  const onEvent = (session: DshSessionObjectLike, event: DshSessionEventLike): void => {
    try {
      const sessionLike = toSessionLike(session);
      // v5：路由与人格快照都必须在**同步**钩子内取（capture queue 异步 flush，避免开关/切换后错标）
      const route = routeOf(sessionLike.id);
      if (!route || route.enabled === false) return;
      const personaId = route.personaId ?? deps.getPersonaId?.() ?? null;
      const input = mapSessionEvent(sessionLike, event, { ...mapOptions, personaId });
      if (!input) return;
      void route.queue
        .then((queue) => queue?.ingest([input], { reason: 'capture' }))
        .then((records) => {
          if (records && records.length > 0) runDerive(records, 'capture', sessionLike.id);
        })
        .catch((error) => logger.warn('capture ingest failed', error));
    } catch (error) {
      logger.warn('capture hook failed', error);
    }
  };

  const onFlush = async (): Promise<void> => {
    try {
      await flushAll();
    } catch (error) {
      logger.warn('capture flush failed', error);
    }
  };

  const onDisposed = (session: DshSessionObjectLike): void => {
    try {
      void flushAll().catch((error) => logger.warn('flush on dispose failed', error));
      runDerive([], 'session_end', String(session.id));
    } catch (error) {
      logger.warn('dispose hook failed', error);
    }
  };

  const bind = (event: string, handler: (...args: never[]) => void): void => {
    try {
      disposers.push(target.on(event, handler));
    } catch (error) {
      logger.warn(`subscribe ${event} failed`, error);
    }
  };

  bind('session/created', onCreated as never);
  bind('session/event', onEvent as never);
  bind('session/flush', onFlush as never);
  bind('session/disposed', onDisposed as never);

  return {
    backfillSession,
    dispose: () => {
      for (const dispose of disposers.reverse()) {
        try {
          dispose();
        } catch {
          /* ignore */
        }
      }
    },
  };
}

// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hanxustu (dsh-life-memory)
/**
 * 会话级记忆/人格开关（v5，docs/26 §3）。
 *
 * - 默认值：memoryEnabled=true、personaEnabled=false、personaId=null（= 使用共享库）。
 * - 持久化：`<dataDir>/session-config.json`（原子写；JSON）。
 * - 纯本地文件实现，零外部依赖；Host 集成层通过 `createSessionConfigService` 使用。
 * - 并发/竞争：单进程内以内存 Map 为准；写回失败只记录 warning（下次写入重试）。
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Logger } from '../core/contracts.ts';

export interface SessionConfig {
  sessionId: string;
  /** 是否使用记忆库（false = 该会话不捕获、不注入、工具拒绝） */
  memoryEnabled: boolean;
  /** 是否启用激活人格（false = 使用共享库、不注入人格身份块） */
  personaEnabled: boolean;
  /** 指定人格 id（null = 使用全局激活人格；仅 personaEnabled=true 时生效） */
  personaId: string | null;
  /** 最近更新时间（epoch ms；默认值记录为 0） */
  updatedAt: number;
}

export type SessionConfigPatch = Partial<Pick<SessionConfig, 'memoryEnabled' | 'personaEnabled' | 'personaId'>>;

export interface SessionConfigView extends SessionConfig {
  /** true = 该会话没有显式配置，返回默认值 */
  isDefault: boolean;
}

export interface SessionConfigDefaults {
  memoryEnabled: boolean;
  personaEnabled: boolean;
  personaId: string | null;
}

export const DEFAULT_SESSION_CONFIG: SessionConfigDefaults = Object.freeze({
  memoryEnabled: true,
  personaEnabled: false,
  personaId: null,
});

export interface CreateSessionConfigServiceOptions {
  /** 配置文件名（通常是 `<dataDir>/session-config.json`） */
  filePath: string;
  logger?: Logger;
  now?: () => number;
  defaults?: Partial<SessionConfigDefaults>;
}

export interface SessionConfigService {
  /** 读取一个会话的配置（无显式配置时返回默认值 + isDefault:true） */
  get(sessionId: string): SessionConfigView;
  /** 更新一个会话的配置；返回最新值 */
  set(sessionId: string, patch: SessionConfigPatch): SessionConfigView;
  /** 显式删除会话配置（恢复默认） */
  remove(sessionId: string): boolean;
  /** 列出所有显式配置的会话 */
  list(): SessionConfig[];
  /** 全部配置（含默认值），用于诊断/状态展示 */
  snapshot(): { defaults: SessionConfigDefaults; sessions: SessionConfig[] };
  /** 落盘（通常无需手动调用；set/remove/flush 会自动写） */
  flush(): void;
  /** 读取"新会话默认"（持久化在 session-config.json 的 defaults 字段） */
  getDefaults(): SessionConfigDefaults;
  /** 更新"新会话默认"（新会话未显式配置时使用） */
  setDefaults(patch: Partial<SessionConfigDefaults>): SessionConfigDefaults;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toBool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function toPersonaId(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function createSessionConfigService(options: CreateSessionConfigServiceOptions): SessionConfigService {
  const { filePath, logger } = options;
  const now = options.now ?? (() => Date.now());
  const defaults: SessionConfigDefaults = {
    memoryEnabled: toBool(options.defaults?.memoryEnabled, DEFAULT_SESSION_CONFIG.memoryEnabled),
    personaEnabled: toBool(options.defaults?.personaEnabled, DEFAULT_SESSION_CONFIG.personaEnabled),
    personaId: toPersonaId(options.defaults?.personaId),
  };
  const sessions = new Map<string, SessionConfig>();
  let loaded = false;

  const warn = (message: string, error?: unknown): void => {
    try {
      logger?.warn?.(message, error);
    } catch {
      /* logger 失败不影响功能 */
    }
  };

  const readFile = (): void => {
    if (loaded) return;
    loaded = true;
    try {
      const text = readFileSync(filePath, 'utf8');
      const parsed: unknown = JSON.parse(text);
      // 文件内的 defaults 优先于构造参数（用户在面板里设置的"新会话默认"要跨重启保持）
      if (isRecord(parsed) && isRecord(parsed.defaults)) {
        defaults.memoryEnabled = toBool(parsed.defaults.memoryEnabled, defaults.memoryEnabled);
        defaults.personaEnabled = toBool(parsed.defaults.personaEnabled, defaults.personaEnabled);
        defaults.personaId = toPersonaId(parsed.defaults.personaId);
      }
      const rawSessions = isRecord(parsed) && isRecord(parsed.sessions) ? parsed.sessions : isRecord(parsed) ? parsed : {};
      for (const [sessionId, raw] of Object.entries(rawSessions)) {
        if (!isRecord(raw)) continue;
        sessions.set(sessionId, {
          sessionId,
          memoryEnabled: toBool(raw.memoryEnabled, defaults.memoryEnabled),
          personaEnabled: toBool(raw.personaEnabled, defaults.personaEnabled),
          personaId: toPersonaId(raw.personaId),
          updatedAt: typeof raw.updatedAt === 'number' && Number.isFinite(raw.updatedAt) ? raw.updatedAt : 0,
        });
      }
    } catch (error) {
      const code = (error as { code?: string } | null)?.code;
      if (code !== 'ENOENT') warn(`session-config: read failed (${filePath})`, error);
    }
  };

  const writeFile = (): void => {
    try {
      mkdirSync(dirname(filePath), { recursive: true });
      const payload = {
        version: 1,
        defaults,
        sessions: Object.fromEntries(
          [...sessions.entries()]
            .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
            .map(([sessionId, config]) => [sessionId, config]),
        ),
      };
      const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
      writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
      renameSync(tmp, filePath);
    } catch (error) {
      warn('session-config: write failed (in-memory state kept)', error);
    }
  };

  /** 人格开启 ⇒ 记忆强制开启（"打开人格后，记忆应该被强制打开"） */
  const normalizeForPersona = <T extends { memoryEnabled: boolean; personaEnabled: boolean }>(value: T): T => {
    if (value.personaEnabled && !value.memoryEnabled) return { ...value, memoryEnabled: true };
    return value;
  };

  const view = (sessionId: string): SessionConfigView => {
    readFile();
    const config = sessions.get(sessionId);
    if (!config) return normalizeForPersona({ sessionId, ...defaults, updatedAt: 0, isDefault: true });
    return normalizeForPersona({ ...config, isDefault: false });
  };

  return {
    get: view,
    set(sessionId, patch) {
      readFile();
      if (typeof sessionId !== 'string' || sessionId.trim().length === 0) {
        throw new TypeError('[dsh-life-memory] session-config: sessionId must be a non-empty string');
      }
      const previous = view(sessionId);
      const next: SessionConfig = {
        sessionId,
        memoryEnabled: patch?.memoryEnabled === undefined ? previous.memoryEnabled : patch.memoryEnabled === true,
        personaEnabled: patch?.personaEnabled === undefined ? previous.personaEnabled : patch.personaEnabled === true,
        personaId: patch?.personaId === undefined ? previous.personaId : toPersonaId(patch.personaId),
        updatedAt: now(),
      };
      // 人格开启 ⇒ 记忆强制开启（即使本次 patch 显式传了 memoryEnabled=false）
      if (next.personaEnabled) next.memoryEnabled = true;
      sessions.set(sessionId, next);
      writeFile();
      return { ...next, isDefault: false };
    },
    remove(sessionId) {
      readFile();
      const removed = sessions.delete(sessionId);
      if (removed) writeFile();
      return removed;
    },
    list() {
      readFile();
      return [...sessions.values()].sort((a, b) => (a.sessionId < b.sessionId ? -1 : a.sessionId > b.sessionId ? 1 : 0));
    },
    snapshot() {
      readFile();
      return { defaults, sessions: [...sessions.values()] };
    },
    flush() {
      readFile();
      writeFile();
    },
    getDefaults() {
      readFile();
      return { ...defaults };
    },
    setDefaults(patch) {
      readFile();
      if (patch?.memoryEnabled !== undefined) defaults.memoryEnabled = patch.memoryEnabled === true;
      if (patch?.personaEnabled !== undefined) defaults.personaEnabled = patch.personaEnabled === true;
      if (patch?.personaId !== undefined) defaults.personaId = toPersonaId(patch.personaId);
      // 人格开启 ⇒ 记忆强制开启
      if (defaults.personaEnabled) defaults.memoryEnabled = true;
      writeFile();
      return { ...defaults };
    },
  };
}

/** 会话配置文件名约定：`<dataDir>/session-config.json` */
export function sessionConfigFilePath(dataDir: string): string {
  return join(dataDir, 'session-config.json');
}

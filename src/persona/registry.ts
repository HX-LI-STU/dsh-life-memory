// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hanxustu (dsh-life-memory)
/**
 * 人格注册表（docs/25-persona.md §3）：文件系统为源、启动加载、200ms 防抖热重载、
 * roster 快照、激活人格校验（激活状态由集成层持久化在 store meta，registry 通过
 * `getActiveId/setActiveId` 回调读写）。
 *
 * 关键语义：
 * - 目录不存在 → 视为空（不创建、不抛错，记 lastError 一次）；
 * - 只加载 `*.md` 普通文件（忽略点文件/子目录）；
 * - 无效文件同样进入 `list()`（`valid=false` + `invalidReason`）供 UI 展示，并汇总到 roster.errors；
 * - 重载后激活人格不存在/无效 → 自动清除激活（写入 null）并记 lastError；
 * - `dispose()` 关闭 watcher；测试可注入 watchFactory / debounceMs。
 */
import { readdirSync, readFileSync, watch as fsWatch } from 'node:fs';
import { join } from 'node:path';
import type {
  Logger,
  PersonaActivationResult,
  PersonaDefinition,
  PersonaLoadError,
  PersonaRegistry,
  PersonaRoster,
} from '../core/contracts.ts';
import { PERSONA_ID_RE, parsePersonaFile, toPersonaSummary } from './parser.ts';

/** 热重载防抖（docs/25 §3：200ms） */
export const PERSONA_WATCH_DEBOUNCE_MS = 200;

export interface PersonaWatcherLike {
  close(): void;
}

export interface PersonaRegistryOptions {
  /** 人格定义目录 */
  dir: string;
  config: { watch: boolean; maxBodyChars: number };
  logger: Logger;
  /** 时钟注入（测试）；默认 Date.now */
  now?: () => number;
  /** 读取当前激活人格 id（集成层从 store meta 读） */
  getActiveId?: () => string | null;
  /** 持久化激活人格 id（集成层写 store meta + L0 note）；null = 清除 */
  setActiveId?: (personaId: string | null, now?: number) => void;
  /** 测试注入：目录监听工厂；返回 null 表示不监听 */
  watchFactory?: (dir: string, listener: () => void) => PersonaWatcherLike | null;
  /** 测试注入：热重载防抖（ms；默认 200） */
  debounceMs?: number;
  /** 每次 reload 完成后回调（集成层用于归档人格定义 + 刷新 prompt）；异常被隔离 */
  onReloaded?: (roster: PersonaRoster) => void;
}

interface RegistryState {
  definitions: PersonaDefinition[];
  errors: PersonaLoadError[];
  loadedAt: number;
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

function comparePersona(a: PersonaDefinition, b: PersonaDefinition): number {
  if (a.name !== b.name) return a.name < b.name ? -1 : 1;
  if (a.id === b.id) return 0;
  return a.id < b.id ? -1 : 1;
}

/** 创建人格注册表（构造时不自动 reload；集成层调用 reload() 或由 watch 触发） */
export function createPersonaRegistry(options: PersonaRegistryOptions): PersonaRegistry {
  const { dir, config, logger } = options;
  const clock = options.now ?? (() => Date.now());
  const debounceMs =
    typeof options.debounceMs === 'number' && Number.isFinite(options.debounceMs) && options.debounceMs >= 0
      ? options.debounceMs
      : PERSONA_WATCH_DEBOUNCE_MS;
  const maxBodyChars =
    typeof config.maxBodyChars === 'number' && Number.isFinite(config.maxBodyChars) && config.maxBodyChars > 0
      ? config.maxBodyChars
      : 20_000;

  let state: RegistryState = { definitions: [], errors: [], loadedAt: 0 };
  let internalActiveId: string | null = null;
  let lastErrorMsg: string | null = null;
  let watcher: PersonaWatcherLike | null = null;
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;

  function readActiveId(): string | null {
    if (options.getActiveId) {
      try {
        const value = options.getActiveId();
        return typeof value === 'string' && value.length > 0 ? value : null;
      } catch (err) {
        lastErrorMsg = `read active persona failed: ${errorMessage(err)}`;
        logger.warn(`persona: ${lastErrorMsg}`);
        return internalActiveId;
      }
    }
    return internalActiveId;
  }

  function writeActiveId(personaId: string | null, now: number = clock()): void {
    internalActiveId = personaId;
    if (!options.setActiveId) return;
    try {
      options.setActiveId(personaId, now);
    } catch (err) {
      lastErrorMsg = `persist active persona failed: ${errorMessage(err)}`;
      logger.warn(`persona: ${lastErrorMsg}`);
    }
  }

  function resolvePersona(input: string): PersonaDefinition | null {
    const trimmed = input.trim();
    if (trimmed.length === 0) return null;
    const exact = state.definitions.find((definition) => definition.id === trimmed);
    if (exact) return exact;
    const lowered = trimmed.toLowerCase();
    return (
      state.definitions.find((definition) => definition.name.toLowerCase() === lowered) ??
      state.definitions.find((definition) => definition.aliases.some((alias) => alias.toLowerCase() === lowered)) ??
      null
    );
  }

  function activeDefinition(): PersonaDefinition | null {
    const activeId = readActiveId();
    if (activeId === null) return null;
    const definition = state.definitions.find((item) => item.id === activeId);
    return definition && definition.valid ? definition : null;
  }

  async function reload(): Promise<PersonaRoster> {
    const loadedAt = clock();
    const definitions: PersonaDefinition[] = [];
    const errors: PersonaLoadError[] = [];
    let loadError: string | null = null;

    let entries: Array<{ name: string; isFile(): boolean }> = [];
    try {
      entries = readdirSync(dir, { withFileTypes: true }) as unknown as Array<{ name: string; isFile(): boolean }>;
    } catch (err) {
      const message = errorMessage(err);
      // 目录不存在视为空（不创建、不抛错）；其它错误同样记录但不阻塞
      loadError = message.includes('ENOENT') ? `persona dir not found: ${dir}` : `read persona dir failed: ${message}`;
      logger.warn(`persona.reload: ${loadError}`);
      state = { definitions: [], errors: [], loadedAt };
      lastErrorMsg = loadError;
      return roster();
    }

    const files = entries
      .filter((entry) => entry.isFile() && entry.name.endsWith('.md') && !entry.name.startsWith('.'))
      .map((entry) => entry.name)
      .sort();
    for (const fileName of files) {
      const filePath = join(dir, fileName);
      let content: string;
      try {
        content = readFileSync(filePath, 'utf8');
      } catch (err) {
        const reason = `read failed: ${errorMessage(err)}`;
        errors.push({ file: filePath, reason });
        loadError = reason;
        continue;
      }
      const parsed = parsePersonaFile({ filePath, content, maxBodyChars, now: loadedAt });
      if (!PERSONA_ID_RE.test(parsed.definition.id)) {
        // 非法文件名：不加载（仅记录 error）
        const reason = `invalid persona id (filename): ${parsed.definition.id}`;
        errors.push({ file: filePath, reason });
        loadError = reason;
        logger.warn(`persona.reload: ${filePath} ${reason}`);
        continue;
      }
      definitions.push(parsed.definition);
      if (parsed.error) {
        errors.push(parsed.error);
        loadError = parsed.error.reason;
        logger.warn(`persona.reload: ${filePath} ${parsed.error.reason}`);
      }
    }

    definitions.sort(comparePersona);
    state = { definitions, errors, loadedAt };

    // 激活状态校验：重载后不存在/无效 → 自动清除激活
    const activeId = readActiveId();
    if (activeId !== null) {
      const activeDef = definitions.find((item) => item.id === activeId);
      if (!activeDef || !activeDef.valid) {
        const reason = activeDef
          ? `active persona "${activeId}" is invalid: ${activeDef.invalidReason ?? 'unknown'}`
          : `active persona "${activeId}" not found after reload`;
        writeActiveId(null, loadedAt);
        loadError = reason;
        logger.warn(`persona.reload: ${reason}`);
      }
    }

    lastErrorMsg = loadError;
    const snapshot = roster();
    if (options.onReloaded) {
      try {
        options.onReloaded(snapshot);
      } catch (error) {
        logger.warn('persona.onReloaded failed', error);
      }
    }
    return snapshot;
  }

  function roster(): PersonaRoster {
    const definitions = [...state.definitions];
    return {
      definitions,
      errors: [...state.errors],
      activeId: activeDefinition()?.id ?? null,
      loadedAt: state.loadedAt,
    };
  }

  async function activate(input: string | null, activateOptions: { now?: number } = {}): Promise<PersonaActivationResult> {
    const now = Number.isFinite(activateOptions.now) ? (activateOptions.now as number) : clock();
    const current = activeDefinition();
    if (input === null) {
      writeActiveId(null, now);
      lastErrorMsg = null;
      return { ok: true, activeId: null, persona: null };
    }
    const resolved = resolvePersona(input);
    if (!resolved) {
      return {
        ok: false,
        activeId: current?.id ?? null,
        persona: current ? toPersonaSummary(current) : null,
        error: `persona not found: ${input}`,
      };
    }
    if (!resolved.valid) {
      return {
        ok: false,
        activeId: current?.id ?? null,
        persona: current ? toPersonaSummary(current) : null,
        error: `persona is invalid: ${resolved.invalidReason ?? 'unknown'}`,
      };
    }
    writeActiveId(resolved.id, now);
    lastErrorMsg = null;
    logger.info(`persona: activate ${resolved.id} (${resolved.name})`);
    return { ok: true, activeId: resolved.id, persona: toPersonaSummary(resolved) };
  }

  function scheduleReload(): void {
    if (disposed) return;
    if (debounceTimer !== null) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      if (disposed) return;
      void reload().catch((err) => {
        lastErrorMsg = `watch reload failed: ${errorMessage(err)}`;
        logger.warn(`persona.watch: ${lastErrorMsg}`);
      });
    }, debounceMs);
    // 不阻塞进程退出
    (debounceTimer as unknown as { unref?: () => void }).unref?.();
  }

  if (config.watch) {
    try {
      const factory =
        options.watchFactory ??
        ((watchDir: string, listener: () => void): PersonaWatcherLike | null => {
          try {
            return fsWatch(watchDir, { persistent: false }, () => listener());
          } catch (err) {
            const message = errorMessage(err);
            lastErrorMsg = message.includes('ENOENT')
              ? `persona dir not found (watch skipped): ${watchDir}`
              : `persona watch failed: ${message}`;
            logger.warn(`persona.watch: ${lastErrorMsg}`);
            return null;
          }
        });
      watcher = factory(dir, scheduleReload);
    } catch (err) {
      lastErrorMsg = `persona watch failed: ${errorMessage(err)}`;
      logger.warn(`persona.watch: ${lastErrorMsg}`);
    }
  }

  return {
    roster,
    list: () => [...state.definitions],
    get: (id: string) => state.definitions.find((definition) => definition.id === id),
    active: activeDefinition,
    activate,
    reload,
    lastError: () => lastErrorMsg,
    dispose: () => {
      disposed = true;
      if (debounceTimer !== null) {
        clearTimeout(debounceTimer);
        debounceTimer = null;
      }
      if (watcher !== null) {
        try {
          watcher.close();
        } catch {
          /* watcher 关闭失败不影响主流程 */
        }
        watcher = null;
      }
    },
  };
}

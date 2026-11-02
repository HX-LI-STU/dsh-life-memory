// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hanxustu (dsh-life-memory)
/**
 * 多记忆库布局与管理（v5，docs/26 §2）。
 *
 * 每个记忆库 = 一个完全独立的目录：
 *   <dataDir>/vaults/shared/     共享库（无人格/关闭人格的会话）
 *   <dataDir>/vaults/<personaId>/ 人格库（人格之间互不可见，含原始 L0）
 * 每个库内部结构与 v4 完全一致（segments/manifest.json/VERSION/locks/vault.db）。
 *
 * 旧版（v4 及以前）数据在 <dataDir> 根下（segments、vault.db…）。
 * `migrateLegacy` 会把这些**旧根文件整体移到 legacy-<ts>/**（不删除、不再加载），
 * 然后创建 `vaults/` 布局；对应“清空重来”的迁移口径。
 *
 * 本模块只做布局/打开/统计，不承载捕获/检索运行时（由集成层按库创建 bundle）。
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Logger, MemoryVaultConfig } from '../core/contracts.ts';
import { openStore } from '../store/index.ts';
import { openVault } from '../vault/index.ts';

export const SHARED_VAULT_ID = 'shared';
/** 一次性清空标记：插件下次启动时把原始记忆/数据库整体备份后清空（从 0 开始） */
export const RESET_MARKER_FILE = '.reset-requested';
/** reset 时需要移走的"活动数据"条目（session-config/active-persona 等配置保留） */
const RESET_MOVED_ENTRIES = [
  'vaults',
  'exports',
  'segments',
  'vault.db',
  'vault.db-wal',
  'vault.db-shm',
  'manifest.json',
  'VERSION',
  'locks',
] as const;

export interface PendingResetResult {
  applied: boolean;
  backupDir: string | null;
  movedEntries: string[];
}

/** 是否存在待执行的清空请求 */
export function pendingResetRequested(dataDir: string): boolean {
  return existsSync(join(dataDir, RESET_MARKER_FILE));
}

/**
 * 执行待清空请求（幂等：标记不存在则 no-op）。
 * 把当前"原始记忆 + 数据库 + 导出副本"整体移动到 `<dataDir>/backup-cleared-<ts>/`
 * （**不删除任何数据**，备份后下次启动从空的 vaults/shared 开始）。
 * 保留：session-config.json / active-persona.json / legacy-* 历史归档。
 */
export function applyPendingReset(
  dataDir: string,
  options: { now?: () => number } = {},
): PendingResetResult {
  const marker = join(dataDir, RESET_MARKER_FILE);
  if (!existsSync(marker)) return { applied: false, backupDir: null, movedEntries: [] };
  const stamp = new Date((options.now ?? (() => Date.now()))()).toISOString().replace(/[:.]/g, '-');
  const backupDir = join(dataDir, `backup-cleared-${stamp}`);
  mkdirSync(backupDir, { recursive: true });
  const moved: string[] = [];
  for (const name of RESET_MOVED_ENTRIES) {
    const source = join(dataDir, name);
    if (!existsSync(source)) continue;
    renameSync(source, join(backupDir, name));
    moved.push(name);
  }
  try {
    writeFileSync(
      join(backupDir, 'RESET-README.txt'),
      [
        'dsh-life-memory 清空备份（从 0 开始）',
        `requestedAt: ${new Date(options.now ? options.now() : Date.now()).toISOString()}`,
        `moved: ${moved.join(', ') || '(none)'}`,
        '',
        '本目录是清空前自动保存的原数据（原始记忆 + 数据库 + 导出副本）。',
        '如需恢复：退出 DSH 后把这里的 vaults/ 等条目移回 life-memory 目录（先删除现有新库）。',
        '愿记忆长存。',
        '',
      ].join('\n'),
      'utf8',
    );
  } catch {
    /* 说明文件失败不影响备份结论 */
  }
  rmSync(marker, { force: true });
  return { applied: true, backupDir, movedEntries: moved };
}
export const VAULTS_DIR_NAME = 'vaults';
export const ACTIVE_PERSONA_FILE = 'active-persona.json';
export const LEGACY_PREFIX = 'legacy-';
/** persona id 规则（与 src/persona/parser.ts 的 PERSONA_ID_RE 保持一致） */
export const VAULT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** 旧根布局的判定文件（存在任一即视为 v4 根库） */
const LEGACY_ROOT_ENTRIES = ['segments', 'vault.db', 'manifest.json', 'VERSION', 'locks'] as const;

export interface VaultLayout {
  dataDir: string;
  vaultsDir: string;
  sharedDir: string;
  /** 已存在的库 id（含 shared；不重复） */
  ids: string[];
}

export interface VaultStats {
  rawRecords: number;
  memoryCount: number;
  activeMemoryCount: number;
  dbBytes: number;
  segments: number;
  days: number;
  lastUpdatedAt: number | null;
}

export interface VaultSummary {
  id: string;
  name: string;
  isPersona: boolean;
  isActive: boolean;
  dir: string;
  stats: VaultStats;
}

export interface VaultManagerOptions {
  /** 插件数据根目录（config.dataDir） */
  dataDir: string;
  config: MemoryVaultConfig;
  logger: Logger;
  now?: () => number;
  /** 由人格注册表提供的有效/全部人格 id（用于列表命名与过滤） */
  listPersonaIds?: () => string[];
  /** 读取人格展示名（id → name） */
  personaNameOf?: (id: string) => string | null;
}

export interface VaultManager {
  layout(): VaultLayout;
  /** 创建 `vaults/` 与 `vaults/shared/`（幂等） */
  ensureLayout(): VaultLayout;
  /** 把一个库 id 解析为绝对目录（不创建） */
  resolveVaultDir(vaultId: string): string;
  /** 列出已存在的库 id（shared 永远在首位，其余按 id 排序） */
  listVaultIds(): string[];
  /** 各库摘要（含统计；会临时打开/关闭每个库读取 stats） */
  listVaults(options?: { openStats?: boolean }): Promise<VaultSummary[]>;
  /** 读取全局激活人格 id（无则 null） */
  getActivePersonaId(): string | null;
  /** 写入全局激活人格 id（null 清除） */
  setActivePersonaId(personaId: string | null, now?: number): void;
  /** 旧根库 → legacy-<ts>/，并创建 vaults 布局；返回迁移结果 */
  migrateLegacy(options?: { now?: number }): LegacyMigrationResult;
  /** 已迁移的 legacy 目录（无则 null） */
  legacyDir(): string | null;
}

export interface LegacyMigrationResult {
  migrated: boolean;
  legacyDir: string | null;
  movedEntries: string[];
  layout: VaultLayout;
}

function isVaultId(value: string): boolean {
  return value === SHARED_VAULT_ID || VAULT_ID_RE.test(value);
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function readJsonFile<T>(file: string): T | null {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as T;
  } catch {
    return null;
  }
}

function writeFileAtomic(file: string, content: string): void {
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, content, 'utf8');
  renameSync(tmp, file);
}

/** 计算布局（不创建目录） */
export function resolveVaultLayout(dataDir: string): VaultLayout {
  const vaultsDir = join(dataDir, VAULTS_DIR_NAME);
  const sharedDir = join(vaultsDir, SHARED_VAULT_ID);
  const ids: string[] = [];
  if (isDirectory(vaultsDir)) {
    const entries = readdirSync(vaultsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && isVaultId(entry.name))
      .map((entry) => entry.name)
      .sort();
    if (entries.includes(SHARED_VAULT_ID)) {
      ids.push(SHARED_VAULT_ID);
    }
    for (const id of entries) if (id !== SHARED_VAULT_ID) ids.push(id);
  }
  return { dataDir, vaultsDir, sharedDir, ids };
}

/** 创建布局（幂等） */
export function ensureVaultLayout(dataDir: string): VaultLayout {
  const layout = resolveVaultLayout(dataDir);
  mkdirSync(layout.sharedDir, { recursive: true });
  return resolveVaultLayout(dataDir);
}

/** 一个库目录的绝对路径 */
export function resolveVaultDir(dataDir: string, vaultId: string): string {
  if (!isVaultId(vaultId)) {
    throw new TypeError(`[dsh-life-memory] invalid vault id: ${JSON.stringify(vaultId)}`);
  }
  return join(dataDir, VAULTS_DIR_NAME, vaultId);
}

/** 旧根布局是否存在（有 segments/vault.db/manifest/VERSION/locks 任一） */
export function hasLegacyRootVault(dataDir: string): boolean {
  return LEGACY_ROOT_ENTRIES.some((name) => existsSync(join(dataDir, name)));
}

/** 已存在的 legacy 目录（取字典序最后一个） */
export function findLegacyDirs(dataDir: string): string[] {
  try {
    return readdirSync(dataDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name.startsWith(LEGACY_PREFIX))
      .map((entry) => join(dataDir, entry.name))
      .sort();
  } catch {
    return [];
  }
}

/** 旧根库迁移（移动而非删除；幂等：已迁移过则直接返回 ensureLayout） */
export function migrateLegacyVault(
  dataDir: string,
  options: { now?: () => number } = {},
): LegacyMigrationResult {
  const clock = options.now ?? (() => Date.now());
  const layout = ensureVaultLayout(dataDir);
  if (!hasLegacyRootVault(dataDir)) {
    return { migrated: false, legacyDir: null, movedEntries: [], layout };
  }
  const stamp = new Date(clock()).toISOString().replace(/[:.]/g, '-');
  const legacyDir = join(dataDir, `${LEGACY_PREFIX}${stamp}`);
  mkdirSync(legacyDir, { recursive: true });
  const movedEntries: string[] = [];
  for (const name of LEGACY_ROOT_ENTRIES) {
    const source = join(dataDir, name);
    if (!existsSync(source)) continue;
    const target = join(legacyDir, name);
    renameSync(source, target);
    movedEntries.push(name);
  }
  // 旧根库的附属文件（runtime-load/selftest 等诊断文件）留在根目录，不受影响。
  return { migrated: true, legacyDir, movedEntries, layout: resolveVaultLayout(dataDir) };
}

/** 创建 VaultManager */
export function createVaultManager(options: VaultManagerOptions): VaultManager {
  const { dataDir, config, logger } = options;
  const now = options.now ?? (() => Date.now());
  let activePersonaCache: string | null | undefined;

  const activePersonaFile = (): string => join(dataDir, ACTIVE_PERSONA_FILE);

  const readActivePersona = (): string | null => {
    try {
      const parsed = readJsonFile<{ personaId?: unknown }>(activePersonaFile());
      const raw = parsed?.personaId;
      return typeof raw === 'string' && raw.trim().length > 0 ? raw.trim() : null;
    } catch {
      return null;
    }
  };

  const legacyDirOf = (): string | null => {
    const dirs = findLegacyDirs(dataDir);
    return dirs.length > 0 ? (dirs[dirs.length - 1] as string) : null;
  };

  return {
    layout: () => resolveVaultLayout(dataDir),
    ensureLayout: () => ensureVaultLayout(dataDir),
    resolveVaultDir: (vaultId) => resolveVaultDir(dataDir, vaultId),
    listVaultIds: () => resolveVaultLayout(dataDir).ids,
    async listVaults(listOptions = {}): Promise<VaultSummary[]> {
      const ids = resolveVaultLayout(dataDir).ids;
      if (ids.length === 0) return [];
      const activePersonaId = readActivePersona();
      const personaIds = options.listPersonaIds?.() ?? [];
      const summaries: VaultSummary[] = [];
      for (const id of ids) {
        const dir = resolveVaultDir(dataDir, id);
        const isPersona = id !== SHARED_VAULT_ID;
        let stats: VaultStats = {
          rawRecords: 0,
          memoryCount: 0,
          activeMemoryCount: 0,
          dbBytes: 0,
          segments: 0,
          days: 0,
          lastUpdatedAt: null,
        };
        if (listOptions.openStats !== false) {
          let store: ReturnType<typeof openStore> | null = null;
          try {
            store = openStore({ dataDir: dir, timezone: config.timezone }, { logger });
            const storage = store.storageStats();
            stats = {
              rawRecords: storage.rawCount ?? 0,
              memoryCount: storage.memoryCount ?? 0,
              activeMemoryCount: storage.activeMemoryCount ?? 0,
              dbBytes: storage.dbBytes ?? 0,
              segments: storage.segmentCount ?? 0,
              days: 0,
              lastUpdatedAt: null,
            };
          } catch (error) {
            logger.warn(`vault-manager: stats failed for vault ${id}`, error);
          } finally {
            try {
              store?.close();
            } catch {
              /* ignore */
            }
          }
        }
        const displayName = isPersona ? (options.personaNameOf?.(id) ?? id) : '共享记忆库';
        summaries.push({
          id,
          name: displayName,
          isPersona,
          isActive: isPersona ? id === activePersonaId : activePersonaId === null,
          dir,
          stats,
        });
      }
      return summaries;
    },
    getActivePersonaId() {
      if (activePersonaCache === undefined) activePersonaCache = readActivePersona();
      return activePersonaCache;
    },
    setActivePersonaId(personaId, at = now()) {
      mkdirSync(dataDir, { recursive: true });
      const value = typeof personaId === 'string' && personaId.trim().length > 0 ? personaId.trim() : null;
      writeFileAtomic(
        activePersonaFile(),
        `${JSON.stringify({ personaId: value, updatedAt: at }, null, 2)}\n`,
      );
      activePersonaCache = value;
    },
    migrateLegacy(migrationOptions = {}) {
      const result = migrateLegacyVault(dataDir, {
        now: () => (typeof migrationOptions.now === 'number' ? (migrationOptions.now as number) : now()),
      });
      return result;
    },
    legacyDir: legacyDirOf,
  };
}

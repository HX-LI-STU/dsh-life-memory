// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hanxustu (dsh-life-memory)
/**
 * SQLite 连接初始化 + schema 迁移（docs/20 §7.2/§7.7，docs/21 migration 1，
 * docs/23-memory-models §5 migration 2：retention 保留期治理列）。
 *
 * 规则：
 *   - 每个连接打开后执行 §0 的连接级 PRAGMA（page_size 必须最先；user_version 除外）；
 *   - migration **只增不改**：`schema.ts` 的 MIGRATIONS 数组保存每个已发布 migration 的
 *     SQL 与 sha256；已发布 SQL 永不编辑，checksum 存 schema_migrations 用于检测手改；
 *   - 打开时按 version 顺序应用缺失 migration（v1 库 => 只跑 v2；新库 => v1+v2；
 *     已是 v2 => 仅校验，no-op）；整个迁移过程在**一个事务**内，失败整体回滚；
 *   - user_version 比本程序支持的新 => 拒绝打开（避免旧程序破坏新库）。
 */

import type { DatabaseSync } from 'node:sqlite';
import {
  CONNECTION_PRAGMAS,
  MIGRATIONS,
  STORE_APPLICATION_ID,
  STORE_SCHEMA_VERSION,
  type SchemaMigration,
} from './schema.ts';

/** 打开连接后的 PRAGMA 初始化结果（便于测试/日志） */
export interface ConnectionPragmaResult {
  journalMode: string;
  schemaVersion: number;
}

/**
 * 执行 docs/21-schema.sql §0 的连接级 PRAGMA。
 * - page_size 对已有库是 no-op（所以必须在建表前执行，顺序保持文档原序）；
 * - mmap_size 在部分平台/文件系统失败可静默降级（文档允许）；
 * - user_version 不在连接初始化阶段设置（由 migrate 在 DDL 成功后设置）。
 */
export function applyConnectionPragmas(db: DatabaseSync, options: { memory?: boolean } = {}): ConnectionPragmaResult {
  for (const pragma of CONNECTION_PRAGMAS) {
    if (/^\s*PRAGMA\s+user_version/i.test(pragma)) continue;
    try {
      db.exec(pragma);
    } catch (error) {
      // mmap 在部分平台/网络盘会失败：docs 允许静默降级；其它 PRAGMA 失败要暴露
      if (/mmap_size/i.test(pragma)) continue;
      throw new Error(
        `[dsh-life-memory] store: failed to apply ${pragma}: ${(error as Error).message}`,
      );
    }
  }
  // 确认 application_id 与 journal_mode
  const appId = db.prepare('PRAGMA application_id').get() as { application_id?: number } | undefined;
  if (appId?.application_id !== STORE_APPLICATION_ID) {
    db.exec(`PRAGMA application_id = ${STORE_APPLICATION_ID};`);
  }
  const journalRow = db.prepare('PRAGMA journal_mode').get() as { journal_mode?: string } | undefined;
  const journalMode = String(journalRow?.journal_mode ?? '');
  if (options.memory !== true && journalMode !== 'wal') {
    // 用整库共享目录（网盘/SMB）时 WAL 可能不可用：docs 明确不支持，直接失败而不是静默降级
    throw new Error(
      `[dsh-life-memory] store: journal_mode is "${journalMode}", expected "wal"; ` +
        'WAL is required (local disk only; network shares are unsupported, docs/20 §6.3)',
    );
  }
  return { journalMode, schemaVersion: readSchemaVersion(db) };
}

/** 读取 PRAGMA user_version */
export function readSchemaVersion(db: DatabaseSync): number {
  const row = db.prepare('PRAGMA user_version').get() as { user_version?: number } | undefined;
  const version = Number(row?.user_version ?? 0);
  return Number.isFinite(version) && version >= 0 ? Math.floor(version) : 0;
}

/** 迁移执行结果 */
export interface MigrateResult {
  /** 本次是否执行了迁移 */
  applied: boolean;
  fromVersion: number;
  toVersion: number;
  /** 本次实际应用的 migration 版本（升序） */
  appliedVersions: number[];
}

/** 校验已知 migration 版本连续从 1 到 target（防止 schema.ts 被改乱） */
function applicableMigrations(target: number): SchemaMigration[] {
  const known = [...MIGRATIONS].sort((a, b) => a.version - b.version);
  const applicable = known.filter((migration) => migration.version <= target);
  for (let i = 0; i < applicable.length; i += 1) {
    if (applicable[i].version !== i + 1) {
      throw new Error(
        `[dsh-life-memory] store: migration chain is not contiguous at v${i + 1} ` +
          `(found v${applicable[i].version}); schema.ts is corrupted`,
      );
    }
  }
  if (applicable.length !== target) {
    throw new Error(
      `[dsh-life-memory] store: missing migrations for target schema v${target} ` +
        `(have ${applicable.map((migration) => migration.version).join(',')})`,
    );
  }
  return applicable;
}

/**
 * 确保 schema 就绪（幂等）：
 *   - user_version=0 → 在单个事务内执行全部 migration（v1+v2…）；
 *   - user_version=1 → 只执行 v2；
 *   - user_version=target → 仅校验 checksum（no-op）；
 *   - user_version>target → 抛错。
 *
 * 旧库升级是**原地 ALTER**：migration 2 只加列/索引/视图，不重写既有行，
 * 旧数据保留且默认获得 `retention_tier='short'`、`retention_score=0`、`pinned=0`。
 */
export function ensureSchema(db: DatabaseSync, now: number = Date.now()): MigrateResult {
  const fromVersion = readSchemaVersion(db);
  if (fromVersion > STORE_SCHEMA_VERSION) {
    throw new Error(
      `[dsh-life-memory] store schema version ${fromVersion} is newer than this build supports ` +
        `(${STORE_SCHEMA_VERSION}); upgrade the plugin instead of opening it`,
    );
  }
  const applicable = applicableMigrations(STORE_SCHEMA_VERSION);
  if (fromVersion === STORE_SCHEMA_VERSION) {
    verifyMigrationChecksums(db);
    syncMetaSchemaVersion(db, now);
    return { applied: false, fromVersion, toVersion: fromVersion, appliedVersions: [] };
  }
  // 已有库：先校验旧 migration 账本再升级（检测手改历史 migration）
  if (fromVersion > 0) verifyMigrationChecksums(db);
  const pending = applicable.filter((migration) => migration.version > fromVersion);
  if (pending.length === 0) {
    return { applied: false, fromVersion, toVersion: fromVersion, appliedVersions: [] };
  }
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const migration of pending) {
      db.exec(migration.sql);
      db.prepare(
        'INSERT OR REPLACE INTO schema_migrations(version, applied_at, description, checksum) VALUES (?, ?, ?, ?)',
      ).run(migration.version, now, migration.description, migration.sha256);
    }
    db.exec(`PRAGMA user_version = ${STORE_SCHEMA_VERSION};`);
    db.prepare(
      "INSERT OR REPLACE INTO meta(key, value, updated_at) VALUES ('schema_version', ?, ?)",
    ).run(String(STORE_SCHEMA_VERSION), now);
    db.exec('COMMIT');
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch {
      /* ignore */
    }
    throw new Error(
      `[dsh-life-memory] store: migration from v${fromVersion} to v${STORE_SCHEMA_VERSION} failed: ` +
        `${(error as Error).message}; the database was left unchanged (transaction rolled back)`,
    );
  }
  verifyMigrationChecksums(db);
  return {
    applied: true,
    fromVersion,
    toVersion: STORE_SCHEMA_VERSION,
    appliedVersions: pending.map((migration) => migration.version),
  };
}

/**
 * 校验已发布 migration 的 checksum；缺失行/空 checksum 自动补写为当前值（不视为篡改），
 * 非空且不匹配则抛错（说明有人手改了历史 migration SQL）。
 */
export function verifyMigrationChecksums(db: DatabaseSync): void {
  let rows: Array<{ version: number; checksum: string }>;
  try {
    rows = db.prepare('SELECT version, checksum FROM schema_migrations ORDER BY version').all() as Array<{
      version: number;
      checksum: string;
    }>;
  } catch {
    return; // schema_migrations 不存在（视图不可读）时交由后续查询报错
  }
  const byVersion = new Map(rows.map((row) => [Number(row.version), String(row.checksum)]));
  for (const migration of MIGRATIONS) {
    const checksum = byVersion.get(migration.version);
    if (checksum === undefined) {
      // 账本缺行（例如手工按 docs SQL 建库）：补登记，不视为篡改
      db.prepare(
        'INSERT OR REPLACE INTO schema_migrations(version, applied_at, description, checksum) VALUES (?, ?, ?, ?)',
      ).run(migration.version, 0, migration.description, migration.sha256);
      continue;
    }
    if (checksum === '') {
      db.prepare('UPDATE schema_migrations SET checksum = ? WHERE version = ?').run(
        migration.sha256,
        migration.version,
      );
      continue;
    }
    if (checksum !== migration.sha256) {
      throw new Error(
        `[dsh-life-memory] store: migration ${migration.version} checksum mismatch — the migration SQL ` +
          'was edited. Never edit published migrations; add a new migration instead (docs/20 §7.7)',
      );
    }
  }
}

/** 让 meta.schema_version 与 PRAGMA user_version 保持一致 */
function syncMetaSchemaVersion(db: DatabaseSync, now: number): void {
  const current = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as
    | { value: string }
    | undefined;
  if (current === undefined || current.value !== String(STORE_SCHEMA_VERSION)) {
    db.prepare('INSERT OR REPLACE INTO meta(key, value, updated_at) VALUES (?, ?, ?)').run(
      'schema_version',
      String(STORE_SCHEMA_VERSION),
      now,
    );
  }
}

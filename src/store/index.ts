// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hanxustu (dsh-life-memory)
/**
 * SQLite 存储入口（稳定工厂，供 src/index.ts / src/layers/** 使用）。
 *
 * 用法：
 *   const store = openStore(config);                       // MemoryVaultConfig
 *   const store = openStore({ dataDir, timezone, embedding }, { logger, now });
 *   const store = openStore({ dataDir: ':memory:' });      // 测试用内存库
 *
 * 数据库文件固定为 `<dataDir>/vault.db`（docs/20 §5）。locks/writer.json、
 * segments/、manifest.json 由 vault 层管理；本模块只碰 vault.db。
 */

import { join } from 'node:path';

import type {
  EmbeddingConfig,
  EmbeddingRef,
  Logger,
  MemoryStore,
  MemoryVaultConfig,
} from '../core/contracts.ts';
import { silentLogger } from '../core/logger.ts';
import { LOCAL_HASH_DIM, LOCAL_HASH_MODEL, LOCAL_HASH_VERSION, resolveEmbeddingRef } from '../embed/ref.ts';
import { SqliteMemoryStore } from './sqlite-store.ts';

/** openStore 接受的输入：MemoryVaultConfig 或最小路径/配置对象 */
export interface OpenStoreInput {
  dataDir: string;
  timezone?: string;
  embedding?: EmbeddingConfig;
}

/** openStore 运行时选项（测试/集成可注入） */
export interface StoreRuntimeOptions {
  /** 日志器（默认静默） */
  logger?: Logger;
  /** 注入时钟（测试） */
  now?: () => number;
  /** 强制校验 sourceRawIds 存在于 raw_index（docs/20 §8.5） */
  strictProvenance?: boolean;
  /** 覆盖默认嵌入引用（测试/多模型场景） */
  embedding?: EmbeddingRef;
}

/**
 * 打开（必要时创建并迁移）SQLite 存储。
 * 同步 API（node:sqlite DatabaseSync），失败抛错。
 */
export function openStore(
  input: OpenStoreInput | MemoryVaultConfig,
  runtime: StoreRuntimeOptions = {},
): MemoryStore {
  if (typeof input !== 'object' || input === null) {
    throw new TypeError('[dsh-life-memory] openStore: input must be an object with dataDir');
  }
  const dataDir = (input as OpenStoreInput).dataDir;
  if (typeof dataDir !== 'string' || dataDir.length === 0) {
    throw new TypeError('[dsh-life-memory] openStore: input.dataDir must be a non-empty resolved path');
  }
  const embeddingConfig = (input as MemoryVaultConfig).embedding;
  const embedding: EmbeddingRef =
    runtime.embedding ??
    (embeddingConfig !== undefined
      ? resolveEmbeddingRef(embeddingConfig)
      : { model: LOCAL_HASH_MODEL, dim: LOCAL_HASH_DIM, version: LOCAL_HASH_VERSION });
  const provider = embeddingConfig?.provider ?? 'local';
  const dbPath = dataDir === ':memory:' ? ':memory:' : join(dataDir, 'vault.db');
  return new SqliteMemoryStore({
    dbPath,
    embedding,
    provider,
    timezone: (input as OpenStoreInput).timezone,
    logger: runtime.logger ?? silentLogger,
    now: runtime.now,
    strictProvenance: runtime.strictProvenance,
  });
}

export { SqliteMemoryStore, type SqliteStoreOptions } from './sqlite-store.ts';
export {
  CONNECTION_PRAGMAS,
  MIGRATION_2_DESCRIPTION,
  MIGRATION_2_SHA256,
  MIGRATION_2_SQL,
  MIGRATION_3_DESCRIPTION,
  MIGRATION_3_SHA256,
  MIGRATION_3_SQL,
  MIGRATION_4_DESCRIPTION,
  MIGRATION_4_SHA256,
  MIGRATION_4_SQL,
  MIGRATIONS,
  SCHEMA_V1_DESCRIPTION,
  SCHEMA_V1_DOC_SHA256,
  SCHEMA_V1_SHA256,
  SCHEMA_V1_SQL,
  STORE_APPLICATION_ID,
  STORE_SCHEMA_VERSION,
  USER_VERSION_PRAGMA,
  type SchemaMigration,
} from './schema.ts';
export {
  applyConnectionPragmas,
  ensureSchema,
  readSchemaVersion,
  verifyMigrationChecksums,
} from './migrations.ts';
export { lexicalScoreFromRank } from './sqlite-store.ts';
export {
  DEFAULT_HEAT_HALF_LIFE_DAYS,
  HEAT_HALF_LIFE_DAYS,
  blobToFloat32,
  computeHeat,
  float32ToBlob,
} from './store-utils.ts';

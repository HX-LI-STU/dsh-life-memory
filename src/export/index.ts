// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hanxustu (dsh-life-memory)
/**
 * 原始会话 / 原始数据库 导入导出模块入口（v6）。
 *
 * - `exportSessionArchive` / `importSessionArchive`：单会话 JSONL 归档（可读、可移植）
 * - `exportVaultArchive` / `importVaultArchive`：整库目录快照（字节级备份/迁移）
 *
 * 宿主无关、零外部依赖；工具层（src/tools/handlers.ts）与自检直接复用。
 */
export {
  IMPORT_SESSION_PREFIX,
  SESSION_ARCHIVE_FORMAT,
  SESSION_ARCHIVE_VERSION,
  SESSION_EXPORT_DIR,
  SessionArchiveError,
  VAULT_EXPORT_DIR,
  exportSessionArchive,
  exportVaultArchive,
  importSessionArchive,
  importVaultArchive,
  type ArchiveChainEntry,
  type ArchiveSegmentRef,
  type ExportSessionArchiveOptions,
  type ExportVaultArchiveOptions,
  type ExportedSessionArchive,
  type ExportedVaultArchive,
  type ImportSessionArchiveOptions,
  type ImportVaultArchiveOptions,
  type ImportedSessionArchive,
  type ImportedVaultArchive,
  type SessionArchiveHeader,
  type SessionArchiveMappingEntry,
  type VaultArchiveFile,
} from './session-archive.ts';
export { listTransferArchives } from './session-archive.ts';
export type { TransferArchiveEntry, TransferArchives } from './session-archive.ts';

// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hanxustu (dsh-life-memory)
/**
 * L0 原始记忆库（vault）模块入口。
 *
 * 对其它实现（capture/集成层/召回层）稳定导出：
 *   - `openRawVault(options, runtime)` / `openVault(input, runtime)`：打开 vault；
 *   - `RawVaultImpl`：实现 contracts.ts 的 `RawVault`；
 *   - 段文件名/哈希/行序列化辅助（fsck、集成层核对用）；
 *   - 布局常量（segments 目录、VERSION、manifest 路径等）。
 *
 * 稳定工厂：`openStore` 在 `src/store/index.ts`，本模块只负责 L0 文件层。
 */

export {
  RawVaultImpl,
  openRawVault,
  openVault,
  type OpenVaultInput,
  type RawVaultRuntimeOptions,
} from './raw-vault.ts';

export {
  MAX_APPEND_BATCH,
} from './raw-vault.ts';

export {
  DB_FILE_NAME,
  LOCKS_DIR_NAME,
  MANIFEST_FILE_NAME,
  MANIFEST_TMP_NAME,
  NO_SESSION_KEY,
  SEGMENTS_DIR_NAME,
  SEGMENT_MAX_BYTES,
  SEGMENT_MAX_RECORDS,
  SEGMENT_NAME_RE,
  SESSION_KEY_MAX_LENGTH,
  SESSION_KEY_RE,
  SUPPORTED_RECORD_VERSION,
  SUPPORTED_VAULT_VERSIONS,
  TMP_DIR_NAME,
  VAULT_LAYOUT_VERSION,
  VERSION_CONTENT,
  VERSION_FILE_NAME,
  WRITER_FILE_NAME,
  WRITER_ID_RE,
  absoluteFromRelative,
  isSessionKey,
  normalizeWriterId,
  parseSegmentFileName,
  parseSegmentRelativePath,
  relativeFromAbsolute,
  relativeSegmentPath,
  sanitizeSessionKey,
  segmentAbsolutePath,
  segmentFileName,
  vaultPaths,
  type SegmentRelPathParts,
  type VaultPaths,
} from './layout.ts';

export {
  MANIFEST_FORMAT_VERSION,
  cloneManifest,
  computeManifestStats,
  emptyManifest,
  parseManifest,
  refreshManifestDerived,
  sortSegments,
  type ManifestSegment,
  type VaultManifest,
} from './manifest.ts';

export {
  EMPTY_CHAIN_HASH,
  PayloadError,
  assertParsedRecord,
  buildRawRecord,
  hashRawRecord,
  normalizeRawRecordInput,
  parseRecordLine,
  serializeRecordForHash,
  serializeRecordLine,
  serializeRecordLineWithNewline,
  validateParsedRecord,
  validatePayloadJson,
  type ParseRecordResult,
  type RawRecordIdentity,
} from './record.ts';

export {
  countCompleteLines,
  iterateLinesForward,
  iterateLinesReverse,
  readFirstLine,
  readLastLineInfo,
  truncateFileTo,
  type LastLineInfo,
} from './lines.ts';

export { mergeSortedAsync } from './merge.ts';

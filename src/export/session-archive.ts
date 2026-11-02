// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hanxustu (dsh-life-memory)
/**
 * 原始会话数据 / 原始数据库 导入导出（v6，宿主无关实现）。
 *
 * 两种归档：
 * 1) 会话归档（JSONL，可读、可审计、可移植）
 *    <dataDir>/exports/sessions/session-<sanitized>-<ts>.jsonl
 *    第 1 行 header：
 *      {format:'dsh-life-memory/session-archive', version:1, vaultId, personaId,
 *       sessionId, exportedAt, rawCount, memoryCount, segments:[...], hashChain:[...]}
 *    随后每行一条原始记录：L0 完整字段（id/seq/ts/iso/day/timezone/kind/sessionId/
 *    workspace/turnId/stepId/role/text/payload/tags/v/prevHash/hash）+ location；
 *    text/payload 全文保留，不截断。
 *    可选随后 `{"line":"memory", "memory":{...}}`：该会话的派生记忆（L1/L2/L3，
 *    含 retention/pinned/sessionId）。导入侧忽略 memory 行（派生数据可重建）。
 *
 * 2) 整库归档（目录快照，字节级备份）
 *    <dataDir>/exports/vaults/<vaultId>-<ts>/  （VERSION/manifest.json/vault.db/segments/**）
 *    导入到 <dataDir>/vaults/<newVaultId>/（目标必须不存在，绝不覆盖已有库）。
 *
 * 不变量（与 L0 一致）：
 *   - 导入只 **append**：绝不修改/删除目标库已有记录；
 *   - 导入的 raw 由目标 vault 重新分配 id/seq/hash（原 id 存 payload.importedFrom，
 *     原 sessionId 存 payload.originalSessionId），因此目标库哈希链自洽；
 *   - 导入前完成全部校验（format/version/逐条 hash/链连续性），校验失败不写任何数据；
 *   - 零外部依赖（node:fs / node:crypto / node:readline）。
 */

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { copyFile, mkdir, readdir, readFile, rm, stat } from 'node:fs/promises';
import { createInterface } from 'node:readline';

import { dirname, join, resolve } from 'node:path';

import type {
  MemoryRecord,
  MemoryStore,
  RawAppendItem,
  RawQuery,
  RawRecord,
  RawRecordInput,
  RawRecordLocation,
  RawVault,
} from '../core/contracts.ts';
import { atomicWriteFile, mkdirp, pathExists } from '../core/fs-atomic.ts';
import { silentLogger } from '../core/logger.ts';
import { isValidTimeZone } from '../core/time.ts';
import { openStore } from '../store/index.ts';
import { openVault } from '../vault/index.ts';
import { sanitizeSessionKey } from '../vault/layout.ts';
import { hashRawRecord, serializeRecordLine, validateParsedRecord } from '../vault/record.ts';
import { reconcileRawIndex } from '../runtime/vault-bundle.ts';
import { SHARED_VAULT_ID, VAULT_ID_RE, ensureVaultLayout, resolveVaultDir } from '../vaults/index.ts';

// ---------------------------------------------------------------------------
// 常量 / 类型
// ---------------------------------------------------------------------------

/** 会话归档格式标识（header.format） */
export const SESSION_ARCHIVE_FORMAT = 'dsh-life-memory/session-archive';
/** 会话归档格式版本（header.version；reader 只接受 1） */
export const SESSION_ARCHIVE_VERSION = 1;
/** 会话归档默认输出目录（相对 dataDir） */
export const SESSION_EXPORT_DIR = join('exports', 'sessions');
/** 整库归档默认输出目录（相对 dataDir） */
export const VAULT_EXPORT_DIR = join('exports', 'vaults');
/** 导入会话的默认新 sessionId 前缀 */
export const IMPORT_SESSION_PREFIX = 'import-';
/** 单次导入 append 的批大小 */
const IMPORT_BATCH_SIZE = 200;
/** 工具/调用侧返回的 mapping 上限（超大归档避免返回体爆炸） */
const MAPPING_RETURN_LIMIT = 500;
/** 单条 raw 行允许的最大长度（防御坏归档；正常行远小于此值） */
const MAX_ARCHIVE_LINE_BYTES = 64 * 1024 * 1024;

/** 归档校验/读写错误（带 code，工具层转结构化错误） */
export class SessionArchiveError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'SessionArchiveError';
    this.code = code;
  }
}

/** 会话归档 header */
export interface SessionArchiveHeader {
  format: typeof SESSION_ARCHIVE_FORMAT;
  version: number;
  vaultId: string;
  personaId: string | null;
  sessionId: string;
  exportedAt: number;
  exportedAtIso: string;
  rawCount: number;
  memoryCount: number;
  segments: ArchiveSegmentRef[];
  hashChain: ArchiveChainEntry[];
}

/** header.segments 条目（段位置与规模；不含内容） */
export interface ArchiveSegmentRef {
  segment: string;
  day: string;
  writerId?: string;
  sessionId?: string | null;
  records: number;
  bytes: number;
}

/** header.hashChain 条目（链校验清单：导入侧逐条比对） */
export interface ArchiveChainEntry {
  id: string;
  seq: number;
  hash: string;
  prevHash: string;
}

/** 会话归档导出选项 */
export interface ExportSessionArchiveOptions {
  /** vault 根目录（`<dataDir>/vaults/<id>` 或旧单库 dataDir） */
  vaultDir: string;
  store: MemoryStore;
  vault: RawVault;
  /** 要导出的会话 id */
  sessionId: string;
  /** 时间戳（默认 Date.now） */
  now?: number;
  /** 是否附带该会话的派生记忆（默认 true） */
  includeMemories?: boolean;
  /** 插件数据根目录（默认输出目录的基准；缺省 = vaultDir） */
  dataDir?: string;
  /** 显式输出文件路径（覆盖默认命名） */
  path?: string;
  /** 显式 vaultId（缺省从 manifest 读） */
  vaultId?: string;
  /** 显式 personaId（缺省 null） */
  personaId?: string | null;
}

/** 会话归档导出结果 */
export interface ExportedSessionArchive {
  ok: true;
  file: string;
  bytes: number;
  /** 归档文件全文 sha256（hex） */
  sha256: string;
  rawCount: number;
  memoryCount: number;
  segments: ArchiveSegmentRef[];
  sessionId: string;
}

/** 会话归档导入选项 */
export interface ImportSessionArchiveOptions {
  /** 目标 vault 根目录 */
  targetVaultDir: string;
  store: MemoryStore;
  vault: RawVault;
  /** 归档文件路径 */
  file: string;
  /** 新 sessionId（缺省 import-<ts>） */
  newSessionId?: string;
  /** 时间戳（默认 Date.now） */
  now?: number;
  /** 导入完成后的回调（向量嵌入/派生；每批一次） */
  deriveHook?: (items: RawAppendItem[]) => void | Promise<void>;
  /** 单批大小（默认 200） */
  batchSize?: number;
}

/** id 映射（原 raw id → 目标库新 raw id） */
export interface SessionArchiveMappingEntry {
  from: string;
  to: string;
  seq: number;
}

/** 会话归档导入结果 */
export interface ImportedSessionArchive {
  ok: true;
  file: string;
  rawCount: number;
  /** 归档中携带的派生记忆条数（不导入；派生可重建） */
  memoryCount: number;
  newSessionId: string;
  mapping: SessionArchiveMappingEntry[];
  mappingCount: number;
  mappingTruncated: boolean;
  segmentsWritten: string[];
}

/** 整库归档导出选项 */
export interface ExportVaultArchiveOptions {
  /** 插件数据根目录 */
  dataDir: string;
  /** 要导出的库 id */
  vaultId: string;
  /** 显式库目录（缺省 `<dataDir>/vaults/<vaultId>`） */
  vaultDir?: string;
  /** 显式输出目录（缺省 `<dataDir>/exports/vaults/<vaultId>-<ts>`） */
  path?: string;
  now?: number;
  /** 可选：已打开的 store（用于统计 memoryCount；缺省打开快照副本） */
  store?: MemoryStore;
  /** v6：导出内容 — all=数据库+原始记忆（默认）/ db=仅数据库 / raw=仅原始记忆数据（L0） */
  include?: 'all' | 'db' | 'raw';
}

/** 归档中的单个文件 */
export interface VaultArchiveFile {
  /** 相对归档目录的 posix 路径 */
  path: string;
  bytes: number;
  sha256: string;
}

/** 整库归档导出结果 */
export interface ExportedVaultArchive {
  ok: true;
  vaultId: string;
  /** v6：导出内容范围 */
  include: 'all' | 'db' | 'raw';
  dir: string;
  files: VaultArchiveFile[];
  bytes: number;
  /** 文件清单聚合 sha256（按 path 排序后逐行 `path:sha256`） */
  sha256: string;
  rawCount: number;
  memoryCount: number;
  segments: number;
}

/** 整库归档导入选项 */
export interface ImportVaultArchiveOptions {
  /** 插件数据根目录（目标库落在 `<dataDir>/vaults/<targetVaultId>`） */
  dataDir: string;
  /** 目标库 id（必须是新 id，且不能是 shared） */
  targetVaultId: string;
  /** 归档目录路径 */
  path: string;
  /** 时区（打开目标库用；缺省宿主时区） */
  timezone?: string;
  now?: number;
  /** v6：导入内容 — all=数据库+原始记忆（默认）/ db=仅数据库 / raw=仅原始记忆数据（导入后自动重建 raw_index） */
  mode?: 'all' | 'db' | 'raw';
}

/** 整库归档导入结果 */
export interface ImportedVaultArchive {
  ok: true;
  vaultId: string;
  /** v6：导入内容范围 */
  mode: 'all' | 'db' | 'raw';
  dir: string;
  rawCount: number;
  memoryCount: number;
  segments: number;
  days: number;
  files: number;
  reconcile: { checked: number; storeBefore: number; indexed: number; reconciled: boolean };
}

// ---------------------------------------------------------------------------
// 通用辅助
// ---------------------------------------------------------------------------

/** 时间戳（文件名安全）：2026-10-27T00-13-25-123Z */
function archiveStamp(now: number): string {
  return new Date(now).toISOString().replace(/[:.]/g, '-');
}

/** 文件 sha256（流式） */
async function sha256File(file: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

/**
 * vault 目录内需要归档的条目（顺序固定）。
 * `vault.db-wal` / `vault.db-shm` 是 SQLite WAL 模式下的伴生文件：只复制主库会丢失
 * 最近提交（或让快照落后），因此存在时一并快照；导入后 SQLite 会自动回放 WAL。
 */
const VAULT_ARCHIVE_ENTRIES = [
  'VERSION',
  'manifest.json',
  'vault.db',
  'vault.db-wal',
  'vault.db-shm',
] as const;

/** 递归列出目录内所有普通文件的相对 posix 路径（排序） */
async function listFilesRecursive(root: string, prefix = ''): Promise<string[]> {
  const out: string[] = [];
  let entries;
  try {
    entries = await readdir(join(root, prefix), { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const rel = prefix.length === 0 ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) {
      out.push(...(await listFilesRecursive(root, rel)));
    } else if (entry.isFile()) {
      out.push(rel);
    }
  }
  return out.sort();
}

/** 复制单个文件（自动建目录；保留内容字节） */
async function copyFileInto(source: string, target: string): Promise<number> {
  await mkdirp(dirname(target));
  await copyFile(source, target);
  const info = await stat(target);
  return info.size;
}

/** 段清单（RawVaultImpl 的诊断 getter；缺失时按 manifest 推导） */
interface SegmentListLike {
  segmentList?: Array<{
    segment: string;
    day: string;
    writerId: string;
    sessionId?: string | null;
    records: number;
    bytes: number;
    firstSeq: number;
    lastSeq: number;
  }>;
}

/** 取段清单（兼容实现类/接口：无 segmentList 时返回空） */
function segmentListOf(vault: RawVault): NonNullable<SegmentListLike['segmentList']> {
  const impl = vault as unknown as SegmentListLike;
  return impl.segmentList ?? [];
}

/** raw 索引位置（缺失返回 null） */
function locationOf(store: MemoryStore, id: string): RawRecordLocation | null {
  try {
    const row = store.getRawIndex(id);
    if (!row) return null;
    return {
      ingestKey: row.ingestKey,
      segment: row.segment,
      lineNo: row.lineNo,
      byteOffset: row.byteOffset,
      byteLen: row.byteLen,
    };
  } catch {
    return null;
  }
}

/** 序列化归档 raw 行：L0 canonical 字段顺序 + location */
function serializeArchiveRawLine(record: RawRecord, location: RawRecordLocation | null): string {
  // 复用 L0 canonical 序列化（字段顺序/格式与段文件行一致），再追加 location
  const ordered = JSON.parse(serializeRecordLine(record)) as Record<string, unknown>;
  ordered.location = location;
  return JSON.stringify(ordered);
}

/** 计算归档中属于某会话的段清单 */
function archiveSegmentsOf(
  vault: RawVault,
  sessionId: string,
  records: readonly RawRecord[],
): ArchiveSegmentRef[] {
  const seqs = records.map((record) => record.seq);
  const minSeq = seqs.length > 0 ? Math.min(...seqs) : 0;
  const maxSeq = seqs.length > 0 ? Math.max(...seqs) : 0;
  const out: ArchiveSegmentRef[] = [];
  for (const segment of segmentListOf(vault)) {
    const bySession = segment.sessionId === sessionId;
    const overlaps = segment.records > 0 && segment.lastSeq >= minSeq && segment.firstSeq <= maxSeq;
    if (!bySession && !overlaps) continue;
    out.push({
      segment: segment.segment,
      day: segment.day,
      writerId: segment.writerId,
      sessionId: segment.sessionId ?? null,
      records: segment.records,
      bytes: segment.bytes,
    });
  }
  return out;
}

/** 该会话的派生记忆（L1/L2/L3；最多 10000 条） */
function memoriesOf(store: MemoryStore, sessionId: string): MemoryRecord[] {
  try {
    return store.listMemories({ sessionId, limit: 10_000 });
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// 1) 会话归档：导出
// ---------------------------------------------------------------------------

/**
 * 导出单个会话的原始记录（+ 可选派生记忆）为 JSONL 归档。
 * 原子写文件（tmp + rename），返回 sha256 与计数。
 */
export async function exportSessionArchive(
  options: ExportSessionArchiveOptions,
): Promise<ExportedSessionArchive> {
  const sessionId = typeof options.sessionId === 'string' ? options.sessionId.trim() : '';
  if (sessionId.length === 0) {
    throw new SessionArchiveError('E_BAD_ARGS', 'exportSessionArchive: sessionId is required');
  }
  const now = typeof options.now === 'number' ? options.now : Date.now();
  const includeMemories = options.includeMemories !== false;

  // 1) 读取该会话的全部原始记录（完整 L0 字段；不截断）
  const query: RawQuery = { sessionId };
  const records: RawRecord[] = [];
  for await (const record of options.vault.iterate(query)) records.push(record);

  // 2) 段清单 + 链清单
  const segments = archiveSegmentsOf(options.vault, sessionId, records);
  const hashChain: ArchiveChainEntry[] = records.map((record) => ({
    id: record.id,
    seq: record.seq,
    hash: record.hash,
    prevHash: record.prevHash,
  }));

  // 3) 派生记忆（可选）
  const memories = includeMemories ? memoriesOf(options.store, sessionId) : [];

  // 4) 组装 JSONL：header + raw 行 + memory 行
  const vaultId =
    typeof options.vaultId === 'string' && options.vaultId.length > 0
      ? options.vaultId
      : await options.vault
          .manifest()
          .then((manifest) => manifest.vaultId)
          .catch(() => 'unknown');
  const header: SessionArchiveHeader = {
    format: SESSION_ARCHIVE_FORMAT,
    version: SESSION_ARCHIVE_VERSION,
    vaultId,
    personaId: options.personaId ?? null,
    sessionId,
    exportedAt: now,
    exportedAtIso: new Date(now).toISOString(),
    rawCount: records.length,
    memoryCount: memories.length,
    segments,
    hashChain,
  };
  const lines: string[] = [JSON.stringify(header)];
  for (const record of records) {
    lines.push(serializeArchiveRawLine(record, locationOf(options.store, record.id)));
  }
  for (const memory of memories) {
    lines.push(JSON.stringify({ line: 'memory', memory }));
  }
  const content = `${lines.join('\n')}\n`;

  // 5) 解析输出路径并原子写
  const baseDir = options.dataDir ?? options.vaultDir;
  const file =
    typeof options.path === 'string' && options.path.length > 0
      ? resolve(options.path)
      : join(
          resolve(baseDir),
          SESSION_EXPORT_DIR,
          `session-${sanitizeSessionKey(sessionId)}-${archiveStamp(now)}.jsonl`,
        );
  await atomicWriteFile(file, content);

  return {
    ok: true,
    file,
    bytes: Buffer.byteLength(content, 'utf8'),
    sha256: createHash('sha256').update(content, 'utf8').digest('hex'),
    rawCount: records.length,
    memoryCount: memories.length,
    segments,
    sessionId,
  };
}

// ---------------------------------------------------------------------------
// 2) 会话归档：导入
// ---------------------------------------------------------------------------

/** 解析一行归档 JSON；错误统一为 E_ARCHIVE_INVALID */
function parseArchiveLine(line: string, lineNo: number): Record<string, unknown> {
  if (Buffer.byteLength(line, 'utf8') > MAX_ARCHIVE_LINE_BYTES) {
    throw new SessionArchiveError('E_ARCHIVE_INVALID', `archive line ${lineNo} exceeds ${MAX_ARCHIVE_LINE_BYTES} bytes`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch (error) {
    throw new SessionArchiveError(
      'E_ARCHIVE_INVALID',
      `archive line ${lineNo} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new SessionArchiveError('E_ARCHIVE_INVALID', `archive line ${lineNo} is not a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

/** 逐行读取文本文件（UTF-8；行尾 \n 或 \r\n） */
async function readArchiveLines(file: string): Promise<string[]> {
  const info = await pathExists(file);
  if (!info) throw new SessionArchiveError('E_ARCHIVE_NOT_FOUND', `archive file not found: ${file}`);
  const lines: string[] = [];
  const stream = createReadStream(file, { encoding: 'utf8' });
  const reader = createInterface({ input: stream, crlfDelay: Number.POSITIVE_INFINITY });
  try {
    for await (const raw of reader) {
      const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
      if (line.length === 0) continue;
      lines.push(line);
    }
  } finally {
    reader.close();
    stream.destroy();
  }
  return lines;
}

/** 原 payload -> 导入 payload（object 原地扩展；非 object 包一层 data） */
function remapImportedPayload(
  payload: unknown,
  importedFrom: string,
  originalSessionId: string,
  importedAt: number,
): unknown {
  if (payload !== null && typeof payload === 'object' && !Array.isArray(payload)) {
    return {
      ...(payload as Record<string, unknown>),
      importedFrom,
      originalSessionId,
      importedAt,
    };
  }
  return { importedFrom, originalSessionId, importedAt, data: payload ?? null };
}

/** 归档 raw 行 -> RawRecordInput（校验已在调用前完成） */
function rawInputOf(
  record: RawRecord,
  newSessionId: string,
  importedAt: number,
): RawRecordInput {
  const input: RawRecordInput = {
    kind: record.kind,
    ts: record.ts,
    timezone: record.timezone,
    sessionId: newSessionId,
    workspace: record.workspace ?? null,
    turnId: record.turnId ?? null,
    stepId: record.stepId ?? null,
    role: record.role ?? null,
    text: record.text ?? null,
    payload: remapImportedPayload(record.payload, record.id, record.sessionId, importedAt),
    tags: Array.isArray(record.tags) ? [...record.tags] : [],
    ingestKey: `import:${newSessionId}:${record.id}`,
  };
  return input;
}

/**
 * 导入会话归档：校验 header/version/逐条 hash/链连续性 → 重新 append 到目标库。
 * 全部校验通过后才写入；写入只 append（绝不改/删已有数据）。
 */
export async function importSessionArchive(
  options: ImportSessionArchiveOptions,
): Promise<ImportedSessionArchive> {
  const now = typeof options.now === 'number' ? options.now : Date.now();
  const file = resolve(options.file);
  const lines = await readArchiveLines(file);
  if (lines.length === 0) {
    throw new SessionArchiveError('E_ARCHIVE_INVALID', 'archive file is empty');
  }

  // 1) header 校验
  const headerRaw = parseArchiveLine(lines[0], 1);
  if (headerRaw.format !== SESSION_ARCHIVE_FORMAT) {
    throw new SessionArchiveError(
      'E_ARCHIVE_INVALID',
      `unsupported archive format: ${String(headerRaw.format)}`,
    );
  }
  if (headerRaw.version !== SESSION_ARCHIVE_VERSION) {
    throw new SessionArchiveError(
      'E_ARCHIVE_INVALID',
      `unsupported archive version: ${String(headerRaw.version)} (expected ${SESSION_ARCHIVE_VERSION})`,
    );
  }
  if (typeof headerRaw.sessionId !== 'string' || headerRaw.sessionId.length === 0) {
    throw new SessionArchiveError('E_ARCHIVE_INVALID', 'archive header is missing sessionId');
  }
  if (typeof headerRaw.rawCount !== 'number' || !Number.isInteger(headerRaw.rawCount) || headerRaw.rawCount < 0) {
    throw new SessionArchiveError('E_ARCHIVE_INVALID', 'archive header is missing rawCount');
  }
  const headerChain = Array.isArray(headerRaw.hashChain) ? headerRaw.hashChain : [];
  const originalSessionId = headerRaw.sessionId;

  // 2) 解析 raw 行（先全部校验，再写入）
  const parsedRecords: RawRecord[] = [];
  let memoryCount = 0;
  for (let i = 1; i < lines.length; i += 1) {
    const obj = parseArchiveLine(lines[i], i + 1);
    if (obj.line === 'memory') {
      memoryCount += 1;
      continue;
    }
    const shape = validateParsedRecord(obj);
    if (!shape.ok) {
      throw new SessionArchiveError(
        'E_ARCHIVE_INVALID',
        `archive line ${i + 1} is not a valid raw record: ${shape.reason}`,
      );
    }
    const record = shape.record;
    const recomputed = hashRawRecord(record);
    if (recomputed !== record.hash) {
      throw new SessionArchiveError(
        'E_ARCHIVE_INVALID',
        `archive line ${i + 1} hash mismatch (record ${record.id}): content tampered`,
      );
    }
    if (parsedRecords.length > 0) {
      const previous = parsedRecords[parsedRecords.length - 1];
      if (record.prevHash !== previous.hash) {
        throw new SessionArchiveError(
          'E_ARCHIVE_INVALID',
          `archive line ${i + 1} breaks the hash chain (record ${record.id})`,
        );
      }
    }
    parsedRecords.push(record);
  }

  // 3) header 计数/链清单与正文一致性
  if (parsedRecords.length !== headerRaw.rawCount) {
    throw new SessionArchiveError(
      'E_ARCHIVE_INVALID',
      `archive rawCount mismatch: header=${headerRaw.rawCount}, lines=${parsedRecords.length}`,
    );
  }
  if (headerChain.length > 0) {
    if (headerChain.length !== parsedRecords.length) {
      throw new SessionArchiveError('E_ARCHIVE_INVALID', 'archive hashChain length does not match raw lines');
    }
    for (let i = 0; i < parsedRecords.length; i += 1) {
      const entry = headerChain[i] as Record<string, unknown> | null;
      const record = parsedRecords[i];
      if (
        !entry ||
        entry.id !== record.id ||
        entry.hash !== record.hash ||
        (typeof entry.seq === 'number' && entry.seq !== record.seq)
      ) {
        throw new SessionArchiveError(
          'E_ARCHIVE_INVALID',
          `archive hashChain entry ${i + 1} does not match raw line (record ${record.id})`,
        );
      }
    }
  }
  // 记录自身字段的基本约束（时区必须有效；archive 可能跨机器）
  for (const record of parsedRecords) {
    if (typeof record.ts !== 'number' || !Number.isFinite(record.ts)) {
      throw new SessionArchiveError('E_ARCHIVE_INVALID', `record ${record.id} has invalid ts`);
    }
    if (typeof record.timezone !== 'string' || !isValidTimeZone(record.timezone)) {
      throw new SessionArchiveError('E_ARCHIVE_INVALID', `record ${record.id} has invalid timezone`);
    }
  }

  // 4) 新 sessionId
  const requested = typeof options.newSessionId === 'string' ? options.newSessionId.trim() : '';
  const newSessionId = requested.length > 0 ? requested : `${IMPORT_SESSION_PREFIX}${archiveStamp(now)}`;

  // 5) 分批 append（id/seq/hash 由目标 vault 分配）+ 索引 + 回调
  const batchSize =
    typeof options.batchSize === 'number' && Number.isInteger(options.batchSize) && options.batchSize > 0
      ? Math.min(options.batchSize, IMPORT_BATCH_SIZE)
      : IMPORT_BATCH_SIZE;
  const mapping: SessionArchiveMappingEntry[] = [];
  const segmentsWritten: string[] = [];
  for (let start = 0; start < parsedRecords.length; start += batchSize) {
    const slice = parsedRecords.slice(start, start + batchSize);
    const inputs = slice.map((record) => rawInputOf(record, newSessionId, now));
    const appended = await options.vault.append(inputs);
    if (appended.items.length === 0) {
      throw new SessionArchiveError('E_IMPORT_FAILED', 'target vault rejected the import batch (no items appended)');
    }
    for (let i = 0; i < appended.items.length; i += 1) {
      const item = appended.items[i];
      const source = slice[i];
      mapping.push({ from: source.id, to: item.record.id, seq: item.record.seq });
    }
    for (const segment of appended.segmentsWritten) {
      if (!segmentsWritten.includes(segment)) segmentsWritten.push(segment);
    }
    try {
      options.store.indexRawRecords(appended.items);
    } catch (error) {
      // 索引失败不影响 L0 事实（下次 open 会 reconcile）；但要让调用方知道
      silentLogger.warn('[export] raw index write failed after import batch (L0 remains authoritative)', error);
    }
    if (options.deriveHook) await options.deriveHook(appended.items);
  }

  return {
    ok: true,
    file,
    rawCount: mapping.length,
    memoryCount,
    newSessionId,
    mapping: mapping.slice(0, MAPPING_RETURN_LIMIT),
    mappingCount: mapping.length,
    mappingTruncated: mapping.length > MAPPING_RETURN_LIMIT,
    segmentsWritten,
  };
}

// ---------------------------------------------------------------------------
// 3) 整库归档：导出
// ---------------------------------------------------------------------------

/** 读取 vault 目录的 manifest 统计（缺失/损坏返回零值） */
async function readManifestStats(
  vaultDir: string,
): Promise<{ rawCount: number; segments: number; days: number }> {
  try {
    const raw = await readFile(join(vaultDir, 'manifest.json'), 'utf8');
    const parsed = JSON.parse(raw) as { segments?: unknown; stats?: { records?: unknown; days?: unknown } };
    const segments = Array.isArray(parsed.segments) ? parsed.segments.length : 0;
    const rawCount = typeof parsed.stats?.records === 'number' ? parsed.stats.records : 0;
    const days = typeof parsed.stats?.days === 'number' ? parsed.stats.days : 0;
    return { rawCount, segments, days };
  } catch {
    return { rawCount: 0, segments: 0, days: 0 };
  }
}

/**
 * 导出整个 vault 目录（VERSION/manifest.json/vault.db + segments/**）到快照目录。
 * 每个文件计算 sha256；另给出文件清单的聚合 sha256。
 */
export async function exportVaultArchive(
  options: ExportVaultArchiveOptions,
): Promise<ExportedVaultArchive> {
  const vaultId = typeof options.vaultId === 'string' ? options.vaultId.trim() : '';
  if (vaultId.length === 0 || !VAULT_ID_RE.test(vaultId)) {
    throw new SessionArchiveError('E_BAD_ARGS', `invalid vault id: ${JSON.stringify(options.vaultId)}`);
  }
  const sourceDir = options.vaultDir !== undefined ? resolve(options.vaultDir) : resolveVaultDir(options.dataDir, vaultId);
  if (!(await pathExists(sourceDir))) {
    throw new SessionArchiveError('E_VAULT_NOT_FOUND', `vault directory not found: ${sourceDir}`);
  }
  const include: 'all' | 'db' | 'raw' =
    options.include === 'db' || options.include === 'raw' ? options.include : 'all';
  const hasManifest = await pathExists(join(sourceDir, 'manifest.json'));
  const hasVersion = await pathExists(join(sourceDir, 'VERSION'));
  if (!hasVersion || (include !== 'db' && !hasManifest)) {
    throw new SessionArchiveError(
      'E_VAULT_INVALID',
      `vault directory is missing required ${include === 'db' ? 'VERSION/vault.db' : 'manifest.json/VERSION'}: ${sourceDir}`,
    );
  }
  const now = typeof options.now === 'number' ? options.now : Date.now();
  const targetDir =
    typeof options.path === 'string' && options.path.length > 0
      ? resolve(options.path)
      : join(resolve(options.dataDir), VAULT_EXPORT_DIR, `${vaultId}-${archiveStamp(now)}`);
  if (await pathExists(targetDir)) {
    throw new SessionArchiveError('E_EXPORT_EXISTS', `export directory already exists: ${targetDir}`);
  }
  await mkdir(targetDir, { recursive: true });

  // 1) 顶层文件（按导出内容过滤：db 只拷数据库，raw 只拷清单/版本，all 全拷）
  const files: VaultArchiveFile[] = [];
  const topEntries: readonly string[] =
    include === 'db'
      ? ['VERSION', 'vault.db', 'vault.db-wal', 'vault.db-shm']
      : include === 'raw'
        ? ['VERSION', 'manifest.json']
        : VAULT_ARCHIVE_ENTRIES;
  for (const entry of topEntries) {
    const source = join(sourceDir, entry);
    if (!(await pathExists(source))) continue;
    const target = join(targetDir, entry);
    const bytes = await copyFileInto(source, target);
    files.push({ path: entry, bytes, sha256: await sha256File(target) });
  }
  // 2) segments/**（递归；仅数据库快照时跳过）
  if (include !== 'db') {
    const segmentFiles = await listFilesRecursive(sourceDir, 'segments');
    for (const rel of segmentFiles) {
      const source = join(sourceDir, ...rel.split('/'));
      const target = join(targetDir, ...rel.split('/'));
      const bytes = await copyFileInto(source, target);
      files.push({ path: rel, bytes, sha256: await sha256File(target) });
    }
  }
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  // 3) 统计（优先用调用方提供的已打开 store；否则打开快照副本计数）
  const manifestStats = await readManifestStats(targetDir);
  let rawCount = manifestStats.rawCount;
  let memoryCount = 0;
  let liveStore: MemoryStore | null = null;
  try {
    liveStore = options.store ?? openStore({ dataDir: targetDir }, { logger: silentLogger });
    memoryCount = liveStore.storageStats().memoryCount ?? 0;
    if (include === 'db') rawCount = liveStore.storageStats().rawCount ?? 0;
  } catch {
    memoryCount = 0;
  } finally {
    if (options.store === undefined) {
      try {
        liveStore?.close();
      } catch {
        /* ignore */
      }
    }
  }
  const aggregate = createHash('sha256');
  for (const file of files) aggregate.update(`${file.path}:${file.sha256}\n`, 'utf8');
  return {
    ok: true,
    vaultId,
    include,
    dir: targetDir,
    files,
    bytes: files.reduce((sum, file) => sum + file.bytes, 0),
    sha256: aggregate.digest('hex'),
    rawCount,
    memoryCount,
    segments: include === 'db' ? 0 : manifestStats.segments,
  };
}

// ---------------------------------------------------------------------------
// 3.5) 面板用：列出 exports/ 下已有归档（自动填路径/建议新库 id）
// ---------------------------------------------------------------------------

export interface TransferArchiveEntry {
  kind: 'session' | 'vault';
  /** 展示名（文件名/目录名） */
  name: string;
  /** 绝对路径（session=文件，vault=目录） */
  path: string;
  bytes: number;
  mtime: number;
  /** vault 内容类型（根据目录内文件存在情况推断）；session 恒为 raw */
  include?: 'all' | 'db' | 'raw';
  /** vault 的建议新库 id（尚不存在、合法、非 shared） */
  suggestedVaultId?: string;
}

export interface TransferArchives {
  ok: true;
  exportsDir: string;
  sessionsDir: string;
  vaultsDir: string;
  sessions: TransferArchiveEntry[];
  vaults: TransferArchiveEntry[];
}

/** 把归档目录名转成合法的建议新库 id（并以 -import / -2 保证不冲突） */
async function suggestVaultId(dataDir: string, name: string): Promise<string> {
  const sanitized = name
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 56);
  let candidate = sanitized.length > 0 ? sanitized : `import-${archiveStamp(Date.now())}`;
  if (candidate === SHARED_VAULT_ID) candidate = `${candidate}-import`;
  let attempt = candidate;
  let suffix = 1;
  while (await pathExists(resolveVaultDir(dataDir, attempt))) {
    suffix += 1;
    attempt = `${candidate}-${suffix}`.slice(0, 64);
  }
  return attempt;
}

/** 列出 `<dataDir>/exports/sessions/*.jsonl` 与 `<dataDir>/exports/vaults/*` 归档 */
export async function listTransferArchives(dataDir: string): Promise<TransferArchives> {
  const exportsDir = join(resolve(dataDir), 'exports');
  const sessionsDir = join(exportsDir, 'sessions');
  const vaultsDir = join(exportsDir, 'vaults');
  const sessions: TransferArchiveEntry[] = [];
  const vaults: TransferArchiveEntry[] = [];

  let sessionNames: string[] = [];
  try {
    sessionNames = (await readdir(sessionsDir)).filter((name) => name.endsWith('.jsonl'));
  } catch {
    sessionNames = [];
  }
  for (const name of sessionNames) {
    const filePath = join(sessionsDir, name);
    try {
      const info = await stat(filePath);
      if (!info.isFile()) continue;
      sessions.push({ kind: 'session', name, path: filePath, bytes: info.size, mtime: info.mtimeMs });
    } catch {
      /* ignore */
    }
  }

  let vaultNames: string[] = [];
  try {
    vaultNames = (await readdir(vaultsDir, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    vaultNames = [];
  }
  for (const name of vaultNames) {
    const dir = join(vaultsDir, name);
    try {
      const hasDb = await pathExists(join(dir, 'vault.db'));
      const hasManifest = await pathExists(join(dir, 'manifest.json'));
      const hasSegments = await pathExists(join(dir, 'segments'));
      if ((!hasDb && !hasSegments) || (!hasManifest && !hasDb)) continue;
      const include: 'all' | 'db' | 'raw' = hasDb && hasSegments ? 'all' : hasDb ? 'db' : 'raw';
      let bytes = 0;
      let mtime = 0;
      try {
        const info = await stat(dir);
        mtime = info.mtimeMs;
        for (const rel of await listFilesRecursive(dir)) {
          try {
            bytes += (await stat(join(dir, ...rel.split('/')))).size;
          } catch {
            /* ignore */
          }
        }
      } catch {
        /* ignore */
      }
      vaults.push({
        kind: 'vault',
        name,
        path: dir,
        bytes,
        mtime,
        include,
        suggestedVaultId: await suggestVaultId(dataDir, name),
      });
    } catch {
      /* ignore */
    }
  }

  sessions.sort((a, b) => b.mtime - a.mtime);
  vaults.sort((a, b) => b.mtime - a.mtime);
  return { ok: true, exportsDir, sessionsDir, vaultsDir, sessions, vaults };
}
// ---------------------------------------------------------------------------
// 4) 整库归档：导入
// ---------------------------------------------------------------------------

/**
 * 导入整库归档：校验目录结构（VERSION/manifest.json/vault.db）→ 复制到
 * `<dataDir>/vaults/<targetId>/`（目标必须不存在）→ openStore/openVault +
 * reconcile（把 L0 补齐进 raw_index）→ 返回计数。
 */
export async function importVaultArchive(
  options: ImportVaultArchiveOptions,
): Promise<ImportedVaultArchive> {
  const targetVaultId = typeof options.targetVaultId === 'string' ? options.targetVaultId.trim() : '';
  if (targetVaultId.length === 0 || !VAULT_ID_RE.test(targetVaultId)) {
    throw new SessionArchiveError(
      'E_BAD_ARGS',
      `invalid target vault id: ${JSON.stringify(options.targetVaultId)} (expected ^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$)`,
    );
  }
  if (targetVaultId === SHARED_VAULT_ID) {
    throw new SessionArchiveError('E_BAD_ARGS', 'target vault id "shared" is reserved; choose a new id');
  }
  const sourceDir = resolve(options.path);
  if (!(await pathExists(sourceDir))) {
    throw new SessionArchiveError('E_ARCHIVE_NOT_FOUND', `archive directory not found: ${sourceDir}`);
  }
  const mode: 'all' | 'db' | 'raw' = options.mode === 'db' || options.mode === 'raw' ? options.mode : 'all';
  const requiredEntries: readonly string[] =
    mode === 'db'
      ? ['VERSION', 'vault.db']
      : mode === 'raw'
        ? ['VERSION', 'manifest.json']
        : ['VERSION', 'manifest.json', 'vault.db'];
  for (const required of requiredEntries) {
    if (!(await pathExists(join(sourceDir, required)))) {
      throw new SessionArchiveError('E_ARCHIVE_INVALID', `archive is missing ${required}: ${sourceDir}`);
    }
  }
  await ensureVaultLayout(options.dataDir);
  const targetDir = resolveVaultDir(options.dataDir, targetVaultId);
  if (await pathExists(targetDir)) {
    throw new SessionArchiveError('E_VAULT_EXISTS', `target vault already exists (refusing to overwrite): ${targetDir}`);
  }

  // 1) 复制整库目录（只复制普通文件；归档目录由 exportVaultArchive 保证结构）
  await mkdir(targetDir, { recursive: true });
  let copied = 0;
  try {
    for (const rel of await listFilesRecursive(sourceDir)) {
      await copyFileInto(join(sourceDir, ...rel.split('/')), join(targetDir, ...rel.split('/')));
      copied += 1;
    }
  } catch (error) {
    await rm(targetDir, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
  if (copied === 0) {
    await rm(targetDir, { recursive: true, force: true }).catch(() => undefined);
    throw new SessionArchiveError('E_ARCHIVE_INVALID', `archive directory has no files: ${sourceDir}`);
  }

  // 2) 打开目标库（store + L0）并启动对账；失败则回滚新建目录（不碰已有数据）
  const timezone =
    typeof options.timezone === 'string' && options.timezone.length > 0
      ? options.timezone
      : Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  let store: MemoryStore | null = null;
  let vault: Awaited<ReturnType<typeof openVault>> | null = null;
  try {
    store = openStore({ dataDir: targetDir, timezone }, { logger: silentLogger });
    if (mode === 'db') {
      // 仅数据库：没有 segments，打开 store 校验计数即可（raw 文件需另行导入）
      const storage = store.storageStats();
      return {
        ok: true,
        vaultId: targetVaultId,
        mode,
        dir: targetDir,
        rawCount: storage.rawCount ?? 0,
        memoryCount: storage.memoryCount ?? 0,
        segments: 0,
        days: 0,
        files: copied,
        reconcile: { checked: 0, storeBefore: 0, indexed: 0, reconciled: false },
      };
    }
    vault = await openVault({ rootDir: targetDir, timezone }, { logger: silentLogger, writerInfo: false });
    const reconcile = await reconcileRawIndex({ vault, store, logger: silentLogger });
    const vaultStats = await vault.stats();
    const storage = store.storageStats();
    return {
      ok: true,
      vaultId: targetVaultId,
      mode,
      dir: targetDir,
      rawCount: vaultStats.records,
      memoryCount: storage.memoryCount ?? 0,
      segments: vaultStats.segments,
      days: vaultStats.days,
      files: copied,
      reconcile: {
        checked: reconcile.checked,
        storeBefore: reconcile.storeBefore,
        indexed: reconcile.indexed,
        reconciled: reconcile.reconciled,
      },
    };
  } catch (error) {
    try {
      await vault?.close();
    } catch {
      /* ignore */
    }
    try {
      store?.close();
    } catch {
      /* ignore */
    }
    await rm(targetDir, { recursive: true, force: true }).catch(() => undefined);
    if (error instanceof SessionArchiveError) throw error;
    throw new SessionArchiveError(
      'E_IMPORT_FAILED',
      `failed to open imported vault: ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    try {
      await vault?.close();
    } catch {
      /* ignore */
    }
    try {
      store?.close();
    } catch {
      /* ignore */
    }
  }
}

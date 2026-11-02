// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hanxustu (dsh-life-memory)
/**
 * Vault 目录布局与命名规则（L0 原始记忆层，docs/20 §5 字节级契约）。
 *
 * 磁盘布局（`<vaultRoot>` = config.dataDir 或 `<dataDir>/vaults/<vaultId>`）：
 *   <vaultRoot>/
 *     VERSION                 # 纯文本 "2\n"（原始记录布局版本；reader 兼容 "1"）
 *     vault.db                # SQLite（store 模块负责；本模块只读路径）
 *     manifest.json           # 顶层清单（原子替换写；可重建缓存）
 *     segments/
 *       2026-10-25/           # 本地日期目录（config.timezone）
 *         <sessionKey>/       # v2：按会话物理隔离（sanitizeSessionKey(sessionId)）
 *           seg-w1a2b3c-000001.jsonl
 *           seg-w1a2b3c-000002.jsonl
 *         seg-w1a2b3c-000009.jsonl   # v1 旧布局（只读兼容，不再新增；不迁移）
 *     exports/                # 可选的人类可读导出（本实现不使用；导出走 <dataDir>/exports）
 *     tmp/                    # 原子写临时文件（manifest.json.tmp），启动时清理
 *     locks/
 *       writer.json           # 写者诊断信息（不参与正确性；DB 锁才是仲裁者）
 *
 * 命名规则（必须正则匹配，docs/20 §5.1）：
 *   - 日期目录：`YYYY-MM-DD`（本地历法，config.timezone）
 *   - v2 会话目录：`sanitizeSessionKey(sessionId)`，保留 `[A-Za-z0-9._-]`、其它字符
 *     替换为 `-`、最长 80 字符；无 sessionId 归入 `_no-session`
 *   - 段文件：`seg-w<writerId6>-<segNo6>.jsonl`；writerId6 = 6 位小写十六进制，
 *     segNo 从 000001 起、同一 (day, sessionKey, writer) 递增
 *   - 段内一行一条 UTF-8 JSON，行尾 `\n`，无 BOM/缩进/空行
 *   - manifest 临时文件固定为 `tmp/manifest.json.tmp`
 *
 * 兼容性口径（v2）：
 *   - 新数据一律写入 `segments/<day>/<sessionKey>/`；
 *   - 读取/校验/检索**以 manifest 的段列表为准**，并同时接受 v1/v2 两种相对路径；
 *   - 旧 v1 段文件保持原样（不迁移、不重写，只读）；
 *   - 哈希链是**全库全局**的：分目录只影响文件位置，不影响 seq/prevHash 顺序。
 */

import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { isDateString } from '../core/time.ts';

/** 记录格式版本文件 */
export const VERSION_FILE_NAME = 'VERSION';
/** VERSION 文件内容（v2：会话分目录布局） */
export const VERSION_CONTENT = '2\n';
/** 支持的原始记录行格式版本（record.ts 的 `v`） */
export const SUPPORTED_RECORD_VERSION = 1;
/** vault 布局版本（VERSION 文件）：v1 = 同库混写，v2 = 按会话分目录 */
export const VAULT_LAYOUT_VERSION = 2;
/** reader 接受的 VERSION 值（v1 旧库只读兼容，不迁移） */
export const SUPPORTED_VAULT_VERSIONS: readonly string[] = ['1', '2'];
/** 清单文件 */
export const MANIFEST_FILE_NAME = 'manifest.json';
/** manifest 临时文件（tmp/manifest.json.tmp） */
export const MANIFEST_TMP_NAME = 'manifest.json.tmp';
/** 段目录 */
export const SEGMENTS_DIR_NAME = 'segments';
/** 临时目录 */
export const TMP_DIR_NAME = 'tmp';
/** 锁/诊断目录 */
export const LOCKS_DIR_NAME = 'locks';
/** 写者诊断文件 */
export const WRITER_FILE_NAME = 'writer.json';
/** SQLite 数据库文件名（store 使用；此常量只用于文档/路径解析） */
export const DB_FILE_NAME = 'vault.db';
/** 单个段文件大小上限：8 MiB（docs/20 §5.1） */
export const SEGMENT_MAX_BYTES = 8 * 1024 * 1024;
/** 单个段文件记录数上限：2000 */
export const SEGMENT_MAX_RECORDS = 2_000;
/** 段文件名正则：seg-w<6 hex>-<digits>.jsonl */
export const SEGMENT_NAME_RE: RegExp = /^seg-w([0-9a-f]{6})-(\d{6,})\.jsonl$/;
/** writerId 形状：6 位小写十六进制 */
export const WRITER_ID_RE: RegExp = /^[0-9a-f]{6}$/;
/** 会话目录名（sessionKey）形状：保留 [A-Za-z0-9._-]，最长 80 */
export const SESSION_KEY_RE: RegExp = /^[A-Za-z0-9._-]{1,80}$/;
/** 无会话 id 的记录归入的目录名 */
export const NO_SESSION_KEY = '_no-session';
/** sessionKey 字符白名单（其余替换为 '-'） */
const SESSION_KEY_UNSAFE_RE = /[^A-Za-z0-9._-]/g;
/** sessionKey 最大长度 */
export const SESSION_KEY_MAX_LENGTH = 80;
/** v1 段相对路径：segments/<day>/<name>.jsonl */
const V1_SEGMENT_REL_RE: RegExp = /^segments\/(\d{4}-\d{2}-\d{2})\/([^/\\]+\.jsonl)$/;
/** v2 段相对路径：segments/<day>/<sessionKey>/<name>.jsonl */
const V2_SEGMENT_REL_RE: RegExp = /^segments\/(\d{4}-\d{2}-\d{2})\/([^/\\]+)\/([^/\\]+\.jsonl)$/;

/** Vault 相关绝对路径 */
export interface VaultPaths {
  /** dataDir / vault root */
  rootDir: string;
  /** <root>/segments */
  segmentsDir: string;
  /** <root>/tmp */
  tmpDir: string;
  /** <root>/locks */
  locksDir: string;
  /** <root>/VERSION */
  versionPath: string;
  /** <root>/manifest.json */
  manifestPath: string;
  /** <root>/tmp/manifest.json.tmp */
  manifestTmpPath: string;
  /** <root>/locks/writer.json */
  writerInfoPath: string;
  /** <root>/vault.db */
  dbPath: string;
}

/** 计算全部 vault 路径（不创建目录） */
export function vaultPaths(rootDir: string): VaultPaths {
  const root = resolve(rootDir);
  return {
    rootDir: root,
    segmentsDir: join(root, SEGMENTS_DIR_NAME),
    tmpDir: join(root, TMP_DIR_NAME),
    locksDir: join(root, LOCKS_DIR_NAME),
    versionPath: join(root, VERSION_FILE_NAME),
    manifestPath: join(root, MANIFEST_FILE_NAME),
    manifestTmpPath: join(root, TMP_DIR_NAME, MANIFEST_TMP_NAME),
    writerInfoPath: join(root, LOCKS_DIR_NAME, WRITER_FILE_NAME),
    dbPath: join(root, DB_FILE_NAME),
  };
}

/**
 * 会话目录名（物理隔离单位）：保留 `[A-Za-z0-9._-]`，其余替换为 `-`，最长 80。
 * 无 sessionId（null/undefined/空串/纯非法字符）→ `_no-session`。
 * 另外拒绝 `.` / `..` / 纯点号（路径穿越防护）与 Windows 不允许的结尾点号。
 */
export function sanitizeSessionKey(sessionId: string | null | undefined): string {
  if (typeof sessionId !== 'string') return NO_SESSION_KEY;
  const sanitized = sessionId
    .replace(SESSION_KEY_UNSAFE_RE, '-')
    .slice(0, SESSION_KEY_MAX_LENGTH)
    .replace(/\.+$/, '');
  if (sanitized.length === 0) return NO_SESSION_KEY;
  if (/^\.+$/.test(sanitized)) return NO_SESSION_KEY;
  return sanitized;
}

/** 是否合法 sessionKey（可用于拼接路径） */
export function isSessionKey(value: unknown): value is string {
  if (typeof value !== 'string' || !SESSION_KEY_RE.test(value)) return false;
  return !/^\.+$/.test(value);
}

/** 段文件名（seg-w<writerId6>-<segNo6>.jsonl） */
export function segmentFileName(writerId: string, segNo: number): string {
  if (!WRITER_ID_RE.test(writerId)) {
    throw new RangeError(`[dsh-life-memory] segmentFileName: invalid writerId ${String(writerId)}`);
  }
  if (!Number.isSafeInteger(segNo) || segNo < 1) {
    throw new RangeError(`[dsh-life-memory] segmentFileName: invalid segNo ${String(segNo)}`);
  }
  return `seg-w${writerId}-${String(segNo).padStart(6, '0')}.jsonl`;
}

/** 解析段文件名；非法返回 null */
export function parseSegmentFileName(name: string): { writerId: string; segNo: number } | null {
  if (typeof name !== 'string') return null;
  const match = SEGMENT_NAME_RE.exec(name);
  if (match === null) return null;
  const segNo = Number(match[2]);
  if (!Number.isSafeInteger(segNo) || segNo < 1) return null;
  return { writerId: match[1], segNo };
}

/**
 * 段文件相对路径（相对 vault root，posix 分隔符）：
 *   - 传 sessionKey（v2 写入路径）→ `segments/<day>/<sessionKey>/<name>`；
 *   - 省略 sessionKey（v1 旧布局）→ `segments/<day>/<name>`。
 */
export function relativeSegmentPath(day: string, name: string, sessionKey?: string | null): string {
  if (!isDateString(day)) {
    throw new RangeError(`[dsh-life-memory] relativeSegmentPath: invalid day ${String(day)}`);
  }
  if (parseSegmentFileName(name) === null) {
    throw new RangeError(`[dsh-life-memory] relativeSegmentPath: invalid segment name ${String(name)}`);
  }
  if (sessionKey === undefined || sessionKey === null) return `${SEGMENTS_DIR_NAME}/${day}/${name}`;
  if (!isSessionKey(sessionKey)) {
    throw new RangeError(`[dsh-life-memory] relativeSegmentPath: invalid sessionKey ${String(sessionKey)}`);
  }
  return `${SEGMENTS_DIR_NAME}/${day}/${sessionKey}/${name}`;
}

/** 段文件绝对路径（sessionKey 省略 = v1 旧布局） */
export function segmentAbsolutePath(
  paths: VaultPaths,
  day: string,
  name: string,
  sessionKey?: string | null,
): string {
  if (!isDateString(day)) {
    throw new RangeError(`[dsh-life-memory] segmentAbsolutePath: invalid day ${String(day)}`);
  }
  if (parseSegmentFileName(name) === null) {
    throw new RangeError(`[dsh-life-memory] segmentAbsolutePath: invalid segment name ${String(name)}`);
  }
  if (sessionKey === undefined || sessionKey === null) return join(paths.segmentsDir, day, name);
  if (!isSessionKey(sessionKey)) {
    throw new RangeError(`[dsh-life-memory] segmentAbsolutePath: invalid sessionKey ${String(sessionKey)}`);
  }
  return join(paths.segmentsDir, day, sessionKey, name);
}

/** 解析后的段相对路径（v1 = sessionKey:null） */
export interface SegmentRelPathParts {
  /** 规范化后的相对路径（posix；v2 含 sessionKey 段） */
  relPath: string;
  day: string;
  /** v2 会话目录名；v1 旧布局为 null */
  sessionKey: string | null;
  name: string;
  writerId: string;
  segNo: number;
}

/**
 * 解析段相对路径（同时接受 v1/v2 布局）。
 * 形状非法、日期非法、文件名非法或 sessionKey 非法时返回 null。
 */
export function parseSegmentRelativePath(relPath: string): SegmentRelPathParts | null {
  if (typeof relPath !== 'string' || relPath.length === 0) return null;
  const normalized = relPath.replace(/\\/g, '/');
  let day: string | null = null;
  let sessionKey: string | null = null;
  let name: string | null = null;
  const v2 = V2_SEGMENT_REL_RE.exec(normalized);
  if (v2 !== null) {
    day = v2[1];
    sessionKey = v2[2];
    name = v2[3];
    if (!isSessionKey(sessionKey)) return null;
  } else {
    const v1 = V1_SEGMENT_REL_RE.exec(normalized);
    if (v1 === null) return null;
    day = v1[1];
    name = v1[2];
  }
  if (!isDateString(day)) return null;
  const parsedName = parseSegmentFileName(name);
  if (parsedName === null) return null;
  return {
    relPath: sessionKey === null ? `${SEGMENTS_DIR_NAME}/${day}/${name}` : `${SEGMENTS_DIR_NAME}/${day}/${sessionKey}/${name}`,
    day,
    sessionKey,
    name,
    writerId: parsedName.writerId,
    segNo: parsedName.segNo,
  };
}

/** 相对段路径 -> 绝对路径（防止 manifest 中的路径穿越；接受 v1/v2 布局） */
export function absoluteFromRelative(paths: VaultPaths, relPath: string): string {
  const parts = parseSegmentRelativePath(relPath);
  if (parts === null) {
    throw new RangeError(`[dsh-life-memory] invalid segment relative path: ${relPath}`);
  }
  const absolute = resolve(paths.rootDir, ...parts.relPath.split('/'));
  const rel = relative(paths.rootDir, absolute);
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new RangeError(`[dsh-life-memory] segment path escapes vault root: ${relPath}`);
  }
  return absolute;
}

/** 绝对路径 -> 相对 vault root 的 posix 路径（用于 manifest） */
export function relativeFromAbsolute(paths: VaultPaths, absolute: string): string {
  return relative(paths.rootDir, absolute).split(sep).join('/');
}

/** 校验 writerId（接受 'w1a2b3c' 或 '1a2b3c'，统一返回 6 位小写十六进制） */
export function normalizeWriterId(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().toLowerCase().replace(/^w/, '');
  return WRITER_ID_RE.test(trimmed) ? trimmed : null;
}

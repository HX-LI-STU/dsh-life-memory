// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hanxustu (dsh-life-memory)
/**
 * L2 情景记忆层：把 L1 原子按「会话 + 时间窗」聚合成情节摘要（docs/20 §9.2.3 / §9.4）。
 *
 * 切窗规则（三者任一即切，实现逐条照做）：
 * 1. 相邻 atom 时间差 > 30 min；
 * 2. 窗口内 atom 数达 20；
 * 3. 会话结束（`reason==='session_end'` / rebuild 全量重放）。
 * 窗口最短 2 条；整个会话只有 1 条时在 session_end 仍生成 episode 并标 `meta.short=true`。
 *
 * 摘要模板（docs §9.4-3，**禁止读当前时间/随机数**，全部来自输入）：
 *   `"{day} 会话（{workspace}）：讨论了 {keywords}；用户关注：{firstUser}；最后进展：{lastMsg}。"`
 * - 去重：同会话已有 episode 且 `meta.windowKey` 相同 → 跳过（幂等）；
 *   否则若文本 3-gram Jaccard ≥ 0.8 → 更新原 episode（revision++ + 快照）。
 * - 私有行：`layer_l2_episodes`（topic/startTs/endTs/turnCount/rawFirstId/rawLastId/pageIds），
 *   通过 `writeSidecar` 与 memory_records 在**同一事务**写入。
 */
import type {
  DeriveContext,
  DeriveInput,
  L2EpisodeRow,
  MemoryRecord,
  NewMemoryRecord,
  RawRecord,
} from '../core/contracts.ts';
import { deriveMemoryId } from '../core/ids.ts';
import { isL1Atom } from './l1-episode.ts';
import type { InternalLayerDefinition, LayerWriteItem } from './registry.ts';
import {
  L2_LAYER_ID,
  basenameOf,
  clamp01,
  compareStrings,
  computeHeat,
  configTimezone,
  dayString,
  firstChars,
  jaccard3gram,
  normalizeTags,
  pushUnique,
  rawTagValue,
  topKeywords,
} from './util.ts';

/** 会话空闲切窗阈值（30 min，docs §4.3 / §9.2.3） */
export const L2_IDLE_MS = 30 * 60_000;
/** 窗口内 atom 数上限（20） */
export const L2_WINDOW_MAX_ATOMS = 20;
/** 窗口最少 atom 数（2；唯一例外见 short episode） */
export const L2_WINDOW_MIN_ATOMS = 2;
/** 近重复 episode 的 3-gram Jaccard 阈值（0.8） */
export const L2_DEDUP_JACCARD = 0.8;
/** L2 抽取器 id（docs §9.2 表：sum:extractive@1） */
export const L2_EXTRACTOR = 'sum:extractive@1';
/** L2 重要度基线（docs §9.3 base(episode)=0.50） */
export const L2_IMPORTANCE_BASE = 0.5;
/** 单次 L2 派生最多处理的会话数（防御异常输入） */
const MAX_SESSIONS_PER_RUN = 64;
/** 单会话/全库扫描的 L1/L2 记录上限（防全表载入；窗口在最近这些记录内聚合） */
const MAX_SCAN_MEMORIES = 5000;

/** 决策词（命中 +0.10 重要度，docs §9.2.3-5） */
const DECISION_RE = /决定|结论|方案|改为|采用|确定用|最终|decided|conclusion|decision|chose|adopt/i;
/** 错误/失败迹象（命中 +0.05 重要度） */
const ERROR_RE = /错误|失败|报错|异常|error|failed|failure|exception|timeout/i;

/** atom 的展示时间：优先 createdAt，其次 validFrom */
function atomTs(atom: MemoryRecord): number {
  return typeof atom.createdAt === 'number' ? atom.createdAt : (atom.validFrom ?? 0);
}

/** atom 排序：createdSeq → createdAt → id（确定性） */
function sortAtoms(atoms: readonly MemoryRecord[]): MemoryRecord[] {
  return [...atoms].sort(
    (a, b) =>
      (a.createdSeq ?? 0) - (b.createdSeq ?? 0) ||
      atomTs(a) - atomTs(b) ||
      compareStrings(a.id, b.id),
  );
}

/** atom 角色（L1 tags/meta 中的 role） */
function atomRole(atom: MemoryRecord): string | null {
  const meta = atom.meta ?? {};
  if (typeof meta.role === 'string' && meta.role.length > 0) return meta.role;
  for (const tag of atom.tags ?? []) {
    if (typeof tag === 'string' && tag.startsWith('role:')) return tag.slice(5);
  }
  return null;
}

/** 是否用户消息 atom */
function isUserAtom(atom: MemoryRecord): boolean {
  return atomRole(atom) === 'user' || (atom.tags ?? []).includes('role:user');
}

/** 是否助手/用户消息（用于"最后进展"） */
function isConversationalAtom(atom: MemoryRecord): boolean {
  const role = atomRole(atom);
  return role === 'user' || role === 'assistant';
}

/** 会话窗口（atoms 已按 seq 升序） */
export interface L2WindowInfo {
  atoms: MemoryRecord[];
  startTs: number;
  endTs: number;
  /** 会话只有单条 atom 时的短窗口（docs §9.2.3-2） */
  short: boolean;
}

/**
 * 切窗（纯函数，确定性）：输入按 seq 升序的 L1 原子，输出应物化的窗口。
 * @param options.sessionEnded 会话结束/rebuild（允许物化最后一个未闭合窗口）
 * @param options.now 当前时间（用于空闲判定，不进入文本）
 */
export function buildL2Windows(
  atoms: readonly MemoryRecord[],
  options: { sessionEnded: boolean; now: number },
): L2WindowInfo[] {
  const sorted = [...atoms];
  if (sorted.length === 0) return [];
  const rawWindows: MemoryRecord[][] = [];
  let current: MemoryRecord[] = [];
  for (const atom of sorted) {
    if (current.length > 0) {
      const prev = current[current.length - 1];
      const gap = atomTs(atom) - atomTs(prev);
      if (gap > L2_IDLE_MS || current.length >= L2_WINDOW_MAX_ATOMS) {
        rawWindows.push(current);
        current = [];
      }
    }
    current.push(atom);
  }
  if (current.length > 0) rawWindows.push(current);

  const windows: L2WindowInfo[] = [];
  rawWindows.forEach((window, index) => {
    const isLast = index === rawWindows.length - 1;
    const lastAtom = window[window.length - 1];
    const closedByCount = window.length >= L2_WINDOW_MAX_ATOMS;
    const closedByIdle = options.now - atomTs(lastAtom) >= L2_IDLE_MS;
    if (isLast && !options.sessionEnded && !closedByCount && !closedByIdle) return; // 仍在进行中的窗口：等下次触发
    const startTs = Math.min(...window.map(atomTs));
    const endTs = Math.max(...window.map(atomTs));
    if (window.length < L2_WINDOW_MIN_ATOMS) {
      // 窗口最短 2 条；唯一例外：整个会话只有 1 条且在 session_end 时生成 short episode
      if (options.sessionEnded && sorted.length === 1) {
        windows.push({ atoms: window, startTs, endTs, short: true });
      }
      return;
    }
    windows.push({ atoms: window, startTs, endTs, short: false });
  });
  return windows;
}

/** 窗口内 raw id 并集（去重保序） */
function windowRawIds(atoms: readonly MemoryRecord[]): string[] {
  const ids: string[] = [];
  for (const atom of atoms) {
    for (const rawId of atom.sourceRawIds ?? []) {
      if (typeof rawId === 'string' && rawId.length > 0 && !ids.includes(rawId)) ids.push(rawId);
    }
  }
  return ids;
}

/** 窗口内 turnId 去重数 */
function windowTurnCount(atoms: readonly MemoryRecord[]): number {
  const turnIds = new Set<string>();
  for (const atom of atoms) {
    const meta = atom.meta ?? {};
    const turnId = typeof meta.turnId === 'string' ? meta.turnId : null;
    if (turnId) turnIds.add(turnId);
  }
  return turnIds.size;
}

/** L2 抽取式摘要结果（纯函数输出，便于单测） */
export interface L2Summary {
  text: string;
  topic: string;
  summary: string;
  keywords: string[];
  firstUser: string;
  lastMsg: string;
  day: string;
  workspaceLabel: string;
}

/**
 * 抽取式摘要（docs §9.4）：
 * 首条用户消息前 120 字符 + 最后一条助手/用户消息前 120 字符 + Top6 TF 关键词。
 * 禁止读当前时间/随机数（day/workspace 均来自输入）。
 */
export function summarizeL2Window(
  atoms: readonly MemoryRecord[],
  options: { timezone: string },
): L2Summary {
  const texts = atoms.map((atom) => atom.text ?? '').filter((text) => text.length > 0);
  const keywords = topKeywords(texts, 6);
  const topicKeywords = keywords.slice(0, 2);
  const topic = topicKeywords.length > 0 ? topicKeywords.join('、') : '未命名窗口';
  const firstUserAtom = atoms.find(isUserAtom) ?? atoms[0];
  const lastConversational = [...atoms].reverse().find(isConversationalAtom) ?? atoms[atoms.length - 1];
  const firstUser = firstChars(firstUserAtom?.text ?? '', 120) || '（无用户消息）';
  const lastMsg = firstChars(lastConversational?.text ?? '', 120) || '（无后续消息）';
  const workspaceRaw = atoms[0]?.workspace ?? null;
  const workspaceLabel = basenameOf(workspaceRaw) ?? '未知工作区';
  const day = dayString(atomTs(atoms[0]), options.timezone);
  const keywordText = keywords.length > 0 ? keywords.join('、') : '（无关键词）';
  const text = `${day} 会话（${workspaceLabel}）：讨论了 ${keywordText}；用户关注：${firstUser}；最后进展：${lastMsg}。`;
  return { text, topic, summary: topic, keywords, firstUser, lastMsg, day, workspaceLabel };
}

/** 窗口重要度（docs §9.2.3-5：0.50 + 0.10 决策词 + 0.10 turnCount≥10 + 0.05 错误） */
export function computeL2Importance(atoms: readonly MemoryRecord[]): number {
  const joined = atoms.map((atom) => atom.text ?? '').join('\n');
  let value = L2_IMPORTANCE_BASE;
  if (DECISION_RE.test(joined)) value += 0.1;
  if (windowTurnCount(atoms) >= 10) value += 0.1;
  const hasError =
    atoms.some((atom) => (atom.tags ?? []).includes('is-error')) || ERROR_RE.test(joined);
  if (hasError) value += 0.05;
  return clamp01(value);
}

/** 是否会话结束迹象（pending raw 里出现 session 结束类事件；host 生命周期缺失时的兜底） */
function detectsSessionEnd(raws: readonly RawRecord[], sessionId: string): boolean {
  for (const raw of raws) {
    if (raw.sessionId !== sessionId) continue;
    if (raw.kind !== 'session' && raw.kind !== 'event' && raw.kind !== 'system') continue;
    const payload = raw.payload;
    if (payload === null || typeof payload !== 'object') continue;
    const type = typeof (payload as Record<string, unknown>).type === 'string'
      ? String((payload as Record<string, unknown>).type)
      : '';
    if (/session(?:\/|:)?(?:end|stop|close|archive)/i.test(type)) return true;
  }
  return false;
}

/** 从新到旧的最近 L1 原子中取受影响会话（timer/manual 触发时用） */
function recentSessions(atoms: readonly MemoryRecord[], now: number): string[] {
  const sessions: string[] = [];
  for (const atom of atoms) {
    if (!isL1Atom(atom)) continue;
    const sessionId = atom.sessionId ?? '';
    if (sessionId.length === 0) continue;
    // 只关心"可能还没闭合"的会话：最近一次 atom 在 30 min 内，或尚未有 L2 覆盖由窗口键兜底
    if (now - atomTs(atom) > L2_IDLE_MS * 2) continue;
    if (!sessions.includes(sessionId)) sessions.push(sessionId);
    if (sessions.length >= MAX_SESSIONS_PER_RUN) break;
  }
  return sessions;
}

interface EpisodeMeta {
  windowKey: string;
  topic: string;
  startTs: number;
  endTs: number;
  turnCount: number;
  rawFirstId: string | null;
  rawLastId: string | null;
  pageMemoryIds: string[];
  atomCount: number;
  short: boolean;
  keywords: string[];
  importance: number;
  heat: number;
  extractor: string;
}

/** 由窗口构造一条 L2 episode 候选（纯函数；id 由 windowKey 决定，rebuild 稳定） */
export function buildL2EpisodeRecord(
  sessionId: string,
  window: L2WindowInfo,
  options: { now: number; timezone: string; existingId?: string; existingRevisionBase?: number },
): NewMemoryRecord {
  const atoms = window.atoms;
  const summary = summarizeL2Window(atoms, { timezone: options.timezone });
  const rawIds = windowRawIds(atoms);
  const pageMemoryIds = atoms.map((atom) => atom.id);
  const turnCount = windowTurnCount(atoms);
  const importance = computeL2Importance(atoms);
  const windowKey = `${sessionId}:${window.startTs}-${window.endTs}`;
  const createdAt = window.endTs;
  const heat = computeHeat({
    now: options.now,
    updatedAt: createdAt,
    accessCount: 0,
    importance,
    distinctSourceCount: rawIds.length,
    halfLifeDays: 14, // L2 halfLife = 14d（docs §4.3）
  });
  const workspace = atoms[0]?.workspace ?? null;
  const workspaceTag = basenameOf(workspace);
  // 人格归属（v4）：窗口内全部来源同人格 → 该人格；混合/含共享 → null（共享）
  const personaIds = new Set(
    atoms.map((atom) => (typeof atom.personaId === 'string' && atom.personaId.length > 0 ? atom.personaId : null)),
  );
  const personaId = personaIds.size === 1 ? [...personaIds][0] : null;
  const tags: string[] = ['episode', `source:${L2_EXTRACTOR}`, `session:${sessionId}`];
  if (workspaceTag) tags.push(`workspace:${workspaceTag}`);
  if (window.short) tags.push('short');
  const meta: EpisodeMeta = {
    windowKey,
    topic: summary.topic,
    startTs: window.startTs,
    endTs: window.endTs,
    turnCount,
    rawFirstId: rawIds.length > 0 ? rawIds[0] : null,
    rawLastId: rawIds.length > 0 ? rawIds[rawIds.length - 1] : null,
    pageMemoryIds,
    atomCount: atoms.length,
    short: window.short,
    keywords: summary.keywords,
    importance,
    heat,
    extractor: L2_EXTRACTOR,
  };
  const id =
    options.existingId ??
    deriveMemoryId(L2_LAYER_ID, 'episode', window.startTs, windowKey);
  return {
    id,
    layer: L2_LAYER_ID,
    kind: 'episode',
    text: summary.text,
    summary: summary.summary,
    importance,
    confidence: 0.7,
    sourceRawIds: rawIds,
    sessionId,
    workspace,
    personaId,
    tags: normalizeTags(tags),
    createdAt,
    validFrom: window.startTs,
    validTo: null,
    createdSeq: Math.max(...atoms.map((atom) => atom.createdSeq ?? 0)),
    meta: meta as unknown as Record<string, unknown>,
  };
}

/** 建立已有 episode 索引：windowKey 集合（幂等跳过）+ 会话 → 记录（近重复更新） */
interface ExistingEpisodes {
  windowKeys: Set<string>;
  bySession: Map<string, MemoryRecord[]>;
}

function indexExistingEpisodes(episodes: readonly MemoryRecord[]): ExistingEpisodes {
  const windowKeys = new Set<string>();
  const bySession = new Map<string, MemoryRecord[]>();
  for (const episode of episodes) {
    if (episode.layer !== L2_LAYER_ID || episode.kind !== 'episode') continue;
    const key = (episode.meta ?? {}).windowKey;
    if (typeof key === 'string' && key.length > 0) windowKeys.add(key);
    const sessionId = episode.sessionId ?? '';
    if (sessionId.length > 0) {
      const list = bySession.get(sessionId) ?? [];
      list.push(episode);
      bySession.set(sessionId, list);
    }
  }
  return { windowKeys, bySession };
}

/** 同会话近重复 episode（字符 3-gram Jaccard ≥ 0.8；docs §9.2.3-6） */
function findNearDuplicate(
  candidates: readonly MemoryRecord[] | undefined,
  text: string,
): MemoryRecord | null {
  if (!candidates) return null;
  let best: MemoryRecord | null = null;
  let bestScore = 0;
  for (const episode of candidates) {
    const score = jaccard3gram(episode.text ?? '', text);
    if (score >= L2_DEDUP_JACCARD && score > bestScore) {
      best = episode;
      bestScore = score;
    }
  }
  return best;
}

/** 由 episode 候选的 meta 组装 layer_l2_episodes 行（sidecar 用） */
function episodeRow(memoryId: string, record: NewMemoryRecord): L2EpisodeRow | null {
  const meta = (record.meta ?? {}) as unknown as Partial<EpisodeMeta>;
  if (typeof meta.windowKey !== 'string') return null;
  return {
    memoryId,
    sessionId: record.sessionId ?? null,
    topic: typeof meta.topic === 'string' ? meta.topic : null,
    startTs: typeof meta.startTs === 'number' ? meta.startTs : (record.validFrom ?? 0),
    endTs: typeof meta.endTs === 'number' ? meta.endTs : (record.createdAt ?? 0),
    turnCount: typeof meta.turnCount === 'number' ? meta.turnCount : 0,
    rawFirstId: typeof meta.rawFirstId === 'string' ? meta.rawFirstId : null,
    rawLastId: typeof meta.rawLastId === 'string' ? meta.rawLastId : null,
    pageIds: Array.isArray(meta.pageMemoryIds) ? meta.pageMemoryIds : [],
    heat: typeof meta.heat === 'number' ? meta.heat : 0,
    promotedAt: null,
  };
}

/**
 * 创建 L2 层定义。
 * 依赖 L1；触发时机：session_end / timer / capture（L1 有新原子且窗口闭合时）。
 */
export function createL2Layer(): InternalLayerDefinition {
  return {
    id: L2_LAYER_ID,
    name: 'L2 情景记忆层',
    version: 1,
    dependsOn: ['L1'],
    rebuildableFromRaw: true,
    enabled: (config) => config.enabled && config.layers.enabled.includes(L2_LAYER_ID),
    async derive(input: DeriveInput, ctx: DeriveContext): Promise<NewMemoryRecord[]> {
      const now = input.now;
      const timezone = configTimezone(ctx.config);
      const pendingRaws = input.pendingRaws ?? input.raws ?? [];
      const reason = input.reason;

      // ① 受影响会话：新 raw 的会话 ∪ 指定会话 ∪（timer/manual/rebuild 时最近活跃会话）
      const sessions: string[] = [];
      const addSession = (sessionId: string | null | undefined): void => {
        if (typeof sessionId === 'string' && sessionId.length > 0 && !sessions.includes(sessionId)) {
          sessions.push(sessionId);
        }
      };
      for (const raw of pendingRaws) addSession(raw.sessionId);
      if (input.sessionId) addSession(input.sessionId);
      const broadScan = reason === 'timer' || reason === 'manual' || reason === 'rebuild';
      if (broadScan) {
        const recentAtoms = ctx.listLayerMemories('L1', { limit: MAX_SCAN_MEMORIES });
        for (const sessionId of recentSessions(recentAtoms, now)) addSession(sessionId);
      }
      const targets = sessions.slice(0, MAX_SESSIONS_PER_RUN);

      // ② 已有 episode 索引（幂等 + 近重复更新）
      const existing = indexExistingEpisodes(ctx.listLayerMemories('L2', { limit: MAX_SCAN_MEMORIES }));

      const records: NewMemoryRecord[] = [];
      for (const sessionId of targets) {
        const atoms = sortAtoms(
          ctx.listLayerMemories('L1', { sessionId, limit: MAX_SCAN_MEMORIES }).filter(
            (memory) => isL1Atom(memory) && (memory.sessionId ?? '') === sessionId,
          ),
        );
        if (atoms.length === 0) continue;
        const sessionEnded =
          (reason === 'session_end' && input.sessionId === sessionId) ||
          reason === 'rebuild' ||
          detectsSessionEnd(pendingRaws, sessionId);
        const windows = buildL2Windows(atoms, { sessionEnded, now });
        for (const window of windows) {
          const windowKey = `${sessionId}:${window.startTs}-${window.endTs}`;
          if (existing.windowKeys.has(windowKey)) continue; // 幂等：窗口已物化
          const probe = buildL2EpisodeRecord(sessionId, window, { now, timezone });
          const near = findNearDuplicate(existing.bySession.get(sessionId), probe.text);
          const record = near
            ? // 近重复：更新原 episode（revision++ + 快照由 store 负责）
              buildL2EpisodeRecord(sessionId, window, { now, timezone, existingId: near.id })
            : probe;
          records.push(record);
          existing.windowKeys.add(windowKey);
        }
      }
      return records;
    },
    writeSidecar(ctx: DeriveContext, items: readonly LayerWriteItem[]): void {
      for (const item of items) {
        if (item.record.layer !== L2_LAYER_ID || item.record.kind !== 'episode') continue;
        const row = episodeRow(item.stored.id, item.record);
        if (row) ctx.store.putL2Episode(row);
      }
    },
  };
}

/** 由 raw 事件推断 phase 的便捷导出（保留给扩展层/测试） */
export function compactionPhase(raw: RawRecord): string | null {
  return rawTagValue(raw, 'phase:');
}

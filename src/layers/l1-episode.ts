// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hanxustu (dsh-life-memory)
/**
 * L1 工作记忆层：raw → atom（docs/20 §9.2.1，逐条照做）。
 *
 * 规则摘要：
 * | raw kind | 是否生成 atom | text | importance 基线 |
 * | user | ✅ | 规范化 raw.text | 0.35 |
 * | assistant | ✅ | raw.text；空则 `tool: <name1>,<name2>` | 0.30 |
 * | tool_call | ✅ | `<toolName>(<参数 JSON 前 200 字符>)` | 0.25 |
 * | tool_result | ✅ | 结果文本前 2000 字符（完整在 raw） | 0.30（isError 0.45） |
 * | session/system/event | 仅 text 非空 | 原样 | 0.30 |
 * | compaction | ✅ | 压缩前摘要/文本 | 0.60 |
 * | note（memory_save） | ✅ | 原样 | 0.90 |
 * | turn | ❌（结构性事件） | — | — |
 *
 * - 一条 raw 最多 1 条 atom；`createdAt=raw.ts`、`createdSeq=raw.seq`、
 *   `sourceRawIds=[raw.id]`、`sessionId/workspace` 取自 raw；
 * - 确定性 id：`deriveMemoryId('L1','atom', raw.ts, raw.id)`，重建逐字节可复现；
 * - 相同内容（同层同 kind 同 text）命中 store 的重述去重，不产生重复行。
 */
import type {
  DeriveContext,
  DeriveInput,
  MemoryRecord,
  NewMemoryRecord,
  RawRecord,
} from '../core/contracts.ts';
import { deriveMemoryId } from '../core/ids.ts';
import { contentHash } from '../core/hash.ts';
import { estimateTokens } from '../core/text.ts';
import type { InternalLayerDefinition } from './registry.ts';
import {
  L1_LAYER_ID,
  asRecord,
  asString,
  isToolNoise,
  normalizeDerivedText,
  normalizeTags,
  pushUnique,
  rawHasTag,
  rawTagValue,
  scoreImportance,
  sortRawsBySeq,
  truncateChars,
} from './util.ts';

/** L1 抽取器版本（docs/20 §9.2 表：seg:turn-v1） */
export const L1_EXTRACTOR = 'seg:turn-v1';

/** 工具结果进入 atom 文本的最大字符数（完整原文仍在 L0 / raw 引用） */
export const TOOL_RESULT_TEXT_LIMIT = 2000;

/** 工具调用参数进入 atom 文本的最大字符数 */
export const TOOL_CALL_ARGS_LIMIT = 200;

/** 单条 atom 文本上限（docs §8.1 ≤8KB；超出截断并 meta.truncated） */
const ATOM_TEXT_LIMIT = 8 * 1024;

/** 从 payload 中递归找工具名（assistant 纯工具调用轮的 text 合成用） */
function toolNamesFromPayload(payload: unknown): string[] {
  const names: string[] = [];
  const seen = new Set<string>();
  const walk = (value: unknown, depth: number): void => {
    if (depth > 6 || names.length >= 8) return;
    if (value === null || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      for (const item of value) walk(item, depth + 1);
      return;
    }
    const obj = value as Record<string, unknown>;
    const type = asString(obj.type) ?? asString(obj.kind) ?? '';
    if (/tool[\s_-]?call|tool[\s_-]?use/i.test(type)) {
      const name = asString(obj.name) ?? asString(obj.toolName) ?? asString(obj.tool);
      if (name && !seen.has(name)) {
        seen.add(name);
        names.push(name);
      }
    }
    for (const child of Object.values(obj)) walk(child, depth + 1);
  };
  walk(payload, 0);
  return names;
}

/** 工具调用文本：`<toolName>(<参数 JSON 前 200 字符>)`（docs §9.2.1） */
function toolCallText(raw: RawRecord): string | null {
  const outer = asRecord(raw.payload);
  const payload = asRecord(outer?.data) ?? outer;
  const tagName = rawTagValue(raw, 'tool:');
  const name = asString(payload?.name) ?? tagName ?? null;
  const args =
    asString(payload?.arguments) ??
    (payload && payload.arguments !== undefined && payload.arguments !== null
      ? safeJson(payload.arguments)
      : null);
  if (!name && !args) return normalizeDerivedText(raw.text);
  const argsPart = args !== null && args.length > 0 ? truncateChars(args, TOOL_CALL_ARGS_LIMIT).text : '';
  return `${name ?? 'unknown'}(${argsPart})`;
}

/** 安全 JSON 序列化（失败返回 null，不抛错） */
function safeJson(value: unknown): string | null {
  try {
    return JSON.stringify(value);
  } catch {
    return null;
  }
}

/** 工具结果文本（前 2000 字符） */
function toolResultText(raw: RawRecord): { text: string; truncated: boolean } {
  return truncateChars(normalizeDerivedText(raw.text), TOOL_RESULT_TEXT_LIMIT);
}

/** 压缩事件文本：raw.text 优先，其次 payload 中常见的摘要字段 */
function compactionText(raw: RawRecord): string | null {
  const direct = normalizeDerivedText(raw.text);
  if (direct.length > 0) return direct;
  const payload = asRecord(raw.payload);
  if (!payload) return null;
  for (const key of ['summary', 'text', 'compacted', 'content']) {
    const value = payload[key];
    if (typeof value === 'string' && value.trim().length > 0) return normalizeDerivedText(value);
  }
  const message = asRecord(payload.message);
  if (message) {
    for (const key of ['summary', 'text', 'content']) {
      const value = message[key];
      if (typeof value === 'string' && value.trim().length > 0) return normalizeDerivedText(value);
    }
  }
  return null;
}

interface AtomPlan {
  text: string;
  base: number;
  tags: string[];
  meta: Record<string, unknown>;
  /** 是否工具结果错误（importance 基线 0.45） */
  isError?: boolean;
}

/** 单条 raw → atom 计划（返回 null 表示结构性事件/空文本，跳过） */
export function planL1Atom(raw: RawRecord): AtomPlan | null {
  const tags: string[] = [];
  const meta: Record<string, unknown> = {
    rawKind: raw.kind,
    rawId: raw.id,
    seq: raw.seq,
    role: raw.role ?? null,
    turnId: raw.turnId ?? null,
  };
  if (raw.role) tags.push(`role:${raw.role}`);
  if (raw.turnId) tags.push(`turn:${raw.turnId}`);
  let base = 0.3;
  let text = '';
  let isError = false;

  switch (raw.kind) {
    case 'turn': {
      // 结构性事件：不生成 atom（docs §9.2.1 表未列 turn）
      return null;
    }
    case 'user': {
      text = normalizeDerivedText(raw.text);
      base = 0.35;
      pushUnique(tags, ['role:user']);
      break;
    }
    case 'assistant': {
      text = normalizeDerivedText(raw.text);
      base = 0.3;
      pushUnique(tags, ['role:assistant']);
      if (text.length === 0) {
        // 纯工具调用轮：合成 "tool: <name1>,<name2>"（docs §9.2.1）
        const names = toolNamesFromPayload(raw.payload);
        if (names.length > 0) {
          text = `tool: ${names.join(',')}`;
          meta.synthesized = 'tool-names';
          meta.toolNames = names;
          for (const name of names) pushUnique(tags, [`tool:${name}`]);
        }
      }
      break;
    }
    case 'tool_call': {
      const callText = toolCallText(raw);
      text = normalizeDerivedText(callText);
      base = 0.25;
      pushUnique(tags, ['role:tool']);
      const toolName = rawTagValue(raw, 'tool:') ?? asString(asRecord(raw.payload)?.name);
      if (toolName) {
        pushUnique(tags, [`tool:${toolName}`]);
        meta.toolName = toolName;
      }
      break;
    }
    case 'tool_result': {
      const result = toolResultText(raw);
      text = result.text;
      base = 0.3;
      pushUnique(tags, ['role:tool']);
      if (result.truncated) meta.truncated = true;
      meta.fullTextChars = typeof raw.text === 'string' ? raw.text.length : 0;
      const payload = asRecord(raw.payload);
      const message = payload ? asRecord(payload.message) : null;
      isError = rawHasTag(raw, 'tool-error') || message?.isError === true || payload?.isError === true;
      if (isError) {
        base = 0.45;
        pushUnique(tags, ['is-error']);
        meta.isError = true;
      }
      const toolName = rawTagValue(raw, 'tool:') ?? asString(message?.toolName);
      if (toolName) {
        pushUnique(tags, [`tool:${toolName}`]);
        meta.toolName = toolName;
      }
      const callId = rawTagValue(raw, 'call:');
      if (callId) meta.callId = callId;
      break;
    }
    case 'compaction': {
      const compacted = compactionText(raw);
      if (compacted === null) return null;
      text = compacted;
      base = 0.6;
      meta.kindTag = 'compaction';
      const phase = rawTagValue(raw, 'phase:');
      if (phase) {
        tags.push(`phase:${phase}`);
        meta.phase = phase;
      }
      break;
    }
    case 'note': {
      text = normalizeDerivedText(raw.text);
      base = 0.9;
      pushUnique(tags, ['origin:memory_save']);
      break;
    }
    case 'session':
    case 'system':
    case 'event': {
      // 仅 text 非空时生成（docs §9.2.1）
      text = normalizeDerivedText(raw.text);
      base = 0.3;
      break;
    }
    default: {
      text = normalizeDerivedText(raw.text);
      base = 0.3;
      break;
    }
  }

  if (text.trim().length === 0) return null;
  const truncated = truncateChars(text, ATOM_TEXT_LIMIT);
  text = truncated.text;
  if (truncated.truncated) meta.truncated = true;
  meta.charLen = text.length;
  meta.estTokens = estimateTokens(text);
  tags.push(`rawKind:${raw.kind}`, `source:${L1_EXTRACTOR}`);
  if (rawHasTag(raw, 'interrupted')) tags.push('interrupted');
  return { text, base, tags: normalizeTags(tags), meta, isError };
}

/**
 * 创建 L1 层定义。
 * L1 只依赖 L0（dependsOn=[]），每次 raw 落盘后增量派生。
 */
export function createL1Layer(): InternalLayerDefinition {
  return {
    id: L1_LAYER_ID,
    name: 'L1 工作记忆层',
    version: 1,
    dependsOn: [],
    rebuildableFromRaw: true,
    enabled: (config) => config.enabled && config.layers.enabled.includes(L1_LAYER_ID),
    async derive(input: DeriveInput, ctx: DeriveContext): Promise<NewMemoryRecord[]> {
      const raws = sortRawsBySeq(input.pendingRaws ?? input.raws ?? []);
      interface Winner {
        id: string;
        rawIds: string[];
        firstRaw: RawRecord;
        plan: AtomPlan;
      }
      // 同批内容去重：相同 contentHash 复用首条 id，并把后续 raw 并入溯源列表
      // （store 的 (layer, content_hash) 活跃唯一约束要求同内容只有一行）
      const winnerByHash = new Map<string, Winner>();
      for (const raw of raws) {
        const plan = planL1Atom(raw);
        if (!plan) continue;
        const hash = contentHash(L1_LAYER_ID, 'atom', plan.text);
        const winner = winnerByHash.get(hash);
        if (winner) {
          winner.rawIds.push(raw.id);
          continue;
        }
        winnerByHash.set(hash, {
          id: deriveMemoryId(L1_LAYER_ID, 'atom', raw.ts, raw.id),
          rawIds: [raw.id],
          firstRaw: raw,
          plan,
        });
      }
      const records: NewMemoryRecord[] = [];
      for (const winner of winnerByHash.values()) {
        const { firstRaw, plan } = winner;
        records.push({
          id: winner.id,
          layer: L1_LAYER_ID,
          kind: 'atom',
          text: plan.text,
          summary: null,
          importance: scoreImportance(plan.base, plan.text, {
            isUserMessage: firstRaw.kind === 'user',
            isToolNoise:
              (firstRaw.kind === 'tool_call' || firstRaw.kind === 'tool_result') && isToolNoise(firstRaw.text ?? ''),
          }),
          confidence: 0.95,
          sourceRawIds: [...winner.rawIds],
          sessionId: firstRaw.sessionId,
          workspace: firstRaw.workspace ?? null,
          personaId: ctx.store.getRawIndex(firstRaw.id)?.personaId ?? null,
          tags: plan.tags,
          createdAt: firstRaw.ts,
          validFrom: firstRaw.ts,
          validTo: null,
          createdSeq: firstRaw.seq,
          meta: plan.meta,
        });
      }
      return records;
    },
  };
}

/** 便捷：对单个 raw 生成 L1 记录（测试/调试用；不写库） */
export function buildL1Record(raw: RawRecord): NewMemoryRecord | null {
  const plan = planL1Atom(raw);
  if (!plan) return null;
  return {
    id: deriveMemoryId(L1_LAYER_ID, 'atom', raw.ts, raw.id),
    layer: L1_LAYER_ID,
    kind: 'atom',
    text: plan.text,
    importance: scoreImportance(plan.base, plan.text, {
      isUserMessage: raw.kind === 'user',
      isToolNoise: (raw.kind === 'tool_call' || raw.kind === 'tool_result') && isToolNoise(raw.text ?? ''),
    }),
    confidence: 0.95,
    sourceRawIds: [raw.id],
    sessionId: raw.sessionId,
    workspace: raw.workspace ?? null,
    tags: plan.tags,
    createdAt: raw.ts,
    validFrom: raw.ts,
    createdSeq: raw.seq,
    meta: plan.meta,
  } satisfies NewMemoryRecord;
}

/** 由 L1 原子反查其原始 raw id（取首个溯源；docs §8.3） */
export function atomRawId(memory: MemoryRecord): string | null {
  return Array.isArray(memory.sourceRawIds) && memory.sourceRawIds.length > 0 ? memory.sourceRawIds[0] : null;
}

/** 判断一条记忆是否 L1 原子 */
export function isL1Atom(memory: MemoryRecord): boolean {
  return memory.layer === L1_LAYER_ID && memory.kind === 'atom';
}

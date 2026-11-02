// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hanxustu (dsh-life-memory)
/**
 * 捕获映射器：DSH 会话事件 → L0 原始记录输入（纯函数、可单测、不依赖宿主 API）。
 *
 * 设计要点（对应 docs/20）：
 * - **无损**：`payload` 保存完整事件信封（type/seq/time/data/ignorable/surfaceOp/sourceEventSeqs），
 *   绝不裁剪；`text` 只是给 FTS/嵌入用的规范化文本，丢了也能从 payload 重建。
 * - **每个 SessionEvent 一条原始记录**（含 turn/step/request 等结构事件），满足"应存尽存"。
 * - **幂等键**：优先 `${sessionId}:${seq}`（DSH 事件 seq 在会话内单调且稳定）；
 *   缺失 seq 时退回 docs/20 §6.4 的哈希公式。
 * - **可配置**：capture.* 开关只决定"是否收录该类事件"，默认全开。
 */
import { createHash } from 'node:crypto';
import type { RawKind, RawRecordInput } from '../core/contracts.ts';
import type { CaptureConfig } from '../core/contracts.ts';
import type { DshContentBlockLike, DshMessageLike, DshSessionEventLike, DshSessionLike } from './dsh-types.ts';
import { asMessage, asNumber, asString } from './dsh-types.ts';

/** 单条内容的文本化上限（仅用于 `text` 检索字段；payload 永不截断） */
export const TEXT_FIELD_MAX_CHARS = 200_000;

/** 映射会话元数据（session/created 时写入一条 kind='session' 的原始记录） */
export function sessionHeaderToRawInput(
  session: DshSessionLike,
  options: { timezone: string; now?: number; personaId?: string | null },
): RawRecordInput {
  const now = options.now ?? Date.now();
  const header = session.header ?? ({ createdAt: now } as DshSessionLike['header']);
  return {
    kind: 'session',
    ts: typeof header.createdAt === 'number' ? header.createdAt : now,
    timezone: options.timezone,
    sessionId: String(session.id),
    workspace: typeof header.cwd === 'string' ? header.cwd : null,
    text: null,
    // 人格归属：只是索引元数据（raw_index.persona_id），不写入 L0 行、不参与哈希
    personaId: options.personaId ?? null,
    payload: {
      kind: 'session/header',
      id: String(session.id),
      header,
    },
    tags: ['session-header'],
    ingestKey: `${String(session.id)}:header`,
    meta: { eventType: 'session/created' },
  };
}

/** 事件类型 → 原始记录种类 */
export function kindOfEvent(event: DshSessionEventLike): RawKind {
  const type = event.type;
  if (type.startsWith('plugin:')) {
    return /compact/i.test(type) ? 'compaction' : 'event';
  }
  switch (type) {
    case 'user/message':
      return 'user';
    case 'assistant/message':
      return 'assistant';
    case 'assistant/attempt':
      return 'assistant';
    case 'tool/call':
      return 'tool_call';
    case 'tool/result':
      return 'tool_result';
    case 'system/message':
    case 'developer/message':
    case 'request/header':
    case 'request/context':
      return 'system';
    case 'turn/start':
    case 'turn/end':
      return 'turn';
    case 'step/start':
    case 'step/end':
      return 'event';
    case 'session/end-seed':
      return 'event';
    default:
      return 'event';
  }
}

/** 事件类型 → 角色标签 */
export function roleOfEvent(event: DshSessionEventLike): string | null {
  switch (event.type) {
    case 'user/message':
      return 'user';
    case 'assistant/message':
    case 'assistant/attempt':
      return 'assistant';
    case 'tool/call':
    case 'tool/result':
      return 'tool';
    case 'system/message':
    case 'developer/message':
      return 'system';
    default:
      return null;
  }
}

/**
 * 内容块 → 纯文本（保留可见文本与工具调用摘要；图片/文件给占位符）。
 * reasoning 不默认计入 text（噪声大），但完整保留在 payload；可通过 includeReasoning 打开。
 */
export function contentToText(
  blocks: readonly DshContentBlockLike[] | null | undefined,
  options: { includeReasoning?: boolean } = {},
): string | null {
  if (!blocks || blocks.length === 0) return null;
  const parts: string[] = [];
  for (const block of blocks) {
    switch (block.type) {
      case 'text':
        if (typeof block.text === 'string' && block.text.length > 0) parts.push(block.text);
        break;
      case 'reasoning':
        if (options.includeReasoning && typeof block.text === 'string' && block.text.length > 0) {
          parts.push(`[reasoning] ${block.text}`);
        }
        break;
      case 'tool-call':
        parts.push(`[tool_call] ${String(block.name ?? 'unknown')} ${String(block.arguments ?? '')}`.trim());
        break;
      case 'image':
        parts.push('[image]');
        break;
      case 'file':
        parts.push('[file]');
        break;
      case 'tool-addition':
        parts.push(`[tool_addition] ${String(block.toolName ?? '')}`.trim());
        break;
      case 'tool-removal':
        parts.push(`[tool_removal] ${String(block.toolName ?? '')}`.trim());
        break;
      default:
        // 未知块类型：保留一个可检索标记，payload 里有完整内容
        parts.push(`[${String(block.type ?? 'unknown')}]`);
        break;
    }
  }
  if (parts.length === 0) return null;
  const text = parts.join('\n').trim();
  if (text.length === 0) return null;
  return text.length > TEXT_FIELD_MAX_CHARS ? text.slice(0, TEXT_FIELD_MAX_CHARS) : text;
}

/** 从消息取文本 */
function messageText(message: DshMessageLike | null, options?: { includeReasoning?: boolean }): string | null {
  if (!message) return null;
  return contentToText(message.content, options);
}

/** 归一化文本（用于 ingestKey 的回退哈希，与 docs/20 §6.4 对齐） */
function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

/**
 * 计算幂等键。
 * 首选宿主事件 id：`${sessionId}:${seq}`（DSH seq 在会话内单调、稳定、跨重启不变）。
 * 没有 seq 时按 docs/20 §6.4 的公式生成。
 */
export function ingestKeyOf(
  sessionId: string,
  event: Pick<DshSessionEventLike, 'seq' | 'type' | 'time' | 'data'>,
  kind: RawKind,
  role: string | null,
  text: string | null,
): string {
  if (typeof event.seq === 'number' && Number.isFinite(event.seq) && event.seq >= 0) {
    return `${sessionId}:${event.seq}`;
  }
  const turnId = asNumber(event.data.turn);
  const stepId = asNumber(event.data.step);
  const tsBucket = Math.floor((event.time ?? 0) / 1000);
  const digest = sha256Hex(
    [sessionId, `turn=${turnId ?? ''}`, `step=${stepId ?? ''}`, kind, role ?? '', sha256Hex(text ?? ''), `ts=${tsBucket}`].join(
      '|',
    ),
  );
  return `h:${digest}`;
}

export interface MapOptions {
  timezone: string;
  capture: CaptureConfig;
  /** 是否把 assistant 的 reasoning 计入 text（默认 false；payload 始终保留） */
  includeReasoningInText?: boolean;
  /**
   * 当前激活人格 id 的**同步快照**（v4）：写入 `raw_index.persona_id`（索引元数据），
   * 不进入 L0 行、不参与哈希；null = 共享。捕获队列是异步的，调用方必须在钩子触发的
   * 同一 tick 内取快照传入，避免 flush 时已切换人格。
   */
  personaId?: string | null;
}

/** 判断该事件是否按配置需要收录 */
export function shouldCapture(event: DshSessionEventLike, capture: CaptureConfig): boolean {
  const type = event.type;
  if (type === 'user/message') {
    if (!capture.userMessages) return false;
    // 注入型 user 消息（agent.inject / skill / AGENTS.md 等）也属于原始记忆，照常保留
    return true;
  }
  if (type === 'assistant/message' || type === 'assistant/attempt') return capture.assistantMessages;
  if (type === 'tool/call') return capture.toolCalls;
  if (type === 'tool/result') return capture.toolResults;
  return true;
}

/**
 * 核心映射：一个 DSH 会话事件 → 一条 RawRecordInput。
 * @returns null 表示按配置跳过（不会发生"原始数据丢失"以外的语义变化）
 */
export function mapSessionEvent(
  session: DshSessionLike,
  event: DshSessionEventLike,
  options: MapOptions,
): RawRecordInput | null {
  if (!shouldCapture(event, options.capture)) return null;
  const kind = kindOfEvent(event);
  const role = roleOfEvent(event);
  const data = event.data ?? {};
  const turn = asNumber(data.turn);
  const step = asNumber(data.step);
  const workspace = typeof session.header?.cwd === 'string' ? session.header.cwd : null;

  let text: string | null = null;
  const tags: string[] = [];

  switch (event.type) {
    case 'user/message': {
      const message = asMessage(data);
      text = messageText(message, { includeReasoning: false });
      const source = message?.source;
      if (source && source.kind && source.kind !== 'user') {
        tags.push('injected');
        tags.push(`source:${String(source.kind)}`);
      }
      break;
    }
    case 'assistant/message': {
      const message = asMessage(data.message);
      text = messageText(message, { includeReasoning: options.includeReasoningInText === true });
      if (data.interrupted === true) tags.push('interrupted');
      const usage = data.usage;
      if (usage && typeof usage === 'object') tags.push('has-usage');
      break;
    }
    case 'assistant/attempt': {
      tags.push('attempt');
      break;
    }
    case 'system/message':
    case 'developer/message': {
      const message = asMessage(data.message);
      text = messageText(message);
      break;
    }
    case 'tool/call': {
      const name = asString(data.name) ?? 'unknown';
      const args = asString(data.arguments) ?? '';
      text = `[tool_call] ${name} ${args}`.trim();
      tags.push(`tool:${name}`);
      break;
    }
    case 'tool/result': {
      const message = asMessage(data.message);
      text = messageText(message);
      if (message?.isError === true) tags.push('tool-error');
      const callId = asString(data.callId) ?? asString(message?.toolCallId);
      if (callId) tags.push(`call:${callId}`);
      break;
    }
    case 'request/header': {
      tags.push('request-header');
      break;
    }
    case 'request/context': {
      tags.push('request-context');
      break;
    }
    case 'turn/end': {
      const reason = data.reason;
      const kindOfReason =
        reason && typeof reason === 'object' && typeof (reason as { kind?: unknown }).kind === 'string'
          ? String((reason as { kind: string }).kind)
          : null;
      if (kindOfReason) tags.push(`turn-end:${kindOfReason}`);
      break;
    }
    default: {
      if (event.type.startsWith('plugin:')) tags.push('plugin-record');
      break;
    }
  }

  const ingestKey = ingestKeyOf(String(session.id), event, kind, role, text);

  return {
    kind,
    ts: typeof event.time === 'number' && Number.isFinite(event.time) ? event.time : Date.now(),
    timezone: options.timezone,
    sessionId: String(session.id),
    workspace,
    turnId: turn !== null ? String(turn) : null,
    stepId: step !== null ? String(step) : null,
    role,
    text,
    // 人格归属（索引元数据；null = 共享）
    personaId: options.personaId ?? null,
    // 完整事件信封：无损保存（含 data/surfaceOp/sourceEventSeqs/ignorable）
    payload: event,
    tags: tags.length > 0 ? tags : undefined,
    ingestKey,
    meta: {
      eventType: event.type,
      ...(event.surfaceOp !== undefined ? { surfaceOp: event.surfaceOp } : {}),
      ...(event.sourceEventSeqs !== undefined ? { sourceEventSeqs: event.sourceEventSeqs } : {}),
      ...(event.ignorable !== undefined ? { ignorable: event.ignorable } : {}),
    },
  };
}

/**
 * 批量映射（跳过 excluded workspace）。
 * 排除规则：workspace 以某个 excludeWorkspaces 前缀开头（大小写不敏感，Windows 语义）。
 */
export function mapSessionEvents(
  session: DshSessionLike,
  events: readonly DshSessionEventLike[],
  options: MapOptions,
): RawRecordInput[] {
  const workspace = typeof session.header?.cwd === 'string' ? session.header.cwd : null;
  if (workspace && isExcludedWorkspace(workspace, options.capture.excludeWorkspaces)) return [];
  const out: RawRecordInput[] = [];
  for (const event of events) {
    const input = mapSessionEvent(session, event, options);
    if (input) out.push(input);
  }
  return out;
}

/** workspace 是否被排除（前缀匹配，路径分隔符归一） */
export function isExcludedWorkspace(workspace: string, excludes: readonly string[]): boolean {
  if (excludes.length === 0) return false;
  const normalize = (p: string): string => p.replace(/[\\/]+/g, '/').replace(/\/+$/, '').toLowerCase();
  const ws = normalize(workspace);
  return excludes.some((entry) => {
    const prefix = normalize(entry);
    return prefix.length > 0 && (ws === prefix || ws.startsWith(`${prefix}/`));
  });
}

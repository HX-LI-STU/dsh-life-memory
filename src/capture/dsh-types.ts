// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hanxustu (dsh-life-memory)
/**
 * DSH 宿主事件的结构化子集（不 import SDK，保证核心逻辑可脱离宿主单测）。
 *
 * 这些形状来自 `@deepseek-ai/dsh-session@0.2.1-rc.3` / `@deepseek-ai/dsh-llm@0.2.1-rc.3`
 * 的类型定义（见 docs/10-dsh-plugin-api.md）。宿主集成层负责把真实对象按结构传入；
 * 未知字段一律保留到 `payload`，不做裁剪（原始记忆全保留）。
 */

/** DSH 会话头（会话元数据，不在事件日志里） */
export interface DshSessionHeaderLike {
  readonly version?: number;
  readonly createdAt: number;
  readonly cwd?: string;
  readonly parentSession?: string;
  readonly isSeeded?: boolean;
  readonly origin?: 'subagent';
  readonly delegationDepth?: number;
  readonly agentPreset?: string;
}

/** DSH 会话对象（最小结构） */
export interface DshSessionLike {
  readonly id: string;
  readonly header: DshSessionHeaderLike;
  /** 下一个事件 seq（= 日志长度），可能没有 */
  readonly seq?: number;
}

/** DSH 内容块（text / reasoning / image / file / tool-call / tool-addition / tool-removal） */
export interface DshContentBlockLike {
  readonly type: string;
  readonly text?: string;
  readonly id?: string;
  readonly name?: string;
  readonly arguments?: string;
  readonly toolName?: string;
  readonly attachment?: unknown;
  readonly [key: string]: unknown;
}

/** DSH 消息（user/assistant/system/developer/tool） */
export interface DshMessageLike {
  readonly id?: string;
  readonly role: string;
  readonly content: readonly DshContentBlockLike[];
  readonly source?: Record<string, unknown>;
  readonly toolCallId?: string;
  readonly isError?: boolean;
}

/**
 * DSH 会话事件（SessionEvent 的结构子集）。
 * 未列出的字段（surfaceOp/sourceEventSeqs/ignorable/...）全部原样保存在 payload。
 */
export interface DshSessionEventLike {
  readonly type: string;
  readonly seq: number;
  readonly time: number;
  readonly data: Record<string, unknown>;
  readonly ignorable?: true;
  readonly surfaceOp?: unknown;
  readonly sourceEventSeqs?: readonly number[];
}

/** 从事件 data 里安全取对象 */
export function asMessage(value: unknown): DshMessageLike | null {
  if (!value || typeof value !== 'object') return null;
  const msg = value as DshMessageLike;
  return Array.isArray(msg.content) ? msg : null;
}

/** 从事件 data 里安全取数字 */
export function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** 从事件 data 里安全取字符串 */
export function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

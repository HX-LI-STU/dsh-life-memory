// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hanxustu (dsh-life-memory)
/**
 * 把 17 个工具注册到 DSH 的工具注册表（宿主无关的可测适配层）。
 *
 * ToolDefinition（docs/10 §4.1）：{ name, description, parameters, output:{schema, render}, execute }。
 * 注意 JSON Schema 受限子集：type 必须是单字符串；object 必须显式 additionalProperties。
 */
import type { ToolContext } from './handlers.ts';
import { handleTool } from './handlers.ts';
import { TOOL_DEFINITIONS } from './schemas.ts';
import type { ToolDefinition } from './schemas.ts';
import type { Logger } from '../core/contracts.ts';

/** DSH ToolRuntime 的最小子集（便于测试注入 fake） */
export interface ToolRegistryLike {
  register(definition: Record<string, unknown>): () => void;
}

export interface RegisterToolsOptions {
  /** 每次执行时构造 ToolContext（可反映最新运行时状态；v5 允许异步按会话解析记忆库） */
  getContext: (args?: unknown) => ToolContext | Promise<ToolContext>;
  logger: Logger;
}

/** 输出 schema：工具结果形状因工具而异，使用开放对象（受限 schema 允许 additionalProperties:true） */
const OUTPUT_SCHEMA = { type: 'object', additionalProperties: true } as const;

/** 构造一个 DSH 原生 ToolDefinition（纯数据，方便单测断言） */
export function buildToolDefinition(definition: ToolDefinition, options: RegisterToolsOptions): Record<string, unknown> {
  return {
    name: definition.name,
    description: definition.description,
    parameters: definition.inputSchema,
    output: {
      schema: OUTPUT_SCHEMA,
      render: (_args: unknown, value: unknown) => [
        { type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) },
      ],
    },
    execute: async (args: unknown) => {
      const ctx = await options.getContext(args);
      const result = await handleTool(definition.name, args, ctx);
      if (!result.ok) options.logger.warn(`tool ${definition.name} failed: ${result.error.code} ${result.error.message}`);
      return result;
    },
  };
}

/** 注册全部 5 个工具，返回聚合 disposer */
export function registerMemoryTools(registry: ToolRegistryLike, options: RegisterToolsOptions): () => void {
  const disposers: Array<() => void> = [];
  for (const definition of TOOL_DEFINITIONS) {
    try {
      disposers.push(registry.register(buildToolDefinition(definition, options)));
    } catch (error) {
      options.logger.error(`register tool ${definition.name} failed`, error);
    }
  }
  return () => {
    for (const dispose of disposers.reverse()) {
      try {
        dispose();
      } catch (error) {
        options.logger.warn('tool disposer failed', error);
      }
    }
  };
}

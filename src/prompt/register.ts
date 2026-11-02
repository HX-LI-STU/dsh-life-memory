// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hanxustu (dsh-life-memory)
/**
 * 把"稳定画像块"注册为 DSH system prompt section（宿主无关适配层）。
 *
 * 关键点（docs/10 §5）：
 * - `text` provider 是同步函数（不能 await）；因此这里维护一份缓存字符串，
 *   在后台 refresh() 中异步计算，provider 只返回最近一次结果。
 * - order 用 HARNESS_SOURCE + 50，避免与内置区块撞号。
 */
import type { Logger } from '../core/contracts.ts';
import type { PromptSectionBuilder } from './section.ts';

/** SystemPrompt 服务的最小子集 */
export interface PromptRegistryLike {
  section(section: {
    name: string;
    order: number;
    text: () => string;
    interpolate?: boolean;
  }): () => void;
  getSectionOrder(name: string): number;
}

export interface PromptRegistrationOptions {
  name?: string;
  logger: Logger;
  /** 追加到 HARNESS_SOURCE 之后的偏移 */
  orderOffset?: number;
  /** 首次构建是否阻塞 */
  refreshOnRegister?: boolean;
}

export interface PromptRegistration {
  /** 强制重算注入块（L3 变更/派生完成/重建后调用） */
  refresh(): Promise<void>;
  /** 当前缓存内容（测试/诊断用） */
  current(): string;
  dispose(): void;
}

export function registerPromptSection(
  registry: PromptRegistryLike,
  builder: PromptSectionBuilder,
  options: PromptRegistrationOptions,
): PromptRegistration {
  const name = options.name ?? 'dsh-life-memory:profile';
  const offset = options.orderOffset ?? 50;
  let cached = '';
  let disposed = false;
  let refreshing: Promise<void> | null = null;

  const baseOrder = (() => {
    try {
      return registry.getSectionOrder('HARNESS_SOURCE');
    } catch {
      return 10_000;
    }
  })();

  const dispose = registry.section({
    name,
    order: baseOrder + offset,
    text: () => (disposed ? '' : cached),
    interpolate: false,
  });

  const refresh = (): Promise<void> => {
    if (disposed) return Promise.resolve();
    if (refreshing) return refreshing;
    refreshing = builder
      .build()
      .then((text) => {
        cached = text;
      })
      .catch((error) => {
        options.logger.warn('prompt section refresh failed', error);
      })
      .finally(() => {
        refreshing = null;
      });
    return refreshing;
  };

  if (options.refreshOnRegister !== false) void refresh();

  return {
    refresh,
    current: () => cached,
    dispose: () => {
      disposed = true;
      try {
        dispose();
      } catch {
        /* ignore */
      }
    },
  };
}

// ---------------------------------------------------------------------------
// v5：按会话/记忆库切换的动态 section
// ---------------------------------------------------------------------------

/** v5：动态注入块构建器（每个会话/库一份缓存，避免串会话泄漏） */
export interface KeyedPromptBuilder {
  /** 当前 key（同步；text() 用它命中缓存） */
  currentKey(): string;
  /** 构建当前上下文的注入块（异步；返回实际使用的 key + 文本） */
  build(): Promise<{ key: string; text: string }>;
}

export interface KeyedPromptRegistrationOptions extends PromptRegistrationOptions {
  /** 缓存 key 上限（默认 24；超出按插入顺序淘汰最旧） */
  maxEntries?: number;
}

/**
 * 注册按 `currentKey()` 切换的 system prompt section（v5）。
 *
 * 关键点：
 * - `text()` 必须同步：只返回缓存；缓存按 key 隔离，**不会把 A 会话/人格的注入块给 B 会话**；
 * - 集成层在会话切换/人格切换/派生/保留期 tick 后调用 `refresh()`；
 * - 缓存未命中时返回空串（宁可少注入，也不串库）。
 */
export function registerKeyedPromptSection(
  registry: PromptRegistryLike,
  builder: KeyedPromptBuilder,
  options: KeyedPromptRegistrationOptions,
): PromptRegistration {
  const name = options.name ?? 'dsh-life-memory:profile';
  const offset = options.orderOffset ?? 50;
  const maxEntries = Math.max(2, options.maxEntries ?? 24);
  const cache = new Map<string, string>();
  let disposed = false;
  let refreshing: Promise<void> | null = null;

  const baseOrder = (() => {
    try {
      return registry.getSectionOrder('HARNESS_SOURCE');
    } catch {
      return 10_000;
    }
  })();

  const currentKeySafe = (): string => {
    try {
      return builder.currentKey();
    } catch {
      return '';
    }
  };

  const dispose = registry.section({
    name,
    order: baseOrder + offset,
    text: () => (disposed ? '' : (cache.get(currentKeySafe()) ?? '')),
    interpolate: false,
  });

  const refresh = (): Promise<void> => {
    if (disposed) return Promise.resolve();
    if (refreshing) return refreshing;
    refreshing = builder
      .build()
      .then(({ key, text }) => {
        cache.delete(key);
        cache.set(key, text);
        while (cache.size > maxEntries) {
          const oldest = cache.keys().next();
          if (oldest.done) break;
          cache.delete(oldest.value);
        }
      })
      .catch((error) => {
        options.logger.warn('prompt section refresh failed', error);
      })
      .finally(() => {
        refreshing = null;
      });
    return refreshing;
  };

  if (options.refreshOnRegister !== false) void refresh();

  return {
    refresh,
    current: () => cache.get(currentKeySafe()) ?? '',
    dispose: () => {
      disposed = true;
      cache.clear();
      try {
        dispose();
      } catch {
        /* ignore */
      }
    },
  };
}

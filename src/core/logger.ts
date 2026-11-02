// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hanxustu (dsh-life-memory)
/**
 * 轻量日志封装：带前缀/级别，宿主可注入底层 logger（DSH 的 ctx.logger）。
 * 默认输出到 console，绝不抛出（日志失败不能影响记忆写入）。
 */
import type { Logger, LogLevel } from './contracts.ts';

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface LogSink {
  debug(message: string, extra?: unknown): void;
  info(message: string, extra?: unknown): void;
  warn(message: string, extra?: unknown): void;
  error(message: string, extra?: unknown): void;
}

const consoleSink: LogSink = {
  debug: (m, e) => (e === undefined ? console.debug(m) : console.debug(m, e)),
  info: (m, e) => (e === undefined ? console.info(m) : console.info(m, e)),
  warn: (m, e) => (e === undefined ? console.warn(m) : console.warn(m, e)),
  error: (m, e) => (e === undefined ? console.error(m) : console.error(m, e)),
};

export interface LoggerOptions {
  /** 前缀，默认 [dsh-life-memory] */
  prefix?: string;
  /** 最低级别 */
  level?: LogLevel;
  /** 宿主 logger（例如 DSH 的 ctx.logger('dsh-life-memory')） */
  sink?: LogSink;
  /** 额外格式化器（例如脱敏） */
  format?: (message: string, extra?: unknown) => [string, unknown?];
}

export function createLogger(options: LoggerOptions = {}): Logger {
  const prefix = options.prefix ?? '[dsh-life-memory]';
  const min = LEVEL_ORDER[options.level ?? 'info'];
  const sink = options.sink ?? consoleSink;

  const emit = (level: LogLevel, message: string, extra?: unknown): void => {
    if (LEVEL_ORDER[level] < min) return;
    try {
      let msg = `${prefix} ${message}`;
      let payload = extra;
      if (options.format) {
        const [m, e] = options.format(message, extra);
        msg = `${prefix} ${m}`;
        payload = e;
      }
      sink[level](msg, payload);
    } catch {
      /* 日志失败不影响主流程 */
    }
  };

  return {
    debug: (m, e) => emit('debug', m, e),
    info: (m, e) => emit('info', m, e),
    warn: (m, e) => emit('warn', m, e),
    error: (m, e) => emit('error', m, e),
  };
}

export const silentLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

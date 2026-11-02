// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hanxustu (dsh-life-memory)
/**
 * 密钥/隐私脱敏（docs/20 §13.1）。
 *
 * 边界（重要）：
 * - **L0 原始记录永不脱敏**（硬约束：程序不得修改原始记录）。本模块只用于
 *   派生层文本、system prompt 注入、工具返回（memory_get_raw 显式取原文时除外）。
 * - 确定性、无网络、无状态；误伤控制见 docs（长度阈值、Luhn 校验银行卡）。
 */

export interface RedactResult {
  text: string;
  /** 命中的类型（去重，按首次出现顺序）；不记录原文 */
  hits: string[];
}

interface Rule {
  type: string;
  pattern: RegExp;
  replacement: string;
  /** 可选二次校验（如 Luhn） */
  validate?: (match: string) => boolean;
}

/** Luhn 校验（银行卡） */
export function luhnValid(digits: string): boolean {
  if (!/^\d{12,19}$/.test(digits)) return false;
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    let d = digits.charCodeAt(i) - 48;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

const RULES: Rule[] = [
  {
    type: 'private-key',
    pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    replacement: '[REDACTED:private-key]',
  },
  {
    type: 'api-key',
    pattern: /\b(sk-(?:ant-)?[A-Za-z0-9_-]{20,})\b/g,
    replacement: '[REDACTED:api-key]',
  },
  { type: 'aws-key', pattern: /\b(AKIA[0-9A-Z]{16})\b/g, replacement: '[REDACTED:aws-key]' },
  { type: 'github-token', pattern: /\b(gh[pousr]_[A-Za-z0-9]{20,})\b/g, replacement: '[REDACTED:github-token]' },
  {
    type: 'jwt',
    pattern: /\b(eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})\b/g,
    replacement: '[REDACTED:jwt]',
  },
  {
    type: 'credential',
    pattern: /(?<![A-Za-z0-9])(api[_-]?key|secret|token|password|passwd)\b\s*[:=]\s*["']?([^\s"']{8,})/gi,
    replacement: '$1=[REDACTED:credential]',
  },
  {
    type: 'cn-id',
    pattern: /\b([1-9]\d{5}(?:19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3}[\dXx])\b/g,
    replacement: '[REDACTED:cn-id]',
  },
  {
    type: 'card',
    pattern: /\b(\d{16,19})\b/g,
    replacement: '[REDACTED:card]',
    validate: (match) => luhnValid(match),
  },
];

/** 检测文本中是否疑似含密钥/隐私（返回类型列表；不返回原文） */
export function detectSecrets(text: string): string[] {
  if (typeof text !== 'string' || text.length === 0) return [];
  const hits: string[] = [];
  for (const rule of RULES) {
    rule.pattern.lastIndex = 0;
    for (const match of text.matchAll(rule.pattern)) {
      if (rule.validate && !rule.validate(match[0])) continue;
      if (!hits.includes(rule.type)) hits.push(rule.type);
      break;
    }
  }
  return hits;
}

/** 脱敏文本（返回替换后的文本 + 命中类型；用于派生/注入/工具返回） */
export function redactSecrets(text: string): RedactResult {
  if (typeof text !== 'string' || text.length === 0) return { text: text ?? '', hits: [] };
  let out = text;
  const hits: string[] = [];
  for (const rule of RULES) {
    rule.pattern.lastIndex = 0;
    out = out.replace(rule.pattern, (...args) => {
      const match = args[0] as string;
      if (rule.validate && !rule.validate(match)) return match;
      if (!hits.includes(rule.type)) hits.push(rule.type);
      return rule.replacement;
    });
  }
  return { text: out, hits };
}

/** 便捷：按配置决定是否脱敏（关闭时原样返回，但仍返回 hits 便于 UI 高亮） */
export function maybeRedact(text: string, enabled: boolean): RedactResult {
  if (!enabled) return { text, hits: detectSecrets(text) };
  return redactSecrets(text);
}

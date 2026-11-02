// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hanxustu (dsh-life-memory)
/**
 * 客户端小工具：时间/字节/ID 格式化、JSON 安全序列化、剪贴板复制。
 * 不依赖任何外部库。
 */

/** epoch ms -> 本地 `YYYY-MM-DD HH:mm:ss` */
export function formatTime(value: number | null | undefined): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/** epoch ms -> 本地 `HH:mm:ss`（列表用） */
export function formatClock(value: number | null | undefined): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/** 相对时间（中文），用于"最近更新" */
export function formatRelative(value: number | null | undefined, now = Date.now()): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
  const delta = Math.max(0, now - value);
  if (delta < 45_000) return '刚刚';
  const minutes = Math.floor(delta / 60_000);
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} 天前`;
  return formatTime(value);
}

/** 字节数 -> 人类可读 */
export function formatBytes(value: number | null | undefined): string {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return '—';
  if (value < 1024) return `${value} B`;
  const units = ['KiB', 'MiB', 'GiB', 'TiB'];
  let size = value / 1024;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${size >= 100 ? size.toFixed(0) : size.toFixed(1)} ${units[unit]}`;
}

/** 数字千分位 */
export function formatNumber(value: number | null | undefined): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
  return value.toLocaleString('zh-CN');
}

/** 0..1 -> 百分比 */
export function formatPercent(value: number | null | undefined): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
  return `${Math.round(value * 100)}%`;
}

/** 分数（0..1）保留 3 位 */
export function formatScore(value: number | null | undefined): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
  return value.toFixed(3);
}

/** 截断长文本（保留完整内容在详情里） */
export function truncate(text: string | null | undefined, limit: number): string {
  if (!text) return '';
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}…`;
}

/** JSON 安全序列化（循环引用/函数/大对象不抛错） */
export function safeJsonStringify(value: unknown): string {
  try {
    const seen = new WeakSet<object>();
    const text = JSON.stringify(
      value,
      (_key, val: unknown) => {
        if (typeof val === 'object' && val !== null) {
          if (seen.has(val)) return '[Circular]';
          seen.add(val);
        }
        if (typeof val === 'bigint') return `${val.toString()}n`;
        if (typeof val === 'function') return '[Function]';
        return val;
      },
      2,
    );
    return typeof text === 'string' ? text : String(value);
  } catch {
    return String(value);
  }
}

/**
 * 复制文本到剪贴板；返回是否成功（不抛错）。
 *
 * 只用异步 Clipboard API：DSH Web 页面是安全上下文（127.0.0.1/localhost + Electron），
 * 不写 DOM 到组件之外（不 append 到 document.body），失败时由 UI 提示"复制失败"。
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* 权限拒绝/非安全上下文 */
  }
  return false;
}

/** 原始记录 id 形状：`YYYY-MM-DD-NNNNNN` */
export function looksLikeRawId(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}-\d{4,10}$/.test(value);
}

/** 取对象字段的安全读取（用于宽松解析后端 JSON） */
export function pick<T = unknown>(obj: unknown, key: string): T | undefined {
  if (typeof obj === 'object' && obj !== null && key in obj) return (obj as Record<string, T>)[key];
  return undefined;
}

/** 后端 kind 的中文标签 */
export function kindLabel(kind: string | null | undefined): string {
  const map: Record<string, string> = {
    session: '会话',
    turn: '轮次',
    user: '用户',
    assistant: '助手',
    tool_call: '工具调用',
    tool_result: '工具结果',
    system: '系统',
    compaction: '压缩',
    event: '事件',
    note: '备注',
  };
  if (!kind) return '—';
  return map[kind] ?? kind;
}

/** 层标签（L1/L2/L3 通用；扩展层原样显示） */
export function layerLabel(layer: string | null | undefined): string {
  if (!layer) return '—';
  if (layer === 'raw') return 'L0 原始';
  return layer;
}

/**
 * 三层记忆模型（按内容类型）的展示名：
 * L1 工作记忆层 / L2 情景记忆层 / L3 语义记忆层；扩展层原样显示。
 */
export function layerDisplayName(layer: string | null | undefined): string {
  if (!layer) return '—';
  if (layer === 'raw') return 'L0 原始档案';
  if (layer === 'L1') return 'L1 工作记忆层';
  if (layer === 'L2') return 'L2 情景记忆层';
  if (layer === 'L3') return 'L3 语义记忆层';
  return layer;
}

// ---------------------------------------------------------------------------
// 记忆分层模型：短期 / 中期 / 长期（retention 维度）
// ---------------------------------------------------------------------------

/** retention tier id 的中文标签 */
export function retentionLabel(tier: string | null | undefined): string {
  if (tier === 'short') return '短期';
  if (tier === 'mid') return '中期';
  if (tier === 'long') return '长期';
  return tier ?? '—';
}

/** retention tier id 带“记忆”后缀的完整标签（详情/卡片用） */
export function retentionLongLabel(tier: string | null | undefined): string {
  if (tier === 'short') return '短期记忆';
  if (tier === 'mid') return '中期记忆';
  if (tier === 'long') return '长期记忆';
  return tier ?? '—';
}

/** 从预览行提取记忆分层信息：优先嵌套 `retention`，兼容扁平字段 */
export function retentionOf(record: unknown): { tier: string; score: number; pinned: boolean } | null {
  if (typeof record !== 'object' || record === null) return null;
  const row = record as {
    retention?: { tier?: unknown; score?: unknown; pinned?: unknown } | null;
    retentionTier?: unknown;
    retentionScore?: unknown;
    pinned?: unknown;
  };
  const tier = row.retention?.tier ?? row.retentionTier;
  if (typeof tier !== 'string' || tier.length === 0) return null;
  const scoreRaw = row.retention?.score ?? row.retentionScore;
  const pinnedRaw = row.retention?.pinned ?? row.pinned;
  return {
    tier,
    score: typeof scoreRaw === 'number' && Number.isFinite(scoreRaw) ? scoreRaw : 0,
    pinned: pinnedRaw === true,
  };
}

/** 记忆分层排序：pinned 优先，再按 retentionScore 降序（宿主已排序时无害） */
export function compareRetention(a: unknown, b: unknown): number {
  const left = retentionOf(a);
  const right = retentionOf(b);
  if (left === null && right === null) return 0;
  if (left === null) return 1;
  if (right === null) return -1;
  if (left.pinned !== right.pinned) return left.pinned ? -1 : 1;
  return right.score - left.score;
}

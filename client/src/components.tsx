// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hanxustu (dsh-life-memory)
/**
 * 共享展示组件（只读；无任何写入/删除控件）。
 */
import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { styles, token } from './theme.tsx';
import { copyText, formatScore, retentionLabel, retentionOf, safeJsonStringify } from './util.ts';
import type { ApiError } from './api.ts';
import { describeError } from './api.ts';
import type { RetentionState, ScoreComponents } from './types.ts';

export type Tone = 'neutral' | 'success' | 'warn' | 'error' | 'info' | 'brand';

const TONE_COLORS: Record<Tone, { color: string; border: string; background: string }> = {
  neutral: { color: token.textSecondary, border: token.borderL3, background: token.bgLayer2 },
  success: { color: token.success, border: token.success, background: token.bgLayer2 },
  warn: { color: token.warn, border: token.warn, background: token.bgLayer2 },
  error: { color: token.error, border: token.error, background: token.bgLayer2 },
  info: { color: token.info, border: token.info, background: token.bgLayer2 },
  brand: { color: token.brand, border: token.brand, background: token.bgLayer2 },
};

/** 状态徽标 */
export function Badge(props: { tone?: Tone; children: ReactNode; title?: string }): JSX.Element {
  const tone = props.tone ?? 'neutral';
  const palette = TONE_COLORS[tone];
  return (
    <span
      style={{ ...styles.badge, color: palette.color, borderColor: palette.border, background: palette.background }}
      title={props.title}
    >
      {props.children}
    </span>
  );
}

/** 健康状态徽标（ok / 只读 / 出错） */
export function HealthBadge(props: { ok: boolean | undefined; readonly?: boolean; title?: string }): JSX.Element {
  if (props.ok === undefined) return <Badge tone="neutral">状态未知</Badge>;
  if (!props.ok) return <Badge tone="error">异常</Badge>;
  return (
    <Badge tone="success" title={props.title}>
      健康{props.readonly === false ? '' : ' · 只读'}
    </Badge>
  );
}

// ---------------------------------------------------------------------------
// 记忆分层徽标（短期 / 中期 / 长期，retention 维度）
// ---------------------------------------------------------------------------

const RETENTION_TONES: Record<string, Tone> = {
  short: 'info',
  mid: 'brand',
  long: 'success',
};

/** 钉住图标（内联 SVG；pinned 记忆始终保留） */
export function PinIcon(props: { size?: number }): JSX.Element {
  const size = props.size ?? 11;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
      style={{ display: 'inline-block', verticalAlign: '-1px' }}
    >
      <path
        d="M9 3h6l-1 6 4 3v2H6v-2l4-3-1-6Z"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinejoin="round"
      />
      <path d="M12 14v7" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

/**
 * 记忆分层徽标（短期/中期/长期）：优先使用传入的 retention，否则从记录行提取
 * （兼容嵌套/扁平两种形状）。`showScore` 为 true 时显示 retentionScore（0..1，保留 2 位）。
 */
export function RetentionBadge(props: {
  record?: unknown;
  retention?: { tier?: string; score?: number; pinned?: boolean } | RetentionState | null;
  showScore?: boolean;
  title?: string;
}): JSX.Element | null {
  const inline = props.retention;
  const info =
    inline && typeof inline.tier === 'string' && inline.tier.length > 0
      ? {
          tier: inline.tier,
          score: typeof inline.score === 'number' && Number.isFinite(inline.score) ? inline.score : 0,
          pinned: inline.pinned === true,
        }
      : retentionOf(props.record);
  if (info === null) return null;
  const tone = RETENTION_TONES[info.tier] ?? 'neutral';
  const scoreText = props.showScore === true ? ` · ${info.score.toFixed(2)}` : '';
  return (
    <Badge
      tone={tone}
      title={props.title ?? `记忆分层：${retentionLabel(info.tier)}${props.showScore === true ? `，retentionScore=${info.score.toFixed(3)}` : ''}${info.pinned ? '，已钉住' : ''}`}
    >
      {retentionLabel(info.tier)}
      {scoreText}
      {info.pinned ? (
        <span style={{ display: 'inline-flex', alignItems: 'center', marginLeft: 2 }}>
          <PinIcon />
        </span>
      ) : null}
    </Badge>
  );
}

/** 大数字统计卡 */
export function StatCard(props: { label: string; value: ReactNode; hint?: ReactNode }): JSX.Element {
  return (
    <div style={styles.card}>
      <div style={styles.statLabel}>{props.label}</div>
      <div style={styles.statValue}>{props.value}</div>
      {props.hint !== undefined ? <div style={styles.statHint}>{props.hint}</div> : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 人格（Persona，v4）：记忆条目人格徽标 + 只读人格过滤器
// ---------------------------------------------------------------------------

/** 记忆/原始条目的人格归属徽标；personaId 为空（共享）时不渲染（showShared 可显示"共享"） */
export function PersonaBadge(props: { personaId?: string | null; showShared?: boolean }): JSX.Element | null {
  const personaId = props.personaId;
  if (personaId === null || personaId === undefined || personaId === '') {
    return props.showShared ? <Badge tone="neutral">共享</Badge> : null;
  }
  return (
    <Badge tone="info" title={`人格：${personaId}`}>
      persona:{personaId}
    </Badge>
  );
}

export interface PersonaOption {
  id: string;
  name?: string | null;
  valid?: boolean;
}

/**
 * 只读人格过滤器（下拉）：
 * - `mode='memories'|'raw'`：空值 = 全部人格（不过滤）；其余为具体人格 id；
 * - `mode='search'`：空值 = 当前激活人格（服务端默认）+ 共享；`all` = 跨人格；其余为具体人格 id。
 */
export function PersonaFilter(props: {
  value: string;
  onChange: (value: string) => void;
  personas: PersonaOption[];
  mode?: 'memories' | 'raw' | 'search';
  label?: string;
}): JSX.Element {
  const mode = props.mode ?? 'memories';
  const valid = props.personas.filter((persona) => persona.valid !== false);
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
      <span style={styles.statHint}>{props.label ?? '人格：'}</span>
      <select
        style={styles.select}
        value={props.value}
        onChange={(event) => props.onChange(event.target.value)}
        title="按人格过滤（只读筛选）"
      >
        {mode === 'search' ? (
          <>
            <option value="">当前人格（默认 + 共享）</option>
            <option value="all">全部人格（跨人格）</option>
          </>
        ) : (
          <option value="">全部人格（不过滤）</option>
        )}
        {valid.map((persona) => (
          <option key={persona.id} value={persona.id}>
            {persona.name ? `${persona.name} (${persona.id})` : persona.id}
          </option>
        ))}
      </select>
    </span>
  );
}

/** 键值行 */
export function KV(props: { label: string; children: ReactNode; mono?: boolean }): JSX.Element {
  return (
    <div style={styles.kvRow}>
      <span style={styles.kvLabel}>{props.label}</span>
      <span style={props.mono ? { ...styles.mono, flex: '1 1 auto', wordBreak: 'break-all' } : { flex: '1 1 auto', wordBreak: 'break-all' }}>
        {props.children}
      </span>
    </div>
  );
}

export function SectionTitle(props: { children: ReactNode; first?: boolean; extra?: ReactNode }): JSX.Element {
  return (
    <div style={props.first ? styles.sectionTitleFirst : styles.sectionTitle}>
      <span>{props.children}</span>
      {props.extra !== undefined ? <span style={{ marginLeft: 'auto', display: 'inline-flex', gap: 6 }}>{props.extra}</span> : null}
    </div>
  );
}

export function EmptyState(props: { title: string; hint?: string; icon?: boolean }): JSX.Element {
  return (
    <div
      style={{
        padding: '26px 16px',
        textAlign: 'center',
        color: token.textTertiary,
        border: `1px dashed ${token.borderL2}`,
        borderRadius: 8,
        background: token.bgLayer1,
      }}
    >
      <div style={{ fontSize: 13, color: token.textSecondary }}>{props.title}</div>
      {props.hint !== undefined ? <div style={{ fontSize: 12, marginTop: 4 }}>{props.hint}</div> : null}
    </div>
  );
}

/** 加载占位 */
export function LoadingNotice(props: { label?: string }): JSX.Element {
  return <div style={{ ...styles.muted, padding: '12px 0' }}>{props.label ?? '正在读取…'}</div>;
}

/**
 * 错误横幅：只展示 code + message（不展示 stack trace）。
 * API 完全不可用时（ApiUnavailableError）额外列出探测过的地址，便于排查。
 */
export function ErrorNotice(props: { error: ApiError | null | undefined; onRetry?: () => void }): JSX.Element | null {
  if (!props.error) return null;
  const info = describeError(props.error);
  return (
    <div style={styles.error} role="alert">
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <strong>{info.code}</strong>
        <span>{info.message}</span>
        {props.onRetry ? (
          <button type="button" style={{ ...styles.button, marginLeft: 'auto' }} onClick={props.onRetry}>
            重试
          </button>
        ) : null}
      </div>
      {info.attempts && info.attempts.length > 0 ? (
        <div style={{ ...styles.mono, marginTop: 6, color: token.textSecondary }}>
          已尝试：{info.attempts.join(' , ')}
        </div>
      ) : null}
    </div>
  );
}

/** 复制按钮：展示"已复制"反馈，失败时提示 */
export function CopyButton(props: { text: string; label?: string; title?: string }): JSX.Element {
  const [state, setState] = useState<'idle' | 'ok' | 'fail'>('idle');
  const timer = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    },
    [],
  );
  const onClick = (): void => {
    void copyText(props.text).then((ok) => {
      setState(ok ? 'ok' : 'fail');
      if (timer.current !== null) window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setState('idle'), 1600);
    });
  };
  return (
    <button
      type="button"
      style={{ ...styles.button, color: state === 'fail' ? token.error : undefined }}
      onClick={onClick}
      title={props.title ?? '复制到剪贴板'}
    >
      {state === 'ok' ? '已复制' : state === 'fail' ? '复制失败' : (props.label ?? '复制')}
    </button>
  );
}

/** 可折叠 JSON（只读；默认折叠） */
export function JsonBlock(props: { value: unknown; label?: string; defaultOpen?: boolean }): JSX.Element {
  const [open, setOpen] = useState(props.defaultOpen === true);
  const text = safeJsonStringify(props.value);
  return (
    <div>
      <div style={{ ...styles.row, gap: 8 }}>
        <button type="button" style={styles.button} onClick={() => setOpen((v) => !v)} aria-expanded={open}>
          {open ? '▾' : '▸'} {props.label ?? 'JSON'}
        </button>
        <span style={styles.muted}>
          {text.length.toLocaleString('zh-CN')} 字符
        </span>
        <CopyButton text={text} label="复制 JSON" />
      </div>
      {open ? (
        <pre style={{ ...styles.pre, marginTop: 8 }}>{text}</pre>
      ) : null}
    </div>
  );
}

/** 分数条（用于检索四成分可解释性） */
export function ScoreBar(props: { label: string; value: number | undefined; color?: string }): JSX.Element {
  const value = typeof props.value === 'number' && Number.isFinite(props.value) ? Math.max(0, Math.min(1, props.value)) : 0;
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, flex: '1 1 120px', minWidth: 108 }}>
      <span style={{ color: token.textTertiary, width: 64, flex: '0 0 auto' }}>{props.label}</span>
      <span
        style={{
          flex: '1 1 auto',
          height: 6,
          borderRadius: 3,
          background: token.bgLayer3,
          overflow: 'hidden',
          minWidth: 40,
        }}
        role="img"
        aria-label={`${props.label} ${formatScore(value)}`}
      >
        <span
          style={{
            display: 'block',
            width: `${Math.round(value * 100)}%`,
            height: '100%',
            background: props.color ?? token.brand,
          }}
        />
      </span>
      <span style={{ ...styles.mono, width: 34, textAlign: 'right', color: token.textSecondary }}>{formatScore(value)}</span>
    </div>
  );
}

/** 四成分条形图：vector / lexical / recency / importance */
export function ScoreComponentsBars(props: { components: ScoreComponents | undefined }): JSX.Element {
  const components = props.components ?? {};
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 14px', marginTop: 6 }}>
      <ScoreBar label="vector" value={components.vector} color={token.brand} />
      <ScoreBar label="lexical" value={components.lexical} color={token.info} />
      <ScoreBar label="recency" value={components.recency} color={token.success} />
      <ScoreBar label="importance" value={components.importance} color={token.warn} />
    </div>
  );
}

/** 表格单元格快捷包装 */
export function Td(props: { children?: ReactNode; mono?: boolean; style?: Record<string, unknown> }): JSX.Element {
  return <td style={{ ...styles.td, ...(props.mono ? styles.mono : {}), ...(props.style ?? {}) }}>{props.children}</td>;
}

export function Th(props: { children?: ReactNode; style?: Record<string, unknown> }): JSX.Element {
  return <th style={{ ...styles.th, ...(props.style ?? {}) }}>{props.children}</th>;
}

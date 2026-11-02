// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hanxustu (dsh-life-memory)
/**
 * 主题 token 与共享样式。
 *
 * 只用 DSH 宿主提供的 `--dsw-alias-*` CSS 变量（浅色/深色主题自动跟随），
 * 不引入任何外部字体/图标/CDN 资源；字体仅使用系统栈。
 * 图标用内联 SVG 手写（无图标库依赖）。
 */

export const token = {
  bgBase: 'var(--dsw-alias-bg-base)',
  bgLayer1: 'var(--dsw-alias-bg-layer-1)',
  bgLayer2: 'var(--dsw-alias-bg-layer-2)',
  bgLayer3: 'var(--dsw-alias-bg-layer-3)',
  borderL1: 'var(--dsw-alias-border-l1)',
  borderL2: 'var(--dsw-alias-border-l2)',
  borderL3: 'var(--dsw-alias-border-l3)',
  borderL4: 'var(--dsw-alias-border-l4)',
  textPrimary: 'var(--dsw-alias-label-primary)',
  textSecondary: 'var(--dsw-alias-label-secondary)',
  textTertiary: 'var(--dsw-alias-label-tertiary)',
  textDimmed: 'var(--dsw-alias-label-dimmed)',
  brand: 'var(--dsw-alias-brand-primary)',
  brandText: 'var(--dsw-alias-brand-text, var(--dsw-alias-brand-primary))',
  link: 'var(--dsw-alias-link, var(--dsw-alias-brand-primary))',
  success: 'var(--dsw-alias-state-success-primary)',
  warn: 'var(--dsw-alias-state-warn-primary)',
  warnBg: 'var(--dsw-alias-state-warn-secondary, var(--dsw-alias-bg-layer-2))',
  error: 'var(--dsw-alias-state-error-primary)',
  info: 'var(--dsw-alias-state-business-primary)',
  hover: 'var(--dsw-alias-interactive-bg-hover)',
  activeBg: 'var(--dsw-alias-interactive-bg-active)',
  primaryFill: 'var(--dsw-alias-button-primary-fill)',
  primaryForeground: 'var(--dsw-alias-label-primary-foreground)',
  codeBg: 'var(--dsw-alias-markdown-code-block, var(--dsw-alias-bg-layer-2))',
} as const;

export const fontMono = "ui-monospace, SFMono-Regular, 'Cascadia Mono', Menlo, Consolas, 'Liberation Mono', monospace";

export const styles = {
  page: {
    height: '100%',
    minHeight: 0,
    display: 'flex',
    flexDirection: 'column',
    background: token.bgBase,
    color: token.textPrimary,
    fontSize: 13,
    lineHeight: 1.5,
  },
  header: {
    padding: '14px 20px 10px',
    borderBottom: `1px solid ${token.borderL2}`,
    flex: '0 0 auto',
  },
  titleRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    flexWrap: 'wrap',
  },
  title: {
    fontSize: 16,
    fontWeight: 600,
    margin: 0,
  },
  subtitle: {
    color: token.textSecondary,
    fontSize: 12,
  },
  warning: {
    marginTop: 8,
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    padding: '7px 12px',
    borderRadius: 6,
    // 固定高对比配色：暗色主题下"橙底橙字"会完全看不清
    border: '1px solid rgba(245, 158, 11, 0.55)',
    color: '#ffd166',
    background: 'rgba(245, 158, 11, 0.14)',
    fontSize: 12,
    fontWeight: 500,
  },
  tabs: {
    display: 'flex',
    gap: 4,
    padding: '0 20px',
    borderBottom: `1px solid ${token.borderL2}`,
    flex: '0 0 auto',
    overflowX: 'auto',
  },
  tab: {
    appearance: 'none',
    border: 'none',
    background: 'transparent',
    color: token.textSecondary,
    padding: '9px 12px',
    cursor: 'pointer',
    fontSize: 13,
    borderBottom: '2px solid transparent',
    whiteSpace: 'nowrap',
    fontFamily: 'inherit',
  },
  tabActive: {
    color: token.textPrimary,
    borderBottom: `2px solid ${token.brand}`,
    fontWeight: 600,
  },
  body: {
    flex: '1 1 auto',
    minHeight: 0,
    overflow: 'auto',
    padding: '16px 20px 28px',
  },
  card: {
    background: token.bgLayer1,
    border: `1px solid ${token.borderL2}`,
    borderRadius: 8,
    padding: '12px 14px',
  },
  cardGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(190px, 1fr))',
    gap: 10,
  },
  statLabel: {
    color: token.textSecondary,
    fontSize: 12,
  },
  statValue: {
    fontSize: 20,
    fontWeight: 600,
    marginTop: 2,
    fontVariantNumeric: 'tabular-nums',
  },
  statHint: {
    color: token.textTertiary,
    fontSize: 11,
    marginTop: 2,
  },
  sectionTitle: {
    fontSize: 14,
    fontWeight: 600,
    margin: '18px 0 8px',
    display: 'flex',
    alignItems: 'center',
    gap: 8,
  },
  sectionTitleFirst: {
    fontSize: 14,
    fontWeight: 600,
    margin: '0 0 8px',
    display: 'flex',
    alignItems: 'center',
    gap: 8,
  },
  badge: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 4,
    borderRadius: 999,
    padding: '1px 8px',
    fontSize: 11,
    fontWeight: 500,
    lineHeight: '18px',
    border: `1px solid ${token.borderL3}`,
    color: token.textSecondary,
    background: token.bgLayer2,
    whiteSpace: 'nowrap',
  },
  row: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
  },
  wrap: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: 8,
    alignItems: 'center',
  },
  kvLabel: {
    color: token.textSecondary,
    minWidth: 112,
    flex: '0 0 auto',
    fontSize: 12,
  },
  kvRow: {
    display: 'flex',
    gap: 10,
    padding: '3px 0',
    alignItems: 'baseline',
    borderBottom: `1px solid ${token.borderL1}`,
    wordBreak: 'break-all',
  },
  button: {
    appearance: 'none',
    fontFamily: 'inherit',
    fontSize: 12,
    padding: '3px 10px',
    borderRadius: 6,
    border: `1px solid ${token.borderL2}`,
    background: token.bgLayer2,
    color: token.textPrimary,
    cursor: 'pointer',
    whiteSpace: 'nowrap',
  },
  buttonPrimary: {
    appearance: 'none',
    fontFamily: 'inherit',
    fontSize: 12,
    padding: '4px 12px',
    borderRadius: 6,
    border: 'none',
    background: token.primaryFill,
    color: token.primaryForeground,
    cursor: 'pointer',
    whiteSpace: 'nowrap',
  },
  input: {
    fontFamily: 'inherit',
    fontSize: 12,
    padding: '5px 8px',
    borderRadius: 6,
    border: `1px solid ${token.borderL2}`,
    background: token.bgBase,
    color: token.textPrimary,
    outline: 'none',
    minWidth: 0,
  },
  select: {
    fontFamily: 'inherit',
    fontSize: 12,
    padding: '5px 8px',
    borderRadius: 6,
    border: `1px solid ${token.borderL2}`,
    background: token.bgBase,
    color: token.textPrimary,
    outline: 'none',
    maxWidth: 220,
  },
  mono: {
    fontFamily: fontMono,
    fontSize: 11,
  },
  pre: {
    fontFamily: fontMono,
    fontSize: 12,
    lineHeight: 1.55,
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
    margin: 0,
    padding: 10,
    borderRadius: 6,
    border: `1px solid ${token.borderL2}`,
    background: token.codeBg,
    maxHeight: 320,
    overflow: 'auto',
  },
  error: {
    border: `1px solid ${token.error}`,
    color: token.error,
    background: token.bgLayer1,
    borderRadius: 8,
    padding: '10px 12px',
    fontSize: 12,
  },
  muted: {
    color: token.textTertiary,
    fontSize: 12,
  },
  divider: {
    height: 1,
    background: token.borderL1,
    margin: '12px 0',
    border: 'none',
  },
  listItem: {
    padding: '8px 10px',
    borderRadius: 6,
    border: `1px solid transparent`,
    cursor: 'pointer',
    display: 'flex',
    flexDirection: 'column',
    gap: 3,
  },
  listItemHover: {
    background: token.hover,
  },
  listItemActive: {
    background: token.activeBg,
    border: `1px solid ${token.borderL2}`,
  },
  scrollList: {
    overflow: 'auto',
    minHeight: 0,
    paddingRight: 4,
  },
  table: {
    width: '100%',
    borderCollapse: 'collapse',
    fontSize: 12,
  },
  th: {
    textAlign: 'left',
    fontWeight: 600,
    color: token.textSecondary,
    padding: '5px 8px',
    borderBottom: `1px solid ${token.borderL2}`,
    whiteSpace: 'nowrap',
  },
  td: {
    padding: '5px 8px',
    borderBottom: `1px solid ${token.borderL1}`,
    verticalAlign: 'top',
  },
  linkButton: {
    appearance: 'none',
    border: 'none',
    background: 'transparent',
    color: token.link,
    cursor: 'pointer',
    padding: 0,
    fontFamily: 'inherit',
    fontSize: 'inherit',
    textAlign: 'left',
    wordBreak: 'break-all',
  },
  codeChip: {
    display: 'inline-block',
    fontFamily: fontMono,
    fontSize: 11,
    padding: '1px 6px',
    borderRadius: 4,
    border: `1px solid ${token.borderL2}`,
    background: token.bgLayer2,
    color: token.textSecondary,
    wordBreak: 'break-all',
  },
} as const;

/** 内联 SVG 图标（24x24，currentColor） */
export function VaultIcon(props: { size?: number }): JSX.Element {
  const size = props.size ?? 20;
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect x="3" y="4" width="18" height="16" rx="3" stroke="currentColor" strokeWidth="1.6" />
      <circle cx="12" cy="12" r="3.4" stroke="currentColor" strokeWidth="1.6" />
      <path d="M12 8.6V6.2M12 17.8v-2.4M8.6 12H6.2M17.8 12h-2.4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      <circle cx="12" cy="12" r="0.9" fill="currentColor" />
    </svg>
  );
}

/** 小图标：刷新 */
export function RefreshIcon(props: { size?: number }): JSX.Element {
  const size = props.size ?? 14;
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M20 11a8 8 0 1 0-2.34 5.66M20 5v6h-6"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

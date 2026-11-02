// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hanxustu (dsh-life-memory)
/**
 * 面板外壳：标题 + 常驻隐私警示 + 页签（概览 / 记忆分层 / 人格 / 原始 / 层 / 搜索 / 完整性）。
 *
 * 三套维度并存（v4）：
 * - 记忆分层模型（短期/中期/长期）→ 「记忆分层」页签；
 * - 三层记忆模型（L1 工作 / L2 情景 / L3 语义）→ 「层统计」页签；
 * - 人格（Persona，记忆的使用者/作用域）→ 「人格」页签。
 *
 * 只读：这里没有任何写操作控件；数据全部来自同源 GET API。
 * 错误边界保证单个视图抛错时不会把宿主 Web 应用带崩（宿主也会捕获 slot entry 崩溃）。
 */
import { Component, useState } from 'react';
import type { ReactNode } from 'react';
import type { TabId } from './types.ts';
import { styles, token } from './theme.tsx';
import { IntegrityView } from './views/integrity.tsx';
import { LayersView } from './views/layers.tsx';
import { OverviewView } from './views/overview.tsx';
import { PersonasView } from './views/personas.tsx';
import { RawView } from './views/raw.tsx';
import { RetentionView } from './views/retention.tsx';
import { SearchView } from './views/search.tsx';
import { TransferView } from './views/transfer.tsx';

const TABS: Array<{ id: TabId; label: string }> = [
  { id: 'overview', label: '概览' },
  { id: 'retention', label: '记忆分层' },
  { id: 'persona', label: '人格' },
  { id: 'raw', label: '原始记忆' },
  { id: 'layers', label: '层统计' },
  { id: 'search', label: '搜索' },
  { id: 'transfer', label: '导入导出' },
  { id: 'integrity', label: '健康/完整性' },
];

const PRIVACY_WARNING = '原始档案可能包含隐私/密钥，请勿截图外传';

interface BoundaryState {
  error: Error | null;
}

/** 视图级错误边界：只展示 message，不渲染 stack */
class ViewErrorBoundary extends Component<{ children: ReactNode; viewLabel: string }, BoundaryState> {
  constructor(props: { children: ReactNode; viewLabel: string }) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error: Error): BoundaryState {
    return { error };
  }

  override render(): ReactNode {
    if (this.state.error !== null) {
      return (
        <div style={styles.error}>
          <div style={{ fontWeight: 600, marginBottom: 4 }}>「{this.props.viewLabel}」视图渲染失败（面板其余部分仍可用）</div>
          <div>{this.state.error.message}</div>
          <button
            type="button"
            style={{ ...styles.button, marginTop: 8 }}
            onClick={() => this.setState({ error: null })}
          >
            重试
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

export function MemoryVaultPanel(): JSX.Element {
  const [tab, setTab] = useState<TabId>('overview');
  const [rawFocus, setRawFocus] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState<string>('');
  /** 「人格」页 → 「层统计」按人格过滤的跨页焦点 */
  const [personaFocus, setPersonaFocus] = useState<string | null>(null);

  const openRaw = (rawId: string): void => {
    setRawFocus(rawId);
    setTab('raw');
  };

  const keywordSearch = (query: string): void => {
    setSearchQuery(query);
    setTab('search');
  };

  let content: ReactNode;
  switch (tab) {
    case 'retention':
      content = <RetentionView onOpenRaw={openRaw} />;
      break;
    case 'persona':
      content = (
        <PersonasView
          onOpenMemories={(personaId) => {
            setPersonaFocus(personaId);
            setTab('layers');
          }}
        />
      );
      break;
    case 'raw':
      content = (
        <RawView
          focusRecordId={rawFocus}
          onFocusConsumed={() => setRawFocus(null)}
          onKeywordSearch={keywordSearch}
        />
      );
      break;
    case 'layers':
      content = (
        <LayersView
          onOpenRaw={openRaw}
          focusPersona={personaFocus}
          onFocusConsumed={() => setPersonaFocus(null)}
        />
      );
      break;
    case 'search':
      content = (
        <SearchView
          initialQuery={searchQuery}
          onQueryConsumed={() => setSearchQuery('')}
          onOpenRaw={openRaw}
        />
      );
      break;
    case 'transfer':
      content = <TransferView />;
      break;
    case 'integrity':
      content = <IntegrityView />;
      break;
    case 'overview':
    default:
      content = (
        <OverviewView
          onOpenRetention={() => setTab('retention')}
          onOpenPersona={() => setTab('persona')}
        />
      );
      break;
  }

  const activeLabel = TABS.find((item) => item.id === tab)?.label ?? tab;

  return (
    <div style={styles.page}>
      <div style={styles.header}>
        <div style={styles.titleRow}>
          <h2 style={styles.title}>记忆库</h2>
          <span style={styles.subtitle}>Life Memory · 浏览 + 人格/会话设置</span>
          <span style={{ ...styles.badge, marginLeft: 'auto', color: token.info }}>READ-ONLY · 人格页可编辑</span>
        </div>
        <div style={styles.warning} role="alert">
          <span aria-hidden="true">⚠</span>
          <span>{PRIVACY_WARNING}</span>
        </div>
      </div>

      <div style={styles.tabs} role="tablist" aria-label="记忆库视图">
        {TABS.map((item) => (
          <button
            key={item.id}
            type="button"
            role="tab"
            aria-selected={tab === item.id}
            style={{ ...styles.tab, ...(tab === item.id ? styles.tabActive : {}) }}
            onClick={() => setTab(item.id)}
          >
            {item.label}
          </button>
        ))}
      </div>

      <div style={styles.body}>
        <ViewErrorBoundary viewLabel={activeLabel}>{content}</ViewErrorBoundary>
      </div>
    </div>
  );
}

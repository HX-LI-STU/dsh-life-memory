// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hanxustu (dsh-life-memory)
/**
 * 搜索 Search（只读，v3 访问分工，见 docs/24-memory-access-forgetting.md）：
 *
 * - **显式检索（默认）**：`GET /search?q=...&mode=explicit` → L0 原始层 + 原始层向量索引；
 *   返回原始记忆命中（raw.id / 日期时间 / kind / sessionId / text / score+四成分 / citations），
 *   点击条目 → 原始记忆详情（`/raw-detail?id=`，由面板切到「原始记忆」页签）。
 *   原始层与向量模型**永不遗忘**，因此显式检索结果永远完整。
 * - **隐式检索（可选高级视图）**：`mode=implicit` → 三层记忆（L1/L2/L3，可遗忘）；
 *   沿用三层记忆命中渲染（retention 徽标等）。
 *
 * 只读：GET-only；宿主 HTTP 检索固定 trackAccess=false（不污染治理数据）。
 */
import { useCallback, useEffect, useState } from 'react';
import { api, useApiAction } from '../api.ts';
import {
  Badge,
  EmptyState,
  ErrorNotice,
  LoadingNotice,
  PersonaBadge,
  RetentionBadge,
  ScoreComponentsBars,
  SectionTitle,
} from '../components.tsx';
import { styles, token } from '../theme.tsx';
import type { RecallHit, SearchData } from '../types.ts';
import { formatNumber, formatScore, formatTime, truncate } from '../util.ts';

const LAYER_FILTERS = ['L1', 'L2', 'L3'] as const;
const LIMIT_OPTIONS = [5, 10, 20, 50] as const;

type SearchMode = 'explicit' | 'implicit';

export interface SearchViewProps {
  /** 从 Raw 页关键词跳转过来的初始查询（显式检索） */
  initialQuery: string;
  onQueryConsumed: () => void;
  onOpenRaw: (rawId: string) => void;
}

function isRawId(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}-\d{4,10}$/.test(value);
}

function isMemoryId(value: string): boolean {
  return /^L\d+-/.test(value);
}

function rawText(hit: RecallHit): string {
  return hit.raw?.text ?? '';
}

function hitText(hit: RecallHit): string {
  return hit.memory?.text ?? rawText(hit);
}

/** 引用 chips：raw id 可点击跳原始详情；其它（记忆 id 等）只读展示 */
function Citations(props: { citations: string[]; onOpenRaw: (rawId: string) => void }): JSX.Element {
  return (
    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center', marginTop: 8 }}>
      <span style={styles.statHint}>引用/来源：</span>
      {props.citations.map((citation) => {
        if (isRawId(citation)) {
          return (
            <button
              key={citation}
              type="button"
              style={{ ...styles.codeChip, cursor: 'pointer', color: token.link }}
              title="打开原始记录详情"
              onClick={(event) => {
                event.stopPropagation();
                props.onOpenRaw(citation);
              }}
            >
              {citation}
            </button>
          );
        }
        return (
          <span key={citation} style={styles.codeChip} title={isMemoryId(citation) ? '派生记忆 id' : '来源引用'}>
            {citation}
          </span>
        );
      })}
    </div>
  );
}

/** 显式检索命中：L0 原始记录（原文 + 时间 + kind + sessionId + 引用） */
function RawHitCard(props: { hit: RecallHit; onOpenRaw: (rawId: string) => void }): JSX.Element {
  const { hit } = props;
  const raw = hit.raw;
  const rawId = raw?.id ?? hit.citations?.[0] ?? '';
  const preview = truncate(rawText(hit), 520);
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => {
        if (rawId) props.onOpenRaw(rawId);
      }}
      onKeyDown={(event) => {
        if ((event.key === 'Enter' || event.key === ' ') && rawId) {
          event.preventDefault();
          props.onOpenRaw(rawId);
        }
      }}
      title={rawId ? '打开原始记录详情（只读）' : undefined}
      style={{ ...styles.card, marginBottom: 10, cursor: rawId ? 'pointer' : 'default' }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <Badge tone="neutral">L0 原始</Badge>
        <PersonaBadge personaId={raw?.personaId} showShared />
        {raw?.kind ? <Badge tone="info">{raw.kind}</Badge> : null}
        {raw?.role ? <Badge tone="info">{raw.role}</Badge> : null}
        {raw?.day ? <Badge tone="neutral">{raw.day}</Badge> : null}
        <span style={{ ...styles.mono, color: token.textSecondary }}>score {formatScore(hit.score)}</span>
        <span style={{ ...styles.statHint, marginLeft: 'auto' }}>{raw?.ts ? formatTime(raw.ts) : (raw?.iso ?? '')}</span>
      </div>
      <div style={{ ...styles.mono, color: token.textTertiary, marginTop: 4, display: 'flex', gap: 12, flexWrap: 'wrap' }}>
        <span>raw {rawId || '—'}</span>
        {raw?.sessionId ? <span>session {truncate(raw.sessionId, 24)}</span> : null}
      </div>
      <div style={{ fontSize: 13, marginTop: 6, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
        {preview || '（该原始记录无 text 字段；点击查看完整 payload）'}
      </div>
      <ScoreComponentsBars components={hit.components} />
      {hit.citations && hit.citations.length > 0 ? <Citations citations={hit.citations} onOpenRaw={props.onOpenRaw} /> : null}
      <div style={{ ...styles.statHint, marginTop: 6 }}>原文来自 L0 不可变档案（永不遗忘）；点击打开原始记忆详情 →</div>
    </div>
  );
}

/** 隐式检索命中：三层记忆（可遗忘；沿用三层记忆渲染） */
function MemoryHitCard(props: { hit: RecallHit; onOpenRaw: (rawId: string) => void }): JSX.Element {
  const { hit } = props;
  const citations = hit.citations ?? [];
  return (
    <div style={{ ...styles.card, marginBottom: 10 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <Badge tone={hit.layer === 'raw' ? 'neutral' : 'brand'}>{hit.layer}</Badge>
        {hit.memory?.kind ? <Badge tone="info">{hit.memory.kind}</Badge> : null}
        {hit.memory ? <RetentionBadge record={hit.memory} showScore /> : null}
        {hit.memory ? <PersonaBadge personaId={hit.memory.personaId} /> : null}
        <span style={{ ...styles.mono, color: token.textSecondary }}>score {formatScore(hit.score)}</span>
        <span style={{ ...styles.statHint, marginLeft: 'auto' }}>{hit.memory?.id ?? hit.raw?.id ?? ''}</span>
      </div>
      <div style={{ fontSize: 13, marginTop: 6, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
        {truncate(hitText(hit), 520) || '（无文本）'}
      </div>
      <ScoreComponentsBars components={hit.components} />
      {citations.length > 0 ? <Citations citations={citations} onOpenRaw={props.onOpenRaw} /> : null}
    </div>
  );
}

export function SearchView(props: SearchViewProps): JSX.Element {
  const [query, setQuery] = useState<string>('');
  const [mode, setMode] = useState<SearchMode>('explicit');
  const [layers, setLayers] = useState<string[]>([...LAYER_FILTERS]);
  const [limit, setLimit] = useState<number>(10);
  const [lastQuery, setLastQuery] = useState<string>('');
  const [lastMode, setLastMode] = useState<SearchMode>('explicit');
  const search = useApiAction<SearchData>();

  const runSearch = useCallback(
    (text: string, nextMode: SearchMode = mode) => {
      const trimmed = text.trim();
      if (trimmed.length === 0) return;
      setLastQuery(trimmed);
      setLastMode(nextMode);
      void search.run(() =>
        api.search({
          q: trimmed,
          mode: nextMode,
          // 层过滤只对隐式（三层记忆）有意义；显式检索面向 L0 原始层
          layers: nextMode === 'implicit' && layers.length > 0 ? layers.join(',') : undefined,
          limit,
        }),
      );
    },
    [layers, limit, mode, search],
  );

  // 从 Raw 页带过来的查询：默认显式检索并自动执行一次
  useEffect(() => {
    if (props.initialQuery && props.initialQuery.trim().length > 0) {
      setQuery(props.initialQuery);
      setMode('explicit');
      runSearch(props.initialQuery, 'explicit');
      props.onQueryConsumed();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 只在 initialQuery 变化时触发
  }, [props.initialQuery]);

  const switchMode = (nextMode: SearchMode): void => {
    if (nextMode === mode) return;
    setMode(nextMode);
    if (lastQuery.length > 0) runSearch(lastQuery, nextMode);
  };

  const toggleLayer = (layer: string): void => {
    setLayers((prev) => (prev.includes(layer) ? prev.filter((item) => item !== layer) : [...prev, layer]));
  };

  const result = search.state.data;
  const items = result?.items ?? [];
  const isExplicit = lastMode === 'explicit';

  return (
    <div>
      <div style={{ ...styles.card, padding: 12 }}>
        <SectionTitle first>检索（只读）</SectionTitle>
        <div style={{ ...styles.row, gap: 6, flexWrap: 'wrap', marginBottom: 8 }}>
          <button
            type="button"
            style={mode === 'explicit' ? styles.buttonPrimary : styles.button}
            onClick={() => switchMode('explicit')}
            title="显式检索：L0 原始层 + 原始层向量索引（永不遗忘，返回原文）"
          >
            显式检索（原始层）
          </button>
          <button
            type="button"
            style={mode === 'implicit' ? styles.buttonPrimary : styles.button}
            onClick={() => switchMode('implicit')}
            title="隐式检索：三层记忆（工作/情景/语义，可遗忘）"
          >
            隐式检索（三层记忆）
          </button>
          <span style={styles.statHint}>
            {mode === 'explicit'
              ? '显式检索 = L0 原始层 + 原始层向量模型（永不遗忘），返回原文与引用'
              : '隐式上下文 = 三层记忆（工作/情景/语义，可遗忘）'}
          </span>
        </div>
        <div style={{ ...styles.row, gap: 8, flexWrap: 'wrap' }}>
          <input
            style={{ ...styles.input, flex: '1 1 260px', fontSize: 13, padding: '7px 10px' }}
            placeholder={mode === 'explicit' ? '检索原始记忆原文，例如：深色主题 / build.mjs' : '检索三层记忆（派生记忆）'}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') runSearch(query);
            }}
            autoFocus
          />
          <button type="button" style={styles.buttonPrimary} onClick={() => runSearch(query)} disabled={search.state.pending}>
            {search.state.pending ? '检索中…' : '检索'}
          </button>
        </div>
        <div style={{ ...styles.row, gap: 14, flexWrap: 'wrap', marginTop: 10 }}>
          {mode === 'implicit' ? (
            <>
              <span style={styles.statHint}>层过滤：</span>
              {LAYER_FILTERS.map((layer) => (
                <label key={layer} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 12, cursor: 'pointer' }}>
                  <input type="checkbox" checked={layers.includes(layer)} onChange={() => toggleLayer(layer)} />
                  {layer}
                </label>
              ))}
            </>
          ) : (
            <span style={styles.statHint}>显式检索返回 L0 原始记录（原文完整、永不受遗忘影响）</span>
          )}
          <span style={styles.statHint}>条数：</span>
          <select style={styles.select} value={limit} onChange={(event) => setLimit(Number(event.target.value))}>
            {LIMIT_OPTIONS.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
          <span style={{ ...styles.statHint, marginLeft: 'auto' }}>只读检索：不写入 access/heat（trackAccess=false）</span>
        </div>
      </div>

      <div style={{ marginTop: 12 }}>
        {search.state.error ? <ErrorNotice error={search.state.error} onRetry={() => runSearch(lastQuery, lastMode)} /> : null}
        {search.state.pending ? <LoadingNotice label="检索中…" /> : null}
        {!search.state.pending && !search.state.error && result === null ? (
          <EmptyState
            title="输入查询开始检索"
            hint="显式检索（默认）从 L0 原始层 + 原始层向量模型返回原文；可切换到隐式检索查看三层记忆（可遗忘）。"
          />
        ) : null}
        {result !== null ? (
          <>
            <div style={{ ...styles.row, gap: 10, marginBottom: 10, flexWrap: 'wrap' }}>
              <Badge tone="neutral">{formatNumber(items.length)} 条结果</Badge>
              <Badge tone={isExplicit ? 'info' : 'brand'}>{isExplicit ? '显式检索 · 原始层' : '隐式检索 · 三层记忆'}</Badge>
              <span style={styles.statHint}>
                查询 “{lastQuery}” · 耗时 {formatNumber(result.latencyMs)} ms
                {result.truncated ? ' · 已截断（可提高条数）' : ''}
              </span>
            </div>
            {items.length === 0 ? (
              <EmptyState
                title="没有命中"
                hint={
                  isExplicit
                    ? '原始层尚无匹配的原文；可换个关键词或确认宿主已完成捕获/向量回填。'
                    : '三层记忆尚无匹配（遗忘策略可能已清理旧记录）；可换关键词或改用显式检索原文。'
                }
              />
            ) : null}
            {items.map((hit, index) => {
              // 显式检索期望 layer==='raw'；宿主若返回其它形状则走通用记忆卡（降级）
              if (isExplicit && hit.raw) {
                return <RawHitCard key={`raw-${hit.raw.id ?? index}`} hit={hit} onOpenRaw={props.onOpenRaw} />;
              }
              return <MemoryHitCard key={`${hit.layer}-${hit.memory?.id ?? hit.raw?.id ?? index}`} hit={hit} onOpenRaw={props.onOpenRaw} />;
            })}
          </>
        ) : null}
      </div>
    </div>
  );
}


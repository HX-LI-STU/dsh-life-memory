// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hanxustu (dsh-life-memory)
/**
 * 原始记忆 Raw（只读）：
 * 左侧日期列表（day → 条数，来自 manifest）｜中间记录列表（kind/role/时间/预览/哈希前 8 位）
 * 右侧详情（完整 text、payload JSON 折叠、hash/prevHash、segment:lineNo:byteOffset、复制 raw id、
 * GET /raw-verify 校验徽标）。
 *
 * 筛选：kind / sessionId / workspace / day / persona（v4）；关键词走 Search 页（宿主 /raw 不支持 FTS 参数）。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ApiError, api, useApi, useApiAction } from '../api.ts';
import {
  Badge,
  CopyButton,
  ErrorNotice,
  EmptyState,
  JsonBlock,
  KV,
  LoadingNotice,
  PersonaBadge,
  PersonaFilter,
  SectionTitle,
} from '../components.tsx';
import { styles, token } from '../theme.tsx';
import type { ManifestData, RawDetailData, RawIndexRowPreview, RawVerifyData } from '../types.ts';
import { formatClock, formatNumber, kindLabel, truncate } from '../util.ts';

const KIND_OPTIONS = [
  '',
  'session',
  'turn',
  'user',
  'assistant',
  'tool_call',
  'tool_result',
  'system',
  'compaction',
  'event',
  'note',
] as const;

const PAGE_LIMIT = 100;

export interface RawViewProps {
  /** 从搜索/层视图跳转过来时要打开的 record id */
  focusRecordId: string | null;
  onFocusConsumed: () => void;
  /** 关键词检索：交给 Search 页（/raw 无 FTS 参数） */
  onKeywordSearch: (query: string) => void;
}

interface DayBucket {
  day: string;
  records: number;
  segments: number;
}

/** manifest.segments -> 按 day 聚合 */
function dayBuckets(manifest: ManifestData | null): DayBucket[] {
  if (!manifest || !Array.isArray(manifest.segments)) return [];
  const map = new Map<string, DayBucket>();
  for (const segment of manifest.segments) {
    const day = segment.day ?? (segment.segment ?? '').match(/\d{4}-\d{2}-\d{2}/)?.[0];
    if (!day) continue;
    const bucket = map.get(day) ?? { day, records: 0, segments: 0 };
    bucket.records += segment.records ?? 0;
    bucket.segments += 1;
    map.set(day, bucket);
  }
  return [...map.values()].sort((a, b) => (a.day < b.day ? 1 : -1));
}

export function RawView(props: RawViewProps): JSX.Element {
  const [day, setDay] = useState<string | null>(null);
  const [kind, setKind] = useState<string>('');
  const [sessionId, setSessionId] = useState<string>('');
  const [workspace, setWorkspace] = useState<string>('');
  const [personaFilter, setPersonaFilter] = useState<string>('');
  const [keyword, setKeyword] = useState<string>('');

  const [items, setItems] = useState<RawIndexRowPreview[]>([]);
  const [total, setTotal] = useState<number>(0);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [listPhase, setListPhase] = useState<'loading' | 'ready' | 'error'>('loading');
  const [listError, setListError] = useState<ApiError | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  const manifest = useApi(() => api.manifest(), []);
  const personas = useApi(() => api.personas(), []);
  const detail = useApiAction<RawDetailData>();
  const verify = useApiAction<RawVerifyData>();
  const requestSeq = useRef(0);

  const days = useMemo(() => dayBuckets(manifest.data), [manifest.data]);
  const daysFallback = useMemo<DayBucket[]>(() => {
    if (days.length > 0) return days;
    const map = new Map<string, number>();
    for (const item of items) {
      if (!item.day) continue;
      map.set(item.day, (map.get(item.day) ?? 0) + 1);
    }
    return [...map.entries()].map(([value, records]) => ({ day: value, records, segments: 0 })).sort((a, b) => (a.day < b.day ? 1 : -1));
  }, [days, items]);

  const loadFirstPage = useCallback(() => {
    const seq = ++requestSeq.current;
    setListPhase('loading');
    setListError(null);
    api
      .raw({
        day: day ?? undefined,
        kind: kind || undefined,
        sessionId: sessionId || undefined,
        workspace: workspace || undefined,
        persona: personaFilter || undefined,
        limit: PAGE_LIMIT,
        desc: true,
      })
      .then((data) => {
        if (seq !== requestSeq.current) return;
        setItems(data.items ?? []);
        setTotal(data.total ?? 0);
        setNextCursor(data.nextCursor ?? null);
        setListPhase('ready');
      })
      .catch((error: unknown) => {
        if (seq !== requestSeq.current) return;
        setListError(error instanceof ApiError ? error : new ApiError('E_INTERNAL', String(error)));
        setListPhase('error');
      });
  }, [day, kind, sessionId, workspace, personaFilter]);

  useEffect(() => {
    loadFirstPage();
  }, [loadFirstPage, tick]);

  const loadMore = (): void => {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    api
      .raw({
        day: day ?? undefined,
        kind: kind || undefined,
        sessionId: sessionId || undefined,
        workspace: workspace || undefined,
        persona: personaFilter || undefined,
        cursor: nextCursor,
        limit: PAGE_LIMIT,
        desc: true,
      })
      .then((data) => {
        setItems((prev) => [...prev, ...(data.items ?? [])]);
        setTotal(data.total ?? 0);
        setNextCursor(data.nextCursor ?? null);
      })
      .catch((error: unknown) => {
        setListError(error instanceof ApiError ? error : new ApiError('E_INTERNAL', String(error)));
        setListPhase('error');
      })
      .finally(() => setLoadingMore(false));
  };

  const openRecord = useCallback(
    (id: string) => {
      setSelectedId(id);
      verify.reset();
      void detail.run(() => api.rawDetail(id));
    },
    [detail, verify],
  );

  // 外部跳转（搜索/Layer 的引用）优先
  useEffect(() => {
    if (props.focusRecordId) {
      openRecord(props.focusRecordId);
      props.onFocusConsumed();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 只在 focus id 变化时触发
  }, [props.focusRecordId]);

  const doVerify = (): void => {
    if (!selectedId) return;
    void verify.run(() => api.rawVerify(selectedId));
  };

  const detailData = detail.state.data;
  const record = detailData?.record;
  const location = detailData?.location;

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '190px minmax(260px, 1fr) minmax(320px, 1.35fr)', gap: 12, alignItems: 'stretch', height: '100%', minHeight: 420 }}>
      {/* ── 左：日期列表 ── */}
      <div style={{ ...styles.card, display: 'flex', flexDirection: 'column', minHeight: 0, padding: 8 }}>
        <div style={{ ...styles.sectionTitle, margin: '0 4px 6px', fontSize: 13 }}>
          日期
          <button type="button" style={{ ...styles.button, marginLeft: 'auto', padding: '1px 8px' }} onClick={() => setDay(null)}>
            全部
          </button>
        </div>
        <div style={{ ...styles.scrollList, flex: '1 1 auto' }}>
          {manifest.phase === 'loading' && daysFallback.length === 0 ? <LoadingNotice label="读取清单…" /> : null}
          {manifest.error ? <ErrorNotice error={manifest.error} onRetry={manifest.reload} /> : null}
          {daysFallback.length === 0 && manifest.phase !== 'loading' ? (
            <div style={{ ...styles.muted, padding: 8 }}>暂无归档日期</div>
          ) : null}
          {daysFallback.map((bucket) => (
            <div
              key={bucket.day}
              role="button"
              tabIndex={0}
              onClick={() => setDay(bucket.day)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault();
                  setDay(bucket.day);
                }
              }}
              style={{
                ...styles.listItem,
                padding: '5px 8px',
                ...(day === bucket.day ? styles.listItemActive : {}),
              }}
            >
              <span style={{ fontFamily: 'inherit', fontSize: 12 }}>{bucket.day}</span>
              <span style={{ ...styles.statHint, marginTop: 0 }}>
                {formatNumber(bucket.records)} 条{bucket.segments > 0 ? ` · ${bucket.segments} 段` : ''}
              </span>
            </div>
          ))}
        </div>
      </div>

      {/* ── 中：筛选 + 记录列表 ── */}
      <div style={{ ...styles.card, display: 'flex', flexDirection: 'column', minHeight: 0, padding: 8 }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, padding: '0 2px 8px' }}>
          <div style={{ ...styles.row, flexWrap: 'wrap', gap: 6 }}>
            <select style={styles.select} value={kind} onChange={(event) => setKind(event.target.value)} title="按 kind 过滤">
              {KIND_OPTIONS.map((option) => (
                <option key={option} value={option}>
                  {option === '' ? '全部 kind' : kindLabel(option)}
                </option>
              ))}
            </select>
            <input
              style={{ ...styles.input, width: 130 }}
              placeholder="sessionId"
              value={sessionId}
              onChange={(event) => setSessionId(event.target.value)}
            />
          </div>
          <div style={{ ...styles.row, gap: 6 }}>
            <input
              style={{ ...styles.input, flex: '1 1 auto' }}
              placeholder="workspace 前缀"
              value={workspace}
              onChange={(event) => setWorkspace(event.target.value)}
            />
            <button type="button" style={styles.button} onClick={() => setTick((value) => value + 1)}>
              刷新
            </button>
          </div>
          <div style={{ ...styles.row, gap: 6 }}>
            <PersonaFilter
              value={personaFilter}
              onChange={setPersonaFilter}
              personas={personas.data?.definitions ?? []}
              mode="raw"
              label="人格过滤："
            />
          </div>
          <div style={{ ...styles.row, gap: 6 }}>
            <input
              style={{ ...styles.input, flex: '1 1 auto' }}
              placeholder="关键词 → 全文检索"
              value={keyword}
              onChange={(event) => setKeyword(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && keyword.trim().length > 0) props.onKeywordSearch(keyword.trim());
              }}
            />
            <button
              type="button"
              style={styles.button}
              onClick={() => {
                if (keyword.trim().length > 0) props.onKeywordSearch(keyword.trim());
              }}
            >
              检索
            </button>
          </div>
          <div style={{ ...styles.statHint, display: 'flex', gap: 8, alignItems: 'center' }}>
            <span>{day ? `日期 ${day}` : '全部日期'}</span>
            <span>·</span>
            <span>共 {formatNumber(total)} 条</span>
            {day ? (
              <button type="button" style={{ ...styles.linkButton, marginLeft: 'auto', fontSize: 11 }} onClick={() => setDay(null)}>
                清除日期
              </button>
            ) : null}
          </div>
          {listError ? <ErrorNotice error={listError} onRetry={loadFirstPage} /> : null}
        </div>

        <div style={{ ...styles.scrollList, flex: '1 1 auto' }}>
          {listPhase === 'loading' && items.length === 0 ? <LoadingNotice label="读取原始记录…" /> : null}
          {listPhase === 'ready' && items.length === 0 ? (
            <EmptyState title="没有匹配的原始记录" hint="换个日期/kind/sessionId，或等待宿主捕获新事件。" />
          ) : null}
          {items.map((item) => (
            <div
              key={item.id}
              role="button"
              tabIndex={0}
              onClick={() => openRecord(item.id)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault();
                  openRecord(item.id);
                }
              }}
              style={{
                ...styles.listItem,
                ...(selectedId === item.id ? styles.listItemActive : {}),
              }}
            >
              <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                <Badge tone="neutral">{kindLabel(item.kind)}</Badge>
                {item.role ? <Badge tone="info">{item.role}</Badge> : null}
                <PersonaBadge personaId={item.personaId} />
                <span style={{ ...styles.statHint, marginLeft: 'auto' }}>
                  {formatClock(item.ts)} · {item.id}
                </span>
              </div>
              <div style={{ fontSize: 12, color: token.textPrimary, wordBreak: 'break-word' }}>
                {truncate(item.textPreview ?? '', 200) || <span style={styles.muted}>（无文本预览）</span>}
              </div>
              <div style={{ ...styles.mono, color: token.textTertiary, display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                <span>hash {(item.hash ?? '').slice(0, 8) || '—'}</span>
                {item.sessionId ? <span>session {truncate(item.sessionId, 18)}</span> : null}
                {item.lineNo !== undefined ? <span>L{item.lineNo}</span> : null}
              </div>
            </div>
          ))}
          {nextCursor ? (
            <div style={{ padding: '8px 4px' }}>
              <button type="button" style={styles.button} onClick={loadMore} disabled={loadingMore}>
                {loadingMore ? '加载中…' : '加载更多'}
              </button>
            </div>
          ) : null}
        </div>
      </div>

      {/* ── 右：记录详情 ── */}
      <div style={{ ...styles.card, minHeight: 0, overflow: 'auto' }}>
        {!selectedId ? (
          <EmptyState title="选择左侧记录查看详情" hint="完整原文、payload JSON、哈希链位置与校验。" />
        ) : null}
        {selectedId && detail.state.pending ? <LoadingNotice label={`读取 ${selectedId}…`} /> : null}
        {selectedId && detail.state.error ? <ErrorNotice error={detail.state.error} onRetry={() => openRecord(selectedId)} /> : null}
        {record ? (
          <div>
            <SectionTitle first extra={<CopyButton text={record.id} label="复制 raw id" />}>
              <span style={styles.mono}>{record.id}</span>
            </SectionTitle>
            <div style={{ ...styles.wrap, marginBottom: 8 }}>
              <Badge tone="brand">{kindLabel(record.kind)}</Badge>
              {record.role ? <Badge tone="info">{record.role}</Badge> : null}
              <PersonaBadge personaId={record.personaId} />
              {record.day ? <Badge tone="neutral">{record.day}</Badge> : null}
              {record.v !== undefined ? <Badge tone="neutral">v{record.v}</Badge> : null}
              <button type="button" style={{ ...styles.button, marginLeft: 'auto' }} onClick={doVerify} disabled={verify.state.pending}>
                {verify.state.pending ? '校验中…' : '校验单条'}
              </button>
            </div>

            {verify.state.error ? <ErrorNotice error={verify.state.error} /> : null}
            {verify.state.data ? (
              <div style={{ marginBottom: 8 }}>
                <Badge tone={verify.state.data.exists === false ? 'error' : 'success'}>
                  记录存在 {verify.state.data.exists === false ? '否' : '是'}
                </Badge>{' '}
                <Badge tone={verify.state.data.hashPresent ? 'success' : 'warn'}>hash 字段{verify.state.data.hashPresent ? '完整' : '异常'}</Badge>{' '}
                <Badge tone={verify.state.data.prevHashPresent ? 'success' : 'warn'}>
                  prevHash 字段{verify.state.data.prevHashPresent ? '完整' : '异常'}
                </Badge>
                {verify.state.data.note ? <div style={{ ...styles.statHint, marginTop: 4 }}>{verify.state.data.note}</div> : null}
              </div>
            ) : null}

            <KV label="时间">{formatClock(record.ts)} · {record.iso ?? '—'}</KV>
            <KV label="会话" mono>
              {record.sessionId ?? '—'}
            </KV>
            <KV label="人格" mono>
              {record.personaId ? `persona:${record.personaId}` : '共享'}
            </KV>
            <KV label="工作区" mono>
              {record.workspace ?? '—'}
            </KV>
            {record.turnId || record.stepId ? (
              <KV label="轮次/步骤" mono>
                {record.turnId ?? '—'} / {record.stepId ?? '—'}
              </KV>
            ) : null}
            <KV label="哈希" mono>
              {record.hash ?? '—'}
            </KV>
            <KV label="前一条哈希" mono>
              {record.prevHash ?? '—'}
            </KV>
            <KV label="位置" mono>
              {location
                ? `${location.segment ?? '?'}:${location.lineNo ?? '?'}:${location.byteOffset ?? '?'}${location.byteLen ? ` (+${location.byteLen}B)` : ''}`
                : '索引中无位置信息'}
              {location ? <span style={{ marginLeft: 8 }}><CopyButton text={`${location.segment ?? ''}:${location.lineNo ?? ''}:${location.byteOffset ?? ''}`} label="复制位置" /></span> : null}
            </KV>
            {location?.ingestKey ? (
              <KV label="幂等键" mono>
                {location.ingestKey}
              </KV>
            ) : null}

            <SectionTitle>完整原文</SectionTitle>
            {record.text ? (
              <>
                <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 4 }}>
                  <CopyButton text={record.text} label="复制原文" />
                </div>
                <pre style={styles.pre}>{record.text}</pre>
              </>
            ) : (
              <div style={styles.muted}>该记录没有 text 字段（例如仅含结构化事件）。</div>
            )}

            <SectionTitle>原始事件 payload</SectionTitle>
            <JsonBlock value={record.payload ?? null} label="展开 payload JSON" />
            {record.tags && record.tags.length > 0 ? (
              <div style={{ ...styles.wrap, marginTop: 8 }}>
                {record.tags.map((tag) => (
                  <Badge key={tag} tone="neutral">
                    #{tag}
                  </Badge>
                ))}
              </div>
            ) : null}
            {record.meta ? (
              <div style={{ marginTop: 10 }}>
                <JsonBlock value={record.meta} label="meta" />
              </div>
            ) : null}
          </div>
        ) : null}
        {!record && detailData && !detail.state.pending ? (
          <EmptyState title="未找到该原始记录" hint={selectedId ?? ''} />
        ) : null}
      </div>
    </div>
  );
}


// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hanxustu (dsh-life-memory)
/**
 * 层统计 Layers（只读）—— 三层记忆模型（按内容类型）：L1 工作记忆层 / L2 情景记忆层 / L3 语义记忆层。
 * - 每层：id/版本/依赖/启停/总数/有效/归档/向量覆盖率/最近更新
 * - L3 语义记忆列表（kind/canonicalKey/validFrom/validTo + 记忆分层徽标）
 * - L2 情景列表（topic/时间窗 + 记忆分层徽标）
 * - 点击记忆 → /memory-detail?id=，可跳转到来源 raw 记录
 *
 * 注意：这里的“层”是记忆类型（工作/情景/语义）；记忆分层（短期/中期/长期，retention）
 * 是另一个正交维度，见「记忆分层」页签。
 */
import { useCallback, useEffect, useState } from 'react';
import { api, useApi, useApiAction } from '../api.ts';
import {
  Badge,
  EmptyState,
  ErrorNotice,
  JsonBlock,
  KV,
  LoadingNotice,
  PersonaBadge,
  PersonaFilter,
  SectionTitle,
  Td,
  Th,
  RetentionBadge,
} from '../components.tsx';
import { styles, token } from '../theme.tsx';
import type { MemoryDetailData, MemoryRecordPreview } from '../types.ts';
import { formatNumber, formatPercent, formatRelative, formatScore, formatTime, layerDisplayName, retentionLongLabel, retentionOf, truncate } from '../util.ts';

export interface LayersViewProps {
  onOpenRaw: (rawId: string) => void;
  /** 从「人格」页跳转过来的按人格过滤（null = 不过滤） */
  focusPersona?: string | null;
  onFocusConsumed?: () => void;
}

function memoryKey(memory: MemoryRecordPreview): string {
  const fromMeta = typeof memory.meta === 'object' && memory.meta !== null ? (memory.meta as Record<string, unknown>).canonicalKey : undefined;
  return memory.canonicalKey ?? (typeof fromMeta === 'string' ? fromMeta : '—');
}

function memoryTopic(memory: MemoryRecordPreview): string {
  const meta = typeof memory.meta === 'object' && memory.meta !== null ? (memory.meta as Record<string, unknown>) : {};
  const topic = meta.topic ?? meta.title ?? memory.summary;
  return typeof topic === 'string' && topic.length > 0 ? topic : truncate(memory.text ?? '', 60) || '（无主题）';
}

function memoryWindow(memory: MemoryRecordPreview): string {
  const meta = typeof memory.meta === 'object' && memory.meta !== null ? (memory.meta as Record<string, unknown>) : {};
  const from = typeof meta.startTs === 'number' ? meta.startTs : typeof meta.validFrom === 'number' ? meta.validFrom : memory.validFrom ?? undefined;
  const to = typeof meta.endTs === 'number' ? meta.endTs : typeof meta.validTo === 'number' ? meta.validTo : memory.validTo ?? undefined;
  const start = typeof from === 'number' ? formatTime(from) : '—';
  const end = typeof to === 'number' ? formatTime(to) : '进行中/未知';
  return `${start} → ${end}`;
}

function MemoryRow(props: {
  memory: MemoryRecordPreview;
  selected: boolean;
  onSelect: () => void;
  showValidRange: boolean;
}): JSX.Element {
  const { memory } = props;
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={props.onSelect}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          props.onSelect();
        }
      }}
      style={{
        ...styles.listItem,
        ...(props.selected ? styles.listItemActive : {}),
      }}
    >
      <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
        <Badge tone="brand">{layerDisplayName(memory.layer)}</Badge>
        {memory.kind ? <Badge tone="neutral">{memory.kind}</Badge> : null}
        <RetentionBadge record={memory} showScore />
        <PersonaBadge personaId={memory.personaId} />
        {memory.status && memory.status !== 'active' ? <Badge tone="warn">{memory.status}</Badge> : null}
        <span style={{ ...styles.statHint, marginLeft: 'auto' }}>{formatRelative(memory.updatedAt)}</span>
      </div>
      <div style={{ fontSize: 12, wordBreak: 'break-word' }}>{truncate(memory.text ?? '', 140) || '（无文本）'}</div>
      {props.showValidRange ? (
        <div style={{ ...styles.mono, color: token.textTertiary }}>
          key={memoryKey(memory)} · 生效 {memory.validFrom ? formatTime(memory.validFrom) : '—'} →{' '}
          {memory.validTo ? formatTime(memory.validTo) : '至今'}
        </div>
      ) : (
        <div style={{ ...styles.mono, color: token.textTertiary }}>{memoryWindow(memory)}</div>
      )}
    </div>
  );
}

export function LayersView(props: LayersViewProps): JSX.Element {
  const stats = useApi(() => api.layerStats(), []);
  const registry = useApi(() => api.layers(), []);
  const personas = useApi(() => api.personas(), []);
  const [personaFilter, setPersonaFilter] = useState<string>('');
  const l3 = useApi(
    () => api.memories({ layer: 'L3', limit: 100, onlyValid: true, persona: personaFilter || undefined }),
    [personaFilter],
  );
  const l2 = useApi(
    () => api.memories({ layer: 'L2', limit: 100, onlyValid: true, persona: personaFilter || undefined }),
    [personaFilter],
  );
  const [selectedMemoryId, setSelectedMemoryId] = useState<string | null>(null);
  const detail = useApiAction<MemoryDetailData>();

  const openMemory = useCallback(
    (id: string) => {
      setSelectedMemoryId(id);
      void detail.run(() => api.memoryDetail(id));
    },
    [detail],
  );

  // 从「人格」页跳转：初始化人格过滤条件
  useEffect(() => {
    if (props.focusPersona !== null && props.focusPersona !== undefined) {
      setPersonaFilter(props.focusPersona);
      props.onFocusConsumed?.();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 只在 focusPersona 变化时触发
  }, [props.focusPersona]);

  const refreshAll = (): void => {
    stats.reload();
    registry.reload();
    l3.reload();
    l2.reload();
    personas.reload();
  };

  const registryById = new Map((registry.data?.layers ?? []).map((row) => [row.id, row]));
  const statsRows = stats.data?.layers ?? [];
  const extensionOnly = (registry.data?.layers ?? []).filter((row) => !statsRows.some((stat) => stat.id === row.id));
  const memory = detail.state.data;

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10, flexWrap: 'wrap' }}>
        <span style={styles.subtitle}>
          原始记录 {formatNumber(stats.data?.raw?.records)} · 分段 {formatNumber(stats.data?.raw?.segments)} · 天数{' '}
          {formatNumber(stats.data?.raw?.days)} · 占用 {formatNumber(stats.data?.raw?.bytes)} B
        </span>
        <PersonaFilter
          value={personaFilter}
          onChange={setPersonaFilter}
          personas={personas.data?.definitions ?? []}
          mode="memories"
          label="人格过滤："
        />
        <button type="button" style={{ ...styles.button, marginLeft: 'auto' }} onClick={refreshAll}>
          刷新
        </button>
      </div>

      <SectionTitle first>各层统计</SectionTitle>
      {stats.error ? <ErrorNotice error={stats.error} onRetry={stats.reload} /> : null}
      {stats.phase === 'loading' && statsRows.length === 0 ? <LoadingNotice /> : null}
      {statsRows.length === 0 && stats.phase === 'ready' ? <EmptyState title="尚未注册任何记忆层" /> : null}
      {statsRows.length > 0 ? (
        <div style={{ ...styles.card, padding: 4, overflowX: 'auto' }}>
          <table style={styles.table}>
            <thead>
              <tr>
                <Th>层</Th>
                <Th>版本</Th>
                <Th>依赖</Th>
                <Th>启停</Th>
                <Th style={{ textAlign: 'right' }}>总数</Th>
                <Th style={{ textAlign: 'right' }}>有效</Th>
                <Th style={{ textAlign: 'right' }}>归档</Th>
                <Th style={{ textAlign: 'right' }}>向量覆盖率</Th>
                <Th>最近更新</Th>
              </tr>
            </thead>
            <tbody>
              {statsRows.map((row) => {
                const meta = registryById.get(row.id);
                return (
                  <tr key={row.id}>
                    <Td>
                      <strong>{layerDisplayName(row.id)}</strong>
                      {row.name ? <span style={{ ...styles.statHint, marginLeft: 6 }}>{row.name}</span> : null}
                    </Td>
                    <Td>v{row.version ?? '?'}</Td>
                    <Td mono>{meta?.dependsOn && meta.dependsOn.length > 0 ? meta.dependsOn.join(', ') : 'L0'}</Td>
                    <Td>
                      <Badge tone={meta?.enabled === false ? 'warn' : 'success'}>{meta?.enabled === false ? '停用' : '启用'}</Badge>
                      {meta?.kind === 'extension' ? <Badge tone="info">扩展</Badge> : null}
                    </Td>
                    <Td mono style={{ textAlign: 'right' }}>{formatNumber(row.total)}</Td>
                    <Td mono style={{ textAlign: 'right' }}>{formatNumber(row.active)}</Td>
                    <Td mono style={{ textAlign: 'right' }}>{formatNumber(row.archived)}</Td>
                    <Td mono style={{ textAlign: 'right' }}>{formatPercent(row.embeddingCoverage)}</Td>
                    <Td>{formatRelative(row.latestUpdatedAt)}</Td>
                  </tr>
                );
              })}
              {extensionOnly.map((row) => (
                <tr key={row.id}>
                  <Td>
                    <strong>{layerDisplayName(row.id)}</strong>
                    {row.name ? <span style={{ ...styles.statHint, marginLeft: 6 }}>{row.name}</span> : null}
                  </Td>
                  <Td>v{row.version ?? '?'}</Td>
                  <Td mono>{row.dependsOn && row.dependsOn.length > 0 ? row.dependsOn.join(', ') : 'L0'}</Td>
                  <Td>
                    <Badge tone={row.enabled === false ? 'warn' : 'success'}>{row.enabled === false ? '停用' : '启用'}</Badge>
                    <Badge tone="info">扩展</Badge>
                  </Td>
                  <Td mono style={{ textAlign: 'right' }}>{formatNumber(row.count)}</Td>
                  <Td mono style={{ textAlign: 'right' }}>{formatNumber(row.active)}</Td>
                  <Td mono style={{ textAlign: 'right' }}>{formatNumber(row.archived)}</Td>
                  <Td mono style={{ textAlign: 'right' }}>—</Td>
                  <Td>{formatRelative(row.latestUpdatedAt)}</Td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(340px, 1fr))', gap: 12, marginTop: 14 }}>
        {/* L3 语义表 */}
        <div style={{ ...styles.card, padding: 10 }}>
          <SectionTitle first extra={<span style={styles.statHint}>{formatNumber(l3.data?.total)} 条</span>}>
            L3 语义记忆
          </SectionTitle>
          {l3.error ? <ErrorNotice error={l3.error} onRetry={l3.reload} /> : null}
          {l3.phase === 'loading' && (l3.data?.items ?? []).length === 0 ? <LoadingNotice /> : null}
          {(l3.data?.items ?? []).length === 0 && l3.phase === 'ready' ? (
            <EmptyState title="暂无 L3 语义记忆" hint="数据不足或派生尚未运行（可从 L0 重建）。" />
          ) : null}
          {(l3.data?.items ?? []).map((item) => (
            <MemoryRow
              key={item.id}
              memory={item}
              selected={selectedMemoryId === item.id}
              onSelect={() => openMemory(item.id)}
              showValidRange
            />
          ))}
        </div>

        {/* L2 情节列表 */}
        <div style={{ ...styles.card, padding: 10 }}>
          <SectionTitle first extra={<span style={styles.statHint}>{formatNumber(l2.data?.total)} 条</span>}>
            L2 情节
          </SectionTitle>
          {l2.error ? <ErrorNotice error={l2.error} onRetry={l2.reload} /> : null}
          {l2.phase === 'loading' && (l2.data?.items ?? []).length === 0 ? <LoadingNotice /> : null}
          {(l2.data?.items ?? []).length === 0 && l2.phase === 'ready' ? (
            <EmptyState title="暂无 L2 情节" hint="会话结束后会归纳为情节；也可从 L0 重建。" />
          ) : null}
          {(l2.data?.items ?? []).map((item) => (
            <MemoryRow key={item.id} memory={item} selected={selectedMemoryId === item.id} onSelect={() => openMemory(item.id)} showValidRange={false} />
          ))}
        </div>
      </div>

      {/* 记忆详情 */}
      {selectedMemoryId ? (
        <div style={{ ...styles.card, marginTop: 12 }}>
          <SectionTitle first extra={<button type="button" style={styles.button} onClick={() => setSelectedMemoryId(null)}>关闭详情</button>}>
            记忆详情 <span style={{ ...styles.mono, color: token.textSecondary }}>{selectedMemoryId}</span>
          </SectionTitle>
          {detail.state.pending ? <LoadingNotice label="读取记忆详情…" /> : null}
          {detail.state.error ? <ErrorNotice error={detail.state.error} onRetry={() => openMemory(selectedMemoryId)} /> : null}
          {memory ? (
            <div>
              <div style={{ ...styles.wrap, marginBottom: 8 }}>
                <Badge tone="brand">{layerDisplayName(memory.memory.layer)}</Badge>
                {memory.memory.kind ? <Badge tone="neutral">{memory.memory.kind}</Badge> : null}
                {memory.memory.status ? <Badge tone={memory.memory.status === 'active' ? 'success' : 'warn'}>{memory.memory.status}</Badge> : null}
                {memory.memory.revision !== undefined ? <Badge tone="neutral">rev {memory.memory.revision}</Badge> : null}
                <RetentionBadge record={memory.memory} showScore />
                <PersonaBadge personaId={memory.memory.personaId} />
              </div>
              <div style={{ fontSize: 13, whiteSpace: 'pre-wrap', wordBreak: 'break-word', marginBottom: 10 }}>
                {memory.memory.text ?? '（无文本）'}
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: 12 }}>
                <div>
                  <KV label="canonicalKey" mono>
                    {memoryKey(memory.memory as MemoryRecordPreview)}
                  </KV>
                  <KV label="重要度 / 置信度">
                    {formatPercent(memory.memory.importance)} / {formatPercent(memory.memory.confidence)}
                  </KV>
                  <KV label="人格">{memory.memory.personaId ? `persona:${memory.memory.personaId}` : '共享'}</KV>
                  <KV label="记忆分层 / 分数">
                    {retentionLongLabel(retentionOf(memory.memory)?.tier)} · {formatScore(retentionOf(memory.memory)?.score)}
                    {retentionOf(memory.memory)?.pinned ? ' · 已钉住（始终保留）' : ''}
                  </KV>
                  <KV label="生效区间">
                    {memory.memory.validFrom ? formatTime(memory.memory.validFrom) : '—'} →{' '}
                    {memory.memory.validTo ? formatTime(memory.memory.validTo) : '至今'}
                  </KV>
                  <KV label="来源 raw" >
                    {(memory.memory.sourceRawIds ?? []).length === 0 ? (
                      <span style={styles.muted}>—</span>
                    ) : (
                      <span style={{ display: 'inline-flex', gap: 6, flexWrap: 'wrap' }}>
                        {(memory.memory.sourceRawIds ?? []).map((rawId) => (
                          <button key={rawId} type="button" style={{ ...styles.linkButton, fontFamily: 'monospace' }} onClick={() => props.onOpenRaw(rawId)}>
                            {rawId}
                          </button>
                        ))}
                      </span>
                    )}
                  </KV>
                  {(memory.sources ?? []).length > 0 ? (
                    <KV label="溯源链接">
                      <span style={{ display: 'inline-flex', gap: 6, flexWrap: 'wrap' }}>
                        {(memory.sources ?? []).map((source, index) => (
                          <button
                            key={`${source.rawId ?? index}`}
                            type="button"
                            style={{ ...styles.linkButton, fontFamily: 'monospace' }}
                            onClick={() => source.rawId && props.onOpenRaw(source.rawId)}
                          >
                            {source.rawId ?? '—'}
                            {source.relation ? ` (${source.relation})` : ''}
                          </button>
                        ))}
                      </span>
                    </KV>
                  ) : null}
                </div>
                <div>
                  <div style={{ ...styles.statLabel, marginBottom: 4 }}>修订历史（{memory.revisions?.length ?? 0}）</div>
                  {(memory.revisions ?? []).length === 0 ? (
                    <div style={styles.muted}>无修订记录</div>
                  ) : (
                    <div style={{ maxHeight: 220, overflow: 'auto' }}>
                      <table style={styles.table}>
                        <thead>
                          <tr>
                            <Th>rev</Th>
                            <Th>变更</Th>
                            <Th>时间</Th>
                            <Th>文本</Th>
                          </tr>
                        </thead>
                        <tbody>
                          {(memory.revisions ?? []).map((revision, index) => (
                            <tr key={`${revision.revision ?? index}`}>
                              <Td mono>{revision.revision ?? '—'}</Td>
                              <Td>{revision.changeKind ?? '—'}</Td>
                              <Td>{formatTime(revision.changedAt)}</Td>
                              <Td>{truncate(revision.text ?? '', 80)}</Td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                  {memory.l3Semantic ? (
                    <div style={{ marginTop: 8 }}>
                      <JsonBlock value={memory.l3Semantic} label="L3 语义扩展字段" />
                    </div>
                  ) : null}
                </div>
              </div>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}



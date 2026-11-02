// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hanxustu (dsh-life-memory)
/**
 * 记忆分层（只读）：短期 / 中期 / 长期（retention 维度，短 → 中 → 长期晋升阶梯）。
 *
 * 与「三层记忆模型」（L1 工作记忆层 / L2 情景记忆层 / L3 语义记忆层，按内容类型）
 * 是两个并存的正交框架：retention 描述“该保留多久”，layer 描述“是什么类型”。
 *
 * 数据：
 * - `GET /api/life-memory/retention` → 三层统计（short/mid/long、pinned、lastTickAt）+ countsByLayer + generatedAt；
 * - `GET /api/life-memory/memories?retention=short|mid|long` → 某层的记忆列表（可切换）；
 * - `GET /api/life-memory/memory-detail?id=` → 点击条目查看详情与来源 raw 记录。
 *
 * 只读保证：本页所有请求都是 GET；宿主对 UI 浏览不写治理数据（浏览不改变分层）。
 */
import { useCallback, useMemo, useState } from 'react';
import { ApiError, api, useApi, useApiAction } from '../api.ts';
import {
  Badge,
  EmptyState,
  ErrorNotice,
  KV,
  LoadingNotice,
  PersonaBadge,
  PersonaFilter,
  PinIcon,
  RetentionBadge,
  SectionTitle,
} from '../components.tsx';
import { styles, token } from '../theme.tsx';
import type { MemoryDetailData, MemoryRecordPreview, RetentionStats } from '../types.ts';
import {
  compareRetention,
  formatNumber,
  formatRelative,
  formatScore,
  formatTime,
  layerDisplayName,
  retentionLongLabel,
  retentionOf,
  truncate,
} from '../util.ts';

const RETENTION_TIERS = [
  {
    id: 'short',
    label: '短期',
    hint: '新产生 / 尚未巩固的记忆（所有新记忆的默认层）',
    tone: 'info' as const,
  },
  {
    id: 'mid',
    label: '中期',
    hint: '已保留一段时间、进入常规巩固',
    tone: 'brand' as const,
  },
  {
    id: 'long',
    label: '长期',
    hint: '稳定 / 重要 / 被反复引用或被钉住，长期保留',
    tone: 'success' as const,
  },
] as const;

type RetentionTierId = (typeof RETENTION_TIERS)[number]['id'];

function retentionHint(tier: string): string {
  return RETENTION_TIERS.find((item) => item.id === tier)?.hint ?? '';
}

function countOf(stats: RetentionStats | undefined, tier: RetentionTierId): number | undefined {
  if (!stats) return undefined;
  if (tier === 'short') return stats.short;
  if (tier === 'mid') return stats.mid;
  return stats.long;
}

/** 单条记忆行（列表用） */
function RetentionRow(props: {
  memory: MemoryRecordPreview;
  selected: boolean;
  onSelect: () => void;
  onOpenRaw: (rawId: string) => void;
}): JSX.Element {
  const { memory } = props;
  const retention = retentionOf(memory);
  const meta = typeof memory.meta === 'object' && memory.meta !== null ? (memory.meta as Record<string, unknown>) : {};
  const rawIds = Array.isArray(meta.sourceRawIds)
    ? (meta.sourceRawIds as unknown[]).filter((item): item is string => typeof item === 'string')
    : [];
  const previewRaw = rawIds.length > 0 ? rawIds[0] : null;
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
      style={{ ...styles.listItem, ...(props.selected ? styles.listItemActive : {}) }}
    >
      <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
        <RetentionBadge record={memory} showScore />
        <PersonaBadge personaId={memory.personaId} />
        <Badge tone="neutral">{layerDisplayName(memory.layer)}</Badge>
        {memory.kind ? <Badge tone="info">{memory.kind}</Badge> : null}
        {memory.status && memory.status !== 'active' ? <Badge tone="warn">{memory.status}</Badge> : null}
        {retention?.pinned ? (
          <span style={{ color: token.warn, display: 'inline-flex', alignItems: 'center', gap: 2, fontSize: 11 }}>
            <PinIcon /> 钉住
          </span>
        ) : null}
        <span style={{ ...styles.statHint, marginLeft: 'auto' }}>{formatRelative(memory.updatedAt)}</span>
      </div>
      <div style={{ fontSize: 12, wordBreak: 'break-word' }}>
        {truncate(memory.text ?? memory.summary ?? '', 180) || '（无文本）'}
      </div>
      <div style={{ ...styles.mono, color: token.textTertiary, display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
        <span>retentionScore {formatScore(retention?.score)}</span>
        <span>{memory.id}</span>
        {previewRaw ? (
          <button
            type="button"
            style={{ ...styles.linkButton, fontFamily: 'monospace', fontSize: 11 }}
            title="打开来源原始记录"
            onClick={(event) => {
              event.stopPropagation();
              props.onOpenRaw(previewRaw);
            }}
          >
            原文 {previewRaw}
          </button>
        ) : null}
      </div>
    </div>
  );
}

function RetentionCard(props: {
  tier: (typeof RETENTION_TIERS)[number];
  stats: RetentionStats | undefined;
  selected: boolean;
  onSelect: () => void;
}): JSX.Element {
  const { tier, stats } = props;
  const count = countOf(stats, tier.id);
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
        ...styles.card,
        cursor: 'pointer',
        border: `1px solid ${props.selected ? token.brand : token.borderL2}`,
        background: props.selected ? token.bgLayer2 : token.bgLayer1,
      }}
      title={`查看${tier.label}记忆列表`}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
        <Badge tone={tier.tone}>{tier.label}记忆</Badge>
        {tier.id === 'long' && stats?.pinned !== undefined ? (
          <Badge tone="warn" title="钉住的记忆直接进入长期层并保留">
            <PinIcon /> 钉住 {formatNumber(stats.pinned)}
          </Badge>
        ) : null}
      </div>
      <div style={styles.statValue}>{count === undefined ? '—' : formatNumber(count)}</div>
      <div style={styles.statHint}>{tier.hint}</div>
      <div style={{ ...styles.statHint, marginTop: 4 }}>
        最近 tick：{stats?.lastTickAt ? formatRelative(stats.lastTickAt) : '—'}
      </div>
    </div>
  );
}

export interface RetentionViewProps {
  onOpenRaw: (rawId: string) => void;
}

export function RetentionView(props: RetentionViewProps): JSX.Element {
  const [tier, setTier] = useState<RetentionTierId>('short');
  const [selectedMemoryId, setSelectedMemoryId] = useState<string | null>(null);
  const [personaFilter, setPersonaFilter] = useState<string>('');

  const retention = useApi(() => api.retention(), []);
  const personas = useApi(() => api.personas(), []);
  // status 兜底：若 /retention 尚未就绪但 /status 已带 retention 统计，仍能显示三层计数
  const status = useApi(() => api.status(false), []);
  const memories = useApi(
    () => api.memories({ retention: tier, limit: 50, onlyValid: true, persona: personaFilter || undefined }),
    [tier, personaFilter],
  );
  const detail = useApiAction<MemoryDetailData>();

  const stats: RetentionStats | undefined = retention.data?.stats ?? status.data?.retention ?? undefined;
  const retentionError: ApiError | null = retention.error;
  const listError: ApiError | null = memories.error;

  const list: MemoryRecordPreview[] = useMemo(() => {
    const items = memories.data?.items ?? [];
    // 兼容旧宿主：/memories 尚未支持 retention 过滤时，客户端按 retention 字段过滤
    const withRetention = items.filter((item) => retentionOf(item) !== null);
    const source = withRetention.length > 0 ? withRetention.filter((item) => retentionOf(item)?.tier === tier) : items;
    return [...source].sort(compareRetention);
  }, [memories.data, tier]);

  const openMemory = useCallback(
    (id: string) => {
      setSelectedMemoryId(id);
      void detail.run(() => api.memoryDetail(id));
    },
    [detail],
  );

  const refreshAll = (): void => {
    retention.reload();
    status.reload();
    memories.reload();
    personas.reload();
  };

  const generatedAt = retention.data?.generatedAt;
  // v3 遗忘统计（来自 /status.forgetting）：短期到期删/中期到期归档/最近遗忘时间
  const forgetting = status.data?.forgetting ?? undefined;
  const currentTier = RETENTION_TIERS.find((item) => item.id === tier) ?? RETENTION_TIERS[0];
  const memory = detail.state.data;
  const missingRetentionFields =
    (memories.data?.items ?? []).length > 0 && (memories.data?.items ?? []).every((item) => retentionOf(item) === null);

  return (
    <div>
      <div style={{ ...styles.row, gap: 8, flexWrap: 'wrap', marginBottom: 10 }}>
        <Badge tone="brand">记忆分层模型（短期 / 中期 / 长期）</Badge>
        <span style={styles.statHint}>
          记忆分层（短/中/长，保留时长）与记忆类型（L1 工作 / L2 情景 / L3 语义，内容类型）共同描述每条记忆
        </span>
        {generatedAt ? <span style={{ ...styles.statHint, marginLeft: 'auto' }}>生成于 {formatTime(generatedAt)}</span> : null}
        <button type="button" style={{ ...styles.button, marginLeft: generatedAt ? 0 : 'auto' }} onClick={refreshAll}>
          刷新
        </button>
      </div>

      {retentionError ? (
        <div style={{ marginBottom: 10 }}>
          <ErrorNotice error={retentionError} onRetry={refreshAll} />
          <div style={{ ...styles.statHint, marginTop: 4 }}>
            /retention 接口尚未就绪时，本页会回退到 /status 的 retention 统计与 /memories 列表（等待宿主联调）。
          </div>
        </div>
      ) : null}

      <div style={styles.cardGrid}>
        {RETENTION_TIERS.map((item) => (
          <RetentionCard
            key={item.id}
            tier={item}
            stats={stats}
            selected={tier === item.id}
            onSelect={() => {
              setTier(item.id);
              setSelectedMemoryId(null);
              detail.reset();
            }}
          />
        ))}
      </div>

      <div style={{ ...styles.row, gap: 6, margin: '16px 0 8px', flexWrap: 'wrap' }}>
        <SectionTitle first>{retentionLongLabel(tier)}列表</SectionTitle>
        <span style={styles.statHint}>({retentionHint(tier)})</span>
        <PersonaFilter
          value={personaFilter}
          onChange={setPersonaFilter}
          personas={personas.data?.definitions ?? []}
          mode="memories"
          label="人格过滤："
        />
        <span style={{ ...styles.statHint, marginLeft: 'auto' }}>
          共 {formatNumber(memories.data?.total ?? countOf(stats, tier) ?? list.length)} 条（列表仅显示当前有效记忆；卡片统计含历史归档）
          · 按 pinned / retentionScore 排序 · 只读浏览不会改变分层
        </span>
      </div>

      {listError ? <ErrorNotice error={listError} onRetry={memories.reload} /> : null}
      {missingRetentionFields && (memories.data?.items ?? []).length > 0 ? (
        <div style={{ ...styles.statHint, marginBottom: 6 }}>
          宿主尚未在该响应中返回 retention 字段（等待联调）；列表可能未按记忆分层过滤。
        </div>
      ) : null}

      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1.2fr) minmax(300px, 1fr)', gap: 12 }}>
        <div style={{ ...styles.card, padding: 8, minWidth: 0 }}>
          {memories.phase === 'loading' && list.length === 0 ? <LoadingNotice label={`读取${retentionLongLabel(tier)}…`} /> : null}
          {memories.phase === 'ready' && list.length === 0 ? (
            <EmptyState
              title={`暂无${retentionLongLabel(tier)}`}
              hint="记忆分层只升不降（short → mid → long，新记忆先进入短期）；也可能尚未派生任何记忆。"
            />
          ) : null}
          {list.map((item) => (
            <RetentionRow
              key={item.id}
              memory={item}
              selected={selectedMemoryId === item.id}
              onSelect={() => openMemory(item.id)}
              onOpenRaw={props.onOpenRaw}
            />
          ))}
        </div>

        {/* 详情（点击条目后加载 /memory-detail?id=） */}
        <div style={{ ...styles.card, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
            <strong style={{ fontSize: 13 }}>记忆详情</strong>
            <RetentionBadge record={memory?.memory} showScore />
            {selectedMemoryId ? (
              <span style={{ ...styles.mono, color: token.textTertiary, marginLeft: 'auto' }}>{selectedMemoryId}</span>
            ) : null}
          </div>
          {!selectedMemoryId ? (
            <EmptyState title="点击左侧条目查看详情" hint="可查看完整文本、记忆分层状态与来源原始记录（只读）。" />
          ) : null}
          {detail.state.pending ? <LoadingNotice label="读取记忆详情…" /> : null}
          {detail.state.error ? (
            <ErrorNotice error={detail.state.error} onRetry={() => selectedMemoryId && openMemory(selectedMemoryId)} />
          ) : null}
          {memory ? (
            <div>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 8 }}>
                <Badge tone="neutral">{layerDisplayName(memory.memory.layer)}</Badge>
                {memory.memory.kind ? <Badge tone="info">{memory.memory.kind}</Badge> : null}
                {memory.memory.status ? (
                  <Badge tone={memory.memory.status === 'active' ? 'success' : 'warn'}>{memory.memory.status}</Badge>
                ) : null}
                <RetentionBadge record={memory.memory} showScore />
                <PersonaBadge personaId={memory.memory.personaId} />
              </div>
              <div style={{ fontSize: 13, whiteSpace: 'pre-wrap', wordBreak: 'break-word', marginBottom: 8 }}>
                {memory.memory.text ?? '（无文本）'}
              </div>
              <KV label="记忆分层">{retentionLongLabel(retentionOf(memory.memory)?.tier)}</KV>
              <KV label="retentionScore">{formatScore(retentionOf(memory.memory)?.score)}</KV>
              <KV label="钉住">{retentionOf(memory.memory)?.pinned ? '是（始终保留）' : '否'}</KV>
              <KV label="记忆类型">{layerDisplayName(memory.memory.layer)}</KV>
              <KV label="人格">{memory.memory.personaId ? `persona:${memory.memory.personaId}` : '共享'}</KV>
              <KV label="重要度 / 置信度">
                {formatScore(memory.memory.importance)} / {formatScore(memory.memory.confidence)}
              </KV>
              <KV label="最近更新">{formatTime(memory.memory.updatedAt)}</KV>
              <KV label="来源原始记录">
                {(memory.memory.sourceRawIds ?? []).length === 0 ? (
                  <span style={styles.muted}>—</span>
                ) : (
                  <span style={{ display: 'inline-flex', gap: 6, flexWrap: 'wrap' }}>
                    {(memory.memory.sourceRawIds ?? []).map((rawId) => (
                      <button
                        key={rawId}
                        type="button"
                        style={{ ...styles.linkButton, fontFamily: 'monospace', fontSize: 11 }}
                        onClick={() => props.onOpenRaw(rawId)}
                      >
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
                        style={{ ...styles.linkButton, fontFamily: 'monospace', fontSize: 11 }}
                        onClick={() => source.rawId && props.onOpenRaw(source.rawId)}
                      >
                        {source.rawId ?? '—'}
                        {source.relation ? ` (${source.relation})` : ''}
                      </button>
                    ))}
                  </span>
                </KV>
              ) : null}
              {(memory.revisions ?? []).length > 0 ? (
                <div style={{ ...styles.statHint, marginTop: 8 }}>
                  修订历史 {memory.revisions?.length} 条（最近：{memory.revisions?.[0]?.changeKind ?? '—'}{' '}
                  {formatTime(memory.revisions?.[0]?.changedAt)}）
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>

      <div style={{ ...styles.card, marginTop: 14, padding: 10 }}>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <Badge tone="warn">遗忘策略（v3）</Badge>
          <span style={styles.statHint}>短期到期删除 / 中期到期归档 / 长期永久；原始层与向量模型不遗忘</span>
        </div>
        <div style={{ ...styles.statHint, marginTop: 6 }}>
          已删除短期 {formatNumber(forgetting?.shortDeleted)} 条 · 已归档中期 {formatNumber(forgetting?.midArchived)} 条 ·
          最近遗忘 {forgetting?.lastForgetAt ? formatRelative(forgetting.lastForgetAt) : '尚未发生'}
        </div>
        <div style={{ ...styles.statHint, marginTop: 6, lineHeight: 1.7 }}>
          说明：短期记忆=新产生/尚未巩固的记忆（所有新记忆默认层）；中期记忆=已保留一段时间、进入常规巩固；
          长期记忆=稳定/重要/被反复引用或被钉住的记忆。分层晋升只升不降（short → mid → long），
          但**到期且未晋升**的记忆会被遗忘（短期物理删除 / 中期归档）；pinned 与高重要度记忆受保护。
          遗忘只作用于三层记忆（派生层），L0 原始档案与原始层向量模型永久保留；本页面只读展示，浏览不会改动数据。
          记忆类型（工作/情景/语义）与记忆分层（短/中/长期）相互独立，共同描述每条记忆。
        </div>
      </div>
    </div>
  );
}

/** 类型导出（便于后续页面复用） */
export type RetentionTierIdValue = RetentionTierId;


// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hanxustu (dsh-life-memory)
/**
 * 概览 Overview（只读）：
 * 健康徽标 + 原始档案数字卡 + 记忆分层（短期/中期/长期）计数卡 + 人格（当前人格）卡 +
 * 访问与遗忘（v3）卡 + 三层记忆类型（L1 工作 / L2 情景 / L3 语义）卡片 + 嵌入模型/维度 +
 * 捕获/派生水位 + DB 大小。
 *
 * 维度：人格（作用域，v4）× retention（短/中/长期，保留时长）× layer（工作/情景/语义，内容类型）。
 */
import { api, useApi } from '../api.ts';
import { Badge, ErrorNotice, HealthBadge, KV, LoadingNotice, SectionTitle, StatCard } from '../components.tsx';
import { styles } from '../theme.tsx';
import type { LayerRegistryRow, LayerStatRow, PersonaMemoryCount } from '../types.ts';
import { formatBytes, formatNumber, formatPercent, formatRelative, formatTime, layerDisplayName } from '../util.ts';
import { NewSessionDefaults } from './hero-options.tsx';

function personaCountTotal(count: PersonaMemoryCount | undefined): number | undefined {
  if (!count) return undefined;
  if (typeof count.total === 'number') return count.total;
  const parts = [count.L1, count.L2, count.L3].filter((value): value is number => typeof value === 'number');
  return parts.length > 0 ? parts.reduce((sum, value) => sum + value, 0) : undefined;
}

function uptimeLabel(ms: number | undefined): string {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return '—';
  const totalMinutes = Math.floor(ms / 60_000);
  if (totalMinutes < 60) return `${totalMinutes} 分钟`;
  const hours = Math.floor(totalMinutes / 60);
  if (hours < 48) return `${hours} 小时 ${totalMinutes % 60} 分`;
  return `${Math.floor(hours / 24)} 天 ${hours % 24} 小时`;
}

function layerName(row: LayerStatRow | LayerRegistryRow, index: number): string {
  if (row.id === 'L1' || row.id === 'L2' || row.id === 'L3') return layerDisplayName(row.id);
  const fallback = ['L1 工作记忆层', 'L2 情景记忆层', 'L3 语义记忆层'][index];
  return row.name ?? fallback ?? row.id;
}

export interface OverviewViewProps {
  /** 点击“查看记忆分层”时切换到记忆分层页签 */
  onOpenRetention?: () => void;
  /** 点击“查看人格”时切换到人格页签 */
  onOpenPersona?: () => void;
}

export function OverviewView(props: OverviewViewProps = {}): JSX.Element {
  const health = useApi(() => api.health(), []);
  const status = useApi(() => api.status(false), []);
  const stats = useApi(() => api.layerStats(), []);
  const retention = useApi(() => api.retention(), []);
  const personas = useApi(() => api.personas(), []);
  const vaults = useApi(() => api.vaults(), []);
  const now = Date.now();

  const refreshAll = (): void => {
    health.reload();
    status.reload();
    stats.reload();
    retention.reload();
    personas.reload();
    vaults.reload();
  };

  const healthData = health.data;
  const statusData = status.data;
  const statsData = stats.data;
  // 记忆分层统计：/retention 优先，/status.retention 兜底（宿主新旧版本兼容）
  const retentionStats = retention.data?.stats ?? statusData?.retention ?? undefined;
  // v3：原始层向量索引（永久模型）+ 三层记忆遗忘统计（来自 /status）
  const vectorStats = statusData?.vectors ?? undefined;
  const forgettingStats = statusData?.forgetting ?? undefined;
  // 契约（Host v3 当前语义）：
  //   total   = raw_index 总数（含空文本 raw：turn/session 等纯事件，按设计永不嵌入）
  //   pending = 有文本但缺向量的 raw 数（回填完成后应为 0；不含空文本 raw）
  //   embedded = 精确已嵌入数（Host 提案中；字段落地前不要用 total-pending 推算，会高估）
  const vectorEmbedded = typeof vectorStats?.embedded === 'number' ? vectorStats.embedded : undefined;
  const vectorPending = typeof vectorStats?.pending === 'number' ? vectorStats.pending : undefined;
  const vectorTotal = typeof vectorStats?.total === 'number' ? vectorStats.total : undefined;

  // v4：人格（记忆作用域）—— /personas 优先，/status.persona 兜底
  const personaHealth = statusData?.persona ?? undefined;
  const personaData = personas.data;
  // v5：全局激活人格优先取 /vaults.activePersonaId（默认会话可能路由共享库）
  const personaActiveId = vaults.data?.activePersonaId ?? personaData?.activeId ?? personaHealth?.activeId ?? null;
  const personaDefinitions = personaData?.definitions ?? personaHealth?.definitions ?? [];
  const personaMemoryCounts = personaData?.memoryCounts ?? personaHealth?.memoryCounts ?? {};
  const personaSharedCount = personaData?.sharedCount ?? personaHealth?.sharedCount;
  const personaActiveDefinition = personaActiveId
    ? personaDefinitions.find((definition) => definition.id === personaActiveId)
    : undefined;
  const personaActiveName =
    personaActiveDefinition?.name || personaHealth?.activeName || personaActiveId || null;
  const personaActiveCount = personaActiveDefinition
    ? (personaActiveDefinition.memories ?? personaMemoryCounts[personaActiveDefinition.id])
    : personaActiveId
      ? personaMemoryCounts[personaActiveId]
      : undefined;
  const personaValidCount = personaDefinitions.filter((definition) => definition.valid !== false).length;
  const personaInvalidCount = personaDefinitions.filter((definition) => definition.valid === false).length;

  // v5：记忆库（vault）总览 —— 当前库名 + 库数量（会话级开关在会话内「记忆库」页签设置）
  const vaultList = vaults.data?.vaults ?? [];
  const activeVaultId = vaults.data?.activeVaultId ?? null;
  const activeVaultInfo = activeVaultId ? vaultList.find((vault) => vault.id === activeVaultId) : undefined;
  const activeVaultName =
    activeVaultInfo?.name ?? (activeVaultId === 'shared' || activeVaultId === null ? (activeVaultId === null ? '（未知）' : '共享库') : activeVaultId);

  const raw = statsData?.raw ?? statusData?.vault;
  const storage = statusData?.storage;
  const embedding = storage?.embedding ?? null;

  // 层卡片来源：stats-layers（数量/覆盖率）优先，status.layers（含扩展层注册信息）补足
  const statRows: LayerStatRow[] = statsData?.layers ?? [];
  const registryRows: LayerRegistryRow[] = statusData?.layers ?? [];
  const registryById = new Map(registryRows.map((row) => [row.id, row]));
  const cardRows: Array<LayerStatRow & { enabled?: boolean; kind?: string }> = statRows.map((row) => {
    const registry = registryById.get(row.id);
    return { ...row, enabled: registry?.enabled, kind: registry?.kind };
  });
  for (const registry of registryRows) {
    if (!cardRows.some((row) => row.id === registry.id)) {
      cardRows.push({
        id: registry.id,
        name: registry.name,
        version: registry.version,
        total: registry.count,
        active: registry.active,
        archived: registry.archived,
        latestUpdatedAt: registry.latestUpdatedAt,
        enabled: registry.enabled,
        kind: registry.kind,
      });
    }
  }

  const topError = health.error ?? stats.error ?? status.error;

  return (
    <div>
      <div style={{ ...styles.row, flexWrap: 'wrap', marginBottom: 12 }}>
        <HealthBadge ok={healthData?.ok ?? statusData?.health?.ok} readonly={healthData?.readonly ?? statusData?.readonly} />
        {healthData?.lastVerify ? (
          <Badge tone={healthData.lastVerify.ok === false ? 'error' : 'success'}>
            最近校验 {healthData.lastVerify.ok === false ? '失败' : '通过'}
            {typeof healthData.lastVerify.checked === 'number' ? ` · ${formatNumber(healthData.lastVerify.checked)} 条` : ''}
          </Badge>
        ) : (
          <Badge tone="neutral">尚无整库校验记录</Badge>
        )}
        <Badge tone="neutral">运行 {uptimeLabel(healthData?.uptimeMs ?? statusData?.uptimeMs)}</Badge>
        {healthData?.lastError || statusData?.health?.lastError ? (
          <Badge tone="error" title={healthData?.lastError ?? statusData?.health?.lastError ?? ''}>
            最近错误：{String(healthData?.lastError ?? statusData?.health?.lastError).slice(0, 80)}
          </Badge>
        ) : (
          <Badge tone="success">无最近错误</Badge>
        )}
        <button type="button" style={{ ...styles.button, marginLeft: 'auto' }} onClick={refreshAll}>
          刷新
        </button>
      </div>

      {topError ? <ErrorNotice error={topError} onRetry={refreshAll} /> : null}

      <SectionTitle>数据保留与删除</SectionTitle>
      <div style={{ ...styles.card, border: '1px solid rgba(245, 158, 11, 0.45)', background: 'rgba(245, 158, 11, 0.07)' }}>
        <div style={styles.statHint}>
          原始记忆（L0）与 SQLite 数据库默认<strong> 永久保留、只追加不改写</strong>。
        </div>
        <div style={{ ...styles.statHint, marginTop: 8 }}>
          如需彻底删除并「从 0 开始」：请先<strong>完全退出 DSH</strong>，再人工删除目录（建议先备份/导出）：
        </div>
        <KV label="数据目录" mono>
          {statusData?.dataDir ?? '—'}
        </KV>
        <div style={{ ...styles.statHint, marginTop: 8 }}>
          （其下的 <code>vaults/</code> 为各人格独立记忆库，<code>exports/</code> 为导出副本。）
          插件不会自动删除任何原始记忆——删除只能由你人工完成。<strong>愿记忆长存。</strong>
        </div>
      </div>
      <SectionTitle first>原始档案（L0，不可变）</SectionTitle>
      <div style={styles.cardGrid}>
        <StatCard label="原始记录数" value={formatNumber(raw?.records)} hint="全量归档，append-only" />
        <StatCard label="分段文件" value={formatNumber(raw?.segments)} hint="segments/*.jsonl" />
        <StatCard label="覆盖天数" value={formatNumber(raw?.days)} hint="按本地日期" />
        <StatCard label="原始档案磁盘占用" value={formatBytes(raw?.bytes)} hint="JSONL 字节数" />
        <StatCard
          label="SQLite 数据库"
          value={formatBytes(storage?.dbBytes)}
          hint={storage?.schemaVersion !== undefined ? `schema v${storage.schemaVersion}` : '含 FTS/向量/索引'}
        />
        <StatCard
          label="向量条数"
          value={formatNumber(storage?.vectorCount)}
          hint={embedding ? `${embedding.model ?? '嵌入模型'} · dim=${embedding.dim ?? '?'}` : '未配置嵌入'}
        />
        <StatCard
          label="派生记忆总数"
          value={formatNumber(storage?.memoryCount)}
          hint={`有效 ${formatNumber(storage?.activeMemoryCount)}`}
        />
        <StatCard label="最近写入" value={formatRelative(raw?.lastTs, now)} hint={raw?.lastId ? `last id ${raw.lastId}` : undefined} />
      </div>

      <SectionTitle
        extra={
          props.onOpenRetention ? (
            <button type="button" style={styles.button} onClick={props.onOpenRetention}>
              查看记忆分层 →
            </button>
          ) : null
        }
      >
        记忆分层模型（短期 / 中期 / 长期）
      </SectionTitle>
      <div style={{ ...styles.statHint, marginBottom: 8 }}>
        记忆分层（短/中/长期，保留时长）× 记忆类型（工作/情景/语义，内容类型）两套框架共同描述每条记忆。
      </div>
      {retention.error && retentionStats === undefined ? (
        <div style={{ ...styles.statHint, marginBottom: 8 }}>
          宿主尚未返回记忆分层统计（/retention 或 /status.retention，等待宿主联调）。
        </div>
      ) : null}
      <div style={styles.cardGrid}>
        <StatCard
          label="短期记忆"
          value={formatNumber(retentionStats?.short)}
          hint="新产生 / 尚未巩固的记忆（所有新记忆默认层）"
        />
        <StatCard
          label="中期记忆"
          value={formatNumber(retentionStats?.mid)}
          hint="已保留一段时间、进入常规巩固"
        />
        <StatCard
          label="长期记忆"
          value={formatNumber(retentionStats?.long)}
          hint="稳定 / 重要 / 被反复引用或被钉住"
        />
        <StatCard
          label="钉住 / 最近 tick"
          value={formatNumber(retentionStats?.pinned)}
          hint={`钉住记忆直接进入长期层 · 最近 tick ${retentionStats?.lastTickAt ? formatRelative(retentionStats.lastTickAt, now) : '—'}`}
        />
      </div>

      <SectionTitle>访问与遗忘（v3：显式检索 × 隐式上下文）</SectionTitle>
      <div style={{ ...styles.statHint, marginBottom: 8 }}>
        显式检索 = L0 原始层 + 原始层向量模型（永不遗忘）；隐式上下文 = 三层记忆（工作/情景/语义，可遗忘）。
        遗忘策略：短期到期删除 / 中期到期归档 / 长期永久；原始层与向量模型不遗忘。
      </div>
      <div style={styles.cardGrid}>
        <StatCard
          label={vectorEmbedded !== undefined ? '原始层向量索引（已嵌入）' : '原始层向量索引（raw 条数）'}
          value={formatNumber(vectorEmbedded ?? vectorTotal)}
          hint={
            <>
              {vectorEmbedded !== undefined
                ? `已嵌入 ${formatNumber(vectorEmbedded)} / 共 ${formatNumber(vectorTotal)} 条 raw（含无文本事件，无需向量）`
                : `共 ${formatNumber(vectorTotal)} 条 raw（含无文本事件，无需向量）`}
              {' · '}待回填 {formatNumber(vectorPending)}（含空文本事件，永不嵌入）
              {' · '}最近回填 {formatRelative(vectorStats?.lastBackfillAt, now)}
              {vectorStats?.ref?.model ? ` · ${vectorStats.ref.model}${vectorStats.ref.dim !== undefined ? ` (dim=${vectorStats.ref.dim})` : ''}` : ''}
              {vectorEmbedded === undefined ? ' · 已嵌入精确数待 Host embedded 字段（旧构建）' : ''}
            </>
          }
        />
        <StatCard
          label="短期到期已删除"
          value={formatNumber(forgettingStats?.shortDeleted)}
          hint="三层记忆物理删除（L0 与原始层向量不受影响）"
        />
        <StatCard
          label="中期到期已归档"
          value={formatNumber(forgettingStats?.midArchived)}
          hint="status=archived，不再参与隐式上下文"
        />
        <StatCard
          label="最近遗忘时间"
          value={forgettingStats?.lastForgetAt ? formatRelative(forgettingStats.lastForgetAt, now) : '—'}
          hint={forgettingStats?.lastForgetAt ? formatTime(forgettingStats.lastForgetAt) : '尚未发生遗忘'}
        />
      </div>

      <SectionTitle
        extra={
          props.onOpenPersona ? (
            <button type="button" style={styles.button} onClick={props.onOpenPersona}>
              查看人格 →
            </button>
          ) : null
        }
      >
        人格（当前人格 · 记忆作用域）
      </SectionTitle>
      <div style={{ ...styles.statHint, marginBottom: 8 }}>
        人格是记忆的使用者（v4）：不同人格拥有各自的工作/情景/语义记忆，默认隔离、可共享；定义来自 markdown 文件（Host 热重载）。
      </div>
      {personas.error && personaHealth === undefined && personaDefinitions.length === 0 ? (
        <div style={{ ...styles.statHint, marginBottom: 8 }}>
          宿主尚未返回人格状态（/personas 或 /status.persona，等待宿主联调）。
        </div>
      ) : null}
      <div style={styles.cardGrid}>
        <StatCard
          label="当前人格"
          value={personaActiveId ? personaActiveName : '未激活'}
          hint={personaActiveId ? `id: ${personaActiveId}` : '所有记忆归为共享；可在会话中通过人格工具切换'}
        />
        <StatCard
          label="人格定义"
          value={formatNumber(personaDefinitions.length)}
          hint={`有效 ${formatNumber(personaValidCount)} · 无效 ${formatNumber(personaInvalidCount)}`}
        />
        <StatCard
          label="当前人格记忆"
          value={formatNumber(personaCountTotal(personaActiveCount))}
          hint={
            personaActiveId
              ? `L1 ${formatNumber(personaActiveCount?.L1)} · L2 ${formatNumber(personaActiveCount?.L2)} · L3 ${formatNumber(personaActiveCount?.L3)}`
              : '未激活（全部为共享）'
          }
        />
        <StatCard
          label="共享记忆"
          value={formatNumber(personaSharedCount)}
          hint="无人格归属（personaId = null），所有激活人格共用"
        />
      </div>

      <SectionTitle>本会话（会话级开关）</SectionTitle>
      <div style={{ ...styles.statHint, marginBottom: 8 }}>
        会话级开关（本会话使用记忆 / 本会话使用人格 / 指定人格）在**会话内「记忆库」标签页**设置（v5，session 作用域）。
        全局页面拿不到 sessionId 时这里仅展示当前记忆库；开关改动会立即保存到 Host（POST /session-config）。
        下方「新会话默认」卡片设置的是下一个新会话的默认值（v5.1）。
      </div>
      <div style={styles.cardGrid}>
        <StatCard label="本会话记忆" value="会话内设置" hint="在会话内「记忆库」标签页开关（默认开启）" />
        <StatCard label="本会话人格" value="会话内设置" hint="开启后按人格隔离；默认关闭（共享库）" />
        <StatCard
          label="当前记忆库"
          value={vaults.error ? '—' : activeVaultName}
          hint={vaults.error ? '/vaults 未就绪（等待 Host 联调）' : activeVaultId ? `vault: ${activeVaultId}` : '共享库'}
        />
        <StatCard label="记忆库数量" value={formatNumber(vaultList.length)} hint="共享库 + 每个人格库（GET /vaults）" />
      </div>

      <div style={{ marginTop: 14 }}>
        <NewSessionDefaults variant="panel" />
      </div>

      <SectionTitle>三层记忆模型（工作 / 情景 / 语义 + 扩展层）</SectionTitle>
      {stats.phase === 'loading' && statsData === null ? <LoadingNotice /> : null}
      {cardRows.length === 0 && stats.phase === 'ready' ? (
        <div style={styles.muted}>尚未注册任何记忆层（或层派生还未运行）。</div>
      ) : (
        <div style={styles.cardGrid}>
          {cardRows.map((row, index) => (
            <div key={row.id} style={styles.card}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                <strong style={{ fontSize: 13 }}>{layerName(row, index)}</strong>
                <Badge tone={row.enabled === false ? 'warn' : 'neutral'}>{row.id}</Badge>
                {row.enabled === false ? <Badge tone="warn">已停用</Badge> : null}
                {row.kind === 'extension' ? <Badge tone="info">扩展层</Badge> : null}
              </div>
              <div style={{ ...styles.row, marginTop: 8, alignItems: 'baseline', gap: 14, flexWrap: 'wrap' }}>
                <span style={styles.statValue}>{formatNumber(row.total ?? row.active)}</span>
                <span style={styles.statHint}>条</span>
                <span style={styles.statHint}>有效 {formatNumber(row.active)}</span>
                <span style={styles.statHint}>归档 {formatNumber(row.archived)}</span>
              </div>
              <div style={{ ...styles.statHint, marginTop: 6 }}>
                向量覆盖率 {formatPercent(row.embeddingCoverage)} · 版本 v{row.version ?? '?'} · 更新{' '}
                {formatRelative(row.latestUpdatedAt, now)}
              </div>
            </div>
          ))}
        </div>
      )}

      <SectionTitle>嵌入与水位</SectionTitle>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 12 }}>
        <div style={styles.card}>
          <KV label="嵌入模型">
            {embedding?.model ?? '—'}
            {embedding?.dim !== undefined ? ` · dim=${embedding.dim}` : ''}
            {embedding?.version ? ` · v${embedding.version}` : ''}
          </KV>
          <KV label="数据目录" mono>
            {statusData?.dataDir ?? '—'}
          </KV>
          <KV label="存储作用域">{statusData?.scope ?? '—'}</KV>
          <KV label="数据库路径" mono>
            {storage?.dbPath ?? '—'}
          </KV>
          <KV label="模式">
            <Badge tone="info">只读面板</Badge>
          </KV>
        </div>
        <div style={styles.card}>
          <KV label="捕获水位">
            已捕获 {formatNumber(statusData?.capture?.captured)} · 队列 {formatNumber(statusData?.capture?.queued)} · 失败{' '}
            {formatNumber(statusData?.capture?.failed)} · 丢弃 {formatNumber(statusData?.capture?.dropped)}
          </KV>
          <KV label="最近捕获">{formatTime(statusData?.capture?.lastCaptureAt)}</KV>
          <KV label="派生任务">
            待处理 {formatNumber(statusData?.derive?.pendingJobs)} · 最近派生{' '}
            {formatRelative(statusData?.derive?.lastDeriveAt, now)}
          </KV>
          <KV label="派生游标" mono>
            {statusData?.derive?.cursors && Object.keys(statusData.derive.cursors).length > 0
              ? Object.entries(statusData.derive.cursors)
                  .map(([layer, cursor]) => `${layer}:${cursor}`)
                  .join('  ')
              : '—'}
          </KV>
        </div>
      </div>
    </div>
  );
}







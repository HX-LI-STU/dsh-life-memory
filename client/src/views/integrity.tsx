// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hanxustu (dsh-life-memory)
/**
 * 健康/完整性 Integrity（只读）：
 * - 最近 integrity_runs（kind/时间/checked/ok）
 * - repair_log 最近条目（action/target/时间）
 * - manifest 摘要（段数/统计/最近分段）+ 最近整库 verify 结果
 * 说明：本面板不提供任何修复/重建/校验触发按钮（只读；运维走 CLI/工具）。
 */
import { api, useApi } from '../api.ts';
import { Badge, ErrorNotice, EmptyState, HealthBadge, KV, LoadingNotice, SectionTitle, Td, Th } from '../components.tsx';
import { styles, token } from '../theme.tsx';
import { formatBytes, formatNumber, formatTime } from '../util.ts';

export function IntegrityView(): JSX.Element {
  const health = useApi(() => api.health(), []);
  const integrity = useApi(() => api.integrity(), []);
  const manifest = useApi(() => api.manifest(), []);

  const refreshAll = (): void => {
    health.reload();
    integrity.reload();
    manifest.reload();
  };

  const runs = integrity.data?.runs ?? [];
  const repairs = integrity.data?.repairs ?? [];
  const lastVerify = health.data?.lastVerify;
  const segments = manifest.data?.segments ?? [];
  const recentSegments = [...segments].sort((a, b) => ((a.day ?? '') < (b.day ?? '') ? 1 : -1)).slice(0, 12);

  return (
    <div>
      <div style={{ ...styles.row, gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
        <HealthBadge ok={health.data?.ok} readonly={health.data?.readonly} />
        {lastVerify ? (
          <Badge tone={lastVerify.ok === false ? 'error' : 'success'}>
            最近整库校验 {lastVerify.ok === false ? '失败' : '通过'}
            {typeof lastVerify.checked === 'number' ? ` · 检查 ${formatNumber(lastVerify.checked)} 条` : ''}
          </Badge>
        ) : (
          <Badge tone="neutral">尚无整库校验记录</Badge>
        )}
        <span style={{ ...styles.statHint, marginLeft: 'auto' }}>只读视图：修复/重建动作由 CLI 或工具执行</span>
        <button type="button" style={styles.button} onClick={refreshAll}>
          刷新
        </button>
      </div>

      {health.error ? <ErrorNotice error={health.error} onRetry={health.reload} /> : null}

      <SectionTitle first>最近完整性巡检（integrity_runs）</SectionTitle>
      {integrity.error ? <ErrorNotice error={integrity.error} onRetry={integrity.reload} /> : null}
      {integrity.phase === 'loading' && runs.length === 0 ? <LoadingNotice /> : null}
      {integrity.phase === 'ready' && runs.length === 0 ? (
        <EmptyState title="暂无巡检记录" hint="宿主会在启动/定时/手动校验时写入 integrity_runs。" />
      ) : null}
      {runs.length > 0 ? (
        <div style={{ ...styles.card, padding: 4, overflowX: 'auto' }}>
          <table style={styles.table}>
            <thead>
              <tr>
                <Th>#</Th>
                <Th>kind</Th>
                <Th>开始</Th>
                <Th>结束</Th>
                <Th style={{ textAlign: 'right' }}>记录数</Th>
                <Th style={{ textAlign: 'right' }}>分段数</Th>
                <Th>结果</Th>
              </tr>
            </thead>
            <tbody>
              {runs.map((run, index) => (
                <tr key={`${run.id ?? index}`}>
                  <Td mono>{run.id ?? index + 1}</Td>
                  <Td>{run.kind ?? '—'}</Td>
                  <Td>{formatTime(run.startedAt)}</Td>
                  <Td>{run.finishedAt ? formatTime(run.finishedAt) : '进行中/未完成'}</Td>
                  <Td mono style={{ textAlign: 'right' }}>{formatNumber(run.recordsChecked)}</Td>
                  <Td mono style={{ textAlign: 'right' }}>{formatNumber(run.segmentsChecked)}</Td>
                  <Td>
                    <Badge tone={run.ok === true ? 'success' : run.ok === false ? 'error' : 'neutral'}>
                      {run.ok === true ? '通过' : run.ok === false ? '失败' : '未知'}
                    </Badge>
                  </Td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      {lastVerify?.error ? (
        <div style={{ ...styles.error, marginTop: 10 }}>
          <strong>首个校验错误</strong> · {lastVerify.error.id ?? '?'} (seq {lastVerify.error.seq ?? '?'}) ·{' '}
          {lastVerify.error.reason ?? '未知原因'}
        </div>
      ) : null}

      <SectionTitle>修复日志（repair_log，只读展示）</SectionTitle>
      {repairs.length === 0 ? (
        <EmptyState title="暂无修复记录" hint="未发生过需要修复的巡检问题。" />
      ) : (
        <div style={{ ...styles.card, padding: 4, overflowX: 'auto' }}>
          <table style={styles.table}>
            <thead>
              <tr>
                <Th>#</Th>
                <Th>时间</Th>
                <Th>动作</Th>
                <Th>目标</Th>
              </tr>
            </thead>
            <tbody>
              {repairs.map((repair, index) => (
                <tr key={`${repair.id ?? index}`}>
                  <Td mono>{repair.id ?? index + 1}</Td>
                  <Td>{formatTime(repair.ts)}</Td>
                  <Td>{repair.action ?? '—'}</Td>
                  <Td mono>{repair.target ?? '—'}</Td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <SectionTitle>Manifest 摘要</SectionTitle>
      {manifest.error ? <ErrorNotice error={manifest.error} onRetry={manifest.reload} /> : null}
      {manifest.phase === 'loading' && manifest.data === null ? <LoadingNotice /> : null}
      {manifest.data ? (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: 12 }}>
          <div style={styles.card}>
            <KV label="formatVersion">{manifest.data.formatVersion ?? '—'}</KV>
            <KV label="vaultId" mono>
              {manifest.data.vaultId ?? '—'}
            </KV>
            <KV label="updatedAt">{formatTime(manifest.data.updatedAt)}</KV>
            <KV label="统计">
              记录 {formatNumber(manifest.data.stats?.records)} · 天数 {formatNumber(manifest.data.stats?.days)} · 字节{' '}
              {formatBytes(manifest.data.stats?.bytes)}
            </KV>
            <KV label="分段数">{formatNumber(segments.length)}</KV>
          </div>
          <div style={styles.card}>
            <div style={{ ...styles.statLabel, marginBottom: 6 }}>最近分段（按日期倒序，最多 12）</div>
            {recentSegments.length === 0 ? (
              <div style={styles.muted}>暂无分段</div>
            ) : (
              <div style={{ maxHeight: 240, overflow: 'auto' }}>
                <table style={styles.table}>
                  <thead>
                    <tr>
                      <Th>day</Th>
                      <Th>segment</Th>
                      <Th style={{ textAlign: 'right' }}>记录</Th>
                      <Th>状态</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {recentSegments.map((segment, index) => (
                      <tr key={`${segment.segment ?? index}`}>
                        <Td mono>{segment.day ?? '—'}</Td>
                        <Td mono style={{ color: token.textSecondary }}>
                          {segment.segment ?? '—'}
                        </Td>
                        <Td mono style={{ textAlign: 'right' }}>{formatNumber(segment.records)}</Td>
                        <Td>
                          <Badge tone={segment.sealed ? 'neutral' : 'info'}>{segment.sealed ? '已封存' : '写入中'}</Badge>
                        </Td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      ) : null}

      <div style={{ ...styles.statHint, marginTop: 14, lineHeight: 1.7 }}>
        只读说明：本页面仅调用 GET 接口展示巡检/修复/manifest 数据；不会触发 verify、fsck、rebuild 或任何写操作。
        链校验产物由宿主后台任务与 <code>memory_status</code> 工具写入。
      </div>
    </div>
  );
}

// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hanxustu (dsh-life-memory)
/**
 * 导入导出 + 原始数据库重构（v6）。
 *
 * - **默认范围 = 整库（记忆库）**；单会话为可选项；
 * - **内容**：全部（默认）/ 仅数据库（vault.db）/ 仅原始记忆数据（L0 segments，
 *   导入时自动重建 raw_index）；
 * - **导入路径自动列出**：从 `<dataDir>/exports/` 扫描已有归档（无需手填路径）；
 * - **新库 id 自动建议**：选择归档后自动填入合法且不冲突的 id，可修改；
 * - 导出只读；导入只追加（新 sessionId / 新库 id，绝不删改已有记忆）。
 */
import { useState } from 'react';
import { api, useApi } from '../api.ts';
import { JsonBlock, KV, SectionTitle } from '../components.tsx';
import { styles, token } from '../theme.tsx';
import { formatBytes } from '../util.ts';

type Action = 'export-session' | 'import-session' | 'export-vault' | 'import-vault' | 'rebuild';
type ScopeMode = 'vault' | 'session';
type ContentMode = 'all' | 'db' | 'raw';

interface ResultView {
  label: string;
  data: unknown;
}

interface VaultArchive {
  kind: 'vault';
  name: string;
  path: string;
  bytes: number;
  mtime: number;
  include?: 'all' | 'db' | 'raw';
  suggestedVaultId?: string;
}

interface SessionArchive {
  kind: 'session';
  name: string;
  path: string;
  bytes: number;
  mtime: number;
}

const blockStyle = {
  ...styles.card,
  display: 'flex',
  flexDirection: 'column' as const,
  gap: 10,
};

const warnBoxStyle = {
  ...styles.muted,
  border: '1px solid rgba(245, 158, 11, 0.45)',
  background: 'rgba(245, 158, 11, 0.08)',
  color: '#ffd166',
  borderRadius: 8,
  padding: '10px 12px',
  lineHeight: 1.7,
};

const SESSION_ID_HINT =
  '会话 sessionId 可在「会话内 → 记忆库」页签顶部查看（形如 session-xxxxxxxx-…，可点「复制」），也可以让 Agent 调用 memory_status 查看当前 session.sessionId。';

const INCLUDE_LABEL: Record<'all' | 'db' | 'raw', string> = {
  all: '全部（数据库+原始记忆）',
  db: '仅数据库',
  raw: '仅原始记忆数据',
};

function archiveOptionLabel(archive: VaultArchive | SessionArchive): string {
  const when = new Date(archive.mtime || Date.now()).toLocaleString();
  return `${archive.name} · ${formatBytes(archive.bytes)} · ${when}`;
}

export function TransferView(): JSX.Element {
  const vaults = useApi(() => api.vaults(), []);
  const archives = useApi(() => api.transfer({ action: 'list-archives' }) as Promise<unknown>, []);
  const vaultList = vaults.data?.vaults ?? [];
  const activeVaultId = vaults.data?.activeVaultId ?? 'shared';
  const archiveData = (archives.data ?? {}) as { sessions?: SessionArchive[]; vaults?: VaultArchive[] };
  const sessionArchives = Array.isArray(archiveData.sessions) ? archiveData.sessions : [];
  const vaultArchives = Array.isArray(archiveData.vaults) ? archiveData.vaults : [];

  /** 默认整库；单会话为可选项 */
  const [mode, setMode] = useState<ScopeMode>('vault');
  /** 整库模式下的内容：全部 / 仅数据库 / 仅原始记忆数据 */
  const [content, setContent] = useState<ContentMode>('all');
  const [sessionId, setSessionId] = useState('');
  const [includeMemories, setIncludeMemories] = useState(true);
  const [exportVaultId, setExportVaultId] = useState(activeVaultId);
  const [sessionFile, setSessionFile] = useState('');
  const [newSessionId, setNewSessionId] = useState('');
  const [derive, setDerive] = useState(true);
  const [vaultArchivePath, setVaultArchivePath] = useState('');
  const [targetVaultId, setTargetVaultId] = useState('');
  const [busy, setBusy] = useState<Action | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ResultView | null>(null);

  const exportAction: Action = content === 'db' ? 'export-db' : content === 'raw' ? 'export-raw' : 'export-vault';
  const importAction: Action = content === 'db' ? 'import-db' : content === 'raw' ? 'import-raw' : 'import-vault';
  const contentLabel =
    content === 'db' ? '仅数据库（vault.db）' : content === 'raw' ? '仅原始记忆数据（L0 segments）' : '全部（数据库 + 原始记忆，默认）';
  const selectedVaultArchive = vaultArchives.find((archive) => archive.path === vaultArchivePath) ?? null;
  const selectedSessionArchive = sessionArchives.find((archive) => archive.path === sessionFile) ?? null;

  const disabled = busy !== null;

  const run = async (label: string, action: Action, task: () => Promise<unknown>): Promise<void> => {
    setBusy(action);
    setError(null);
    try {
      const data = await task();
      setResult({ label, data });
      if (action === 'import-vault' || action === 'import-db' || action === 'import-raw' || action === 'import-session') {
        vaults.reload();
      }
      if (action !== 'rebuild') archives.reload();
    } catch (err) {
      setResult(null);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const pickVaultArchive = (pathValue: string): void => {
    setVaultArchivePath(pathValue);
    const picked = vaultArchives.find((archive) => archive.path === pathValue) ?? null;
    if (picked?.suggestedVaultId) setTargetVaultId(picked.suggestedVaultId);
    if (picked?.include) setContent(picked.include);
  };

  const refreshArchives = (): void => {
    archives.reload();
  };

  return (
    <div>
      <div style={{ ...warnBoxStyle, marginTop: 4 }}>
        <strong>默认范围：整库（记忆库）</strong>；单会话为可选项。 导入路径与目标库 id 会<strong>自动列出/自动生成</strong>，
        无需手填。 <strong>导入 = 只追加</strong>：以新会话 id / 新库 id 追加，<strong>不会删除、覆盖或修改任何已有记忆</strong>。
      </div>

      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 12, flexWrap: 'wrap' }}>
        <span style={styles.statHint}>范围：</span>
        <button type="button" style={mode === 'vault' ? { ...styles.buttonPrimary } : { ...styles.button }} onClick={() => setMode('vault')} disabled={disabled}>
          整库（默认）
        </button>
        <button type="button" style={mode === 'session' ? { ...styles.buttonPrimary } : { ...styles.button }} onClick={() => setMode('session')} disabled={disabled}>
          单会话（可选）
        </button>
        {mode === 'session' ? <span style={{ ...styles.statHint, color: token.textTertiary }}>{SESSION_ID_HINT}</span> : null}
      </div>

      {mode === 'vault' ? (
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 8, flexWrap: 'wrap' }}>
          <span style={styles.statHint}>内容：</span>
          <button type="button" style={content === 'all' ? { ...styles.buttonPrimary } : { ...styles.button }} onClick={() => setContent('all')} disabled={disabled}>
            全部（默认）
          </button>
          <button type="button" style={content === 'db' ? { ...styles.buttonPrimary } : { ...styles.button }} onClick={() => setContent('db')} disabled={disabled}>
            仅数据库
          </button>
          <button type="button" style={content === 'raw' ? { ...styles.buttonPrimary } : { ...styles.button }} onClick={() => setContent('raw')} disabled={disabled}>
            仅原始记忆数据
          </button>
        </div>
      ) : (
        <div style={{ ...styles.statHint, marginTop: 8, color: token.textTertiary }}>
          单会话范围只涉及原始记忆（L0 + 该会话派生记忆行）；数据库是整库级对象，请切回「整库」范围操作。
        </div>
      )}

      <SectionTitle first>{mode === 'vault' ? '导出整库（只读，默认）' : '导出会话（只读，可选）'}</SectionTitle>
      <div style={blockStyle}>
        {mode === 'vault' ? (
          <KV label={`导出${contentLabel}`} mono={false}>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginTop: 6 }}>
              <select style={{ ...styles.select, minWidth: 220 }} value={exportVaultId} onChange={(event) => setExportVaultId(event.target.value)} disabled={disabled}>
                {vaultList.length === 0 ? <option value={activeVaultId}>{activeVaultId}</option> : null}
                {vaultList.map((vault) => (
                  <option key={vault.id} value={vault.id}>
                    {vault.name}（{vault.id}）
                  </option>
                ))}
              </select>
              <button type="button" style={styles.buttonPrimary} disabled={disabled} onClick={() => void run(`导出${contentLabel}`, exportAction, () => api.transfer({ action: exportAction, vault: exportVaultId }))}>
                {busy === exportAction ? '导出中…' : content === 'db' ? '导出数据库' : content === 'raw' ? '导出原始记忆' : '导出整库'}
              </button>
              <span style={styles.muted}>输出到 exports/vaults/（导出后会自动出现在下方导入列表）</span>
            </div>
          </KV>
        ) : (
          <KV label="导出单个会话的原始记忆（JSONL 归档）" mono={false}>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginTop: 6 }}>
              <input style={{ ...styles.input, minWidth: 280 }} placeholder="sessionId（留空 = 当前会话）" value={sessionId} onChange={(event) => setSessionId(event.target.value)} disabled={disabled} />
              <label style={{ ...styles.muted, display: 'flex', gap: 6, alignItems: 'center' }}>
                <input type="checkbox" checked={includeMemories} onChange={(event) => setIncludeMemories(event.target.checked)} disabled={disabled} />
                附带该会话派生记忆
              </label>
              <button
                type="button"
                style={styles.button}
                disabled={disabled}
                onClick={() =>
                  void run('导出会话归档', 'export-session', () =>
                    api.transfer({ action: 'export-session', ...(sessionId.trim().length > 0 ? { sessionId: sessionId.trim() } : {}), includeMemories }),
                  )
                }
              >
                {busy === 'export-session' ? '导出中…' : '导出会话（可选）'}
              </button>
            </div>
            <div style={{ ...styles.statHint, marginTop: 8, color: token.textTertiary }}>{SESSION_ID_HINT}</div>
          </KV>
        )}
      </div>

      <SectionTitle>{mode === 'vault' ? '导入整库（只追加，默认）' : '导入会话（只追加，可选）'}</SectionTitle>
      <div style={blockStyle}>
        {mode === 'vault' ? (
          <KV label="选择要导入的整库归档（自动列出 exports/vaults/）→ 新库 id 自动生成" mono={false}>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginTop: 6 }}>
              <select
                style={{ ...styles.select, minWidth: 360, maxWidth: '100%' }}
                value={vaultArchivePath}
                onChange={(event) => pickVaultArchive(event.target.value)}
                disabled={disabled}
              >
                <option value="">— 选择整库归档（{vaultArchives.length} 个可用）—</option>
                {vaultArchives.map((archive) => (
                  <option key={archive.path} value={archive.path}>
                    {archiveOptionLabel(archive)}
                    {archive.include ? ` · ${INCLUDE_LABEL[archive.include]}` : ''}
                  </option>
                ))}
              </select>
              <button type="button" style={styles.button} onClick={refreshArchives} disabled={disabled}>
                刷新列表
              </button>
            </div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginTop: 8 }}>
              <input
                style={{ ...styles.input, minWidth: 240 }}
                placeholder="目标新库 id（自动生成，可修改）"
                value={targetVaultId}
                onChange={(event) => setTargetVaultId(event.target.value)}
                disabled={disabled}
              />
              <button
                type="button"
                style={styles.button}
                disabled={disabled}
                onClick={() => setTargetVaultId(selectedVaultArchive?.suggestedVaultId ?? `import-${Date.now().toString(36)}`)}
              >
                重新自动生成 id
              </button>
              <button
                type="button"
                style={styles.buttonPrimary}
                disabled={disabled || vaultArchivePath.length === 0 || targetVaultId.trim().length === 0}
                onClick={() =>
                  void run(`导入${contentLabel}`, importAction, () =>
                    api.transfer({ action: importAction, path: vaultArchivePath, targetVault: targetVaultId.trim() }),
                  )
                }
              >
                {busy === importAction ? '导入中…' : content === 'db' ? '导入数据库' : content === 'raw' ? '导入原始记忆' : '导入整库'}
              </button>
            </div>
            {selectedVaultArchive?.suggestedVaultId ? (
              <div style={{ ...styles.statHint, marginTop: 8, color: token.textTertiary }}>
                已自动生成目标库 id：<code>{targetVaultId || selectedVaultArchive.suggestedVaultId}</code>（不冲突、合法；可修改）
              </div>
            ) : (
              <div style={{ ...styles.statHint, marginTop: 8, color: token.textTertiary }}>
                {vaultArchives.length === 0 ? '暂无整库归档：先在导出区导出一次，或把归档目录放到 exports/vaults/ 后点「刷新列表」。' : '选择一个归档后会自动填入目标库 id。'}
              </div>
            )}
          </KV>
        ) : (
          <KV label="选择要导入的会话归档（自动列出 exports/sessions/）→ 新 sessionId 自动生成" mono={false}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 6 }}>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                <select style={{ ...styles.select, minWidth: 360, maxWidth: '100%' }} value={sessionFile} onChange={(event) => setSessionFile(event.target.value)} disabled={disabled}>
                  <option value="">— 选择会话归档（{sessionArchives.length} 个可用）—</option>
                  {sessionArchives.map((archive) => (
                    <option key={archive.path} value={archive.path}>
                      {archiveOptionLabel(archive)}
                    </option>
                  ))}
                </select>
                <button type="button" style={styles.button} onClick={refreshArchives} disabled={disabled}>
                  刷新列表
                </button>
              </div>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                <input style={{ ...styles.input, minWidth: 240 }} placeholder="新 sessionId（留空自动 import-<时间戳>）" value={newSessionId} onChange={(event) => setNewSessionId(event.target.value)} disabled={disabled} />
                <label style={{ ...styles.muted, display: 'flex', gap: 6, alignItems: 'center' }}>
                  <input type="checkbox" checked={derive} onChange={(event) => setDerive(event.target.checked)} disabled={disabled} />
                  导入后立即派生
                </label>
                <button
                  type="button"
                  style={styles.button}
                  disabled={disabled || sessionFile.length === 0}
                  onClick={() =>
                    void run('导入会话归档', 'import-session', () =>
                      api.transfer({ action: 'import-session', path: sessionFile, derive, ...(newSessionId.trim().length > 0 ? { newSessionId: newSessionId.trim() } : {}) }),
                    )
                  }
                >
                  {busy === 'import-session' ? '导入中…' : '导入会话（可选）'}
                </button>
              </div>
              <div style={{ ...styles.statHint, color: token.textTertiary }}>
                新 sessionId 留空会自动生成；{sessionArchives.length === 0 ? '暂无会话归档，先在导出区导出一次。' : `已选择：${selectedSessionArchive?.name ?? '（未选择）'}`}
              </div>
            </div>
          </KV>
        )}
      </div>

      <SectionTitle>维护</SectionTitle>
      <div style={blockStyle}>
        <KV label="重构原始数据库（从 L0 重建 raw_index，只增不删）" mono={false}>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginTop: 6 }}>
            <select style={{ ...styles.select, minWidth: 200 }} value={exportVaultId} onChange={(event) => setExportVaultId(event.target.value)} disabled={disabled}>
              {vaultList.length === 0 ? <option value={activeVaultId}>{activeVaultId}</option> : null}
              {vaultList.map((vault) => (
                <option key={vault.id} value={vault.id}>
                  {vault.name}（{vault.id}）
                </option>
              ))}
            </select>
            <button
              type="button"
              style={styles.button}
              disabled={disabled}
              onClick={() => {
                if (typeof window !== 'undefined' && !window.confirm('将扫描 L0 原始归档并补齐 raw_index（只增不删），继续？')) return;
                void run('重构原始数据库', 'rebuild', () => api.rebuildRaw(exportVaultId !== 'shared' ? { vault: exportVaultId } : {}));
              }}
            >
              {busy === 'rebuild' ? '重构中…' : '重构原始数据库'}
            </button>
            <span style={styles.muted}>导入完成后建议执行一次（对账/补齐索引，不删除、不改写 L0）。注意：导入「仅原始记忆数据」时会自动从 L0 重建 raw_index。</span>
          </div>
        </KV>
      </div>

      {error !== null ? (
        <div style={{ ...styles.error, marginTop: 12 }} role="alert">
          操作失败：{error}
        </div>
      ) : null}

      {result !== null ? (
        <>
          <SectionTitle>最近一次结果 · {result.label}</SectionTitle>
          <JsonBlock value={result.data} label={result.label} defaultOpen />
        </>
      ) : null}

      <div style={{ ...styles.muted, marginTop: 14, color: token.textTertiary }}>
        导出文件位于插件数据目录 <code>exports/</code> 下；删除数据只能人工操作（见「概览 → 数据保留与删除」）。愿记忆长存。
      </div>
    </div>
  );
}

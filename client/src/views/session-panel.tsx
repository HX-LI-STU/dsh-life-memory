// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hanxustu (dsh-life-memory)
/**
 * 会话内「记忆库」面板（v5，session 作用域 view tab）：
 *
 * 通过 `conversation.view` slot 注册（session 作用域，标准席位带 `sessionId`，见 docs/11）。
 * 内容：
 * - 本会话使用记忆 开关（写入 POST /session-config）
 * - 本会话使用人格 开关 + 人格下拉（仅当开启"使用人格"时可选）
 * - 当前使用的记忆库名称（来自 session-config.vault；缺省回退 /vaults.activeVaultId）
 * - 保存状态（保存中/已保存/失败；Host 未就绪时提示而不崩溃）
 *
 * 只做会话级配置的读写；人格 CRUD/全局激活在「人格」页签。
 */
import { useEffect, useMemo, useState } from 'react';
import { api, isHostWritePending, useApi } from '../api.ts';
import { Badge, CopyButton, EmptyState, ErrorNotice, LoadingNotice, SectionTitle } from '../components.tsx';
import { styles, token } from '../theme.tsx';
import type { SessionConfig } from '../types.ts';

export interface SessionMemoryPanelProps {
  /** session 作用域标准席位；缺失时说明需在会话内使用 */
  sessionId?: string;
  [key: string]: unknown;
}

function Toggle(props: { checked: boolean; disabled?: boolean; label: string; hint?: string; onChange: (next: boolean) => void }): JSX.Element {
  return (
    <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: props.disabled ? 'default' : 'pointer', padding: '6px 0' }}>
      <button
        type="button"
        role="switch"
        aria-checked={props.checked}
        disabled={props.disabled}
        onClick={() => props.onChange(!props.checked)}
        style={{
          width: 38,
          height: 20,
          borderRadius: 999,
          border: `1px solid ${props.checked ? token.brand : token.borderL3}`,
          background: props.checked ? token.brand : token.bgLayer3,
          position: 'relative',
          cursor: props.disabled ? 'default' : 'pointer',
          padding: 0,
          flex: '0 0 auto',
        }}
      >
        <span
          style={{
            position: 'absolute',
            top: 1,
            left: props.checked ? 19 : 1,
            width: 16,
            height: 16,
            borderRadius: '50%',
            background: token.bgBase,
            transition: 'left 120ms ease',
          }}
        />
      </button>
      <span style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        <span style={{ fontSize: 13 }}>{props.label}</span>
        {props.hint ? <span style={styles.statHint}>{props.hint}</span> : null}
      </span>
    </label>
  );
}

export function SessionMemoryPanel(props: SessionMemoryPanelProps): JSX.Element {
  const sessionId = typeof props.sessionId === 'string' && props.sessionId.length > 0 ? props.sessionId : '';
  const config = useApi<SessionConfig>(
    () => (sessionId ? api.sessionConfig(sessionId) : Promise.resolve({ sessionId: '', memory: true, persona: false, isDefault: true })),
    [sessionId],
  );
  const personas = useApi(() => api.personas(), []);
  const vaults = useApi(() => api.vaults(), []);

  const [memory, setMemory] = useState<boolean>(true);
  const [personaEnabled, setPersonaEnabled] = useState<boolean>(false);
  const [personaId, setPersonaId] = useState<string>('');
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hostPending, setHostPending] = useState<boolean>(false);

  // 载入/刷新配置时同步本地开关
  useEffect(() => {
    const data = config.data;
    if (!data) return;
    setMemory(data.memory !== false);
    setPersonaEnabled(data.persona === true);
    setPersonaId(data.personaId ?? '');
  }, [config.data]);

  const definitions = personas.data?.definitions ?? [];
  const validPersonas = definitions.filter((definition) => definition.valid !== false);
  const activeVault = useMemo(() => {
    const ref = config.data?.vault;
    if (ref?.name || ref?.id) return { id: ref.id, name: ref.name ?? ref.id };
    const list = vaults.data?.vaults ?? [];
    const activeId = vaults.data?.activeVaultId;
    const found = list.find((vault) => vault.id === activeId);
    return found ? { id: found.id, name: found.name ?? found.id } : { id: activeId ?? '', name: activeId ?? '' };
  }, [config.data?.vault, vaults.data]);

  const save = async (patch: { memory?: boolean; persona?: boolean; personaId?: string | null }): Promise<void> => {
    if (!sessionId) return;
    setSaving(true);
    setError(null);
    try {
      const nextPersona = patch.persona ?? personaEnabled;
      const updated = await api.saveSessionConfig({
        sessionId,
        // 人格开启 ⇒ 记忆强制开启（Host 侧同样强制）
        memory: nextPersona ? true : (patch.memory ?? memory),
        persona: nextPersona,
        personaId: patch.personaId !== undefined ? patch.personaId : personaId || null,
      });
      // 用服务端返回值回填（Host 是权威）
      setMemory(updated.memory !== false);
      setPersonaEnabled(updated.persona === true);
      setPersonaId(updated.personaId ?? '');
      setSavedAt(Date.now());
      setHostPending(false);
    } catch (caught) {
      if (isHostWritePending(caught)) {
        setHostPending(true);
        setError('Host 会话配置接口尚未就绪（等待联调）：开关未保存。');
      } else {
        setError(caught instanceof Error ? caught.message : String(caught));
      }
    } finally {
      setSaving(false);
    }
  };

  if (!sessionId) {
    return (
      <div style={{ padding: '16px 20px' }}>
        <SectionTitle first>记忆库（本会话）</SectionTitle>
        <EmptyState
          title="未取得会话 id"
          hint="请从会话页签打开本视图（session 作用域会自动注入 sessionId）。"
        />
      </div>
    );
  }

  return (
    <div style={{ padding: '14px 20px', height: '100%', overflow: 'auto', boxSizing: 'border-box' }}>
      <div style={{ ...styles.row, gap: 8, flexWrap: 'wrap', marginBottom: 10 }}>
        <Badge tone="brand">记忆库 · 本会话</Badge>
        <span style={{ ...styles.mono, color: token.textTertiary }}>session {sessionId}</span>`n        <CopyButton text={sessionId} label="复制" title="复制完整 sessionId（用于单会话导出/导入）" />
        <button type="button" style={{ ...styles.button, marginLeft: 'auto' }} onClick={() => config.reload()} disabled={saving}>
          刷新
        </button>
      </div>

      {config.error ? <ErrorNotice error={config.error} onRetry={() => config.reload()} /> : null}
      {config.phase === 'loading' && config.data === null ? <LoadingNotice label="读取会话配置…" /> : null}
      {error ? (
        <div style={{ ...styles.error, marginBottom: 10 }} role="alert">
          {error}
          {hostPending ? '（可先保持只读；联调后重试）' : ''}
        </div>
      ) : null}
      {savedAt ? <div style={{ ...styles.statHint, color: token.success, marginBottom: 8 }}>✓ 已保存（{new Date(savedAt).toLocaleTimeString()}）</div> : null}

      <div style={styles.card}>
        <SectionTitle first extra={saving ? <Badge tone="neutral">保存中…</Badge> : null}>
          本会话设置
        </SectionTitle>
        <Toggle
          checked={memory}
          disabled={saving || config.phase === 'loading' || personaEnabled}
          label="本会话使用记忆"
          hint={
            personaEnabled
              ? '人格开启时记忆强制开启（关闭「使用人格」后可单独关闭记忆）。'
              : '关闭后本会话不再捕获/召回记忆（仍可只读浏览档案）。'
          }
          onChange={(next) => {
            setMemory(next);
            void save({ memory: next });
          }}
        />
        <Toggle
          checked={personaEnabled}
          disabled={saving || config.phase === 'loading'}
          label="本会话使用人格"
          hint="开启后按人格隔离记忆与注入身份块（记忆同时强制开启）；关闭则使用共享记忆库。"
          onChange={(next) => {
            if (next) setMemory(true);
            setPersonaEnabled(next);
            void save({ persona: next, memory: next ? true : memory, personaId: next ? personaId || null : null });
          }}
        />
        <div style={{ marginTop: 6, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <span style={styles.statHint}>人格：</span>
          <select
            style={styles.select}
            value={personaId}
            disabled={!personaEnabled || saving || validPersonas.length === 0}
            onChange={(event) => {
              const next = event.target.value;
              setPersonaId(next);
              void save({ persona: true, personaId: next || null });
            }}
            title={personaEnabled ? '指定本会话使用的人格' : '先开启「本会话使用人格」'}
          >
            <option value="">跟随全局激活人格{definitions.find((definition) => definition.id === (personas.data?.activeId ?? ''))?.name ? `（${definitions.find((definition) => definition.id === (personas.data?.activeId ?? ''))?.name}）` : ''}</option>
            {validPersonas.map((definition) => (
              <option key={definition.id} value={definition.id}>
                {definition.name ? `${definition.name} (${definition.id})` : definition.id}
              </option>
            ))}
          </select>
        </div>
        <div style={{ ...styles.statHint, marginTop: 10 }}>
          当前使用的记忆库：<strong>{activeVault.name || activeVault.id || '（未知）'}</strong>
          {activeVault.id ? `（${activeVault.id}）` : ''}
        </div>
        {config.data?.isDefault ? (
          <div style={{ ...styles.statHint, marginTop: 4 }}>本会话尚未保存过配置，当前显示默认值（memory=true / persona=false）。</div>
        ) : null}
      </div>

      <div style={{ ...styles.statHint, marginTop: 12, lineHeight: 1.7 }}>
        会话级开关只影响本会话：关闭记忆后不捕获/召回，但不会影响已归档的 L0/三层记忆；人格开关决定使用共享库还是独立人格库。
        全局人格切换请到「人格」页签（切换即切换记忆库）。
      </div>
    </div>
  );
}

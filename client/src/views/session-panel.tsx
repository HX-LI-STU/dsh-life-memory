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
import type { SessionConfig, SessionDefaults } from '../types.ts';

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
  // 仅用于探测 Host 是否已加载 v1.1.8 的补档协议（旧 Host 无该字段）
  const defaults = useApi<SessionDefaults>(() => api.sessionDefaults(), []);

  const [memory, setMemory] = useState<boolean>(true);
  const [personaEnabled, setPersonaEnabled] = useState<boolean>(false);
  const [personaId, setPersonaId] = useState<string>('');
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hostPending, setHostPending] = useState<boolean>(false);
  // v1.1.8：开启记忆/人格时弹窗确认是否补档历史（默认每次询问，不设持久开关）
  const [pendingEnable, setPendingEnable] = useState<{ persona: boolean } | null>(null);
  const [backfillChoice, setBackfillChoice] = useState<boolean>(false);
  // v1.2.0：默认只记最终输入/回复；打开才记录思考/工具/事件
  const [fullCapture, setFullCapture] = useState<boolean>(false);

  // 载入/刷新配置时同步本地开关
  useEffect(() => {
    const data = config.data;
    if (!data) return;
    setMemory(data.memory !== false);
    setPersonaEnabled(data.persona === true);
    setPersonaId(data.personaId ?? '');
    setFullCapture(data.fullCapture === true);
  }, [config.data]);

  // 旧 Host 未加载 v1.1.8 协议时，弹窗里的补档选择无法生效
  const hostSupportsBackfill = defaults.data ? defaults.data.backfillOnEnable !== undefined : true;

  const definitions = personas.data?.definitions ?? [];
  const validPersonas = definitions.filter((definition) => definition.valid !== false);
  const globalActivePersona = definitions.find((definition) => definition.id === (personas.data?.activeId ?? '')) ?? null;
  // 实际生效的库由「本会话使用人格」开关决定：关闭时必然是共享库（全局激活人格不改变本会话路由）
  const activeVault = useMemo(() => {
    if (!personaEnabled) return { id: 'shared', name: '共享记忆库' };
    const ref = config.data?.vault;
    if (ref?.name || ref?.id) return { id: ref.id, name: ref.name ?? ref.id };
    const list = vaults.data?.vaults ?? [];
    const activeId = vaults.data?.activeVaultId;
    const found = list.find((vault) => vault.id === activeId);
    return found ? { id: found.id, name: found.name ?? found.id } : { id: activeId ?? '', name: activeId ?? '' };
  }, [config.data?.vault, vaults.data, personaEnabled]);

  const save = async (patch: {
    memory?: boolean;
    persona?: boolean;
    personaId?: string | null;
    backfill?: boolean;
    fullCapture?: boolean;
  }): Promise<void> => {
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
        fullCapture: patch.fullCapture ?? fullCapture,
        ...(patch.backfill !== undefined ? { backfill: patch.backfill } : {}),
      });
      // 用服务端返回值回填（Host 是权威）
      setMemory(updated.memory !== false);
      setPersonaEnabled(updated.persona === true);
      setPersonaId(updated.personaId ?? '');
      setFullCapture(updated.fullCapture === true);
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

  // v1.1.8：确认开启（带补档选择；默认每次弹窗重新选择）
  const confirmEnable = async (): Promise<void> => {
    const target = pendingEnable;
    if (!target) return;
    setPendingEnable(null);
    const backfill = backfillChoice && hostSupportsBackfill;
    if (target.persona) {
      setMemory(true);
      setPersonaEnabled(true);
      await save({ persona: true, memory: true, personaId: personaId || null, backfill });
    } else {
      setMemory(true);
      await save({ memory: true, backfill });
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
        <span style={{ ...styles.mono, color: token.textTertiary }}>session {sessionId}</span>
        <CopyButton text={sessionId} label="复制" title="复制完整 sessionId（用于单会话导出/导入）" />
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
      {defaults.data && !hostSupportsBackfill ? (
        <div style={{ ...styles.error, marginBottom: 10 }} role="alert">
          当前运行中的 DSH Host 仍是旧版本（尚未加载补档协议）：弹窗里的“补档本会话全部历史”不会生效。
          请完全退出并重新启动 DSH Desktop 后再试。
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
            if (next && !memory) {
              setBackfillChoice(false);
              setPendingEnable({ persona: false });
              return;
            }
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
            if (next && !personaEnabled) {
              setBackfillChoice(false);
              setPendingEnable({ persona: true });
              return;
            }
            setPersonaEnabled(next);
            void save({ persona: next, memory: next ? true : memory, personaId: next ? personaId || null : null });
          }}
        />
        <Toggle
          checked={fullCapture}
          disabled={saving || config.phase === 'loading'}
          label="记录完整原始事件"
          hint="关闭（默认）：只记录你发送的最终输入与助手最终回复；开启：同时记录思考、工具调用、系统事件等（记录量会明显增加）。"
          onChange={(next) => {
            setFullCapture(next);
            void save({ fullCapture: next });
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
        {!personaEnabled && globalActivePersona ? (
          <div style={{ ...styles.statHint, marginTop: 4 }}>
            全局激活人格：<strong>{globalActivePersona.name || globalActivePersona.id}</strong>（开启「本会话使用人格」后，本会话才会使用其独立记忆库；关闭时使用共享库）
          </div>
        ) : null}
        {config.data?.isDefault ? (
          <div style={{ ...styles.statHint, marginTop: 4 }}>本会话尚未保存过配置，当前显示默认值（memory=${config.data?.memory === true ? 'true' : 'false'} / persona=${config.data?.persona === true ? 'true' : 'false'}）。</div>
        ) : null}
      </div>

      <div style={{ ...styles.statHint, marginTop: 12, lineHeight: 1.7 }}>
        会话级开关只影响本会话：关闭记忆后不再捕获新记录、注入或召回；关闭前已写入的 L0 原始记录会保留（不可变归档，不会自动删除）。人格开关决定使用共享库还是独立人格库；
        开启记忆时会在弹窗中选择是否补档本会话已有历史（默认不补档，每次重新选择）。
        全局人格切换请到「人格」页签（切换即切换记忆库）。
      </div>

      {pendingEnable ? (
        <div
          role="dialog"
          aria-modal="true"
          style={{
            position: 'fixed',
            inset: 0,
            zIndex: 2000,
            background: 'rgba(0,0,0,0.45)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: 16,
          }}
        >
          <div style={{ ...styles.card, width: 'min(540px, 94vw)', maxHeight: '86vh', overflow: 'auto' }}>
            <SectionTitle first>{pendingEnable.persona ? '开启人格与记忆' : '开启本会话记忆'}</SectionTitle>
            <div style={{ ...styles.statHint, lineHeight: 1.7 }}>
              开启后本会话会捕获新事件并参与提示词注入。是否同时补档本会话已经发生的全部历史
              （包括你之前发送的消息、回复与工具调用）？
            </div>
            {pendingEnable.persona ? (
              <div style={{ ...styles.statHint, color: token.warn, marginTop: 8, lineHeight: 1.7 }}>
                注意：开启人格后补档会把同一段历史写入人格库，可能与共享库中已有记录重复；不需要时请保持补档关闭。
              </div>
            ) : null}
            <div style={{ marginTop: 12 }}>
              <Toggle
                checked={backfillChoice && hostSupportsBackfill}
                disabled={!hostSupportsBackfill || saving}
                onChange={(next) => {
                  if (hostSupportsBackfill) setBackfillChoice(next);
                }}
                label="补档本会话全部历史"
                hint={
                  !hostSupportsBackfill
                    ? '当前 Host 未加载补档协议，此开关不会生效；请重启 DSH。'
                    : backfillChoice
                      ? '会写入开启前（甚至关闭记忆期间）的会话内容；L0 不可变，写入后不会自动删除。'
                      : '关闭：只从此刻开始捕获，不导入历史。'
                }
              />
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 16 }}>
              <button type="button" style={styles.button} onClick={() => setPendingEnable(null)} disabled={saving}>
                取消
              </button>
              <button type="button" style={{ ...styles.button, ...styles.buttonPrimary }} onClick={() => void confirmEnable()} disabled={saving}>
                {saving ? '保存中…' : '确认开启'}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hanxustu (dsh-life-memory)
/**
 * 新会话默认（v5.1）：「记忆 / 人格」开关 + 人格下拉。
 *
 * 两处复用同一组件：
 * 1) `conversation.hero.options`（新建会话页 hero 设置行，list/session 作用域，紧凑横排）；
 * 2) 记忆库面板「概览」页的「新会话默认」卡片（panel 变体）。
 *
 * 语义：这里改的是**下一个新会话的默认值**，不是当前会话配置：
 * - GET  `/session-config`（**不带 sessionId**）→ `{sessionId:null, defaults:true, memory, persona, personaId, …}`；
 * - POST `/session-config`（**不带 sessionId**）→ body `{defaults:true, memory, persona, personaId}`。
 * 会话内「记忆库」页签仍走带 sessionId 的会话级读写（session-panel.tsx，互不影响）。
 *
 * 健壮性（Hero 页不得崩 / 不得影响 boot）：
 * - 任何 API 失败都只落到本地「保存失败 / Host 未就绪」小字，不抛错、不 setState 到卸载后组件；
 * - 乐观 UI + 300ms debounce，服务端返回后以其为准回填；
 * - 不读 sessionId、不做会话级写（Hero 页本就没有会话语义）。
 */
import { useEffect, useRef, useState } from 'react';
import { api, isHostWritePending, useApi } from '../api.ts';
import { Badge, SectionTitle } from '../components.tsx';
import { styles, token } from '../theme.tsx';
import type { SessionDefaults } from '../types.ts';

/** 保存 debounce（ms）：合并连续点击，避免每个开关各发一次 POST */
const SAVE_DEBOUNCE_MS = 300;

/** default 导出的组件在 hero 行的注册 id（与 conversation.view 一样是自描述 id） */
export const HERO_OPTIONS_ID = 'life-memory-hero';

/** hero 槽位名（DSH client-ui-conversation 声明；feature-detect 注册） */
export const HERO_OPTIONS_SLOT = 'conversation.hero.options';

/** 本地状态（乐观 UI） */
interface DefaultsValues {
  memory: boolean;
  persona: boolean;
  personaId: string;
  fullCapture: boolean;
}

function valuesFrom(data: SessionDefaults | null | undefined): DefaultsValues {
  return {
    memory: readDefaultsMemory(data),
    persona: readDefaultsPersona(data),
    personaId: typeof data?.personaId === 'string' ? data.personaId : '',
    fullCapture: data?.fullCapture === true,
  };
}

/** 记忆默认值：memory 优先，旧/别名 Host 回退 memoryEnabled，再回退 true */
export function readDefaultsMemory(data: SessionDefaults | null | undefined): boolean {
  if (!data) return true;
  if (typeof data.memory === 'boolean') return data.memory;
  if (typeof data.memoryEnabled === 'boolean') return data.memoryEnabled;
  return true;
}

/** 人格默认值：persona 优先，回退 personaEnabled，再回退 false（共享库） */
export function readDefaultsPersona(data: SessionDefaults | null | undefined): boolean {
  if (!data) return false;
  if (typeof data.persona === 'boolean') return data.persona;
  if (typeof data.personaEnabled === 'boolean') return data.personaEnabled;
  return false;
}

function warnSaveFailure(error: unknown): void {
  try {
    console.warn(
      '[dsh-life-memory] 保存新会话默认失败：',
      error instanceof Error ? error.message : String(error),
    );
  } catch {
    /* ignore */
  }
}

/** 紧凑开关（hero 行内用；比会话页签的开关更小） */
function MiniSwitch(props: {
  checked: boolean;
  disabled?: boolean;
  label: string;
  title: string;
  onChange: (next: boolean) => void;
}): JSX.Element {
  return (
    <label
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 5,
        cursor: props.disabled ? 'default' : 'pointer',
        whiteSpace: 'nowrap',
      }}
      title={props.title}
    >
      <button
        type="button"
        role="switch"
        aria-checked={props.checked}
        aria-label={props.title}
        disabled={props.disabled}
        onClick={() => props.onChange(!props.checked)}
        style={{
          width: 30,
          height: 16,
          borderRadius: 999,
          border: `1px solid ${props.checked ? token.brand : token.borderL3}`,
          background: props.checked ? token.brand : token.bgLayer3,
          position: 'relative',
          cursor: props.disabled ? 'default' : 'pointer',
          padding: 0,
          flex: '0 0 auto',
          opacity: props.disabled ? 0.6 : 1,
        }}
      >
        <span
          style={{
            position: 'absolute',
            top: 1,
            left: props.checked ? 16 : 1,
            width: 12,
            height: 12,
            borderRadius: '50%',
            background: token.bgBase,
            transition: 'left 120ms ease',
          }}
        />
      </button>
      <span style={{ fontSize: 12 }}>{props.label}</span>
    </label>
  );
}

export interface NewSessionDefaultsProps {
  /** compact = hero 行内横排；panel = 记忆库面板卡片 */
  variant?: 'compact' | 'panel';
  /** 保存成功回调（可选；服务端返回值） */
  onSaved?: (next: SessionDefaults) => void;
}

/**
 * 新会话默认控件：记忆开关 + 人格开关 + 人格下拉（+ 保存状态）。
 * 不依赖 sessionId；任何错误都收敛成小字状态，不抛错。
 */
export function NewSessionDefaults(props: NewSessionDefaultsProps = {}): JSX.Element {
  const variant = props.variant ?? 'compact';
  const defaults = useApi<SessionDefaults>(() => api.sessionDefaults(), []);
  const personas = useApi(() => api.personas(), []);

  const [memory, setMemory] = useState(true);
  const [personaEnabled, setPersonaEnabled] = useState(false);
  const [personaId, setPersonaId] = useState('');
  const [fullCapture, setFullCapture] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [failure, setFailure] = useState<'failed' | 'host-pending' | null>(null);

  const mounted = useRef(true);
  const timer = useRef<number | null>(null);
  const seq = useRef(0);
  const values = useRef<DefaultsValues>({ memory: true, persona: false, personaId: '', fullCapture: false });
  const synced = useRef<SessionDefaults | null>(null);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (timer.current !== null) {
        try {
          window.clearTimeout(timer.current);
        } catch {
          /* ignore */
        }
        timer.current = null;
      }
    };
  }, []);

  // 首次/刷新拿到 Host 默认值后同步本地（每次响应只同步一次，避免覆盖用户正在改的乐观状态）
  useEffect(() => {
    const data = defaults.data;
    if (!data || synced.current === data) return;
    synced.current = data;
    const next = valuesFrom(data);
    values.current = next;
    setMemory(next.memory);
    setPersonaEnabled(next.persona);
    setPersonaId(next.personaId);
    setFullCapture(next.fullCapture);
  }, [defaults.data]);

  const persist = async (next: DefaultsValues): Promise<void> => {
    const ticket = ++seq.current;
    setSaving(true);
    setFailure(null);
    try {
      const updated = await api.saveSessionDefaults({
        memory: next.persona ? true : next.memory,
        persona: next.persona,
        personaId: next.persona ? next.personaId || null : null,
        fullCapture: next.fullCapture,
      });
      if (!mounted.current || ticket !== seq.current) return;
      const authoritative = valuesFrom(updated);
      values.current = authoritative;
      setMemory(authoritative.memory);
      setPersonaEnabled(authoritative.persona);
      setPersonaId(authoritative.personaId);
      setFullCapture(authoritative.fullCapture);
      setSaving(false);
      setSavedAt(Date.now());
      props.onSaved?.(updated);
    } catch (error) {
      if (!mounted.current || ticket !== seq.current) return;
      setSaving(false);
      setFailure(isHostWritePending(error) ? 'host-pending' : 'failed');
      warnSaveFailure(error);
    }
  };

  const schedule = (next: DefaultsValues): void => {
    values.current = next;
    setSavedAt(null);
    if (timer.current !== null) {
      try {
        window.clearTimeout(timer.current);
      } catch {
        /* ignore */
      }
    }
    timer.current = window.setTimeout(() => {
      timer.current = null;
      void persist(values.current);
    }, SAVE_DEBOUNCE_MS);
  };

  const changeMemory = (next: boolean): void => {
    setMemory(next);
    schedule({ ...values.current, memory: next });
  };

  const changePersona = (next: boolean): void => {
    // 人格开启 ⇒ 记忆强制开启（Host 侧同样强制，这里同步 UI 避免歧义）
    if (next) setMemory(true);
    setPersonaEnabled(next);
    schedule({
      ...values.current,
      memory: next ? true : values.current.memory,
      persona: next,
      personaId: next ? values.current.personaId : '',
    });
  };

  const changePersonaId = (next: string): void => {
    setPersonaId(next);
    schedule({ ...values.current, personaId: next });
  };

  const changeFullCapture = (next: boolean): void => {
    setFullCapture(next);
    schedule({ ...values.current, fullCapture: next });
  };

  const definitions = personas.data?.definitions ?? [];
  const validPersonas = definitions.filter((definition) => definition.valid !== false);
  const activeId = personas.data?.activeId ?? null;
  const activeDefinition = activeId ? definitions.find((definition) => definition.id === activeId) : undefined;
  const activeName = activeDefinition?.name || activeId || '';
  const knownIds = new Set(validPersonas.map((definition) => definition.id));

  const statusText = saving
    ? '保存中…'
    : failure === 'host-pending'
      ? 'Host 未就绪'
      : failure === 'failed'
        ? '保存失败'
        : savedAt !== null
          ? '已保存'
          : '';
  const statusTone =
    failure === null ? (saving ? token.textTertiary : token.success) : failure === 'host-pending' ? token.warn : token.error;

  const controls = (
    <div style={{ display: 'flex', alignItems: 'center', gap: variant === 'compact' ? 10 : 14, flexWrap: 'wrap' }}>
      <MiniSwitch
        checked={memory}
        disabled={saving || personaEnabled}
        label="记忆"
        title={
          personaEnabled
            ? '人格开启时记忆强制开启（关闭人格后可单独关闭记忆）'
            : `新会话默认：${memory ? '开启' : '关闭'}记忆（只影响下一个新会话）`
        }
        onChange={changeMemory}
      />
      <MiniSwitch
        checked={personaEnabled}
        disabled={saving}
        label="人格"
        title={`新会话默认：${personaEnabled ? '使用' : '不使用'}人格（关闭时使用共享库）`}
        onChange={changePersona}
      />
      <MiniSwitch
        checked={fullCapture}
        disabled={saving}
        label="全量原始"
        title="新会话默认：是否记录思考/工具调用/系统事件等完整原始事件；关闭时只记录最终用户输入与最终助手回复（推荐）"
        onChange={changeFullCapture}
      />
      <select
        style={{ ...styles.select, maxWidth: variant === 'compact' ? 150 : 220, padding: '3px 6px', fontSize: 12 }}
        value={personaId}
        disabled={saving || !personaEnabled || validPersonas.length === 0}
        aria-label="新会话默认人格"
        title={
          !personaEnabled
            ? '先开启「人格」'
            : validPersonas.length === 0
              ? '暂无可用人格定义（GET /personas）'
              : '新会话默认人格：空 = 跟随全局激活人格 / 共享库'
        }
        onChange={(event) => changePersonaId(event.target.value)}
      >
        <option value="">{activeName ? `跟随激活人格（${activeName}）` : '共享库（未激活人格）'}</option>
        {validPersonas.map((definition) => (
          <option key={definition.id} value={definition.id}>
            {definition.name ? `${definition.name} (${definition.id})` : definition.id}
          </option>
        ))}
        {personaId.length > 0 && !knownIds.has(personaId) ? <option value={personaId}>{`${personaId}（定义缺失）`}</option> : null}
      </select>
      {statusText.length > 0 ? (
        <span style={{ color: statusTone, fontSize: 11, whiteSpace: 'nowrap' }} role="status">
          {statusText}
        </span>
      ) : null}
    </div>
  );

  if (variant === 'compact') {
    return (
      <div
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 10,
          flexWrap: 'wrap',
          color: token.textSecondary,
          fontFamily: 'inherit',
        }}
        title="新会话默认：下一个新会话的记忆/人格设置（不影响当前会话）"
      >
        <span style={{ fontSize: 11, color: token.textTertiary, whiteSpace: 'nowrap' }}>新会话默认</span>
        {controls}
      </div>
    );
  }

  return (
    <div style={styles.card}>
      <SectionTitle
        first
        extra={
          saving ? (
            <Badge tone="neutral">保存中…</Badge>
          ) : failure !== null ? (
            <Badge tone={failure === 'host-pending' ? 'warn' : 'error'}>
              {failure === 'host-pending' ? 'Host 未就绪' : '保存失败'}
            </Badge>
          ) : savedAt !== null ? (
            <Badge tone="success">已保存</Badge>
          ) : null
        }
      >
        新会话默认
      </SectionTitle>
      <div style={{ ...styles.statHint, marginBottom: 10, lineHeight: 1.7 }}>
        这里是下一个新会话的默认值（新建会话页 hero 设置行同样可改）；当前会话的开关请到会话内「记忆库」页签调整。
        改动即时保存到 Host（POST /session-config，不带 sessionId，body 带 defaults:true）。
      </div>
      {controls}
      {defaults.error ? (
        <div style={{ ...styles.statHint, marginTop: 8, color: token.warn }}>
          新会话默认接口未就绪（GET /session-config 无 sessionId）：Host 联调后自动生效，当前显示内置默认值（记忆开 / 人格关 / 共享库）。
        </div>
      ) : null}
      {failure !== null ? (
        <div style={{ ...styles.statHint, marginTop: 6, color: failure === 'host-pending' ? token.warn : token.error }}>
          {failure === 'host-pending'
            ? 'Host 写接口尚未就绪（等待联调）：本次改动未保存，可稍后重试。'
            : '保存失败：改动仅在本地生效，刷新后会恢复 Host 当前默认值。'}
        </div>
      ) : null}
    </div>
  );
}

/** hero 槽位注册的默认组件（紧凑横排；无 owner props 依赖、不读 sessionId） */
export function HeroOptions(): JSX.Element {
  return <NewSessionDefaults variant="compact" />;
}

export default HeroOptions;

/** 槽位最小接口（只用到 inject/register；避免打包 DSH 类型包） */
export interface HeroSlotsLike {
  inject(key: string, callback: () => unknown): void;
  register(
    options: { name: string; id?: string; order?: number; label?: string | (() => string); [key: string]: unknown },
    component: unknown,
  ): () => void;
}

/**
 * 注册 `conversation.hero.options`（新建会话页 hero 设置行）。
 *
 * - feature-detect：宿主没有该 slot 声明时 `inject` 不会回调，静默不注册；
 * - 注册失败只回调 onError（index.tsx 里 console.warn），绝不向上抛错、不影响 boot。
 */
export function registerHeroOptions(slots: HeroSlotsLike, onError: (message: string, error: unknown) => void): void {
  try {
    slots.inject(HERO_OPTIONS_SLOT, () =>
      slots.register(
        {
          name: HERO_OPTIONS_SLOT,
          id: HERO_OPTIONS_ID,
          order: 100,
          label: () => '记忆',
        },
        HeroOptions,
      ),
    );
  } catch (error) {
    onError('新建会话 hero 选项注册失败（不影响 boot）', error);
  }
}

// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hanxustu (dsh-life-memory)
/**
 * 人格 Persona（v5：只读展示 + 可编辑 CRUD / 激活 / 记忆库切换，见 docs/25-persona.md）。
 *
 * 能力（全部与 Host 契约对齐）：
 * - GET  /personas       当前激活人格 + 定义摘要（含每人记忆数）
 * - GET  /vaults         记忆库总览（共享库 + 每个人格库：raw/记忆条数/大小/最近更新/当前库）
 * - POST /personas               新建人格（写 persona.dir/<id>.md）
 * - POST /personas/update        编辑人格
 * - POST /personas/delete        删除人格（移入 .trash，非物理删除历史）
 * - POST /personas/activate      切换全局激活人格（= 切换独立记忆库；null = 取消/共享库）
 *
 * 写操作失败（Host 写接口尚未就绪 404 等）只显示提示/横幅，绝不崩溃；
 * 所有写请求集中在 api.persona* 中，其余数据仍 GET-only。
 */
import { useEffect, useMemo, useState } from 'react';
import { api, isHostWritePending, useApi } from '../api.ts';
import {
  Badge,
  EmptyState,
  ErrorNotice,
  LoadingNotice,
  SectionTitle,
  StatCard,
} from '../components.tsx';
import { styles, token } from '../theme.tsx';
import type {
  PersonaHealth,
  PersonaMemoryCount,
  PersonaSummary,
  VaultInfo,
} from '../types.ts';
import { formatBytes, formatNumber, formatRelative, formatTime } from '../util.ts';

export interface PersonasViewProps {
  /** 查看某人格的记忆（跳到「层统计」并按 persona 过滤） */
  onOpenMemories?: (personaId: string) => void;
}

interface PersonaFormState {
  mode: 'create' | 'edit';
  id: string;
  name: string;
  description: string;
  tags: string;
  aliases: string;
  body: string;
}

const EMPTY_FORM: PersonaFormState = {
  mode: 'create',
  id: '',
  name: '',
  description: '',
  tags: '',
  aliases: '',
  body: '',
};

/** 由名称生成候选 id（英文/数字保留，其它转 -；可手改） */
function slugifyId(name: string): string {
  const base = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
  if (base.length > 0 && /^[a-z0-9]/.test(base)) return base;
  return `persona-${Date.now().toString(36).slice(-6)}`;
}

function splitList(value: string): string[] {
  return value
    .split(/[,，\s]+/)
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function memoryCountOf(
  definition: PersonaSummary,
  counts: Record<string, PersonaMemoryCount> | undefined,
): PersonaMemoryCount {
  const fromCounts = counts?.[definition.id];
  return definition.memories ?? fromCounts ?? {};
}

function countTotal(count: PersonaMemoryCount | undefined): number | undefined {
  if (!count) return undefined;
  if (typeof count.total === 'number') return count.total;
  const parts = [count.L1, count.L2, count.L3].filter((value): value is number => typeof value === 'number');
  return parts.length > 0 ? parts.reduce((sum, value) => sum + value, 0) : undefined;
}

function countsLine(count: PersonaMemoryCount | undefined): string {
  return `total ${formatNumber(countTotal(count))} · L1 ${formatNumber(count?.L1)} · L2 ${formatNumber(count?.L2)} · L3 ${formatNumber(count?.L3)}`;
}

/** 写操作状态（保存中/成功/失败提示；Host 未就绪单独提示） */
function useWriteAction(): {
  pending: boolean;
  message: string | null;
  error: string | null;
  hostPending: boolean;
  run: (action: () => Promise<unknown>, okMessage: string) => Promise<boolean>;
  clear: () => void;
} {
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hostPending, setHostPending] = useState(false);

  const run = async (action: () => Promise<unknown>, okMessage: string): Promise<boolean> => {
    setPending(true);
    setMessage(null);
    setError(null);
    try {
      await action();
      setMessage(okMessage);
      setHostPending(false);
      return true;
    } catch (caught) {
      if (isHostWritePending(caught)) {
        setHostPending(true);
        setError('Host 写接口尚未就绪（等待联调）：写操作未生效。');
      } else {
        setError(caught instanceof Error ? caught.message : String(caught));
      }
      return false;
    } finally {
      setPending(false);
    }
  };

  const clear = (): void => {
    setMessage(null);
    setError(null);
  };

  return { pending, message, error, hostPending, run, clear };
}

function PersonaForm(props: {
  form: PersonaFormState;
  pending: boolean;
  onChange: (next: PersonaFormState) => void;
  onSubmit: () => void;
  onCancel: () => void;
}): JSX.Element {
  const { form } = props;
  const set = (patch: Partial<PersonaFormState>): void => props.onChange({ ...form, ...patch });
  return (
    <div style={{ ...styles.card, marginBottom: 12, border: `1px solid ${token.brand}` }}>
      <SectionTitle first>
        {form.mode === 'create' ? '新建人格（写 persona.dir/<id>.md）' : `编辑人格 ${form.id}`}
      </SectionTitle>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 8 }}>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span style={styles.statHint}>名称 *</span>
          <input
            style={styles.input}
            value={form.name}
            placeholder="例如：小林"
            onChange={(event) => {
              const name = event.target.value;
              // create 模式：ID 未手改时按名称自动生成
              const id = form.mode === 'create' && (form.id === '' || form.id === slugifyId(form.name)) ? slugifyId(name) : form.id;
              set({ name, id });
            }}
          />
        </label>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span style={styles.statHint}>ID（文件名；可手改）</span>
          <input
            style={{ ...styles.input, fontFamily: 'monospace' }}
            value={form.id}
            placeholder="persona-id（^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$）"
            onChange={(event) => set({ id: event.target.value })}
            disabled={form.mode === 'edit'}
          />
        </label>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span style={styles.statHint}>描述</span>
          <input style={styles.input} value={form.description} placeholder="一句话描述（roster/UI 展示）" onChange={(event) => set({ description: event.target.value })} />
        </label>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span style={styles.statHint}>标签（逗号分隔）</span>
          <input style={styles.input} value={form.tags} placeholder="assistant, engineer" onChange={(event) => set({ tags: event.target.value })} />
        </label>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span style={styles.statHint}>别名（逗号分隔）</span>
          <input style={styles.input} value={form.aliases} placeholder="kobayashi" onChange={(event) => set({ aliases: event.target.value })} />
        </label>
      </div>
      <label style={{ display: 'flex', flexDirection: 'column', gap: 4, marginTop: 8 }}>
        <span style={styles.statHint}>人格提示词正文 *（frontmatter 之后的内容；= system prompt 身份块）</span>
        <textarea
          style={{ ...styles.input, minHeight: 120, resize: 'vertical', fontSize: 12, lineHeight: 1.6 }}
          value={form.body}
          placeholder={'例如：你是"小林"，用户长期合作的个人助理。说话简洁、先给结论，再给依据。'}
          onChange={(event) => set({ body: event.target.value })}
        />
      </label>
      <div style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
        <button type="button" style={styles.buttonPrimary} onClick={props.onSubmit} disabled={props.pending}>
          {props.pending ? '保存中…' : form.mode === 'create' ? '创建人格' : '保存修改'}
        </button>
        <button type="button" style={styles.button} onClick={props.onCancel} disabled={props.pending}>
          取消
        </button>
        <span style={styles.statHint}>
          {form.mode === 'create'
            ? '创建后自动热重载；同一时刻最多一个激活人格（默认不切换）。'
            : '仅提交有变化的字段；正文留空表示不修改。'}
        </span>
      </div>
    </div>
  );
}

/** 人格卡片（含 v5 操作按钮） */
function PersonaCard(props: {
  definition: PersonaSummary;
  active: boolean;
  count: PersonaMemoryCount;
  busy: boolean;
  onUse: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onOpenMemories?: (personaId: string) => void;
}): JSX.Element {
  const { definition } = props;
  const valid = definition.valid !== false;
  return (
    <div
      style={{
        ...styles.card,
        border: `1px solid ${props.active ? token.brand : token.borderL2}`,
        background: props.active ? token.bgLayer2 : token.bgLayer1,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
        <strong style={{ fontSize: 13 }}>{definition.name || definition.id}</strong>
        <span style={{ ...styles.mono, color: token.textTertiary }}>{definition.id}</span>
        {props.active ? <Badge tone="brand">当前激活</Badge> : null}
        {valid ? <Badge tone="success">有效</Badge> : <Badge tone="error">无效</Badge>}
        {definition.truncated ? <Badge tone="warn">正文已截断</Badge> : null}
        <span style={{ ...styles.statHint, marginLeft: 'auto' }}>{formatRelative(definition.mtime)}</span>
      </div>
      <div style={{ fontSize: 12, marginTop: 6, color: token.textSecondary, wordBreak: 'break-word' }}>
        {definition.description || '（无描述）'}
      </div>
      {!valid && definition.invalidReason ? (
        <div style={{ ...styles.statHint, color: token.error, marginTop: 4 }}>无效原因：{definition.invalidReason}</div>
      ) : null}
      {definition.tags && definition.tags.length > 0 ? (
        <div style={{ ...styles.wrap, marginTop: 6, gap: 4 }}>
          {definition.tags.map((tag) => (
            <Badge key={tag} tone="neutral">
              #{tag}
            </Badge>
          ))}
        </div>
      ) : null}
      <div style={{ ...styles.mono, color: token.textTertiary, marginTop: 6 }}>{countsLine(props.count)}</div>
      <div style={{ display: 'flex', gap: 6, marginTop: 8, flexWrap: 'wrap' }}>
        {!props.active && valid ? (
          <button type="button" style={styles.buttonPrimary} onClick={props.onUse} disabled={props.busy}>
            使用此人格
          </button>
        ) : null}
        {props.active ? <Badge tone="info">正在使用（切换即切换独立记忆库）</Badge> : null}
        <button type="button" style={styles.button} onClick={props.onEdit} disabled={props.busy}>
          编辑
        </button>
        <button type="button" style={{ ...styles.button, color: token.error }} onClick={props.onDelete} disabled={props.busy}>
          删除
        </button>
        {valid && props.onOpenMemories ? (
          <button type="button" style={styles.button} onClick={() => props.onOpenMemories?.(definition.id)}>
            查看记忆 →
          </button>
        ) : null}
      </div>
      {definition.sourcePath ? (
        <div style={{ ...styles.mono, color: token.textTertiary, marginTop: 6, fontSize: 10 }} title={definition.sourcePath}>
          {definition.sourcePath}
        </div>
      ) : null}
    </div>
  );
}

/** 记忆库卡片（v5；点击 = 使用该记忆库/人格） */
function VaultCard(props: { vault: VaultInfo; busy: boolean; onUse: () => void }): JSX.Element {
  const { vault } = props;
  const active = vault.isActive === true;
  const stats = vault.stats ?? {};
  return (
    <div
      style={{
        ...styles.card,
        border: `1px solid ${active ? token.brand : token.borderL2}`,
        background: active ? token.bgLayer2 : token.bgLayer1,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
        <strong style={{ fontSize: 13 }}>{vault.name || vault.id}</strong>
        <span style={{ ...styles.mono, color: token.textTertiary }}>{vault.id}</span>
        {active ? <Badge tone="brand">当前记忆库</Badge> : null}
        {vault.isPersona === false ? <Badge tone="neutral">共享库</Badge> : <Badge tone="info">人格库</Badge>}
      </div>
      <div style={{ ...styles.statHint, marginTop: 6 }}>
        raw {formatNumber(stats.rawRecords)} · 记忆 {formatNumber(stats.memoryCount)} · 大小 {formatBytes(stats.dbBytes)} · 更新{' '}
        {formatRelative(stats.lastUpdatedAt)}
      </div>
      <div style={{ marginTop: 8 }}>
        {active ? (
          <span style={styles.statHint}>正在使用</span>
        ) : (
          <button type="button" style={styles.button} onClick={props.onUse} disabled={props.busy}>
            {vault.isPersona === false ? '使用共享库（取消人格）' : '使用该人格库'}
          </button>
        )}
      </div>
    </div>
  );
}

export function PersonasView(props: PersonasViewProps): JSX.Element {
  const personas = useApi(() => api.personas(), []);
  const vaults = useApi(() => api.vaults(), []);
  // 兜底：/personas 未就绪时用 /status.persona 的摘要/计数（只读展示）
  const status = useApi(() => api.status(false), []);
  const write = useWriteAction();
  const [form, setForm] = useState<PersonaFormState | null>(null);

  const data = personas.data;
  const health: PersonaHealth | undefined = status.data?.persona ?? undefined;
  // v5：全局激活人格以 /vaults.activePersonaId 为准（默认会话可能路由到共享库，/personas.activeId 为空）
  const activeId = vaults.data?.activePersonaId ?? data?.activeId ?? health?.activeId ?? null;
  const definitions = data?.definitions ?? health?.definitions ?? [];
  const memoryCounts = data?.memoryCounts ?? health?.memoryCounts ?? {};
  const sharedCount = data?.sharedCount ?? health?.sharedCount;
  const dir = data?.dir ?? health?.dir ?? null;
  const lastError = health?.lastError ?? null;
  const activeDefinition = activeId ? definitions.find((definition) => definition.id === activeId) : undefined;
  const activeName = activeDefinition?.name || health?.activeName || activeId || null;
  const activeBody = activeDefinition?.body ?? activeDefinition?.bodyPreview ?? null;
  const activeCount = activeDefinition ? memoryCountOf(activeDefinition, memoryCounts) : activeId ? memoryCounts[activeId] : undefined;
  const knownIds = new Set(definitions.map((definition) => definition.id));
  const orphanCounts = Object.entries(memoryCounts).filter(([personaId]) => !knownIds.has(personaId));
  const invalidCount = definitions.filter((definition) => definition.valid === false).length;
  const validCount = definitions.filter((definition) => definition.valid !== false).length;
  const vaultList: VaultInfo[] = vaults.data?.vaults ?? [];
  const activeVaultId = vaults.data?.activeVaultId ?? null;
  const empty = definitions.length === 0 && orphanCounts.length === 0;
  const busy = write.pending;

  const reloadAll = (): void => {
    personas.reload();
    vaults.reload();
    status.reload();
  };

  // 写操作成功提示 3s 后淡出；失败保留
  useEffect(() => {
    if (!write.message) return;
    const timer = setTimeout(() => write.clear(), 4000);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 仅响应 message 变化
  }, [write.message]);

  const submitForm = async (): Promise<void> => {
    if (!form) return;
    if (form.name.trim().length === 0) {
      write.clear();
      return;
    }
    if (form.mode === 'create') {
      const ok = await write.run(
        () =>
          api.personaCreate({
            id: form.id.trim() || undefined,
            name: form.name.trim(),
            description: form.description.trim() || undefined,
            tags: splitList(form.tags),
            aliases: splitList(form.aliases),
            body: form.body,
          }),
        `人格「${form.name.trim()}」已创建`,
      );
      if (ok) {
        setForm(null);
        reloadAll();
      }
    } else {
      const ok = await write.run(
        () =>
          api.personaUpdate({
            id: form.id,
            name: form.name.trim() || undefined,
            description: form.description.trim() || undefined,
            tags: splitList(form.tags),
            aliases: splitList(form.aliases),
            body: form.body.trim().length > 0 ? form.body : undefined,
          }),
        `人格「${form.id}」已更新`,
      );
      if (ok) {
        setForm(null);
        reloadAll();
      }
    }
  };

  const usePersona = async (personaId: string | null): Promise<void> => {
    const ok = await write.run(
      () => api.personaActivate({ persona: personaId }),
      personaId ? `已切换人格：${personaId}（独立记忆库）` : '已取消人格，使用共享记忆库',
    );
    if (ok) reloadAll();
  };

  const deletePersona = async (definition: PersonaSummary): Promise<void> => {
    const name = definition.name || definition.id;
    const confirmed = typeof window === 'undefined' ? true : window.confirm(`确定删除人格「${name}」？\n文件将移入 persona.dir/.trash/（非物理删除历史）。`);
    if (!confirmed) return;
    const ok = await write.run(
      () => api.personaDelete({ id: definition.id }),
      `人格「${name}」已删除（备份在 .trash/）`,
    );
    if (ok) {
      if (activeId === definition.id) write.clear();
      reloadAll();
    }
  };

  return (
    <div>
      <div style={{ ...styles.row, gap: 8, flexWrap: 'wrap', marginBottom: 10 }}>
        <Badge tone="brand">人格（Persona）</Badge>
        <span style={styles.statHint}>
          人格是记忆的使用者与独立记忆库：每人格拥有自己的工作/情景/语义记忆，默认隔离、可共享；定义来自 markdown（Host 热重载）。
        </span>
        <button
          type="button"
          style={{ ...styles.buttonPrimary, marginLeft: 'auto' }}
          onClick={() => setForm(form && form.mode === 'create' ? null : { ...EMPTY_FORM })}
          disabled={busy}
        >
          {form && form.mode === 'create' ? '收起新建表单' : '+ 新建人格'}
        </button>
        <button type="button" style={styles.button} onClick={reloadAll}>
          刷新
        </button>
      </div>

      {write.error ? (
        <div style={{ marginBottom: 10 }}>
          <div style={styles.error} role="alert">
            {write.error}
            {write.hostPending ? '（Host 未就绪时可先只读浏览；联调后重试即可）' : ''}
          </div>
        </div>
      ) : null}
      {write.message ? <div style={{ ...styles.statHint, color: token.success, marginBottom: 8 }}>✓ {write.message}</div> : null}
      {personas.error ? (
        <div style={{ marginBottom: 10 }}>
          <ErrorNotice error={personas.error} onRetry={reloadAll} />
          <div style={{ ...styles.statHint, marginTop: 4 }}>/personas 未就绪时回退 /status.persona 摘要；写操作会提示 Host 未就绪。</div>
        </div>
      ) : null}
      {vaults.error ? (
        <div style={{ ...styles.statHint, marginBottom: 8 }}>
          /vaults 未就绪（等待 Host 联调）：记忆库区块暂不可用；人格/记忆数据仍可查看。
        </div>
      ) : null}
      {lastError ? <div style={{ ...styles.statHint, color: token.error, marginBottom: 8 }}>人格目录最近加载错误：{lastError}</div> : null}

      {form ? (
        <PersonaForm
          form={form}
          pending={busy}
          onChange={setForm}
          onSubmit={() => void submitForm()}
          onCancel={() => {
            setForm(null);
            write.clear();
          }}
        />
      ) : null}

      {/* 当前激活人格 */}
      <SectionTitle first>当前激活人格</SectionTitle>
      {activeId ? (
        <div style={{ ...styles.card, border: `1px solid ${token.brand}`, background: token.bgLayer2, marginBottom: 12 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <Badge tone="brand">激活</Badge>
            <strong style={{ fontSize: 15 }}>{activeName}</strong>
            <span style={{ ...styles.mono, color: token.textSecondary }}>{activeId}</span>
            {activeDefinition?.truncated ? <Badge tone="warn">正文已截断</Badge> : null}
            <button
              type="button"
              style={{ ...styles.button, marginLeft: 'auto' }}
              onClick={() => void usePersona(null)}
              disabled={busy}
            >
              取消人格（使用共享库）
            </button>
          </div>
          {activeDefinition?.description ? (
            <div style={{ fontSize: 13, marginTop: 6, color: token.textSecondary }}>{activeDefinition.description}</div>
          ) : null}
          {activeDefinition?.tags && activeDefinition.tags.length > 0 ? (
            <div style={{ ...styles.wrap, marginTop: 6, gap: 4 }}>
              {activeDefinition.tags.map((tag) => (
                <Badge key={tag} tone="neutral">
                  #{tag}
                </Badge>
              ))}
            </div>
          ) : null}
          <div style={{ ...styles.mono, color: token.textTertiary, marginTop: 8 }}>{countsLine(activeCount)}</div>
          <div style={{ ...styles.statHint, marginTop: 8 }}>
            {activeBody
              ? '人格正文预览（system prompt 身份块）'
              : `定义文件：${dir ? `${dir}/${activeId}.md` : `<persona.dir>/${activeId}.md`}（/personas 仅返回摘要，正文由 Host 决定是否暴露）`}
          </div>
          {activeBody ? <pre style={{ ...styles.pre, marginTop: 6, maxHeight: 220 }}>{activeBody}</pre> : null}
          <div style={{ display: 'flex', gap: 6, marginTop: 8, flexWrap: 'wrap' }}>
            {activeDefinition ? (
              <button
                type="button"
                style={styles.button}
                onClick={() =>
                  setForm({
                    mode: 'edit',
                    id: activeDefinition.id,
                    name: activeDefinition.name ?? '',
                    description: activeDefinition.description ?? '',
                    tags: (activeDefinition.tags ?? []).join(', '),
                    aliases: (activeDefinition as PersonaSummary & { aliases?: string[] }).aliases?.join(', ') ?? '',
                    body: activeBody ?? '',
                  })
                }
                disabled={busy}
              >
                编辑当前人格
              </button>
            ) : null}
            {props.onOpenMemories && activeId ? (
              <button type="button" style={styles.button} onClick={() => props.onOpenMemories?.(activeId)}>
                查看该人格记忆 →
              </button>
            ) : null}
          </div>
        </div>
      ) : (
        <div style={{ ...styles.card, marginBottom: 12 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <Badge tone="neutral">未激活</Badge>
            <span style={{ fontSize: 13 }}>当前使用共享记忆库：所有记忆归为「共享」，不注入人格身份块。</span>
          </div>
          <div style={{ ...styles.statHint, marginTop: 6 }}>
            选择下方某个人格卡片「使用此人格」即可切换为独立记忆库（写操作，POST /personas/activate）。
          </div>
        </div>
      )}

      {/* 统计卡 */}
      <div style={styles.cardGrid}>
        <StatCard label="人格定义" value={formatNumber(definitions.length)} hint={`有效 ${formatNumber(validCount)} · 无效 ${formatNumber(invalidCount)}`} />
        <StatCard label="当前人格记忆" value={formatNumber(countTotal(activeCount))} hint={activeId ? countsLine(activeCount) : '未激活（全部为共享）'} />
        <StatCard label="共享记忆" value={formatNumber(sharedCount)} hint="无人格归属（personaId = null），所有激活人格共用" />
        <StatCard
          label="记忆库"
          value={formatNumber(vaultList.length)}
          hint={activeVaultId ? `当前库：${activeVaultId}` : dir ?? '<persona.dir>（默认 ~/.dsh/personas）'}
        />
      </div>

      {/* 记忆库总览（v5） */}
      <SectionTitle>记忆库（vault）</SectionTitle>
      {vaults.phase === 'loading' && vaultList.length === 0 ? <LoadingNotice label="读取记忆库…" /> : null}
      {!vaults.error && vaultList.length === 0 && vaults.phase === 'ready' ? (
        <EmptyState title="暂无记忆库信息" hint="/vaults 返回空；Host 联调后这里会列出共享库与每个人格库。" />
      ) : null}
      {vaultList.length > 0 ? (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 12 }}>
          {vaultList.map((vault) => (
            <VaultCard
              key={vault.id}
              vault={vault}
              busy={busy}
              onUse={() => void usePersona(vault.isPersona === false ? null : vault.id)}
            />
          ))}
        </div>
      ) : null}

      <SectionTitle>全部人格</SectionTitle>
      {personas.phase === 'loading' && definitions.length === 0 ? <LoadingNotice label="读取人格定义…" /> : null}
      {empty && personas.phase !== 'loading' ? (
        <EmptyState
          title="还没有人格定义"
          hint={`把 *.md 人格文件放到 ${dir ?? '<persona.dir>'}（默认 ~/.dsh/personas），或点击右上角「+ 新建人格」创建。Host 会热重载（约 200ms 防抖）。`}
        />
      ) : null}
      {definitions.length > 0 ? (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: 12 }}>
          {definitions.map((definition) => (
            <PersonaCard
              key={definition.id}
              definition={definition}
              active={activeId === definition.id}
              count={memoryCountOf(definition, memoryCounts)}
              busy={busy}
              onUse={() => void usePersona(definition.id)}
              onEdit={() =>
                setForm({
                  mode: 'edit',
                  id: definition.id,
                  name: definition.name ?? '',
                  description: definition.description ?? '',
                  tags: (definition.tags ?? []).join(', '),
                  aliases: (definition as PersonaSummary & { aliases?: string[] }).aliases?.join(', ') ?? '',
                  body: definition.body ?? definition.bodyPreview ?? '',
                })
              }
              onDelete={() => void deletePersona(definition)}
              onOpenMemories={props.onOpenMemories}
            />
          ))}
        </div>
      ) : null}

      {orphanCounts.length > 0 ? (
        <>
          <SectionTitle>仅有记忆、无当前定义的人格</SectionTitle>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 12 }}>
            {orphanCounts.map(([personaId, count]) => (
              <div key={personaId} style={{ ...styles.card, border: `1px dashed ${token.borderL3}` }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                  <span style={{ ...styles.mono, fontSize: 12 }}>{personaId}</span>
                  <Badge tone="warn">定义缺失</Badge>
                </div>
                <div style={{ ...styles.statHint, marginTop: 6 }}>{countsLine(count)}</div>
              </div>
            ))}
          </div>
        </>
      ) : null}

      <div style={{ ...styles.statHint, marginTop: 14, lineHeight: 1.7 }}>
        说明：人格定义来自 markdown 文件（`*.md`，文件名 = id，YAML frontmatter 支持 name/description/aliases/tags/model/provider，
        正文 = system prompt）；新建/编辑/删除都是写 persona.dir 下文件（删除移入 .trash/），Host 热重载并归档到 L0 原始层。
        切换人格 = 切换独立记忆库；「取消人格」= 使用共享库。本页写操作仅 POST /personas* 五个接口。
      </div>
    </div>
  );
}

/** 供概览复用：当前人格展示名 */
export function personaDisplayName(activeId: string | null | undefined, health: PersonaHealth | undefined): string {
  if (!activeId) return '未激活';
  const definition = health?.definitions?.find((item) => item.id === activeId);
  return definition?.name || health?.activeName || activeId;
}

/** 供概览复用：人格记忆计数 */
export function personaCountTotal(count: PersonaMemoryCount | undefined): number | undefined {
  return countTotal(count);
}

/** 供概览复用：KV 行 */
export function personaCountsLine(count: PersonaMemoryCount | undefined): string {
  return countsLine(count);
}

export type { PersonaSummary };


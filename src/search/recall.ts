// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hanxustu (dsh-life-memory)
/**
 * 混合召回服务（`Recaller`）—— docs/24-memory-access-forgetting §1 的**访问分工**：
 *
 * | 模式 | 数据源 | 用途 | 遗忘影响 |
 * | --- | --- | --- | --- |
 * | `explicit`（**默认**） | **L0 原始层** + 原始层永久向量模型 + raw FTS | `memory_recall` 工具 / 用户显式提问 / UI 搜索 | **不受遗忘影响** |
 * | `implicit` | 三层记忆 L1/L2/L3（docs/20/23） | system prompt 注入 / 自动召回 / 调试 | 受 forgetting 影响 |
 *
 * 显式检索（explicit）评分（docs/24 §3）：
 * ```
 * vector  = max(0, cos(rawVector, query))           权重 0.45
 * lexical = b/(1+b), b=max(0,-bm25)（raw_fts）      权重 0.35
 * recency = 0.5 ^ (ageDays(raw.ts) / halfLifeDays)  权重 0.20
 * score   = 0.45*vector + 0.35*lexical + 0.20*recency
 * ```
 * 命中 `RecallHit{layer:'raw', raw, citations:[raw.id]}`；原始层无向量时自动只走词法
 * （记 warning，不失败）；原始层检索不 touch、不写 retention、不受遗忘影响。
 *
 * 隐式检索（implicit，docs/20 §10.3 / docs/23 §4 既有行为）：
 * ```
 * score = Σ(w_i · component_i) / Σw_i × layerPrior(layer) × retentionPrior(tier)
 * ```
 * 默认不限制 retentionTier；`retentionTiers` 过滤；召回只 touch access_count/heat，不写 retention。
 */
import type {
  Embedder,
  EmbeddingRef,
  LayerId,
  LexHit,
  Logger,
  MemoryKind,
  MemoryRecord,
  MemoryStore,
  MemoryVaultConfig,
  RawIndexRow,
  RawRecord,
  RawVecHit,
  RecallHit,
  RecallQuery,
  Recaller,
  RetentionTier,
  VecHit,
} from '../core/contracts.ts';
import { PromptSectionBuilder } from '../prompt/section.ts';
import { maybeRedact } from '../tools/redact.ts';

/** 单条命中文本的展示上限（token 预算/工具返回用） */
export const HIT_TEXT_DISPLAY_LIMIT = 600;

/** 显式检索（L0 原始层）三因子权重（docs/24 §3；和 = 1） */
export const EXPLICIT_VECTOR_WEIGHT = 0.45;
export const EXPLICIT_LEXICAL_WEIGHT = 0.35;
export const EXPLICIT_RECENCY_WEIGHT = 0.2;

/** 召回服务选项（store/embedder 由集成层注入，便于脱离真实实现单测） */
export interface RecallerOptions {
  store: MemoryStore;
  embedder: Embedder;
  config: MemoryVaultConfig;
  logger: Logger;
  /** 时钟注入（测试）；默认 Date.now */
  now?: () => number;
  /** 注入块「工作记忆」用的当前会话 id（无会话上下文返回 null；集成层注入） */
  getSessionId?: () => string | null;
  /**
   * 读取 L0 原始记录（显式检索用）。集成层注入 vault.get；不传时回退用 raw_index 行还原
   * （payload 从 payloadJson 解析，足以满足工具/UI 展示）。
   */
  getRaw?: (id: string) => Promise<RawRecord | null>;
}

/** 记录当前所属保留期层（未初始化视为 short，与 store 默认一致） */
export function retentionTierOf(memory: MemoryRecord): RetentionTier {
  return memory.retentionTier ?? 'short';
}

/** 保留期召回先验（docs/23-memory-models §7：short .95 / mid 1.0 / long 1.0；关闭分层时为 1） */
export function retentionPriorFor(tier: RetentionTier, config: MemoryVaultConfig): number {
  if (config.retention.enabled === false) return 1;
  const prior = config.recall.retentionPrior?.[tier];
  return typeof prior === 'number' && Number.isFinite(prior) && prior >= 0 ? prior : 1;
}

/** 词法分归一（兼容 store 返回"原始 bm25（负值）"或"已归一化 [0,1)"两种实现） */
export function normalizeLexicalComponent(score: number): number {
  if (!Number.isFinite(score)) return 0;
  if (score < 0) {
    const b = Math.max(0, -score);
    return b / (1 + b);
  }
  return Math.min(1, Math.max(0, score));
}

/**
 * 词法分"量纲退化"阈值。
 *
 * 背景（真实集成测试发现）：SQLite FTS5 `bm25()` 的绝对量级与语料规模相关，
 * 小库 / 短文本下常见 `-1e-6` 量级；直接套 docs/20 §10.3 的 `b/(1+b)` 会得到
 * `lexical ≈ 1e-6`——中文 2 字查询明明命中，`components.lexical` 却显示 0，
 * 混合分被向量完全主导（lead E2E 观测到的 "lexical: 0"）。
 *
 * 容错策略：**仅当**本批所有命中分数的归一化值都 < 该阈值（即 bm25 量级退化）时，
 * 改用名次归一化 `lex = (n - rank) / n` 保留词法排序信号；分数正常时仍严格按
 * docs §10.3 公式计算。components 语义不变（都是 [0,1] 的相关性分）。
 */
export const LEXICAL_DEGENERATE_FLOOR = 1e-2;

/** 时间衰减分量（docs §10.3 recency） */
export function recencyComponent(updatedAt: number, now: number, halfLifeDays: number): number {
  const halfLife = Number.isFinite(halfLifeDays) && halfLifeDays > 0 ? halfLifeDays : 30;
  const ageDays = Math.max(0, (now - updatedAt) / 86_400_000);
  return 0.5 ** (ageDays / halfLife);
}

/** 单条记忆的混合评分（纯函数；便于单测断言公式） */
export function combineRecallScore(
  memory: MemoryRecord,
  components: RecallHit['components'],
  config: MemoryVaultConfig,
  options: { layer?: LayerId } = {},
): number {
  const hybrid = config.recall.hybrid;
  const weightSum =
    hybrid.vectorWeight + hybrid.lexicalWeight + hybrid.recencyWeight + hybrid.importanceWeight;
  if (!(weightSum > 0)) return 0;
  const raw =
    (hybrid.vectorWeight * components.vector +
      hybrid.lexicalWeight * components.lexical +
      hybrid.recencyWeight * components.recency +
      hybrid.importanceWeight * components.importance) /
    weightSum;
  const layer = options.layer ?? memory.layer;
  const prior = config.recall.layerPrior[layer] ?? 1;
  const statusFactor = (memory.status ?? 'active') === 'active' ? 1 : 0;
  return Math.max(0, raw * prior * statusFactor);
}

interface Candidate {
  lexical: number;
  vector: number;
}

function clampLimit(value: number | undefined, fallback: number, max = 100): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(1, Math.floor(value)));
}

/** 文本截断（用于 formatHit / 注入展示） */
function displayText(text: string, maxChars = HIT_TEXT_DISPLAY_LIMIT): string {
  const value = typeof text === 'string' ? text.replace(/\s+/g, ' ').trim() : '';
  return value.length > maxChars ? `${value.slice(0, maxChars)}…` : value;
}

/** 创建召回服务 */
export function createRecaller(options: RecallerOptions): Recaller {
  const { store, embedder, config, logger } = options;
  const clock = options.now ?? (() => Date.now());
  const promptBuilder = new PromptSectionBuilder({
    config,
    store,
    now: clock,
    ...(options.getSessionId !== undefined ? { getSessionId: options.getSessionId } : {}),
  });

  /** 本查询的保留期过滤集合（默认 null = 不限制；docs/23-memory-models §4） */
  function resolveRetentionFilter(query: RecallQuery): Set<RetentionTier> | null {
    if (!config.retention.enabled) return null;
    if (!query.retentionTiers || query.retentionTiers.length === 0) return null;
    return new Set<RetentionTier>(query.retentionTiers);
  }

  /** 保留期过滤（未初始化视为 short） */
  function passesRetention(memory: MemoryRecord, filter: Set<RetentionTier> | null): boolean {
    if (filter === null) return true;
    return filter.has(retentionTierOf(memory));
  }

  /** 保留期先验（关闭分层时不参与评分，行为与旧版一致） */
  function retentionPrior(memory: MemoryRecord): number {
    return retentionPriorFor(retentionTierOf(memory), config);
  }

  // -------------------------------------------------------------------------
  // 人格作用域过滤（docs/25 §4；config.persona.enabled=false 时退化为不过滤）
  // -------------------------------------------------------------------------

  /** 本查询是否启用人格过滤（personaId 未传 = 不过滤） */
  function personaFilterActive(query: RecallQuery): boolean {
    return config.persona?.enabled !== false && query.personaId !== undefined;
  }

  /** 派生记忆是否命中人格作用域：目标人格本身 + （默认）共享记忆 */
  function personaMatches(memory: MemoryRecord, query: RecallQuery): boolean {
    if (!personaFilterActive(query)) return true;
    const target = query.personaId ?? null;
    const memoryPersona = memory.personaId ?? null;
    if (memoryPersona === target) return true;
    const includeShared = query.includeSharedPersona !== false;
    return includeShared && memoryPersona === null;
  }

  /** 派生层查询的人格过滤参数（透传给 store.listMemories） */
  function personaQueryFilter(query: RecallQuery): { personaId?: string | null; includeSharedPersona?: boolean } {
    if (!personaFilterActive(query)) return {};
    return {
      personaId: query.personaId ?? null,
      includeSharedPersona: query.includeSharedPersona !== false,
    };
  }

  /**
   * 原始层人格候选集合（docs/25 §4/§7）：
   * 契约的 `searchRawVector/searchRawLexical` 不支持人格过滤，先用 `listRawIndex({personaId})`
   * 取允许的 raw id 集合，再对检索命中做内存过滤（候选不足时放大检索 limit 已缓解）。
   */
  function allowedRawIds(query: RecallQuery): Set<string> | null {
    if (!personaFilterActive(query)) return null;
    const ids = new Set<string>();
    const collect = (personaId: string | null): void => {
      try {
        const { records } = store.listRawIndex({ personaId, limit: 50_000 });
        for (const row of records) ids.add(row.id);
      } catch (err) {
        logger.warn(`recall: 读取 raw_index 人格候选失败（降级为不过滤）：${err instanceof Error ? err.message : String(err)}`);
        throw err;
      }
    };
    try {
      collect(query.personaId ?? null);
      if (query.personaId !== null && query.includeSharedPersona !== false) collect(null);
      return ids;
    } catch {
      return null;
    }
  }

  /** 读取记录向量（近重复/MMR 用；失败返回 null，不抛错） */
  function getVector(memoryId: string): Float32Array | null {
    try {
      const row = store.getVector(memoryId);
      return row && row.vec instanceof Float32Array ? row.vec : null;
    } catch {
      return null;
    }
  }

  /** 余弦相似度（已归一化向量即点积；长度不一致返回 0） */
  function cosine(a: Float32Array | null, b: Float32Array | null): number {
    if (!a || !b || a.length !== b.length || a.length === 0) return 0;
    let dot = 0;
    for (let i = 0; i < a.length; i += 1) dot += a[i] * b[i];
    return dot;
  }

  /** 引用列表（契约示例是纯 id 列表：memory id + raw id；格式化在 formatHit 里做） */
  function buildCitations(memory: MemoryRecord): string[] {
    const out: string[] = [memory.id];
    for (const rawId of (memory.sourceRawIds ?? []).slice(0, 10)) {
      if (typeof rawId === 'string' && rawId.length > 0) out.push(rawId);
    }
    return out;
  }

  /** 人读引用串（`[mem:…] [raw:…@segment:lineNo]`，docs §8.3） */
  function citationLabels(memory: MemoryRecord): string[] {
    const out = [`[mem:${memory.id}]`];
    let rawIndex: RawIndexRow | null = null;
    for (const rawId of (memory.sourceRawIds ?? []).slice(0, 10)) {
      if (typeof rawId !== 'string' || rawId.length === 0) continue;
      try {
        rawIndex = store.getRawIndex(rawId);
      } catch {
        rawIndex = null;
      }
      out.push(rawIndex ? `[raw:${rawId}@${rawIndex.segment}:${rawIndex.lineNo}]` : `[raw:${rawId}]`);
    }
    return out;
  }

  /**
   * 词法命中 → 归一化 lexical 分量（docs §10.3；bm25 量纲退化时退化为名次归一化）。
   * 见 `LEXICAL_DEGENERATE_FLOOR` 注释。
   */
  function applyLexicalHits(ensure: (id: string) => Candidate, lexHits: readonly LexHit[]): void {
    if (lexHits.length === 0) return;
    const values = lexHits.map((hit) => normalizeLexicalComponent(hit.score));
    const maxValue = Math.max(...values);
    const degenerate = maxValue > 0 && maxValue < LEXICAL_DEGENERATE_FLOOR;
    if (degenerate) {
      // 名次归一化：top1 = 1.0，末位 = 1/n；保留词法排序信号
      lexHits.forEach((hit, rank) => {
        const entry = ensure(hit.id);
        entry.lexical = Math.min(1, Math.max(0, (lexHits.length - rank) / lexHits.length));
      });
      logger.debug(
        `recall: FTS5 bm25 量纲退化（max=${maxValue.toExponential(2)}），词法分改用名次归一化（n=${lexHits.length}）`,
      );
      return;
    }
    lexHits.forEach((hit, rank) => {
      const entry = ensure(hit.id);
      entry.lexical = Math.min(1, Math.max(0, values[rank]));
    });
  }

  /** 候选收集：词法 + 向量两路，按 id 合并 */
  async function collectCandidates(
    query: RecallQuery,
    text: string,
    candidateLimit: number,
    layers: LayerId[] | undefined,
    kinds: MemoryKind[] | undefined,
  ): Promise<Map<string, Candidate>> {
    const merged = new Map<string, Candidate>();
    const ensure = (id: string): Candidate => {
      const existing = merged.get(id);
      if (existing) return existing;
      const created: Candidate = { lexical: 0, vector: 0 };
      merged.set(id, created);
      return created;
    };

    // ① 词法：FTS5（store 内部 AND 优先、0 命中 OR 降级）
    if (text.length > 0) {
      try {
        const lexHits: LexHit[] = store.searchLexical(text, {
          ...(layers ? { layers } : {}),
          ...(kinds ? { kinds } : {}),
          limit: candidateLimit,
        });
        applyLexicalHits(ensure, lexHits);
      } catch (err) {
        logger.warn(`recall: 词法检索失败（降级为向量/时间召回）：${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // ② 向量：查询嵌入 + 余弦 topK（嵌入失败降级为纯词法，不抛错）
    if (text.length > 0) {
      try {
        const vectors = await embedder.embed([text]);
        const queryVector = Array.isArray(vectors) && vectors[0] instanceof Float32Array ? vectors[0] : null;
        if (queryVector) {
          const vecHits: VecHit[] = store.searchVector(queryVector, embedder.ref, {
            ...(layers ? { layers } : {}),
            ...(kinds ? { kinds } : {}),
            limit: candidateLimit,
          });
          for (const hit of vecHits) {
            const entry = ensure(hit.id);
            entry.vector = Math.max(0, Math.min(1, hit.score));
          }
        }
      } catch (err) {
        logger.warn(
          `recall: 向量检索失败（降级为纯词法召回）：${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    return merged;
  }

  /** 空查询/无关键词：退化为 recency + importance 的最近记录（docs §10.5） */
  function fallbackCandidates(
    query: RecallQuery,
    candidateLimit: number,
    layers: LayerId[] | undefined,
    kinds: MemoryKind[] | undefined,
    now: number,
  ): Map<string, Candidate> {
    const merged = new Map<string, Candidate>();
    try {
      const records = store.listMemories({
        ...(layers ? { layers } : {}),
        ...(kinds ? { kinds } : {}),
        status: ['active'],
        onlyValid: true,
        ...(query.sessionId ? { sessionId: query.sessionId } : {}),
        ...(query.workspace ? { workspace: query.workspace } : {}),
        ...(query.from !== undefined ? { from: query.from } : {}),
        ...(query.to !== undefined ? { to: query.to } : {}),
        ...personaQueryFilter(query),
        limit: candidateLimit,
        desc: true,
      });
      for (const memory of records) {
        merged.set(memory.id, { lexical: 0, vector: 0 });
      }
    } catch (err) {
      logger.warn(`recall: 空查询兜底读取最近记忆失败：${err instanceof Error ? err.message : String(err)}`);
    }
    return merged;
  }

  /** 后置过滤：层/种类/会话/工作区/时间/状态/有效期 */
  function passesFilters(memory: MemoryRecord, query: RecallQuery, now: number): boolean {
    if (memory.status !== undefined && memory.status !== 'active') return false;
    if (typeof memory.validTo === 'number' && memory.validTo <= now) return false;
    if (query.layers && query.layers.length > 0 && !query.layers.includes(memory.layer)) return false;
    if (query.kinds && query.kinds.length > 0 && !query.kinds.includes(memory.kind)) return false;
    if (query.sessionId !== undefined && memory.sessionId !== query.sessionId) return false;
    if (query.workspace !== undefined && memory.workspace !== query.workspace) return false;
    if (query.from !== undefined && memory.updatedAt < query.from) return false;
    if (query.to !== undefined && memory.updatedAt > query.to) return false;
    // L3 有效期双保险：即使 store 的 memory_records.valid_to 更新路径滞后，也按私有表过滤
    if (memory.layer === 'L3') {
      try {
        const semantic = store.getL3Semantic(memory.id);
        if (semantic && typeof semantic.validTo === 'number' && semantic.validTo <= now) return false;
      } catch {
        /* 私有表不可用时忽略 */
      }
    }
    return true;
  }

  // -------------------------------------------------------------------------
  // 显式检索（L0 原始层 + 永久原始层向量模型；docs/24 §1/§3）
  // -------------------------------------------------------------------------

  /** 用 raw_index 行兜底构造 RawRecord（未注入 getRaw 时；payload 从 payloadJson 还原） */
  function rawFromIndex(row: RawIndexRow): RawRecord {
    let payload: unknown = null;
    try {
      payload = row.payloadJson ? JSON.parse(row.payloadJson) : null;
    } catch {
      payload = row.payloadJson;
    }
    return {
      id: row.id,
      day: row.day,
      seq: row.seq,
      ts: row.ts,
      iso: row.iso,
      timezone: row.timezone,
      kind: row.kind,
      sessionId: row.sessionId,
      workspace: row.workspace,
      personaId: row.personaId ?? null,
      turnId: row.turnId,
      stepId: row.stepId,
      role: row.role,
      text: row.text,
      payload,
      tags: [],
      v: row.recordVersion as 1,
      hash: row.hash,
      prevHash: row.prevHash,
    };
  }

  /** 读取 L0 原始记录：优先注入的 getRaw（vault），否则用 raw_index 行还原 */
  async function loadRaw(rawId: string): Promise<RawRecord | null> {
    if (options.getRaw) {
      try {
        const raw = await options.getRaw(rawId);
        if (raw) return raw;
      } catch {
        /* 回退到 raw_index */
      }
    }
    try {
      const row = store.getRawIndex(rawId);
      return row ? rawFromIndex(row) : null;
    } catch {
      return null;
    }
  }

  /** 原始记录 recency（raw.ts 衰减；半衰期沿用 recall.hybrid.halfLifeDays） */
  function rawRecency(ts: number, now: number): number {
    const halfLife = Number.isFinite(config.recall.hybrid.halfLifeDays) && config.recall.hybrid.halfLifeDays > 0
      ? config.recall.hybrid.halfLifeDays
      : 30;
    const ageDays = Math.max(0, (now - ts) / 86_400_000);
    return 0.5 ** (ageDays / halfLife);
  }

  /**
   * 显式检索（docs/24 §1/§3）：L0 原始层的向量 + 词法 + recency 融合。
   * - 原始层向量不可用/嵌入失败 → 自动降级为纯词法（warning，不失败）；
   * - **不受遗忘影响**（不 touch、不写 retention、不读三层记忆）。
   */
  async function recallExplicit(query: RecallQuery, now: number): Promise<RecallHit[]> {
    const startedAt = now;
    const limit = clampLimit(query.limit, config.recall.toolDefaultLimit);
    const candidateLimit = Math.max(limit, Math.min(config.recall.maxCandidates, Math.max(limit * 4, limit)));
    const text = typeof query.text === 'string' ? query.text.trim() : '';
    if (text.length === 0) return [];

    // 人格作用域：先用 raw_index 取允许的 raw id 集合（store 的 searchRaw* 不支持人格过滤）
    const rawIdFilter = allowedRawIds(query);
    if (rawIdFilter !== null && rawIdFilter.size === 0) {
      logger.debug('recall(explicit): 人格作用域内无原始记录候选');
      return [];
    }
    // 人格过滤在内存中做，放大检索 limit 以降低目标人格候选被挤出 topN 的概率
    const searchLimit = rawIdFilter !== null ? Math.min(config.recall.maxCandidates * 2, candidateLimit * 4) : candidateLimit;

    const merged = new Map<string, { vector: number; lexical: number }>();
    const ensure = (rawId: string): { vector: number; lexical: number } => {
      const existing = merged.get(rawId);
      if (existing) return existing;
      const created = { vector: 0, lexical: 0 };
      merged.set(rawId, created);
      return created;
    };
    let lexicalOk = false;
    let vectorOk = false;

    // ① 原始层词法（raw_fts）
    try {
      if (typeof store.searchRawLexical === 'function') {
        const lexHits: RawVecHit[] = store.searchRawLexical(text, { limit: searchLimit });
        lexicalOk = Array.isArray(lexHits);
        const values = lexHits.map((hit) => normalizeLexicalComponent(hit.score));
        const maxValue = values.length > 0 ? Math.max(...values) : 0;
        const degenerate = maxValue > 0 && maxValue < LEXICAL_DEGENERATE_FLOOR;
        lexHits.forEach((hit, rank) => {
          const entry = ensure(hit.rawId);
          entry.lexical = degenerate
            ? Math.min(1, Math.max(0, (lexHits.length - rank) / lexHits.length))
            : Math.min(1, Math.max(0, values[rank]));
        });
      } else {
        logger.warn('recall(explicit): store.searchRawLexical 不可用，跳过原始层词法检索');
      }
    } catch (err) {
      logger.warn(`recall(explicit): 原始层词法检索失败（降级）：${err instanceof Error ? err.message : String(err)}`);
    }

    // ② 原始层向量（永久向量模型；缺失时自动只走词法）
    try {
      const vectors = await embedder.embed([text]);
      const queryVector = Array.isArray(vectors) && vectors[0] instanceof Float32Array ? vectors[0] : null;
      if (queryVector) {
        if (typeof store.searchRawVector === 'function') {
          const vecHits: RawVecHit[] = store.searchRawVector(queryVector, embedder.ref, { limit: searchLimit });
          vectorOk = Array.isArray(vecHits);
          for (const hit of vecHits) {
            const entry = ensure(hit.rawId);
            entry.vector = Math.max(0, Math.min(1, hit.score));
          }
        } else {
          logger.warn('recall(explicit): store.searchRawVector 不可用，降级为纯词法检索');
        }
      }
    } catch (err) {
      logger.warn(`recall(explicit): 查询嵌入失败（降级为纯词法检索）：${err instanceof Error ? err.message : String(err)}`);
    }

    if (!lexicalOk && !vectorOk) {
      logger.warn('recall(explicit): 原始层向量与词法检索均不可用，返回空结果');
      return [];
    }

    // ③ 取原始记录 + 三因子打分（docs/24 §3：.45/.35/.20，权重和为 1）
    const scored: RecallHit[] = [];
    for (const [rawId, candidate] of merged) {
      if (rawIdFilter !== null && !rawIdFilter.has(rawId)) continue; // 人格作用域过滤
      const raw = await loadRaw(rawId);
      if (!raw) continue;
      // 人格归属来自 raw_index（L0 行本身不写 persona_id；索引是检索元数据）
      let indexPersona: string | null | undefined;
      try {
        indexPersona = store.getRawIndex(rawId)?.personaId;
      } catch {
        indexPersona = undefined;
      }
      const rawWithPersona: RawRecord =
        raw.personaId === undefined || raw.personaId === null
          ? { ...raw, personaId: indexPersona ?? null }
          : raw;
      const components: RecallHit['components'] = {
        vector: Math.min(1, Math.max(0, candidate.vector)),
        lexical: Math.min(1, Math.max(0, candidate.lexical)),
        recency: rawRecency(rawWithPersona.ts, now),
        importance: 0,
      };
      const score =
        EXPLICIT_VECTOR_WEIGHT * components.vector +
        EXPLICIT_LEXICAL_WEIGHT * components.lexical +
        EXPLICIT_RECENCY_WEIGHT * components.recency;
      if (typeof query.minScore === 'number' && Number.isFinite(query.minScore) && score < query.minScore) continue;
      scored.push({
        layer: 'raw',
        raw: rawWithPersona,
        score,
        components,
        citations: [rawWithPersona.id],
      });
    }
    scored.sort((a, b) => b.score - a.score || ((a.raw?.id ?? '') < (b.raw?.id ?? '') ? -1 : 1));
    const hits = scored.slice(0, limit);
    logger.debug(
      `recall(explicit): q=${text.slice(0, 40)} rawCandidates=${merged.size} hits=${hits.length} lexicalOk=${lexicalOk} vectorOk=${vectorOk} latency=${Math.max(0, clock() - startedAt)}ms`,
    );
    return hits;
  }

  // -------------------------------------------------------------------------
  // 隐式检索（三层记忆；docs/20 §10.3 + docs/23 §4 既有行为）
  // -------------------------------------------------------------------------

  async function recallImplicit(query: RecallQuery, now: number): Promise<RecallHit[]> {
    const startedAt = now;
    const limit = clampLimit(query.limit, config.recall.toolDefaultLimit);
    const baseCandidateLimit = Math.max(limit, Math.min(config.recall.maxCandidates, Math.max(limit * 4, limit)));
    // 人格过滤在内存后置做（store 的 searchVector/searchLexical 不支持人格）→ 放大候选池
    const candidateLimit = personaFilterActive(query)
      ? Math.min(config.recall.maxCandidates * 2, baseCandidateLimit * 2)
      : baseCandidateLimit;
    const text = typeof query.text === 'string' ? query.text.trim() : '';
    const layers = query.layers && query.layers.length > 0 ? query.layers : undefined;
    const kinds = query.kinds && query.kinds.length > 0 ? query.kinds : undefined;
    const retentionFilter = resolveRetentionFilter(query);

    let candidates = await collectCandidates(query, text, candidateLimit, layers, kinds);
    if (candidates.size === 0) {
      // 空查询/无关键词/两路均无命中：退化为 recency+importance
      if (text.length === 0) candidates = fallbackCandidates(query, candidateLimit, layers, kinds, now);
    }

    // ③ 逐条补齐 recency/importance 并打分（含保留期过滤与先验）
    const scored: RecallHit[] = [];
    for (const [id, candidate] of candidates) {
      let memory: MemoryRecord | null = null;
      try {
        memory = store.getMemory(id);
      } catch {
        memory = null;
      }
      if (!memory) continue;
      if (!passesFilters(memory, query, now)) continue;
      if (!passesRetention(memory, retentionFilter)) continue;
      if (!personaMatches(memory, query)) continue;
      const importance = Math.min(1, Math.max(0, typeof memory.importance === 'number' ? memory.importance : 0));
      const components: RecallHit['components'] = {
        vector: Math.min(1, Math.max(0, candidate.vector)),
        lexical: Math.min(1, Math.max(0, candidate.lexical)),
        recency: recencyComponent(memory.updatedAt, now, config.recall.hybrid.halfLifeDays),
        importance,
      };
      const score = combineRecallScore(memory, components, config) * retentionPrior(memory);
      if (typeof query.minScore === 'number' && Number.isFinite(query.minScore) && score < query.minScore) continue;
      scored.push({
        layer: memory.layer,
        memory,
        score,
        components,
        citations: buildCitations(memory),
      });
    }

    // ④ 排序（score 降序，id 升序保证确定性）
    scored.sort((a, b) => b.score - a.score || (a.memory && b.memory ? (a.memory.id < b.memory.id ? -1 : 1) : 0));

    // ⑤ 近重复压制（结果内余弦 ≥ dedupSimilarity 只保留高分）
    const deduped = suppressNearDuplicates(scored);

    // ⑥ 可选 MMR 去冗余
    const reranked = config.recall.mmr.enabled ? applyMmr(deduped, limit) : deduped;

    // ⑦ 截断 + 治理字段 touch（recaller 只负责 access_count/heat；保留期由引擎 tick 晋升，此处不写）
    const finalHits = reranked.slice(0, limit);
    if (query.trackAccess !== false && finalHits.length > 0) {
      try {
        store.touchMemories(
          finalHits.map((hit) => (hit.memory ? hit.memory.id : '')).filter((id) => id.length > 0),
          now,
        );
      } catch (err) {
        logger.warn(`recall: touch 治理字段失败（不影响召回结果）：${err instanceof Error ? err.message : String(err)}`);
      }
    }

    logger.debug(
      `recall(implicit): q=${text.slice(0, 40)} candidates=${candidates.size} hits=${finalHits.length} retention=${retentionFilter ? [...retentionFilter].join('+') : 'all'} latency=${Math.max(0, clock() - startedAt)}ms`,
    );
    return finalHits;
  }

  /**
   * 召回入口（docs/24 §1 访问分工）：
   * - `mode='explicit'`（默认）：L0 原始层（永久原文/永久向量，不受遗忘影响）；
   * - `mode='implicit'`：三层记忆（prompt/自动召回；受遗忘影响）。
   */
  async function recall(query: RecallQuery): Promise<RecallHit[]> {
    const now = clock();
    if (!config.recall.enabled || !config.enabled) return [];
    const mode = query.mode ?? 'explicit';
    if (mode === 'explicit') return recallExplicit(query, now);
    return recallImplicit(query, now);
  }

  /** 近重复压制：按分数从高到低保留，与已保留命中余弦 ≥ 阈值则丢弃（同 contentHash 也视为重复） */
  function suppressNearDuplicates(hits: RecallHit[]): RecallHit[] {
    const threshold = config.recall.dedupSimilarity;
    if (!Number.isFinite(threshold) || threshold >= 1 || hits.length < 2) return hits;
    const kept: RecallHit[] = [];
    const keptVectors: Array<{ vector: Float32Array | null; contentHash: string | null }> = [];
    for (const hit of hits) {
      const memory = hit.memory;
      if (!memory) {
        kept.push(hit);
        continue;
      }
      const vector = getVector(memory.id);
      let duplicate = false;
      for (const keptEntry of keptVectors) {
        if (keptEntry.contentHash !== null && keptEntry.contentHash === memory.contentHash) {
          duplicate = true;
          break;
        }
        if (vector && keptEntry.vector && cosine(vector, keptEntry.vector) >= threshold) {
          duplicate = true;
          break;
        }
      }
      if (duplicate) continue;
      kept.push(hit);
      keptVectors.push({ vector, contentHash: memory.contentHash ?? null });
    }
    return kept;
  }

  /** MMR 去冗余（λ 由 recall.mmr.lambda 提供）：MMR = λ·score − (1−λ)·maxSim(已选) */
  function applyMmr(hits: RecallHit[], limit: number): RecallHit[] {
    if (hits.length <= 1) return hits;
    const lambda = Math.min(1, Math.max(0, config.recall.mmr.lambda));
    const vectors = new Map<string, Float32Array | null>();
    const vectorOf = (hit: RecallHit): Float32Array | null => {
      const id = hit.memory?.id ?? '';
      if (vectors.has(id)) return vectors.get(id) ?? null;
      const vector = getVector(id);
      vectors.set(id, vector);
      return vector;
    };
    const selected: RecallHit[] = [];
    const remaining = [...hits];
    const target = Math.max(1, Math.min(limit, hits.length));
    while (selected.length < target && remaining.length > 0) {
      let bestIndex = 0;
      let bestScore = Number.NEGATIVE_INFINITY;
      for (let index = 0; index < remaining.length; index += 1) {
        const candidate = remaining[index];
        let maxSimilarity = 0;
        for (const chosen of selected) {
          const similarity = cosine(vectorOf(candidate), vectorOf(chosen));
          if (similarity > maxSimilarity) maxSimilarity = similarity;
        }
        const mmr = lambda * candidate.score - (1 - lambda) * maxSimilarity;
        // 并列时保留原始顺序（已按 score 排序），保证确定性
        if (mmr > bestScore + 1e-12) {
          bestScore = mmr;
          bestIndex = index;
        }
      }
      selected.push(remaining[bestIndex]);
      remaining.splice(bestIndex, 1);
    }
    return selected;
  }

  async function buildPromptSection(promptOptions?: { budgetTokens?: number; now?: number }): Promise<string> {
    if (!config.enabled || !config.recall.enabled || !config.recall.injectSystemPrompt) return '';
    try {
      // 委托 src/prompt/section.ts：语义画像块（L3）+ 工作记忆块（L1，当前会话或最近 24h）
      return await promptBuilder.build(
        promptOptions?.budgetTokens !== undefined ? { budgetTokens: promptOptions.budgetTokens } : {},
      );
    } catch (err) {
      logger.warn(`recall: 构建记忆注入块失败（返回空块）：${err instanceof Error ? err.message : String(err)}`);
      return '';
    }
  }

  function formatHit(hit: RecallHit): string {
    const redact = config.safety.redactSecretsInDerived;
    const labels = hit.memory ? citationLabels(hit.memory) : hit.citations.map((id) => `[raw:${id}]`);
    const components = hit.components;
    const scoreLine = `score=${hit.score.toFixed(4)} (vector=${components.vector.toFixed(3)}, lexical=${components.lexical.toFixed(3)}, recency=${components.recency.toFixed(3)}, importance=${components.importance.toFixed(3)})`;
    if (hit.raw) {
      const text = maybeRedact(displayText(hit.raw.text ?? ''), redact).text;
      return [`[raw] ${hit.raw.kind} ${hit.raw.id} ${scoreLine}`, `  ${text}`, `  引用: ${labels.join(' ')}`].join('\n');
    }
    const memory = hit.memory;
    if (!memory) return `[${hit.layer}] ${scoreLine}`;
    const title = `[${memory.layer}] ${memory.kind} ${memory.id} ${scoreLine}`;
    const text = maybeRedact(displayText(memory.text), redact).text;
    const summary =
      typeof memory.summary === 'string' && memory.summary.length > 0 && memory.summary !== memory.text
        ? `\n  摘要: ${maybeRedact(displayText(memory.summary, 160), redact).text}`
        : '';
    return [title, `  ${text}${summary}`, `  引用: ${labels.join(' ')}`].join('\n');
  }

  return { recall, buildPromptSection, formatHit };
}

/** 便于测试/调试：内存中的 embedding ref 是否与 store 当前模型一致（仅比较 ref 字段） */
export function embeddingRefsEqual(a: EmbeddingRef | null | undefined, b: EmbeddingRef | null | undefined): boolean {
  if (!a || !b) return false;
  return a.model === b.model && a.dim === b.dim && a.version === b.version;
}

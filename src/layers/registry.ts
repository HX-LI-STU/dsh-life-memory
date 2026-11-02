// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hanxustu (dsh-life-memory)
/**
 * 层注册表 / 层运行器（docs/20 §4.5、§9.1、§9.7）。
 *
 * 职责：
 * 1. `LayerDefinition` 注册（内置 L1/L2/L3 + 任意扩展层），按 `dependsOn` 拓扑排序；
 * 2. **增量派生**：每层独立 `derive_cursors` 水位（raw seq），只处理水位之后的 raw，
 *    单批上限 `layers.maxBatchRaws`；批量嵌入；写回 `store.upsertMemory`；
 * 3. **重建**：L1/L2 物理清空该层 + 重放 L0；L3 走"代际归档 + 重新派生"
 *    （`clearLayer(layer,{archive:true})`，绝不物理删除语义历史）；
 * 4. 错误隔离：任何层失败只写入 `LayerRunResult.errors` 并记日志，**绝不向捕获路径抛错**。
 *
 * 层私有数据结构（L2 情节表 / L3 语义表）通过内部可选钩子 `writeSidecar` 在
 * **同一个 store.transaction** 内与 `upsertMemory` 一起写入，保证原子性。
 * 该钩子是对 `LayerDefinition` 的**层内扩展**（不修改 contracts.ts）。
 */
import type {
  DeriveContext,
  DeriveInput,
  Embedder,
  LayerDefinition,
  LayerId,
  LayerRunner,
  LayerRunResult,
  Logger,
  MemoryQuery,
  MemoryRecord,
  MemoryStore,
  MemoryVaultConfig,
  NewMemoryRecord,
  RawQuery,
  RawRecord,
} from '../core/contracts.ts';
import { MEMORY_ID_RE } from '../core/ids.ts';
import { maybeRedact } from '../tools/redact.ts';
import { L2_LAYER_ID, L3_LAYER_ID, clamp01, errorMessage, normalizeTags, sortRawsBySeq } from './util.ts';

/** 单条写回结果：派生层提交的候选 + store 落库后的完整记录 */
export interface LayerWriteItem {
  record: NewMemoryRecord;
  stored: MemoryRecord;
}

/** 私有表写回钩子可以补充的计数（例如 L3 取代旧记录的 updated） */
export interface LayerSidecarCounts {
  written?: number;
  updated?: number;
  skipped?: number;
}

/**
 * 层内部钩子（不属于公开契约；仅 src/layers 内使用）。
 * - `rebuildStrategy='archive'`：重建时不物理删除（L3 代际重建）；
 * - `onRebuildStart`：清空/归档后、重放 L0 前（L3 递增代际号）；
 * - `writeSidecar`：记录写回后写层私有表，运行在 store.transaction 内。
 */
export interface LayerInternalHooks {
  rebuildStrategy?: 'physical' | 'archive';
  onRebuildStart?(ctx: DeriveContext, info: { now: number; removed: number; archived: number }): void;
  writeSidecar?(
    ctx: DeriveContext,
    items: readonly LayerWriteItem[],
    input: DeriveInput,
  ): LayerSidecarCounts | void;
}

/** 内置层 + 扩展层：契约定义 + 层内钩子 */
export type InternalLayerDefinition = LayerDefinition & LayerInternalHooks;

/** 重建结果（在契约字段之外附加 archivedOld，docs/20 §9.7 要求报告归档旧代数量） */
export interface LayerRebuildResult extends LayerRunResult {
  /** L3 代际重建：被归档的旧记录数（不物理删除） */
  archivedOld?: number;
}

export interface LayerRunnerDeps {
  store: MemoryStore;
  embedder: Embedder;
  config: MemoryVaultConfig;
  logger: Logger;
  /** 读取 L0（窗口补齐/重建重放用）；不传时只能靠 DeriveInput.raws 增量派生 */
  readRaw?: (query?: RawQuery) => Promise<RawRecord[]>;
  /** 时钟注入（测试）；默认 Date.now */
  now?: () => number;
}

/** 层运行器（契约 LayerRunner + 内部辅助方法） */
export interface LayerRegistry extends LayerRunner {
  /** 取某层定义（不存在返回 undefined） */
  get(layer: LayerId): InternalLayerDefinition | undefined;
  /** 已注册层按依赖拓扑排序后的列表 */
  ordered(): InternalLayerDefinition[];
  /** 运行单个层（重建/测试用）；不抛错 */
  runLayer(def: InternalLayerDefinition, input: DeriveInput): Promise<LayerRunResult>;
  /** 重建某层（返回 archivedOld 计数；未知层/不可重建层抛错） */
  rebuild(layer: LayerId, options?: { batchSize?: number }): Promise<LayerRebuildResult>;
}

/** 单行派生文本上限（docs/20 §8.1：text ≤ 8 KB） */
const MAX_TEXT_CHARS = 8 * 1024;
/** 单层单次派生最多接受的候选记录数（防御扩展层异常输出） */
const MAX_RECORDS_PER_RUN = 10_000;
/** 重建时最多读取的批次数（防御 readRaw 异常导致死循环） */
const MAX_REBUILD_BATCHES = 100_000;

/** 创建层注册表（默认不注册任何层；内置层由 createMemoryRuntime 注册） */
export function createLayerRegistry(deps: LayerRunnerDeps): LayerRegistry {
  const { store, embedder, config, logger } = deps;
  const readRaw: (query?: RawQuery) => Promise<RawRecord[]> =
    deps.readRaw ??
    (async () => {
      throw new Error('[dsh-life-memory] layers: 未配置 readRaw，无法读取 L0（重建/窗口补齐不可用）');
    });
  const clock = deps.now ?? (() => Date.now());
  const definitions = new Map<LayerId, InternalLayerDefinition>();
  let orderedCache: InternalLayerDefinition[] | null = null;

  const makeContext = (now: number): DeriveContext => ({
    store,
    embedder,
    config,
    logger,
    readRaw,
    listLayerMemories: (layer: LayerId, query: MemoryQuery = {}) =>
      store.listMemories({ ...query, layers: [layer] }),
    now: () => now,
  });

  // -------------------------------------------------------------------------
  // 注册 / 排序
  // -------------------------------------------------------------------------

  function register(definition: LayerDefinition): void {
    if (!definition || typeof definition !== 'object') {
      throw new TypeError('[dsh-life-memory] layers.register: 层定义必须是对象');
    }
    if (typeof definition.id !== 'string' || definition.id.length === 0) {
      throw new TypeError('[dsh-life-memory] layers.register: 层 id 不能为空');
    }
    if (typeof definition.derive !== 'function') {
      throw new TypeError(`[dsh-life-memory] layers.register: 层 ${definition.id} 缺少 derive()`);
    }
    if (!Array.isArray(definition.dependsOn)) {
      throw new TypeError(`[dsh-life-memory] layers.register: 层 ${definition.id} 的 dependsOn 必须是数组`);
    }
    if (definitions.has(definition.id)) {
      logger.debug(`layers.register: 覆盖已注册层 ${definition.id}`);
    }
    definitions.set(definition.id, definition as InternalLayerDefinition);
    orderedCache = null;
  }

  function ordered(): InternalLayerDefinition[] {
    if (orderedCache !== null) return orderedCache;
    const ids = [...definitions.keys()].sort(compareId);
    const out: InternalLayerDefinition[] = [];
    const state = new Map<LayerId, 1 | 2>(); // 1=访问中 2=已完成
    const visit = (id: LayerId): void => {
      const status = state.get(id);
      if (status === 2) return;
      if (status === 1) {
        logger.warn(`layers: 检测到层依赖环（${id}），已跳过该依赖边`);
        return;
      }
      const def = definitions.get(id);
      if (!def) return;
      state.set(id, 1);
      for (const dep of def.dependsOn) {
        if (dep === id) {
          logger.warn(`layers: 层 ${id} 依赖自身，已忽略`);
          continue;
        }
        if (!definitions.has(dep)) {
          logger.warn(`layers: 层 ${id} 依赖未注册的层 ${dep}（按已就绪处理）`);
          continue;
        }
        visit(dep);
      }
      state.set(id, 2);
      out.push(def);
    };
    for (const id of ids) visit(id);
    orderedCache = out;
    return out;
  }

  // -------------------------------------------------------------------------
  // 增量：待处理 raw 收集
  // -------------------------------------------------------------------------

  /**
   * 收集某层待处理的 raw：
   * - 优先使用 DeriveInput 提供的 raws/pendingRaws 中 `seq > cursor` 的部分；
   * - 若提供的为空、或与水位不连续（崩溃补采），用 `readRaw({offset:cursor})` 从 L0 补齐；
   *   （raw seq 从 1 连续递增，故 offset 即水位游标，契约无 "seq after" 查询）
   */
  async function collectPending(layer: LayerId, cursor: number, input: DeriveInput): Promise<RawRecord[]> {
    const limit = Math.max(1, Math.floor(config.layers.maxBatchRaws));
    const provided = sortRawsBySeq((input.pendingRaws ?? input.raws ?? []).filter((raw) => raw.seq > cursor));
    const first = provided.length > 0 ? provided[0] : null;
    const needFill = provided.length === 0 || (first !== null && first.seq > cursor + 1);
    let pending = provided;
    if (needFill) {
      try {
        const fetched = await readRaw({ offset: Math.max(0, cursor), limit });
        const byId = new Map<string, RawRecord>();
        for (const raw of fetched) {
          if (raw.seq > cursor) byId.set(raw.id, raw);
        }
        for (const raw of provided) byId.set(raw.id, raw);
        pending = sortRawsBySeq([...byId.values()]);
      } catch (err) {
        logger.warn(`layers: 层 ${layer} 从 L0 补齐待处理 raw 失败（继续用增量入参）：${errorMessage(err)}`);
      }
    }
    return pending.slice(0, limit);
  }

  // -------------------------------------------------------------------------
  // 写回：校验/脱敏 → 批量嵌入 → 事务内 upsert + sidecar + 水位
  // -------------------------------------------------------------------------

  /** 校验并规范化层提交的候选记录（非法记录计入 skipped/errors，不中断整批） */
  function prepareRecords(
    def: InternalLayerDefinition,
    records: unknown,
    result: LayerRunResult,
  ): NewMemoryRecord[] {
    if (!Array.isArray(records)) {
      result.errors.push(`${def.id}: derive() 返回值不是数组`);
      logger.error(`layers: 层 ${def.id} 的 derive() 未返回数组`);
      return [];
    }
    const cap = Math.min(MAX_RECORDS_PER_RUN, Math.max(config.layers.maxBatchRaws * 4, 200));
    let list = records as NewMemoryRecord[];
    if (list.length > cap) {
      result.errors.push(`${def.id}: derive() 返回 ${list.length} 条候选，超过单次上限 ${cap}，已截断`);
      list = list.slice(0, cap);
    }
    const out: NewMemoryRecord[] = [];
    const requiresProvenance = def.id === 'L1' || def.id === 'L2' || def.id === 'L3';
    for (const raw of list) {
      if (!raw || typeof raw !== 'object') {
        result.skipped += 1;
        result.errors.push(`${def.id}: 候选记录不是对象，已跳过`);
        continue;
      }
      const text = typeof raw.text === 'string' ? raw.text : '';
      if (text.trim().length === 0) {
        result.skipped += 1;
        result.errors.push(`${def.id}: 候选记录 text 为空，已跳过`);
        continue;
      }
      if (typeof raw.kind !== 'string' || raw.kind.length === 0) {
        result.skipped += 1;
        result.errors.push(`${def.id}: 候选记录缺少 kind，已跳过`);
        continue;
      }
      if (raw.id !== undefined && (typeof raw.id !== 'string' || !MEMORY_ID_RE.test(raw.id))) {
        result.skipped += 1;
        result.errors.push(`${def.id}: 候选记录 id 非法（${String(raw.id)}），已跳过`);
        continue;
      }
      const meta = raw.meta && typeof raw.meta === 'object' ? { ...raw.meta } : {};
      const rawSourceIds = Array.isArray(raw.sourceRawIds)
        ? raw.sourceRawIds.filter((id): id is string => typeof id === 'string' && id.length > 0)
        : [];
      if (requiresProvenance && rawSourceIds.length === 0 && meta.sourcePolicy !== 'constructed') {
        result.skipped += 1;
        result.errors.push(`${def.id}: 候选记录缺少 sourceRawIds（溯源强制），已跳过`);
        continue;
      }
      const record: NewMemoryRecord = {
        ...raw,
        layer: def.id,
        text,
        sourceRawIds: rawSourceIds,
        importance: typeof raw.importance === 'number' ? clamp01(raw.importance) : undefined,
        confidence: typeof raw.confidence === 'number' ? clamp01(raw.confidence) : undefined,
        tags: normalizeTags(raw.tags),
        meta,
      };
      if (typeof record.createdAt !== 'number' || !Number.isFinite(record.createdAt)) delete record.createdAt;
      if (typeof record.createdSeq !== 'number' || !Number.isFinite(record.createdSeq)) delete record.createdSeq;
      // text 上限（docs §8.1 ≤8KB）：超出截断并标记（原文仍可从 sourceRawIds 追溯）
      if (record.text.length > MAX_TEXT_CHARS) {
        record.text = record.text.slice(0, MAX_TEXT_CHARS);
        record.meta = { ...meta, truncated: true };
      }
      // 派生层脱敏（docs §13.1；L0 原始层永不脱敏，只在此处处理派生文本）
      if (config.safety.redactSecretsInDerived) {
        const redacted = maybeRedact(record.text, true);
        record.text = redacted.text;
        if (typeof record.summary === 'string' && record.summary.length > 0) {
          record.summary = maybeRedact(record.summary, true).text;
        }
        if (redacted.hits.length > 0) {
          record.meta = { ...(record.meta ?? {}), redacted: redacted.hits };
        }
      }
      out.push(record);
    }
    return out;
  }

  /** 批量嵌入（按 embedding.batchSize 分组；失败只记 error，记录仍写入——向量可后补） */
  async function embedRecords(
    def: InternalLayerDefinition,
    records: readonly NewMemoryRecord[],
    result: LayerRunResult,
  ): Promise<Array<Float32Array | undefined>> {
    const out: Array<Float32Array | undefined> = new Array(records.length).fill(undefined);
    if (records.length === 0) return out;
    const batchSize = Math.max(1, Math.min(config.embedding.batchSize ?? 32, 512));
    // 相同文本只嵌入一次（同一批内可能有重复内容）
    const indexByText = new Map<string, number[]>();
    records.forEach((record, index) => {
      const list = indexByText.get(record.text);
      if (list) list.push(index);
      else indexByText.set(record.text, [index]);
    });
    const texts = [...indexByText.keys()];
    for (let start = 0; start < texts.length; start += batchSize) {
      const chunk = texts.slice(start, start + batchSize);
      try {
        const vectors = await embedder.embed(chunk);
        if (!Array.isArray(vectors) || vectors.length !== chunk.length) {
          throw new Error(`embedding 返回数量不匹配（期望 ${chunk.length}，实际 ${Array.isArray(vectors) ? vectors.length : '非数组'}）`);
        }
        chunk.forEach((text, offset) => {
          const vector = vectors[offset];
          if (!(vector instanceof Float32Array)) return;
          for (const index of indexByText.get(text) ?? []) out[index] = vector;
        });
      } catch (err) {
        const message = `embedding 失败（记录仍写入，向量待补算）：${errorMessage(err)}`;
        result.errors.push(message);
        logger.warn(`layers: 层 ${def.id} ${message}`);
      }
    }
    return out;
  }

  /**
   * 派生 + 写回（不负责收集 raw / 水位前的校验；内部兜错，不抛出）。
   * @param cursorAdvance 写回成功后要推进到的 raw seq（null 表示不推进水位）
   */
  async function deriveAndWrite(
    def: InternalLayerDefinition,
    input: DeriveInput,
    ctx: DeriveContext,
    result: LayerRunResult,
    cursorAdvance: number | null,
  ): Promise<void> {
    try {
      const candidates = await def.derive(input, ctx);
      const records = prepareRecords(def, candidates, result);
      const vectors = await embedRecords(def, records, result);
      const counts = { written: 0, updated: 0, skipped: 0 };
      store.transaction(() => {
        const items: LayerWriteItem[] = [];
        for (let index = 0; index < records.length; index += 1) {
          const record = records[index];
          const existing = typeof record.id === 'string' ? store.getMemory(record.id) : null;
          const stored = store.upsertMemory(record, vectors[index]);
          if (existing) counts.updated += 1;
          else if (typeof record.id === 'string' && stored.id !== record.id) counts.skipped += 1;
          else counts.written += 1;
          items.push({ record, stored });
        }
        if (def.writeSidecar) {
          const extra = def.writeSidecar(ctx, items, input) ?? {};
          counts.written += extra.written ?? 0;
          counts.updated += extra.updated ?? 0;
          counts.skipped += extra.skipped ?? 0;
        }
        if (cursorAdvance !== null && cursorAdvance > 0) store.setDeriveCursor(def.id, cursorAdvance);
      });
      result.written += counts.written;
      result.updated += counts.updated;
      result.skipped += counts.skipped;
    } catch (err) {
      const message = `层 ${def.id} 派生/写回失败：${errorMessage(err)}`;
      result.errors.push(message);
      logger.error(`layers: ${message}`);
    }
  }

  // -------------------------------------------------------------------------
  // 增量运行
  // -------------------------------------------------------------------------

  function resolveTargets(requested?: LayerId[]): InternalLayerDefinition[] {
    const all = ordered();
    const selected = new Set<LayerId>();
    const roots = requested && requested.length > 0 ? requested : config.layers.enabled;
    for (const id of roots) {
      if (!definitions.has(id)) {
        logger.warn(`layers.run: 未注册的层 ${id}，已忽略`);
        continue;
      }
      selected.add(id);
    }
    // 自动补依赖（依赖层必须先在本次运行中处理，保证 derive 时已就绪）
    let changed = true;
    while (changed) {
      changed = false;
      for (const id of [...selected]) {
        const def = definitions.get(id);
        if (!def) continue;
        for (const dep of def.dependsOn) {
          if (!selected.has(dep) && definitions.has(dep)) {
            selected.add(dep);
            changed = true;
          }
        }
      }
    }
    return all.filter((def) => selected.has(def.id) && def.enabled(config));
  }

  async function runLayer(def: InternalLayerDefinition, input: DeriveInput): Promise<LayerRunResult> {
    const started = clock();
    const now = typeof input.now === 'number' && Number.isFinite(input.now) ? input.now : clock();
    const result: LayerRunResult = {
      layer: def.id,
      written: 0,
      updated: 0,
      skipped: 0,
      errors: [],
      durationMs: 0,
    };
    try {
      if (!def.enabled(config)) return result;
      const ctx = makeContext(now);
      const cursor = store.getDeriveCursor(def.id);
      const pending = await collectPending(def.id, cursor, input);
      const deriveInput: DeriveInput = {
        raws: pending,
        pendingRaws: pending,
        reason: input.reason,
        ...(input.sessionId !== undefined ? { sessionId: input.sessionId } : {}),
        now,
      };
      const cursorAdvance = pending.length > 0 ? pending[pending.length - 1].seq : null;
      await deriveAndWrite(def, deriveInput, ctx, result, cursorAdvance);
    } catch (err) {
      const message = `层 ${def.id} 运行失败：${errorMessage(err)}`;
      result.errors.push(message);
      logger.error(`layers: ${message}`);
    }
    result.durationMs = Math.max(0, clock() - started);
    return result;
  }

  async function run(input: DeriveInput, layers?: LayerId[]): Promise<LayerRunResult[]> {
    const targets = resolveTargets(layers);
    const results: LayerRunResult[] = [];
    const now = typeof input.now === 'number' && Number.isFinite(input.now) ? input.now : clock();
    const normalized: DeriveInput = {
      raws: Array.isArray(input.raws) ? input.raws : [],
      ...(Array.isArray(input.pendingRaws) ? { pendingRaws: input.pendingRaws } : {}),
      reason: input.reason,
      ...(input.sessionId !== undefined ? { sessionId: input.sessionId } : {}),
      now,
    };
    for (const def of targets) {
      // 逐层串行：依赖层先完成（拓扑序已保证）；单层失败不影响后续层
      results.push(await runLayer(def, normalized));
    }
    return results;
  }

  // -------------------------------------------------------------------------
  // 重建（docs/20 §9.7）
  // -------------------------------------------------------------------------

  async function latestRawSeq(): Promise<number> {
    try {
      const raws = await readRaw({ limit: 1, desc: true });
      if (Array.isArray(raws) && raws.length > 0) return raws[0].seq;
    } catch (err) {
      logger.warn(`layers: 查询 L0 最大 seq 失败：${errorMessage(err)}`);
    }
    return 0;
  }

  async function rebuild(layer: LayerId, options: { batchSize?: number } = {}): Promise<LayerRebuildResult> {
    const def = definitions.get(layer);
    if (!def) throw new Error(`[dsh-life-memory] layers.rebuild: 未知层 ${layer}`);
    if (def.rebuildableFromRaw === false) {
      throw new Error(`[dsh-life-memory] layers.rebuild: 层 ${layer} 声明不可从 L0 重建（rebuildableFromRaw=false）`);
    }
    const started = clock();
    const now = clock();
    const result: LayerRebuildResult = {
      layer,
      written: 0,
      updated: 0,
      skipped: 0,
      errors: [],
      durationMs: 0,
    };
    try {
      const archive = def.rebuildStrategy === 'archive';
      const cleared = store.clearLayer(layer, archive ? { archive: true, now } : { now });
      if (archive) {
        result.archivedOld = cleared.archived;
        logger.info(`layers.rebuild: 层 ${layer} 代际归档 ${cleared.archived} 条旧记录（不物理删除）`);
      } else {
        logger.info(`layers.rebuild: 层 ${layer} 物理清空 ${cleared.removed} 条派生记录（L0 不受影响）`);
      }
      const ctx = makeContext(now);
      def.onRebuildStart?.(ctx, { now, removed: cleared.removed, archived: cleared.archived });

      if (layer === L2_LAYER_ID) {
        // L2 的输入是 L1 原子（不是 raw）：清空后一次重跑即可扫全部会话窗口
        const latest = await latestRawSeq();
        await deriveAndWrite(def, { raws: [], pendingRaws: [], reason: 'rebuild', now }, ctx, result, latest > 0 ? latest : null);
      } else {
        // L1/L3/扩展层：按 seq 分页重放 L0（确定性抽取器版本不变时结果逐字节一致）
        const batchSize = Math.max(
          1,
          Math.min(options.batchSize ?? config.layers.maxBatchRaws, config.layers.maxBatchRaws),
        );
        let offset = 0;
        for (let batch = 0; batch < MAX_REBUILD_BATCHES; batch += 1) {
          let raws: RawRecord[];
          try {
            raws = await readRaw({ offset, limit: batchSize });
          } catch (err) {
            result.errors.push(`读取 L0 失败：${errorMessage(err)}`);
            logger.error(`layers.rebuild: 层 ${layer} 读取 L0 失败：${errorMessage(err)}`);
            break;
          }
          if (!Array.isArray(raws) || raws.length === 0) break;
          const batchRaws = sortRawsBySeq(raws).slice(0, batchSize);
          const cursorAdvance = batchRaws[batchRaws.length - 1].seq;
          await deriveAndWrite(
            def,
            { raws: batchRaws, pendingRaws: batchRaws, reason: 'rebuild', now },
            ctx,
            result,
            cursorAdvance,
          );
          offset += batchRaws.length;
          if (batchRaws.length < batchSize) break;
        }
      }
    } catch (err) {
      const message = `层 ${layer} 重建失败：${errorMessage(err)}`;
      result.errors.push(message);
      logger.error(`layers.rebuild: ${message}`);
    }
    result.durationMs = Math.max(0, clock() - started);
    return result;
  }

  return {
    register,
    list: () => ordered(),
    run,
    rebuild,
    get: (layer: LayerId) => definitions.get(layer),
    ordered,
    runLayer,
  };
}

function compareId(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/** 便于测试/扩展层复用：内置层 id 常量（与 util.ts 同一来源） */
export { L2_LAYER_ID, L3_LAYER_ID };

// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hanxustu (dsh-life-memory)
/**
 * L3 语义记忆层：确定性 cue 模式抽取（docs/20 §9.2.2）+ canonical_key 归一化、
 * SPO、有效期/取代链（§8.4），以及 `memory_save` 显式保存入口 `saveExplicit`。
 *
 * 抽取器（全部无 LLM、可单测）：
 * - 来源门禁（v2）：自动抽取只接受**用户消息**与**显式 memory_save note**
 *   （`candidateSourceOf` / `extractCandidatesFromRaw`）；assistant / tool_call /
 *   tool_result / system / turn 等会话流水一律不抽，防止工具输出与代码片段被写成"事实"。
 * - `zh-preference` / `en-preference` → preference（canonical `user.pref.*`）
 * - `zh-decision` / `en-decision` → decision（canonical `project.*`）
 * - `zh-profile` / `en-profile` → profile（canonical `user.profile.*`）
 * - `remember` → 按片段判定 preference/decision/fact（conf 0.95 / imp 0.95）；
 *   fact 还必须通过事实句式门禁（`isFactSentence`），宁缺毋滥。
 * - `meta-workspace` → git remote / package name/version / 路径 / 端口（fact）；
 *   **自动派生已不再启用**（仅显式调用方可用），避免包名/端口/路径等伪事实。
 *
 * 规则通用约束（docs §9.2.2）：
 * - 触发词之后到最近标点（`。！？；\n` 或 `. ; ! ?`）为片段，清理前缀冒号/是/为；
 * - 片段 2–120 字符才产出；单条 raw 最多 3 条候选；`meta.quote` 保存片段原文；
 * - 候选整句 6–500 字符，且必须通过噪声过滤（`isNoisyCandidate`：代码围栏 /
 *   代码特征 / URL 单独成句 / 纯路径 / 纯数字 / 工具标记）；疑问句不抽；
 * - 所有候选必须带 `sourceRawIds` 溯源。
 *
 * 去重/取代（docs §8.4）：
 * - 同 `canonical_key`（object 相同）→ 重述（复用原 id，store 负责 revision++/来源合并）；
 * - 同 `<subject>.<predicate>`（维度相同、object 不同）→ 取代：旧记录 `valid_to=now-1`
 *   + `superseded_by` 写私有表（不删除），新记录 `supersedes=[旧 id]`；
 * - 私用表 `layer_l3_semantic` 通过 `writeSidecar` 与记录写回同一事务。
 *
 * 重建（docs §9.7）：L3 不物理删除，采用代际重建；代际号存 `meta.l3.rebuildGeneration`，
 * 新代记录 id 携带代际号，旧代保留为 archived（见 registry.rebuild）。
 */
import { createHash } from 'node:crypto';
import type {
  DeriveContext,
  DeriveInput,
  L3SemanticRow,
  L3SemanticRow as L3Row,
  MemoryKind,
  MemoryRecord,
  NewMemoryRecord,
  RawIndexRow,
  RawRecord,
} from '../core/contracts.ts';
import type { SaveExplicitInput, SaveExplicitResult } from '../tools/handlers.ts';
import { contentHash as computeContentHash } from '../core/hash.ts';
import { deriveMemoryId } from '../core/ids.ts';
import { lowerLatin } from '../core/text.ts';
import { maybeRedact } from '../tools/redact.ts';
import type { InternalLayerDefinition, LayerWriteItem } from './registry.ts';
import {
  L2_LAYER_ID,
  L3_LAYER_ID,
  L3_REBUILD_GENERATION_KEY,
  clamp01,
  errorMessage,
  firstChars,
  normalizeDerivedText,
  normalizeTags,
  sortRawsBySeq,
} from './util.ts';

/** 抽取器版本（规则变更需递增；docs §9.2.2 `meta.extractedBy='rule:<id>@<version>'`） */
export const L3_EXTRACTOR_VERSION = 2;

/** L3 语义类别（与 layer_l3_semantic.category CHECK 一致） */
export type L3Category = 'fact' | 'preference' | 'decision' | 'profile';

/** 单条 raw 最多产出的 L3 候选数（docs §9.2.2） */
export const L3_MAX_CANDIDATES_PER_RAW = 3;
/** 片段长度上下限（docs §9.2.2） */
export const L3_SEGMENT_MIN = 2;
export const L3_SEGMENT_MAX = 120;
/** 候选整句长度上下限（v2 噪声过滤：过短无信息、过长多为日志/代码） */
export const L3_CANDIDATE_MIN = 6;
export const L3_CANDIDATE_MAX = 500;

const CATEGORY_KINDS: ReadonlySet<string> = new Set(['fact', 'preference', 'decision', 'profile']);

/** MemoryKind → layer_l3_semantic.category（非四类时归入 fact） */
export function categoryOfKind(kind: MemoryKind | string): L3Category {
  return CATEGORY_KINDS.has(kind) ? (kind as L3Category) : 'fact';
}

/** 类别基线重要度（docs §9.3 base(kind)：fact 0.55 / preference 0.70 / decision 0.85 / profile 0.75） */
export function baseImportanceOfKind(kind: MemoryKind | string): number {
  switch (kind) {
    case 'decision':
      return 0.85;
    case 'profile':
      return 0.75;
    case 'preference':
      return 0.7;
    default:
      return 0.55;
  }
}

// ---------------------------------------------------------------------------
// 候选来源门禁（v2）：只保留可靠的自动抽取来源
// ---------------------------------------------------------------------------

/** 可作为 L3 自动抽取来源的 raw 类型 */
export type L3CandidateSource = 'user' | 'memory_save';

/** 来源判定所需的最小 raw 形状（RawRecord / RawIndexRow 都兼容） */
export interface CandidateSourceLike {
  kind?: string | null;
  role?: string | null;
  text?: string | null;
  payload?: unknown;
}

/** 明确排除的会话流水（即使 role 被写成 user 也不抽取） */
const NON_CANDIDATE_KINDS: ReadonlySet<string> = new Set([
  'assistant',
  'tool_call',
  'tool_result',
  'system',
  'turn',
  'session',
  'compaction',
  'event',
]);

/** 把 raw.payload 安全视为对象（兼容已落盘的 JSON 字符串） */
export function payloadRecordOf(payload: unknown): Record<string, unknown> | null {
  if (typeof payload === 'string') {
    const trimmed = payload.trim();
    if (!trimmed.startsWith('{')) return null;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : null;
    } catch {
      return null;
    }
  }
  return typeof payload === 'object' && payload !== null && !Array.isArray(payload)
    ? (payload as Record<string, unknown>)
    : null;
}

/** 是否显式保存（memory_save）写入的 L0 note：kind=note 且 payload.source=memory_save */
export function isExplicitSaveRaw(raw: CandidateSourceLike | null | undefined): boolean {
  if (!raw || raw.kind !== 'note') return false;
  const payload = payloadRecordOf(raw.payload);
  return payload !== null && payload.source === 'memory_save';
}

/**
 * 自动抽取来源判定（纯函数；v2 收紧）：
 * - `user`：用户消息（kind=user 或 role=user），但 assistant/tool_call/tool_result/system/turn 等流水优先排除；
 * - `memory_save`：显式保存写入的 note（kind=note 且 payload.source=memory_save）；
 * - 其它（assistant/tool_call/tool_result/system/turn/session/compaction/event/普通 note）→ null。
 *
 * 注意：memory_save 的 sessionId 自 v1.0.2 起是当前会话，**不能**再用 sessionId 判定来源。
 */
export function candidateSourceOf(raw: CandidateSourceLike | null | undefined): L3CandidateSource | null {
  if (!raw) return null;
  const kind = typeof raw.kind === 'string' ? raw.kind : '';
  if (isExplicitSaveRaw(raw)) return 'memory_save';
  if (NON_CANDIDATE_KINDS.has(kind)) return null;
  if (kind === 'user' || raw.role === 'user') return 'user';
  return null;
}

/** 是否属于可信自动抽取来源（`user` / `memory_save`） */
export function isCandidateSource(raw: CandidateSourceLike | null | undefined): boolean {
  return candidateSourceOf(raw) !== null;
}

// ---------------------------------------------------------------------------
// 噪声过滤（v2）：代码 / 日志 / URL / 路径 / 纯数字一律不抽
// ---------------------------------------------------------------------------

/** markdown 代码围栏 */
const CODE_FENCE_RE = /```/;
/** 代码特征（含 latin 关键字、赋值/箭头/逻辑运算、括号/引号外露的模板符号） */
const CODE_FEATURE_RE =
  /(?:^|[^\p{L}\p{N}_])(?:function|import|const|let|var|class|export|def|lambda)\s|[=!<>]=|=>|\+\+|&&|\|\||\/\*|\*\/|[{}`|]|\b(?:if|for|while|switch)\s*\(/iu;
/** 单独成句的 URL（允许一层包裹符号与句末标点） */
const URL_ONLY_RE = /^[(\[<"'（【《]*?(?:(?:https?|ftp|file):\/\/|www\.)\S+[)\]>"'）】》]*?[。.!！?？,，;；]?$/iu;
/** 纯路径（Windows / UNC / posix / 相对路径 / home 路径） */
const PATH_ONLY_RE = /^(?:[A-Za-z]:[\\/]|\\\\|\/|\.{1,2}[\\/]|~[\\/])[\p{L}\p{N}\s._\-\\/@%+~:#]*$/u;
/** 纯数字/纯符号（无任何语义） */
const NUMBER_ONLY_RE = /^[\d\s.,:%+\-()（）]+$/u;
/** 工具流水标记（捕获端/文本回显里常见） */
const TOOL_MARKER_RE = /\[(?:tool_call|tool_result)\]/i;

export interface CandidateNoiseOptions {
  /** 最短长度（默认 L3_CANDIDATE_MIN；行级噪声检查可传 0） */
  minLength?: number;
  /** 最长长度（默认 L3_CANDIDATE_MAX；行级噪声检查可传 MAX_SAFE_INTEGER） */
  maxLength?: number;
}

/**
 * 是否为明显噪声候选（纯函数，确定性；宁缺毋滥）：
 * - 长度不在 `[minLength, maxLength]`（默认 6–500）；
 * - 含代码围栏 ``` 或代码特征（function/import/const/=>/class 等）；
 * - URL 单独成句、纯路径、纯数字/纯符号；
 * - 含 `[tool_call]` / `[tool_result]` 标记。
 */
export function isNoisyCandidate(text: string, options: CandidateNoiseOptions = {}): boolean {
  if (typeof text !== 'string') return true;
  const value = normalizeDerivedText(text);
  const min = options.minLength ?? L3_CANDIDATE_MIN;
  const max = options.maxLength ?? L3_CANDIDATE_MAX;
  if (value.length === 0 || value.length < min || value.length > max) return true;
  if (CODE_FENCE_RE.test(value) || TOOL_MARKER_RE.test(value)) return true;
  if (CODE_FEATURE_RE.test(value)) return true;
  if (URL_ONLY_RE.test(value)) return true;
  if (PATH_ONLY_RE.test(value)) return true;
  if (NUMBER_ONLY_RE.test(value) && /\d/.test(value)) return true;
  return false;
}

// ---------------------------------------------------------------------------
// canonical_key / SPO 归一化（docs §9.2.2 / §8.4）
// ---------------------------------------------------------------------------

/**
 * 对象归一化（docs §9.2.2 伪代码，逐条实现）：
 * NFKC → 拉丁小写 → 去尾标点 → 折叠空白 → 超 24 字符时截断 + sha1 前 8 位 →
 * 非 `[\p{L}\p{N}._-]` 替换为 `_` → 折叠下划线/去首尾。
 */
export function normalizeObject(input: string): string {
  if (typeof input !== 'string' || input.length === 0) return 'unknown';
  let value = input.normalize('NFKC');
  value = lowerLatin(value).trim();
  value = value.replace(/[。．.！!?？;；,，、]+$/g, '').replace(/\s+/g, ' ');
  if (value.length > 24) {
    const digest = createHash('sha1').update(value, 'utf8').digest('hex').slice(0, 8);
    value = `${value.slice(0, 24)}_${digest}`;
  }
  value = value
    .replace(/[^\p{L}\p{N}._-]+/gu, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '');
  return value.length > 0 ? value : 'unknown';
}

/** 维度词典：按顺序匹配，先命中者胜（确定性；与 docs 示例 'pref.theme'/'vector.dim'/'deploy.target' 对齐） */
const DIMENSION_LEXICON: ReadonlyArray<{ dimension: string; keywords: readonly string[] }> = [
  { dimension: 'vector.dim', keywords: ['向量维度', '嵌入维度', '维度', 'dimension', 'dim', '向量', 'embedding', 'vector'] },
  { dimension: 'theme', keywords: ['主题', '深色', '浅色', '暗色', 'dark', 'light', 'theme', '配色', '外观', '界面'] },
  { dimension: 'language', keywords: ['语言', '中文', '英文', 'chinese', 'english', 'language'] },
  { dimension: 'comment.style', keywords: ['注释', 'comment', 'docstring'] },
  { dimension: 'port', keywords: ['端口', 'port'] },
  { dimension: 'editor', keywords: ['编辑器', 'editor', 'vscode', 'vim', 'neovim', 'emacs'] },
  { dimension: 'framework', keywords: ['框架', 'framework', 'react', 'vue', 'svelte', 'angular'] },
  { dimension: 'database', keywords: ['数据库', 'database', 'sqlite', 'postgres', 'mysql', 'redis'] },
  { dimension: 'package.manager', keywords: ['包管理', 'package manager', 'npm', 'pnpm', 'yarn', 'bun', '依赖'] },
  { dimension: 'test', keywords: ['测试', 'test', 'jest', 'vitest', 'mocha', 'pytest'] },
  { dimension: 'deploy.target', keywords: ['部署', 'deploy', '发布', 'release', '上线'] },
  { dimension: 'format', keywords: ['格式', 'format', 'esm', 'commonjs', 'typescript', 'javascript'] },
  { dimension: 'naming', keywords: ['命名', 'naming'] },
  { dimension: 'indent', keywords: ['缩进', 'indent'] },
  { dimension: 'commit.style', keywords: ['提交', 'commit'] },
  { dimension: 'model', keywords: ['模型', 'model', 'deepseek', 'gpt', 'llm'] },
  { dimension: 'api', keywords: ['接口', 'api', 'rest', 'graphql'] },
  { dimension: 'error.handling', keywords: ['错误处理', '异常', 'error'] },
  { dimension: 'logging', keywords: ['日志', 'log', 'logging'] },
  { dimension: 'performance', keywords: ['性能', 'performance', '优化'] },
  { dimension: 'security', keywords: ['安全', 'security', '密钥', 'secret'] },
] as const;

/** 该维度是否以"数值"为对象（decision/fact 时优先抽取数字，如 'project.vector.dim=512'） */
const NUMERIC_DIMENSIONS: ReadonlySet<string> = new Set(['vector.dim', 'port']);

/** 关键词是否出现（拉丁短词用词边界，避免 'ui' 命中 'build'） */
function containsKeyword(haystack: string, keyword: string): boolean {
  if (keyword.length === 0) return false;
  if (/^[a-z0-9._-]+$/.test(keyword)) {
    const pattern = new RegExp(`(?:^|[^a-z0-9])${keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:$|[^a-z0-9])`);
    return pattern.test(haystack);
  }
  return haystack.includes(keyword);
}

/** 识别片段主题维度（无命中返回 null） */
export function detectDimension(segment: string): string | null {
  const haystack = lowerLatin(normalizeDerivedText(segment));
  if (haystack.length === 0) return null;
  for (const entry of DIMENSION_LEXICON) {
    for (const keyword of entry.keywords) {
      if (containsKeyword(haystack, keyword)) return entry.dimension;
    }
  }
  return null;
}

/** 兜底谓词 slug：取片段首个 CJK 连续段前 2 字，或首个 ≥2 字符拉丁词 */
function fallbackSlug(segment: string): string {
  const normalized = normalizeDerivedText(segment).normalize('NFKC');
  const cjk = normalized.match(/[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]{2,}/u);
  if (cjk) return normalizeObject(cjk[0].slice(0, 2));
  const words = lowerLatin(normalized).match(/[\p{L}\p{N}]+/gu) ?? [];
  const word = words.find((item) => item.length >= 2) ?? words[0];
  return normalizeObject(word ?? 'general');
}

/** 画像维度（名字/所在地/职业/其它） */
function profileDimension(segment: string): string {
  if (/名字|叫我|name\s+is|call\s+me/i.test(segment)) return 'name';
  if (/住|live\s+in|based\s+in|所在地|城市/i.test(segment)) return 'location';
  if (/工作|职业|work\s+as|工程师|开发|设计|产品|role/i.test(segment)) return 'role';
  return detectDimension(segment) ?? fallbackSlug(segment);
}

export interface SpoTriple {
  subject: string;
  predicate: string;
  object: string;
  canonicalKey: string;
  dimension: string;
}

/**
 * 构造 SPO + canonical_key（docs §9.2.2）：
 * - preference → `user.pref.<dim>=<object>`；
 * - decision → `project.<dim 或 decision.slug>=<object>`（含点维度直接作谓词，如 vector.dim）；
 * - profile → `user.profile.<name|location|role|slug>=<object>`；
 * - fact → `<user|project>.fact.<dim|slug>=<object>`。
 */
export function buildSpo(input: {
  kind: L3Category;
  segment: string;
  subjectOverride?: string;
  dimensionOverride?: string;
}): SpoTriple {
  const segment = normalizeDerivedText(input.segment);
  const dimension = input.dimensionOverride ?? (input.kind === 'profile' ? profileDimension(segment) : detectDimension(segment)) ?? fallbackSlug(segment);
  let subject: string;
  switch (input.kind) {
    case 'preference':
    case 'profile':
      subject = 'user';
      break;
    case 'decision':
      subject = 'project';
      break;
    default:
      subject = input.subjectOverride ?? (/(?:^|\s)我|我的|我的|i\s|my\s/i.test(segment) ? 'user' : 'project');
      break;
  }
  if (input.subjectOverride) subject = input.subjectOverride;
  let predicate: string;
  if (input.kind === 'preference') predicate = `pref.${dimension}`;
  else if (input.kind === 'profile') predicate = `profile.${dimension}`;
  else if (input.kind === 'decision') predicate = dimension.includes('.') ? dimension : `decision.${dimension}`;
  else predicate = `fact.${dimension}`;
  let object: string;
  if ((input.kind === 'decision' || input.kind === 'fact') && NUMERIC_DIMENSIONS.has(dimension)) {
    const numeric = segment.match(/(\d+(?:\.\d+)?)/);
    object = numeric ? normalizeObject(numeric[1]) : normalizeObject(segment);
  } else {
    object = normalizeObject(segment);
  }
  return { subject, predicate, object, canonicalKey: `${subject}.${predicate}=${object}`, dimension };
}

/** 把 `subject.predicate=object` 拆成结构（非法输入返回 null） */
export function parseCanonicalKey(key: string): { subject: string; predicate: string; object: string } | null {
  if (typeof key !== 'string') return null;
  const eq = key.indexOf('=');
  if (eq <= 0) return null;
  const left = key.slice(0, eq);
  const dot = left.indexOf('.');
  if (dot <= 0) return null;
  const subject = left.slice(0, dot).trim();
  const predicate = left.slice(dot + 1).trim();
  const object = key.slice(eq + 1).trim();
  if (subject.length === 0 || predicate.length === 0 || object.length === 0) return null;
  return { subject, predicate, object };
}

/** 由 canonical_key 取"维度键"（`user.pref.theme=dark` → `user.pref.theme`，用于取代判定） */
export function dimensionKeyOf(canonicalKey: string): string | null {
  const eq = canonicalKey.indexOf('=');
  return eq > 0 ? canonicalKey.slice(0, eq) : null;
}

// ---------------------------------------------------------------------------
// 触发词规则（docs §9.2.2 表，逐条实现；中/英并列）
// ---------------------------------------------------------------------------

interface CueRule {
  /** 规则 id（meta.extractedBy = `rule:<id>@1`） */
  id: string;
  lang: 'zh' | 'en';
  kind: L3Category;
  pattern: RegExp;
  confidence: number;
  importance: number;
  /** 该规则产出的 subject 覆盖（未指定则按 kind 默认） */
  subject?: string;
}

/** 偏好触发词（中） */
const ZH_PREFERENCE_RE =
  /我(?:更)?(?:喜欢|偏好|习惯|倾向于)|我不喜欢|以后(?:都|统一)(?:用|使用)|请(?:默认)?(?:用|使用)|默认(?:用|使用)|统一(?:用|使用)|别(?:再)?用|不要(?:再)?用|避免(?:用|使用)|希望(?:你)?(?:默认|以后|统一)?(?:用|使用)/g;
/** 偏好触发词（英） */
const EN_PREFERENCE_RE =
  /i\s+(?:prefer|like|always\s+use|usually\s+use)|always\s+use|please\s+(?:always\s+|default\s+to\s+)?use|from\s+now\s+on,?\s+(?:use|always)|don'?t\s+(?:use|ever\s+use)|never\s+use|avoid\s+using/gi;
/** 决策触发词（中） */
const ZH_DECISION_RE = /决定|确定(?:用|采用)|方案(?:是|定为)|结论(?:是|为)|就按|改为|改成|采用|选择|最终(?:用|定为)/g;
/** 决策触发词（英） */
const EN_DECISION_RE =
  /we\s+decided|we['’]ll\s+go\s+with|let'?s\s+(?:use|go\s+with)|final\s+decision|conclusion|we\s+chose|going\s+with|adopt/gi;
/** 画像触发词（中） */
const ZH_PROFILE_RE = /我是|我的名字|叫我|我在.{0,12}工作|我(?:是|做).{0,8}(?:工程师|开发|设计|产品)|我住|我的职业/g;
/** 画像触发词（英） */
const EN_PROFILE_RE = /my\s+name\s+is|call\s+me|i['’]m\s+a|i\s+work\s+as|i\s+live\s+in|i['’]m\s+based\s+in/gi;
/** 显式记忆触发词（中英） */
const REMEMBER_RE =
  /记住|请记住|记录一下|别忘了|保存到记忆|备忘|重要[:：]|remember\s+(?:that\s+)?|note\s+(?:that\s+)?|don'?t\s+forget|keep\s+in\s+mind|save\s+(?:this|that)/gi;

const CUE_RULES: readonly CueRule[] = [
  { id: 'zh-preference', lang: 'zh', kind: 'preference', pattern: ZH_PREFERENCE_RE, confidence: 0.75, importance: 0.7 },
  { id: 'en-preference', lang: 'en', kind: 'preference', pattern: EN_PREFERENCE_RE, confidence: 0.75, importance: 0.7 },
  { id: 'zh-decision', lang: 'zh', kind: 'decision', pattern: ZH_DECISION_RE, confidence: 0.8, importance: 0.85 },
  { id: 'en-decision', lang: 'en', kind: 'decision', pattern: EN_DECISION_RE, confidence: 0.8, importance: 0.85 },
  { id: 'zh-profile', lang: 'zh', kind: 'profile', pattern: ZH_PROFILE_RE, confidence: 0.8, importance: 0.8 },
  { id: 'en-profile', lang: 'en', kind: 'profile', pattern: EN_PROFILE_RE, confidence: 0.8, importance: 0.8 },
];

/** 片段结束标点（docs §9.2.2：`。！？；\n` 或 `. ; ! ?`） */
const SEGMENT_DELIMITER_RE = /[。！？；\n.;!?]/;
/** 片段起始需要清理的标点/连接词（'决定：xxx' / '我的名字是 xxx'） */
const SEGMENT_LEADING_RE = /^[\s:：,，、。.！!？?；;—\-]+/;
const SEGMENT_COPULA_RE = /^(?:是|为|叫|就是)\s*/;

/** 事实句式特征词（v2：fact 必须含其一且不是疑问句；宁缺毋滥） */
const FACT_SENTENCE_RE = /是|为|用|叫|住|在|有|支持|使用/;
/** 决策句式特征词（v2：与触发词表对齐，中英并列） */
const DECISION_SENTENCE_RE =
  /决定|以后|统一|必须|不要|禁止|改成|改为|采用|确定|方案|结论|就按|选择|最终|decided|decision|adopt|chose|go\s+with|must|never|always/i;

/** 是否事实句式（含事实特征词、且不含问号；纯函数） */
export function isFactSentence(text: string): boolean {
  const value = normalizeDerivedText(text);
  if (value.length === 0) return false;
  if (/[?？]/.test(value)) return false;
  return FACT_SENTENCE_RE.test(value);
}

/** 是否决策句式（含决策特征词；纯函数） */
export function isDecisionSentence(text: string): boolean {
  const value = normalizeDerivedText(text);
  return value.length > 0 && DECISION_SENTENCE_RE.test(value);
}

/** 片段细节：片段正文 + 结束符（结束符为 ?/？ 时按疑问句丢弃） */
interface SegmentDetail {
  segment: string;
  terminator: string;
}

/** 截取触发词之后的片段（到最近标点为止），返回清理后的片段与结束符 */
function extractSegmentDetailed(text: string, triggerEnd: number): SegmentDetail | null {
  if (triggerEnd >= text.length) return null;
  const rest = text.slice(triggerEnd);
  const delimiter = rest.search(SEGMENT_DELIMITER_RE);
  const raw = delimiter >= 0 ? rest.slice(0, delimiter) : rest;
  const terminator = delimiter >= 0 ? rest[delimiter] : '';
  const cleaned = raw.replace(SEGMENT_LEADING_RE, '').replace(SEGMENT_COPULA_RE, '').trim();
  if (cleaned.length < L3_SEGMENT_MIN || cleaned.length > L3_SEGMENT_MAX) return null;
  return { segment: cleaned, terminator };
}

/** 截取触发词之后的片段（到最近标点为止），返回清理后的片段 */
export function extractSegment(text: string, triggerEnd: number): string | null {
  return extractSegmentDetailed(text, triggerEnd)?.segment ?? null;
}

/** 候选（抽取器输出；sourceRawIds/createdSeq 由调用方补齐） */
export interface L3Candidate {
  ruleId: string;
  /** `rule:<id>@<version>`；显式保存回放为 `memory_save@1` */
  extractedBy: string;
  lang: 'zh' | 'en';
  kind: L3Category;
  /** 记录 kind（显式 memory_save 回放可保留 summary/custom；缺省 = kind） */
  recordKind?: MemoryKind;
  category: L3Category;
  confidence: number;
  importance: number;
  /** 人类可读主文本（如 `用户偏好：深色主题`） */
  text: string;
  summary: string;
  /** 原文片段（证据，docs §9.2.2 meta.quote） */
  quote: string;
  segment: string;
  canonicalKey: string;
  subject: string;
  predicate: string;
  object: string;
  dimension: string;
  /** 是否显式保存回放（写入 meta.sourceKind='manual'） */
  explicit?: boolean;
  /** 显式保存时的原始 tags（与 saveExplicit 的 tags 对齐） */
  explicitTags?: string[];
}

/** 人类可读标签（注入/工具输出用陈述句，非祈使句，docs §11.4） */
const KIND_LABEL: Record<L3Category, string> = {
  preference: '用户偏好',
  decision: '决定',
  profile: '用户画像',
  fact: '事实',
};

/** 由片段构造候选（内部共用） */
function makeCueCandidate(
  rule: CueRule,
  kind: L3Category,
  segment: string,
  dimensionOverride?: string,
): L3Candidate {
  const spo = buildSpo({
    kind,
    segment,
    subjectOverride: rule.subject,
    ...(dimensionOverride ? { dimensionOverride } : {}),
  });
  const text = `${KIND_LABEL[kind]}：${segment}`;
  return {
    ruleId: rule.id,
    extractedBy: `rule:${rule.id}@${L3_EXTRACTOR_VERSION}`,
    lang: rule.lang,
    kind,
    category: kind,
    confidence: rule.confidence,
    importance: kind === 'preference' || kind === 'decision' || kind === 'profile' ? rule.importance : baseImportanceOfKind(kind),
    text,
    summary: firstChars(segment, 60),
    quote: segment,
    segment,
    canonicalKey: spo.canonicalKey,
    subject: spo.subject,
    predicate: spo.predicate,
    object: spo.object,
    dimension: spo.dimension,
  };
}

/** 记住规则：按内容判定 kind（偏好词→preference，决定词→decision，否则 fact） */
function rememberKind(text: string): L3Category {
  ZH_PREFERENCE_RE.lastIndex = 0;
  EN_PREFERENCE_RE.lastIndex = 0;
  ZH_DECISION_RE.lastIndex = 0;
  EN_DECISION_RE.lastIndex = 0;
  if (ZH_PREFERENCE_RE.test(text) || EN_PREFERENCE_RE.test(text)) return 'preference';
  if (ZH_DECISION_RE.test(text) || EN_DECISION_RE.test(text)) return 'decision';
  return 'fact';
}

/** 命中位置所在的行（行级噪声判定：代码行/日志行整行不抽） */
function lineAround(text: string, index: number): string {
  const start = text.lastIndexOf('\n', Math.max(0, index - 1)) + 1;
  const end = text.indexOf('\n', index);
  return text.slice(start, end >= 0 ? end : text.length);
}

/** 命中位置是否落在 markdown 代码围栏内（``` 成对计数；确定性） */
function isInsideCodeFence(text: string, index: number): boolean {
  if (index <= 0) return false;
  const fences = text.slice(0, index).split('```').length - 1;
  return fences % 2 === 1;
}

/** 行级噪声检查不限制长度（单行可能很长，长度门禁只看候选整句） */
const LINE_NOISE_OPTIONS: CandidateNoiseOptions = { minLength: 0, maxLength: Number.MAX_SAFE_INTEGER };
const SEGMENT_NOISE_OPTIONS: CandidateNoiseOptions = { minLength: L3_SEGMENT_MIN, maxLength: L3_SEGMENT_MAX };

/** 应用触发词规则（返回原始候选，未截断数量；含行级噪声 / 疑问句 / 句式门禁） */
function extractCueCandidates(text: string): L3Candidate[] {
  const out: L3Candidate[] = [];
  const pushCandidate = (
    rule: CueRule,
    kind: L3Category,
    segment: string,
    dimensionOverride: string | undefined,
    evidence: string,
  ): void => {
    // fact / decision 额外过句式门禁（宁缺毋滥）；preference / profile 由强触发词保证。
    // 决策证据取"触发词所在行"：'决定：向量默认 512 维' 的片段本身可不含决策词。
    if (kind === 'fact' && !isFactSentence(segment)) return;
    if (kind === 'decision' && !isDecisionSentence(evidence)) return;
    const candidate = makeCueCandidate(rule, kind, segment, dimensionOverride);
    if (isNoisyCandidate(candidate.text)) return;
    out.push(candidate);
  };
  for (const rule of CUE_RULES) {
    rule.pattern.lastIndex = 0;
    for (const match of text.matchAll(rule.pattern)) {
      if (out.length >= 12) break; // 单条文本的中间上限（最终仍按 raw 截 3）
      const matchIndex = match.index ?? 0;
      if (isInsideCodeFence(text, matchIndex)) continue;
      const line = lineAround(text, matchIndex);
      if (isNoisyCandidate(line, LINE_NOISE_OPTIONS)) continue;
      const detail = extractSegmentDetailed(text, matchIndex + match[0].length);
      if (detail === null) continue;
      // 疑问句（片段结束符为 ?/？）一律不抽：避免把"希望用什么主题？"写成偏好
      if (detail.terminator === '?' || detail.terminator === '？') continue;
      if (isNoisyCandidate(detail.segment, SEGMENT_NOISE_OPTIONS)) continue;
      // 画像维度由"触发词+片段"共同判定（如 '我的名字' + 'Hanxu' → profile.name）
      const dimensionOverride =
        rule.kind === 'profile' ? profileDimension(`${match[0]} ${detail.segment}`) : undefined;
      pushCandidate(rule, rule.kind, detail.segment, dimensionOverride, line);
    }
  }
  // 显式记忆规则最后处理（kind 由片段本身判定，避免把无关句子归到偏好/决策）
  REMEMBER_RE.lastIndex = 0;
  const rememberRule: CueRule = {
    id: 'remember',
    lang: /[\u4e00-\u9fff]/u.test(text) ? 'zh' : 'en',
    kind: 'fact',
    pattern: REMEMBER_RE,
    confidence: 0.95,
    importance: 0.95,
  };
  for (const match of text.matchAll(REMEMBER_RE)) {
    if (out.length >= 12) break;
    const matchIndex = match.index ?? 0;
    if (isInsideCodeFence(text, matchIndex)) continue;
    if (isNoisyCandidate(lineAround(text, matchIndex), LINE_NOISE_OPTIONS)) continue;
    const detail = extractSegmentDetailed(text, matchIndex + match[0].length);
    if (detail === null) continue;
    if (detail.terminator === '?' || detail.terminator === '？') continue;
    if (isNoisyCandidate(detail.segment, SEGMENT_NOISE_OPTIONS)) continue;
    const kind = rememberKind(detail.segment);
    if (kind === 'fact' && !isFactSentence(detail.segment)) continue;
    if (kind === 'decision' && !isDecisionSentence(detail.segment)) continue;
    const candidate = makeCueCandidate(rememberRule, kind, detail.segment);
    candidate.extractedBy = `rule:remember@${L3_EXTRACTOR_VERSION}`;
    candidate.confidence = 0.95;
    candidate.importance = 0.95;
    // remember 的 fact 主语按"我/我的"判定
    if (kind === 'fact') {
      const spo = buildSpo({ kind: 'fact', segment: detail.segment });
      candidate.canonicalKey = spo.canonicalKey;
      candidate.subject = spo.subject;
      candidate.predicate = spo.predicate;
      candidate.object = spo.object;
      candidate.dimension = spo.dimension;
      candidate.text = `${KIND_LABEL.fact}：${detail.segment}`;
    }
    if (isNoisyCandidate(candidate.text)) continue;
    out.push(candidate);
  }
  return out;
}

/** meta-workspace 抽取：git remote / package name/version / 路径 / 端口（docs §9.2.2） */
const WORKSPACE_PATTERNS: ReadonlyArray<{
  dimension: string;
  pattern: RegExp;
  label: string;
}> = [
  { dimension: 'git.remote', pattern: /git\s+remote[^\n]*?((?:https?:\/\/|git@)[^\s"'`]+)/i, label: 'git remote' },
  { dimension: 'name', pattern: /"name"\s*:\s*"([^"]+)"/, label: '包名' },
  { dimension: 'version', pattern: /"version"\s*:\s*"([^"]+)"/, label: '版本号' },
  { dimension: 'workspace.path', pattern: /[A-Za-z]:\\[^\s"']+|(?:\/(?:[\w.-]+\/)+[\w.-]+)/, label: '路径' },
  { dimension: 'port', pattern: /:(\d{2,5})\b/, label: '端口' },
];

/**
 * 从工具/系统文本抽取项目元数据事实（显式 opt-in）。
 *
 * v2 起**自动派生不再调用**（防止把工具输出里的包名/版本/端口/路径写成长期事实）；
 * 仅保留给显式调用方（单测 / 未来的显式"扫描项目"工具）。
 */
export function extractWorkspaceFacts(text: string): L3Candidate[] {
  const out: L3Candidate[] = [];
  for (const spec of WORKSPACE_PATTERNS) {
    const match = spec.pattern.exec(text);
    if (!match) continue;
    const rawValue = (match[1] ?? match[0]).trim();
    if (rawValue.length === 0) continue;
    const object = normalizeObject(rawValue);
    const predicate = spec.dimension.includes('.') ? spec.dimension : `fact.${spec.dimension}`;
    const subject = 'project';
    out.push({
      ruleId: 'meta-workspace',
      extractedBy: `rule:meta-workspace@${L3_EXTRACTOR_VERSION}`,
      lang: /[\u4e00-\u9fff]/u.test(text) ? 'zh' : 'en',
      kind: 'fact',
      category: 'fact',
      confidence: 0.6,
      importance: 0.6,
      text: `项目事实：${spec.label} ${firstChars(rawValue, 120)}`,
      summary: firstChars(`${spec.label} ${rawValue}`, 60),
      quote: firstChars(rawValue, L3_SEGMENT_MAX),
      segment: firstChars(rawValue, L3_SEGMENT_MAX),
      canonicalKey: `${subject}.${predicate}=${object}`,
      subject,
      predicate,
      object,
      dimension: spec.dimension,
    });
    if (out.length >= L3_MAX_CANDIDATES_PER_RAW) break;
  }
  return out;
}

export interface ExtractL3Options {
  /** 单条文本最多候选数（默认 3，docs §9.2.2） */
  maxCandidates?: number;
  /** 是否追加 meta-workspace 事实（默认关闭；自动派生不再启用） */
  includeWorkspaceFacts?: boolean;
}

/**
 * 从一段文本抽取 L3 候选（纯函数，确定性；供单测与 saveExplicit 复用）。
 * 同一 canonicalKey 只保留一条；顺序 = 规则顺序（偏好→决策→画像→记住→元数据）。
 *
 * 注意：本函数只看文本、不判来源；自动派生必须经 `extractCandidatesFromRaw`，
 * 以保证 assistant/tool_result/system 等流水永远不会进入 L3。
 */
export function extractL3Candidates(text: string, options: ExtractL3Options = {}): L3Candidate[] {
  const normalized = normalizeDerivedText(text);
  if (normalized.length === 0) return [];
  const max = Math.max(1, Math.min(options.maxCandidates ?? L3_MAX_CANDIDATES_PER_RAW, 20));
  const cue = extractCueCandidates(normalized);
  const workspaceFacts = options.includeWorkspaceFacts === true ? extractWorkspaceFacts(normalized) : [];
  const out: L3Candidate[] = [];
  const seen = new Set<string>();
  for (const candidate of [...cue, ...workspaceFacts]) {
    if (seen.has(candidate.canonicalKey)) continue;
    seen.add(candidate.canonicalKey);
    out.push(candidate);
    if (out.length >= max) break;
  }
  return out;
}

/** 可作为抽取输入的最小 raw 形状（RawRecord / 索引行都兼容） */
export interface ExtractableRaw extends CandidateSourceLike {
  id?: string | null;
}

/** memory_save note payload 中的 L3 相关字段 */
interface ExplicitSaveNote {
  text: string;
  kind: MemoryKind;
  canonicalKey: string | null;
  tags: string[];
}

const MEMORY_KINDS: ReadonlySet<string> = new Set(['fact', 'preference', 'decision', 'profile', 'summary', 'custom']);

/** 解析 memory_save note（非显式保存 / 空文本返回 null） */
function explicitSaveNoteOf(raw: ExtractableRaw | null | undefined): ExplicitSaveNote | null {
  if (!raw || !isExplicitSaveRaw(raw)) return null;
  const payload = payloadRecordOf(raw.payload);
  if (!payload) return null;
  const payloadText = typeof payload.text === 'string' ? payload.text : '';
  const text = normalizeDerivedText(payloadText.length > 0 ? payloadText : typeof raw.text === 'string' ? raw.text : '');
  if (text.length === 0) return null;
  const kindValue = typeof payload.kind === 'string' ? payload.kind : 'fact';
  const kind = MEMORY_KINDS.has(kindValue) ? (kindValue as MemoryKind) : 'fact';
  const canonicalKey =
    typeof payload.canonicalKey === 'string' && payload.canonicalKey.trim().length > 0
      ? payload.canonicalKey.trim()
      : null;
  const tags = Array.isArray(payload.tags)
    ? payload.tags.filter((tag): tag is string => typeof tag === 'string' && tag.length > 0)
    : [];
  return { text, kind, canonicalKey, tags };
}

/**
 * 显式保存回放前按配置脱敏（docs §13.1）：
 * note.payload 保存的是 L0 原文，但派生文本（含 quote / canonical_key）必须脱敏，
 * 否则重建会把密钥原文带进 L3。已脱敏文本再次脱敏是幂等 no-op。
 */
function redactExplicitSaveRaw(
  raw: ExtractableRaw | null | undefined,
  enabled: boolean,
): ExtractableRaw | null | undefined {
  if (!enabled || !raw || !isExplicitSaveRaw(raw)) return raw;
  const payload = payloadRecordOf(raw.payload);
  const nextPayload: Record<string, unknown> | null = payload ? { ...payload } : null;
  if (nextPayload && typeof nextPayload.text === 'string') {
    nextPayload.text = maybeRedact(nextPayload.text, true).text;
  }
  return {
    ...raw,
    ...(typeof raw.text === 'string' ? { text: maybeRedact(raw.text, true).text } : {}),
    ...(nextPayload ? { payload: nextPayload } : {}),
  };
}

/**
 * 显式保存（memory_save note）回放：忠实还原 saveExplicit 的 SPO / 主文本。
 *
 * 用途：L3 重建（L0 note 是显式保存的唯一权威来源）与派生补偿；
 * 不做 cue 规则扫描（用户已经显式保存，文本本身即可信）。
 * 注意：payload 未持久化 importance/confidence，回放使用类别基线（已知边界）。
 */
export function extractExplicitSaveCandidates(raw: ExtractableRaw | null | undefined): L3Candidate[] {
  const note = explicitSaveNoteOf(raw);
  if (!note) return [];
  const category = categoryOfKind(note.kind);
  const spo = deriveSpoForExplicit({
    text: note.text,
    kind: note.kind,
    ...(note.canonicalKey ? { canonicalKey: note.canonicalKey } : {}),
    sourceRawIds: [],
  });
  const quote = firstChars(note.text, L3_SEGMENT_MAX);
  return [
    {
      ruleId: 'memory_save',
      extractedBy: 'memory_save@1',
      lang: /[\u4e00-\u9fff]/u.test(note.text) ? 'zh' : 'en',
      kind: category,
      recordKind: note.kind,
      category,
      confidence: 0.9,
      importance: baseImportanceOfKind(note.kind),
      text: explicitStatement(note.text, category),
      summary: firstChars(note.text, 60),
      quote,
      segment: quote,
      canonicalKey: spo.canonicalKey,
      subject: spo.subject,
      predicate: spo.predicate,
      object: spo.object,
      dimension: spo.dimension,
      explicit: true,
      explicitTags: note.tags,
    },
  ];
}

/**
 * 单条 raw 的 L3 候选（纯函数，自动抽取唯一入口）：
 * - 用户消息 → cue 规则抽取（不做 meta-workspace 事实）；
 * - 显式 memory_save note → 显式保存回放；
 * - 其它来源（assistant / tool_call / tool_result / system / turn / 普通 note）恒为空。
 */
export function extractCandidatesFromRaw(
  raw: ExtractableRaw | null | undefined,
  options: ExtractL3Options = {},
): L3Candidate[] {
  const source = candidateSourceOf(raw);
  if (!raw || source === null) return [];
  if (source === 'memory_save') return extractExplicitSaveCandidates(raw);
  const text = normalizeDerivedText(raw.text);
  if (text.length === 0) return [];
  return extractL3Candidates(text, {
    maxCandidates: options.maxCandidates ?? L3_MAX_CANDIDATES_PER_RAW,
    includeWorkspaceFacts: false,
  });
}

// ---------------------------------------------------------------------------
// 已有 L3 索引 / 记录构造 / 取代
// ---------------------------------------------------------------------------

interface L3Index {
  /** canonical_key → 当前有效记录 */
  byCanonical: Map<string, MemoryRecord>;
  /** `<subject>.<predicate>`（维度键）→ 当前有效记录 */
  byDimension: Map<string, MemoryRecord>;
  /** content_hash → 当前有效同 hash 记录 */
  byContentHash: Map<string, MemoryRecord>;
}

const L3_INDEX_SCAN_LIMIT = 5000;

function indexL3Memories(memories: readonly MemoryRecord[], now: number): L3Index {
  const byCanonical = new Map<string, MemoryRecord>();
  const byDimension = new Map<string, MemoryRecord>();
  const byContentHash = new Map<string, MemoryRecord>();
  for (const memory of memories) {
    if (memory.layer !== L3_LAYER_ID) continue;
    // 已结束有效期（被取代/归档）的历史版本不参与"当前值"判定（仍可查询/审计）
    if (typeof memory.validTo === 'number' && memory.validTo <= now) continue;
    if (memory.status !== undefined && memory.status !== 'active') continue;
    const meta = (memory.meta ?? {}) as Record<string, unknown>;
    const canonicalKey = typeof meta.canonicalKey === 'string' ? meta.canonicalKey : null;
    if (canonicalKey) {
      if (!byCanonical.has(canonicalKey)) byCanonical.set(canonicalKey, memory);
      const dimensionKey = dimensionKeyOf(canonicalKey);
      if (dimensionKey && !byDimension.has(dimensionKey)) byDimension.set(dimensionKey, memory);
    }
    if (typeof memory.contentHash === 'string' && !byContentHash.has(memory.contentHash)) {
      byContentHash.set(memory.contentHash, memory);
    }
  }
  return { byCanonical, byDimension, byContentHash };
}

/** 读取 L3 当前有效记录索引（限定扫描量，防止极端全表） */
function loadL3Index(ctx: DeriveContext, now: number): L3Index {
  return indexL3Memories(ctx.listLayerMemories('L3', { limit: L3_INDEX_SCAN_LIMIT, onlyValid: true }), now);
}

/** 读取 L3 代际号（重建代际，docs §9.7；默认 0） */
export function readRebuildGeneration(ctx: DeriveContext): number {
  try {
    const value = ctx.store.getMeta(L3_REBUILD_GENERATION_KEY);
    if (value === null) return 0;
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
  } catch {
    return 0;
  }
}

/**
 * L3 记录 id：`L3-<kind>-<base36(代际+1)>-<hash8(canonicalKey#代际)>`。
 * - 同代同 canonical_key → 同一 id（重述幂等、rebuild 稳定）；
 * - 代际重建后 id 变化 → 旧代 archived 记录不被覆盖（语义历史零丢失）。
 */
export function deriveL3MemoryId(kind: string, canonicalKey: string, generation: number): string {
  return deriveMemoryId(L3_LAYER_ID, kind, generation + 1, `${canonicalKey}\u0000${generation}`);
}

/** 带溯源上下文的候选 */
interface ProvenancedCandidate extends L3Candidate {
  sourceRawIds: string[];
  sessionId: string | null;
  workspace: string | null;
  createdSeq: number;
  /** 证据生效时间：raw 推导取 raw.ts；L2 摘要推导取窗口起点（避免用摘要文本复活旧值） */
  createdAt: number;
  /** 证据来源：raw 直接抽取 / L2 摘要晋升（后者不覆盖更新的 raw 事实） */
  origin: 'raw' | 'l2';
  /** 人格归属（v4；从来源 raw/episode 继承；null = 共享） */
  personaId: string | null;
}

/** 候选 → 新记忆记录 */
export function buildL3MemoryRecord(
  candidate: ProvenancedCandidate,
  options: { generation: number; existingId?: string; supersedes?: string[] },
): NewMemoryRecord {
  const recordKind = candidate.recordKind ?? candidate.kind;
  const id = options.existingId ?? deriveL3MemoryId(recordKind, candidate.canonicalKey, options.generation);
  const tags = candidate.explicit
    ? normalizeTags(['source:memory_save', 'memory_save', candidate.category, ...(candidate.explicitTags ?? [])])
    : normalizeTags([`source:${candidate.extractedBy}`, candidate.category, `rule:${candidate.ruleId}`]);
  return {
    id,
    layer: L3_LAYER_ID,
    kind: recordKind,
    text: candidate.text,
    summary: candidate.summary,
    importance: candidate.importance,
    confidence: candidate.confidence,
    sourceRawIds: [...candidate.sourceRawIds],
    sessionId: candidate.sessionId,
    workspace: candidate.workspace,
    personaId: candidate.personaId,
    tags,
    createdAt: candidate.createdAt,
    validFrom: candidate.createdAt,
    validTo: null,
    supersedes: options.supersedes && options.supersedes.length > 0 ? [...options.supersedes] : [],
    createdSeq: candidate.createdSeq,
    meta: {
      canonicalKey: candidate.canonicalKey,
      category: candidate.category,
      subject: candidate.subject,
      predicate: candidate.predicate,
      object: candidate.object,
      dimension: candidate.dimension,
      quote: candidate.quote,
      language: candidate.lang,
      ruleId: candidate.ruleId,
      extractedBy: candidate.extractedBy,
      sourceKind: candidate.explicit ? 'manual' : 'deterministic',
      ...(candidate.explicit ? { replay: 'memory_save' } : {}),
      generation: options.generation,
    },
  };
}

/** 生成"旧记录失效"的更新记录（同一 id，valid_to=now-1 + supersededBy；不删除） */
export function buildL3ExpireRecord(old: MemoryRecord, supersededBy: string, now: number): NewMemoryRecord {
  const previousMeta = (old.meta ?? {}) as Record<string, unknown>;
  return {
    id: old.id,
    layer: L3_LAYER_ID,
    kind: old.kind,
    text: old.text,
    summary: old.summary ?? null,
    importance: old.importance,
    confidence: old.confidence,
    sourceRawIds: [...(old.sourceRawIds ?? [])],
    sessionId: old.sessionId ?? null,
    workspace: old.workspace ?? null,
    tags: [...(old.tags ?? [])],
    createdAt: old.createdAt,
    validFrom: old.validFrom ?? null,
    validTo: Math.max(0, now - 1),
    supersedes: [...(old.supersedes ?? [])],
    createdSeq: old.createdSeq ?? 0,
    meta: { ...previousMeta, supersededBy },
  };
}

/** 把 L3 记录写回 `layer_l3_semantic`（与 memory_records 同一事务；sidecar 与 saveExplicit 共用） */
export function writeL3SemanticRows(ctx: DeriveContext, items: readonly LayerWriteItem[]): void {
  for (const item of items) {
    const { record, stored } = item;
    if (record.layer !== L3_LAYER_ID) continue;
    const meta = (record.meta ?? {}) as Record<string, unknown>;
    const canonicalKey = currentStringOrNull(meta.canonicalKey);
    if (!canonicalKey) continue; // 无 canonical_key 的 L3 条目（如 summary）不写私有表
    const category = categoryOfKind(currentStringOrNull(meta.category) ?? record.kind);
    const supersededBy = currentStringOrNull(meta.supersededBy);
    const validTo = supersededBy !== null ? (stored.validTo ?? record.validTo ?? null) : (stored.validTo ?? null);
    const row: L3Row = {
      memoryId: stored.id,
      category,
      subject: currentStringOrNull(meta.subject),
      predicate: currentStringOrNull(meta.predicate),
      object: currentStringOrNull(meta.object),
      canonicalKey,
      validFrom: stored.validFrom ?? record.validFrom ?? null,
      validTo,
      supersededBy,
      sourceKind:
        meta.sourceKind === 'manual' ? 'manual' : meta.sourceKind === 'llm' ? 'llm' : 'deterministic',
      extractedBy: currentStringOrNull(meta.extractedBy),
    };
    ctx.store.putL3Semantic(row);
  }
}

function currentStringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

// ---------------------------------------------------------------------------
// L3 derive
// ---------------------------------------------------------------------------

/** 把候选按 canonical_key 分组：同键合并溯源、取最新候选；同维度不同键后者胜出 */
function groupCandidates(candidates: readonly ProvenancedCandidate[]): ProvenancedCandidate[] {
  const byCanonical = new Map<string, ProvenancedCandidate>();
  for (const candidate of candidates) {
    const existing = byCanonical.get(candidate.canonicalKey);
    if (!existing) {
      byCanonical.set(candidate.canonicalKey, { ...candidate, sourceRawIds: [...candidate.sourceRawIds] });
      continue;
    }
    // 同键重述：合并溯源、保留最新 quote/createdSeq
    const merged: ProvenancedCandidate = candidate.createdSeq >= existing.createdSeq ? { ...candidate } : { ...existing };
    merged.sourceRawIds = [...new Set([...existing.sourceRawIds, ...candidate.sourceRawIds])];
    merged.createdSeq = Math.max(existing.createdSeq, candidate.createdSeq);
    merged.createdAt = Math.max(existing.createdAt, candidate.createdAt);
    byCanonical.set(candidate.canonicalKey, merged);
  }
  // 同维度（subject.predicate）不同 object：按出现顺序后者覆盖前者（一次运行内的值演进）
  const byDimension = new Map<string, ProvenancedCandidate>();
  for (const candidate of byCanonical.values()) {
    const dimensionKey = dimensionKeyOf(candidate.canonicalKey) ?? candidate.canonicalKey;
    byDimension.set(dimensionKey, candidate);
  }
  // 输出顺序确定：按 canonicalKey 排序
  return [...byDimension.values()].sort((a, b) => compareCanonical(a.canonicalKey, b.canonicalKey));
}

function compareCanonical(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/** 业务时间：raw.ts / episode.createdAt */
function sourceTs(raw: RawRecord): number {
  return typeof raw.ts === 'number' && Number.isFinite(raw.ts) ? raw.ts : 0;
}

/** 是否人工（memory_save）写入的 L3 记录（meta.sourceKind='manual'） */
function isManualL3Record(record: MemoryRecord): boolean {
  const meta = (record.meta ?? {}) as Record<string, unknown>;
  return meta.sourceKind === 'manual';
}

/** 索引行是否为可信来源（note 需解析 payload 判断 memory_save；其它看 kind/role） */
function isReliableIndexRow(row: RawIndexRow): boolean {
  if (row.kind === 'note') {
    let payload: unknown = null;
    try {
      payload = JSON.parse(row.payloadJson);
    } catch {
      return false;
    }
    return isCandidateSource({ kind: row.kind, role: row.role, payload });
  }
  return isCandidateSource({ kind: row.kind, role: row.role });
}

/**
 * L2 摘要晋升门禁：摘要的每条来源 raw 都必须是可信来源（用户消息 / 显式 memory_save）。
 * 混合了工具/助手输出的摘要会放大伪事实，直接跳过（宁缺毋滥）。
 */
function episodeSourcesAreReliable(
  ctx: DeriveContext,
  sourceRawIds: readonly string[],
  cache: Map<string, boolean>,
): boolean {
  for (const id of sourceRawIds) {
    const cached = cache.get(id);
    if (cached !== undefined) {
      if (!cached) return false;
      continue;
    }
    let reliable = false;
    try {
      const row = ctx.store.getRawIndex(id);
      reliable = row !== null && isReliableIndexRow(row);
    } catch {
      reliable = false;
    }
    cache.set(id, reliable);
    if (!reliable) return false;
  }
  return true;
}

/**
 * 创建 L3 层定义。
 * 依赖 L1/L2（自动抽取只读 L0 的 user / memory_save note；session_end/timer 时
 * 再扫 L2 摘要，且要求摘要来源全部可信）。
 */
export function createL3Layer(): InternalLayerDefinition {
  return {
    id: L3_LAYER_ID,
    name: 'L3 语义记忆层',
    version: 1,
    dependsOn: ['L1', 'L2'],
    rebuildableFromRaw: true,
    enabled: (config) => config.enabled && config.layers.enabled.includes(L3_LAYER_ID),
    rebuildStrategy: 'archive',
    onRebuildStart(ctx: DeriveContext, info: { now: number }): void {
      // 代际重建：新代记录使用新 id，旧代保留为 archived（docs §9.7）
      const next = readRebuildGeneration(ctx) + 1;
      ctx.store.setMeta(L3_REBUILD_GENERATION_KEY, String(next), info.now);
      // 旧代 layer_l3_semantic 行结束有效期：否则 ux_l3_canonical_active（valid_to IS NULL 唯一）
      // 会阻止新代同 canonical_key 的行写入。clearLayer({archive}) 负责 memory_records；
      // 这里补齐私有表的 valid_to（对已正确归档的 store 实现是幂等 no-op）。
      try {
        const archived = ctx.listLayerMemories('L3', { limit: 5000 });
        for (const memory of archived) {
          if (memory.status !== 'archived') continue;
          const row = ctx.store.getL3Semantic(memory.id);
          if (!row || row.validTo !== null && row.validTo !== undefined) continue;
          ctx.store.putL3Semantic({ ...row, validTo: info.now });
        }
      } catch (err) {
        ctx.logger.warn(`L3 代际重建：归档 layer_l3_semantic 旧行失败（继续重放）：${errorMessage(err)}`);
      }
      ctx.logger.info(`L3 代际重建：generation=${next}`);
    },
    async derive(input: DeriveInput, ctx: DeriveContext): Promise<NewMemoryRecord[]> {
      const now = typeof input.now === 'number' && Number.isFinite(input.now) ? input.now : ctx.now();
      const generation = readRebuildGeneration(ctx);
      const pendingRaws = sortRawsBySeq(input.pendingRaws ?? input.raws ?? []);
      const collected: ProvenancedCandidate[] = [];

      // ① 直接读 L0：仅用户消息 + 显式 memory_save note（v2 来源门禁）。
      //    assistant / tool_call / tool_result / system / turn 一律不抽，
      //    也不再用 meta-workspace 从工具输出生成项目事实（包名/端口/路径污染源）。
      for (const raw of pendingRaws) {
        const noteRaw = redactExplicitSaveRaw(raw, ctx.config.safety.redactSecretsInDerived);
        const candidates = extractCandidatesFromRaw(noteRaw, { maxCandidates: L3_MAX_CANDIDATES_PER_RAW });
        for (const candidate of candidates) {
          collected.push({
            ...candidate,
            sourceRawIds: [raw.id],
            sessionId: raw.sessionId,
            workspace: raw.workspace ?? null,
            createdSeq: raw.seq,
            createdAt: sourceTs(raw),
            origin: 'raw',
            personaId: ctx.store.getRawIndex(raw.id)?.personaId ?? null,
          });
        }
      }

      // ② L2→L3 晋升：session_end / timer / manual / rebuild 时把 L2 摘要再跑一遍规则。
      //    仅接受"全部来源 raw 均可信（用户消息 / 显式保存）"的摘要：混合了工具/助手
      //    输出的摘要文本会放大伪事实（真实污染案例），宁可漏抽。
      const promoteFromL2 =
        input.reason === 'session_end' || input.reason === 'timer' || input.reason === 'manual' || input.reason === 'rebuild';
      if (promoteFromL2) {
        const reliability = new Map<string, boolean>();
        const sessions: string[] = [];
        const addSession = (sessionId: string | null | undefined): void => {
          if (typeof sessionId === 'string' && sessionId.length > 0 && !sessions.includes(sessionId)) sessions.push(sessionId);
        };
        for (const raw of pendingRaws) addSession(raw.sessionId);
        addSession(input.sessionId);
        if (input.reason === 'timer' || input.reason === 'manual' || input.reason === 'rebuild') {
          const recentEpisodes = ctx.listLayerMemories('L2', { limit: L2_SCAN_LIMIT });
          for (const episode of recentEpisodes) addSession(episode.sessionId);
        }
        for (const sessionId of sessions.slice(0, L3_MAX_SESSIONS_PER_RUN)) {
          const episodes = ctx.listLayerMemories('L2', { sessionId, limit: L2_SCAN_LIMIT });
          for (const episode of episodes) {
            if (episode.layer !== L2_LAYER_ID || episode.kind !== 'episode') continue;
            const sourceRawIds = (episode.sourceRawIds ?? []).filter((id): id is string => typeof id === 'string' && id.length > 0);
            if (sourceRawIds.length === 0) continue;
            if (!episodeSourcesAreReliable(ctx, sourceRawIds, reliability)) continue;
            const candidates = extractL3Candidates(episode.text, { maxCandidates: L3_MAX_CANDIDATES_PER_RAW });
            for (const candidate of candidates) {
              collected.push({
                ...candidate,
                sourceRawIds,
                sessionId: episode.sessionId ?? null,
                workspace: episode.workspace ?? null,
                createdSeq: episode.createdSeq ?? 0,
                // L2 摘要的"生效时间"取窗口起点：摘要文本可能转述更早的历史值，
                // 不能让它（更晚生成的摘要）复活并取代窗口内更新的 raw 事实。
                createdAt: episode.validFrom ?? episode.createdAt,
                origin: 'l2',
                personaId: episode.personaId ?? null,
              });
            }
          }
        }
      }

      if (collected.length === 0) return [];
      const winners = groupCandidates(collected);
      const index = loadL3Index(ctx, now);
      const records: NewMemoryRecord[] = [];
      for (const candidate of winners) {
        const existingCanonical = index.byCanonical.get(candidate.canonicalKey) ?? null;
        // 显式保存已由 saveExplicit 原子写入：L0 note 回放不得覆盖人工记录（幂等）
        if (candidate.explicit === true && existingCanonical !== null && isManualL3Record(existingCanonical)) {
          continue;
        }
        if (existingCanonical) {
          // 同 canonical_key → 重述（复用原 id；store 负责 revision++ / 来源合并）
          records.push(
            buildL3MemoryRecord(candidate, {
              generation,
              existingId: existingCanonical.id,
              supersedes: existingCanonical.supersedes ?? [],
            }),
          );
          continue;
        }
        const dimensionKey = dimensionKeyOf(candidate.canonicalKey);
        const existingDimension = dimensionKey ? index.byDimension.get(dimensionKey) ?? null : null;
        const newId = deriveL3MemoryId(candidate.recordKind ?? candidate.kind, candidate.canonicalKey, generation);
        if (existingDimension) {
          // 时间顺序守卫：只允许"证据更新"的值取代当前值。
          // 否则 L2 摘要转述的旧值（或批量重放中的乱序）会把新值回退（int 集成测试发现的真实缺陷）。
          const existingFrom =
            existingDimension.validFrom ?? existingDimension.createdAt ?? 0;
          if (candidate.createdAt <= existingFrom) {
            ctx.logger.debug(
              `L3: 跳过过时候选 ${candidate.canonicalKey}（证据 ${candidate.createdAt} <= 当前值生效 ${existingFrom}）`,
            );
            continue;
          }
          // 同维度不同值 → 取代：旧记录有效期结束（不删除），新记录 supersedes=[旧]。
          // 失效时刻取新值的来源时间（deterministic rebuild 时与时钟无关）；不早于旧值生效时间。
          const supersedeAt = Math.max(
            candidate.createdAt,
            (existingDimension.validFrom ?? 0) + 1,
            typeof existingDimension.createdAt === 'number' ? existingDimension.createdAt : 0,
          );
          records.push(buildL3ExpireRecord(existingDimension, newId, supersedeAt));
          records.push(buildL3MemoryRecord(candidate, { generation, supersedes: [existingDimension.id] }));
        } else {
          records.push(buildL3MemoryRecord(candidate, { generation }));
        }
      }
      return records;
    },
    writeSidecar(ctx: DeriveContext, items: readonly LayerWriteItem[]): void {
      writeL3SemanticRows(ctx, items);
    },
  };
}

/** L2 扫描上限（L3 晋升用） */
const L2_SCAN_LIMIT = 2000;
/** 单次 L3 派生最多处理的会话数 */
const L3_MAX_SESSIONS_PER_RUN = 64;

// ---------------------------------------------------------------------------
// memory_save 显式保存（SaveExplicitFn 的 L3 实现）
// ---------------------------------------------------------------------------

/** 由显式保存输入推导 SPO（未给 canonicalKey 时按规则/文本生成） */
export function deriveSpoForExplicit(input: SaveExplicitInput): SpoTriple {
  const text = normalizeDerivedText(input.text);
  const category = categoryOfKind(input.kind);
  if (input.canonicalKey && input.canonicalKey.trim().length > 0) {
    const parsed = parseCanonicalKey(input.canonicalKey.trim());
    if (parsed) {
      const dimension = parsed.predicate.includes('.') ? parsed.predicate.split('.').slice(1).join('.') : parsed.predicate;
      return {
        subject: parsed.subject,
        predicate: parsed.predicate,
        object: normalizeObject(parsed.object),
        canonicalKey: `${parsed.subject}.${parsed.predicate}=${normalizeObject(parsed.object)}`,
        dimension,
      };
    }
  }
  // 先尝试按确定性规则抽取（记住/偏好/决策等），取与 kind 匹配的候选
  const extracted = extractL3Candidates(text, { maxCandidates: 3 });
  const matching = extracted.find((candidate) => candidate.kind === category) ?? extracted[0];
  if (matching) {
    return {
      subject: matching.subject,
      predicate: matching.predicate,
      object: matching.object,
      canonicalKey: matching.canonicalKey,
      dimension: matching.dimension,
    };
  }
  return buildSpo({ kind: category, segment: text });
}

/** 显式保存主文本（陈述句；脱敏已由 memory_save 处理） */
function explicitStatement(text: string, category: L3Category): string {
  const value = normalizeDerivedText(text);
  if (category === 'preference') return value.startsWith('用户偏好') ? value : `用户偏好：${value}`;
  if (category === 'decision') return value.startsWith('决定') ? value : `决定：${value}`;
  if (category === 'profile') return value.startsWith('用户画像') ? value : `用户画像：${value}`;
  return value.startsWith('事实') || value.startsWith('项目事实') ? value : `事实：${value}`;
}

/** 显式保存主文本（SaveExplicitInput 版本，saveExplicit 用） */
function explicitText(input: SaveExplicitInput, category: L3Category): string {
  return explicitStatement(normalizeDerivedText(input.text), category);
}

/**
 * L3 显式保存（memory_save）：不追加 raw（调用方已写 note raw 并传 sourceRawIds），
 * 原子写 `memory_records` + `layer_l3_semantic`，返回回执。
 *
 * 去重/取代规则与确定性抽取一致：
 * - 同 canonical_key → 重述（复用原 id）；
 * - 同维度不同值 / 显式 supersedes → 取代旧记录（valid_to + supersededBy，不删除）。
 */
export async function saveExplicitL3(input: SaveExplicitInput, ctx: DeriveContext): Promise<SaveExplicitResult> {
  const now = ctx.now();
  const warnings: string[] = [];
  const text = typeof input.text === 'string' ? normalizeDerivedText(input.text) : '';
  if (text.length === 0) throw new Error('[dsh-life-memory] memory_save: text 不能为空');
  const sourceRawIds = (Array.isArray(input.sourceRawIds) ? input.sourceRawIds : []).filter(
    (id): id is string => typeof id === 'string' && id.length > 0,
  );
  if (sourceRawIds.length === 0) {
    throw new Error('[dsh-life-memory] memory_save: sourceRawIds 至少 1 个（L3 记录必须有溯源）');
  }
  const kind = input.kind ?? 'fact';
  const category = categoryOfKind(kind);
  const generation = readRebuildGeneration(ctx);
  const spo = deriveSpoForExplicit(input);
  const importance = clamp01(input.importance ?? baseImportanceOfKind(kind));
  const confidence = clamp01(input.confidence ?? 0.9);
  const validFrom = typeof input.validFrom === 'number' && Number.isFinite(input.validFrom) ? input.validFrom : now;
  const hash = computeContentHash(L3_LAYER_ID, kind, text);
  const index = loadL3Index(ctx, now);
  const existingSame = index.byCanonical.get(spo.canonicalKey) ?? null;
  const existingHash = index.byContentHash.get(hash) ?? null;
  const dimensionKey = dimensionKeyOf(spo.canonicalKey);
  const existingDimension = dimensionKey ? index.byDimension.get(dimensionKey) ?? null : null;

  // 显式 supersedes 指定的旧记录（存在且仍有效）
  const explicitOld: MemoryRecord[] = [];
  for (const id of input.supersedes ?? []) {
    if (typeof id !== 'string' || id.length === 0) continue;
    const memory = ctx.store.getMemory(id);
    if (!memory || memory.layer !== L3_LAYER_ID) {
      warnings.push(`supersedes:${id} 不存在或不是 L3 记录，已忽略`);
      continue;
    }
    if (memory.id === existingSame?.id) continue;
    explicitOld.push(memory);
  }

  const primaryId =
    existingSame?.id ??
    existingHash?.id ??
    deriveL3MemoryId(kind, spo.canonicalKey, generation);
  const record: NewMemoryRecord = {
    id: primaryId,
    layer: L3_LAYER_ID,
    kind,
    text: explicitText(input, category),
    summary: firstChars(text, 60),
    importance,
    confidence,
    sourceRawIds,
    sessionId: input.sessionId ?? null,
    workspace: input.workspace ?? null,
    personaId: input.personaId ?? null,
    tags: normalizeTags([...(input.tags ?? []), 'source:memory_save']),
    createdAt: now,
    validFrom,
    validTo: null,
    supersedes: [],
    createdSeq: 0,
    meta: {
      canonicalKey: spo.canonicalKey,
      category,
      subject: spo.subject,
      predicate: spo.predicate,
      object: spo.object,
      dimension: spo.dimension,
      quote: firstChars(text, L3_SEGMENT_MAX),
      sourceKind: 'manual',
      extractedBy: 'memory_save@1',
      generation,
    },
  };

  const supersededIds: string[] = [];
  const records: NewMemoryRecord[] = [];
  const expire = (old: MemoryRecord): void => {
    if (supersededIds.includes(old.id)) return;
    records.push(buildL3ExpireRecord(old, primaryId, now));
    supersededIds.push(old.id);
  };
  for (const old of explicitOld) expire(old);
  if (!existingSame && existingDimension && existingDimension.id !== primaryId) expire(existingDimension);
  records.push(record);
  if (supersededIds.length > 0) record.supersedes = [...supersededIds];

  let storedPrimary: MemoryRecord | null = null;
  ctx.store.transaction(() => {
    const items: LayerWriteItem[] = [];
    for (const candidate of records) {
      const stored = ctx.store.upsertMemory(candidate);
      items.push({ record: candidate, stored });
      if (stored.id === primaryId) storedPrimary = stored;
    }
    writeL3SemanticRows(ctx, items);
  });

  const dedup: SaveExplicitResult['dedup'] = !storedPrimary
    ? 'noop'
    : supersededIds.length > 0
      ? 'superseded'
      : existingSame
        ? existingSame.contentHash === hash
          ? 'noop'
          : 'restated'
        : existingHash
          ? 'restated'
          : 'created';
  const primary = storedPrimary as MemoryRecord | null;
  return {
    memoryId: primary ? primary.id : primaryId,
    layer: L3_LAYER_ID,
    revision: primary ? primary.revision : 0,
    dedup,
    ...(supersededIds.length > 0 ? { supersededIds } : {}),
    ...(warnings.length > 0 ? { warnings } : {}),
  };
}

/** 便捷：包一层 try/catch 的显式保存（工具层不期望异常穿透；保留错误信息） */
export async function safeSaveExplicitL3(
  input: SaveExplicitInput,
  ctx: DeriveContext,
): Promise<SaveExplicitResult> {
  try {
    return await saveExplicitL3(input, ctx);
  } catch (err) {
    throw new Error(`[dsh-life-memory] memory_save 失败：${errorMessage(err)}`);
  }
}

/** 便于测试：构造一个最小 L3 候选（不写库） */
export function buildTestCandidate(segment: string, kind: L3Category): L3Candidate {
  const spo = buildSpo({ kind, segment });
  return {
    ruleId: 'test',
    extractedBy: `rule:test@${L3_EXTRACTOR_VERSION}`,
    lang: /[\u4e00-\u9fff]/u.test(segment) ? 'zh' : 'en',
    kind,
    category: kind,
    confidence: 0.5,
    importance: baseImportanceOfKind(kind),
    text: `${KIND_LABEL[kind]}：${segment}`,
    summary: segment,
    quote: segment,
    segment,
    canonicalKey: spo.canonicalKey,
    subject: spo.subject,
    predicate: spo.predicate,
    object: spo.object,
    dimension: spo.dimension,
  };
}

/** 重新导出便于外部使用（不额外引入依赖） */
export type { L3SemanticRow };

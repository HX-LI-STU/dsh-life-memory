// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hanxustu (dsh-life-memory)
/**
 * 人格（persona）入口 —— docs/25-persona.md。
 *
 * 人格定义来自 `<DSH_HOME>/personas/*.md`（markdown + frontmatter，文件名 = id），
 * 文件系统是当前定义的源；注册表负责加载/roster/热重载/激活校验。
 *
 * 集成层用法：
 * ```ts
 * const personas = createPersonaRegistry({
 *   dir: config.persona.dir,
 *   config: { watch: config.persona.watch, maxBodyChars: config.persona.maxBodyChars },
 *   logger,
 *   getActiveId: () => store.getActivePersonaId(),
 *   setActiveId: (id) => store.setActivePersonaId(id),
 * });
 * await personas.reload();
 * const builder = new PromptSectionBuilder({ ..., getActivePersona: () => personas.active(), getPersonaRoster: () => personas.list() });
 * ```
 * 记忆作用域由集成层在捕获/派生/检索时按 `personaId` 写入/过滤（docs/25 §4）。
 */
export {
  PERSONA_ID_RE,
  PERSONA_TEMPLATE_GROUP_RE,
  parsePersonaFile,
  parsePersonaFrontmatter,
  personaIdFromPath,
  toPersonaSummary,
} from './parser.ts';
export type {
  ParsePersonaFileInput,
  PersonaFrontmatter,
  PersonaParseResult,
} from './parser.ts';
export {
  PERSONA_WATCH_DEBOUNCE_MS,
  createPersonaRegistry,
} from './registry.ts';
export type { PersonaRegistryOptions, PersonaWatcherLike } from './registry.ts';

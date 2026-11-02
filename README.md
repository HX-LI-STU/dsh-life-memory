# dsh-life-memory

> Persistent, auditable memory for **DeepSeek Harness (DSH)** agents: an immutable raw archive, a local SQLite store, layered memories, and isolated per-persona vaults.

<p>
  <a href="LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-green.svg"></a>
  <img alt="DSH plugin" src="https://img.shields.io/badge/DSH-plugin-blue.svg">
  <img alt="Node" src="https://img.shields.io/badge/node-%5E22.19%20%7C%7C%20%3E%3D24-brightgreen.svg">
</p>

[中文说明](README.zh-CN.md)

**Initial public release — v1.1.5.**

DSH conversations are ephemeral: close a session and the context is gone. `dsh-life-memory` gives your agents durable, inspectable, effectively life-long memory that survives restarts, with a strict separation between **what actually happened** (immutable raw records) and **what the model recalls** (derived, forgettable memories).

- **Raw first** — every captured event is appended to an immutable L0 archive; it is never edited or silently deleted.
- **Derived is rebuildable** — working / episodic / semantic memories live in SQLite and can always be rebuilt from L0.
- **Local-first** — data stays on your machine; no telemetry, no external database. Remote embeddings are explicit opt-in.
- **Scoped** — memories are grouped by session, and each persona gets a completely isolated vault (raw data and database included).
- **Long horizon** — the archive grows with your conversations and is limited only by disk space; raw conversations are never deleted by the memory system itself.
- **Shared by design** — sessions using the shared vault share memories with each other, and all sessions of a persona share that persona's vault; separate personas stay isolated.
- **Low context cost** — each prompt only gets a compact profile and current-session working memory; details are fetched on demand from the raw/vector store instead of being stuffed into every prompt.

---

## The idea: life-long memory with low context cost

`dsh-life-memory` is built around one observation: an agent does not need **all** old conversations in its context — it needs to be able to find them again.

- **Never-deleted raw conversations**: every session is archived as append-only, hash-chained records. The archive is the source of truth and is never rewritten; only an explicit manual deletion removes it.
- **Vector + keyword index over raw conversations**: every raw record is embedded and indexed with FTS5, so the agent can search the original conversations by keyword or meaning.
- **Memory is shared, but scoped**: the shared vault is shared across sessions; a persona's vault is shared by all sessions of that persona. Different personas and the shared vault stay isolated.
- **Low context dependency**: only a compact semantic profile, a small working-memory block and the persona block are injected into each prompt. The rest is retrieved when needed, keeping the context window small even after years of history.
- **Manual recall**: you can tell the agent *"search the raw conversations in the vector store for X"*; it calls `memory_recall` (explicit mode) to search L0 + the permanent raw-vector index, then `memory_get_raw` for the full text if needed.

> Rule of thumb: let the plugin keep memory compact automatically; ask it explicitly when you need the exact words of an old conversation.

## Features

### Memory architecture

- **Immutable raw archive (L0)**
  - Append-only JSONL segments with a global SHA-256 hash chain and manifest.
  - Raw segments are physically separated **per session** (`segments/<day>/<sessionKey>/`), so conversations never mix in storage.
  - Raw records (`memory_recall` explicit mode, `memory_get_raw`, panel inspection) are the source of truth and are never rewritten.
- **SQLite derived store** (`node:sqlite`, WAL)
  - `raw_index` mirror of L0, FTS5 full-text search, vector search (cosine), vector cache.
  - Local hash embeddings (`dsh-local-hash-v1`, dim 512) work fully offline; an OpenAI-compatible embedding endpoint is supported as an explicit opt-in.
- **Two orthogonal memory models**
  - **Content layers**: L1 working memory → L2 episodic summaries → L3 semantic profile (preferences, facts, decisions, profile).
  - **Retention tiers**: short → mid → long, with configurable promotion rules, pinning, and forgetting (short-term expiry deletion, mid-term archival). Long-term/pinned memories are not deleted.
- **Access / forgetting split**
  - Explicit retrieval reads the **immutable raw layer + permanent raw-vector index** (never forgotten).
  - Implicit context reads the **derived three-layer memory** (forgettable), so prompt injection stays compact.
- **Conservative semantic extraction**
  - L3 extraction only uses **user messages** and **explicit `memory_save`** calls; tool output, assistant code blocks, URLs and other noisy sources are filtered out.
  - L2 → L3 promotion requires trusted source records.

### Personas

- **Markdown-defined personas**: `<DSH_HOME>/personas/<id>.md` with frontmatter (`name`, `description`, `tags`, `aliases`) and a body used as the system prompt.
- **Hot reload** — edit or add persona files and the roster refreshes without restarting DSH.
- **Panel CRUD** — create, edit, delete (recoverable `.trash/`), activate personas from the Life Memory panel.
- **Isolated vaults** — each persona has its own raw segments, SQLite database, vectors, retention and forgetting state. Persona A cannot see persona B's or the shared vault's data (raw included).
- **Shared vault** — sessions without a persona use `<dataDir>/vaults/shared/`.
- **Strict validation** — invalid definitions are reported with reasons; bodies containing complete `{{…}}` template groups are rejected.

### Session-level controls

- **Per-session switches**: `memory` on/off and `persona` on/off, persisted per `sessionId`.
- **Defaults for new sessions**: memory **on**, persona **off** (shared vault) — configurable, with controls on the new-session page.
- **Semantics**: enabling a persona forces memory on; disabling memory stops capture/injection for that session while the archive stays readable.
- **Current session id** is shown in the in-session Life Memory tab, ready to copy.

### Panel

The Life Memory panel (sidebar icon / `main` slot) provides:

| Tab | What it shows |
| --- | --- |
| Overview | health, raw archive stats, retention/forgetting stats, current vault, session defaults, data-retention notice |
| Memory tiers | short / mid / long counts, promotion and forgetting status |
| Personas | roster, create/edit/delete/activate, per-persona memory counts |
| Raw memory | paginated L0 browser with session/persona metadata, verification |
| Layer stats | L1/L2/L3 counts per persona |
| Search | explicit (raw) and implicit (derived) search |
| Import / export | export/import session and whole-vault archives, rebuild raw index |
| Health / integrity | hash-chain verification, manifest, storage health |

The panel is read-only except for persona editing, session/new-session settings and import/export actions.

### Import / export (append-only)

- **Session archive** (JSONL): header + full L0 records + optional derived-memory lines. Import creates a **new** session id, appends new records, and records `importedFrom` / `originalSessionId` in payloads.
- **Whole-vault archive**: `VERSION`, `manifest.json`, `vault.db` (+ WAL), `segments/**`. Content can be selected as **all / database only / raw memory only**.
- **Never destructive**: imports never delete, overwrite or modify existing memories; importing a vault requires a **new** vault id; importing raw-only data rebuilds the SQLite index from L0.
- **Rebuild raw index**: reconcile/fill `raw_index` from the immutable L0 archive (insert-only) after imports or when integrity is in doubt.

### Tools & HTTP API

- **17 agent tools** for recall, save, status, raw access, layers, personas and session/import-export operations.
- **HTTP API** for the web panel: 16 `GET` endpoints + 7 `POST` endpoints (same-origin, JSON envelope).
- **Zero runtime dependencies** — only Node.js built-ins (`node:sqlite`, `node:crypto`, `node:fs`).

---

## How it works

```
DSH session events ──► capture queue ──► L0 raw archive (append-only, hash-chained, per-session)
                                              │ derive
                                              ▼
                                   SQLite: raw_index + L1/L2/L3 + FTS5 + vectors
                                              │
                        ┌─────────────────────┴─────────────────────┐
                        ▼                                           ▼
             prompt context (implicit memory)              memory tools / HTTP panel
                        ▲
               explicit recall reads L0 directly (never forgotten)
```

1. **Capture**: session events (messages, tool calls/results, notes) are appended to the raw archive.
2. **Derive**: a bucket queue builds L1 atoms, L2 episode summaries and L3 semantic memories; retention promotion and forgetting run on timers.
3. **Serve**: a system-prompt section injects the persona identity block and compact memory context; tools/handlers expose recall and inspection.
4. **Scope**: every operation resolves a vault from the session configuration (shared vault or a persona's vault) and a session id for grouping.

---

## Requirements

- **DeepSeek Harness desktop** `0.2.1-rc.3` or newer (tested with `0.2.1-rc.3` … `0.2.1-rc.5` on Windows).
- Node.js **22.19+ or 24+** runtime (the plugin uses `node:sqlite`; DSH ships a compatible runtime).
- A writable DSH home directory.

---

## Install

### From a release package

```bash
dsh plugin --profile desktop add "./dsh-life-memory-1.1.5.tgz"   # desktop app profile
# or: dsh plugin --profile web add "./dsh-life-memory-1.1.5.tgz"
```

If the `dsh` CLI is not on `PATH`, use the CLI bundled with DSH (`resources/runtime/cli/bin/dsh.cmd` on Windows). After installing, **fully quit and restart DSH Desktop** — the plugin loads at startup, and the sidebar will show **Life Memory** (记忆库).

### From source

```bash
npm install
npm run build        # produces lib/index.js (host) and lib/client.js (web panel)
npm pack             # produces dsh-life-memory-1.1.5.tgz
dsh plugin --profile desktop add ./dsh-life-memory-1.1.5.tgz
```

### Development

```bash
npm run typecheck    # TypeScript, no emit
npm test             # unit tests (tests/run.mjs)
npm run build        # host + client bundles
```

> DSH plugins are loaded by the DSH runtime. This package contains both halves: the host plugin (`lib/index.js`, `src/`) and the web client (`lib/client.js`, `client/src/`).

---

## Quick start

1. Install and restart DSH. Open **Life Memory** from the sidebar.
2. Chat normally — session events are captured automatically; derived memories are built in the background.
3. Ask the agent to remember something explicitly:

   > “记住：这个项目使用 TypeScript ESM，测试用 `node tests/run.mjs`。”

   This calls `memory_save` and is stored as an explicit L3 memory.
4. Use `memory_recall` (or just ask “之前我们约定过什么？”) — explicit recall searches L0 plus its permanent vector index.
5. Open the **Personas** tab, create a persona, click **Use this persona**. That persona now owns a separate vault and its body is injected as the identity block.
6. In any conversation, open the in-session **Life Memory** tab to toggle memory/persona for that session only.
7. New-session page bottom options control the defaults for the next conversation.

---

## What you can do with it

- **Project memory across sessions**: decisions, conventions, commands, API contracts and preferences survive restarts.
- **Multiple working personas with separate memories**: an assistant persona and a coding persona never mix raw data or derived memories.
- **Per-conversation isolation**: turn memory off for a throwaway chat; turn a persona on only where it belongs.
- **Audit and inspect**: browse every raw record, verify the hash chain, inspect how a memory was derived.
- **Search**: full-text (FTS5, CJK-aware) and vector search over raw and derived memories.
- **Backup / migrate**: export a session or a whole vault, move it to another machine, and import it without touching existing history.
- **Recover / rebuild**: rebuild the SQLite raw index from L0 if the database is lost or out of sync.
- **Extend**: layer registry and SQLite schema support additional layers; persona definitions are plain markdown.

---

## Recovering old memories

The agent has first-class tools for this:

```text
You:  search raw conversations for the deployment port and quote the original messages
Agent -> memory_recall({ query: "deployment port", mode: "explicit", limit: 8 })
      -> memory_get_raw({ id: "<raw id>" }) when the exact text is needed
```

- `memory_recall` explicit mode searches the **immutable L0 archive + raw-vector index** and returns citations; implicit mode searches derived layers.
- `memory_get_raw` returns the full original record and verifies its hash.
- Results carry session and persona metadata, so the agent knows which conversation a memory belongs to.
- Because raw data is never deleted, this keeps working for old sessions as long as the archive exists (disk space is the only practical limit).

## Personas

A persona is a single markdown file in `<DSH_HOME>/personas/`:

```markdown
---
name: 小狸
description: 生活助理人格
tags: [assistant]
aliases: [xiaoli]
---

你是一个细心、简洁的生活助理。回答中文，先给结论，再给必要的解释。
```

- The body becomes the persona identity block in the system prompt.
- `id` is the file name without `.md` (or `memory_persona_create` with an explicit id).
- Invalid personas (empty body, malformed frontmatter, complete `{{…}}` template groups) are marked invalid with a reason and cannot be activated.
- Activating a persona switches the default vault; per-session overrides live in session configuration.

---

## Session configuration

`session-config.json` stores the effective configuration per session (default: `memory=true`, `persona=false`):

| Field | Meaning |
| --- | --- |
| `memoryEnabled` | capture + recall + prompt injection for this session |
| `personaEnabled` | use a persona vault instead of the shared vault |
| `personaId` | explicit persona for this session (`null` = follow the globally active persona) |

Defaults for new sessions are stored in the same file; the in-session Life Memory tab and the new-session page write through the `memory_session_config` tool / `POST /session-config`.

---

## Memory tools

| Tool | Purpose |
| --- | --- |
| `memory_recall` | explicit (L0 + raw vectors) or implicit (derived) retrieval |
| `memory_save` | explicit memory save (L3, pinned) |
| `memory_status` | vault, storage, layers, capture/derive, retention, vectors, persona, session |
| `memory_get_raw` | fetch a raw record and verify its hash |
| `memory_layers` | layer registry and counts |
| `memory_persona_list` | persona roster |
| `memory_persona_use` | activate a persona (or `null` to clear) |
| `memory_persona_current` | current persona |
| `memory_persona_reload` | reload persona files from disk |
| `memory_persona_create` | create a persona markdown file |
| `memory_persona_update` | edit a persona |
| `memory_persona_delete` | delete a persona (moved to `.trash/`, recoverable) |
| `memory_session_config` | read/write per-session switches |
| `memory_export_session` | export a session's raw archive (JSONL) |
| `memory_import_session` | import a session archive (append-only, new session id) |
| `memory_export_vault` | export a whole vault (all / database / raw only) |
| `memory_import_vault` | import a vault archive into a new vault id |

---

## HTTP API

The web panel talks to the same-origin API under `/api/life-memory` (configurable via `http.basePath`).

**GET (16)** — `health`, `status`, `layers`, `stats-layers`, `raw`, `raw-detail`, `raw-verify`, `memories`, `memory-detail`, `search`, `manifest`, `integrity`, `retention`, `personas`, `vaults`, `session-config`.

**POST (7)** — `personas`, `personas/update`, `personas/delete`, `personas/activate`, `session-config`, `transfer`, `rebuild`.

Responses use `{ ok: true, data: … }` / `{ ok: false, error: { code, message } }`. Writes require the DSH same-origin session; anonymous requests are rejected by the host.

---

## Configuration

All options live under the plugin config (defaults shown):

| Option | Default | Description |
| --- | --- | --- |
| `enabled` | `true` | master switch |
| `dataDir` | `<DSH_HOME>/life-memory` | plugin data root |
| `timezone` | host timezone | used for day buckets and timestamps |
| `capture.enabled` | `true` | capture DSH session events |
| `embedding.provider` | `local` | `local` hash embeddings or `openai-compatible` |
| `embedding.model` / `dim` | `dsh-local-hash-v1` / `512` | embedding model reference |
| `embedding.baseURL`, `apiKeyEnv`, `timeoutMs`, `batchSize` | — | remote embedding settings (requires `safety.allowNetwork`) |
| `layers.enabled` | `[L1, L2, L3]` | derived layers to build |
| `recall.enabled` | `true` | enable prompt injection and recall |
| `recall.promptBudgetTokens`, `toolDefaultLimit` | built-in budgets | context/tool limits |
| `retention.enabled` | `true` | short/mid/long promotion |
| `retention.shortTermDays`, `longTermAfterDays` | `7`, `90` | retention thresholds |
| `vectors.enabled` | `true` | raw-index vector pipeline |
| `forgetting.enabled` | `true` | short-term expiry deletion, mid-term archival |
| `persona.enabled` | `true` | enable personas |
| `persona.dir` | `<DSH_HOME>/personas` | persona markdown directory |
| `persona.maxBodyChars` | `20000` | maximum persona body length |
| `http.enabled` / `basePath` | `true` / `/api/life-memory` | panel API |
| `ui.enabled` | `true` | web panel |
| `safety.allowNetwork` | `false` | allow remote embedding calls |
| `safety.redactSecretsInDerived` | `true` | redact detected secrets from derived text |
| `consolidation.enabled` | `false` | optional long-memory consolidation |

Example (adapt to your DSH config format):

```json
{
  "life-memory": {
    "dataDir": "<DSH_HOME>/life-memory",
    "recall": { "promptBudgetTokens": 1200 },
    "retention": { "shortTermDays": 7, "longTermAfterDays": 90 },
    "persona": { "enabled": true },
    "safety": { "allowNetwork": false }
  }
}
```

---

## Data layout

```
<DSH_HOME>/personas/<personaId>.md          # persona definitions
<dataDir>/
├─ vaults/
│  ├─ shared/                               # shared vault
│  │  ├─ vault.db (+ -wal/-shm)             # raw_index + L1/L2/L3 + FTS/vectors
│  │  ├─ manifest.json / VERSION            # segment manifest + layout version
│  │  └─ segments/<day>/<sessionKey>/*.jsonl # immutable L0, per session
│  └─ <personaId>/                          # isolated persona vault (same layout)
├─ exports/                                 # generated archives (sessions/, vaults/)
├─ session-config.json                      # per-session switches + new-session defaults
├─ active-persona.json                      # globally active persona
├─ runtime-load.json                        # last load diagnostics
└─ legacy-*/                                # old-layout archives (read-only, if present)
```

Raw L0 files are append-only; the derived database can be deleted and rebuilt from them.

---

## Privacy & safety

- **Local only**: no telemetry, no remote service by default. All data lives under `dataDir`.
- **Raw is immutable**: capture never rewrites or deletes L0 records; deletion is a manual filesystem action.
- **Explicit derivation**: L3 extraction only uses user messages and `memory_save`; secrets are redacted from derived memories and prompts by default (raw keeps the original).
- **Network off by default**: `safety.allowNetwork=false`; remote embeddings must be explicitly enabled and configured.
- **Append-only imports**: imports never modify existing data; archives are validated (format/version/hash chain) before writing.
- **Deleting data**: fully quit DSH, then remove `<dataDir>` (back up/export first). The panel shows the exact path.

---

## Limitations & roadmap (v1)

- Semantic extraction (L3) is rule-based and deliberately conservative; some statements are not extracted unless saved explicitly.
- One globally active persona (sessions can override via session configuration); persona management is a single-user feature.
- The panel is primarily a read-only inspector; direct edits are limited to personas, session/new-session settings and import/export actions.
- Consolidation of long-term memories is disabled by default and considered experimental.
- Tested on Windows with DSH `0.2.1-rc.3`–`rc.5`; other platforms are expected to work but not yet validated.
- OpenAI-compatible embeddings are optional and require network access; they are not required for normal use.

Planned directions: richer consolidation, embedding-model migration tooling, better semantic extraction, and multi-persona concurrency.

---

## Contributing

Issues and pull requests are welcome.

- Keep the invariants: L0 append-only and hash-chained; derived data rebuildable; imports non-destructive.
- Run `npm run typecheck`, `npm test` and `npm run build` before opening a PR.
- Persona definitions and docs are plain markdown — contributions are easy to review.

---

## License

MIT © 2026 **hanxustu**. See [LICENSE](LICENSE) and [NOTICE](NOTICE).

DSH and DeepSeek Harness are products of DeepSeek; this project is an independent community plugin and is not affiliated with or endorsed by DeepSeek.

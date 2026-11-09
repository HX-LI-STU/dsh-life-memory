# Changelog

## v1.2.0

### Added

- **Capture scope switch**: default capture is now compact — only the final
  user input and the final assistant answer are archived. Reasoning, tool
  calls/results, system messages and lifecycle events are skipped.
- The switch is available in both the in-session panel
  ("记录完整原始事件") and the new-session defaults row ("全量原始"); the
  selection is stored per session / as the new-session default.
- Full capture mode preserves the previous complete-event behaviour and is
  opt-in.
- Compact records store a text-only payload (no reasoning/tool-call content),
  so the raw archive stays small and privacy-friendly.

## v1.1.9

### Changed

- Removed the standalone "开启记忆时默认补档本会话历史" switch from the
  session panel; the backfill decision is made only in the confirmation dialog
  each time memory/persona is enabled (default: off).
- The dialog warns that enabling persona + backfill can duplicate history across
  the shared and persona vaults.

### Fixed

- The session panel now detects an old Host that has not loaded the v1.1.8
  backfill protocol and shows a clear "please restart DSH" notice instead of
  silently ignoring the dialog choice (this was why backfill appeared to do
  nothing after a client-only refresh).

## v1.1.8

### Added

- **Confirmation dialog + switch when enabling memory**: turning memory (or a
  persona) on now opens a dialog asking whether to backfill the current
  session's existing history (earlier user messages, replies and tool events).
  The dialog has its own switch so the decision is explicit every time.
- **Persistent preference switch**: "开启记忆时默认补档本会话历史" in the
  session panel sets the default answer for future confirmations. Default: off
  (only capture events from the moment memory is enabled).
- Tool/API support: `memory_session_config` accepts `backfill`; the session
  config HTTP API accepts `backfill` (action) and `backfillOnEnable` (default
  preference), and returns `backfillOnEnable` in session/default views.

### Changed

- Backfill is no longer automatic on every memory enable; it only runs when the
  user (or an agent tool call) explicitly chooses it.

## v1.1.7

### Added

- **Backfill session history when memory is enabled mid-session**: turning
  memory back on now archives the session's existing events (user messages,
  assistant messages, tool calls/results) into L0, so user messages sent before
  the switch are not lost. Idempotent and bounded by the same smart-capture rules.
- The plugin also performs an idempotent backfill for sessions already present
  when it loads/hot-reloads, covering sessions started before the plugin loaded.

### Fixed

- Clarified and enforced the "memory off" semantics: after disabling memory the
  session stops capturing new events, prompting and recall; already archived L0
  records remain immutable (append-only) and are never deleted automatically.
- Session panel now states the above so "关闭记忆后仍有旧记录" is explained
  in-product.

## v1.1.6

### Added

- **Persona sessions can read the shared vault on demand**: `memory_recall` and
  `memory_get_raw` accept `vault: "shared"` and return a `vault` field in their
  results. Other persona vaults remain inaccessible (`E_BAD_ARGS`), preserving
  persona isolation.
- Shared-vault read access is also documented in the README with usage examples.

### Fixed

- **Session panel now shows the vault actually used by the session**: when
  `persona` is off, it displays the shared vault instead of the globally active
  persona vault, and explains that global persona activation only takes effect
  after "use persona in this session" is enabled.
- The session panel's "unsaved configuration" note now shows the real
  `memory` / `persona` defaults instead of a hard-coded `memory=true / persona=false`.


# Live session monitor for the SSSF visualizer

**Goal:** one web tab that shows every coding-agent session on this machine in real time —
interactive Claude Code sessions, Codex sessions (TUI and `exec`), and by extension every
SSSF ADW run (their headless agents write the same transcripts). Answers three questions
at a glance: what is running, what is stalled, what waits on me.

**Date:** 2026-08-13 · **Branch:** `feat/live-session-monitor`

## Why

- The visualizer only reads `sssf.db`, so it only sees ADW factory runs.
- Interactive sessions are invisible: Chris cannot tell what is running, stalled, or done.
- Both CLIs already stream live JSONL transcripts to disk. No hooks, no daemon, no ingest
  needed — the visualizer server can tail the files at poll time.

Dismissed alternative: a separate ingest daemon that mirrors transcripts into SQLite,
or Claude Code hooks that POST events. Both add a moving part and a failure mode; the
poll-time tail gives the same answer with zero deployment.

## Sources (verified 2026-08-13, claude 2.1.222, codex 0.147.0)

- **Claude Code:** `~/.claude/projects/<project-slug>/<session-uuid>.jsonl`, one line per
  event. Lines carry `type` (`user` | `assistant` | `system` | `summary` | …),
  `timestamp`, `cwd`, `gitBranch`, `version`, `sessionId`, `isSidechain`. Assistant lines
  carry `message.model`, `message.usage` (`input_tokens`, `cache_read_input_tokens`,
  `cache_creation_input_tokens`, `output_tokens`), and content blocks
  (`thinking` | `text` | `tool_use`). User lines may carry `tool_result` blocks.
- **Codex:** `~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl`. Lines:
  `session_meta` (cwd, `originator` e.g. `codex_exec`, cli_version), `turn_context`
  (model, cwd), `response_item` (messages, reasoning, function calls),
  `event_msg` with `payload.type` ∈ {`task_started`, `task_complete`, `agent_message`,
  `user_message`, `token_count` (total_token_usage + model_context_window),
  `patch_apply_end`, …}.

## Design

Everything lives in the visualizer app (`.claude/skills/sssf/apps/visualizer/`).

### Server: `server/live.ts`

- Scans both roots at request time for `*.jsonl` with mtime inside the window
  (`?hours=`, default 24). Codex date directories are pruned by path before statting.
- Incremental tail: an in-memory cache per file (byte offset + accumulated state).
  On growth, parse only new complete lines; malformed/partial lines are skipped.
- Accumulated state per session: id, source, cwd, git branch, model, title (first real
  user message), last activity timestamp, last event label, turn open/closed, tool calls,
  turn count, context tokens vs window, token totals.
- Status heuristic, shared across sources:
  - `working` — a turn is open (Claude: last event is a tool_use/tool_result or thinking;
    Codex: `task_started` with no matching `task_complete`) and last write < 10 min ago.
  - `stalled` — a turn is open but the file has not grown for ≥ 10 min.
  - `waiting` — the turn is closed (final assistant text / `task_complete`); the session
    waits on the user.
  - `idle` — turn closed and no activity for ≥ 1 h.
- Endpoints (read-only, same polling philosophy as the rest of the server):
  - `GET /api/live/sessions?hours=24` → `LiveSessionSummary[]`
  - `GET /api/live/sessions/:source/:id?limit=120` → summary + normalized activity feed
    (user / assistant / tool / error entries with timestamp, label, detail snippet).

### UI

- Hash routes: `#/live` (list) and `#/live/<source>/<id>` (detail). Tabs in the topbar:
  **factory** (existing sessions view) · **live**.
- `LiveList.vue` — poll every 2 s; sections in severity order: stalled, working, waiting,
  idle. Card: source logo (claude/openai icons already in `public/models/`), project
  (basename of cwd), branch, model, status chip, age since last activity, last event
  line, context-occupancy bar, turn/tool counts.
- `LiveDetail.vue` — poll every 2 s; header meta + the activity feed, newest at the
  bottom.

## Steps

1. `shared/types.ts` — live types (summary, detail, activity entry, status).
2. `server/live.ts` — scanner, both parsers, status logic.
3. `server/index.ts` — the two routes.
4. UI: router + App tabs + `LiveList.vue` + `LiveDetail.vue` + `src/lib/api.ts` fetchers.
5. Gates: `bun run typecheck`, `lint`, `build`.
6. Smoke: curl both endpoints against this machine's real transcripts; verify this very
   session shows `working`, and an old one shows `idle`.

## Out of scope

- Killing/steering sessions from the UI (read-only stays read-only).
- Gemini/pi transcript parsing; other machines' sessions.
- Merging live sessions with ADW trace rows into one timeline (the factory tab already
  covers ADW runs; a headless agent's transcript also appears in live).

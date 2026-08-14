# Factory process visibility

The visualizer now exposes the tracer's per-run process records in the factory view. For a selected session, the UI can show each supervised process's status, kind, name, PID, command, and start time. A null `ended_at` is presented as alive with a pulsing green marker and highlighted row; completed processes show their end time. Empty or older databases remain unobtrusive because the server returns no rows when the optional `processes` table is absent, and the panel is hidden when no process data exists.

Active sessions refresh process data through the factory view's existing polling cycle, so process liveness can update even when no corresponding event arrives. Finished sessions reload process data on initial load and event boundaries. The client also treats a 404 from an older visualizer server as an empty process list.

`phase_start` events now have a first-class event treatment: amber timeline/type coloring, a description-aware collapsed label, and structured kind, owner, and description fields in expanded phase detail. Unparseable legacy payloads continue to fall through to the raw payload view.

## Files carrying the change

- `.claude/skills/sssf/apps/visualizer/server/db.ts` adds optional-table detection and an ordered, parameterized process query for an `adw_id`.
- `.claude/skills/sssf/apps/visualizer/server/index.ts` exposes `GET /api/sessions/:adw_id/processes` beside the existing session endpoints.
- `.claude/skills/sssf/apps/visualizer/shared/types.ts` defines the process row, processes response, and parsed `phase_start` payload contracts.
- `.claude/skills/sssf/apps/visualizer/src/lib/types.ts` re-exports the new UI-facing types.
- `.claude/skills/sssf/apps/visualizer/src/lib/api.ts` adds the process endpoint client with backward-compatible 404 handling.
- `.claude/skills/sssf/apps/visualizer/src/lib/events.ts` parses `phase_start` payloads, assigns their amber event-dot color, and builds descriptive labels.
- `.claude/skills/sssf/apps/visualizer/src/components/ProcessesPanel.vue` renders the responsive process table and distinct alive/dead states.
- `.claude/skills/sssf/apps/visualizer/src/components/SessionTrace.vue` owns process state, refreshes it on the established cadence, and mounts the panel between the trace and phase detail.
- `.claude/skills/sssf/apps/visualizer/src/components/PhaseDetail.vue` renders structured `phase_start` metadata and amber event text.
- `specs/84e11b3f_visualizer-process-panel.md` records the implementation plan, boundaries, database shape, and verification procedure used for this work.

## Use and verification

1. From `.claude/skills/sssf/apps/visualizer/`, run `bun run build` to exercise Vue type-checking and the Vite production build, then run `bun run lint`.
2. Start the existing visualizer server with `SSSF_DB` pointing at `adws/adw_data/sssf.db`. Request `/api/sessions/8c5a2e77/processes` and confirm it returns a JSON array containing process fields including `kind`, `name`, `pid`, `command`, `started_at`, and `ended_at`. An unknown session ID should return `[]`.
3. Start the existing `just obs` setup and open a historical run in the factory tab. Confirm the process panel appears for a run with process rows, completed rows show an end time, and commands expose their full text on hover when truncated.
4. Expand a `phase_start` event and confirm its kind, owner, and description render as labeled fields with amber event treatment. Check that the existing session list, phase selection, and live tab still operate normally.


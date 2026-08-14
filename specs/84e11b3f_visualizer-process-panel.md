# Plan: Surface the live process table in the visualizer's factory tab

## Objective

The tracer writes a `processes` table into the sqlite trace db (`adws/adw_data/sssf.db`).
The visualizer (`.claude/skills/sssf/apps/visualizer`) doesn't show it. Add:

1. A `GET /api/sessions/:adw_id/processes` endpoint on the bun server, following the
   existing route pattern.
2. A "processes" panel on the factory tab (the selected-run view, `SessionTrace.vue`):
   one row per process — kind, name, pid, command, started_at, live/dead indicator
   (`ended_at IS NULL` = alive). Alive rows visually distinct. Refreshes on the
   existing 500ms poll while the run is active.
3. A rendered treatment for `phase_start` events in the event views instead of the
   generic/raw JSON fallthrough.

## Boundary

Work ONLY inside `.claude/skills/sssf/apps/visualizer/`. Do NOT touch `adws/`,
`templates/`, the `justfile`, or any skill markdown. No new data path — a sibling
endpoint next to `/gates` and `/envelopes`, consumed by the same poll loop.

## Ground truth (verified against the live db)

Schema of `processes` in `adws/adw_data/sssf.db`:

```sql
CREATE TABLE processes (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  adw_id        TEXT REFERENCES sessions,
  kind          TEXT,   -- 'adw' (the workflow process) | 'agent' (a coding-agent child)
  name          TEXT,   -- '' for the adw, the agent name for a child
  pid           INTEGER,
  command       TEXT,   -- what the pid was, so a recycled pid is not killed by mistake
  started_at    TEXT, ended_at TEXT  -- ended_at NULL = believed alive
);
```

Historical adw_ids with rows you can verify against: `8c5a2e77` (adw + planner +
builder), `b3d01ffb`, `92b07399`, `d430734e`.

`phase_start` payload_json shape (from real rows):
`{"kind": "engineer"|"agent"|"code", "owner": "<name>", "description": "<text>"}`.

Important: **older dbs may not have the `processes` table at all.** The db is opened
readonly; follow the same defensive philosophy as `optionalColumn()` in
`server/db.ts` — probe, and treat "table absent" as "no rows", never an error.

## Files to change (all under `.claude/skills/sssf/apps/visualizer/`)

### 1. `shared/types.ts`

- Add, near the other table-mirror interfaces:

```ts
/** processes — one row per OS process the tracer supervised for a run. */
export interface ProcessRow {
  id: number;
  adw_id: string;
  /** 'adw' = the workflow process itself; 'agent' = a coding-agent child. */
  kind: string | null;
  /** '' for the adw process, the agent name for a child. */
  name: string | null;
  pid: number | null;
  /** The command line the pid was started as. */
  command: string | null;
  started_at: string | null;
  /** NULL = believed alive. */
  ended_at: string | null;
}

/** GET /api/sessions/:adw_id/processes */
export type ProcessesResponse = ProcessRow[];
```

- In the payload-shapes section, add the parsed `phase_start` shape:

```ts
/** Parsed `phase_start` payload — the phase's declared identity. */
export interface PhaseStartPayload {
  kind?: string;
  owner?: string;
  description?: string;
}
```

### 2. `server/db.ts`

- Add a latching `hasTable(table: string)` probe alongside `hasColumn` (query
  `sqlite_master`: `SELECT name FROM sqlite_master WHERE type='table' AND name=?`;
  cache like `columnCache`, re-probe while false — the tracer can create the table
  mid-serve, and once seen it never goes away).
- Add the reader:

```ts
processes(adwId: string): ProcessRow[] {
  if (!this.hasTable("processes")) return [];
  return this.db
    .query<ProcessRow, [string]>(
      `SELECT id, adw_id, kind, name, pid, command, started_at, ended_at
         FROM processes WHERE adw_id = ? ORDER BY started_at, id`,
    )
    .all(adwId);
}
```

- Import/`ProcessRow` type from `../shared/types.ts`.

### 3. `server/index.ts`

- One route, placed next to `/gates` — identical shape:

```ts
"/api/sessions/:adw_id/processes": safely((req) =>
  json(db.processes(param(req, "adw_id"))),
),
```

(No `isSafeSegment` needed — like `/events`, `/gates`, `/envelopes`, the param only
ever reaches a parameterized SELECT, never the filesystem.)

### 4. `src/lib/types.ts`

- Re-export `ProcessRow` and `PhaseStartPayload` from the shared contract (this file
  is the single switch point; the UI imports from here).

### 5. `src/lib/api.ts`

- Add, mirroring `fetchGates` but resilient to an older running server:

```ts
export async function fetchProcesses(adwId: string): Promise<ProcessRow[]> {
  const res = await fetch(`/api/sessions/${encodeURIComponent(adwId)}/processes`)
  // A server predating the endpoint 404s — that renders as "no processes", not an error.
  if (res.status === 404) return []
  if (!res.ok) throw new Error(`GET processes → ${res.status}`)
  return (await res.json()) as ProcessRow[]
}
```

### 6. `src/lib/events.ts`

- Add a parser next to `parseAgentStart`:

```ts
export function parsePhaseStart(e: EventRow): PhaseStartPayload | null {
  return parsePayload(e.payload_json) as PhaseStartPayload | null
}
```

- Add `phase_start: '#e8b64a'` (amber — the engineer/phase-boundary color) to
  `EVENT_DOT_COLORS`, so phase boundaries also read on the L1 card timelines.
  (Events without a dot color are skipped there today; a handful of phase starts
  per run is signal, not clutter.)

### 7. NEW `src/components/ProcessesPanel.vue`

- Props: `{ processes: ProcessRow[] }`. Render nothing (`v-if` in the parent or an
  early empty state) when the list is empty — dbs predating the table stay clean.
- Layout: a panel styled like the existing surfaces (`border: 1px solid
  var(--border-soft); border-radius: 16px; background: var(--surface); margin: 0 28px 20px`),
  with a lowercase heading matching PhaseDetail's `h3` treatment ("processes (N)").
- One row per process, mono font (`var(--mono)`), columns:
  - **live/dead indicator**: alive (`ended_at === null`) → a green pulsing dot
    (reuse the `pulse` keyframes pattern + `var(--green)` glow, same as the topbar
    `live-dot`) and the word `alive`; dead → a static faint dot (`var(--faint)`)
    and `ended <clock time>` (use `fmtClock` from `src/lib/format.ts`).
  - **kind**: `adw` | `agent` (fixed-width column).
  - **name**: agent name; render `—` or the adw script hint for the `''` adw row.
  - **pid**.
  - **command**: truncated with ellipsis, full text in `title=`.
  - **started_at** via `fmtClock`.
- Alive rows visually distinct beyond the dot: e.g. a soft green left border /
  tinted row background (`rgba` of `var(--green)`), consistent with how gate
  pass/fail rows use a colored `border-left`.

### 8. `src/components/SessionTrace.vue`

- State: `const processes = ref<ProcessRow[]>([])`.
- In `tick()`, fetch processes on the existing cadence. Recommended rule (keeps the
  side-table optimization intact while a finished run stays cheap):

```ts
const boundary = fresh.some((e) => e.type !== null && SIDE_TABLE_TYPES.has(e.type))
if (!loaded.value || boundary) { /* existing envelopes+gates refetch */ }
// Processes: liveness changes tick-to-tick while the run is active (the watchdog
// can close a row without a matching event), so poll them while running and
// resync on boundaries otherwise.
if (!loaded.value || boundary || session.value?.status === 'running') {
  processes.value = await fetchProcesses(props.adwId)
}
```

  (Folding `fetchProcesses` into the existing `Promise.all` when both conditions
  overlap is fine — builder's choice; the requirement is simply that an active run
  refreshes the panel on the same 500ms poll.)
- Template: render `<ProcessesPanel v-if="processes.length" :processes="processes" />`
  between the waterfall and `<PhaseDetail>`.

### 9. `src/components/PhaseDetail.vue` — `phase_start` rendered treatment

- `typeClass`: add `phase_start: 't-amber'` and define `.t-amber { color: var(--amber); }`
  in the scoped style block (var exists in `src/style.css`).
- Expanded panel: before the generic `v-else-if="e.payload_json"` raw-JSON branch,
  add a branch for `e.type === 'phase_start'` with a parsed payload
  (`parsePhaseStart(e)`), rendering the three fields as labeled rows reusing the
  existing `cfg` / `cfg-row` / `cfg-k` classes:
  - `kind` → value (plain text or a `cfg-chip`)
  - `owner` → value
  - `description` → value
  Fall through to the raw branch when the payload doesn't parse (legacy rows).
- Optional polish, same spirit: in `eventLabel` (`src/lib/events.ts`), for
  `phase_start` return `"<name> — <description>"` when the payload carries a
  description, so the collapsed row already reads as a sentence. Keep it to one
  line via the existing `oneLine()` helper.

## Out of scope / name-and-dismiss

- No kill button, no `/processes` write actions — the factory-tab table is
  read-only display (the live tab already owns kill/nudge).
- No websocket/SSE, no new polling loop — the 500ms `tick()` already exists.
- No `phase_end` special-casing beyond what exists; the ask is `phase_start` only.

## Verification (definition of done)

All from `.claude/skills/sssf/apps/visualizer/`:

1. `bun install` (if needed), then `bun run build` — runs `vue-tsc --noEmit` +
   `vite build`; must exit 0. Also `bun run lint` (oxlint) should stay clean.
2. Endpoint against a historical run (from the repo root):
   `SSSF_DB=$PWD/adws/adw_data/sssf.db bun run .claude/skills/sssf/apps/visualizer/server/index.ts &`
   then `curl -s localhost:4600/api/sessions/8c5a2e77/processes` → JSON array with
   ≥2 rows (adw + planner/builder), each carrying kind/name/pid/command/started_at/ended_at.
   Also confirm an unknown id returns `[]` (not an error). Kill the server after.
3. UI: `just obs` from the repo root (or `bun run dev:all` with `SSSF_DB` set) —
   open a historical run in the factory tab: the processes panel renders (all rows
   dead, no pulse), phase blocks/detail still work, `phase_start` events show the
   amber type tag and the parsed kind/owner/description panel when expanded, and
   the live tab + sessions list are unbroken.
4. Report every changed file (expected: `shared/types.ts`, `server/db.ts`,
   `server/index.ts`, `src/lib/types.ts`, `src/lib/api.ts`, `src/lib/events.ts`,
   `src/components/ProcessesPanel.vue` (new), `src/components/SessionTrace.vue`,
   `src/components/PhaseDetail.vue`).

## Notes for the builder

- Judge commands by exit status only; the repo is on WSL — prefer `tr` over `sed`
  for CR stripping if it ever comes up.
- The server opens the db readonly; never add a write for this feature.
- Match the codebase's voice: comments explain *why* (see existing files), UI copy
  is lowercase, sizes/colors come from `src/style.css` vars.
- Commit on a branch (never the default branch), and commit/push as part of the task.

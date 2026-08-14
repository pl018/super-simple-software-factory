# Fix three stale observability claims in README.md

## Scope

Edit **only** the top-level `README.md`. Do not touch `templates/`, any Python, the justfile, or anything under `.claude/skills/`. Keep the README's existing voice (declarative, bolded key terms, short punchy sentences) and formatting.

## Verified facts (checked against code 2026-08-13)

1. **"Read-only UI" + port claim (README line 273) is stale.**
   - `.claude/skills/sssf/apps/visualizer/server/index.ts` exposes three mutating endpoints:
     - `POST /api/sessions/:adw_id/archive` (line 220) — sets one review flag on a row.
     - `POST /api/live/sessions/:source/:id/kill` (line 159) — sends a signal to the session's process.
     - `POST /api/live/sessions/:source/:id/nudge` (line 187) — fires a one-shot resume at a **dead** session only ("nudge only fires when no process owns the session", line 201).
   - Ports: API server defaults to **4600** (`PORT ?? 4600`, index.ts line 26); the Vite dev UI runs on **4601** (index.ts line 291; justfile `obs` recipe comment line 104: "http://localhost:4601 (api on :4600)"; `cookbooks/run_adw.md` line 122: "viz-api :4600 + viz-ui :4601").
   - The trace/data path *reads* really are non-blocking (WAL, cursor polls — README line 269 already says so), so the honest scoping is: reads never block runs; the mutating endpoints exist but are manual operator actions, not anything the pipeline calls.

2. **Live-status list (README line 283) omits `dead`.**
   - `shared/types.ts` line 325: `export type LiveStatus = "working" | "stalled" | "dead" | "waiting" | "idle"`.
   - Doc comment (types.ts lines 317–323): *working* — turn open, file grew recently; *stalled* — turn open, file stopped growing, but a matching process still exists; *dead* — turn open, file stopped growing, and NO matching process; *waiting* — turn closed, waiting on the user; *idle* — turn closed, no activity for a long while.
   - `server/live.ts` line 553 confirms the stalled/dead split: `return match?.kind === "none" ? "dead" : "stalled"`.

3. **Stalled-session remedies are undocumented.** The same paragraph (line 283) mentions **stalled** sessions but not what to do about one. Two manual remedies exist:
   - The **kill** and **nudge** actions in the live tab (the POST endpoints above; nudge applies to *dead* sessions specifically).
   - `just kill <adw_id>` for ADW runs (justfile lines 82–97: looks up live pids in the `processes` table, SIGTERMs children first).

## Changes to make

All in `README.md`, section "The trace".

### Change 1 — line 273 (ports + read-only scoping)

Current:

> The skill ships a read-only UI for this db at `.claude/skills/sssf/apps/visualizer/`: Vue and Vite served by Bun on port 4600, with sessions, a trace waterfall, and per-phase tool-call detail.

Rewrite so that:
- The two ports are stated correctly: **API server on 4600, Vite UI on 4601**.
- "Read-only" is scoped honestly rather than deleted wholesale: reads never block runs (WAL + polling), and the only writes are a handful of manual operator actions — archiving a session, and kill/nudge on live sessions — never anything a run triggers itself.

Suggested wording (builder may adjust to taste, keeping the voice):

> The skill ships a UI for this db at `.claude/skills/sssf/apps/visualizer/`: Vue and Vite served by Bun — API server on port 4600, Vite UI on 4601 — with sessions, a trace waterfall, and per-phase tool-call detail. Reads never block runs; the only writes are manual operator actions (archive a session, kill or nudge a live one), never anything a run triggers itself.

### Change 2 — line 283 (add `dead` to the status list)

Current status list: "**stalled** (a turn is open but the transcript stopped growing), **working**, **waiting on you**, and **idle**."

Update it to include all five statuses, matching `LiveStatus`. Keep the parenthetical-gloss style. `stalled` vs `dead` distinction: stalled = transcript stopped growing but the CLI process is still there; dead = turn open but the CLI process is gone. Order can mirror the code (working, stalled, dead, waiting, idle) or keep the README's severity-first flavor — builder's choice, but all five must appear and the `dead` gloss must convey "turn open but the CLI process is gone".

### Change 3 — same paragraph (stalled/dead remedies)

Append one sentence to the line-283 paragraph noting the two manual remedies, e.g.:

> A stuck session has two manual levers: the kill/nudge actions on its card in the live tab, and `just kill <adw_id>` for ADW runs.

(Nudge specifically targets dead sessions — fine to leave that nuance implicit, but do not claim nudge works on merely-stalled ones.)

### Change 4 (consistency, same file, optional but recommended)

Line 296, in the "What is in this branch" tree, the comment reads `# the read-only trace UI (Vue + Vite on Bun)`. That repeats the same stale claim. Drop "read-only" there (e.g. `# the trace UI (Vue + Vite on Bun)`). Still README.md-only, so in scope.

## Verification

1. `grep -n "4600\|4601" README.md` — line ~273 shows both ports correctly attributed (API 4600, UI 4601).
2. `grep -n "read-only" README.md` — no remaining unscoped "read-only" claim about the visualizer.
3. `grep -n "dead" README.md` — the live-status list includes it with the "process is gone" gloss.
4. `grep -n "just kill" README.md` — the remedies sentence is present.
5. `git diff --stat` — exactly one file changed: `README.md`.

No build/typecheck gates apply (docs-only change).

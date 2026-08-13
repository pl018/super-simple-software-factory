# Plan: add a `kill` recipe to the justfile

## Context

Docs and code reference `just kill <adw_id>`, but the recipe does not exist:

- `.claude/skills/sssf/cookbooks/run_adw.md:111` — `just kill <adw_id>  # stop it — children first, then the workflow`
- `adws/adw_modules/session.py:24` — the `_finalize_when_killed` docstring assumes `just kill` sends SIGTERM, which the handler turns into a clean SystemExit that finalizes the trace and closes process rows.
- The justfile's own header comment lists `kill` among recipes "on the example branch", i.e. currently absent here.

The `processes` table in `adws/adw_data/sssf.db`:

```sql
CREATE TABLE processes (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  adw_id     TEXT REFERENCES sessions,
  kind       TEXT,     -- 'adw' (the workflow process) | 'agent' (a coding-agent child)
  name       TEXT,
  pid        INTEGER,
  command    TEXT,
  started_at TEXT, ended_at TEXT   -- ended_at NULL = believed alive
);
```

## Scope

Change **only** the `justfile` at the repo root. No Python, no docs, no db changes.

## Change

### 1. Add the `kill` recipe

Place it in the `── watch it ──` section, directly after the `procs` recipe (it operates on the same rows `procs` displays). Match existing style: short lowercase name, `ADW_ID` positional parameter like `phases`/`tail`/`procs`, the `{{db}}` variable, and a one-line summary comment directly above the recipe (only the last comment line shows in `just --list`).

Because this needs a loop and a conditional, use a shebang recipe (the only one in the file, but the standard `just` way to get multi-line shell):

```just
# stop a running ADW, children first: just kill <adw_id>
kill ADW_ID:
    #!/usr/bin/env bash
    set -euo pipefail
    pids=$(sqlite3 {{db}} "select pid from processes where adw_id='{{ADW_ID}}' and ended_at is null order by (kind='adw'), id;")
    if [ -z "$pids" ]; then
        echo "no live processes for {{ADW_ID}} — nothing to kill"
        exit 0
    fi
    for pid in $pids; do
        if kill -TERM "$pid" 2>/dev/null; then
            echo "sent SIGTERM to $pid"
        else
            echo "pid $pid already gone"
        fi
    done
```

Design notes the builder should preserve:

- **Query**: `adw_id` match + `ended_at is null` — exactly the "believed alive" rows, same predicate `procs` uses.
- **Order**: `order by (kind='adw'), id` puts `agent` children before the `adw` workflow row, matching the documented "children first, then the workflow". (`kind='adw'` evaluates to 0 for agents, 1 for the adw.)
- **Signal**: SIGTERM, never SIGKILL — `_finalize_when_killed` in `adws/adw_modules/session.py` relies on SIGTERM to finalize the trace and close process rows.
- **No live rows**: print the clear message and `exit 0` — not an error.
- **Stale pids**: a row can outlive its process (crash before `ended_at` was written). `kill -TERM ... 2>/dev/null` with the else-branch message keeps the recipe from failing mid-loop under `set -e`.
- **Interpolation style**: use `{{ADW_ID}}` inside the SQL string, same as `phases`/`tail`/`procs`. Do not "improve" it with quoting/escaping machinery — matching the file's existing style is the requirement.
- Do **not** implement the cookbook's pid-recycle command-verification here; the prompt scopes this recipe to query + SIGTERM. Leave that to a future change if wanted.
- No leading `@` on the shebang line (shebang recipes ignore it anyway); the echo output is the point of the recipe.

### 2. Update the justfile header comment

The header currently reads `...(orchestrator agents, kill, rosters, ipi)` — a list of recipes *not* present here. With `kill` now defined, drop it from that list so the comment stays true:

```
# example branch for the fuller set (orchestrator agents, rosters, ipi).
```

This is still a justfile-only change.

## Verification

1. `just --list` — exits 0; `kill` appears with summary `stop a running ADW, children first: just kill <adw_id>`.
2. `just kill no-such-id` — exits 0 and prints `no live processes for no-such-id — nothing to kill`.
3. Optional live test: start `just demo` (or any workflow) in the background, grab its adw_id from `just sessions`, run `just kill <adw_id>`, then confirm `just procs <adw_id>` returns no rows (the SIGTERM handler closes the process rows).
4. `git diff --stat` shows only `justfile` changed.

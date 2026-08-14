# README observability corrections

The top-level observability documentation now describes the visualizer as an operator UI rather than a wholly read-only interface. It assigns the API server to port 4600 and the Vite UI to port 4601, while preserving the important runtime guarantee: reads do not block runs. The write operations are explicitly limited to manual session archive, kill, and nudge actions.

The live-session section now lists all five displayed states: **working**, **stalled**, **dead**, **waiting on you**, and **idle**. It distinguishes a stalled session, whose CLI process remains, from a dead session, whose open turn has lost its CLI process. It also tells operators how to intervene from the live-tab card or, for an ADW run, with `just kill <adw_id>`.

The repository tree description was corrected to call the visualizer the trace UI without repeating the stale read-only label.

## Files

- `README.md` carries the user-facing port, status, and recovery guidance.
- `specs/77aa88bb_readme-observability-fixes.md` records the verified source facts, requested wording constraints, and documentation checks used for the change.

## Verify

From the repository root, inspect the updated claims with:

```bash
grep -n "4600\|4601" README.md
grep -n "read-only" README.md
grep -n "dead" README.md
grep -n "just kill" README.md
```

The first result should attribute port 4600 to the API and 4601 to the UI. The second should find no remaining visualizer read-only claim. The final two should show the dead-state definition and both manual recovery paths.

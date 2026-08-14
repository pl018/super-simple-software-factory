# Plan: SSSF skill-doc turnover — align docs with the three-backend reality

## Scope

Edit ONLY these four markdown files under `.claude/skills/sssf/`:

1. `.claude/skills/sssf/SKILL.md`
2. `.claude/skills/sssf/cookbooks/update_modules.md`
3. `.claude/skills/sssf/cookbooks/sssf_overview.md`
4. `.claude/skills/sssf/cookbooks/install.md`

Do NOT touch any Python, YAML, the justfile, or anything under `.claude/skills/sssf/templates/`. No other files.

## Ground truth (verified against code — cite these, not the old doc text)

- **Backends** — three modules in `adws/adw_modules/`:
  - `agent_cc.py` = `claude_code`, **the shipping default** (`sssf.config.yaml` line 5: `coding_agent: claude_code`, default model `claude-sonnet-5`). Runs `claude -p --output-format stream-json`, tails JSONL live; UUID session ids with a marker file to split create (`--session-id`) from resume (`--resume`). Subscription auth (or `CLAUDE_CODE_OAUTH_TOKEN`), no API key.
  - `agent_codex.py` = `codex`. Runs `codex exec --json`, tails JSONL live; maps sssf session ids → codex thread ids so later sends `codex exec resume <thread_id>`. ChatGPT subscription auth. `tools:` is ignored by codex (no per-tool filtering exists); the real boundary is `writes:` + `protected_files` enforced by `permissions.py`. System prompt rides the first send inside `<system_instructions>` tags.
  - `agent_pi.py` = `pi`, kept for API-key providers (e.g. Gemini); **unused in the starter roster**. Non-interactive `pi -p --mode json`, JSONL tailed live, models resolved against `~/.pi/agent/models.json`; `--session-id` creates-or-continues.
- **Roster** (`adws/adw_sssf_config/sssf.config.yaml`) — 5 agents: planner (claude_code, claude-fable-5), builder (codex, gpt-5.6-sol), scout (claude_code, inherits default claude-sonnet-5), reviewer (claude_code, claude-fable-5), documenter (codex, gpt-5.6-sol).
- **12 ADW scripts** (`adws/adw_*.py`): adw_build, adw_build_review, adw_build_test, adw_document, adw_plan, adw_plan_build, adw_plan_build_test, adw_plan_build_test_quality, adw_prompt, adw_quality, adw_scout, adw_simple_sdlc.
  - `adw_quality` — "lint, typecheck, and build the project"; Phases: `engineer(request) -> code(quality)`.
  - `adw_plan_build_test_quality` — "full agent chain plus deterministic quality"; Phases: `engineer(request) -> planner -> builder -> [code(verify) -> code(test) -> builder(fix)] bounded -> git(commit)`.
- **Gitignore** — `install.py` `GITIGNORE_ENTRIES` has **5** entries: `adws/adw_data/sessions/`, `adws/adw_data/sssf.db*`, `.env`, `__pycache__/`, `*.pyc`. (The last two exist because commit phases run `git add -A`, which would otherwise commit Python bytecode.)
- **Smoke test backends** — `just demo` runs `adw_prompt.py --agent scout` then `adw_scout.py`; **both use scout = claude_code**. The raw form `uv run adws/adw_prompt.py "<prompt>"` (no `--agent`) defaults to the **builder** agent = **codex**. So across install.md's two smoke commands, claude_code and codex both get exercised — but do NOT write "just demo runs codex"; it doesn't.

## Edits

### 1. SKILL.md

- **Line 9**: replace `coding agents (Pi in v1) work inside bounded phases` — the parenthetical must reflect three backends with claude_code as default, e.g. `coding agents (three backends — claude_code by default, codex, pi) work inside bounded phases`.
- Sweep the whole file for any other stale backend claim ("Pi", "v1", "v2") and make it consistent with the Scope section at line 76, which is already correct — leave line 76 as is. (Verified: line 9 is the only stale spot, but confirm with a grep before finishing.)

### 2. cookbooks/update_modules.md

In the "Where things go" table:

- **Line 16 (`agent_pi.py` row)**: drop the "(v1)" framing. Keep the accurate mechanics, reframe as e.g. `the Pi interface — API-key providers (e.g. Gemini), unused in the starter roster; non-interactive \`pi -p --mode json\`, JSONL stream tailed live, model resolved against \`~/.pi/agent/models.json\`; \`--session-id\` creates-or-continues`.
- **Line 17 (`agent_cc.py` row)**: replace `stubbed in v1, lands in v2` with the reality: `the Claude Code interface — the shipping default; \`claude -p --output-format stream-json\` tailed live; UUID session ids with a create-vs-resume marker so corrections resume the same context window`.
- **Add a row for `agent_codex.py`** (place it next to the other backend rows): `the Codex CLI interface — \`codex exec --json\` tailed live; session→thread-id map so later sends resume the thread; \`tools:\` is ignored by codex, the \`writes:\` boundary in permissions.py is what holds`.
- **Lines 23–24**: `console.py` appears twice with different descriptions. Merge into ONE row. Keep the substance of the second (it matches the "Never print()" section): `the rich stdout reporter — every line printed is ALSO traced as a \`log\` event (\`{message, level}\`) so the terminal and the swim-lane UI tell the same story; plain sequential lines, no spinners`.

### 3. cookbooks/sssf_overview.md

- **Line 26**: replace `agent_pi.py  Pi interface (v1)   ·   agent_cc.py  Claude Code (v2, stubbed)` with all three backends, correctly characterized, e.g. `agent_cc.py  Claude Code (default) · agent_codex.py  Codex CLI · agent_pi.py  Pi (API-key providers)`. Keep the tree's alignment style.
- **ADW list (lines 17–21)**: add the two missing scripts so all 12 appear. Suggested placement:
  - Append `adw_quality` and `adw_plan_build_test_quality` — either extend the comma-list on line 18 or add dedicated lines matching the existing style, e.g.:
    - `adw_quality.py              lint, typecheck, build — deterministic code phases, no agents`
    - `adw_plan_build_test_quality.py  full agent chain plus deterministic quality gates`
- Line 40 ("Three backends, chosen per agent...") is already correct — leave it.

### 4. cookbooks/install.md

- **Line 41 (checklist item 4, Gitignore)**: list all **five** appended entries: `adws/adw_data/sessions/`, `adws/adw_data/sssf.db*`, `.env`, `__pycache__/`, `*.pyc`. Fix the closing sentence — "All three are runtime or secrets" no longer parses; say e.g. "All five are runtime, secrets, or bytecode and must never be committed" (the bytecode entries exist because commit phases run `git add -A`).
- **Line 50 (smoke-test green condition)**: replace `Pi ran` with an accurate statement of which backend ran, matching the two commands shown at lines 46–47: `just demo` exercises **claude_code** (both runs use the scout), while the raw `adw_prompt.py` form defaults to the **builder** and exercises **codex**. E.g.: "Green means the whole path works: config validated, session minted, the roster's backend ran (claude_code via the scout for `just demo`; the raw form defaults to the builder, so codex), envelope parsed, events landed in `adws/adw_data/sssf.db`."

## Verification

1. `grep -rn -i "stubbed\|v2\|Pi in v1\|Pi ran" .claude/skills/sssf/SKILL.md .claude/skills/sssf/cookbooks/{update_modules,sssf_overview,install}.md` → no stale hits (mind that "v2" may legitimately appear nowhere else; judge hits by eye).
2. `grep -c "console.py" .claude/skills/sssf/cookbooks/update_modules.md` → exactly 1 table row (the "Never print()" heading text mentions console methods, that's fine).
3. Every `adw_*.py` name in sssf_overview.md's layout exists in `ls adws/adw_*.py`, and all 12 are represented.
4. The five gitignore entries in install.md match `GITIGNORE_ENTRIES` in `.claude/skills/sssf/scripts/install.py` verbatim.
5. `git status` shows changes ONLY in the four listed markdown files.
6. Commit on a branch (never the default branch) and push, per workflow standards.

## Out of scope

- `adws/adw_modules/agent_pi.py`'s own docstring still says "v1's only coding agent" — it is Python, explicitly out of scope. Note it for a future code-side cleanup; do not touch.
- `templates/` copies of any docs — untouched even if they contain the same stale text.

# Claude Code + Codex backends for SSSF

**Goal:** run the factory on subscription auth — Claude models through Claude Code headless
(`claude -p`), GPT-5.6 through Codex CLI (`codex exec`) — instead of pi + provider API keys.
Pi stays in the tree, unused, as the future Gemini runner.

**Date:** 2026-08-05 · **Branch:** `feat/claude-code-codex-backends`

## Why

- v1 is pi-only; `agent_cc.py` is a stub and `agents.validate()` rejects anything else.
- Pi's Anthropic subscription auth bills as "extra usage" per token, not against plan
  limits — only Claude Code itself draws from the plan.
- Token breakdown is the number that matters; dollar cost is best-effort
  (Claude Code reports it, Codex does not).

## Verified facts (probed 2026-08-05, codex-cli 0.145.0, claude 2.1.222)

- Codex JSONL events: `thread.started{thread_id}`, `turn.started`,
  `item.started/updated/completed{item}`, `turn.completed{usage}`, `turn.failed{error}`,
  top-level `error{message}`.
- Codex usage shape: `{input_tokens, cached_input_tokens, cache_write_input_tokens,
  output_tokens, reasoning_output_tokens}` — `input_tokens` INCLUDES cached.
- Resume: `codex exec resume <thread_id> --json ... "<prompt>"` — context carries over.
  `-s/--sandbox` is NOT accepted on `resume`; use `-c sandbox_mode="..."`.
- Model id on this account: `gpt-5.6-sol` (bare `gpt-5.6` is rejected on ChatGPT auth).
- Codex must get `stdin=DEVNULL` or it waits on piped stdin (same failure pi had).
- Claude headless: `claude -p --output-format stream-json --verbose --model <id>
  --session-id <uuid> | --resume <uuid> --system-prompt <text> --effort <low|medium|high>
  --permission-mode bypassPermissions`. Events: `system/init`, `assistant{message}`,
  `user{message}` (tool_result), `result{result, usage, total_cost_usd, modelUsage}`.

## Design

One seam, three backends. `agents.py` dispatches on `agent.coding_agent`
(`pi | claude_code | codex`); each backend module exposes the same duck-typed surface:
`run(request, on_event, on_spawn, on_exit) -> AgentResult`, `ToolCallTracker`
(observe(event) -> normalized tool_call record | None), and a `validate(agent) -> [problems]`
hook. `PiRequest`/`PiResult` are renamed `AgentRequest`/`AgentResult` (they were already
generic in shape).

### agent_cc.py (Claude Code)

- Session ids must be UUIDs → minted per backend in `agents.py`.
- Create vs continue: `--session-id <uuid>` on first send, `--resume <uuid>` after; a
  marker file in `request.session_dir` records that the session exists.
- Tools: sssf names map to Claude tools (read→Read, bash→Bash, edit→Edit, write→Write,
  grep→Grep, find→Glob, ls→Glob, task→Task, subagent_* →Task); restriction is done via
  `--disallowedTools` (complement of the allowlist) because bypassPermissions makes
  `--allowedTools` a no-op. Unknown names pass through as written, so Claude-native
  names (WebSearch) work in the config.
- Thinking→effort: off/minimal/low→low, medium→medium, high/xhigh/max→high.
- Usage/cost from the final `result` event (cumulative); context occupancy from the last
  assistant message's usage; context window from `modelUsage.contextWindow` when present,
  else a 200k default.
- `harness_engineering` (pi .ts extensions) is rejected at validate() for this backend —
  the subagents extension's job is done by the built-in Task tool.

### agent_codex.py (Codex CLI)

- New session: `codex exec --json -m <model> -c model_reasoning_effort="<effort>"
  -c sandbox_mode="danger-full-access" -c approval_policy="never" --skip-git-repo-check
  --cd <cwd> "<prompt>"`. Continue: `codex exec resume <thread_id> --json ...`.
- Codex assigns thread ids; `<session_dir>/codex_threads.json` maps sssf session id →
  thread id, written from `thread.started`.
- No system-prompt flag: the rendered system.md is prepended to the FIRST send of a
  session inside `<system_instructions>` tags; corrections/resumes send the bare prompt.
- `tools:` cannot be enforced (no per-tool filtering in codex) — validate() warns via
  problems only if the agent also has harness_engineering; tool list is ignored with a
  trace log line. `writes:`/protected_files enforcement (permissions.py) is unchanged and
  backend-agnostic, so the real boundary holds.
- Usage: input = input_tokens − cached_input_tokens (UsageBreakdown treats cache reads
  separately), cacheRead = cached_input_tokens, reasoning = reasoning_output_tokens.
  Cost stays 0 — subscription; assign $ from API rates later if wanted.
- Tool calls: `item.*` events fold into the normalized record (command_execution→bash,
  file_change→edit, mcp_tool_call/web_search→their own names).

### Starter roster (sssf.config.yaml)

| agent | backend | model | thinking |
|---|---|---|---|
| planner | claude_code | claude-fable-5 | high |
| builder | codex | gpt-5.6-sol | high |
| scout | claude_code | claude-sonnet-5 | medium |
| reviewer | claude_code | claude-fable-5 | high |
| documenter | codex | gpt-5.6-sol | medium |

Cross-model review holds: Sol builds, Fable reviews. Defaults: `coding_agent: claude_code`,
`model: claude-sonnet-5`.

## Steps

1. `data_types.py` — add `codex` to the Literal, rename Pi* → Agent*.
2. `agent_cc.py` — full backend + tracker.
3. `agent_codex.py` — full backend + tracker.
4. `agents.py` — dispatch, per-backend validate + session-id minting.
5. Templates: `sssf.config.yaml`, `env.sample`; docs: SKILL.md scope, README,
   cookbooks/install.md, references/config.md.
6. Stamp into this repo (`install.py`), smoke test: scout via Claude Code, documenter via
   Codex, verify trace rows + visualizer fields.

## Out of scope

- Gemini (return path: pi backend already works, add GEMINI_API_KEY + a pi agent).
- Dollar-accurate Codex pricing; branch-per-run sandboxing (upstream's stated non-goals).

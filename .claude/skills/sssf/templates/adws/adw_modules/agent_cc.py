"""Claude Code interface — Claude models on subscription auth.

Runs `claude -p --output-format stream-json` and tails its JSONL stdout line by
line, forwarding each event to a callback WHILE the agent works — the same
streaming contract as agent_pi. Auth comes from the operator's Claude Code
login (or CLAUDE_CODE_OAUTH_TOKEN from `claude setup-token`); no API key.

Sessions: Claude Code requires UUID session ids and splits create from
continue (`--session-id` vs `--resume`). A marker file in the request's
session_dir records that a session exists, so corrections and later phases
resume the same context window — create-or-continue, reconstructed.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import time
from pathlib import Path
from typing import Callable, Optional

# Shared stream-normalization helpers; the clip limits are one policy, not per-backend.
from .agent_pi import ARG_VALUE_CHARS, RESULT_SNIPPET_CHARS, _clip, _label, _text_of
from .data_types import AgentConfig, AgentRequest, AgentResult
from .utils import now_iso, operator_env
from .watchdog import StallTimeout, stream_lines

CLAUDE_PATH = os.environ.get("CLAUDE_CODE_PATH", "claude")

# sssf tool names -> Claude Code tool names. Unknown names pass through as
# written, so Claude-native names (WebSearch, NotebookEdit) work in the config.
TOOL_MAP = {
    "read": "Read", "bash": "Bash", "edit": "Edit", "write": "Write",
    "grep": "Grep", "find": "Glob", "ls": "Glob", "task": "Task",
    # pi's subagents extension maps onto the built-in Task tool
    "subagent_create": "Task", "subagent_continue": "Task",
    "subagent_list": "Task", "subagent_remove": "Task",
}

# The tools an allowlist is measured against. bypassPermissions auto-approves
# everything, which makes --allowedTools a no-op — restriction must be phrased
# as the COMPLEMENT via --disallowedTools.
KNOWN_TOOLS = {"Task", "Bash", "Glob", "Grep", "Read", "Edit", "Write",
               "NotebookEdit", "WebFetch", "WebSearch"}

# sssf thinking levels -> claude --effort
EFFORT = {"off": "low", "minimal": "low", "low": "low", "medium": "medium",
          "high": "high", "xhigh": "high", "max": "high"}

CONTEXT_WINDOW_DEFAULT = 200_000


def validate_agent(agent: AgentConfig) -> list[str]:
    """Backend-specific config problems for one agent, checked before any run."""
    problems = []
    if shutil.which(CLAUDE_PATH) is None:
        problems.append(f"claude binary {CLAUDE_PATH!r} not found on PATH — "
                        "install Claude Code or set CLAUDE_CODE_PATH")
    if agent.harness_engineering:
        problems.append("harness_engineering lists pi extensions, which claude_code "
                        "cannot load — subagents are the built-in 'task' tool here")
    return problems


def _mapped_tools(tools: list[str]) -> set[str]:
    return {TOOL_MAP.get(name, name) for name in tools}


def _session_marker(request: AgentRequest) -> Path:
    return Path(request.session_dir) / f"{request.session_id}.exists"


def _usage_total(usage: dict) -> int:
    """Window occupancy of one API message: everything that entered + left it."""
    return int(sum(usage.get(part) or 0
                   for part in ("input_tokens", "cache_read_input_tokens",
                                "cache_creation_input_tokens", "output_tokens")))


class ToolCallTracker:
    """Folds Claude Code's stream into ONE normalized record per tool call.

    An `assistant` event announces the call as a tool_use content block; the
    paired tool_result arrives later inside a `user` event. Only the result
    carries the outcome, so that is where the record is emitted — same contract
    as agent_pi.ToolCallTracker.
    """

    def __init__(self) -> None:
        self._open: dict[str, dict] = {}

    def observe(self, event: dict) -> Optional[dict]:
        etype = event.get("type", "")
        message = event.get("message", {}) or {}
        if etype == "assistant":
            for block in message.get("content", []) or []:
                if isinstance(block, dict) and block.get("type") == "tool_use":
                    self._open[str(block.get("id"))] = {
                        "tool": block.get("name") or "tool",
                        "args": block.get("input") or {},
                        "started_at": now_iso(), "clock": time.monotonic(),
                    }
            return None
        if etype != "user":
            return None
        for block in message.get("content", []) or []:
            if not (isinstance(block, dict) and block.get("type") == "tool_result"):
                continue
            call_id = str(block.get("tool_use_id") or "")
            opened = self._open.pop(call_id, {})
            tool = str(opened.get("tool") or "tool")
            args = opened.get("args") or {}
            record = {
                "tool": tool,
                "tool_call_id": call_id,
                "args": {key: _clip(value, ARG_VALUE_CHARS) if isinstance(value, str) else value
                         for key, value in args.items()},
                "ok": not block.get("is_error", False),
                "label": _label(tool, args),
                "ended_at": now_iso(),
            }
            content = block.get("content")
            text = content if isinstance(content, str) else _text_of({"content": content})
            if text:
                record["result_snippet"] = _clip(text, RESULT_SNIPPET_CHARS)
            if opened.get("clock"):
                record["duration_ms"] = int((time.monotonic() - opened["clock"]) * 1000)
            if opened.get("started_at"):
                record["started_at"] = opened["started_at"]
            return record          # stream-json delivers one tool_result per user event
        return None


def run(request: AgentRequest, on_event: Optional[Callable[[dict], None]] = None,
        on_spawn: Optional[Callable[[int], None]] = None,
        on_exit: Optional[Callable[[int], None]] = None) -> AgentResult:
    """Run one non-interactive Claude Code turn."""
    marker = _session_marker(request)
    cmd = [CLAUDE_PATH, "-p", "--output-format", "stream-json", "--verbose",
           "--model", request.model,
           "--permission-mode", "bypassPermissions",
           # identity travels on every call: a resumed print session takes its
           # flags from the invocation, not from the session file
           "--system-prompt", request.system_prompt,
           "--effort", EFFORT.get(request.thinking, "medium")]
    if marker.exists():
        cmd += ["--resume", request.session_id]
    else:
        cmd += ["--session-id", request.session_id]
    if request.tools:
        disallowed = sorted(KNOWN_TOOLS - _mapped_tools(request.tools))
        if disallowed:
            # equals-form on purpose: the flag is variadic and would otherwise
            # swallow the positional prompt that follows it
            cmd.append(f"--disallowedTools={','.join(disallowed)}")
    cmd.append(request.prompt)

    raw_path = Path(request.raw_output_path)
    raw_path.parent.mkdir(parents=True, exist_ok=True)
    result = AgentResult(session_id=request.session_id,
                         context_window=CONTEXT_WINDOW_DEFAULT)

    # stdin is DEVNULL for the same reason as agent_pi: the prompt travels in
    # argv, and an inherited non-TTY stdin can leave the child waiting forever.
    process = subprocess.Popen(cmd, stdin=subprocess.DEVNULL,
                               stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                               text=True, bufsize=1, cwd=request.cwd,
                               env=operator_env())
    if on_spawn:
        on_spawn(process.pid)
    try:
        with raw_path.open("a") as raw:
            for line in stream_lines(process, request.stall_timeout_seconds,
                                     label=f"claude {request.model}"):
                raw.write(line)
                raw.flush()
                line = line.strip()
                if not line:
                    continue
                try:
                    event = json.loads(line)
                except json.JSONDecodeError:
                    continue
                etype = event.get("type")
                if etype == "assistant":
                    message = event.get("message", {}) or {}
                    text = _text_of(message)
                    if text:
                        result.text = text                # last assistant message wins
                    turn = _usage_total(message.get("usage", {}) or {})
                    if turn:
                        result.context_tokens = turn      # occupancy after this message
                elif etype == "result":
                    usage = event.get("usage", {}) or {}  # cumulative across the whole call
                    result.usage.input_tokens = usage.get("input_tokens") or 0
                    result.usage.output_tokens = usage.get("output_tokens") or 0
                    result.usage.cache_read_tokens = usage.get("cache_read_input_tokens") or 0
                    result.usage.cache_write_tokens = usage.get("cache_creation_input_tokens") or 0
                    result.usage.total_tokens = _usage_total(usage)
                    result.tokens = result.usage.total_tokens
                    result.cost = float(event.get("total_cost_usd") or 0.0)
                    result.usage.total_cost = result.cost
                    if isinstance(event.get("result"), str) and event["result"]:
                        result.text = event["result"]
                    for model_usage in (event.get("modelUsage") or {}).values():
                        window = int((model_usage or {}).get("contextWindow") or 0)
                        if window:
                            result.context_window = window
                if on_event:
                    on_event(event)
    except StallTimeout:
        # The watchdog already killed and reaped the child; the pid must still
        # leave the tracer's live-process table before the failure propagates.
        if on_exit:
            on_exit(process.pid)
        raise

    stderr = process.stderr.read() if process.stderr else ""
    result.returncode = process.wait()
    if on_exit:
        on_exit(process.pid)
    if result.returncode != 0:
        # A nonzero exit is a CLI-reported failure even when text arrived first:
        # partial text parsed as an envelope is a swallowed failure.
        detail = stderr.strip()[-800:]
        if result.text:
            detail += f"\nlast agent text: {result.text.strip()[-400:]}"
        raise RuntimeError(f"claude exited {result.returncode}: {detail}")
    marker.parent.mkdir(parents=True, exist_ok=True)
    marker.touch()                     # the session exists — every later send resumes it
    return result

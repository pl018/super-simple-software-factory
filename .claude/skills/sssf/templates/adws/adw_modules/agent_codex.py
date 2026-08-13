"""Codex CLI interface — GPT models on ChatGPT subscription auth.

Runs `codex exec --json` and tails its JSONL stdout line by line, forwarding
each event to a callback WHILE the agent works — the same streaming contract
as agent_pi. Auth comes from `codex login`; no API key.

Sessions: codex mints its own thread ids, so a json file in the request's
session_dir maps sssf session ids to codex thread ids. First send creates the
thread (`codex exec`); every later send — corrections included — resumes it
(`codex exec resume <thread_id>`), context window intact.

Two contract gaps, both deliberate and logged rather than papered over:
- No per-tool filtering exists in codex, so `tools:` is ignored here. The real
  boundary — `writes:` + protected_files — is enforced in permissions.py after
  every call, backend-agnostic, so a scout that edits code still fails.
- No system-prompt flag exists, so the rendered system.md rides the FIRST send
  of a session inside <system_instructions> tags; resumed sends carry only the
  new prompt (the thread already holds the identity).
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
from .agent_pi import ARG_VALUE_CHARS, RESULT_SNIPPET_CHARS, _clip, _label
from .data_types import AgentConfig, AgentRequest, AgentResult
from .utils import now_iso, operator_env

CODEX_PATH = os.environ.get("CODEX_PATH", "codex")

# sssf thinking levels -> codex model_reasoning_effort
EFFORT = {"off": "minimal", "minimal": "minimal", "low": "low", "medium": "medium",
          "high": "high", "xhigh": "xhigh", "max": "xhigh"}


def validate_agent(agent: AgentConfig) -> list[str]:
    """Backend-specific config problems for one agent, checked before any run."""
    problems = []
    if shutil.which(CODEX_PATH) is None:
        problems.append(f"codex binary {CODEX_PATH!r} not found on PATH — "
                        "install the Codex CLI or set CODEX_PATH")
    if agent.harness_engineering:
        problems.append("harness_engineering lists pi extensions, which codex cannot load")
    return problems


def _threads_path(request: AgentRequest) -> Path:
    return Path(request.session_dir) / "codex_threads.json"


def _load_threads(request: AgentRequest) -> dict:
    path = _threads_path(request)
    if path.is_file():
        try:
            return json.loads(path.read_text())
        except json.JSONDecodeError:
            return {}
    return {}


def _save_thread(request: AgentRequest, thread_id: str) -> None:
    path = _threads_path(request)
    path.parent.mkdir(parents=True, exist_ok=True)
    threads = _load_threads(request)
    threads[request.session_id] = thread_id
    path.write_text(json.dumps(threads, indent=2))


class ToolCallTracker:
    """Folds codex's item.* stream into ONE normalized record per tool call.

    codex announces work as items (`item.started`), then completes them
    (`item.completed`) — commands, file changes, web searches, MCP calls. Only
    completion carries the outcome, so that is where the record is emitted —
    same contract as agent_pi.ToolCallTracker. Messages, reasoning, and todo
    items are the agent talking, not tools running; they emit nothing.
    """

    def __init__(self) -> None:
        self._open: dict[str, dict] = {}

    def observe(self, event: dict) -> Optional[dict]:
        etype = event.get("type", "")
        item = event.get("item") or {}
        item_id = str(item.get("id") or "")
        if etype in ("item.started", "item.updated"):
            if item_id and item_id not in self._open:
                self._open[item_id] = {"started_at": now_iso(), "clock": time.monotonic()}
            return None
        if etype != "item.completed":
            return None
        opened = self._open.pop(item_id, {})
        normalized = self._normalize(item)
        if normalized is None:
            return None
        tool, args, ok, snippet = normalized
        record = {
            "tool": tool,
            "tool_call_id": item_id,
            "args": {key: _clip(value, ARG_VALUE_CHARS) if isinstance(value, str) else value
                     for key, value in args.items()},
            "ok": ok,
            "label": _label(tool, args),
            "ended_at": now_iso(),
        }
        if snippet:
            record["result_snippet"] = _clip(snippet, RESULT_SNIPPET_CHARS)
        if opened.get("clock"):
            record["duration_ms"] = int((time.monotonic() - opened["clock"]) * 1000)
        if opened.get("started_at"):
            record["started_at"] = opened["started_at"]
        return record

    @staticmethod
    def _normalize(item: dict) -> Optional[tuple[str, dict, bool, str]]:
        """(tool, args, ok, result_snippet) for a tool-like item, else None."""
        kind = item.get("type", "")
        status_ok = item.get("status") != "failed"
        if kind == "command_execution":
            exit_code = item.get("exit_code")
            return ("bash", {"command": item.get("command") or ""},
                    (exit_code == 0) if exit_code is not None else status_ok,
                    item.get("aggregated_output") or "")
        if kind == "file_change":
            changed = ", ".join(f"{c.get('kind', 'edit')} {c.get('path', '?')}"
                                for c in item.get("changes") or [])
            return "edit", {"files": changed}, status_ok, ""
        if kind == "mcp_tool_call":
            name = ".".join(p for p in (item.get("server"), item.get("tool")) if p) or "mcp"
            return name, {"query": json.dumps(item.get("arguments"))
                          if item.get("arguments") else ""}, status_ok, ""
        if kind == "web_search":
            return "web_search", {"query": item.get("query") or ""}, status_ok, ""
        return None


def run(request: AgentRequest, on_event: Optional[Callable[[dict], None]] = None,
        on_spawn: Optional[Callable[[int], None]] = None,
        on_exit: Optional[Callable[[int], None]] = None) -> AgentResult:
    """Run one non-interactive codex turn."""
    effort = EFFORT.get(request.thinking, "medium")
    thread_id = _load_threads(request).get(request.session_id)
    if thread_id:
        cmd = [CODEX_PATH, "exec", "resume", thread_id]
        prompt = request.prompt
    else:
        cmd = [CODEX_PATH, "exec"]
        prompt = (f"<system_instructions>\n{request.system_prompt}\n"
                  f"</system_instructions>\n\n{request.prompt}")
    # `resume` rejects -s/--cd, so sandbox rides -c and cwd rides Popen for both
    # shapes — one command surface, not two.
    cmd += ["--json", "--skip-git-repo-check",
            "-m", request.model,
            "-c", 'sandbox_mode="danger-full-access"',
            "-c", 'approval_policy="never"',
            "-c", f'model_reasoning_effort="{effort}"',
            prompt]

    raw_path = Path(request.raw_output_path)
    raw_path.parent.mkdir(parents=True, exist_ok=True)
    result = AgentResult(session_id=request.session_id)
    errors: list[str] = []

    # stdin is DEVNULL: codex reads piped stdin as extra prompt input and waits.
    process = subprocess.Popen(cmd, stdin=subprocess.DEVNULL,
                               stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                               text=True, bufsize=1, cwd=request.cwd,
                               env=operator_env())
    if on_spawn:
        on_spawn(process.pid)
    with raw_path.open("a") as raw:
        assert process.stdout is not None
        for line in process.stdout:
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
            if etype == "thread.started" and event.get("thread_id"):
                result.session_id = str(event["thread_id"])
                _save_thread(request, result.session_id)
            elif etype == "item.completed":
                item = event.get("item") or {}
                if item.get("type") == "agent_message" and item.get("text"):
                    result.text = item["text"]            # last agent message wins
                elif item.get("type") == "error":
                    errors.append(str(item.get("message") or ""))
            elif etype == "turn.completed":
                usage = event.get("usage", {}) or {}
                billed_input = int(usage.get("input_tokens") or 0)      # includes cache reads
                cached = int(usage.get("cached_input_tokens") or 0)
                cache_write = int(usage.get("cache_write_input_tokens") or 0)
                output = int(usage.get("output_tokens") or 0)
                turn_total = billed_input + cache_write + output
                result.usage.input_tokens += max(0, billed_input - cached)
                result.usage.cache_read_tokens += cached
                result.usage.cache_write_tokens += cache_write
                result.usage.output_tokens += output
                result.usage.reasoning_tokens += int(usage.get("reasoning_output_tokens") or 0)
                result.usage.total_tokens += turn_total
                result.tokens += turn_total
                result.context_tokens = turn_total        # occupancy after the last turn
            elif etype in ("turn.failed", "error"):
                message = event.get("message") or (event.get("error") or {}).get("message") or ""
                if message:
                    errors.append(str(message))
            if on_event:
                on_event(event)

    stderr = process.stderr.read() if process.stderr else ""
    result.returncode = process.wait()
    if on_exit:
        on_exit(process.pid)
    if result.returncode != 0 and not result.text:
        detail = " | ".join(errors[-3:]) or stderr.strip()[-800:]
        raise RuntimeError(f"codex exited {result.returncode}: {detail}")
    return result

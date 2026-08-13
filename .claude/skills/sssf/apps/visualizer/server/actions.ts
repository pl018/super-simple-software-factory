/**
 * The live monitor's only interventions, both explicitly user-fired from the UI:
 *
 *   kill  — signal a stalled session's CLI process. The pid must be one the
 *           server itself just matched to that session; arbitrary pids are
 *           rejected, so the endpoint cannot be aimed at unrelated processes.
 *   nudge — one-shot resume of a DEAD session (process gone, turn open):
 *           `claude -p --resume <id>` / `codex exec resume <id>` with a prompt
 *           that either asks for a status report or tells it to continue.
 *
 * There is deliberately NO automation here: a "stalled" read can be a long
 * quiet build or an unanswered permission prompt, so nothing kills or nudges
 * without a human click.
 */
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import type { LiveNudgeState, LiveSource } from "../shared/types.ts";

/** A nudge that runs longer than this is itself stuck and gets killed. */
const NUDGE_TIMEOUT_MS = 15 * 60 * 1000;
const TAIL_CHARS = 4000;

const nudges = new Map<string, LiveNudgeState>();

const key = (source: LiveSource, id: string) => `${source}:${id}`;

export function nudgeState(source: LiveSource, id: string): LiveNudgeState | null {
  return nudges.get(key(source, id)) ?? null;
}

export function killPid(pid: number, force: boolean): void {
  process.kill(pid, force ? "SIGKILL" : "SIGTERM");
}

const REPORT_PROMPT =
  "You stopped mid-task — the previous process ended before the turn closed. " +
  "Do not start new work. Write a concise status report: what was completed, " +
  "what remains, and the exact next step to resume.";

const CONTINUE_PROMPT =
  "You stopped mid-task — the previous process ended before the turn closed. " +
  "Re-read your last steps, then continue the task from where it left off. " +
  "Finish the current step, then summarize what you did and what remains.";

export function startNudge(
  source: LiveSource,
  id: string,
  cwd: string,
  mode: "report" | "continue",
  customPrompt: string | null,
): LiveNudgeState | { error: string } {
  const k = key(source, id);
  if (nudges.get(k)?.status === "running") {
    return { error: "a nudge is already running for this session" };
  }
  const prompt = customPrompt?.trim() || (mode === "continue" ? CONTINUE_PROMPT : REPORT_PROMPT);
  const cmd =
    source === "claude"
      ? [
          "claude", "-p", "--resume", id,
          // "continue" grants edit-level permissions; "report" runs with the
          // headless default, where denied tools still let it answer in text.
          ...(mode === "continue" ? ["--permission-mode", "acceptEdits"] : []),
          prompt,
        ]
      : // codex exec resume rejects --cd; the cwd rides on the subprocess.
        ["codex", "exec", "resume", id, prompt];

  const state: LiveNudgeState = {
    status: "running",
    mode,
    prompt,
    started_at: new Date().toISOString(),
    ended_at: null,
    exit_code: null,
    output_tail: "",
  };
  nudges.set(k, state);

  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn({
      cmd,
      cwd: cwd && existsSync(cwd) ? cwd : homedir(),
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
  } catch (error) {
    state.status = "failed";
    state.ended_at = new Date().toISOString();
    state.output_tail = (error as Error).message;
    return state;
  }

  const append = (chunk: string) => {
    state.output_tail = (state.output_tail + chunk).slice(-TAIL_CHARS);
  };
  const drain = async (stream: ReadableStream<Uint8Array> | null) => {
    if (!stream) return;
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) append(decoder.decode(value));
    }
  };
  void drain(proc.stdout as ReadableStream<Uint8Array>);
  void drain(proc.stderr as ReadableStream<Uint8Array>);

  const timeout = setTimeout(() => {
    append("\n[nudge timed out — killed]");
    proc.kill("SIGKILL");
  }, NUDGE_TIMEOUT_MS);

  void proc.exited.then((code) => {
    clearTimeout(timeout);
    state.status = code === 0 ? "done" : "failed";
    state.exit_code = code;
    state.ended_at = new Date().toISOString();
  });

  return state;
}

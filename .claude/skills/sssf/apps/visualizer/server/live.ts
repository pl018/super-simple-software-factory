/**
 * Live session monitor — tails the coding agents' own transcripts at poll time.
 *
 * Sources:
 *   ~/.claude/projects/<slug>/<session-uuid>.jsonl   (Claude Code, one line/event)
 *   ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl     (Codex TUI + exec)
 *
 * No daemon, no db, no ingest: each poll stats the recent files and parses only
 * the bytes appended since the previous poll (per-file offset + accumulated
 * state cached in memory). A restart just re-parses from byte 0 — transcripts
 * are the durable record, this module is pure derivation.
 */
import { readdirSync, statSync, openSync, readSync, closeSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import type {
  LiveActivityEntry,
  LiveSessionDetail,
  LiveSessionSummary,
  LiveSource,
  LiveStatus,
} from "../shared/types.ts";

const CLAUDE_ROOT = process.env.SSSF_CLAUDE_PROJECTS ?? join(homedir(), ".claude", "projects");
const CODEX_ROOT = process.env.SSSF_CODEX_SESSIONS ?? join(homedir(), ".codex", "sessions");

/** An open turn with no file growth for this long reads as stalled. */
const STALL_MS = 10 * 60 * 1000;
/** A closed turn with no activity for this long reads as idle, not waiting. */
const IDLE_MS = 60 * 60 * 1000;
/** Feed entries kept per session; the detail endpoint slices from this. */
const FEED_CAP = 400;
const SNIPPET = 240;

// ── per-file accumulated state ───────────────────────────────────────────────

interface FileState {
  offset: number;
  /** Trailing bytes of an incomplete final line, re-parsed on next growth. */
  remainder: string;
  s: Mutable;
}

interface Mutable {
  id: string;
  source: LiveSource;
  cwd: string;
  gitBranch: string | null;
  model: string | null;
  originator: string | null;
  title: string | null;
  lastEvent: string | null;
  lastTs: string | null;
  startedAt: string | null;
  turns: number;
  toolCalls: number;
  sidechainLines: number;
  contextTokens: number | null;
  contextWindow: number | null;
  outputTokens: number;
  /** Turn open = agent mid-work (tool running / task started, not yet closed). */
  turnOpen: boolean;
  feed: LiveActivityEntry[];
}

const cache = new Map<string, FileState>();

function freshState(id: string, source: LiveSource): Mutable {
  return {
    id, source, cwd: "", gitBranch: null, model: null, originator: null,
    title: null, lastEvent: null, lastTs: null, startedAt: null,
    turns: 0, toolCalls: 0, sidechainLines: 0,
    contextTokens: null, contextWindow: null, outputTokens: 0,
    turnOpen: false, feed: [],
  };
}

function snip(text: unknown, max = SNIPPET): string {
  const t = String(text ?? "").replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

function push(s: Mutable, entry: LiveActivityEntry): void {
  s.feed.push(entry);
  if (s.feed.length > FEED_CAP) s.feed.splice(0, s.feed.length - FEED_CAP);
  s.lastEvent = entry.kind === "tool" ? `tool: ${entry.label}` : entry.label;
  if (entry.ts) s.lastTs = entry.ts;
}

// ── claude transcript lines ──────────────────────────────────────────────────

/** Meta wrappers Claude injects that are not the user actually talking. */
function isMetaUserText(text: string): boolean {
  return text.startsWith("<") || text.startsWith("Caveat:");
}

function claudeLine(s: Mutable, d: Record<string, unknown>, sidechain = false): void {
  const ts = typeof d.timestamp === "string" ? d.timestamp : null;
  if (ts) {
    s.lastTs = ts;
    if (!s.startedAt) s.startedAt = ts;
  }
  if (typeof d.cwd === "string") s.cwd = d.cwd;
  if (typeof d.gitBranch === "string") s.gitBranch = d.gitBranch;
  if (d.isSidechain === true || sidechain) {
    s.sidechainLines += 1;
    // Subagent work shows in the feed under its own kind, but never touches
    // main-turn state (turnOpen, title, model, context) — it is a parallel lane.
    if (d.type === "assistant") {
      const m = (d.message ?? {}) as Record<string, unknown>;
      for (const block of ((m.content ?? []) as Record<string, unknown>[])) {
        if (block?.type === "tool_use") {
          push(s, {
            ts, kind: "subagent",
            label: `sub:${String(block.name ?? "tool")}`,
            detail: snip((block.input as Record<string, unknown> | undefined)?.command ?? ""),
          });
        }
      }
    }
    return;
  }

  const type = d.type;
  const message = (d.message ?? {}) as Record<string, unknown>;

  if (type === "user") {
    const content = message.content;
    if (typeof content === "string") {
      if (d.isMeta === true || isMetaUserText(content)) return;
      if (!s.title) s.title = snip(content, 120);
      s.turnOpen = true;
      push(s, { ts, kind: "user", label: "user", detail: snip(content) });
      return;
    }
    if (Array.isArray(content)) {
      for (const block of content as Record<string, unknown>[]) {
        if (block?.type === "tool_result") {
          // A tool returned; the agent is still mid-turn.
          s.turnOpen = true;
        } else if (block?.type === "text" && typeof block.text === "string") {
          if (d.isMeta === true || isMetaUserText(block.text)) continue;
          if (!s.title) s.title = snip(block.text, 120);
          s.turnOpen = true;
          push(s, { ts, kind: "user", label: "user", detail: snip(block.text) });
        }
      }
    }
    return;
  }

  if (type === "assistant") {
    if (typeof message.model === "string") s.model = message.model;
    const usage = message.usage as Record<string, unknown> | undefined;
    if (usage) {
      const n = (k: string) => (typeof usage[k] === "number" ? (usage[k] as number) : 0);
      // Window occupancy after this turn = everything the model just read + wrote.
      s.contextTokens =
        n("input_tokens") + n("cache_read_input_tokens") +
        n("cache_creation_input_tokens") + n("output_tokens");
      s.outputTokens += n("output_tokens");
    }
    let sawToolUse = false;
    let text: string | null = null;
    for (const block of ((message.content ?? []) as Record<string, unknown>[])) {
      if (block?.type === "tool_use") {
        sawToolUse = true;
        s.toolCalls += 1;
        const input = block.input as Record<string, unknown> | undefined;
        const hint =
          typeof input?.command === "string" ? input.command
          : typeof input?.file_path === "string" ? input.file_path
          : typeof input?.pattern === "string" ? input.pattern
          : typeof input?.description === "string" ? input.description
          : "";
        push(s, { ts, kind: "tool", label: String(block.name ?? "tool"), detail: snip(hint) });
      } else if (block?.type === "text" && typeof block.text === "string" && block.text.trim()) {
        text = block.text;
      } else if (block?.type === "thinking") {
        s.lastEvent = "thinking";
        if (ts) s.lastTs = ts;
      }
    }
    if (sawToolUse) {
      s.turnOpen = true;
    } else if (text !== null) {
      // Final prose with no tool call closes the turn — the user has the floor.
      s.turnOpen = false;
      s.turns += 1;
      push(s, { ts, kind: "assistant", label: "assistant", detail: snip(text) });
    }
    return;
  }

  if (type === "system" && typeof d.content === "string" && d.subtype !== "local_command") {
    push(s, { ts, kind: "meta", label: String(d.subtype ?? "system"), detail: snip(d.content) });
  }
}

// ── codex rollout lines ──────────────────────────────────────────────────────

function codexLine(s: Mutable, d: Record<string, unknown>): void {
  const ts = typeof d.timestamp === "string" ? d.timestamp : null;
  if (ts) {
    s.lastTs = ts;
    if (!s.startedAt) s.startedAt = ts;
  }
  const payload = (d.payload ?? {}) as Record<string, unknown>;

  if (d.type === "session_meta") {
    if (typeof payload.cwd === "string") s.cwd = payload.cwd;
    if (typeof payload.originator === "string") s.originator = payload.originator;
    return;
  }
  if (d.type === "turn_context") {
    if (typeof payload.cwd === "string") s.cwd = payload.cwd;
    if (typeof payload.model === "string") s.model = payload.model;
    return;
  }
  if (d.type === "event_msg") {
    const kind = payload.type;
    if (kind === "task_started") {
      s.turnOpen = true;
      const win = payload.model_context_window;
      if (typeof win === "number") s.contextWindow = win;
      s.lastEvent = "task_started";
      return;
    }
    if (kind === "task_complete" || kind === "turn_aborted") {
      s.turnOpen = false;
      s.turns += 1;
      push(s, { ts, kind: "meta", label: String(kind), detail: "" });
      return;
    }
    if (kind === "user_message") {
      const text = typeof payload.message === "string" ? payload.message : "";
      if (!s.title && text && !text.startsWith("<")) s.title = snip(text, 120);
      push(s, { ts, kind: "user", label: "user", detail: snip(text) });
      return;
    }
    if (kind === "agent_message") {
      push(s, { ts, kind: "assistant", label: "assistant", detail: snip(payload.message) });
      return;
    }
    if (kind === "agent_reasoning") {
      s.lastEvent = "thinking";
      return;
    }
    if (kind === "token_count") {
      const info = (payload.info ?? {}) as Record<string, unknown>;
      const total = (info.total_token_usage ?? {}) as Record<string, unknown>;
      const last = (info.last_token_usage ?? {}) as Record<string, unknown>;
      if (typeof info.model_context_window === "number") s.contextWindow = info.model_context_window;
      if (typeof total.output_tokens === "number") s.outputTokens = total.output_tokens;
      const lastTotal = typeof last.total_tokens === "number" ? last.total_tokens : null;
      if (lastTotal !== null) s.contextTokens = lastTotal;
      return;
    }
    if (kind === "error" || kind === "stream_error") {
      push(s, { ts, kind: "error", label: "error", detail: snip(payload.message) });
      return;
    }
    return;
  }
  if (d.type === "response_item") {
    const kind = payload.type;
    if (kind === "function_call" || kind === "custom_tool_call" || kind === "local_shell_call") {
      s.toolCalls += 1;
      s.turnOpen = true;
      const name = typeof payload.name === "string" ? payload.name : "tool";
      // function_call carries `arguments`; custom_tool_call carries `input`.
      push(s, { ts, kind: "tool", label: name, detail: snip(payload.arguments ?? payload.input) });
    }
  }
}

// ── file tailing ─────────────────────────────────────────────────────────────

function readNewBytes(path: string, from: number, size: number): string {
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(size - from);
    const n = readSync(fd, buf, 0, buf.length, from);
    return buf.toString("utf8", 0, n);
  } finally {
    closeSync(fd);
  }
}

/** Cursor for a subagent child file; its lines accumulate into the PARENT state. */
const childCache = new Map<string, { offset: number; remainder: string }>();

function parseChunk(s: Mutable, source: LiveSource, chunk: string, sidechain: boolean): string {
  const lines = chunk.split("\n");
  const remainder = lines.pop() ?? ""; // incomplete tail line, if any
  for (const line of lines) {
    if (!line.trim()) continue;
    let d: Record<string, unknown>;
    try {
      d = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue; // a torn or malformed line never takes the monitor down
    }
    if (source === "claude") claudeLine(s, d, sidechain);
    else codexLine(s, d);
  }
  return remainder;
}

function tail(path: string, source: LiveSource, id: string, size: number): Mutable {
  let st = cache.get(path);
  // A shrunk file (rotation/rewrite) invalidates the accumulated state.
  if (!st || size < st.offset) {
    st = { offset: 0, remainder: "", s: freshState(id, source) };
    cache.set(path, st);
  }
  if (size > st.offset) {
    const chunk = st.remainder + readNewBytes(path, st.offset, size);
    st.offset = size;
    st.remainder = parseChunk(st.s, source, chunk, false);
  }
  return st.s;
}

/** Tail a subagent transcript into the parent session's state, all lines sidechain. */
function tailChild(path: string, size: number, parent: Mutable): void {
  let st = childCache.get(path);
  if (!st || size < st.offset) {
    st = { offset: 0, remainder: "" };
    childCache.set(path, st);
  }
  if (size > st.offset) {
    const chunk = st.remainder + readNewBytes(path, st.offset, size);
    st.offset = size;
    st.remainder = parseChunk(parent, "claude", chunk, true);
  }
}

// ── scanning ─────────────────────────────────────────────────────────────────

interface Found {
  path: string;
  id: string;
  source: LiveSource;
  /** Newest write across the main transcript AND its subagent files — a parent
   *  waiting on a busy subagent is active, not stalled. */
  mtimeMs: number;
  size: number;
  /** Subagent transcripts (claude: <project>/<session-id>/subagents/*.jsonl). */
  children: { path: string; size: number }[];
}

function listDir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

function scanClaude(cutoffMs: number): Found[] {
  const found: Found[] = [];
  for (const project of listDir(CLAUDE_ROOT)) {
    const dir = join(CLAUDE_ROOT, project);
    for (const name of listDir(dir)) {
      if (!name.endsWith(".jsonl")) continue;
      const path = join(dir, name);
      try {
        const st = statSync(path);
        const id = name.slice(0, -6);
        let mtimeMs = st.mtimeMs;
        const children: { path: string; size: number }[] = [];
        for (const sub of listDir(join(dir, id, "subagents"))) {
          if (!sub.endsWith(".jsonl")) continue;
          const subPath = join(dir, id, "subagents", sub);
          try {
            const subSt = statSync(subPath);
            children.push({ path: subPath, size: subSt.size });
            mtimeMs = Math.max(mtimeMs, subSt.mtimeMs);
          } catch { /* deleted mid-scan */ }
        }
        if (mtimeMs >= cutoffMs) {
          found.push({ path, id, source: "claude", mtimeMs, size: st.size, children });
        }
      } catch { /* deleted mid-scan */ }
    }
  }
  return found;
}

function scanCodex(cutoffMs: number): Found[] {
  const found: Found[] = [];
  // Layout is sessions/YYYY/MM/DD/ — prune whole days by date before statting files.
  const cutoffDay = new Date(cutoffMs);
  cutoffDay.setHours(0, 0, 0, 0);
  for (const year of listDir(CODEX_ROOT)) {
    for (const month of listDir(join(CODEX_ROOT, year))) {
      for (const day of listDir(join(CODEX_ROOT, year, month))) {
        const dayDate = new Date(Number(year), Number(month) - 1, Number(day));
        if (Number.isNaN(dayDate.getTime()) || dayDate < cutoffDay) continue;
        const dir = join(CODEX_ROOT, year, month, day);
        for (const name of listDir(dir)) {
          if (!name.endsWith(".jsonl")) continue;
          const path = join(dir, name);
          try {
            const st = statSync(path);
            if (st.mtimeMs >= cutoffMs) {
              // rollout-<timestamp>-<uuid>.jsonl → the trailing uuid is the id.
              const id = name.slice(0, -6).split("-").slice(-5).join("-");
              found.push({ path, id, source: "codex", mtimeMs: st.mtimeMs, size: st.size, children: [] });
            }
          } catch { /* deleted mid-scan */ }
        }
      }
    }
  }
  return found;
}

// ── public surface ───────────────────────────────────────────────────────────

function status(s: Mutable, mtimeMs: number, nowMs: number): LiveStatus {
  const age = nowMs - mtimeMs;
  if (s.turnOpen) return age < STALL_MS ? "working" : "stalled";
  return age < IDLE_MS ? "waiting" : "idle";
}

function summarize(f: Found, nowMs: number): LiveSessionSummary {
  const s = tail(f.path, f.source, f.id, f.size);
  for (const child of f.children) tailChild(child.path, child.size, s);
  return {
    id: s.id,
    source: s.source,
    cwd: s.cwd,
    project: s.cwd ? basename(s.cwd) : "(unknown)",
    git_branch: s.gitBranch,
    model: s.model,
    originator: s.originator,
    title: s.title,
    status: status(s, f.mtimeMs, nowMs),
    last_event: s.lastEvent,
    last_activity_at: s.lastTs ?? new Date(f.mtimeMs).toISOString(),
    started_at: s.startedAt,
    turns: s.turns,
    tool_calls: s.toolCalls,
    sidechain_lines: s.sidechainLines,
    context_tokens: s.contextTokens,
    context_window: s.contextWindow,
    output_tokens: s.outputTokens,
    transcript_path: f.path,
  };
}

export function liveSessions(hours: number): LiveSessionSummary[] {
  const nowMs = Date.now();
  const cutoffMs = nowMs - hours * 3600 * 1000;
  const found = [...scanClaude(cutoffMs), ...scanCodex(cutoffMs)];
  return found
    .map((f) => summarize(f, nowMs))
    .toSorted((a, b) => (b.last_activity_at ?? "").localeCompare(a.last_activity_at ?? ""));
}

export function liveSessionDetail(
  source: LiveSource,
  id: string,
  hours: number,
  limit: number,
): LiveSessionDetail | null {
  const nowMs = Date.now();
  const cutoffMs = nowMs - hours * 3600 * 1000;
  const found = (source === "claude" ? scanClaude(cutoffMs) : scanCodex(cutoffMs)).find(
    (f) => f.id === id,
  );
  if (!found) return null;
  const session = summarize(found, nowMs);
  // Child files append after the main file per poll, so re-order by timestamp
  // before slicing — the feed must read as one chronological stream.
  const feed = (cache.get(found.path)?.s.feed ?? [])
    .toSorted((a, b) => (a.ts ?? "").localeCompare(b.ts ?? ""));
  return { session, activity: feed.slice(-limit) };
}

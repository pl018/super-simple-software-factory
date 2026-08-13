<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, shallowRef } from 'vue'
import type { LiveActivityEntry, LiveSessionDetail } from '../lib/types'
import { fetchLiveSession, killLiveSession, nudgeLiveSession } from '../lib/api'
import { fmtDate, fmtDuration, fmtTokens, ts } from '../lib/format'
import { modelName } from '../lib/models'

const props = defineProps<{ source: string; liveId: string }>()

const detail = shallowRef<LiveSessionDetail | null>(null)
const apiError = ref<string | null>(null)
const nowMs = ref(Date.now())
const feedEl = ref<HTMLElement | null>(null)
const selected = ref<number | null>(null)

let timer: ReturnType<typeof setInterval> | undefined
let inflight = false

async function tick() {
  if (inflight) return
  inflight = true
  try {
    const next = await fetchLiveSession(props.source as 'claude' | 'codex', props.liveId, 48, 400)
    const el = feedEl.value
    // Keep the tail pinned only when the reader is already at the tail.
    const pinned = !el || el.scrollHeight - el.scrollTop - el.clientHeight < 60
    const grew = (detail.value?.activity.length ?? 0) !== next.activity.length
    detail.value = next
    nowMs.value = Date.now()
    apiError.value = null
    if (pinned && grew && selected.value === null) {
      await nextTick()
      feedEl.value?.scrollTo({ top: feedEl.value.scrollHeight })
    }
  } catch (err) {
    apiError.value = err instanceof Error ? err.message : String(err)
  } finally {
    inflight = false
  }
}

onMounted(() => {
  void tick()
  timer = setInterval(() => void tick(), 2000)
})

onUnmounted(() => clearInterval(timer))

function age(): string {
  const t = ts(detail.value?.session.last_activity_at)
  return Number.isFinite(t) ? `${fmtDuration(nowMs.value - t)} ago` : '—'
}

// ── trace geometry ───────────────────────────────────────────────────────────
// Everything derives from the activity feed: each entry is a tick on its lane,
// user→assistant pairs become turn spans. No extra endpoint needed.

const range = computed(() => {
  const d = detail.value
  let t0 = ts(d?.session.started_at)
  let t1 = ts(d?.session.last_activity_at)
  for (const e of d?.activity ?? []) {
    const t = ts(e.ts)
    if (!Number.isFinite(t)) continue
    if (!Number.isFinite(t0) || t < t0) t0 = t
    if (!Number.isFinite(t1) || t > t1) t1 = t
  }
  if (turnStillOpen.value) {
    t1 = Math.max(t1, nowMs.value)
  }
  if (!Number.isFinite(t0)) t0 = nowMs.value
  if (!Number.isFinite(t1) || t1 - t0 < 1000) t1 = t0 + 1000
  return { t0, t1, span: t1 - t0 }
})

function pct(iso: string | null): number | null {
  const t = ts(iso)
  if (!Number.isFinite(t)) return null
  const { t0, span } = range.value
  return Math.min(99.4, Math.max(0.6, ((t - t0) / span) * 100))
}

interface LaneDef {
  id: string
  label: string
  kinds: string[]
  color: string
}

// Feed `kind` → lane. Errors ride the agent lane in red rather than owning a
// lane that is empty in the healthy case.
const LANE_DEFS: LaneDef[] = [
  { id: 'user', label: 'you', kinds: ['user'], color: 'var(--amber)' },
  { id: 'agent', label: 'agent', kinds: ['assistant', 'note', 'meta', 'error'], color: 'var(--purple)' },
  { id: 'tools', label: 'tools', kinds: ['tool'], color: 'var(--blue)' },
  { id: 'subagent', label: 'subagents', kinds: ['subagent'], color: 'var(--cyan)' },
]

interface LaneTick {
  index: number
  x: number
  error: boolean
  entry: LiveActivityEntry
}

const lanes = computed(() => {
  const activity = detail.value?.activity ?? []
  return LANE_DEFS.map((def) => ({
    id: def.id,
    label: def.label,
    color: def.color,
    ticks: activity
      .map((entry, index) => ({ entry, index }))
      .filter(({ entry }) => def.kinds.includes(entry.kind))
      .flatMap(({ entry, index }) => {
        const x = pct(entry.ts)
        return x === null ? [] : [{ index, x, error: entry.kind === 'error', entry }]
      }) satisfies LaneTick[],
  })).filter((lane) => lane.ticks.length > 0 || lane.id === 'user' || lane.id === 'agent')
})

/** Statuses that mean the last turn never closed. */
const turnStillOpen = computed(() => {
  const st = detail.value?.session.status
  return st === 'working' || st === 'stalled' || st === 'dead'
})

/** user→assistant turn spans; an unclosed last turn runs to "now" while open. */
const spans = computed(() => {
  const activity = detail.value?.activity ?? []
  const out: { left: number; width: number; open: boolean }[] = []
  let startPct: number | null = null
  for (const e of activity) {
    if (e.kind === 'user') {
      startPct ??= pct(e.ts)
    } else if (e.kind === 'assistant' && startPct !== null) {
      const end = pct(e.ts)
      if (end !== null) out.push({ left: startPct, width: Math.max(end - startPct, 0.3), open: false })
      startPct = null
    }
  }
  if (startPct !== null && turnStillOpen.value) {
    out.push({ left: startPct, width: Math.max(100 - startPct - 0.6, 0.3), open: true })
  }
  return out
})

// ── feed sections ────────────────────────────────────────────────────────────
// The flat stream rolls up into one section per turn (a user message starts
// one). Inside a section, runs of tool/subagent ticks collapse into a group;
// user/assistant/note/error/meta entries stay visible as message rows.

interface MsgRow {
  type: 'msg'
  e: LiveActivityEntry
  i: number
}

interface GroupRow {
  type: 'group'
  key: string
  items: MsgRow[]
  tools: number
  subs: number
  startTs: string | null
  endTs: string | null
}

type Row = MsgRow | GroupRow

interface Section {
  key: string
  /** 1-based turn number; null for entries before the first user message. */
  turn: number | null
  startTs: string | null
  endTs: string | null
  rows: Row[]
  tools: number
  subs: number
}

const sections = computed<Section[]>(() => {
  const acts = detail.value?.activity ?? []
  const secs: Section[] = []
  let turn = 0
  let cur: Section | null = null
  for (let i = 0; i < acts.length; i++) {
    const e = acts[i]
    if (e.kind === 'user' || cur === null) {
      if (e.kind === 'user') turn += 1
      cur = {
        key: `s${secs.length}`,
        turn: e.kind === 'user' ? turn : null,
        startTs: e.ts,
        endTs: e.ts,
        rows: [],
        tools: 0,
        subs: 0,
      }
      secs.push(cur)
    }
    if (e.ts) cur.endTs = e.ts
    if (e.kind === 'tool' || e.kind === 'subagent') {
      if (e.kind === 'tool') cur.tools += 1
      else cur.subs += 1
      const last = cur.rows[cur.rows.length - 1]
      if (last && last.type === 'group') {
        last.items.push({ type: 'msg', e, i })
        if (e.ts) last.endTs = e.ts
        if (e.kind === 'tool') last.tools += 1
        else last.subs += 1
      } else {
        cur.rows.push({
          type: 'group',
          key: `g${i}`,
          items: [{ type: 'msg', e, i }],
          tools: e.kind === 'tool' ? 1 : 0,
          subs: e.kind === 'subagent' ? 1 : 0,
          startTs: e.ts,
          endTs: e.ts,
        })
      }
    } else {
      cur.rows.push({ type: 'msg', e, i })
    }
  }
  return secs
})

/** activity index → key of the group row that contains it. */
const groupOfIndex = computed(() => {
  const map = new Map<number, string>()
  for (const sec of sections.value) {
    for (const row of sec.rows) {
      if (row.type === 'group') for (const item of row.items) map.set(item.i, row.key)
    }
  }
  return map
})

function isLiveSection(si: number): boolean {
  return si === sections.value.length - 1 && turnStillOpen.value
}

function secDuration(sec: Section, si: number): string {
  const start = ts(sec.startTs)
  if (!Number.isFinite(start)) return ''
  const end = isLiveSection(si) ? nowMs.value : ts(sec.endTs)
  if (!Number.isFinite(end) || end - start < 1500) return ''
  return fmtDuration(end - start)
}

function groupLabel(row: GroupRow): string {
  const parts: string[] = []
  if (row.tools) parts.push(`${row.tools} tool call${row.tools === 1 ? '' : 's'}`)
  if (row.subs) parts.push(`${row.subs} subagent call${row.subs === 1 ? '' : 's'}`)
  const start = ts(row.startTs)
  const end = ts(row.endTs)
  if (Number.isFinite(start) && Number.isFinite(end) && end - start >= 1500) {
    parts.push(fmtDuration(end - start))
  }
  return parts.join(' · ')
}

/** Explicit open/closed choices; groups in the live section default to open. */
const groupOverride = ref<Record<string, boolean>>({})

function isGroupOpen(row: GroupRow, si: number): boolean {
  return groupOverride.value[row.key] ?? isLiveSection(si)
}

function toggleGroup(row: GroupRow, si: number) {
  groupOverride.value = { ...groupOverride.value, [row.key]: !isGroupOpen(row, si) }
}

// ── full-text drill-down ─────────────────────────────────────────────────────

const expanded = ref<Set<number>>(new Set())

function isExpanded(i: number): boolean {
  return expanded.value.has(i)
}

function toggleEntry(i: number) {
  const next = new Set(expanded.value)
  if (next.has(i)) next.delete(i)
  else next.add(i)
  expanded.value = next
  selected.value = i
}

function fullText(e: LiveActivityEntry): string {
  return e.text ?? e.detail
}

/** Trace tick click: open the containing group, expand the entry, scroll. */
async function select(index: number) {
  selected.value = selected.value === index ? null : index
  if (selected.value === null) return
  const groupKey = groupOfIndex.value.get(index)
  if (groupKey) groupOverride.value = { ...groupOverride.value, [groupKey]: true }
  if (!expanded.value.has(index)) expanded.value = new Set(expanded.value).add(index)
  await nextTick()
  document
    .getElementById(`live-entry-${index}`)
    ?.scrollIntoView({ block: 'center', behavior: 'smooth' })
}

// ── stall / dead actions ─────────────────────────────────────────────────────

const killArm = ref<number | null>(null)
const actionMsg = ref<string | null>(null)
const nudgeMode = ref<'report' | 'continue'>('report')
const nudgePrompt = ref('')
const nudgeBusy = ref(false)
const showNudgeTail = ref(false)

async function doKill(pid: number, force: boolean) {
  killArm.value = null
  try {
    const res = await killLiveSession(props.source as 'claude' | 'codex', props.liveId, pid, force)
    actionMsg.value = `sent ${res.signal} to pid ${res.pid}`
  } catch (err) {
    actionMsg.value = err instanceof Error ? err.message : String(err)
  }
}

async function doNudge() {
  nudgeBusy.value = true
  actionMsg.value = null
  try {
    await nudgeLiveSession(
      props.source as 'claude' | 'codex',
      props.liveId,
      nudgeMode.value,
      nudgePrompt.value.trim() || null,
    )
    showNudgeTail.value = true
  } catch (err) {
    actionMsg.value = err instanceof Error ? err.message : String(err)
  } finally {
    nudgeBusy.value = false
  }
}
</script>

<template>
  <div class="detail">
    <div v-if="apiError" class="error-bar">api unreachable — retrying {{ apiError }}</div>

    <template v-if="detail">
      <div class="head">
        <div class="head-row">
          <span class="status" :class="detail.session.status">{{ detail.session.status }}</span>
          <span class="project">{{ detail.session.project }}</span>
          <span v-if="detail.session.git_branch" class="mono branch">{{
            detail.session.git_branch
          }}</span>
          <span class="dim">{{ age() }}</span>
        </div>
        <div class="head-row dim small">
          <span>{{ detail.session.source }}</span>
          <span v-if="detail.session.model" class="mono">{{ modelName(detail.session.model) }}</span>
          <span>started {{ fmtDate(detail.session.started_at) }}</span>
          <span>{{ detail.session.turns }} turns · {{ detail.session.tool_calls }} tools</span>
          <span>out {{ fmtTokens(detail.session.output_tokens) }}</span>
          <span
            v-if="detail.session.context_tokens != null"
            >context {{ fmtTokens(detail.session.context_tokens) }}<template
              v-if="detail.session.context_window"
            >
              / {{ fmtTokens(detail.session.context_window) }}</template
            ></span
          >
        </div>
        <div class="head-row faint small mono">{{ detail.session.transcript_path }}</div>

        <!-- stalled: a process is alive but nothing moved past the threshold -->
        <div v-if="detail.session.status === 'stalled'" class="alert stalled-alert">
          <div class="alert-text">
            A turn is open with no transcript growth for {{ age() }} — the process is alive.
            This can be a long build, a hung call, or an unanswered permission prompt.
            Check the terminal first; kill only if it is truly wedged.
          </div>
          <div v-for="p in detail.proc_match?.procs ?? []" :key="p.pid" class="proc-row">
            <span class="mono pid">pid {{ p.pid }}</span>
            <span class="mono argv" :title="p.argv">{{ p.argv }}</span>
            <template v-if="killArm !== p.pid">
              <button class="act" @click="killArm = p.pid">kill…</button>
            </template>
            <template v-else>
              <button class="act danger" @click="doKill(p.pid, false)">confirm SIGTERM</button>
              <button class="act danger" @click="doKill(p.pid, true)">force SIGKILL</button>
              <button class="act" @click="killArm = null">cancel</button>
            </template>
          </div>
          <div v-if="detail.proc_match?.kind === 'cwd'" class="small faint">
            Matched by working directory only — read the command line before you kill.
            Another session in the same directory can be a false match.
          </div>
        </div>

        <!-- dead: no process owns the session; offer the one-time nudge -->
        <div v-else-if="detail.session.status === 'dead'" class="alert dead-alert">
          <div class="alert-text">
            The CLI died with a turn open — nothing comes back on its own.
            A nudge makes ONE resume call to this session ({{ detail.session.source === 'claude'
              ? 'claude -p --resume' : 'codex exec resume' }}).
          </div>
          <template v-if="detail.nudge?.status !== 'running'">
            <div class="nudge-controls">
              <button
                class="act"
                :class="{ on: nudgeMode === 'report' }"
                title="Ask for a status report only; grants no tool permissions."
                @click="nudgeMode = 'report'"
              >
                ask for status
              </button>
              <button
                class="act"
                :class="{ on: nudgeMode === 'continue' }"
                title="Tell it to continue the task; grants edit permissions (acceptEdits)."
                @click="nudgeMode = 'continue'"
              >
                continue work
              </button>
              <button class="act danger" :disabled="nudgeBusy" @click="doNudge">
                {{ nudgeBusy ? 'starting…' : 'send one-time nudge' }}
              </button>
            </div>
            <textarea
              v-model="nudgePrompt"
              class="nudge-prompt mono"
              rows="2"
              placeholder="optional custom prompt — leave empty for the default"
            />
          </template>
        </div>

        <!-- nudge state survives status changes; show it whenever one exists -->
        <div v-if="detail.nudge" class="alert nudge-state">
          <div class="alert-text">
            nudge ({{ detail.nudge.mode }})
            <span :class="`nudge-${detail.nudge.status}`">{{ detail.nudge.status }}</span>
            · started {{ fmtDate(detail.nudge.started_at) }}
            <template v-if="detail.nudge.exit_code !== null">
              · exit {{ detail.nudge.exit_code }}</template
            >
            <button class="act" @click="showNudgeTail = !showNudgeTail">
              {{ showNudgeTail ? 'hide output' : 'show output' }}
            </button>
          </div>
          <pre v-if="showNudgeTail" class="fulltext nudge-tail">{{
            detail.nudge.output_tail || '(no output yet)'
          }}</pre>
        </div>

        <div v-if="actionMsg" class="small action-msg mono">{{ actionMsg }}</div>
      </div>

      <div class="trace">
        <div v-for="lane in lanes" :key="lane.id" class="trace-lane">
          <span class="trace-label" :style="{ color: lane.color }">{{ lane.label }}</span>
          <div class="trace-track">
            <template v-if="lane.id === 'agent'">
              <span
                v-for="(sp, i) in spans"
                :key="`sp${i}`"
                class="turn-span"
                :class="{ open: sp.open }"
                :style="{ left: `${sp.left}%`, width: `${sp.width}%` }"
              />
            </template>
            <button
              v-for="t in lane.ticks"
              :key="t.index"
              class="tick"
              :class="{ err: t.error, selected: t.index === selected }"
              :style="{ left: `${t.x}%`, background: t.error ? 'var(--red)' : lane.color }"
              :title="`${t.entry.ts ? t.entry.ts.slice(11, 19) : ''} ${t.entry.label}\n${t.entry.detail}`"
              @click="select(t.index)"
            />
          </div>
        </div>
      </div>

      <div ref="feedEl" class="feed">
        <div v-for="(sec, si) in sections" :key="sec.key" class="section">
          <div class="sec-head">
            <span class="sec-turn" :class="{ live: isLiveSection(si) }">
              {{ sec.turn === null ? 'session start' : `turn ${sec.turn}` }}
            </span>
            <span class="ts mono">{{ sec.startTs ? sec.startTs.slice(11, 19) : '' }}</span>
            <span v-if="secDuration(sec, si)" class="dim">{{ secDuration(sec, si) }}</span>
            <span v-if="sec.tools || sec.subs" class="faint">
              {{ sec.tools }} tools<template v-if="sec.subs"> · {{ sec.subs }} subagents</template>
            </span>
            <span v-if="isLiveSection(si)" class="sec-live" :class="detail.session.status">{{
              detail.session.status
            }}</span>
          </div>

          <template v-for="row in sec.rows" :key="row.type === 'msg' ? `m${row.i}` : row.key">
            <div
              v-if="row.type === 'msg'"
              :id="`live-entry-${row.i}`"
              class="entry"
              :class="[row.e.kind, { selected: row.i === selected }]"
              @click="toggleEntry(row.i)"
            >
              <span class="ts mono">{{ row.e.ts ? row.e.ts.slice(11, 19) : '' }}</span>
              <span class="label mono">{{ row.e.label }}</span>
              <pre v-if="isExpanded(row.i)" class="fulltext">{{ fullText(row.e) }}</pre>
              <span v-else class="text">{{ row.e.detail }}</span>
            </div>

            <div v-else class="group">
              <button class="group-head mono" @click="toggleGroup(row, si)">
                <span class="caret">{{ isGroupOpen(row, si) ? '▾' : '▸' }}</span>
                {{ groupLabel(row) }}
              </button>
              <template v-if="isGroupOpen(row, si)">
                <div
                  v-for="item in row.items"
                  :id="`live-entry-${item.i}`"
                  :key="item.i"
                  class="entry grouped"
                  :class="[item.e.kind, { selected: item.i === selected }]"
                  @click="toggleEntry(item.i)"
                >
                  <span class="ts mono">{{ item.e.ts ? item.e.ts.slice(11, 19) : '' }}</span>
                  <span class="label mono">{{ item.e.label }}</span>
                  <pre v-if="isExpanded(item.i)" class="fulltext">{{ fullText(item.e) }}</pre>
                  <span v-else class="text">{{ item.e.detail }}</span>
                </div>
              </template>
            </div>
          </template>
        </div>
        <div v-if="!detail.activity.length" class="empty-state">no parsed activity yet</div>
      </div>
    </template>
    <div v-else-if="!apiError" class="empty-state">loading session…</div>
  </div>
</template>

<style scoped>
.detail {
  display: flex;
  flex-direction: column;
  height: calc(100vh - 62px);
}

.head {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 16px 24px 12px;
  border-bottom: 1px solid var(--border-soft);
}

.head-row {
  display: flex;
  align-items: center;
  gap: 14px;
  min-width: 0;
  flex-wrap: wrap;
}

.status {
  padding: 2px 10px;
  border-radius: 999px;
  font-size: 13px;
  border: 1px solid var(--border);
  color: var(--dim);
}

.status.working {
  color: var(--green);
  border-color: rgba(74, 222, 128, 0.5);
}

.status.stalled {
  color: var(--red);
  border-color: rgba(255, 111, 103, 0.6);
}

.status.dead {
  color: var(--red);
  border-color: var(--red);
  background: rgba(255, 111, 103, 0.12);
}

.status.waiting {
  color: var(--amber);
  border-color: rgba(232, 182, 74, 0.5);
}

.project {
  font-weight: 700;
  font-size: 18px;
}

.branch {
  color: var(--cyan);
  font-size: 13px;
}

.small {
  font-size: 13px;
}

.dim {
  color: var(--dim);
}

.faint {
  color: var(--faint);
}

.mono {
  font-family: var(--mono);
}

/* ── stall / dead alerts ─────────────────────────────────────────────────── */
.alert {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-top: 4px;
  padding: 10px 14px;
  border-radius: 10px;
  border: 1px solid rgba(255, 111, 103, 0.4);
  background: rgba(255, 111, 103, 0.07);
  font-size: 14px;
}

.dead-alert {
  border-color: var(--red);
}

.nudge-state {
  border-color: rgba(90, 210, 221, 0.4);
  background: rgba(90, 210, 221, 0.06);
}

.alert-text {
  color: var(--dim);
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.proc-row {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
}

.pid {
  color: var(--red);
  flex: none;
}

.argv {
  color: var(--faint);
  font-size: 12px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  flex: 1;
}

.act {
  padding: 2px 10px;
  border-radius: 999px;
  border: 1px solid var(--border);
  background: transparent;
  color: var(--dim);
  font-size: 13px;
  cursor: pointer;
  flex: none;
}

.act:hover {
  color: var(--text);
  border-color: var(--cyan);
}

.act.on {
  color: var(--cyan);
  border-color: var(--cyan);
  background: rgba(90, 210, 221, 0.08);
}

.act.danger {
  color: var(--red);
  border-color: rgba(255, 111, 103, 0.6);
}

.act.danger:hover {
  border-color: var(--red);
  background: rgba(255, 111, 103, 0.12);
}

.nudge-controls {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.nudge-prompt {
  width: 100%;
  resize: vertical;
  padding: 6px 10px;
  border-radius: 8px;
  border: 1px solid var(--border);
  background: rgba(6, 8, 15, 0.4);
  color: var(--text);
  font-size: 13px;
}

.nudge-running {
  color: var(--amber);
}

.nudge-done {
  color: var(--green);
}

.nudge-failed {
  color: var(--red);
}

.nudge-tail {
  max-height: 220px;
  overflow-y: auto;
}

.action-msg {
  color: var(--amber);
}

/* ── swim-lane trace ─────────────────────────────────────────────────────── */
.trace {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 10px 24px 12px;
  border-bottom: 1px solid var(--border-soft);
  background: var(--panel-3);
}

.trace-lane {
  display: grid;
  grid-template-columns: 92px 1fr;
  align-items: center;
  gap: 12px;
}

.trace-label {
  font-size: 12px;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  text-align: right;
}

.trace-track {
  position: relative;
  height: 22px;
  border-radius: 6px;
  background: rgba(6, 8, 15, 0.55);
  border: 1px solid var(--border-soft);
}

.turn-span {
  position: absolute;
  top: 4px;
  bottom: 4px;
  border-radius: 4px;
  background: rgba(200, 155, 255, 0.14);
  border: 1px solid rgba(200, 155, 255, 0.3);
}

.turn-span.open {
  border-style: dashed;
  animation: pulse 1.6s ease-in-out infinite;
}

.tick {
  position: absolute;
  top: 3px;
  bottom: 3px;
  width: 4px;
  border: none;
  border-radius: 2px;
  padding: 0;
  cursor: pointer;
  opacity: 0.85;
  transform: translateX(-50%);
}

.tick:hover {
  opacity: 1;
  box-shadow: 0 0 8px currentColor;
}

.tick.selected {
  outline: 2px solid var(--text);
  outline-offset: 1px;
  opacity: 1;
}

.tick.err {
  opacity: 1;
}

/* ── feed ────────────────────────────────────────────────────────────────── */
.feed {
  flex: 1;
  overflow-y: auto;
  padding: 12px 24px 24px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.section {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin-top: 10px;
}

.sec-head {
  display: flex;
  align-items: baseline;
  gap: 12px;
  padding: 4px 10px;
  border-bottom: 1px solid var(--border-soft);
  font-size: 13px;
  position: sticky;
  top: -12px;
  background: var(--bg, #0b0e17);
  z-index: 1;
}

.sec-turn {
  font-weight: 700;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--amber);
  font-size: 12px;
}

.sec-turn.live {
  color: var(--green);
}

.sec-live {
  margin-left: auto;
  font-size: 12px;
  text-transform: uppercase;
  letter-spacing: 0.06em;
}

.sec-live.working {
  color: var(--green);
}

.sec-live.stalled,
.sec-live.dead {
  color: var(--red);
}

.entry {
  display: grid;
  grid-template-columns: 68px 130px 1fr;
  gap: 12px;
  padding: 5px 10px;
  border-radius: 8px;
  font-size: 14px;
  align-items: baseline;
  cursor: pointer;
}

.entry:hover {
  background: var(--panel);
}

.entry.selected {
  background: var(--panel-2);
  outline: 1px solid var(--blue);
}

.ts {
  color: var(--faint);
  font-size: 12px;
}

.label {
  font-size: 13px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.entry.user .label {
  color: var(--amber);
}

.entry.assistant .label,
.entry.note .label {
  color: var(--purple);
}

.entry.note .text,
.entry.note .fulltext {
  color: var(--dim);
  font-style: italic;
}

.entry.tool .label {
  color: var(--blue);
}

.entry.subagent .label {
  color: var(--cyan);
}

.entry.error .label,
.entry.error .text {
  color: var(--red);
}

.entry.meta .label {
  color: var(--faint);
}

.text {
  color: var(--dim);
  overflow-wrap: anywhere;
}

.entry.user .text,
.entry.user .fulltext {
  color: var(--text);
}

.entry.assistant .fulltext {
  color: var(--text);
}

.fulltext {
  margin: 0;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  font-family: var(--mono);
  font-size: 13px;
  line-height: 1.5;
  color: var(--dim);
  background: rgba(6, 8, 15, 0.45);
  border: 1px solid var(--border-soft);
  border-radius: 8px;
  padding: 10px 12px;
}

/* ── tool groups ─────────────────────────────────────────────────────────── */
.group {
  display: flex;
  flex-direction: column;
  gap: 2px;
  border-left: 2px solid var(--border-soft);
  margin-left: 6px;
}

.group-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 10px;
  border: none;
  background: transparent;
  color: var(--faint);
  font-size: 13px;
  cursor: pointer;
  text-align: left;
}

.group-head:hover {
  color: var(--text);
}

.caret {
  color: var(--blue);
}

.entry.grouped {
  margin-left: 10px;
}
</style>

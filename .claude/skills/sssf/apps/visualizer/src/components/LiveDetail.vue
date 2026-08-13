<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, shallowRef } from 'vue'
import type { LiveActivityEntry, LiveSessionDetail } from '../lib/types'
import { fetchLiveSession } from '../lib/api'
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
  if (d?.session.status === 'working' || d?.session.status === 'stalled') {
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
  { id: 'agent', label: 'agent', kinds: ['assistant', 'meta', 'error'], color: 'var(--purple)' },
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

/** user→assistant turn spans; an unclosed last turn runs to "now" while working. */
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
  const st = detail.value?.session.status
  if (startPct !== null && (st === 'working' || st === 'stalled')) {
    out.push({ left: startPct, width: Math.max(100 - startPct - 0.6, 0.3), open: true })
  }
  return out
})

async function select(index: number) {
  selected.value = selected.value === index ? null : index
  if (selected.value === null) return
  await nextTick()
  document
    .getElementById(`live-entry-${index}`)
    ?.scrollIntoView({ block: 'center', behavior: 'smooth' })
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
        <div
          v-for="(e, i) in detail.activity"
          :id="`live-entry-${i}`"
          :key="i"
          class="entry"
          :class="[e.kind, { selected: i === selected }]"
          @click="select(i)"
        >
          <span class="ts mono">{{ e.ts ? e.ts.slice(11, 19) : '' }}</span>
          <span class="label mono">{{ e.label }}</span>
          <span class="text">{{ e.detail }}</span>
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

.entry.assistant .label {
  color: var(--purple);
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

.entry.user .text {
  color: var(--text);
}
</style>

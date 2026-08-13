<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, shallowRef } from 'vue'
import type { LiveSessionSummary, LiveStatus } from '../lib/types'
import { fetchLiveSessions } from '../lib/api'
import { fmtDuration, fmtTokens, ts } from '../lib/format'
import { liveHref } from '../lib/router'
import { modelIcon, modelName } from '../lib/models'

const sessions = shallowRef<LiveSessionSummary[]>([])
const apiError = ref<string | null>(null)
const loaded = ref(false)
const nowMs = ref(Date.now())

let timer: ReturnType<typeof setInterval> | undefined
let inflight = false

async function tick() {
  if (inflight) return
  inflight = true
  try {
    sessions.value = await fetchLiveSessions(24)
    nowMs.value = Date.now()
    apiError.value = null
    loaded.value = true
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

// Severity order: what needs eyes first.
const SECTIONS: { status: LiveStatus; label: string }[] = [
  { status: 'stalled', label: 'stalled — a turn is open but nothing is moving' },
  { status: 'working', label: 'working' },
  { status: 'waiting', label: 'waiting on you' },
  { status: 'idle', label: 'idle' },
]

type GroupMode = 'status' | 'project' | 'source'
const MODES: GroupMode[] = ['status', 'project', 'source']
const mode = ref<GroupMode>('status')

interface Group {
  key: string
  label: string
  /** Styles the section dot; only status groups carry a live status. */
  status: LiveStatus | 'plain'
  rows: LiveSessionSummary[]
}

function byActivity(a: LiveSessionSummary, b: LiveSessionSummary): number {
  return (ts(b.last_activity_at) || 0) - (ts(a.last_activity_at) || 0)
}

const grouped = computed<Group[]>(() => {
  if (mode.value === 'status') {
    return SECTIONS.map(({ status, label }) => ({
      key: status,
      label,
      status,
      rows: sessions.value.filter((s) => s.status === status).toSorted(byActivity),
    })).filter((g) => g.rows.length > 0)
  }
  const keyOf = (s: LiveSessionSummary) => (mode.value === 'project' ? s.project : s.source)
  const map = new Map<string, LiveSessionSummary[]>()
  for (const s of sessions.value.toSorted(byActivity)) {
    const rows = map.get(keyOf(s)) ?? []
    rows.push(s)
    map.set(keyOf(s), rows)
  }
  // Map preserves insertion order, so groups rank by their freshest session.
  return [...map.entries()].map(([key, rows]) => ({ key, label: key, status: 'plain' as const, rows }))
})

function age(s: LiveSessionSummary): string {
  const t = ts(s.last_activity_at)
  if (!Number.isFinite(t)) return '—'
  return fmtDuration(nowMs.value - t)
}

/** Claude transcripts carry no window size; 200k is the fleet default. */
function windowOf(s: LiveSessionSummary): number {
  return s.context_window || (s.source === 'claude' ? 200000 : 0)
}

function ctxPct(s: LiveSessionSummary): number | null {
  const win = windowOf(s)
  if (!win || s.context_tokens == null) return null
  return Math.min(100, Math.round((s.context_tokens / win) * 100))
}

function sourceIcon(s: LiveSessionSummary): string | null {
  return modelIcon(s.model) ?? (s.source === 'claude' ? '/models/claude.png' : '/models/openai.png')
}
</script>

<template>
  <div class="live">
    <div v-if="apiError" class="error-bar">api unreachable — retrying {{ apiError }}</div>

    <div class="toolbar">
      <span class="toolbar-label">group by</span>
      <button
        v-for="m in MODES"
        :key="m"
        class="mode-btn"
        :class="{ active: mode === m }"
        @click="mode = m"
      >
        {{ m }}
      </button>
    </div>

    <template v-for="g in grouped" :key="g.key">
      <div class="section-head" :class="g.status">
        <span class="section-dot" />
        {{ g.label }} · {{ g.rows.length }}
      </div>
      <div class="cards">
        <a v-for="s in g.rows" :key="`${s.source}:${s.id}`" class="card" :class="s.status"
          :href="liveHref(s.source, s.id)">
          <div class="row top">
            <img v-if="sourceIcon(s)" class="icon" :src="sourceIcon(s)!" :alt="s.source" />
            <span class="project" :title="s.cwd">{{ s.project }}</span>
            <span v-if="s.git_branch" class="branch mono">{{ s.git_branch }}</span>
            <span class="age" :title="s.last_activity_at ?? ''">{{ age(s) }} ago</span>
          </div>
          <div class="title" :title="s.title ?? ''">{{ s.title || '(no prompt yet)' }}</div>
          <div class="row last">
            <span class="last-event mono">{{ s.last_event ?? '—' }}</span>
          </div>
          <div class="row meta">
            <span v-if="s.model" class="mono dim" :title="s.model">{{ modelName(s.model) }}</span>
            <span v-if="s.originator === 'codex_exec'" class="tag">headless</span>
            <span class="dim">{{ s.turns }} turns · {{ s.tool_calls }} tools</span>
            <span class="dim">out {{ fmtTokens(s.output_tokens) }}</span>
            <span v-if="ctxPct(s) !== null" class="ctx" :title="`context ${fmtTokens(s.context_tokens)} / ${fmtTokens(windowOf(s))}`">
              <span class="ctx-bar"><span class="ctx-fill" :style="{ width: `${ctxPct(s)}%` }" /></span>
              {{ ctxPct(s) }}%
            </span>
          </div>
        </a>
      </div>
    </template>

    <div v-if="loaded && !grouped.length" class="empty-state">
      no live sessions in the last 24 h
    </div>
    <div v-else-if="!loaded && !apiError" class="empty-state">scanning transcripts…</div>
  </div>
</template>

<style scoped>
.live {
  display: flex;
  flex-direction: column;
  padding-bottom: 28px;
}

.toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 14px 24px 0;
}

.toolbar-label {
  font-size: 13px;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--faint);
  margin-right: 4px;
}

.mode-btn {
  padding: 3px 12px;
  border-radius: 999px;
  border: 1px solid var(--border);
  background: transparent;
  color: var(--dim);
  font-size: 14px;
  cursor: pointer;
}

.mode-btn:hover {
  color: var(--text);
  border-color: var(--cyan);
}

.mode-btn.active {
  color: var(--cyan);
  border-color: var(--cyan);
  background: rgba(90, 210, 221, 0.08);
}

.section-head {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 18px 24px 0;
  font-size: 16px;
  color: var(--dim);
}

.section-head.plain {
  color: var(--text);
  font-weight: 700;
}

.section-head.plain .section-dot {
  background: var(--cyan);
}

.section-dot {
  width: 9px;
  height: 9px;
  border-radius: 50%;
  background: var(--faint);
}

.section-head.working .section-dot {
  background: var(--green);
  box-shadow: 0 0 8px rgba(74, 222, 128, 0.7);
  animation: pulse 1.6s ease-in-out infinite;
}

.section-head.stalled {
  color: var(--red);
}

.section-head.stalled .section-dot {
  background: var(--red);
  box-shadow: 0 0 8px rgba(255, 111, 103, 0.7);
}

.section-head.waiting .section-dot {
  background: var(--amber);
}

.cards {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(430px, 1fr));
  gap: 14px;
  padding: 12px 24px 6px;
}

.card {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 14px 16px;
  border-radius: 12px;
  background: var(--surface);
  border: 1px solid var(--border-soft);
  color: var(--text);
  transition: border-color 0.15s ease;
}

.card:hover {
  border-color: var(--cyan);
}

.card.stalled {
  border-color: rgba(255, 111, 103, 0.55);
}

.card.working {
  border-color: rgba(74, 222, 128, 0.35);
}

.row {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
}

.icon {
  width: 18px;
  height: 18px;
  border-radius: 4px;
  flex: none;
}

.project {
  font-weight: 700;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.branch {
  color: var(--cyan);
  font-size: 13px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 180px;
}

.age {
  margin-left: auto;
  color: var(--faint);
  font-size: 14px;
  white-space: nowrap;
}

.title {
  color: var(--dim);
  font-size: 15px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.last-event {
  color: var(--blue);
  font-size: 13px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.meta {
  font-size: 13px;
  flex-wrap: wrap;
}

.dim {
  color: var(--faint);
}

.mono {
  font-family: var(--mono);
}

.tag {
  padding: 1px 7px;
  border-radius: 999px;
  border: 1px solid var(--border);
  color: var(--violet);
  font-size: 12px;
}

.ctx {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  margin-left: auto;
  color: var(--faint);
}

.ctx-bar {
  width: 64px;
  height: 5px;
  border-radius: 3px;
  background: var(--panel-2);
  overflow: hidden;
}

.ctx-fill {
  display: block;
  height: 100%;
  border-radius: 3px;
  background: linear-gradient(90deg, var(--cyan), var(--purple));
}
</style>

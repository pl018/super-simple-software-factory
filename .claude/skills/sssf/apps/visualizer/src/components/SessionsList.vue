<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, shallowRef } from 'vue'
import type { SessionSummary } from '../lib/types'
import { fetchSessions } from '../lib/api'
import { ts } from '../lib/format'
import SessionCard from './SessionCard.vue'

const sessions = shallowRef<SessionSummary[]>([])
const apiError = ref<string | null>(null)
const loaded = ref(false)
const nowMs = ref(Date.now())

let timer: ReturnType<typeof setInterval> | undefined
let inflight = false

async function tick() {
  if (inflight) return
  inflight = true
  try {
    sessions.value = await fetchSessions()
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
  timer = setInterval(() => void tick(), 500)
})

onUnmounted(() => clearInterval(timer))

/** Optimistic removal; an empty id means the write failed, so re-sync instead. */
function onArchived(adwId: string) {
  if (!adwId) {
    void tick()
    return
  }
  sessions.value = sessions.value.filter((s) => s.adw_id !== adwId)
}

const ordered = computed(() =>
  sessions.value.toSorted((a, b) => (ts(b.started_at) || 0) - (ts(a.started_at) || 0)),
)

// ── grouping ─────────────────────────────────────────────────────────────────

type GroupMode = 'none' | 'workflow' | 'status' | 'day'
const MODES: GroupMode[] = ['none', 'workflow', 'status', 'day']
const mode = ref<GroupMode>('none')

/** Status sections rank by urgency; other modes rank by freshest run. */
const STATUS_ORDER = ['running', 'fail', 'success']

function keyOf(s: SessionSummary): string {
  if (mode.value === 'workflow') return s.adw_name ?? '(no workflow)'
  if (mode.value === 'status') return s.status ?? 'fail'
  const t = ts(s.started_at)
  return Number.isFinite(t)
    ? new Date(t).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })
    : '(no date)'
}

const grouped = computed(() => {
  if (mode.value === 'none') {
    return [{ key: 'all', label: `${ordered.value.length} runs`, rows: ordered.value }]
  }
  const map = new Map<string, SessionSummary[]>()
  for (const s of ordered.value) {
    const rows = map.get(keyOf(s)) ?? []
    rows.push(s)
    map.set(keyOf(s), rows)
  }
  const groups = [...map.entries()].map(([key, rows]) => ({
    key,
    label: `${key} · ${rows.length}`,
    rows,
  }))
  if (mode.value === 'status') {
    groups.sort((a, b) => STATUS_ORDER.indexOf(a.key) - STATUS_ORDER.indexOf(b.key))
  }
  return groups
})
</script>

<template>
  <div class="sessions">
    <div v-if="apiError" class="error-bar">api unreachable — retrying {{ apiError }}</div>

    <div v-if="ordered.length" class="toolbar">
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
      <div class="list-head" :class="{ dim: mode === 'none', [`st-${g.key}`]: mode === 'status' }">
        <span v-if="mode !== 'none'" class="section-dot" />
        {{ g.label }}
      </div>
      <div class="cards">
        <SessionCard
          v-for="s in g.rows"
          :key="s.adw_id"
          :session="s"
          :now-ms="nowMs"
          @archived="onArchived"
        />
      </div>
    </template>

    <div v-if="loaded && !ordered.length" class="empty-state">
      no sessions yet — run an ADW to see it here
    </div>
    <div v-else-if="!loaded && !apiError" class="empty-state">loading sessions…</div>
  </div>
</template>

<style scoped>
.sessions {
  display: flex;
  flex-direction: column;
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

.list-head {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 16px 24px 0;
  font-size: 16px;
  color: var(--text);
  font-weight: 700;
}

.list-head.dim {
  color: var(--dim);
  font-weight: 400;
}

.section-dot {
  width: 9px;
  height: 9px;
  border-radius: 50%;
  background: var(--cyan);
}

.list-head.st-running .section-dot {
  background: var(--blue);
  box-shadow: 0 0 8px rgba(108, 182, 255, 0.7);
  animation: pulse 1.6s ease-in-out infinite;
}

.list-head.st-fail {
  color: var(--red);
}

.list-head.st-fail .section-dot {
  background: var(--red);
}

.list-head.st-success .section-dot {
  background: var(--green);
}

.cards {
  /* Uniform grid: every card the same width and (fixed in SessionCard) height,
     independent of content. */
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(460px, 1fr));
  gap: 18px;
  padding: 16px 24px 28px;
}
</style>

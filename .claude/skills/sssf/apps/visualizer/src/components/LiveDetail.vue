<script setup lang="ts">
import { nextTick, onMounted, onUnmounted, ref, shallowRef } from 'vue'
import type { LiveSessionDetail } from '../lib/types'
import { fetchLiveSession } from '../lib/api'
import { fmtDate, fmtDuration, fmtTokens, ts } from '../lib/format'
import { modelName } from '../lib/models'

const props = defineProps<{ source: string; liveId: string }>()

const detail = shallowRef<LiveSessionDetail | null>(null)
const apiError = ref<string | null>(null)
const nowMs = ref(Date.now())
const feedEl = ref<HTMLElement | null>(null)

let timer: ReturnType<typeof setInterval> | undefined
let inflight = false

async function tick() {
  if (inflight) return
  inflight = true
  try {
    const next = await fetchLiveSession(props.source as 'claude' | 'codex', props.liveId, 48, 200)
    const el = feedEl.value
    // Keep the tail pinned only when the reader is already at the tail.
    const pinned = !el || el.scrollHeight - el.scrollTop - el.clientHeight < 60
    const grew = (detail.value?.activity.length ?? 0) !== next.activity.length
    detail.value = next
    nowMs.value = Date.now()
    apiError.value = null
    if (pinned && grew) {
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
        <div v-if="detail.session.title" class="head-row dim small">
          “{{ detail.session.title }}”
        </div>
      </div>

      <div ref="feedEl" class="feed">
        <div v-for="(e, i) in detail.activity" :key="i" class="entry" :class="e.kind">
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
}

.entry:hover {
  background: var(--panel);
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

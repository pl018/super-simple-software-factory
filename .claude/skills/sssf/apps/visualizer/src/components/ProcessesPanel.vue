<script setup lang="ts">
import type { ProcessRow } from '../lib/types'
import { fmtClock } from '../lib/format'

defineProps<{ processes: ProcessRow[] }>()

function processName(process: ProcessRow): string {
  if (process.name) return process.name
  return process.kind === 'adw' ? 'workflow' : '—'
}
</script>

<template>
  <section class="processes-panel">
    <h3>processes ({{ processes.length }})</h3>
    <div class="process-head" aria-hidden="true">
      <span>status</span>
      <span>kind</span>
      <span>name</span>
      <span>pid</span>
      <span>command</span>
      <span>started</span>
    </div>
    <div
      v-for="process in processes"
      :key="process.id"
      class="process-row"
      :class="{ alive: process.ended_at === null }"
    >
      <span class="process-state" :class="{ alive: process.ended_at === null }">
        <span class="state-dot" />
        <span v-if="process.ended_at === null">alive</span>
        <span v-else>ended {{ fmtClock(process.ended_at) }}</span>
      </span>
      <span class="process-kind">{{ process.kind ?? '—' }}</span>
      <span class="process-name">{{ processName(process) }}</span>
      <span class="process-pid">{{ process.pid ?? '—' }}</span>
      <span class="process-command" :title="process.command ?? ''">{{ process.command ?? '—' }}</span>
      <span class="process-start">{{ fmtClock(process.started_at) }}</span>
    </div>
  </section>
</template>

<style scoped>
.processes-panel {
  margin: 0 28px 20px;
  padding: 16px 18px 18px;
  border: 1px solid var(--border-soft);
  border-radius: 16px;
  background: var(--surface);
}

h3 {
  margin: 0 0 10px;
  padding-bottom: 6px;
  border-bottom: 1px solid var(--border-soft);
  color: var(--dim);
  font-size: 16px;
  font-weight: 700;
  letter-spacing: 0.05em;
  text-transform: lowercase;
}

.process-head,
.process-row {
  display: grid;
  grid-template-columns: 170px 64px minmax(110px, 0.7fr) 72px minmax(220px, 2fr) 96px;
  gap: 12px;
  align-items: center;
}

.process-head {
  padding: 4px 10px 6px 13px;
  color: var(--faint);
  font-family: var(--mono);
  font-size: 16px;
}

.process-row {
  min-width: 0;
  padding: 8px 10px;
  border-bottom: 1px solid var(--border-soft);
  border-left: 3px solid transparent;
  font-family: var(--mono);
  font-size: 16px;
}

.process-row:last-child {
  border-bottom: none;
}

.process-row.alive {
  border-left-color: var(--green);
  background: rgba(74, 222, 128, 0.07);
}

.process-state {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  color: var(--faint);
  white-space: nowrap;
}

.process-state.alive {
  color: var(--green);
}

.state-dot {
  width: 9px;
  height: 9px;
  flex: none;
  border-radius: 50%;
  background: var(--faint);
}

.process-state.alive .state-dot {
  background: var(--green);
  box-shadow: 0 0 10px rgba(74, 222, 128, 0.7);
  animation: pulse 1.6s ease-in-out infinite;
}

.process-kind,
.process-pid,
.process-start {
  color: var(--dim);
  font-variant-numeric: tabular-nums;
}

.process-name,
.process-command {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

@keyframes pulse {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0.35;
  }
}

@media (max-width: 1000px) {
  .processes-panel {
    overflow-x: auto;
  }

  .process-head,
  .process-row {
    min-width: 900px;
  }
}
</style>

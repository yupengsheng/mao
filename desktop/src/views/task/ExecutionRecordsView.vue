<template>
  <section class="execution-records">
    <header class="records-header">
      <div>
        <h1>执行记录</h1>
        <p>查看任务的执行状态、入口来源和每次执行结果。</p>
      </div>
      <div class="header-actions">
        <span class="refresh-hint">可见时每 10 秒刷新</span>
        <button type="button" :disabled="loading || detailLoading" @click="refresh">刷新</button>
        <button type="button" @click="goBack">返回工作台</button>
      </div>
    </header>

    <div class="records-filters">
      <label>状态
        <select v-model="filters.stage" aria-label="筛选执行状态">
          <option value="">全部状态</option>
          <option v-for="(label, value) in TASK_STAGE_LABELS" :key="value" :value="value">{{ label }}</option>
        </select>
      </label>
      <label>首次来源
        <select v-model="filters.source" aria-label="筛选首次来源">
          <option value="">全部来源</option>
          <option v-for="(label, value) in TASK_SOURCE_LABELS" :key="value" :value="value">{{ label }}</option>
        </select>
      </label>
      <span class="record-count">共 {{ total }} 个任务</span>
    </div>

    <div class="records-content">
      <div class="record-list-panel" aria-label="执行任务列表" :aria-busy="loading">
        <div v-if="error" class="empty-state" role="alert">
          <p>{{ error }}</p>
          <button type="button" data-action="retry-list" @click="refresh">重新加载</button>
        </div>
        <div v-else-if="loading && items.length === 0" class="empty-state" role="status">加载执行记录…</div>
        <div v-else-if="items.length === 0" class="empty-state">
          <p>暂无符合条件的执行记录</p>
          <p class="muted">任务开始执行后会出现在这里。</p>
        </div>
        <ul v-else class="record-list">
          <li v-for="task in items" :key="task.id">
            <button type="button" class="record-row" :class="{ selected: selectedId === task.id }"
              :aria-pressed="selectedId === task.id" :aria-label="`查看 ${task.title} 的执行记录`" @click="selectTask(task.id)">
              <span class="row-heading"><strong>{{ task.title }}</strong><span class="status" :data-stage="task.stage">{{ taskStageLabel(task.stage) }}</span></span>
              <span class="row-meta">{{ taskSourceLabel(task.source) }} · 会话 #{{ task.sessionId }}</span>
              <time>{{ formatDateTime(task.updatedAt) || '更新时间未记录' }}</time>
            </button>
          </li>
        </ul>
        <footer class="pagination">
          <button type="button" :disabled="page <= 1 || loading" @click="changePage(page - 1)">上一页</button>
          <span>第 {{ page }} / {{ Math.max(1, Math.ceil(total / size)) }} 页</span>
          <button type="button" :disabled="page * size >= total || loading" @click="changePage(page + 1)">下一页</button>
        </footer>
      </div>

      <aside class="record-detail" aria-label="执行详情" :aria-busy="detailLoading">
        <div v-if="detailError" class="empty-state" role="alert">
          <p>{{ detailError }}</p>
          <button v-if="selectedId != null" type="button" @click="selectTask(selectedId)">重试详情</button>
        </div>
        <div v-else-if="!detail" class="empty-state" role="status">{{ detailLoading ? '加载执行详情…' : '选择任务，查看每次执行结果' }}</div>
        <template v-else>
          <header class="detail-header">
            <span class="status" :data-stage="detail.task.stage">{{ taskStageLabel(detail.task.stage) }}</span>
            <h2>{{ detail.task.title }}</h2>
            <div class="detail-meta">
              <span>首次来源：{{ taskSourceLabel(detail.task.source) }}</span>
              <span>会话 #{{ detail.task.sessionId }}</span>
              <span v-if="detail.task.agentId != null">Agent #{{ detail.task.agentId }}</span>
            </div>
            <button type="button" class="primary-button" data-action="open-session" :disabled="opening" @click="openSession">{{ opening ? '正在打开…' : '打开关联会话' }}</button>
            <p v-if="navigationError" class="navigation-error" role="alert">{{ navigationError }}</p>
          </header>
          <div class="history-header">
            <h3>执行历史</h3>
            <span class="muted">最近 {{ detail.executions.length }} 次</span>
          </div>
          <p v-if="detail.executions.length === 0" class="empty-state">暂无执行尝试记录</p>
          <ol v-else class="execution-list">
            <li v-for="execution in detail.executions" :key="execution.id" class="execution-attempt">
              <div class="attempt-heading">
                <strong>第 {{ execution.attemptNo }} 次执行</strong>
                <span class="status" :data-stage="execution.status">{{ taskStageLabel(execution.status) }}</span>
              </div>
              <div class="attempt-meta">
                <span>本次来源：{{ executionSources.has(execution.executionId) ? taskSourceLabel(executionSources.get(execution.executionId)!) : '未记录' }}</span>
                <span v-if="executionEvents.has(execution.executionId)">
                  外部事件：{{ executionEvents.get(execution.executionId)!.id }}
                  （{{ executionEvents.get(execution.executionId)!.scope }}）
                </span>
                <span>开始：{{ formatDateTime(execution.startedAt) || '未记录' }}</span>
                <span>结束：{{ formatDateTime(execution.finishedAt) || (execution.status === 'WORKING' ? '执行中' : '未记录') }}</span>
              </div>
              <div v-if="execution.failureReason" class="failure-reason"><strong>失败原因</strong><p>{{ execution.failureReason }}</p></div>
            </li>
          </ol>
          <p class="history-note">最多展示最近 50 次执行。来源可能随每次执行变化。</p>
        </template>
      </aside>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { useTaskRecords } from '../../composables/useTaskRecords'
import { openSideTaskTabFor, openSubagentTabFor } from '../../composables/useCenterTabs'
import { useSessionStore } from '../../stores/session'
import { formatDateTime } from '../../utils/datetime'
import { goBackToWorkbench } from '../../utils/workbench-nav'
import { TASK_STAGE_LABELS, TASK_SOURCE_LABELS, taskSourceLabel, taskStageLabel } from '../../utils/taskRecordLabels'

const router = useRouter()
const sessionStore = useSessionStore()
const { items, total, page, size, filters, loading, error, selectedId, detail, detailLoading, detailError, selectTask, changePage, refresh } = useTaskRecords()
const executionSources = computed(() => new Map((detail.value?.triggers ?? []).map(trigger => [trigger.sourceEventId, trigger.source])))
const executionEvents = computed(() => new Map(
  (detail.value?.triggers ?? [])
    .filter(trigger => trigger.externalEventId != null && trigger.externalEventScope != null)
    .map(trigger => [trigger.sourceEventId, { id: trigger.externalEventId!, scope: trigger.externalEventScope! }]),
))
const opening = ref(false)
const navigationError = ref('')
let navigationSequence = 0
let timer: ReturnType<typeof setInterval> | undefined

function goBack() {
  goBackToWorkbench(router, sessionStore.activeSession?.id)
}

async function openSession() {
  const task = detail.value?.task
  if (!task || opening.value) return
  const sequence = ++navigationSequence
  opening.value = true
  navigationError.value = ''
  try {
    const session = await sessionStore.fetchSession(String(task.sessionId))
    if (sequence !== navigationSequence) return
    if (!session) throw new Error('关联会话不存在或无权访问')
    let root = session
    const visited = new Set<string>()
    while (root.parentSessionId != null) {
      const rootId = String(root.id)
      if (visited.has(rootId) || visited.size >= 64) throw new Error('会话关联异常，请从工作台打开')
      visited.add(rootId)
      root = await sessionStore.fetchSession(String(root.parentSessionId))
      if (sequence !== navigationSequence) return
      if (!root) throw new Error('所属会话不存在或无权访问')
    }
    const rootId = String(root.id)
    if (session.sessionType === 'SIDE_TASK') {
      sessionStore.addSideTask(rootId, { id: task.sessionId, title: task.title, phase: session.phase })
    }
    await router.push(`/tasks/${rootId}`)
    if (session.sessionType === 'SIDE_TASK') openSideTaskTabFor(rootId, task.sessionId, task.title)
    else if (session.sessionType === 'SUBAGENT') openSubagentTabFor(rootId, task.sessionId, task.title)
  } catch (failure) {
    if (sequence === navigationSequence) navigationError.value = failure instanceof Error ? failure.message : '打开会话失败'
  } finally {
    if (sequence === navigationSequence) opening.value = false
  }
}

function refreshWhenVisible() {
  if (document.visibilityState === 'visible' && !loading.value && !detailLoading.value) void refresh()
}

watch(selectedId, () => {
  ++navigationSequence
  opening.value = false
  navigationError.value = ''
})

onMounted(() => {
  timer = setInterval(refreshWhenVisible, 10_000)
  document.addEventListener('visibilitychange', refreshWhenVisible)
})

onUnmounted(() => {
  clearInterval(timer)
  document.removeEventListener('visibilitychange', refreshWhenVisible)
  ++navigationSequence
})
</script>

<style scoped>
.execution-records { height: 100%; display: flex; flex-direction: column; padding: 24px 28px; gap: 20px; color: var(--aw-ink); overflow: auto; }
.records-header, .header-actions, .records-filters, .row-heading, .attempt-heading, .history-header, .pagination { display: flex; align-items: center; gap: 12px; }
.records-header, .row-heading, .attempt-heading, .history-header { justify-content: space-between; }
h1 { margin: 0; font-size: 24px; font-weight: 600; }
h2 { margin: 12px 0; font-size: 20px; line-height: 1.5; overflow-wrap: anywhere; }
h3 { margin: 0; font-size: 15px; }
.records-header p { margin: 6px 0 0; color: var(--aw-ink-muted); font-size: 13px; }
button, select { font: inherit; font-size: 13px; color: var(--aw-ink); background: var(--aw-canvas); border: 1px solid var(--aw-divider); border-radius: 6px; padding: 7px 12px; }
button { cursor: pointer; }
button:hover:not(:disabled) { background: var(--aw-primary-soft); }
button:disabled { opacity: .45; cursor: default; }
button:focus-visible, select:focus-visible { outline: 2px solid var(--aw-primary); outline-offset: 2px; }
.refresh-hint, .muted, .record-count, time, .row-meta, .detail-meta, .attempt-meta, .history-note, .pagination { font-size: 12px; color: var(--aw-ink-muted); }
.records-filters label { display: flex; align-items: center; gap: 8px; font-size: 13px; }
.record-count { margin-left: auto; }
.records-content { display: grid; grid-template-columns: minmax(260px, 360px) minmax(0, 1fr); flex: 1; min-height: 300px; gap: 20px; }
.record-list-panel, .record-detail { border: 1px solid var(--aw-divider); border-radius: 10px; background: var(--aw-canvas); overflow: auto; }
.record-list-panel { display: flex; flex-direction: column; }
.record-list, .execution-list { list-style: none; margin: 0; padding: 0; }
.record-list { flex: 1; overflow: auto; }
.record-row { text-align: left; width: 100%; border: 0; border-bottom: 1px solid var(--aw-divider-soft); border-radius: 0; display: flex; flex-direction: column; align-items: stretch; gap: 9px; padding: 16px; }
.record-row.selected { background: var(--aw-primary-soft); box-shadow: inset 3px 0 var(--aw-primary); }
.row-heading { width: 100%; gap: 16px; }
.row-heading strong { font-size: 14px; font-weight: 500; overflow-wrap: anywhere; min-width: 0; }
.status { flex-shrink: 0; font-size: 12px; color: var(--aw-ink-muted); padding: 3px 7px; border-radius: 4px; background: var(--aw-canvas-parchment); }
.status[data-stage="WORKING"] { color: var(--aw-primary); background: var(--aw-primary-lighter); }
.status[data-stage="FAILED"], .navigation-error { color: var(--aw-danger); }
.status[data-stage="COMPLETED"] { color: var(--aw-status-success); }
.status[data-stage="BLOCKED"] { color: var(--aw-warning); }
.pagination { justify-content: center; padding: 14px 10px; border-top: 1px solid var(--aw-divider-soft); margin-top: auto; flex-shrink: 0; }
.pagination button { padding: 5px 9px; }
.record-detail { padding: 24px; }
.detail-header { padding-bottom: 22px; border-bottom: 1px solid var(--aw-divider-soft); }
.detail-meta { display: flex; flex-wrap: wrap; gap: 12px; margin-bottom: 18px; }
.primary-button { color: var(--aw-primary); border-color: var(--aw-primary-line); background: var(--aw-primary-soft); }
.history-header { margin: 22px 0 16px; }
.execution-attempt { border: 1px solid var(--aw-divider); border-radius: 8px; padding: 16px; margin-bottom: 12px; }
.attempt-heading strong { font-size: 13px; }
.attempt-meta { display: flex; flex-wrap: wrap; gap: 8px 20px; margin-top: 12px; }
.failure-reason { margin-top: 14px; border-left: 2px solid var(--aw-danger); padding: 2px 12px; font-size: 13px; }
.failure-reason strong { font-weight: 500; color: var(--aw-danger); }
.failure-reason p { white-space: pre-wrap; overflow-wrap: anywhere; line-height: 1.6; margin: 6px 0 0; }
.empty-state { padding: 36px 20px; text-align: center; font-size: 14px; color: var(--aw-ink-muted); margin: auto; }
.empty-state p { overflow-wrap: anywhere; }
.history-note { line-height: 1.6; margin: 16px 0 0; }
.navigation-error { font-size: 13px; }
@media (max-width: 800px) {
  .execution-records { padding: 16px; }
  .records-header { align-items: flex-start; flex-wrap: wrap; }
  .refresh-hint { display: none; }
  .records-content { display: flex; flex-direction: column; flex: none; }
  .record-list-panel { flex-shrink: 0; }
  .record-list { max-height: 350px; flex: none; }
  .record-detail { overflow: visible; padding: 18px; }
  .records-filters { flex-wrap: wrap; }
}
</style>

<template>
  <ResponsiveDialog
    v-if="task"
    :model-value="modelValue"
    title="定时任务详情"
    width="720px"
    @update:model-value="emit('update:modelValue', $event)"
  >
    <el-descriptions :column="2" size="small" border>
      <el-descriptions-item label="ID">{{ task.id }}</el-descriptions-item>
      <el-descriptions-item label="任务名称">{{ task.name }}</el-descriptions-item>
      <el-descriptions-item label="用户">{{ userName || `用户 #${task.userId}` }}</el-descriptions-item>
      <el-descriptions-item label="Agent">{{ agentName || `Agent #${task.agentId}` }}</el-descriptions-item>
      <el-descriptions-item label="所属会话">
        <el-button v-if="task.sessionId" type="primary" link @click="goSession(task.sessionId)">
          #{{ task.sessionId }}
        </el-button>
        <span v-else class="text-muted">-</span>
      </el-descriptions-item>
      <el-descriptions-item label="Cron 表达式">
        <code class="cron-text">{{ task.cronExpression }}</code>
        <el-tag v-if="task.once === 1" type="warning" size="small" style="margin-left: 6px">一次性</el-tag>
      </el-descriptions-item>
      <el-descriptions-item label="状态">
        <el-tag :type="task.status === 'ACTIVE' ? 'success' : 'info'" size="small">
          {{ task.status === 'ACTIVE' ? '启用' : '暂停' }}
        </el-tag>
      </el-descriptions-item>
      <el-descriptions-item label="完结">
        <el-tag v-if="task.finished" type="info" size="small">
          {{ task.finishedAt ? `完结于 ${formatDateTime(task.finishedAt)}` : '已完结' }}
        </el-tag>
        <el-tag v-else type="success" size="small" title="未完结，任务持续有效">进行中</el-tag>
      </el-descriptions-item>
      <el-descriptions-item label="上次执行">
        <el-tag v-if="task.lastExecutionStatus" :type="execStatusTagType(task.lastExecutionStatus)" size="small">
          {{ execStatusLabel(task.lastExecutionStatus) }}
        </el-tag>
        <span v-else class="text-muted">-</span>
      </el-descriptions-item>
      <el-descriptions-item label="连续失败">{{ task.consecutiveFailures ?? 0 }}</el-descriptions-item>
      <el-descriptions-item label="触发次数">{{ task.fireCount }}</el-descriptions-item>
      <el-descriptions-item label="上次触发">{{ formatDateTime(task.lastFireTime) }}</el-descriptions-item>
      <el-descriptions-item label="下次触发">{{ formatDateTime(task.nextFireTime) }}</el-descriptions-item>
      <el-descriptions-item label="创建时间">{{ formatDateTime(task.createdAt) }}</el-descriptions-item>
      <el-descriptions-item label="更新时间">{{ formatDateTime(task.updatedAt) }}</el-descriptions-item>
    </el-descriptions>

    <div class="prompt-section">
      <div class="prompt-head">
        <span class="prompt-title">运行历史</span>
      </div>
      <div v-if="runsLoading" class="prompt-hint">加载中…</div>
      <div v-else-if="runs.length === 0" class="prompt-hint">还没有运行记录</div>
      <el-table v-else :data="runs" size="small">
        <el-table-column prop="fireTime" label="触发时间" min-width="150" />
        <el-table-column label="触发方式" width="90">
          <template #default="{ row }">{{ runTriggerLabel(row.triggerType) }}</template>
        </el-table-column>
        <el-table-column label="状态" width="90">
          <template #default="{ row }">{{ runStatusLabel(row.status) }}</template>
        </el-table-column>
        <el-table-column prop="attempt" label="尝试" width="70" />
        <el-table-column label="耗时" width="90">
          <template #default="{ row }">{{ row.durationMs == null ? '—' : `${row.durationMs} 毫秒` }}</template>
        </el-table-column>
        <el-table-column label="成本" width="90">
          <template #default="{ row }">{{ row.costMicros == null ? '—' : (row.costMicros / 1_000_000).toLocaleString('zh-CN', { maximumFractionDigits: 4 }) }}</template>
        </el-table-column>
        <el-table-column prop="errorSummary" label="错误摘要" min-width="160" show-overflow-tooltip />
      </el-table>
      <div v-if="!runsLoading && total > 0" class="runs-pagination">
        <el-pagination
          v-model:current-page="currentPage"
          layout="prev, pager, next, total"
          :total="total"
          :page-size="pageSize"
          @current-change="handlePageChange"
        />
      </div>
    </div>

    <div class="prompt-section">
      <div class="prompt-head">
        <span class="prompt-title">任务提示词</span>
        <el-button type="primary" link size="small" @click="copyPrompt">复制</el-button>
      </div>
      <pre class="prompt-body">{{ task.prompt || '（空）' }}</pre>
      <div class="prompt-hint">
        触发时系统会在该内容前自动附加「本消息由定时任务《{{ task.name }}》按计划触发」的说明；手动立即执行会标注为手动触发。此处是任务本体原文。
      </div>
    </div>

    <template #footer>
      <el-button @click="emit('update:modelValue', false)">关闭</el-button>
      <el-button
        v-if="canEdit && !task.finished"
        type="success"
        :loading="running"
        :disabled="running"
        @click="runNow"
      >立即执行</el-button>
      <el-button v-if="canEdit" type="primary" @click="emit('edit', task)">编辑</el-button>
    </template>
  </ResponsiveDialog>
</template>

<script setup lang="ts">
import { ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import { api, apiGetWithHeaders } from '../../api'
import ResponsiveDialog from '../../components/ResponsiveDialog.vue'
import { formatDateTime } from '../../utils/datetime'
import { execStatusLabel, execStatusTagType } from './task-display'
import type { ScheduledTaskRow, ScheduledTaskRunRow } from './types'

const runs = ref<ScheduledTaskRunRow[]>([])
const runsLoading = ref(false)
const running = ref(false)
const currentPage = ref(1)
const pageSize = 20
const total = ref(0)
let loadSeq = 0

const props = defineProps<{
  modelValue: boolean
  task: ScheduledTaskRow | null
  userName?: string
  agentName?: string
  canEdit?: boolean
}>()

const emit = defineEmits<{
  (e: 'update:modelValue', value: boolean): void
  (e: 'edit', task: ScheduledTaskRow): void
  (e: 'ran'): void
}>()

const router = useRouter()

watch(() => [props.modelValue, props.task?.id] as const, ([visible, taskId]) => {
  if (!visible || taskId == null) {
    runs.value = []
    total.value = 0
    return
  }
  currentPage.value = 1
  void loadRuns(taskId, 1)
}, { immediate: true })

function readTotalCount(headers: unknown): number {
  if (!headers || typeof headers !== 'object') return NaN
  const bag = headers as { get?: (name: string) => unknown } & Record<string, unknown>
  const raw = typeof bag.get === 'function' ? bag.get('x-total-count') : bag['x-total-count']
  const value = Array.isArray(raw) ? raw[0] : raw
  return Number(value)
}

async function loadRuns(taskId: number, page = currentPage.value) {
  const seq = ++loadSeq
  runsLoading.value = true
  try {
    const { result, headers } = await apiGetWithHeaders<ScheduledTaskRunRow[]>(`/scheduled-tasks/${taskId}/runs`, {
      params: { pageNum: page, pageSize },
    })
    if (seq !== loadSeq) return
    const records = Array.isArray(result.data) ? result.data : []
    const headerTotal = readTotalCount(headers)
    total.value = Number.isFinite(headerTotal) ? headerTotal : records.length
    const maxPage = Math.max(1, Math.ceil(total.value / pageSize))
    if (page > maxPage) {
      currentPage.value = maxPage
      void loadRuns(taskId, maxPage)
      return
    }
    currentPage.value = page
    runs.value = records
  } catch {
    if (seq === loadSeq) {
      runs.value = []
      total.value = 0
    }
  } finally {
    if (seq === loadSeq) runsLoading.value = false
  }
}

function handlePageChange(page: number) {
  if (props.task?.id == null) return
  void loadRuns(props.task.id, page)
}

function runStatusLabel(status: string): string {
  switch (status) {
    case 'COMPLETED': return '成功'
    case 'FAILED': return '失败'
    case 'CANCELLED': return '取消'
    case 'MISSED': return '错过'
    case 'QUEUED': return '排队'
    case 'RUNNING': return '运行中'
    default: return status
  }
}

function runTriggerLabel(triggerType?: string | null): string {
  return triggerType === 'MANUAL' ? '手动' : '计划'
}

async function runNow() {
  if (!props.task || running.value || props.task.finished) return
  try {
    await ElMessageBox.confirm(
      `确定要立即执行定时任务「${props.task.name}」吗？本次执行不会改变下一次计划触发时间。`,
      '立即执行',
      { type: 'info', confirmButtonText: '执行' },
    )
  } catch {
    return
  }
  running.value = true
  try {
    await api.post(`/scheduled-tasks/${props.task.id}/run`)
    ElMessage.success('已提交执行')
    await loadRuns(props.task.id)
    emit('ran')
  } catch {
    // interceptor handles toast
  } finally {
    running.value = false
  }
}

function goSession(sessionId: number) {
  router.push(`/sessions/${sessionId}`)
}

function copyPrompt() {
  const text = props.task?.prompt ?? ''
  if (!text) return
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(text).then(
      () => ElMessage.success('已复制提示词'),
      () => ElMessage.warning('复制失败，请手动选择文本')
    )
    return
  }
  ElMessage.warning('当前环境不支持一键复制，请手动选择文本')
}
</script>

<style scoped>
.text-muted {
  color: var(--mao-muted);
}

.cron-text {
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
}

.prompt-section {
  margin-top: 16px;
}

.prompt-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 6px;
}

.prompt-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--mao-ink);
}

.prompt-body {
  margin: 0;
  padding: 12px;
  background: var(--el-fill-color-light);
  border-radius: 8px;
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 420px;
  overflow-y: auto;
  font-size: 13px;
  line-height: 1.6;
}

.prompt-hint {
  margin-top: 6px;
  font-size: 12px;
  color: var(--mao-muted);
  line-height: 1.5;
}

.runs-pagination {
  display: flex;
  justify-content: flex-end;
  margin-top: 12px;
}
</style>

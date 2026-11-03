import { onScopeDispose, reactive, ref, watch } from 'vue'
import type { AgentTaskVO, TaskDetailVO, TaskSource, TaskStage } from '@mao/contracts'
import { getTask, listTasks } from '../api/task'

export function useTaskRecords() {
  const items = ref<AgentTaskVO[]>([])
  const total = ref(0)
  const page = ref(1)
  const size = 20
  const filters = reactive<{ stage: TaskStage | ''; source: TaskSource | '' }>({ stage: '', source: '' })
  const loading = ref(false)
  const error = ref('')
  const selectedId = ref<number | null>(null)
  const detail = ref<TaskDetailVO | null>(null)
  const detailLoading = ref(false)
  const detailError = ref('')
  let listSequence = 0
  let detailSequence = 0
  let disposed = false

  async function loadPage() {
    if (disposed) return
    const sequence = ++listSequence
    loading.value = true
    error.value = ''
    try {
      const result = await listTasks({
        page: page.value, size, stage: filters.stage || undefined, source: filters.source || undefined,
      })
      if (disposed || sequence !== listSequence) return
      items.value = result.items
      total.value = result.total
    } catch (failure) {
      if (disposed || sequence !== listSequence) return
      items.value = []
      total.value = 0
      error.value = failure instanceof Error ? failure.message : '执行记录加载失败'
    } finally {
      if (!disposed && sequence === listSequence) loading.value = false
    }
  }

  function clearSelection() {
    ++detailSequence
    selectedId.value = null
    detail.value = null
    detailLoading.value = false
    detailError.value = ''
  }

  async function selectTask(id: number) {
    if (disposed) return
    const sequence = ++detailSequence
    const changing = selectedId.value !== id
    selectedId.value = id
    if (changing) detail.value = null
    detailLoading.value = true
    detailError.value = ''
    try {
      const result = await getTask(id)
      if (!disposed && sequence === detailSequence) detail.value = result
    } catch (failure) {
      if (disposed || sequence !== detailSequence) return
      detail.value = null
      detailError.value = failure instanceof Error ? failure.message : '执行详情加载失败'
    } finally {
      if (!disposed && sequence === detailSequence) detailLoading.value = false
    }
  }

  async function changePage(value: number) {
    if (!Number.isSafeInteger(value) || value < 1 || disposed) return
    page.value = value
    clearSelection()
    await loadPage()
  }

  async function refresh() {
    await Promise.all([loadPage(), selectedId.value == null ? undefined : selectTask(selectedId.value)])
  }

  watch(() => [filters.stage, filters.source], () => {
    page.value = 1
    clearSelection()
    void loadPage()
  }, { immediate: true })

  onScopeDispose(() => {
    disposed = true
    ++listSequence
    ++detailSequence
  })

  return { items, total, page, size, filters, loading, error, selectedId, detail, detailLoading, detailError, selectTask, clearSelection, changePage, refresh }
}

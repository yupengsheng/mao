import { effectScope, nextTick } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentTaskVO, TaskDetailVO, TaskPageVO } from '@mao/contracts'

const client = vi.hoisted(() => ({ listTasks: vi.fn(), getTask: vi.fn() }))
vi.mock('../api/task', () => client)

import { useTaskRecords } from './useTaskRecords'

function task(id: number): AgentTaskVO {
  return { id, agentId: 2, sessionId: id + 10, title: `任务 ${id}`, stage: 'WORKING', source: 'MANUAL', lastExecutionId: null, createdAt: null, updatedAt: null }
}

function list(id: number): TaskPageVO {
  return { items: [task(id)], total: 30, page: 1, size: 20 }
}

function detail(id: number): TaskDetailVO {
  return { task: task(id), latestExecution: null, executions: [], triggers: [] }
}

function deferred<Value>() {
  let resolve!: (value: Value) => void
  let reject!: (error: Error) => void
  const promise = new Promise<Value>((resolvePromise, rejectPromise) => { resolve = resolvePromise; reject = rejectPromise })
  return { promise, resolve, reject }
}

const scopes: ReturnType<typeof effectScope>[] = []
function setup() {
  const scope = effectScope()
  scopes.push(scope)
  return { state: scope.run(() => useTaskRecords())!, scope }
}

beforeEach(() => {
  client.listTasks.mockReset().mockResolvedValue(list(1))
  client.getTask.mockReset().mockImplementation(async (id: number) => detail(id))
})
afterEach(() => { scopes.splice(0).forEach(scope => scope.stop()) })

describe('execution records state', () => {
  it('resets pagination and selection when filters change', async () => {
    const { state } = setup()
    await vi.waitFor(() => expect(state.items.value[0]?.id).toBe(1))
    await state.changePage(2)
    await state.selectTask(1)
    state.filters.stage = 'FAILED'
    await nextTick()
    await vi.waitFor(() => expect(state.loading.value).toBe(false))
    expect(state.page.value).toBe(1)
    expect(state.selectedId.value).toBeNull()
    expect(state.detail.value).toBeNull()
    expect(client.listTasks.mock.lastCall?.[0]).toMatchObject({ stage: 'FAILED', page: 1, size: 20 })
  })

  it('does not let an old list response overwrite a newer filter result', async () => {
    const old = deferred<TaskPageVO>()
    client.listTasks.mockReturnValueOnce(old.promise).mockResolvedValueOnce(list(2))
    const { state } = setup()
    state.filters.source = 'WEBHOOK'
    await nextTick()
    await vi.waitFor(() => expect(state.items.value[0]?.id).toBe(2))
    old.resolve(list(1))
    await nextTick()
    expect(state.items.value[0]?.id).toBe(2)
    expect(state.error.value).toBe('')
  })

  it('ignores a failed old detail request after selecting another task', async () => {
    const old = deferred<TaskDetailVO>()
    client.getTask.mockReturnValueOnce(old.promise)
    const { state } = setup()
    const pending = state.selectTask(1)
    await state.selectTask(2)
    old.reject(new Error('old detail failed'))
    await pending
    expect(state.detail.value?.task.id).toBe(2)
    expect(state.detailError.value).toBe('')
    expect(state.detailLoading.value).toBe(false)
  })

  it('clears stale content after a failed refresh and recovers on retry', async () => {
    const { state } = setup()
    await state.refresh()
    await state.selectTask(1)
    client.listTasks.mockRejectedValueOnce(new Error('列表不可用'))
    client.getTask.mockRejectedValueOnce(new Error('任务不存在'))
    await state.refresh()
    expect(state.items.value).toEqual([])
    expect(state.detail.value).toBeNull()
    expect(state.error.value).toBe('列表不可用')
    expect(state.detailError.value).toBe('任务不存在')
    await state.refresh()
    expect(state.items.value[0]?.id).toBe(1)
    expect(state.detail.value?.task.id).toBe(1)
    expect(state.error.value).toBe('')
  })

  it('drops in-flight results after the owning scope is disposed', async () => {
    const pending = deferred<TaskPageVO>()
    client.listTasks.mockReturnValueOnce(pending.promise)
    const { state, scope } = setup()
    scope.stop()
    pending.resolve(list(4))
    await nextTick()
    expect(state.items.value).toEqual([])
  })

  it('clears a pending selection when switching pages', async () => {
    const pending = deferred<TaskDetailVO>()
    client.getTask.mockReturnValueOnce(pending.promise)
    const { state } = setup()
    const selection = state.selectTask(1)
    await state.changePage(2)
    pending.resolve(detail(1))
    await selection
    expect(state.detail.value).toBeNull()
    expect(state.selectedId.value).toBeNull()
    expect(state.page.value).toBe(2)
  })
})

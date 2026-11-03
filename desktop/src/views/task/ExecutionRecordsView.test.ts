// @vitest-environment jsdom
import { createApp, nextTick } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TaskDetailVO } from '@mao/contracts'

const deps = vi.hoisted(() => ({
  listTasks: vi.fn(), getTask: vi.fn(), push: vi.fn(), fetchSession: vi.fn(),
  addSideTask: vi.fn(), openSideTaskTabFor: vi.fn(), openSubagentTabFor: vi.fn(),
}))
vi.mock('../../api/task', () => ({ listTasks: deps.listTasks, getTask: deps.getTask }))
vi.mock('vue-router', () => ({ useRouter: () => ({ push: deps.push }) }))
vi.mock('../../stores/session', () => ({ useSessionStore: () => ({
  activeSession: { id: '11' }, fetchSession: deps.fetchSession, addSideTask: deps.addSideTask,
}) }))
vi.mock('../../composables/useCenterTabs', () => ({
  openSideTaskTabFor: deps.openSideTaskTabFor,
  openSubagentTabFor: deps.openSubagentTabFor,
}))

import ExecutionRecordsView from './ExecutionRecordsView.vue'

const record: TaskDetailVO = {
  task: { id: 1, agentId: 2, sessionId: 41, title: '修复任务', stage: 'FAILED', source: 'API', lastExecutionId: 'run-1', createdAt: null, updatedAt: null },
  latestExecution: null,
  executions: [{ id: 1, taskId: 1, sessionId: 41, executionId: 'run-1', attemptNo: 1, status: 'FAILED', startedAt: null, finishedAt: '2026-11-03 12:00:00', failureReason: '测试命令退出 1', createdAt: null }],
  triggers: [{ id: 1, taskId: 1, sessionId: 41, source: 'WEBHOOK', sourceEventId: 'run-1', createdAt: null }],
}
const apps: ReturnType<typeof createApp>[] = []

async function settle() {
  await Promise.resolve()
  await Promise.resolve()
  await nextTick()
}

function mount() {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const app = createApp(ExecutionRecordsView)
  apps.push(app)
  app.mount(host)
  return { host, app }
}

beforeEach(() => {
  vi.clearAllMocks()
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
  deps.listTasks.mockResolvedValue({ items: [record.task], total: 1, page: 1, size: 20 })
  deps.getTask.mockResolvedValue(record)
  deps.fetchSession.mockResolvedValue({ id: 41, sessionType: 'NORMAL' })
  deps.push.mockResolvedValue(undefined)
})
afterEach(() => {
  apps.splice(0).forEach(app => app.unmount())
  document.body.innerHTML = ''
  vi.useRealTimers()
})

describe('execution records page', () => {
  it('shows the failure and actual execution source separately from first source', async () => {
    const { host } = mount()
    await settle()
    host.querySelector<HTMLButtonElement>('.record-row')!.click()
    await settle()
    expect(host.querySelector('.record-detail')?.textContent).toContain('测试命令退出 1')
    expect(host.querySelector('.detail-meta')?.textContent).toContain('首次来源：开放接口')
    expect(host.querySelector('.execution-list')?.textContent).toContain('Webhook')
    expect(host.querySelector('.execution-list')?.textContent).toContain('未记录')
  })

  it('renders failed requests as an error with a working retry action', async () => {
    deps.listTasks.mockRejectedValueOnce(new Error('暂时无法查询'))
    const { host } = mount()
    await settle()
    expect(host.textContent).toContain('暂时无法查询')
    host.querySelector<HTMLButtonElement>('[data-action="retry-list"]')!.click()
    await settle()
    expect(host.querySelector('.record-row')?.textContent).toContain('修复任务')
  })

  it('refreshes only visible pages and stops polling after unmount', async () => {
    vi.useFakeTimers()
    const { app } = mount()
    await settle()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(deps.listTasks).toHaveBeenCalledTimes(2)
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' })
    await vi.advanceTimersByTimeAsync(10_000)
    expect(deps.listTasks).toHaveBeenCalledTimes(2)
    app.unmount()
    apps.splice(apps.indexOf(app), 1)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(deps.listTasks).toHaveBeenCalledTimes(2)
  })

  it('opens nested side tasks under their root session', async () => {
    deps.fetchSession.mockImplementation(async (id: string) => ({
      '41': { id: 41, sessionType: 'SIDE_TASK', parentSessionId: 31, title: '修复任务', phase: 'FAILED' },
      '31': { id: 31, sessionType: 'SIDE_TASK', parentSessionId: 11 },
      '11': { id: 11, sessionType: 'NORMAL' },
    })[id])
    const { host } = mount()
    await settle()
    host.querySelector<HTMLButtonElement>('.record-row')!.click()
    await settle()
    host.querySelector<HTMLButtonElement>('[data-action="open-session"]')!.click()
    await settle()
    await settle()
    expect(deps.push).toHaveBeenCalledWith('/tasks/11')
    expect(deps.openSideTaskTabFor).toHaveBeenCalledWith('11', 41, '修复任务')
  })

  it('opens a subagent as a read-only tab on its parent', async () => {
    deps.fetchSession.mockImplementation(async (id: string) => id === '41'
      ? { id: 41, sessionType: 'SUBAGENT', parentSessionId: 11 }
      : { id: 11, sessionType: 'NORMAL' })
    const { host } = mount()
    await settle()
    host.querySelector<HTMLButtonElement>('.record-row')!.click()
    await settle()
    host.querySelector<HTMLButtonElement>('[data-action="open-session"]')!.click()
    await settle()
    await settle()
    expect(deps.push).toHaveBeenCalledWith('/tasks/11')
    expect(deps.openSubagentTabFor).toHaveBeenCalledWith('11', 41, '修复任务')
    expect(deps.openSideTaskTabFor).not.toHaveBeenCalled()
  })

  it('reports inaccessible sessions without navigating away', async () => {
    deps.fetchSession.mockResolvedValue(null)
    const { host } = mount()
    await settle()
    host.querySelector<HTMLButtonElement>('.record-row')!.click()
    await settle()
    host.querySelector<HTMLButtonElement>('[data-action="open-session"]')!.click()
    await settle()
    expect(host.querySelector('.navigation-error')?.textContent).toContain('不存在或无权访问')
    expect(deps.push).not.toHaveBeenCalled()
  })

  it('refreshes immediately when the page becomes visible again', async () => {
    vi.useFakeTimers()
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' })
    mount()
    await settle()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(deps.listTasks).toHaveBeenCalledTimes(1)
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
    document.dispatchEvent(new Event('visibilitychange'))
    await settle()
    expect(deps.listTasks).toHaveBeenCalledTimes(2)
  })
})

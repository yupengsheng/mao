import { beforeEach, describe, expect, it } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import {
  deriveParallelStatus,
  titleWithPrefix,
  useParallelStatus,
  type ParallelStatus,
} from './useParallelStatus'
import { useSessionStore } from '../stores/session'

function makeSession(overrides: Record<string, any> = {}): any {
  return {
    id: '1',
    agentId: '1',
    agentName: 'a',
    title: 't',
    executionMode: 'CLOUD',
    status: 'ACTIVE',
    phase: 'IDLE',
    createdAt: '2026-08-01T00:00:00',
    updatedAt: '2026-08-01T00:00:00',
    messageCount: 0,
    elapsedMs: 0,
    running: false,
    ...overrides,
  }
}

const noSideTasks = () => []

describe('deriveParallelStatus', () => {
  it('无活跃会话返回 null', () => {
    expect(deriveParallelStatus([], noSideTasks)).toBeNull()
  })

  it('运行中主会话识别为 running', () => {
    expect(deriveParallelStatus([makeSession({ phase: 'RUNNING' })], noSideTasks)).toBe('running')
  })

  it('等待审批优先于失败与运行中', () => {
    const sessions = [
      makeSession({ id: '1', phase: 'RUNNING' }),
      makeSession({ id: '2', phase: 'FAILED' }),
      makeSession({ id: '3', phase: 'WAITING_APPROVAL' }),
    ]
    expect(deriveParallelStatus(sessions, noSideTasks)).toBe('waiting_approval')
  })

  it('失败优先于运行中', () => {
    const sessions = [
      makeSession({ id: '1', phase: 'RUNNING' }),
      makeSession({ id: '2', phase: 'FAILED' }),
    ]
    expect(deriveParallelStatus(sessions, noSideTasks)).toBe('failed')
  })

  it('边路任务参与聚合，且等待审批优先于主会话失败', () => {
    const sessions = [makeSession({ id: '1', phase: 'FAILED' })]
    const status = deriveParallelStatus(sessions, id => id === '1'
      ? [{ phase: 'WAITING_APPROVAL' as const }]
      : [])
    expect(status).toBe('waiting_approval')
  })

  it('归档主会话连同其边路任务整体跳过', () => {
    const sessions = [makeSession({ id: '1', status: 'ARCHIVED', phase: 'WAITING_APPROVAL' })]
    const status = deriveParallelStatus(sessions, () => [{ phase: 'WAITING_APPROVAL' as const }])
    expect(status).toBeNull()
  })
})

describe('titleWithPrefix', () => {
  it.each<[ParallelStatus, string]>([
    ['waiting_approval', '❗ 等待审批 · Mao'],
    ['failed', '✗ 有会话失败 · Mao'],
    ['running', '▶ 运行中 · Mao'],
    [null, 'Mao'],
  ])('%s → %s', (status, expected) => {
    expect(titleWithPrefix(status)).toBe(expected)
  })
})

describe('useParallelStatus', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('跟随会话与边路任务状态变化', () => {
    const store = useSessionStore()
    store.sessionEntities.set('1', makeSession({ id: '1', phase: 'RUNNING' }))
    store.standardSessionIds = ['1']

    const status = useParallelStatus()
    expect(status.value).toBe('running')

    store.setSideTasks('1', [{ id: 9, phase: 'WAITING_APPROVAL' } as any])
    expect(status.value).toBe('waiting_approval')
  })
})

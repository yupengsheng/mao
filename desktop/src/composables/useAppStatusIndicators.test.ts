import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { nextTick } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { useAppStatusIndicators } from './useParallelStatus'
import { useSessionStore } from '../stores/session'
import { useAuthStore } from '../stores/auth'
import { resetApprovalFlashForTest, setApprovalFlashEnabled } from '../utils/approvalFlashPreference'

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

const user = { id: 1, username: 'u', displayName: 'U', email: '', avatarUrl: '', authSource: 'LOCAL' }

let flashFrame: Mock
let doc: { title: string }

function seedSession(overrides: Record<string, any>) {
  const store = useSessionStore()
  store.sessionEntities.set('1', makeSession({ id: '1', ...overrides }))
  store.standardSessionIds = ['1']
}

describe('useAppStatusIndicators', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    resetApprovalFlashForTest(true)
    flashFrame = vi.fn().mockResolvedValue({ ok: true })
    vi.stubGlobal('window', { electronAPI: { flashFrame } })
    doc = { title: '' }
    vi.stubGlobal('document', doc)
  })

  it('登录后无活跃会话标题保持 Mao，不触发闪烁', () => {
    const auth = useAuthStore()
    auth.user = user
    const stop = useAppStatusIndicators()
    expect(doc.title).toBe('Mao')
    expect(flashFrame).not.toHaveBeenCalled()
    stop()
  })

  it('等待审批时标题加前缀并持续闪烁', () => {
    const auth = useAuthStore()
    auth.user = user
    seedSession({ phase: 'WAITING_APPROVAL' })
    const stop = useAppStatusIndicators()
    expect(doc.title).toBe('❗ 等待审批 · Mao')
    expect(flashFrame).toHaveBeenLastCalledWith(true)
    stop()
  })

  it('关闭本机偏好后保留标题提示但不再闪烁', async () => {
    const auth = useAuthStore()
    auth.user = user
    setApprovalFlashEnabled(false)
    seedSession({ phase: 'WAITING_APPROVAL' })
    const stop = useAppStatusIndicators()
    expect(doc.title).toBe('❗ 等待审批 · Mao')
    expect(flashFrame).not.toHaveBeenCalled()
    stop()
  })

  it('闪烁中关闭偏好会主动复位任务栏', async () => {
    const auth = useAuthStore()
    auth.user = user
    seedSession({ phase: 'WAITING_APPROVAL' })
    const stop = useAppStatusIndicators()
    expect(flashFrame).toHaveBeenLastCalledWith(true)

    setApprovalFlashEnabled(false)
    await nextTick()
    expect(flashFrame).toHaveBeenLastCalledWith(false)
    stop()
  })

  it('登出后标题复位并停止闪烁', async () => {
    const auth = useAuthStore()
    auth.user = user
    seedSession({ phase: 'WAITING_APPROVAL' })
    const stop = useAppStatusIndicators()
    auth.user = null
    await nextTick()
    expect(doc.title).toBe('Mao')
    expect(flashFrame).toHaveBeenLastCalledWith(false)
    stop()
  })

  it('stop 时若仍在闪烁会复位', () => {
    const auth = useAuthStore()
    auth.user = user
    seedSession({ phase: 'WAITING_APPROVAL' })
    const stop = useAppStatusIndicators()
    stop()
    expect(flashFrame).toHaveBeenLastCalledWith(false)
  })

  it('无 Electron 桥接时静默降级，标题仍生效', () => {
    vi.stubGlobal('window', {})
    const auth = useAuthStore()
    auth.user = user
    seedSession({ phase: 'FAILED' })
    const stop = useAppStatusIndicators()
    expect(doc.title).toBe('✗ 有会话失败 · Mao')
    stop()
  })
})

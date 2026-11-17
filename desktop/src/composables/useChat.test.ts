import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { ElMessage } from 'element-plus'
import { isCurrentChatSession, isAbsoluteFileRef, resolveFileRefPaths, useChat } from './useChat'
import { api } from '../api'
import { useSessionStore } from '../stores/session'

const ws = vi.hoisted(() => ({
  connect: vi.fn(), subscribe: vi.fn(), unsubscribe: vi.fn(),
  cancel: vi.fn(), sendMessage: vi.fn(),
  pendingCallbacks: new Map(), onMessageSaved: vi.fn(), offMessageSaved: vi.fn(),
  sendEditMessage: vi.fn(),
  setActiveExecution: vi.fn(), clearActiveExecution: vi.fn(),
}))
vi.mock('./useStreamWS', () => ({ useStreamWS: () => ws }))
vi.mock('./useToolApprovals', () => ({ useToolApprovals: () => ({
  pendingApprovals: ref([]), clearPendingApprovals: vi.fn(),
}) }))
vi.mock('../api', () => ({ api: { get: vi.fn() } }))
vi.mock('element-plus', () => ({ ElMessage: { warning: vi.fn(), error: vi.fn() } }))
vi.mock('../utils/localSkills', () => ({ collectLocalUnsyncedSkills: vi.fn(async () => []) }))
vi.mock('../utils/agentsMd', () => ({ collectAgentsMdContent: vi.fn(async () => undefined) }))

describe('restoreSession', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
    ws.connect.mockReset()
    ws.connect.mockResolvedValue(undefined)
    ws.pendingCallbacks.clear()
    vi.mocked(api.get).mockResolvedValue({ data: [] } as never)
  })

  it('等待历史消息加载完成才完成恢复', async () => {
    let resolve!: (value: any) => void
    vi.mocked(api.get).mockImplementation((url: string) => url.endsWith('/messages')
      ? new Promise(r => { resolve = r }) : Promise.resolve({ data: [] }))
    const chat = useChat(ref('1'), ref('CLOUD'))
    let completed = false
    const pending = chat.restoreSession('A', 'CLOUD').then(() => { completed = true })
    await Promise.resolve()
    await Promise.resolve()
    expect(completed).toBe(false)
    expect(chat.switchingSession.value).toBe(true)
    resolve({ data: { messages: [], hasMore: false } })
    await pending
    expect(completed).toBe(true)
    expect(chat.switchingSession.value).toBe(false)
  })

  it('连接挂起时进入新任务，不再订阅或加载旧会话', async () => {
    let resolve!: () => void
    ws.connect.mockImplementationOnce(() => new Promise<void>(r => { resolve = r }))
    const chat = useChat(ref('1'), ref('CLOUD'))
    const pending = chat.restoreSession('A', 'CLOUD')
    chat.newSession()
    resolve()
    await pending
    expect(ws.subscribe).not.toHaveBeenCalled()
    expect(api.get).not.toHaveBeenCalled()
    expect(chat.sessionId.value).toBeNull()
    expect(chat.switchingSession.value).toBe(false)
  })

  it('订阅抛错也释放切换锁，后续终态仍由 phase watcher 接管', async () => {
    const store = useSessionStore()
    store.updateSession('A', { phase: 'RUNNING' })
    const chat = useChat(ref('1'), ref('CLOUD'))
    ws.subscribe.mockImplementationOnce(() => { throw new Error('subscribe failed') })

    await expect(chat.restoreSession('A', 'CLOUD')).rejects.toThrow('subscribe failed')
    expect(chat.switchingSession.value).toBe(false)
    expect(chat.sending.value).toBe(true)
    expect(chat.sendingSessionId.value).toBe('A')
    store.updateSessionPhase('A', 'COMPLETED')
    await vi.waitFor(() => expect(chat.sending.value).toBe(false))
    expect(chat.sendingSessionId.value).toBeNull()
  })

  it.each(['resolve', 'reject'] as const)('旧会话等待者 %s 不清掉新会话的发送锁和计时', async (outcome) => {
    const store = useSessionStore()
    store.updateSession('A', { phase: 'RUNNING' })
    store.updateSession('B', { phase: 'RUNNING' })
    const chat = useChat(ref('1'), ref('CLOUD'))
    await chat.restoreSession('A', 'CLOUD')
    const oldWaiter = ws.pendingCallbacks.get('A')!
    await chat.restoreSession('B', 'CLOUD')
    chat.startedAt.value = '2026-11-17T10:00:00Z'

    oldWaiter[outcome](outcome === 'reject' ? new Error('old execution failed') : undefined)
    await Promise.resolve()
    await Promise.resolve()
    expect(chat.sending.value).toBe(true)
    expect(chat.sendingSessionId.value).toBe('B')
    expect(chat.startedAt.value).toBe('2026-11-17T10:00:00Z')

    ws.pendingCallbacks.get('B')!.resolve()
    await vi.waitFor(() => expect(chat.sending.value).toBe(false))
    expect(chat.sendingSessionId.value).toBeNull()
    expect(chat.startedAt.value).toBeNull()
  })

  it('同会话再次恢复会替换等待者，旧代次的 rejection 不解开新发送锁', async () => {
    const store = useSessionStore()
    store.updateSession('A', { phase: 'RUNNING' })
    const chat = useChat(ref('1'), ref('CLOUD'))
    await chat.restoreSession('A', 'CLOUD')
    const previous = ws.pendingCallbacks.get('A')!
    const reject = vi.spyOn(previous, 'reject')

    await chat.restoreSession('A', 'CLOUD')
    expect(reject).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining('superseded') }))
    expect(ws.pendingCallbacks.get('A')).not.toBe(previous)
    expect(chat.sending.value).toBe(true)
    expect(chat.sendingSessionId.value).toBe('A')
    ws.pendingCallbacks.get('A')!.resolve()
    await vi.waitFor(() => expect(chat.sending.value).toBe(false))
    expect(chat.sendingSessionId.value).toBeNull()
  })

  it('恢复活动会话时显式替换已占槽的等待者，新等待者能解开输入锁', async () => {
    const store = useSessionStore()
    store.updateSession('A', { phase: 'RUNNING' })
    const reject = vi.fn()
    ws.pendingCallbacks.set('A', { reject })
    const chat = useChat(ref('1'), ref('CLOUD'))
    await chat.restoreSession('A', 'CLOUD')

    expect(reject).toHaveBeenCalledOnce()
    expect(reject).toHaveBeenCalledWith(expect.objectContaining({ toastShown: true }))
    expect(chat.sending.value).toBe(true)
    ws.pendingCallbacks.get('A')!.resolve()
    await vi.waitFor(() => expect(chat.sending.value).toBe(false))
  })

  it('恢复空闲会话时清掉上一会话的发送归属', async () => {
    const store = useSessionStore()
    store.updateSession('A', { phase: 'RUNNING' })
    store.updateSession('B', { phase: 'COMPLETED' })
    const chat = useChat(ref('1'), ref('CLOUD'))
    await chat.restoreSession('A', 'CLOUD')
    expect(chat.sendingSessionId.value).toBe('A')
    await chat.restoreSession('B', 'CLOUD')
    expect(chat.sending.value).toBe(false)
    expect(chat.sendingSessionId.value).toBeNull()
  })

  it('历史请求失败后结束加载状态', async () => {
    vi.mocked(api.get).mockRejectedValue(new Error('network error'))
    const chat = useChat(ref('1'), ref('CLOUD'))
    await chat.restoreSession('A', 'CLOUD')
    expect(chat.switchingSession.value).toBe(false)
  })

  it('快速切换时旧请求完成不会提前结束当前会话的加载状态', async () => {
    const resolves = new Map<string, (value: any) => void>()
    vi.mocked(api.get).mockImplementation((url: string) => url.endsWith('/messages')
      ? new Promise(resolve => { resolves.set(url, resolve) })
      : Promise.resolve({ data: [] }))
    const chat = useChat(ref('1'), ref('CLOUD'))
    const first = chat.restoreSession('A', 'CLOUD')
    await Promise.resolve()
    const second = chat.restoreSession('B', 'CLOUD')
    await Promise.resolve()
    resolves.get('/sessions/A/messages')!({ data: { messages: [], hasMore: false } })
    await first
    expect(chat.switchingSession.value).toBe(true)
    expect(chat.sessionId.value).toBe('B')
    resolves.get('/sessions/B/messages')!({ data: { messages: [], hasMore: false } })
    await second
    expect(chat.switchingSession.value).toBe(false)
  })

  it('待办与队列慢响应写入原会话，不覆盖切换后的会话', async () => {
    const delayed = new Map<string, (value: unknown) => void>()
    vi.mocked(api.get).mockImplementation((url: string) => {
      if (url.endsWith('/messages')) return Promise.resolve({ data: { messages: [], hasMore: false } })
      if (url.endsWith('/todos') || url.endsWith('/queue')) {
        return new Promise(resolve => { delayed.set(url, resolve) })
      }
      return Promise.resolve({ data: [] })
    })
    const store = useSessionStore()
    const chat = useChat(ref('1'), ref('CLOUD'))
    await chat.restoreSession('A', 'CLOUD')
    await chat.restoreSession('B', 'CLOUD')

    delayed.get('/sessions/B/todos')!({ data: [{ id: 2, content: 'B todo' }] })
    delayed.get('/sessions/B/queue')!({ data: [{ id: 'qb' }] })
    await Promise.resolve()
    delayed.get('/sessions/A/todos')!({ data: [{ id: 1, content: 'A todo' }] })
    delayed.get('/sessions/A/queue')!({ data: [{ id: 'qa' }] })
    await Promise.resolve()
    await Promise.resolve()

    expect(store.getTodos('A')).toEqual([{ id: 1, content: 'A todo' }])
    expect(store.getTodos('B')).toEqual([{ id: 2, content: 'B todo' }])
    // setQueueMessages 会把 sessionId 回填成当前会话（见 stores/session/messages.ts），
    // 慢响应不得把旧会话的行改写成切换后的会话。
    expect(store.getQueueMessages('A')).toEqual([{ id: 'qa', sessionId: 'A' }])
    expect(store.getQueueMessages('B')).toEqual([{ id: 'qb', sessionId: 'B' }])
  })

  it('历史上拉合并目标会话自身的文件变更，不混入当前会话', async () => {
    let resolveOlder!: (value: unknown) => void
    vi.mocked(api.get).mockImplementation((url: string, config?: { params?: { beforeMessageId?: unknown } }) => {
      if (url === '/sessions/A/messages' && config?.params?.beforeMessageId) {
        return new Promise(resolve => { resolveOlder = resolve })
      }
      if (url === '/sessions/A/messages') {
        return Promise.resolve({
          data: {
            messages: [{
              id: 10, role: 'ASSISTANT', content: 'current A',
              fileChanges: [{ path: 'a.ts', type: 'MODIFIED', linesAdded: 1, linesDeleted: 0 }],
            }],
            hasMore: true,
            nextBeforeMessageId: 5,
          },
        })
      }
      if (url === '/sessions/B/messages') {
        return Promise.resolve({
          data: {
            messages: [{
              id: 20, role: 'ASSISTANT', content: 'current B',
              fileChanges: [{ path: 'b.ts', type: 'MODIFIED', linesAdded: 2, linesDeleted: 0 }],
            }],
            hasMore: false,
          },
        })
      }
      return Promise.resolve({ data: [] })
    })
    const store = useSessionStore()
    const chat = useChat(ref('1'), ref('CLOUD'))
    await chat.restoreSession('A', 'CLOUD')
    const older = chat.loadOlderMessages()
    await chat.restoreSession('B', 'CLOUD')
    resolveOlder({
      data: {
        messages: [{
          id: 5, role: 'ASSISTANT', content: 'old A',
          fileChanges: [{ path: 'old.ts', type: 'CREATED', linesAdded: 3, linesDeleted: 0 }],
        }],
        hasMore: false,
      },
    })
    await older
    expect(store.getFileChanges('A').map(c => c.path)).toEqual(['old.ts', 'a.ts'])
    expect(store.getFileChanges('B').map(c => c.path)).toEqual(['b.ts'])
  })

  it('历史上拉时当前会话无文件变更也不会丢掉目标会话近期变更', async () => {
    let resolveOlder!: (value: unknown) => void
    vi.mocked(api.get).mockImplementation((url: string, config?: { params?: { beforeMessageId?: unknown } }) => {
      if (url === '/sessions/A/messages' && config?.params?.beforeMessageId) {
        return new Promise(resolve => { resolveOlder = resolve })
      }
      if (url === '/sessions/A/messages') {
        return Promise.resolve({
          data: {
            messages: [{
              id: 10, role: 'ASSISTANT', content: 'current A',
              fileChanges: [{ path: 'a.ts', type: 'MODIFIED', linesAdded: 1, linesDeleted: 0 }],
            }],
            hasMore: true,
            nextBeforeMessageId: 5,
          },
        })
      }
      if (url === '/sessions/B/messages') {
        return Promise.resolve({ data: { messages: [], hasMore: false } })
      }
      return Promise.resolve({ data: [] })
    })
    const store = useSessionStore()
    const chat = useChat(ref('1'), ref('CLOUD'))
    await chat.restoreSession('A', 'CLOUD')
    const older = chat.loadOlderMessages()
    await chat.restoreSession('B', 'CLOUD')
    resolveOlder({
      data: {
        messages: [{
          id: 5, role: 'ASSISTANT', content: 'old A',
          fileChanges: [{ path: 'old.ts', type: 'CREATED', linesAdded: 3, linesDeleted: 0 }],
        }],
        hasMore: false,
      },
    })
    await older
    expect(store.getFileChanges('A').map(c => c.path)).toEqual(['old.ts', 'a.ts'])
    expect(store.getFileChanges('B')).toEqual([])
  })
})

describe('发送完成回调的会话与代次隔离', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
    ws.pendingCallbacks.clear()
    ws.connect.mockReset().mockResolvedValue(undefined)
    ws.sendMessage.mockReset().mockResolvedValue(true)
    vi.mocked(api.get).mockResolvedValue({ data: [] } as never)
  })

  it.each(['resolve', 'reject'] as const)('同会话旧发送 %s 不清新发送的状态、不回滚或刷新新气泡', async (outcome) => {
    const store = useSessionStore()
    store.updateSession('A', { phase: 'IDLE' })
    store.setActiveSession('A')
    const chat = useChat(ref('1'), ref('CLOUD'))
    chat.sessionId.value = 'A'
    const first = chat.sendMessage('first')
    await vi.waitFor(() => expect(ws.pendingCallbacks.has('A')).toBe(true))
    const previous = ws.pendingCallbacks.get('A')!
    const remove = vi.spyOn(store, 'removeTrailingEmptyAssistant')
    vi.mocked(api.get).mockClear()
    // 终态回调已排入微任务，但 UI 已允许下一次发送；下一代必须立即接管。
    previous[outcome](outcome === 'reject' ? new Error('old failure') : undefined)
    chat.sending.value = false
    const second = chat.sendMessage('second')
    await first
    expect(chat.sending.value).toBe(true)
    expect(chat.sendingSessionId.value).toBe('A')
    expect(chat.startedAt.value).not.toBeNull()
    expect(remove).not.toHaveBeenCalled()
    expect(api.get).not.toHaveBeenCalled()
    await vi.waitFor(() => expect(ws.pendingCallbacks.get('A')).not.toBe(previous))
    expect(store.getMessages('A').filter(m => m.role === 'user').map(m => m.content)).toEqual(['first', 'second'])
    expect(ElMessage.error).not.toHaveBeenCalled()
    ws.pendingCallbacks.get('A')!.resolve()
    await second
    expect(chat.sending.value).toBe(false)
    expect(chat.sendingSessionId.value).toBeNull()
  })

  it.each(['resolve', 'reject'] as const)('旧建会话 %s 的 finally 不清新建任务的初始化提示', async (outcome) => {
    const store = useSessionStore()
    const deferred: Array<{ resolve: (value: any) => void; reject: (error: Error) => void }> = []
    vi.spyOn(store, 'createSession').mockImplementation(() => new Promise((resolve, reject) => {
      deferred.push({ resolve, reject })
    }))
    const chat = useChat(ref('1'), ref('CLOUD'))
    const first = chat.sendMessage('first')
    await vi.waitFor(() => expect(deferred).toHaveLength(1))
    chat.newSession()
    const second = chat.sendMessage('second')
    await vi.waitFor(() => expect(deferred).toHaveLength(2))
    const time = chat.startedAt.value
    expect(chat.initializingWorkspace.value).toBe(true)
    if (outcome === 'resolve') deferred[0]!.resolve({ id: 'old' })
    else deferred[0]!.reject(new Error('old creation failed'))
    await first
    expect(chat.sessionId.value).toBeNull()
    expect(chat.sending.value).toBe(true)
    expect(chat.startedAt.value).toBe(time)
    expect(chat.initializingWorkspace.value).toBe(true)
    expect(chat.initializingWorkspaceLabel.value).toBe('正在初始化工作区...')
    deferred[1]!.resolve({ id: 'new' })
    await vi.waitFor(() => expect(ws.pendingCallbacks.has('new')).toBe(true))
    ws.pendingCallbacks.get('new')!.resolve()
    await second
    expect(chat.initializingWorkspace.value).toBe(false)
  })
})

describe('isCurrentChatSession', () => {
  it('仅允许本地、活动和预期会话完全一致时发送', () => {
    expect(isCurrentChatSession('1306', '1306', '1306', false)).toBe(true)
    expect(isCurrentChatSession(null, null, null, false)).toBe(true)
  })

  it('会话切换或任一会话 ID 错配时拒绝发送', () => {
    expect(isCurrentChatSession('1304', '1306', '1306', false)).toBe(false)
    expect(isCurrentChatSession('1306', '1304', '1306', false)).toBe(false)
    expect(isCurrentChatSession('1306', '1306', '1306', true)).toBe(false)
  })
})

describe('editAndResend', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
    ws.connect.mockResolvedValue(undefined)
    ws.sendEditMessage.mockResolvedValue(true)
    vi.mocked(api.get).mockResolvedValue({ data: {} } as never)
  })

  it('失败回滚写入编辑目标会话，不覆盖已切换的会话', async () => {
    const store = useSessionStore()
    store.setMessages('A', [
      { id: 'u1', role: 'user', content: 'old A', createdAt: '2026-09-17 12:00:00' },
      { id: 'a1', role: 'assistant', content: 'reply A', createdAt: '2026-09-17 12:00:01' },
    ])
    store.setMessages('B', [
      { id: 'ub', role: 'user', content: 'B user', createdAt: '2026-09-17 12:00:00' },
    ])
    store.setActiveSession('A')
    const chat = useChat(ref('1'), ref('CLOUD'))
    chat.sessionId.value = 'A'

    let finishSend!: (ok: boolean) => void
    ws.sendEditMessage.mockImplementation(() => new Promise<boolean>(resolve => { finishSend = resolve }))

    const pending = chat.editAndResend('u1', 'edited A')
    await vi.waitFor(() => expect(ws.sendEditMessage).toHaveBeenCalled())

    chat.sessionId.value = 'B'
    store.setActiveSession('B')
    finishSend(false)
    await pending

    expect(store.getMessages('B').map(m => m.content)).toEqual(['B user'])
    expect(store.getMessages('A').map(m => m.content)).toEqual(['old A', 'reply A'])
  })

  // round 1 BUG-3：编辑重发曾用 appendMessage 追加未注册的流式占位气泡，首个
  // content_delta 认不出尾部是自己的气泡 → 新建一条，同一轮回复被劈成
  // 「空气泡 + 新气泡」（流式期间多出一条空 assistant，回合步骤计数 +1）。
  // 必须走 ensureStreamingAssistantMessage 写进流式注册表，与 prepareAndSendMessage 同口径。
  it('首个 content_delta 必须落到重发自带的占位气泡上，不劈出空气泡', async () => {
    vi.mocked(api.get).mockResolvedValue({ data: { messages: [], hasMore: false } } as never)
    const store = useSessionStore()
    store.setMessages('9', [
      { id: '100', role: 'user', content: '写个快排', createdAt: '2026-10-13 10:00:00' },
      { id: '201', role: 'assistant', content: '旧回复', createdAt: '2026-10-13 10:00:05' },
    ])
    store.setActiveSession('9')

    const chat = useChat(ref('1'), ref('CLOUD'))
    chat.sessionId.value = '9'

    const pending = chat.editAndResend('100', '改写个堆排序')
    await vi.waitFor(() => expect(ws.sendEditMessage).toHaveBeenCalled())

    // 服务端重新执行，首包 content_delta 到达（routeEvent → store.appendDelta）
    store.appendDelta('9', '新的堆排序实现：')

    const during = store.getMessages('9')
    // 截断后应只有 [user, 占位气泡]，首包 delta 复用占位气泡，
    // 不得出现「空气泡 + 新气泡」两条 assistant
    expect(during.map(m => m.role)).toEqual(['user', 'assistant'])
    expect(during[1].content).toContain('堆排序')

    // 收尾：执行完成，解开 editAndResend 的等待
    ws.pendingCallbacks.get('9')?.resolve?.()
    await pending
  })
})

// round 1 BUG-1：文本流式中点「停止」→ 终态重拉先于服务端 CANCELLED 帧落地。
// stopExecution 只清 sending/streaming 标志不打中断标记时，phase watcher 的终态
// 重拉（REST 先于服务端 CANCELLED 广播落地）会把气泡当「REST 覆盖范围的尾部残留」
// 删掉，迟到的 CANCELLED 帧再标记已空转——已流出的半段回复凭空消失
// （服务端不落库被中止轮次，流式气泡是唯一副本）。
describe('stopExecution', () => {
  /** 等服务端历史响应（REST GET 在停止点击后一个 tick 内即发出）落地。 */
  async function flushRest() {
    for (let i = 0; i < 5; i++) {
      await Promise.resolve()
    }
    await new Promise(resolve => setTimeout(resolve, 0))
  }

  /** 被中止轮次服务端不落库：REST 历史只有用户消息，没有那条部分回复。 */
  const restWithoutReply = () => {
    vi.mocked(api.get).mockImplementation((url: string) => {
      if (url === '/sessions/9/messages') {
        return Promise.resolve({
          data: { messages: [{ id: 100, role: 'user', content: '写个快排' }], hasMore: false },
        } as never)
      }
      if (url === '/sessions/9/queue') return Promise.resolve({ data: [] } as never)
      return Promise.resolve({ data: null } as never)
    })
  }

  const seedStreaming = (store: ReturnType<typeof useSessionStore>) => {
    store.setMessages('9', [{
      id: '100', role: 'user', content: '写个快排', createdAt: '2026-10-13 10:00:00',
    }])
    store.ensureStreamingAssistantMessage('9')
    store.appendDelta('9', '好的，这是快速排序实现：')
    store.updateSessionPhase('9', 'RUNNING')
    store.setActiveSession('9')
  }

  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
    ws.cancel.mockResolvedValue(true)
    restWithoutReply()
  })

  it('部分流式回复不得因「先重拉、后收 CANCELLED 帧」而丢失', async () => {
    const store = useSessionStore()
    seedStreaming(store)

    const chat = useChat(ref('1'), ref('CLOUD'))
    chat.sessionId.value = '9'

    await chat.stopExecution()
    // 等 watcher 触发的终态 fetchMessages() 的 REST 响应落地（停止点击后一个 tick 内）
    await flushRest()

    // 服务端 CANCELLED 广播要晚几个 DB 跳数才到
    store.finishInterruptedStreamingMessage('9', '执行已被中止')

    const msgs = store.getMessages('9')
    // 已流出的部分回复是唯一副本，必须保留可见
    expect(msgs.map(m => m.role)).toEqual(['user', 'assistant'])
    expect(msgs[1].content).toContain('快速排序')
  })

  it('对照组 A（顺序正确）：CANCELLED 帧先打中断标记、后终态重拉，部分回复保留', async () => {
    const store = useSessionStore()
    seedStreaming(store)

    const chat = useChat(ref('1'), ref('CLOUD'))
    chat.sessionId.value = '9'

    await chat.stopExecution()
    // 服务端 CANCELLED 帧先到：打中断标记 + 删注册
    store.finishInterruptedStreamingMessage('9', '执行已被中止')
    await flushRest()

    const msgs = store.getMessages('9')
    expect(msgs.map(m => m.role)).toEqual(['user', 'assistant'])
    expect(msgs[1].content).toContain('快速排序')
  })

  it('对照组 B（正常完成）：REST 含完整 assistant，终态重拉后不重复、不残留', async () => {
    vi.mocked(api.get).mockImplementation((url: string) => {
      if (url === '/sessions/9/messages') {
        // 正常完成：服务端已落库完整回复（id 201）
        return Promise.resolve({
          data: {
            messages: [
              { id: 100, role: 'user', content: '写个快排' },
              { id: 201, role: 'assistant', content: '好的，这是快速排序实现：' },
            ],
            hasMore: false,
          },
        } as never)
      }
      if (url === '/sessions/9/queue') return Promise.resolve({ data: [] } as never)
      return Promise.resolve({ data: null } as never)
    })
    const store = useSessionStore()
    seedStreaming(store)

    const chat = useChat(ref('1'), ref('CLOUD'))
    chat.sessionId.value = '9'

    await chat.stopExecution()
    await flushRest()

    const msgs = store.getMessages('9')
    expect(msgs.map(m => m.role)).toEqual(['user', 'assistant'])
    // 以 REST 落库版本为准，本地流式占位气泡不得留下重复副本
    expect(msgs[1].id).toBe('201')
    expect(msgs.filter(m => m.role === 'assistant')).toHaveLength(1)
  })
})

describe('resolveFileRefPaths 绝对路径跳过（含 Windows 盘符）', () => {
  const workspace = '/Users/me/project'

  it('POSIX 绝对路径原样透过（服务端 runtime incoming / 本机 ~/.mao/attachments）', () => {
    expect(resolveFileRefPaths('看 @{/opt/mao/runtime/x/a.txt}@', workspace))
      .toBe('看 @{/opt/mao/runtime/x/a.txt}@')
    expect(resolveFileRefPaths('@{/Users/me/.mao/attachments/host/12/a.txt}@', workspace))
      .toBe('@{/Users/me/.mao/attachments/host/12/a.txt}@')
  })

  it('Windows 盘符绝对路径原样透过（LOCAL 附件拷贝落点，防拼坏引用）', () => {
    // 反斜杠形态
    expect(resolveFileRefPaths('看 @{C:\\Users\\me\\.mao\\attachments\\host\\12\\a.txt}@', workspace))
      .toBe('看 @{C:\\Users\\me\\.mao\\attachments\\host\\12\\a.txt}@')
    // 正斜杠形态
    expect(resolveFileRefPaths('@{C:/Users/me/.mao/attachments/host/12/a.txt}@', workspace))
      .toBe('@{C:/Users/me/.mao/attachments/host/12/a.txt}@')
    // 小写盘符同样识别
    expect(resolveFileRefPaths('@{d:\\data\\x.bin}@', workspace))
      .toBe('@{d:\\data\\x.bin}@')
  })

  it('相对路径仍按 workspace 拼接（@ 手输引用）', () => {
    expect(resolveFileRefPaths('看 @{src/a.txt}@', workspace)).toBe('看 @{/Users/me/project/src/a.txt}@')
    expect(resolveFileRefPaths('@{./a.txt}@', workspace)).toBe('@{/Users/me/project/./a.txt}@')
  })

  it('行区间引用只改标记里的路径，行号和片段原样留下', () => {
    const raw = '@{src/a.py}@ 第 3-4 行：\n```python\nprint(1)\n```\n请解释'
    expect(resolveFileRefPaths(raw, workspace))
      .toBe('@{/Users/me/project/src/a.py}@ 第 3-4 行：\n```python\nprint(1)\n```\n请解释')
  })

  it('无 @{} 或空 workspace 时原文返回', () => {
    expect(resolveFileRefPaths('普通文本', workspace)).toBe('普通文本')
    expect(resolveFileRefPaths('看 @{src/a.txt}@', '')).toBe('看 @{src/a.txt}@')
  })

  it('isAbsoluteFileRef 边界', () => {
    expect(isAbsoluteFileRef('/x')).toBe(true)
    expect(isAbsoluteFileRef('C:\\x')).toBe(true)
    expect(isAbsoluteFileRef('c:/x')).toBe(true)
    expect(isAbsoluteFileRef('relative/x')).toBe(false)
    expect(isAbsoluteFileRef('./x')).toBe(false)
    // 形似盘符但冒号后无斜杠（drive-relative 路径）：按相对路径处理
    expect(isAbsoluteFileRef('Z:x')).toBe(false)
    expect(isAbsoluteFileRef('C:x')).toBe(false)
  })
})

// 技术方案 2026-11-05 §4.1-3：浏览器不能新建 LOCAL 任务，但可接管已有 LOCAL 会话对话
describe('LOCAL 模式浏览器边界', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
    ws.connect.mockResolvedValue(undefined)
    vi.mocked(api.get).mockResolvedValue({ data: [] } as never)
  })

  it('浏览器新建 LOCAL 任务被拦截（不建连、不建会话）', async () => {
    const chat = useChat(ref('1'), ref('LOCAL'))
    await chat.sendMessage('hi')

    expect(ElMessage.error).toHaveBeenCalledWith(expect.stringContaining('不能新建本地任务'))
    expect(ws.connect).not.toHaveBeenCalled()
  })

  it('浏览器继续已有 LOCAL 会话时放行到发送链路', async () => {
    const chat = useChat(ref('1'), ref('LOCAL'))
    vi.mocked(api.get).mockImplementation((url: string) => url.endsWith('/messages')
      ? Promise.resolve({ data: { messages: [], hasMore: false } } as never)
      : Promise.resolve({ data: [] } as never))
    await chat.restoreSession('9', 'LOCAL')
    expect(chat.sessionId.value).toBe('9')

    // 用连接失败截断发送链路：只要 connect 被调用，即说明浏览器续聊 LOCAL 未被拦截
    ws.connect.mockRejectedValueOnce(new Error('stop here'))
    await chat.sendMessage('hi')

    expect(ElMessage.error).not.toHaveBeenCalledWith(expect.stringContaining('不能新建本地任务'))
    expect(ws.connect).toHaveBeenCalled()
  })
})

// ===== 静默失败可见化（技术方案 2026-11-07）=====

describe('fetchMessages 加载失败可见化', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
    ws.connect.mockResolvedValue(undefined)
    ws.sendEditMessage.mockResolvedValue(true)
    vi.mocked(api.get).mockResolvedValue({ data: { messages: [], hasMore: false } } as never)
  })

  it('网络 / HTTP 层失败（无 code）置历史加载错误态', async () => {
    vi.mocked(api.get).mockRejectedValue(new Error('Network Error'))
    const chat = useChat(ref('1'), ref('CLOUD'))
    chat.sessionId.value = 'A'
    await chat.fetchMessages()
    expect(chat.historyLoadError.value).toEqual({ sessionId: 'A' })
  })

  it('axios 字符串 code（ERR_NETWORK / ERR_BAD_REQUEST）不算业务拒绝，置错误态', async () => {
    // 关键分支：axios 自身错误几乎都带字符串 code，不能用 code == null 判业务拒绝（D4）
    const axiosLike = Object.assign(new Error('Request failed with status code 500'), { code: 'ERR_BAD_RESPONSE' })
    vi.mocked(api.get).mockRejectedValue(axiosLike)
    const chat = useChat(ref('1'), ref('CLOUD'))
    chat.sessionId.value = 'A'
    await chat.fetchMessages()
    expect(chat.historyLoadError.value).toEqual({ sessionId: 'A' })
  })

  it('业务拒绝（数字 code，拦截器已 toast）保持静默不置错误态', async () => {
    const business = Object.assign(new Error('会话不存在'), { code: 40400 })
    vi.mocked(api.get).mockRejectedValue(business)
    const chat = useChat(ref('1'), ref('CLOUD'))
    chat.sessionId.value = 'A'
    await chat.fetchMessages()
    expect(chat.historyLoadError.value).toBeNull()
  })

  it('加载成功无条件清空错误态', async () => {
    vi.mocked(api.get).mockRejectedValueOnce(new Error('Network Error'))
    const chat = useChat(ref('1'), ref('CLOUD'))
    chat.sessionId.value = 'A'
    await chat.fetchMessages()
    expect(chat.historyLoadError.value).toEqual({ sessionId: 'A' })
    await chat.fetchMessages()
    expect(chat.historyLoadError.value).toBeNull()
  })

  it('retryHistoryLoad 清错误态并绕过 history-anchored 门重新拉取', async () => {
    vi.mocked(api.get).mockRejectedValueOnce(new Error('Network Error'))
    const chat = useChat(ref('1'), ref('CLOUD'))
    chat.sessionId.value = 'A'
    await chat.fetchMessages()
    expect(chat.historyLoadError.value).toEqual({ sessionId: 'A' })

    const store = useSessionStore()
    // 失败重试必须真的重新拉取：即使会话被锚定在历史页也不被门挡住（forceLatest）
    store.setHistoryAnchored('A', true)
    await chat.retryHistoryLoad()
    expect(chat.historyLoadError.value).toBeNull()
    expect(api.get).toHaveBeenCalledTimes(2)
    expect(vi.mocked(api.get).mock.calls[1][0]).toBe('/sessions/A/messages')
  })
})

describe('loadOlderMessages 加载失败可见化', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
    ws.connect.mockResolvedValue(undefined)
    vi.mocked(api.get).mockResolvedValue({ data: { messages: [], hasMore: false } } as never)
  })

  function setupPagedSession(sid: string) {
    const store = useSessionStore()
    store.setMessages(sid, [
      { id: '1', role: 'user', content: 'hello', createdAt: '2026-11-07 10:00:00' },
    ])
    store.setActiveSession(sid)
    store.setMessagePageState(sid, true, '1')
    return store
  }

  it('网络 / HTTP 层失败置上拉错误态且仍返回 false', async () => {
    vi.mocked(api.get).mockImplementation(( _url: string, config?: { params?: { beforeMessageId?: unknown } }) =>
      config?.params?.beforeMessageId
        ? Promise.reject(new Error('Network Error'))
        : Promise.resolve({ data: { messages: [], hasMore: true, nextBeforeMessageId: '1' } } as never))
    const chat = useChat(ref('1'), ref('CLOUD'))
    chat.sessionId.value = 'A'
    setupPagedSession('A')
    const ok = await chat.loadOlderMessages()
    expect(ok).toBe(false)
    expect(chat.olderLoadError.value).toEqual({ sessionId: 'A' })
  })

  it('业务拒绝（数字 code）保持静默', async () => {
    vi.mocked(api.get).mockImplementation(( _url: string, config?: { params?: { beforeMessageId?: unknown } }) =>
      config?.params?.beforeMessageId
        ? Promise.reject(Object.assign(new Error('参数错误'), { code: 40000 }))
        : Promise.resolve({ data: { messages: [], hasMore: true, nextBeforeMessageId: '1' } } as never))
    const chat = useChat(ref('1'), ref('CLOUD'))
    chat.sessionId.value = 'A'
    setupPagedSession('A')
    const ok = await chat.loadOlderMessages()
    expect(ok).toBe(false)
    expect(chat.olderLoadError.value).toBeNull()
  })

  it('上拉成功清空错误态', async () => {
    vi.mocked(api.get).mockImplementation(( _url: string, config?: { params?: { beforeMessageId?: unknown } }) => {
      if (config?.params?.beforeMessageId) {
        return Promise.resolve({ data: { messages: [{ id: '0', role: 'user', content: 'old', createdAt: '2026-11-06 09:00:00' }], hasMore: false } } as never)
      }
      return Promise.resolve({ data: { messages: [], hasMore: true, nextBeforeMessageId: '1' } } as never)
    })
    const chat = useChat(ref('1'), ref('CLOUD'))
    chat.sessionId.value = 'A'
    setupPagedSession('A')
    // 先制造一次失败，再成功
    vi.mocked(api.get).mockImplementationOnce(( _url: string, config?: { params?: { beforeMessageId?: unknown } }) =>
      config?.params?.beforeMessageId
        ? Promise.reject(new Error('Network Error'))
        : Promise.resolve({ data: { messages: [], hasMore: true, nextBeforeMessageId: '1' } } as never))
    await chat.loadOlderMessages()
    expect(chat.olderLoadError.value).toEqual({ sessionId: 'A' })
    await chat.loadOlderMessages()
    expect(chat.olderLoadError.value).toBeNull()
  })
})

describe('editAndResend 三态 images（D5）', () => {
  const ORIGINAL_IMAGES = ['http://localhost/img/1.png', 'http://localhost/img/2.png']

  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
    ws.connect.mockReset()
    ws.connect.mockResolvedValue(undefined)
    vi.mocked(api.get).mockResolvedValue({ data: [] } as never)
  })

  function setupEditableSession() {
    const store = useSessionStore()
    store.setMessages('A', [
      { id: 'u1', role: 'user', content: '看这两张图', images: [...ORIGINAL_IMAGES], createdAt: '2026-11-07 10:00:00' },
      { id: 'a1', role: 'assistant', content: 'reply', createdAt: '2026-11-07 10:00:01' },
    ])
    store.setActiveSession('A')
    const chat = useChat(ref('1'), ref('CLOUD'))
    chat.sessionId.value = 'A'
    return { store, chat }
  }

  async function resendWithImages(
    images?: string[],
    /** 在确认链路收尾前检查乐观更新后的中间态（此时 updateMessageContent 已执行） */
    inspect?: (store: ReturnType<typeof useSessionStore>) => void
  ) {
    const { store, chat } = setupEditableSession()
    let finishSend!: (ok: boolean) => void
    ws.sendEditMessage.mockImplementation(() => new Promise<boolean>(resolve => { finishSend = resolve }))
    const callCountBefore = ws.sendEditMessage.mock.calls.length
    const pending = images === undefined
      ? chat.editAndResend('u1', 'edited')
      : chat.editAndResend('u1', 'edited', images)
    await vi.waitFor(() => expect(ws.sendEditMessage.mock.calls.length).toBeGreaterThan(callCountBefore))
    // 取最后一次调用，避免共享 mock 上其他用例的残留调用干扰
    const sentImages = ws.sendEditMessage.mock.calls[ws.sendEditMessage.mock.calls.length - 1][3] as string[]
    inspect?.(store)
    // editAndResend 先 await sendEditMessage，成功后才注册 pendingCallbacks——顺序不能反
    finishSend(true)
    await vi.waitFor(() => expect(ws.pendingCallbacks.has('A')).toBe(true))
    ws.pendingCallbacks.get('A')?.resolve?.()
    await pending
    return sentImages
  }

  it('未显式传图（undefined）沿用原消息图片（向后兼容）', async () => {
    expect(await resendWithImages()).toEqual(ORIGINAL_IMAGES)
  })

  it('显式传空数组 = 移除全部图片，不回落到原图', async () => {
    expect(await resendWithImages([])).toEqual([])
  })

  it('显式传数组按传入集合重发', async () => {
    expect(await resendWithImages([ORIGINAL_IMAGES[1]])).toEqual([ORIGINAL_IMAGES[1]])
  })

  it('显式传空数组时乐观更新同步清空气泡图片（round1 B1 回归）', async () => {
    await resendWithImages([], (store) => {
      const userMsg = store.getMessages('A').find(m => String(m.id) === 'u1')
      // 确认后整个重跑期间气泡必须立即反映「已无图片」，不能回落成保留原图
      expect(userMsg?.images).toEqual([])
    })
  })

  it('未显式传图时乐观更新保留原图（round1 B1 对照）', async () => {
    await resendWithImages(undefined, (store) => {
      const userMsg = store.getMessages('A').find(m => String(m.id) === 'u1')
      expect(userMsg?.images).toEqual(ORIGINAL_IMAGES)
    })
  })
})

// round1 B2 回归：错误态槽位不得被迟到的跨会话响应覆盖/清空
describe('加载错误态的跨会话竞态（round1 B2 回归）', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
    ws.connect.mockResolvedValue(undefined)
    ws.sendEditMessage.mockResolvedValue(true)
    vi.mocked(api.get).mockResolvedValue({ data: [] } as never)
  })

  it('迟到的旧会话成功响应不清掉当前会话的历史错误态', async () => {
    const resolves = new Map<string, (value: unknown) => void>()
    vi.mocked(api.get).mockImplementation((url: string) => url.endsWith('/messages')
      ? new Promise(r => { resolves.set(url, r) })
      : Promise.resolve({ data: [] }))
    const chat = useChat(ref('1'), ref('CLOUD'))
    const first = chat.restoreSession('A', 'CLOUD')
    await Promise.resolve()
    const second = chat.restoreSession('B', 'CLOUD')
    await Promise.resolve()
    // B 拉历史网络层失败 → 错误态 {B}
    resolves.get('/sessions/B/messages')!(Promise.reject(new Error('Network Error')))
    await second
    expect(chat.historyLoadError.value).toEqual({ sessionId: 'B' })
    // A 的迟到成功不得清掉 {B}
    resolves.get('/sessions/A/messages')!({ data: { messages: [], hasMore: false } })
    await first
    expect(chat.historyLoadError.value).toEqual({ sessionId: 'B' })
  })

  it('迟到的旧会话失败响应不覆盖当前会话的历史错误态', async () => {
    const resolves = new Map<string, (value: unknown) => void>()
    vi.mocked(api.get).mockImplementation((url: string) => url.endsWith('/messages')
      ? new Promise(r => { resolves.set(url, r) })
      : Promise.resolve({ data: [] }))
    const chat = useChat(ref('1'), ref('CLOUD'))
    const first = chat.restoreSession('A', 'CLOUD')
    await Promise.resolve()
    const second = chat.restoreSession('B', 'CLOUD')
    await Promise.resolve()
    resolves.get('/sessions/B/messages')!(Promise.reject(new Error('Network Error')))
    await second
    expect(chat.historyLoadError.value).toEqual({ sessionId: 'B' })
    // A 的迟到失败不得把 {B} 覆盖成 {A}
    resolves.get('/sessions/A/messages')!(Promise.reject(new Error('Network Error')))
    await first
    expect(chat.historyLoadError.value).toEqual({ sessionId: 'B' })
  })

  it('迟到的旧会话上拉失败不覆盖当前会话的上拉错误态', async () => {
    const resolves = new Map<string, (value: unknown) => void>()
    vi.mocked(api.get).mockImplementation((url: string, config?: { params?: { beforeMessageId?: unknown } }) => {
      if (config?.params?.beforeMessageId) {
        return new Promise(r => { resolves.set(`${url}|${String(config.params!.beforeMessageId)}`, r) })
      }
      if (url.endsWith('/messages')) {
        return Promise.resolve({ data: { messages: [], hasMore: true, nextBeforeMessageId: '1' } } as never)
      }
      return Promise.resolve({ data: [] })
    })
    const store = useSessionStore()
    const chat = useChat(ref('1'), ref('CLOUD'))
    await chat.restoreSession('A', 'CLOUD')
    store.setMessagePageState('A', true, '1')
    const olderA = chat.loadOlderMessages()
    await Promise.resolve()
    await chat.restoreSession('B', 'CLOUD')
    store.setMessagePageState('B', true, '1')
    const olderB = chat.loadOlderMessages()
    // B 上拉失败 → {B}
    resolves.get('/sessions/B/messages|1')!(Promise.reject(new Error('Network Error')))
    expect(await olderB).toBe(false)
    expect(chat.olderLoadError.value).toEqual({ sessionId: 'B' })
    // A 的迟到上拉失败不得覆盖 {B}
    resolves.get('/sessions/A/messages|1')!(Promise.reject(new Error('Network Error')))
    await olderA
    expect(chat.olderLoadError.value).toEqual({ sessionId: 'B' })
  })
})

// round2 回归：失败写入按「当前会话」守卫——断网下切换会话后，新会话的新鲜失败必须被记录
describe('断网切换会话后新鲜失败仍可见（round2 回归）', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
    ws.connect.mockResolvedValue(undefined)
    vi.mocked(api.get).mockRejectedValue(new Error('Network Error'))
  })

  it('旧会话失败在槽时，新会话的历史新鲜失败仍被记录', async () => {
    const chat = useChat(ref('1'), ref('CLOUD'))
    chat.sessionId.value = 'B'
    await chat.fetchMessages()
    expect(chat.historyLoadError.value).toEqual({ sessionId: 'B' })
    // 切到 A，A 的历史请求同样网络失败——必须记录 {A}，不能因槽位被 {B} 占有而丢弃
    chat.sessionId.value = 'A'
    await chat.fetchMessages()
    expect(chat.historyLoadError.value).toEqual({ sessionId: 'A' })
  })

  it('旧会话上拉失败在槽时，新会话的上拉新鲜失败仍被记录', async () => {
    vi.mocked(api.get).mockImplementation((_url: string, config?: { params?: { beforeMessageId?: unknown } }) =>
      config?.params?.beforeMessageId
        ? Promise.reject(new Error('Network Error'))
        : Promise.resolve({ data: { messages: [], hasMore: true, nextBeforeMessageId: '1' } } as never))
    const store = useSessionStore()
    const chat = useChat(ref('1'), ref('CLOUD'))
    const seed = (sid: string, id: string) => {
      store.setMessages(sid, [{ id, role: 'user', content: `msg-${sid}`, createdAt: '2026-11-07 10:00:00' }])
      store.setActiveSession(sid)
      store.setMessagePageState(sid, true, id)
    }
    chat.sessionId.value = 'A'
    seed('A', '1')
    await chat.loadOlderMessages()
    expect(chat.olderLoadError.value).toEqual({ sessionId: 'A' })
    // 切到 B，B 的上拉同样网络失败——必须记录 {B}
    chat.sessionId.value = 'B'
    seed('B', '2')
    await chat.loadOlderMessages()
    expect(chat.olderLoadError.value).toEqual({ sessionId: 'B' })
  })
})

// 此组切换到真实 useStreamWS：终态与错误走真实帧路由，而非手动 resolve mock。
describe('普通发送 → 切会话 → 旧执行终态的 WS 联动', () => {
  class ChatSocket {
    static readonly CONNECTING = 0
    static readonly OPEN = 1
    static readonly CLOSING = 2
    static readonly CLOSED = 3
    static sockets: ChatSocket[] = []
    readyState = ChatSocket.CONNECTING
    onopen: (() => void) | null = null
    onmessage: ((event: { target: unknown; data: string }) => void) | null = null
    onclose: ((event: { target: unknown }) => void) | null = null
    onerror: (() => void) | null = null
    sent: Array<Record<string, unknown>> = []
    constructor(_url: string) { ChatSocket.sockets.push(this) }
    send(value: string) { this.sent.push(JSON.parse(value)) }
    message(payload: Record<string, unknown>) {
      this.onmessage?.({ target: this, data: JSON.stringify(payload) })
    }
    open() {
      this.readyState = ChatSocket.OPEN
      this.onopen?.()
      this.message({ type: 'connected', data: { userId: 7 } })
    }
    close() {
      this.readyState = ChatSocket.CLOSED
      this.onclose?.({ target: this })
    }
  }

  let stream: ReturnType<typeof import('./useStreamWS')['useStreamWS']> | undefined
  beforeEach(() => {
    vi.resetModules()
    vi.doUnmock('./useStreamWS')
    vi.doMock('../utils/auth-storage', () => ({ getToken: () => 'test-token' }))
    vi.doMock('../api', () => ({
      api,
      fetchInboxUnreadCount: vi.fn(async () => ({ unreadCount: 0 })),
    }))
    vi.stubGlobal('WebSocket', ChatSocket)
    vi.stubGlobal('window', new EventTarget())
    ChatSocket.sockets = []
    vi.clearAllMocks()
    vi.mocked(api.get).mockResolvedValue({ data: [] } as never)
    setActivePinia(createPinia())
  })
  afterEach(() => {
    stream?.disconnect()
    stream = undefined
    vi.unstubAllGlobals()
    vi.doMock('./useStreamWS', () => ({ useStreamWS: () => ws }))
    vi.doMock('../api', () => ({ api }))
    vi.doUnmock('../utils/auth-storage')
    vi.resetModules()
  })

  it.each(['session_snapshot', 'error'] as const)('A 真实发送后切到运行中 B，A 的 %s 不改 B 状态或重拉 B 历史', async (type) => {
    const { useStreamWS: realWS } = await import('./useStreamWS')
    const { useChat: realChat } = await import('./useChat')
    const { useSessionStore: realStore } = await import('../stores/session')
    stream = realWS()
    const connecting = stream.connect()
    const socket = ChatSocket.sockets[0]!
    socket.open()
    await connecting
    const store = realStore()
    store.updateSession('42', { phase: 'IDLE', executionMode: 'CLOUD' })
    store.updateSession('43', { phase: 'RUNNING', executionMode: 'CLOUD' })
    store.setMessages('43', [
      { id: 'b-user', role: 'user', content: 'B question', createdAt: '' },
      { id: 'b-assistant', role: 'assistant', content: 'B live content', createdAt: '' },
    ])
    store.setActiveSession('42')
    const chat = realChat(ref('1'), ref('CLOUD'))
    chat.sessionId.value = '42'
    const sending = chat.sendMessage('A question')
    await vi.waitFor(() => expect(stream!.pendingCallbacks.has('42')).toBe(true))
    expect(socket.sent.some(frame => frame.type === 'send_message' && frame.sessionId === 42)).toBe(true)
    await chat.restoreSession('43', 'CLOUD')
    chat.startedAt.value = '2026-11-17T10:00:00Z'
    chat.initializingWorkspace.value = true
    chat.initializingWorkspaceLabel.value = 'B owns this label'
    const bBefore = store.getMessages('43').map(message => ({ ...message }))
    const bWaiter = stream.pendingCallbacks.get('43')
    const fetch = vi.spyOn(store, 'fetchSession')
    vi.mocked(api.get).mockClear()

    socket.message({ type, sessionId: 42, data: type === 'session_snapshot'
      ? { phase: 'COMPLETED' } : { message: 'A execution failed' } })
    await sending
    expect(chat.sessionId.value).toBe('43')
    expect(chat.sending.value).toBe(true)
    expect(chat.sendingSessionId.value).toBe('43')
    expect(chat.startedAt.value).toBe('2026-11-17T10:00:00Z')
    expect(chat.initializingWorkspace.value).toBe(true)
    expect(chat.initializingWorkspaceLabel.value).toBe('B owns this label')
    expect(store.getMessages('43')).toEqual(bBefore)
    expect(stream.pendingCallbacks.get('43')).toBe(bWaiter)
    expect(stream.pendingCallbacks.has('42')).toBe(false)
    expect(fetch).toHaveBeenCalledWith('42')
    expect(fetch).not.toHaveBeenCalledWith('43')
    expect(vi.mocked(api.get).mock.calls.some(([url]) => url === '/sessions/43/messages')).toBe(false)
  })
})

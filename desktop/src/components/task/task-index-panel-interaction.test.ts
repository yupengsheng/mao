// TaskIndexPanel 多选 / 右键菜单交互（jsdom 真实挂载 + mock 子组件与 store）。
// TaskSessionGroupList / TaskContextMenu 用真实组件：行点击、复选框禁用、右键菜单
// 禁用态与删除路径都走真实渲染，只把重子组件（聚焦列表 / 归档区 / 分享弹窗）与
// element-plus 消息组件 mock 掉。
// @vitest-environment jsdom
import { h, reactive, ref } from 'vue'
import { createPinia } from 'pinia'
import { afterEach, describe, expect, it, vi, beforeEach } from 'vitest'

/** 面板有效宽度（px）：宽度相关用例按需改写，beforeEach 复位 */
let mockPanelWidth = 280

vi.hoisted(() => {
  if (typeof window !== 'undefined' && !window.matchMedia) {
    ;(window as any).matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} })
  }
  // 拖拽改变面板宽度走 ResizeObserver：保留回调句柄，宽度用例可手动触发一次
  if (typeof globalThis !== 'undefined' && !(globalThis as any).__resizeCallbacks) {
    ;(globalThis as any).__resizeCallbacks = []
  }
  if (typeof globalThis !== 'undefined' && !(globalThis as any).ResizeObserver) {
    ;(globalThis as any).ResizeObserver = class {
      constructor(cb: () => void) {
        ;(globalThis as any).__resizeCallbacks.push(cb)
      }
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  }
  // jsdom 的 offsetWidth 恒为 0：面板 onMounted 会据此把有效宽度刷成 0，
  // showItemActions（>=200px）随之变假，行内删除确认按钮整块不渲染。
  // 统一补到桌面常见宽度，让「宽面板」分支可测；宽度用例再按需改写该值。
  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', {
    configurable: true,
    get() { return mockPanelWidth },
    set() {},
  })
})

// ---- mock 重子组件（局部 import 优先于全局注册，必须 mock 模块）----
vi.mock('./TaskFocusList.vue', () => ({ default: { name: 'TaskFocusList', render() { return null } } }))
vi.mock('./TaskArchivedSection.vue', () => ({ default: { name: 'TaskArchivedSection', render() { return null } } }))
vi.mock('./ShareDialog.vue', () => ({ default: { name: 'ShareDialog', render() { return null } } }))

// ---- mock element-plus（消息组件；TaskContextMenu 用真实组件，不 mock）----
const messageSuccess = vi.fn()
const messageWarning = vi.fn()
const messageInfo = vi.fn()
const messageError = vi.fn()
const messageBoxConfirm = vi.fn((_message: string) => new Promise<void>(() => {}))
vi.mock('element-plus', () => ({
  ElMessage: {
    success: (...a: unknown[]) => messageSuccess(...a),
    warning: (...a: unknown[]) => messageWarning(...a),
    info: (...a: unknown[]) => messageInfo(...a),
    error: (...a: unknown[]) => messageError(...a),
  },
  ElMessageBox: { confirm: (message: string) => messageBoxConfirm(message) },
}))

// ---- mock router ----
const routerPush = vi.fn()
vi.mock('vue-router', () => ({
  useRouter: () => ({ push: routerPush }),
  useRoute: () => ({ query: {}, path: '/' }),
}))

// ---- mock store（reactive 包装让 ref 属性在组件内自动解包）----
const store = reactive({
  loading: false,
  focusLoading: false,
  archivedLoading: false,
  activeSessionId: null as string | null,
  sessions: [] as any[],
  focusedSessions: [] as any[],
  archivedSessions: [] as any[],
  archivedGroupMeta: new Map(),
  fetchSessions: vi.fn(async () => {}),
  fetchFocusSessions: vi.fn(async () => {}),
  fetchArchivedSessions: vi.fn(async () => {}),
  loadMoreInGroup: vi.fn(async () => true),
  getGroupMeta: vi.fn(() => undefined),
  isGroupLoadingMore: vi.fn(() => false),
  getSessionEntity: vi.fn((_id: string): any => undefined),
  updateSessionTreeSignals: vi.fn(),
  isArchiving: vi.fn(() => false),
  isDeleting: vi.fn(() => false),
  // 与真实 store 同口径：删除成功后从标准投影移除（sessions computed 随之缩短）
  deleteSession: vi.fn(async (id: string) => {
    store.sessions = store.sessions.filter((s: any) => String(s.id) !== String(id))
    return true
  }),
  archiveSession: vi.fn(async () => {}),
  archiveSessions: vi.fn(async (_ids: string[]) => ({ archived: 0, skipped: 0 })),
  unarchiveSession: vi.fn(async () => {}),
  sessionPendingApprovals: new Map(),
  sessionPendingQuestions: new Map(),
  getSideTasks: vi.fn((_id: string): any[] => []),
  activeCompactionEvents: [] as any[],
  activeExecutionError: null,
  activeStreaming: false,
  activeThinking: false,
  activeSession: null,
  reset: vi.fn(),
})
vi.mock('../../stores/session', () => ({
  useSessionStore: () => store,
  ACTIVE_PHASES: new Set(['RUNNING', 'RESUMING', 'WAITING_APPROVAL', 'CANCELLING']),
}))

vi.mock('../../composables/useTerminal', () => ({
  useTerminal: () => ({ createTerminal: vi.fn(), isOpen: ref(false) }),
}))
vi.mock('../../composables/useCenterTabs', () => ({ removeSessionTabsFor: vi.fn() }))
vi.mock('../../composables/useTaskPanelPrefs', () => ({
  useTaskPanelPrefs: () => ({
    sortGroups: (g: any[]) => g,
    onDragEnd: vi.fn(),
    loadPrefs: vi.fn(async () => {}),
    isGroupCollapsed: () => false,
    toggleGroupCollapsed: vi.fn(),
    expandGroup: vi.fn(),
    groupAliases: ref({}),
    renameGroup: vi.fn(),
    resetGroupAlias: vi.fn(),
  }),
}))
vi.mock('../../utils/sessionShare', () => ({ downloadSessionJsonl: vi.fn() }))

import { createApp } from 'vue'
import TaskIndexPanel from './TaskIndexPanel.vue'

function mountPanel(listMode: 'standard' | 'focus' = 'standard', handlers: Record<string, unknown> = {}) {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const app = createApp({
    render: () => h(TaskIndexPanel as any, {
      collapsed: false,
      listMode,
      onToggle: () => {},
      onNewTask: () => {},
      'onUpdate:listMode': () => {},
      onNewTaskFromGroup: () => {},
      ...handlers,
    } as any),
  })
  app.use(createPinia())
  app.mount(host)
  return { host, app }
}

function q(host: HTMLElement, sel: string) { return host.querySelector(sel) as HTMLElement | null }
function qa(host: HTMLElement, sel: string) { return Array.from(host.querySelectorAll(sel)) as HTMLElement[] }

/** 等待防抖（300ms）与微任务 */
async function tick(ms = 0) {
  await new Promise(r => setTimeout(r, ms))
}

const row = (id: string, phase = 'IDLE') => ({
  id, agentId: '1', agentName: 'a', title: `t${id}`, summary: `t${id}`,
  executionMode: 'CLOUD', workspace: null, status: 'ACTIVE', phase,
  createdAt: '2026-08-01T00:00:00', updatedAt: '2026-08-01T00:00:00', running: false,
})
const rowEl = (host: HTMLElement, id: string) => host.querySelector(`[data-session-id="${id}"]`) as HTMLElement
/** 右键菜单 Teleport 到 body，不在 host 内 */
const menuItem = (text: string) =>
  Array.from(document.querySelectorAll('.task-context-menu .context-menu-item'))
    .find(el => el.textContent?.trim() === text) as HTMLElement | undefined
/** jsdom 没有 TouchEvent：手搓带 touches / changedTouches 的事件 */
function touchEvent(type: 'touchstart' | 'touchend', x: number, y: number) {
  const ev = new Event(type, { bubbles: true, cancelable: true })
  const touch = { clientX: x, clientY: y }
  Object.defineProperty(ev, 'touches', { value: type === 'touchend' ? [] : [touch] })
  Object.defineProperty(ev, 'changedTouches', { value: [touch] })
  return ev as unknown as TouchEvent
}

beforeEach(() => {
  document.body.innerHTML = ''
  mockPanelWidth = 280
  store.sessions = []
  store.activeSessionId = null
  store.sessionPendingApprovals.clear()
  store.sessionPendingQuestions.clear()
  store.getSessionEntity.mockReset()
  store.getSessionEntity.mockImplementation((id: string) => store.sessions.find(s => String(s.id) === id))
  store.getSideTasks.mockReset()
  store.getSideTasks.mockReturnValue([])
  store.fetchSessions.mockClear()
  store.fetchFocusSessions.mockClear()
  store.deleteSession.mockClear()
  store.deleteSession.mockImplementation(async (id: string) => {
    store.sessions = store.sessions.filter((s: any) => String(s.id) !== String(id))
    return true
  })
  store.archiveSessions.mockClear()
  store.archiveSessions.mockImplementation(async () => ({ archived: 0, skipped: 0 }))
  messageSuccess.mockClear()
  messageWarning.mockClear()
  messageInfo.mockClear()
  messageError.mockClear()
  // 默认 confirm 永不 resolve（= 用户未确认）；需要「已确认」的用例用 mockImplementationOnce 覆盖
  messageBoxConfirm.mockReset()
  messageBoxConfirm.mockImplementation(() => new Promise<void>(() => {}))
  routerPush.mockClear()
})

describe('TaskIndexPanel 标准分组整树活跃排序', () => {
  const renderedIds = (host: HTMLElement) => qa(host, '.session-group .session-item')
    .map(el => el.dataset.sessionId)

  it.each([
    '主任务运行', '服务端整树运行', '边路运行', '边路待审批相位',
    '整树待审批', '整树待回答', '主任务实时审批', '主任务实时问题',
    '边路实时审批', '边路实时问题', '边路缓存审批计数', '边路缓存问题计数',
  ])('%s 即使更新时间旧也排在新空闲任务前', async (signal) => {
    const old: any = row('1')
    const fresh = { ...row('9'), updatedAt: '2026-11-17T00:00:00' }
    const side: any = { id: '101', phase: 'COMPLETED' }
    if (signal === '主任务运行') Object.assign(old, { running: true, phase: 'RUNNING' })
    if (signal === '服务端整树运行') old.treeRunning = true
    if (signal === '边路运行') side.phase = 'RUNNING'
    if (signal === '边路待审批相位') side.phase = 'WAITING_APPROVAL'
    if (signal === '整树待审批') old.treePendingApprovalCount = 1
    if (signal === '整树待回答') old.treePendingQuestionCount = 1
    if (signal === '主任务实时审批') store.sessionPendingApprovals.set('1', 1)
    if (signal === '主任务实时问题') store.sessionPendingQuestions.set('1', [{ requestId: 'q1' }])
    if (signal === '边路实时审批') store.sessionPendingApprovals.set('101', 1)
    if (signal === '边路实时问题') store.sessionPendingQuestions.set('101', [{ requestId: 'q2' }])
    if (signal === '边路缓存审批计数') side.pendingApprovalCount = 1
    if (signal === '边路缓存问题计数') side.pendingQuestionCount = 1
    store.getSideTasks.mockImplementation((id: string) => id === '1' ? [side] : [])
    store.sessions = [fresh, old]
    const { host, app } = mountPanel()
    try {
      await tick()
      expect(renderedIds(host)).toEqual(['1', '9'])
    } finally {
      app.unmount()
    }
  })

  it('treeRunning=false 抑制边路残留运行态，但不抑制待审批/待回答实时信号', async () => {
    store.sessions = [
      { ...row('1'), treeRunning: false },
      { ...row('9'), updatedAt: '2026-11-17T00:00:00' },
    ]
    store.getSideTasks.mockImplementation((id: string) => id === '1' ? [{ id: '101', phase: 'RUNNING' }] : [])
    const { host, app } = mountPanel()
    try {
      await tick()
      expect(renderedIds(host)).toEqual(['9', '1'])
      store.sessionPendingApprovals.set('101', 1)
      await tick()
      expect(renderedIds(host)).toEqual(['1', '9'])
      store.sessionPendingApprovals.clear()
      await tick()
      expect(renderedIds(host)).toEqual(['9', '1'])
      store.sessionPendingQuestions.set('101', [{ requestId: 'q' }])
      await tick()
      expect(renderedIds(host)).toEqual(['1', '9'])
      store.sessionPendingQuestions.clear()
      await tick()
      expect(renderedIds(host)).toEqual(['9', '1'])
    } finally {
      app.unmount()
    }
  })

  it('服务端整树信号变化会立即重排，结束后恢复更新时间和 id 倒序', async () => {
    store.sessions = [row('1'), row('2'), row('3')]
    const { host, app } = mountPanel()
    try {
      await tick()
      expect(renderedIds(host)).toEqual(['3', '2', '1'])
      store.sessions[2].treeRunning = true
      store.sessions[0].treeRunning = true
      await tick()
      expect(renderedIds(host)).toEqual(['3', '1', '2'])
      store.sessions[2].treeRunning = false
      store.sessions[0].treeRunning = false
      await tick()
      expect(renderedIds(host)).toEqual(['3', '2', '1'])
    } finally {
      app.unmount()
    }
  })

  it.each([null, '1', '9', 'outside'])('分组新建按当前同组会话优先、最新会话兜底（当前 %s）', async (activeId) => {
    store.sessions = [
      { ...row('1'), treeRunning: true, agentId: 'old-agent', modelId: 'old-model', permissionLevel: 'READ_ONLY' },
      { ...row('9'), updatedAt: '2026-11-17T00:00:00', agentId: 'new-agent', modelId: 'new-model', permissionLevel: 'FULL' },
    ]
    store.activeSessionId = activeId
    const onNewTaskFromGroup = vi.fn()
    const { host, app } = mountPanel('standard', { onNewTaskFromGroup })
    try {
      await tick()
      expect(renderedIds(host)).toEqual(['1', '9'])
      q(host, '.group-header button[title="在该分组新建任务"]')!.click()
      await tick()
      const useOld = activeId === '1'
      expect(onNewTaskFromGroup).toHaveBeenCalledWith(expect.objectContaining({
        agentId: useOld ? 'old-agent' : 'new-agent',
        modelId: useOld ? 'old-model' : 'new-model',
        permissionLevel: useOld ? 'READ_ONLY' : 'FULL',
        executionMode: 'CLOUD',
      }))
    } finally {
      app.unmount()
    }
  })
})

describe('TaskIndexPanel 多选批量归档交互', () => {
  it('进入选择态渲染列表上方的操作条；Esc 退出', async () => {
    const { host, app } = mountPanel()
    expect(q(host, '.select-action-bar')).toBeNull()
    q(host, '.select-toggle-btn')!.click()
    await tick()
    expect(q(host, '.select-action-bar')).toBeTruthy()
    expect(q(host, '.select-count')!.textContent).toContain('已选 0')

    // 操作条必须在滚动列表之前：长列表勾选后不必滚到底部才能归档
    const bar = q(host, '.select-action-bar')!
    const content = q(host, '.panel-content')!
    expect(bar.compareDocumentPosition(content) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await tick()
    expect(q(host, '.select-action-bar')).toBeNull()
    app.unmount()
  })

  it('聚焦模式没有多选入口（决策 4：仅标准模式）', async () => {
    const { host, app } = mountPanel('focus')
    expect(q(host, '.select-toggle-btn')).toBeNull()
    app.unmount()
  })

  it('选择模式：行点击=勾选，运行中行复选框禁用且点行不选中', async () => {
    store.sessions = [row('1'), row('2'), row('3', 'RUNNING')]
    const { host, app } = mountPanel()
    await tick()
    expect(qa(host, '.session-group .session-item').length).toBe(3)

    q(host, '.select-toggle-btn')!.click()
    await tick()
    // 选择态：行首是复选框
    expect(qa(host, '.session-select-checkbox').length).toBe(3)
    // 运行中（RUNNING）不可选
    expect((rowEl(host, '3').querySelector('.session-select-checkbox') as HTMLInputElement).disabled).toBe(true)

    rowEl(host, '1').click()
    await tick()
    expect(q(host, '.select-count')!.textContent).toContain('已选 1')
    expect((rowEl(host, '1').querySelector('.session-select-checkbox') as HTMLInputElement).checked).toBe(true)

    // 再点一次取消勾选
    rowEl(host, '1').click()
    await tick()
    expect(q(host, '.select-count')!.textContent).toContain('已选 0')

    // 点运行中的行不会选中
    rowEl(host, '3').click()
    await tick()
    expect(q(host, '.select-count')!.textContent).toContain('已选 0')
    app.unmount()
  })

  it('非选择模式：行点击=打开会话', async () => {
    store.sessions = [row('1')]
    const { host, app } = mountPanel()
    await tick()
    ;(host.querySelector('.session-group .session-item') as HTMLElement).click()
    await tick()
    expect(routerPush).toHaveBeenCalledWith('/tasks/1')
    app.unmount()
  })

  it('批量归档：确认后调 archiveSessions，toast 提示并退出选择态', async () => {
    store.sessions = [row('1'), row('2'), row('3', 'RUNNING')]
    store.archiveSessions.mockImplementation(async () => ({ archived: 2, skipped: 1 }))
    // 本用例点「归档」= 确认
    messageBoxConfirm.mockImplementationOnce(async () => {})
    const { host, app } = mountPanel()
    await tick()
    q(host, '.select-toggle-btn')!.click()
    await tick()
    rowEl(host, '1').click()
    rowEl(host, '2').click()
    await tick()
    expect(q(host, '.select-count')!.textContent).toContain('已选 2')

    ;(q(host, '.select-archive-btn') as HTMLElement).click()
    await tick(10)

    // 确认弹窗文案明示运行中自动跳过（C14）
    expect(messageBoxConfirm).toHaveBeenCalledTimes(1)
    expect(String(messageBoxConfirm.mock.calls[0][0])).toContain('运行中的任务将自动跳过')
    expect(store.archiveSessions).toHaveBeenCalledWith(['1', '2'])
    expect(messageSuccess).toHaveBeenCalledWith('已归档 2 个，1 个跳过')
    // 退出选择态
    expect(q(host, '.select-action-bar')).toBeNull()
    app.unmount()
  })

  it('批量归档：取消确认框不发起归档，选择态保留', async () => {
    store.sessions = [row('1')]
    const { host, app } = mountPanel()
    await tick()
    q(host, '.select-toggle-btn')!.click()
    await tick()
    rowEl(host, '1').click()
    await tick()
    ;(q(host, '.select-archive-btn') as HTMLElement).click()
    await tick()
    // 默认 confirm 实现永不 resolve（= 用户未确认）：不发起归档
    expect(store.archiveSessions).not.toHaveBeenCalled()
    // 选择态与勾选都保留
    expect(q(host, '.select-action-bar')).toBeTruthy()
    expect(q(host, '.select-count')!.textContent).toContain('已选 1')
    app.unmount()
  })

  it('选择模式下右键菜单的单条归档入口禁用（与底部批量操作条互斥）', async () => {
    store.sessions = [row('1')]
    const { host, app } = mountPanel()
    await tick()
    q(host, '.select-toggle-btn')!.click()
    await tick()
    rowEl(host, '1').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))
    await tick()
    const archiveItem = menuItem('归档')
    expect(archiveItem).toBeTruthy()
    expect(archiveItem!.className).toContain('disabled')
    expect(archiveItem!.getAttribute('title')).toContain('多选模式')
    app.unmount()
  })
})

describe('TaskIndexPanel 新建会话入口', () => {
  it('新建会话是列表上方的宽按钮：带图标与「新会话」文案，头部不再有「+」图标', async () => {
    store.sessions = [row('1'), row('2')]
    const { host, app } = mountPanel()
    await tick()

    const btn = q(host, '.new-session-btn')!
    expect(btn).toBeTruthy()
    expect(btn.textContent).toContain('新会话')
    // 图标与文案同在按钮内（不再靠 title tooltip 传达语义）；
    // jsdom 未注册 element-plus 组件，el-icon 以未知元素渲染，故按标签名取
    expect(btn.querySelector('.new-session-label')).toBeTruthy()
    expect(btn.querySelector('el-icon')).toBeTruthy()

    // 头部只剩模式切换 / 多选 / 刷新：原「+」新建图标已移除
    const headerIcons = qa(host, '.header-actions button')
    expect(headerIcons.length).toBe(3)
    expect(headerIcons.some(b => b.title === '新任务')).toBe(false)

    // 按钮必须排在滚动列表之前：任务再多也不必滚到底才能新建
    const content = q(host, '.panel-content')!
    expect(btn.compareDocumentPosition(content) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    app.unmount()
  })

  it('点击宽按钮仍走 newTask（与原先头部「+」同一事件）', async () => {
    store.sessions = [row('1')]
    const onNewTask = vi.fn()
    const { host, app } = mountPanel('standard', { onNewTask })
    await tick()
    ;(q(host, '.new-session-btn') as HTMLElement).click()
    await tick()
    expect(onNewTask).toHaveBeenCalledTimes(1)
    app.unmount()
  })

  it('聚焦模式同样提供新建会话入口', async () => {
    const { host, app } = mountPanel('focus')
    await tick()
    const btn = q(host, '.new-session-btn')!
    expect(btn).toBeTruthy()
    const content = q(host, '.panel-content')!
    expect(btn.compareDocumentPosition(content) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    app.unmount()
  })
})

describe('TaskIndexPanel 分组「+」新建任务的工作区沿用', () => {
  const feishuRow = (id: string) => ({
    ...row(id),
    workspace: '/opt/mao-data/workspace/feishu-chat/2/oc_4fc3cb715272aae592213f167743846d',
    projectKey: 'feishu-chat-2-oc_4fc3cb715272aae592213f167743846d',
  })
  const groupAddBtn = (host: HTMLElement) =>
    qa(host, '.group-add-btn').find(b => b.title === '在该分组新建任务')!

  it('飞书群分组点「+」：带出该群工作区与复用标记（回归：掉到临时工作区）', async () => {
    store.sessions = [feishuRow('1')]
    const onNewTaskFromGroup = vi.fn()
    const { host, app } = mountPanel('standard', { onNewTaskFromGroup })
    await tick()
    groupAddBtn(host).click()
    await tick()
    expect(onNewTaskFromGroup).toHaveBeenCalledTimes(1)
    const payload = onNewTaskFromGroup.mock.calls[0][0]
    expect(payload.workspace).toBe('/opt/mao-data/workspace/feishu-chat/2/oc_4fc3cb715272aae592213f167743846d')
    expect(payload.reuseWorkspace).toBe(true)
    // 通道 projectKey 是通道标识不是项目 slug，不得带给后端（曾致「工作区不存在」）
    expect(payload.cloudProjectKey).toBeUndefined()
    app.unmount()
  })

  it('共享云项目分组点「+」：仍带项目键，不预填工作区', async () => {
    store.sessions = [{ ...row('1'), workspace: '/opt/mao-data/workspace/2/projects/mao', projectKey: 'mao' }]
    const onNewTaskFromGroup = vi.fn()
    const { host, app } = mountPanel('standard', { onNewTaskFromGroup })
    await tick()
    groupAddBtn(host).click()
    await tick()
    const payload = onNewTaskFromGroup.mock.calls[0][0]
    expect(payload.cloudProjectKey).toBe('mao')
    expect(payload.workspace).toBeUndefined()
    expect(payload.reuseWorkspace).toBeUndefined()
    app.unmount()
  })

  it('临时工作区分组点「+」：不预填任何工作区', async () => {
    store.sessions = [row('1')]
    const onNewTaskFromGroup = vi.fn()
    const { host, app } = mountPanel('standard', { onNewTaskFromGroup })
    await tick()
    groupAddBtn(host).click()
    await tick()
    const payload = onNewTaskFromGroup.mock.calls[0][0]
    expect(payload.workspace).toBeUndefined()
    expect(payload.reuseWorkspace).toBeUndefined()
    expect(payload.cloudProjectKey).toBeUndefined()
    app.unmount()
  })
})

describe('TaskIndexPanel 右键菜单删除路径', () => {
  it('多选态下右键「删除」改走确认弹窗，不落入无宿主的内联确认（回归：删除死路）', async () => {
    store.sessions = [row('1')]
    const { host, app } = mountPanel()
    await tick()
    q(host, '.select-toggle-btn')!.click()
    await tick()
    rowEl(host, '1').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))
    await tick()

    menuItem('删除')!.click()
    await tick()

    // 走确认弹窗路径（与窄面板同口径）：内联确认按钮在选择态没有宿主
    expect(messageBoxConfirm).toHaveBeenCalledTimes(1)
    // 菜单关闭，且没有「延迟出现」的内联确认按钮
    expect(menuItem('删除')).toBeUndefined()
    expect(host.textContent).not.toContain('确认删除')
    app.unmount()
  })

  it('对照组：非选择态右键「删除」走行内确认（按钮可见可点）', async () => {
    store.sessions = [row('1')]
    const { host, app } = mountPanel()
    await tick()
    rowEl(host, '1').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))
    await tick()

    menuItem('删除')!.click()
    await tick()

    // 宽面板非选择态：confirmingDeleteId 行内确认分支，确认/取消按钮立即可见
    expect(messageBoxConfirm).not.toHaveBeenCalled()
    const confirmBtn = qa(host, '.session-item-actions .action-confirm')[0]
    expect(confirmBtn).toBeTruthy()
    expect(confirmBtn.getAttribute('title')).toBe('确认删除')
    app.unmount()
  })

  it('选择态弹窗删除成功后同步剔除勾选集：计数不虚高、批量归档不误报「跳过」', async () => {
    store.sessions = [row('1'), row('2'), row('3')]
    // 与真实 store 同口径：按实体存在性过滤 targets，已删除的 id 计入 skipped
    store.archiveSessions.mockImplementation(async (ids: string[]) => {
      const targets = ids.filter(id => store.sessions.some((s: any) => String(s.id) === id))
      return { archived: targets.length, skipped: ids.length - targets.length }
    })
    const { host, app } = mountPanel()
    await tick()
    q(host, '.select-toggle-btn')!.click()
    await tick()
    rowEl(host, '1').click()
    rowEl(host, '2').click()
    rowEl(host, '3').click()
    await tick()
    expect(q(host, '.select-count')!.textContent).toContain('已选 3')

    // 选择态右键删除第 2 行：走确认弹窗，确认后删除成功
    rowEl(host, '2').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))
    await tick()
    messageBoxConfirm.mockImplementationOnce(async () => {})
    menuItem('删除')!.click()
    await tick(10)

    // 行消失，且勾选集同步剔除：界面上剩 2 行，计数必须是「已选 2」
    expect(rowEl(host, '2')).toBeNull()
    expect(q(host, '.select-count')!.textContent).toContain('已选 2')

    // 再点批量归档：只传仍在勾选集的 id，不带着已删除的会话去计「跳过」
    messageBoxConfirm.mockImplementationOnce(async () => {})
    ;(q(host, '.select-archive-btn') as HTMLElement).click()
    await tick(10)

    expect(store.archiveSessions).toHaveBeenCalledWith(['1', '3'])
    expect(messageSuccess).toHaveBeenCalledWith('已归档 2 个')
    app.unmount()
  })
})

describe('TaskIndexPanel 宽度阈值', () => {
  const panel = (host: HTMLElement) => host.querySelector('.task-index-panel')!

  it('≥160px 显示「任务」标题（三个图标后标题与图标可同框）', async () => {
    mockPanelWidth = 180
    const { host, app } = mountPanel()
    await tick()
    expect(panel(host).classList.contains('header-condensed')).toBe(false)
    expect(q(host, '.panel-title')!.textContent).toBe('任务')
    app.unmount()
  })

  it('<160px 隐藏「任务」标题（极窄栏把宽度让给图标）', async () => {
    mockPanelWidth = 140
    const { host, app } = mountPanel()
    await tick()
    expect(panel(host).classList.contains('header-condensed')).toBe(true)
    expect(q(host, '.panel-title')).toBeNull()
    app.unmount()
  })

  it('160–199px 仍不显示行内操作按钮（行内阈值独立保持 200px）', async () => {
    mockPanelWidth = 180
    store.sessions = [row('1')]
    const { host, app } = mountPanel()
    await tick()
    // 标题回来了，但 .session-item-actions 依旧被 showItemActions 门控
    expect(panel(host).classList.contains('header-condensed')).toBe(false)
    expect(panel(host).classList.contains('actions-hidden')).toBe(true)
    expect(q(rowEl(host, '1'), '.session-item-actions')).toBeNull()
    app.unmount()
  })

  it('拖窄跨越 160px 时标题实时隐藏（走 ResizeObserver）', async () => {
    mockPanelWidth = 280
    const { host, app } = mountPanel()
    await tick()
    expect(q(host, '.panel-title')!.textContent).toBe('任务')

    mockPanelWidth = 140
    ;(globalThis as any).__resizeCallbacks.forEach((cb: () => void) => cb())
    await tick()
    expect(q(host, '.panel-title')).toBeNull()

    mockPanelWidth = 200
    ;(globalThis as any).__resizeCallbacks.forEach((cb: () => void) => cb())
    await tick()
    expect(q(host, '.panel-title')!.textContent).toBe('任务')
    app.unmount()
  })
})

describe('TaskIndexPanel 移动端历史会话抽屉', () => {
  it('关闭态保留 DOM 但 inert，展开态显示关闭按钮且可交互', async () => {
    const closed = mountPanel('standard', { mobile: true, drawerOpen: false })
    const closedPanel = q(closed.host, '.task-index-panel')!
    expect(closedPanel.classList.contains('mobile-drawer')).toBe(true)
    expect(closedPanel.classList.contains('drawer-open')).toBe(false)
    expect(closedPanel.getAttribute('aria-hidden')).toBe('true')
    expect(closedPanel.hasAttribute('inert')).toBe(true)
    closed.app.unmount()

    const opened = mountPanel('standard', { mobile: true, drawerOpen: true })
    const openedPanel = q(opened.host, '.task-index-panel')!
    expect(openedPanel.classList.contains('drawer-open')).toBe(true)
    expect(openedPanel.hasAttribute('aria-hidden')).toBe(false)
    expect(openedPanel.hasAttribute('inert')).toBe(false)
    expect(q(opened.host, '.drawer-close-btn')).toBeTruthy()
    opened.app.unmount()
  })

  it('关闭按钮只触发 close，不切换列表或新建任务', async () => {
    const onClose = vi.fn()
    const onNewTask = vi.fn()
    const { host, app } = mountPanel('standard', { mobile: true, drawerOpen: true, onClose, onNewTask })
    await tick()
    ;(q(host, '.drawer-close-btn') as HTMLElement).click()
    await tick()
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(onNewTask).not.toHaveBeenCalled()
    app.unmount()
  })

  it('选中会话先关闭抽屉再跳转，避免详情页仍被遮罩覆盖', async () => {
    store.sessions = [row('1')]
    const onClose = vi.fn()
    const { host, app } = mountPanel('standard', { mobile: true, drawerOpen: true, onClose })
    await tick()
    ;(host.querySelector('.session-group .session-item') as HTMLElement).click()
    await tick()
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(routerPush).toHaveBeenCalledWith('/tasks/1')
    app.unmount()
  })
})

describe('TaskIndexPanel 触屏拖拽', () => {
  const desktopUa = navigator.userAgent

  afterEach(() => {
    Object.defineProperty(navigator, 'userAgent', { configurable: true, value: desktopUa })
  })

  it('iOS 打开抽屉后不挂 HTML5 draggable，第一次点击就能打开会话', async () => {
    Object.defineProperty(navigator, 'userAgent', {
      configurable: true,
      value: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148',
    })
    store.sessions = [row('1')]
    const { host, app } = mountPanel('standard', { mobile: true, drawerOpen: true })
    await tick()
    expect(host.querySelector('.session-group')?.getAttribute('draggable')).toBe('false')
    app.unmount()
  })

  it('桌面端保留分组拖拽排序', async () => {
    Object.defineProperty(navigator, 'userAgent', {
      configurable: true,
      value: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    })
    store.sessions = [row('1')]
    const { host, app } = mountPanel()
    await tick()
    expect(host.querySelector('.session-group')?.getAttribute('draggable')).toBe('true')
    app.unmount()
  })
})

describe('TaskIndexPanel 移动端历史会话轻点', () => {
  it('只有 touchend（合成 click 被 iOS 吞掉）也能一次打开会话，且随后的 click 不重复触发', async () => {
    store.sessions = [row('1')]
    const onClose = vi.fn()
    const { host, app } = mountPanel('standard', { mobile: true, drawerOpen: true, onClose })
    await tick()
    const el = rowEl(host, '1')
    el.dispatchEvent(touchEvent('touchstart', 10, 10))
    el.dispatchEvent(touchEvent('touchend', 12, 11))
    await tick()
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(routerPush).toHaveBeenCalledTimes(1)
    expect(routerPush).toHaveBeenCalledWith('/tasks/1')

    // iOS 随后补发的合成 click 落在同一个去重窗口内，不应再打开一次
    el.click()
    await tick()
    expect(routerPush).toHaveBeenCalledTimes(1)
    app.unmount()
  })

  it('在会话行上滑动滚动列表不会打开会话', async () => {
    store.sessions = [row('1')]
    const { host, app } = mountPanel('standard', { mobile: true, drawerOpen: true })
    await tick()
    const el = rowEl(host, '1')
    el.dispatchEvent(touchEvent('touchstart', 10, 10))
    el.dispatchEvent(touchEvent('touchend', 10, 80))
    await tick()
    expect(routerPush).not.toHaveBeenCalled()
    app.unmount()
  })

  it('点行内「删除」按钮不会顺带打开会话', async () => {
    store.sessions = [row('1')]
    const { host, app } = mountPanel('standard', { mobile: true, drawerOpen: true })
    await tick()
    const btn = rowEl(host, '1').querySelector('.action-delete') as HTMLElement
    expect(btn).toBeTruthy()
    btn.dispatchEvent(touchEvent('touchstart', 5, 5))
    btn.dispatchEvent(touchEvent('touchend', 5, 5))
    await tick()
    expect(routerPush).not.toHaveBeenCalled()
    app.unmount()
  })
})

import { readFileSync } from 'node:fs'
import { ref } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { removeSessionTabsFor, resetCenterTabs, useCenterTabs } from '../../composables/useCenterTabs'

vi.mock('../../stores/session', () => ({
  useSessionStore: () => ({
    setViewingSideTask: vi.fn(),
    markSideTaskRead: vi.fn(async () => undefined),
    getSessionEntity: vi.fn(() => null),
    activeSession: null,
    fileQuoteRevision: vi.fn(() => 0),
  }),
}))

const store = new Map<string, string>()
vi.stubGlobal('localStorage', {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
  clear: () => store.clear(),
})

const SESSION_ID = '42'

function setup() {
  return useCenterTabs(ref<string | null>(SESSION_ID))
}

function setupThreeFileTabs() {
  const tabs = setup()
  tabs.openFileTab('a.md', 'a')
  tabs.openFileTab('b.md', 'b')
  tabs.openFileTab('c.md', 'c')
  return tabs
}

function fileTabIds(tabs: ReturnType<typeof useCenterTabs>): string[] {
  return tabs.tabs.value.map(t => t.id).filter(id => id !== 'chat')
}

describe('reorderTab', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    localStorage.clear()
    resetCenterTabs()
    removeSessionTabsFor(SESSION_ID)
  })

  it('supports both drag directions without an off-by-one shift', () => {
    const tabs = setupThreeFileTabs()

    tabs.reorderTab('file:c.md', 'file:a.md', 'before')
    expect(fileTabIds(tabs)).toEqual(['file:c.md', 'file:a.md', 'file:b.md'])

    tabs.reorderTab('file:c.md', 'file:b.md', 'after')
    expect(fileTabIds(tabs)).toEqual(['file:a.md', 'file:b.md', 'file:c.md'])

    tabs.reorderTab('file:a.md', 'file:c.md', 'before')
    expect(fileTabIds(tabs)).toEqual(['file:b.md', 'file:a.md', 'file:c.md'])
  })

  it('keeps the active tab stable and ignores chat or unknown ids', () => {
    const tabs = setupThreeFileTabs()
    tabs.activateTab('file:b.md')

    tabs.reorderTab('chat', 'file:a.md', 'before')
    tabs.reorderTab('file:a.md', 'chat', 'after')
    tabs.reorderTab('file:a.md', 'file:a.md', 'before')
    tabs.reorderTab('nope', 'file:a.md', 'before')
    tabs.reorderTab('file:a.md', 'nope', 'after')

    expect(fileTabIds(tabs)).toEqual(['file:a.md', 'file:b.md', 'file:c.md'])
    expect(tabs.activeTabId.value).toBe('file:b.md')
  })
})

describe('closeRightTabs', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    localStorage.clear()
    resetCenterTabs()
    removeSessionTabsFor(SESSION_ID)
  })

  it('closes file tabs on the right while preserving side tasks and subagents', () => {
    const tabs = setup()
    tabs.openFileTab('a.md', 'a')
    tabs.openFileTab('b.md', 'b')
    tabs.openSideTaskTab(7, '边路任务')
    tabs.openSubagentTab(5, '子代理')
    tabs.openFileTab('c.md', 'c')
    tabs.activateTab('file:a.md')

    tabs.closeRightTabs('file:a.md')

    expect(tabs.tabs.value.map(t => t.type).sort()).toEqual(['chat', 'file', 'side_task', 'subagent'])
    expect(tabs.tabs.value.find(t => t.type === 'file')?.filePath).toBe('a.md')
    expect(tabs.tabs.value.some(t => t.type === 'side_task' && t.sideSessionId === 7)).toBe(true)
    expect(tabs.tabs.value.some(t => t.type === 'subagent' && t.sideSessionId === 5)).toBe(true)
    expect(tabs.activeTabId.value).toBe('file:a.md')
  })

  it('falls back through closeTab semantics when the active tab is also closed', () => {
    const tabs = setupThreeFileTabs()
    tabs.activateTab('file:c.md')

    tabs.closeRightTabs('file:a.md')

    expect(fileTabIds(tabs)).toEqual(['file:a.md'])
    expect(tabs.activeTabId.value).toBe('file:a.md')
  })

  it('treats chat as the start of the bar and ignores unknown targets', () => {
    const tabs = setup()
    tabs.openFileTab('a.md', 'a')
    tabs.openSideTaskTab(7, '边路任务')

    tabs.closeRightTabs('chat')
    expect(tabs.tabs.value.map(t => t.type)).toEqual(['chat', 'side_task'])
    expect(tabs.activeTabId.value).toBe('side:7')

    tabs.openFileTab('b.md', 'b')
    tabs.closeRightTabs('nope')
    expect(tabs.tabs.value.filter(t => t.type === 'file').map(t => t.id)).toEqual(['file:b.md'])
  })
})

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8')
const tabBarSrc = read('./CenterTabBar.vue')
const taskViewSrc = read('../../views/task/TaskView.vue')

function functionBody(src: string, startMarker: string): string {
  const at = src.indexOf(startMarker)
  expect(at, `未找到 ${startMarker}`).toBeGreaterThan(-1)
  const end = src.indexOf('\n}', at)
  expect(end, `${startMarker} 未找到闭合}`).toBeGreaterThan(-1)
  return src.slice(at, end)
}

describe('CenterTabBar wiring', () => {
  it('binds middle-click, drag sorting and the close-right menu action', () => {
    expect(tabBarSrc).toContain(':draggable="tab.type !== \'chat\'"')
    expect(tabBarSrc).toContain('@mousedown="onTabMousedown($event)"')
    expect(tabBarSrc).toContain('@auxclick="onTabAuxclick($event, tab.id)"')
    expect(tabBarSrc).toContain('@dragstart="onTabDragstart($event, tab)"')
    expect(tabBarSrc).toContain('@dragover="onTabDragover($event, tab)"')
    expect(tabBarSrc).toContain('@drop="onTabDrop($event, tab)"')
    expect(tabBarSrc).toContain("$emit('close-right', contextMenu.tabId!)")
    expect(tabBarSrc).toContain('关闭右侧文件')
  })

  it('uses a private reorder MIME and only intercepts after identifying it', () => {
    expect(tabBarSrc).toContain("'application/x-mao-tab-reorder'")
    const dragstart = functionBody(tabBarSrc, 'function onTabDragstart')
    expect(dragstart).toContain('setData(TAB_REORDER_MIME')
    expect(dragstart).toContain("effectAllowed = 'move'")

    const drop = functionBody(tabBarSrc, 'function onTabDrop')
    const mimeAt = drop.indexOf('TAB_REORDER_MIME')
    expect(mimeAt).toBeGreaterThan(-1)
    expect(drop.indexOf('e.preventDefault()')).toBeGreaterThan(mimeAt)
    expect(drop.indexOf('e.stopPropagation()')).toBeGreaterThan(mimeAt)
    expect(drop).toContain("emit('reorder'")
  })

  it('supports dropping on the bar tail and clears hints on drag end or leave', () => {
    expect(functionBody(tabBarSrc, 'function onBarReorderDragover')).toContain('TAB_REORDER_MIME')
    expect(functionBody(tabBarSrc, 'function onBarReorderDrop')).toContain('TAB_REORDER_MIME')
    expect(tabBarSrc).toContain('@dragover="onBarReorderDragover"')
    expect(tabBarSrc).toContain('@drop="onBarReorderDrop"')
    expect(tabBarSrc).toContain("document.addEventListener('dragend', onWindowDragEnd)")
    expect(tabBarSrc).toContain("document.removeEventListener('dragend', onWindowDragEnd)")
    expect(tabBarSrc).toContain('.tab-item.drop-before::before')
    expect(tabBarSrc).toContain('.tab-item.drop-after::after')
  })
})

describe('TaskView tab cycling', () => {
  it('wires reorder and close-right events to the tab state', () => {
    expect(taskViewSrc).toContain('@reorder="reorderTab"')
    expect(taskViewSrc).toContain('@close-right="closeRightTabs"')
  })

  it('cycles with Ctrl/Cmd+Alt+Arrow while skipping typing targets', () => {
    const typing = functionBody(taskViewSrc, 'function isTypingTarget')
    expect(typing).toContain("'INPUT'")
    expect(typing).toContain("'TEXTAREA'")
    expect(typing).toContain('isContentEditable')

    const cycle = functionBody(taskViewSrc, 'function handleTabCycleKeydown')
    expect(cycle).toContain('e.repeat')
    expect(cycle).toContain("e.key !== 'ArrowLeft'")
    expect(cycle).toContain('isTypingTarget(e.target)')
    expect(cycle).toContain('idx === -1')
    expect(cycle).toContain('% tabs.value.length')
    expect(cycle.indexOf('isTypingTarget(e.target)')).toBeLessThan(cycle.indexOf('e.preventDefault()'))
  })

  it('registers and removes the keydown listener with the view lifecycle', () => {
    const mounted = functionBody(taskViewSrc, 'onMounted(async () => {')
    const unmounted = functionBody(taskViewSrc, 'onUnmounted(() => {')
    expect(mounted).toContain("document.addEventListener('keydown', handleTabCycleKeydown)")
    expect(unmounted).toContain("document.removeEventListener('keydown', handleTabCycleKeydown)")
  })
})

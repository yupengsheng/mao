import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h } from 'vue'
import { createMemoryHistory, createRouter } from 'vue-router'
import { useExperienceLibrary, type ExperienceLibraryStore } from './useExperienceLibrary'

const { get, put, patch, del, post, confirm } = vi.hoisted(() => ({
  get: vi.fn(), put: vi.fn(), patch: vi.fn(), del: vi.fn(), post: vi.fn(), confirm: vi.fn(),
}))
vi.mock('../../../api', () => ({ api: { get, put, patch, delete: del, post } }))
vi.mock('element-plus', () => ({ ElMessage: { success: vi.fn() }, ElMessageBox: { confirm } }))
const doc = { fileName: '2026-11-a.md', title: 'A', keywords: 'TS', summary: '', applicable: '', lastVerified: '', sizeBytes: 10, updatedAt: '' }
const overview = { libraries: [{ agentId: 1, agentName: 'Coder', enabled: true, docCount: 45, totalBytes: 100, lastUpdatedAt: '' }], orphans: [] }
const list = { enabled: true, total: 45, page: 1, size: 20, docs: [doc], groupCounts: [{ key: '2026-11', count: 45 }], keywords: [{ tag: 'TS', count: 45 }] }
const tick = async () => { for (let i = 0; i < 12; i++) await new Promise(resolve => setTimeout(resolve, 0)) }
const cleanup: Array<() => void> = []
async function mount(query: Record<string, string> = {}) {
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/experience-library', name: 'ExperienceLibrary', component: { render: () => null } }] })
  await router.push({ name: 'ExperienceLibrary', query })
  await router.isReady()
  let store!: ExperienceLibraryStore
  const app = createApp(defineComponent({ setup() { store = useExperienceLibrary(); return () => h('div') } }))
  app.use(router)
  const el = document.createElement('div')
  app.mount(el)
  cleanup.push(() => app.unmount())
  await tick()
  return { store, router }
}
beforeEach(() => {
  vi.resetAllMocks()
  get.mockImplementation(async (url: string) => ({ data: url.endsWith('/overview') ? overview
    : url.endsWith('/index') ? { fileName: 'INDEX.md', content: '<!-- count: 45 -->', docCount: 45 }
      : url.endsWith('/content') ? { fileName: doc.fileName, content: '# A' } : list }))
  put.mockResolvedValue({ data: {} })
  confirm.mockResolvedValue('confirm')
})
afterEach(() => { for (const unmount of cleanup.splice(0)) unmount() })

describe('useExperienceLibrary API / URL behavior', () => {
  it('restores every filter and sends the paginated API contract rather than treating legacy full docs as a page', async () => {
    const { store } = await mount({ agentId: '1', page: '2', keyword: ' bug ', tag: 'TS', sort: 'updatedAt', order: 'asc', groupBy: 'keyword', abnormal: 'no-title', verifiedFrom: '2026-01-01', verifiedTo: '2026-11-17', updatedFrom: '2026-11-01', updatedTo: '2026-11-17' })
    expect(get).toHaveBeenCalledWith('/agents/1/experience-library/docs', { params: {
      page: 2, size: 20, keyword: 'bug', tag: 'TS', sort: 'updatedAt', order: 'asc', groupBy: 'keyword', abnormal: 'no-title', verifiedFrom: '2026-01-01', verifiedTo: '2026-11-17', updatedFrom: '2026-11-01', updatedTo: '2026-11-17',
    } })
    expect(store.total).toBe(45)
    expect(store.docs).toEqual([doc])
    expect(store.groupCounts).toEqual(list.groupCounts)
    expect(store.keywordFacets).toEqual(list.keywords)
    expect(store.page).toBe(2)
  })
  it('selects the first library through URL and resets pagination on filter changes', async () => {
    const { store, router } = await mount()
    expect(router.currentRoute.value.query.agentId).toBe('1')
    store.turnPage(2)
    await tick()
    expect(store.page).toBe(2)
    store.search('fix')
    await tick()
    expect(store.page).toBe(1)
    expect(router.currentRoute.value.query.keyword).toBe('fix')
    expect(get).toHaveBeenLastCalledWith('/agents/1/experience-library/docs', { params: { page: 1, size: 20, sort: 'fileName', order: 'desc', groupBy: 'month', keyword: 'fix' } })
  })
  it('opens direct-linked documents after metadata loads and keeps file across non-URL index/create views', async () => {
    const { store, router } = await mount({ agentId: '1', file: doc.fileName })
    expect(store.viewer).toMatchObject({ kind: 'doc', meta: doc, initialMode: 'render' })
    const listCalls = () => get.mock.calls.filter(([url]) => url.endsWith('/docs')).length
    const initialCalls = listCalls()
    store.openDoc(doc.fileName, 'edit')
    expect(store.viewer?.initialMode).toBe('edit')
    await store.openIndex()
    expect(get).toHaveBeenLastCalledWith('/agents/1/experience-library/index')
    store.setTag('TS')
    await tick()
    expect(router.currentRoute.value.query.file).toBe(doc.fileName)
    expect(store.viewer?.kind).toBe('index')
    store.openDoc(doc.fileName)
    await tick()
    expect(store.viewer?.kind).toBe('doc')
    expect(listCalls()).toBe(initialCalls + 1)
    store.closeViewer()
    await tick()
    expect(router.currentRoute.value.query.file).toBeUndefined()
    expect(store.viewer).toBeNull()
  })
  it('ignores old-library responses when selection changes during a request', async () => {
    let resolveOld!: (value: unknown) => void
    get.mockImplementation((url: string) => {
      if (url === '/agents/1/experience-library/docs') return new Promise(resolve => { resolveOld = resolve })
      return Promise.resolve({ data: url.endsWith('/overview') ? overview : { ...list, docs: [{ ...doc, title: 'B' }] } })
    })
    const { store, router } = await mount({ agentId: '1' })
    await router.replace({ query: { agentId: '2' } })
    await tick()
    resolveOld({ data: list })
    await tick()
    expect(store.selectedAgentId).toBe(2)
    expect(store.docs[0].title).toBe('B')
    expect(store.listLoading).toBe(false)
  })
  it('requires overwrite confirmation even when the existing filename is not on the current page', async () => {
    const { store } = await mount({ agentId: '1' })
    confirm.mockRejectedValueOnce('cancel')
    expect(await store.saveDoc('off-page.md', '# new', false)).toBe(false)
    expect(get).toHaveBeenLastCalledWith('/agents/1/experience-library/docs/content', { params: { file: 'off-page.md' }, skipErrorToast: true })
    expect(put).not.toHaveBeenCalled()
  })
  it('does not interpret network failures as a missing file; accepts explicit not-found for creation', async () => {
    const { store } = await mount({ agentId: '1' })
    get.mockRejectedValueOnce(new Error('Network Error'))
    expect(await store.saveDoc('new.md', '# new', false)).toBe(false)
    expect(put).not.toHaveBeenCalled()
    get.mockRejectedValueOnce(new Error('经验文档不存在'))
    expect(await store.saveDoc('new.md', '# new', false)).toBe(true)
    expect(put).toHaveBeenCalledWith('/agents/1/experience-library/docs/content', { fileName: 'new.md', content: '# new' })
  })
  it('clears a missing direct-linked file without dropping list filters', async () => {
    get.mockImplementation(async (url: string) => {
      if (url.endsWith('/content')) throw new Error('经验文档不存在')
      return { data: url.endsWith('/overview') ? overview : list }
    })
    const { store, router } = await mount({ agentId: '1', file: 'missing.md', tag: 'TS' })
    expect(store.viewer).toBeNull()
    expect(router.currentRoute.value.query).toEqual({ agentId: '1', tag: 'TS' })
  })
})

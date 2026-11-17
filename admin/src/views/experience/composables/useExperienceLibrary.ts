import { onActivated, reactive, ref, watch, type InjectionKey } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import { api } from '../../../api'

export interface ExperienceDoc {
  fileName: string
  title: string
  keywords: string
  summary: string
  applicable: string
  lastVerified: string
  sizeBytes: number
  updatedAt: string
}
export interface LibraryOverviewEntry {
  agentId: number
  agentName: string
  enabled: boolean
  docCount: number
  totalBytes: number
  lastUpdatedAt: string
}
export interface OrphanEntry { agentId: number; docCount: number; totalBytes: number; lastUpdatedAt: string }
export interface KeywordFacet { tag: string; count: number }
export interface GroupCount { key: string; count: number }
export interface DocListResponse {
  enabled: boolean
  total: number
  page: number
  size: number
  docs: ExperienceDoc[]
  groupCounts: GroupCount[]
  keywords: KeywordFacet[]
}
export type SortField = 'fileName' | 'title' | 'updatedAt' | 'sizeBytes' | 'lastVerified'
export type SortOrder = 'asc' | 'desc'
export type GroupBy = 'none' | 'month' | 'keyword'
export type AbnormalFilter = '' | 'no-frontmatter' | 'no-title'
export interface ViewerPayload {
  kind: 'doc' | 'index' | 'create'
  fileName: string
  meta: ExperienceDoc | null
  content: string
  initialMode: 'render' | 'edit'
}
export const PAGE_SIZE = 20
interface QueryState {
  agentId: number | null
  file: string
  page: number
  keyword: string
  tag: string
  verifiedFrom: string
  verifiedTo: string
  updatedFrom: string
  updatedTo: string
  abnormal: AbnormalFilter
  sort: SortField
  order: SortOrder
  groupBy: GroupBy
}
type LocationQuery = ReturnType<typeof useRoute>['query']
function parseQuery(q: LocationQuery): QueryState {
  const str = (v: unknown) => typeof v === 'string' ? v : ''
  const int = (v: unknown, max: number) => {
    const n = Number(v)
    return Number.isSafeInteger(n) && n >= 1 && n <= max ? n : null
  }
  const enumOf = <T extends string>(v: unknown, allowed: readonly T[], fallback: T): T =>
    typeof v === 'string' && (allowed as readonly string[]).includes(v) ? v as T : fallback
  return {
    agentId: int(q.agentId, Number.MAX_SAFE_INTEGER), file: str(q.file), page: int(q.page, 1_000_000) ?? 1,
    keyword: str(q.keyword), tag: str(q.tag), verifiedFrom: str(q.verifiedFrom), verifiedTo: str(q.verifiedTo),
    updatedFrom: str(q.updatedFrom), updatedTo: str(q.updatedTo),
    abnormal: enumOf<AbnormalFilter>(q.abnormal, ['', 'no-frontmatter', 'no-title'], ''),
    sort: enumOf<SortField>(q.sort, ['fileName', 'title', 'updatedAt', 'sizeBytes', 'lastVerified'], 'fileName'),
    order: enumOf<SortOrder>(q.order, ['asc', 'desc'], 'desc'),
    groupBy: enumOf<GroupBy>(q.groupBy, ['none', 'month', 'keyword'], 'month'),
  }
}
function buildQuery(s: QueryState): Record<string, string> {
  const q: Record<string, string> = {}
  if (s.agentId != null) q.agentId = String(s.agentId)
  if (s.file) q.file = s.file
  if (s.page > 1) q.page = String(s.page)
  if (s.keyword.trim()) q.keyword = s.keyword.trim()
  for (const key of ['tag', 'verifiedFrom', 'verifiedTo', 'updatedFrom', 'updatedTo', 'abnormal'] as const) {
    if (s[key]) q[key] = s[key]
  }
  if (s.sort !== 'fileName') q.sort = s.sort
  if (s.order !== 'desc') q.order = s.order
  if (s.groupBy !== 'month') q.groupBy = s.groupBy
  return q
}

/** 上游独立页状态：URL 是筛选/分页/选中文档的唯一落地口，索引与新建草稿不入 URL。 */
export function useExperienceLibrary() {
  const route = useRoute()
  const router = useRouter()
  const state = reactive<QueryState>(parseQuery({}))
  const overviewLoading = ref(false)
  const libraries = ref<LibraryOverviewEntry[]>([])
  const orphans = ref<OrphanEntry[]>([])
  const enabled = ref(true)
  const docs = ref<ExperienceDoc[]>([])
  const total = ref(0)
  const groupCounts = ref<GroupCount[]>([])
  const keywordFacets = ref<KeywordFacet[]>([])
  const listLoading = ref(false)
  const viewer = ref<ViewerPayload | null>(null)
  const viewerLoading = ref(false)
  const rebuilding = ref(false)
  const toggling = ref(false)
  let pendingEditMode: 'render' | 'edit' = 'render'
  let listVersion = 0
  let viewerVersion = 0
  let queryVersion = 0

  function patchState(patch: Partial<QueryState>): void {
    const next = buildQuery({ ...state, ...patch })
    if (JSON.stringify(next) === JSON.stringify(buildQuery(parseQuery(route.query)))) return
    void router.replace({ query: next })
  }
  function clearDocs(): void {
    docs.value = []
    total.value = 0
    groupCounts.value = []
    keywordFacets.value = []
  }
  async function loadOverview(): Promise<void> {
    overviewLoading.value = true
    try {
      const { data } = await api.get<{ libraries: LibraryOverviewEntry[]; orphans: OrphanEntry[] }>(
        '/agents/experience-library/overview',
      )
      libraries.value = data.libraries
      orphans.value = data.orphans
      if (state.agentId == null && data.libraries.length > 0) patchState({ agentId: data.libraries[0].agentId })
    } catch {
      // 拦截器统一提示；不伪造跨库统计。
    } finally {
      overviewLoading.value = false
    }
  }
  async function loadDocs(): Promise<void> {
    const version = ++listVersion
    const agentId = state.agentId
    if (agentId == null) {
      clearDocs()
      enabled.value = true
      listLoading.value = false
      return
    }
    listLoading.value = true
    try {
      const { data } = await api.get<DocListResponse>(`/agents/${agentId}/experience-library/docs`, {
        params: {
          page: state.page, size: PAGE_SIZE, sort: state.sort, order: state.order, groupBy: state.groupBy,
          ...(state.keyword.trim() ? { keyword: state.keyword.trim() } : {}),
          ...(state.tag ? { tag: state.tag } : {}),
          ...(state.verifiedFrom ? { verifiedFrom: state.verifiedFrom } : {}),
          ...(state.verifiedTo ? { verifiedTo: state.verifiedTo } : {}),
          ...(state.updatedFrom ? { updatedFrom: state.updatedFrom } : {}),
          ...(state.updatedTo ? { updatedTo: state.updatedTo } : {}),
          ...(state.abnormal ? { abnormal: state.abnormal } : {}),
        },
      })
      if (version !== listVersion || agentId !== state.agentId) return
      enabled.value = data.enabled
      docs.value = data.docs
      total.value = data.total
      groupCounts.value = data.groupCounts
      keywordFacets.value = data.keywords
      // 删除最后一页最后一篇后返回有效页，避免空页卡住。
      const lastPage = Math.max(1, Math.ceil(data.total / PAGE_SIZE))
      if (state.page > lastPage) patchState({ page: lastPage })
    } catch {
      if (version === listVersion) clearDocs()
    } finally {
      if (version === listVersion) listLoading.value = false
    }
  }
  async function openDocContent(fileName: string): Promise<void> {
    const agentId = state.agentId
    if (agentId == null) return
    const version = ++viewerVersion
    const mode = pendingEditMode
    pendingEditMode = 'render'
    viewerLoading.value = true
    try {
      const { data } = await api.get<{ fileName: string; content: string }>(
        `/agents/${agentId}/experience-library/docs/content`, { params: { file: fileName } },
      )
      if (version !== viewerVersion || agentId !== state.agentId) return
      viewer.value = {
        kind: 'doc', fileName: data.fileName, content: data.content,
        meta: docs.value.find(doc => doc.fileName === fileName) ?? null, initialMode: mode,
      }
    } catch {
      if (version === viewerVersion && agentId === state.agentId) {
        viewer.value = null
        patchState({ file: '' })
      }
    } finally {
      if (version === viewerVersion) viewerLoading.value = false
    }
  }
  async function openIndex(): Promise<void> {
    const agentId = state.agentId
    if (agentId == null) return
    const version = ++viewerVersion
    viewerLoading.value = true
    try {
      const { data } = await api.get<{ fileName: string; content: string; docCount: number }>(
        `/agents/${agentId}/experience-library/index`,
      )
      if (version !== viewerVersion || agentId !== state.agentId) return
      viewer.value = { kind: 'index', fileName: data.fileName, content: data.content, meta: null, initialMode: 'render' }
    } catch {
      // 拦截器统一提示。
    } finally {
      if (version === viewerVersion) viewerLoading.value = false
    }
  }
  async function applyQuery(next: QueryState): Promise<void> {
    const version = ++queryVersion
    const agentChanged = next.agentId !== state.agentId
    const fileChanged = next.file !== state.file
    const { file: _prevFile, ...prevList } = state
    const { file: _nextFile, ...nextList } = next
    const listChanged = JSON.stringify(prevList) !== JSON.stringify(nextList)
    Object.assign(state, next)
    if (agentChanged || fileChanged) {
      ++viewerVersion
      viewerLoading.value = false
      viewer.value = null
    }
    if (agentChanged) clearDocs()
    if (listChanged) await loadDocs()
    if (version !== queryVersion) return
    if (next.file && (fileChanged || agentChanged)) await openDocContent(next.file)
  }
  watch(() => route.query, q => {
    if (route.name === 'ExperienceLibrary') void applyQuery(parseQuery(q))
  }, { immediate: true })
  void loadOverview()
  let firstActivation = true
  onActivated(() => {
    if (firstActivation) { firstActivation = false; return }
    void loadOverview()
    void loadDocs()
  })

  const store = reactive({
    overviewLoading, libraries, orphans, enabled, docs, total, groupCounts, keywordFacets, listLoading,
    viewer, viewerLoading, rebuilding, toggling, pageSize: PAGE_SIZE,
    get selectedAgentId() { return state.agentId },
    get page() { return state.page },
    get keyword() { return state.keyword },
    get tag() { return state.tag },
    get sort() { return state.sort },
    get order() { return state.order },
    get groupBy() { return state.groupBy },
    get abnormal() { return state.abnormal },
    get verifiedRange(): [string, string] | null {
      return state.verifiedFrom || state.verifiedTo ? [state.verifiedFrom, state.verifiedTo] : null
    },
    get updatedRange(): [string, string] | null {
      return state.updatedFrom || state.updatedTo ? [state.updatedFrom, state.updatedTo] : null
    },
    selectAgent(agentId: number) { patchState({ agentId, page: 1, file: '' }) },
    search(keyword: string) { patchState({ keyword, page: 1 }) },
    setTag(tag: string) { patchState({ tag, page: 1 }) },
    setVerifiedRange(range: [string, string] | null) {
      patchState({ verifiedFrom: range?.[0] ?? '', verifiedTo: range?.[1] ?? '', page: 1 })
    },
    setUpdatedRange(range: [string, string] | null) {
      patchState({ updatedFrom: range?.[0] ?? '', updatedTo: range?.[1] ?? '', page: 1 })
    },
    setAbnormal(abnormal: AbnormalFilter) { patchState({ abnormal, page: 1 }) },
    setSort(sort: SortField) { patchState({ sort, page: 1 }) },
    toggleOrder() { patchState({ order: state.order === 'desc' ? 'asc' : 'desc', page: 1 }) },
    setGroupBy(groupBy: GroupBy) { patchState({ groupBy }) },
    turnPage(page: number) { patchState({ page }) },
    resetFilters() { patchState({ ...parseQuery({}), agentId: state.agentId, file: state.file }) },
    openDoc(fileName: string, mode: 'render' | 'edit' = 'render') {
      if (viewer.value?.kind === 'doc' && viewer.value.fileName === fileName) {
        viewer.value = { ...viewer.value, initialMode: mode }
        return
      }
      pendingEditMode = mode
      if (state.file === fileName) void openDocContent(fileName)
      else patchState({ file: fileName })
    },
    openIndex,
    openCreate() {
      ++viewerVersion
      viewerLoading.value = false
      const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' })
      viewer.value = {
        kind: 'create', fileName: '', meta: null, initialMode: 'edit',
        content: `---\ntitle: \nkeywords: \nsummary: \napplicable: \nlast_verified: ${today}\n---\n\n`,
      }
    },
    closeViewer() {
      ++viewerVersion
      viewerLoading.value = false
      viewer.value = null
      patchState({ file: '' })
    },
    async saveDoc(fileName: string, content: string, existing: boolean): Promise<boolean> {
      const agentId = state.agentId
      if (agentId == null) return false
      if (!existing) {
        let exists = false
        try {
          await api.get(`/agents/${agentId}/experience-library/docs/content`, {
            params: { file: fileName }, skipErrorToast: true,
          })
          exists = true
        } catch (error) {
          // 仅明确「不存在」才允许新建；网络/鉴权失败不能当作不存在而静默覆盖。
          const e = error as { response?: { data?: { message?: string }; status?: number }; message?: string }
          if (e.response?.status !== 404 && !(e.response?.data?.message ?? e.message ?? '').includes('经验文档不存在')) return false
        }
        if (exists) {
          try {
            await ElMessageBox.confirm(`文件「${fileName}」已存在，保存将覆盖原文档且不可恢复，确定继续吗？`, '覆盖确认', { type: 'warning' })
          } catch { return false }
        }
      }
      try {
        await api.put(`/agents/${agentId}/experience-library/docs/content`, { fileName, content })
      } catch { return false }
      ElMessage.success('已保存')
      if (agentId !== state.agentId) return true
      await Promise.all([loadDocs(), loadOverview()])
      if (agentId !== state.agentId) return true
      if (existing && viewer.value?.fileName === fileName) await openDocContent(fileName)
      else if (!existing) {
        if (state.file === fileName) await openDocContent(fileName)
        else patchState({ file: fileName })
      }
      return true
    },
    async deleteDoc(doc: ExperienceDoc) {
      const agentId = state.agentId
      if (agentId == null) return
      try {
        await ElMessageBox.confirm(`确定删除「${doc.title || doc.fileName}」吗？该操作不可恢复。`, '删除经验', { type: 'warning' })
      } catch { return }
      try {
        await api.delete(`/agents/${agentId}/experience-library/docs`, { params: { file: doc.fileName } })
        ElMessage.success('已删除')
        if (agentId !== state.agentId) return
        if (state.file === doc.fileName) store.closeViewer()
        await Promise.all([loadDocs(), loadOverview()])
      } catch { /* 拦截器统一提示 */ }
    },
    async rebuildIndex() {
      const agentId = state.agentId
      if (agentId == null) return
      rebuilding.value = true
      try {
        await api.post(`/agents/${agentId}/experience-library/index/rebuild`)
        ElMessage.success('索引已重建')
        if (agentId === state.agentId && viewer.value?.kind === 'index') await openIndex()
      } catch { /* 拦截器统一提示 */ }
      finally { rebuilding.value = false }
    },
    async toggleEnabled(next: boolean) {
      const agentId = state.agentId
      if (agentId == null) return
      toggling.value = true
      try {
        const { data } = await api.patch<{ enabled: boolean }>(`/agents/${agentId}/experience-library`, { enabled: next })
        if (agentId === state.agentId) enabled.value = data.enabled
        const lib = libraries.value.find(item => item.agentId === agentId)
        if (lib) lib.enabled = data.enabled
        ElMessage.success(data.enabled ? '已启用团队经验库' : '已停用团队经验库')
      } catch { /* 受控开关失败不变 */ }
      finally { toggling.value = false }
    },
    reloadAll() { void loadOverview(); void loadDocs() },
  })
  return store
}
export type ExperienceLibraryStore = ReturnType<typeof useExperienceLibrary>
export const EXPERIENCE_LIBRARY_KEY: InjectionKey<ExperienceLibraryStore> = Symbol('experience-library')

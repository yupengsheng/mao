import { computed, nextTick, ref, type Ref } from 'vue'
import type { Editor } from '@tiptap/core'
import { TextSelection } from '@tiptap/pm/state'
import { api } from '../api'
import { pickPanelPlacement } from '../utils/panel-placement'
import type { QuickCommand, QuickCommandsData } from '../types/quick-command'
import type { WorkspaceFile } from '../components/chat/FileReferencePanel.vue'

export interface EditorPanelHandle {
  moveUp(): void
  moveDown(): void
  confirmSelection(): void
}

export interface EditorTagPanelContext {
  executionMode: string
  workspace?: string
  sessionId?: string | null
  cloudProjectKey?: string | null
}

export interface EditorTagPanelsOptions {
  editorRef: Ref<Editor | undefined>
  quickCommandPanelRef: Ref<EditorPanelHandle | undefined>
  fileReferencePanelRef: Ref<EditorPanelHandle | undefined>
  getContext: () => EditorTagPanelContext
  slashTriggers?: string[]
  autoComplete?: boolean
  onEnter?: () => boolean | void
  onEscape?: () => void
  anchorEl?: () => HTMLElement | null
}

export function useEditorTagPanels(opts: EditorTagPanelsOptions) {
  const slashTriggers = opts.slashTriggers ?? ['/', '、']
  const autoComplete = opts.autoComplete ?? false
  const quickCommands = ref<QuickCommandsData>({ skills: [], commands: [] })
  const commandsLoaded = ref(false)
  const localSkillItems = ref<QuickCommand[]>([])
  const panelSkills = computed(() => {
    const uploaded = quickCommands.value.skills
    if (!localSkillItems.value.length) return uploaded
    const names = new Set(uploaded.map(item => item.name))
    return [...uploaded, ...localSkillItems.value.filter(item => !names.has(item.name))]
  })
  const commandPanelVisible = ref(false)
  const commandPanelFilter = ref('')
  const commandPanelPlacement = ref<'top' | 'bottom'>('top')
  const slashRange = ref<{ from: number; to: number } | null>(null)
  const panelAutoOpened = ref(false)
  const filePanelVisible = ref(false)
  const filePanelFilter = ref('')
  const filePanelLoading = ref(false)
  const fileListError = ref(false)
  const workspaceFiles = ref<WorkspaceFile[]>([])
  const filePanelPlacement = ref<'top' | 'bottom'>('top')
  const atRange = ref<{ from: number; to: number } | null>(null)
  let fileSearchDebounce: ReturnType<typeof setTimeout> | null = null
  let fetchFilesSeq = 0
  let dismissedWord = ''
  let currentFilterWord = ''
  let userNavigatedPanel = false
  const isElectronClient = typeof window !== 'undefined' && !!(window as any).electronAPI

  function updatePlacement(kind: 'command' | 'file') {
    const anchor = opts.anchorEl?.()
    if (!anchor) return
    nextTick(() => {
      const placement = pickPanelPlacement(anchor)
      if (kind === 'command') commandPanelPlacement.value = placement
      else filePanelPlacement.value = placement
    })
  }

  async function ensureLocalSkillsLoaded() {
    if (opts.getContext().executionMode !== 'LOCAL' || !isElectronClient) {
      localSkillItems.value = []
      return
    }
    try {
      const result = await (window as any).electronAPI.listLocalSkills()
      localSkillItems.value = (result?.skills || []).map((item: any) => ({
        type: 'skill' as const,
        name: item.name,
        description: item.description ? `${item.description}（本地未上传，仅本次本地任务可用）` : '本地未上传，仅本次本地任务可用',
      }))
    } catch {
      localSkillItems.value = []
    }
  }

  async function ensureCommandsLoaded() {
    try {
      const { data } = await api.get('/quick-commands')
      quickCommands.value = data || { skills: [], commands: [] }
    } catch {
      // 请求失败由面板的空态承接，且必须记为已加载，避免每次输入重复请求。
    } finally {
      commandsLoaded.value = true
    }
    await ensureLocalSkillsLoaded()
  }

  function closePanel() {
    commandPanelVisible.value = false
    commandPanelFilter.value = ''
    slashRange.value = null
    panelAutoOpened.value = false
  }

  function closeFilePanel() {
    filePanelVisible.value = false
    filePanelFilter.value = ''
    atRange.value = null
    workspaceFiles.value = []
    if (fileSearchDebounce) {
      clearTimeout(fileSearchDebounce)
      fileSearchDebounce = null
    }
  }

  function handleCommandSelect(item: QuickCommand) {
    const ed = opts.editorRef.value
    const range = slashRange.value
    if (!ed || !range) return
    const { state, dispatch } = ed.view
    const nodeType = state.schema.nodes.quickCommand
    if (!nodeType) return
    const node = nodeType.create({ commandType: item.type, commandName: item.name })
    let tr = state.tr.delete(range.from, range.to).insert(range.from, node)
    tr = tr.insert(range.from + node.nodeSize, state.schema.text(' '))
    tr = tr.setSelection(TextSelection.near(tr.doc.resolve(range.from + node.nodeSize + 1)))
    dispatch(tr)
    ed.commands.focus()
    closePanel()
  }

  function handleFileReferenceSelect(file: WorkspaceFile) {
    const ed = opts.editorRef.value
    const range = atRange.value
    if (!ed || !range) return
    const { state, dispatch } = ed.view
    const nodeType = state.schema.nodes.fileReference
    if (!nodeType) return
    const node = nodeType.create({ filePath: file.path })
    let tr = state.tr.delete(range.from, range.to).insert(range.from, node)
    tr = tr.insert(range.from + node.nodeSize, state.schema.text(' '))
    tr = tr.setSelection(TextSelection.near(tr.doc.resolve(range.from + node.nodeSize + 1)))
    dispatch(tr)
    ed.commands.focus()
    closeFilePanel()
  }

  async function fetchWorkspaceFiles(filter: string) {
    const seq = ++fetchFilesSeq
    filePanelLoading.value = true
    try {
      const context = opts.getContext()
      if (context.executionMode === 'LOCAL' && isElectronClient && context.workspace) {
        const result = await (window as any).electronAPI.listWorkspaceFiles(context.workspace, filter || undefined, 20)
        if (seq !== fetchFilesSeq) return
        workspaceFiles.value = result || []
        fileListError.value = false
      } else if (context.sessionId) {
        const { data } = await api.get('/files/workspace-list', { params: { sessionId: context.sessionId, filter: filter || undefined, limit: 20 } })
        if (seq !== fetchFilesSeq) return
        workspaceFiles.value = data?.files || []
        fileListError.value = false
      } else if (context.cloudProjectKey) {
        const { data } = await api.get('/files/project-list', { params: { projectKey: context.cloudProjectKey, filter: filter || undefined, limit: 20 } })
        if (seq !== fetchFilesSeq) return
        workspaceFiles.value = data?.files || []
        fileListError.value = false
      } else {
        if (seq !== fetchFilesSeq) return
        workspaceFiles.value = []
        fileListError.value = false
      }
    } catch {
      if (seq !== fetchFilesSeq) return
      fileListError.value = true
      workspaceFiles.value = []
    } finally {
      if (seq === fetchFilesSeq) filePanelLoading.value = false
    }
  }

  function retryFileFetch() {
    void fetchWorkspaceFiles(filePanelFilter.value)
  }

  function detectSlashTrigger() {
    const ed = opts.editorRef.value
    if (!ed) return
    const { state } = ed.view
    const { from } = state.selection
    const before = state.doc.textBetween(Math.max(0, from - 50), from, '\n', '\n')
    let trigger = -1
    for (const char of slashTriggers) trigger = Math.max(trigger, before.lastIndexOf(char))
    if (trigger < 0 || (trigger > 0 && !/\s/.test(before[trigger - 1]))) {
      if (commandPanelVisible.value) closePanel()
      return
    }
    const filter = before.substring(trigger + 1)
    if (/\s/.test(filter)) {
      if (commandPanelVisible.value) closePanel()
      return
    }
    slashRange.value = { from: from - (before.length - trigger), to: from }
    commandPanelFilter.value = filter
    if (!commandPanelVisible.value) {
      void ensureCommandsLoaded()
      commandPanelVisible.value = true
      userNavigatedPanel = true
      updatePlacement('command')
    }
  }

  function detectAtTrigger() {
    const ed = opts.editorRef.value
    if (!ed) return
    const { state } = ed.view
    const { from } = state.selection
    const before = state.doc.textBetween(Math.max(0, from - 50), from, '\n', '\n')
    const trigger = before.lastIndexOf('@')
    if (trigger < 0 || (trigger > 0 && !/\s/.test(before[trigger - 1]))) {
      if (filePanelVisible.value) closeFilePanel()
      return
    }
    const filter = before.substring(trigger + 1)
    if (/\s/.test(filter)) {
      if (filePanelVisible.value) closeFilePanel()
      return
    }
    atRange.value = { from: from - (before.length - trigger), to: from }
    filePanelFilter.value = filter
    if (!filePanelVisible.value) {
      filePanelVisible.value = true
      void fetchWorkspaceFiles(filter)
      updatePlacement('file')
    } else {
      if (fileSearchDebounce) clearTimeout(fileSearchDebounce)
      fileSearchDebounce = setTimeout(() => void fetchWorkspaceFiles(filter), 300)
    }
  }

  function detectAutoComplete() {
    const ed = opts.editorRef.value
    if (!ed || !autoComplete || (commandPanelVisible.value && !panelAutoOpened.value) || filePanelVisible.value) return
    if (!commandsLoaded.value) {
      void ensureCommandsLoaded().then(() => detectAutoComplete())
      return
    }
    const { state } = ed.view
    const { from } = state.selection
    const before = state.doc.textBetween(Math.max(0, from - 50), from, '\n', '\n')
    const word = before.split(/\s/).pop() ?? ''
    const lower = word.toLowerCase()
    if (lower !== currentFilterWord) {
      dismissedWord = ''
      userNavigatedPanel = false
    }
    currentFilterWord = lower
    if (word.length < 2) {
      if (commandPanelVisible.value && panelAutoOpened.value) closePanel()
      return
    }
    if (!slashTriggers.some(trigger => word.startsWith(trigger)) && (/^(https?|ftp|file):\/\//i.test(word) || /[/.@:\\]/.test(word))) {
      if (commandPanelVisible.value && panelAutoOpened.value) closePanel()
      return
    }
    const all = [...panelSkills.value, ...quickCommands.value.commands]
    const matched = all.filter(item => item.name.toLowerCase().startsWith(lower))
    if (!matched.length || lower === dismissedWord) {
      if (commandPanelVisible.value && panelAutoOpened.value) closePanel()
      return
    }
    slashRange.value = { from: from - word.length, to: from }
    commandPanelFilter.value = word
    panelAutoOpened.value = true
    if (!commandPanelVisible.value) {
      void ensureCommandsLoaded()
      commandPanelVisible.value = true
      userNavigatedPanel = false
      updatePlacement('command')
    }
  }

  function handleEditorUpdate() {
    detectSlashTrigger()
    detectAtTrigger()
    detectAutoComplete()
  }

  function handleEditorKeyDown(_view: unknown, event: KeyboardEvent): boolean {
    const composing = event.isComposing || event.keyCode === 229
    if (filePanelVisible.value) {
      if (event.key === 'ArrowUp') { event.preventDefault(); opts.fileReferencePanelRef.value?.moveUp(); return true }
      if (event.key === 'ArrowDown') { event.preventDefault(); opts.fileReferencePanelRef.value?.moveDown(); return true }
      if (event.key === 'Enter' && !event.ctrlKey && !event.metaKey) {
        if (composing) return false
        event.preventDefault(); opts.fileReferencePanelRef.value?.confirmSelection(); return true
      }
      if (event.key === 'Escape') { event.preventDefault(); closeFilePanel(); return true }
    }
    if (commandPanelVisible.value) {
      if (event.key === 'ArrowUp') { event.preventDefault(); userNavigatedPanel = true; opts.quickCommandPanelRef.value?.moveUp(); return true }
      if (event.key === 'ArrowDown') { event.preventDefault(); userNavigatedPanel = true; opts.quickCommandPanelRef.value?.moveDown(); return true }
      if (event.key === 'Enter' && !event.ctrlKey && !event.metaKey) {
        if (composing) return false
        if (!userNavigatedPanel) {
          if (panelAutoOpened.value) dismissedWord = currentFilterWord
          closePanel()
          if (!opts.onEnter) return false
          if (opts.onEnter() === false) return false
          event.preventDefault()
          return true
        }
        event.preventDefault(); opts.quickCommandPanelRef.value?.confirmSelection(); return true
      }
      if (event.key === 'Escape') {
        event.preventDefault()
        if (panelAutoOpened.value) dismissedWord = currentFilterWord
        closePanel()
        return true
      }
    }
    if (event.key === 'Escape' && !composing && opts.onEscape) {
      opts.onEscape()
      return true
    }
    return false
  }

  function closeAll() {
    closePanel()
    closeFilePanel()
  }

  return {
    quickCommands, panelSkills, commandPanelVisible, commandPanelFilter, commandPanelPlacement,
    handleCommandSelect, closePanel,
    filePanelVisible, filePanelFilter, filePanelLoading, fileListError, workspaceFiles, filePanelPlacement,
    handleFileReferenceSelect, closeFilePanel, retryFileFetch,
    handleEditorKeyDown, handleEditorUpdate, closeAll,
  }
}

export type EditorTagPanels = ReturnType<typeof useEditorTagPanels>

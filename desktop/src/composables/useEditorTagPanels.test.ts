/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Editor } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import { ref, shallowRef } from 'vue'
import { QuickCommandNode } from '../components/chat/tiptap/QuickCommandNode'
import { FileReferenceNode } from '../components/chat/tiptap/FileReferenceNode'
import { useEditorTagPanels, type EditorPanelHandle, type EditorTagPanelContext } from './useEditorTagPanels'
import { api } from '../api'

vi.mock('../api', () => ({ api: { get: vi.fn() } }))

const extensions = [StarterKit.configure({
  heading: false, codeBlock: false, blockquote: false, horizontalRule: false,
  bulletList: false, orderedList: false, listItem: false,
  code: false, bold: false, italic: false, strike: false,
}), QuickCommandNode, FileReferenceNode]

function makeEditor(): Editor {
  return new Editor({ extensions, content: '<p></p>' })
}
function typeText(editor: Editor, text: string) {
  editor.commands.setContent(`<p>${text}</p>`)
  editor.commands.setTextSelection(editor.state.doc.content.size - 1)
}
function handle() {
  return { moveUp: vi.fn(), moveDown: vi.fn(), confirmSelection: vi.fn() }
}
function key(key: string, extra: Record<string, unknown> = {}) {
  const event = new KeyboardEvent('keydown', { key, bubbles: true })
  for (const [name, value] of Object.entries(extra)) Object.defineProperty(event, name, { value })
  return event
}
async function flush() {
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve()
}

let editor: Editor | null = null
afterEach(() => {
  editor?.destroy(); editor = null
  vi.restoreAllMocks()
  delete (window as any).electronAPI
})
beforeEach(() => vi.mocked(api.get).mockReset())

function makePanels(context: EditorTagPanelContext = { executionMode: 'CLOUD', sessionId: 's1' }) {
  editor = makeEditor()
  const quick = handle()
  const files = handle()
  return {
    panels: useEditorTagPanels({
      editorRef: shallowRef(editor),
      quickCommandPanelRef: ref<EditorPanelHandle | undefined>(quick),
      fileReferencePanelRef: ref<EditorPanelHandle | undefined>(files),
      getContext: () => context,
      slashTriggers: ['/'],
    }),
    quick,
    files,
  }
}

describe('useEditorTagPanels slash and insertion', () => {
  it('opens only on a standalone slash and confirms a command chip', () => {
    const { panels, quick } = makePanels()
    typeText(editor!, '/ta'); panels.handleEditorUpdate()
    expect(panels.commandPanelVisible.value).toBe(true)
    expect(panels.commandPanelFilter.value).toBe('ta')
    expect(panels.handleEditorKeyDown(null, key('Enter'))).toBe(true)
    expect(quick.confirmSelection).toHaveBeenCalled()

    panels.handleCommandSelect({ type: 'skill', name: 'deploy', description: '' })
    expect(editor!.getText()).toContain('${deploy}$')
    typeText(editor!, 'a/b'); panels.handleEditorUpdate()
    expect(panels.commandPanelVisible.value).toBe(false)
  })

  it('does not treat the Chinese comma as a trigger when configured for edit mode', () => {
    const { panels } = makePanels()
    typeText(editor!, '、skill'); panels.handleEditorUpdate()
    expect(panels.commandPanelVisible.value).toBe(false)
  })
})

describe('useEditorTagPanels file references', () => {
  it('shows a file fetch error and supports retry after a rejected request', async () => {
    vi.mocked(api.get).mockRejectedValueOnce(new Error('offline'))
    const { panels } = makePanels()
    typeText(editor!, '@'); panels.handleEditorUpdate()
    await vi.waitFor(() => expect(panels.filePanelLoading.value).toBe(false))
    expect(panels.fileListError.value).toBe(true)
    expect(panels.workspaceFiles.value).toEqual([])
    vi.mocked(api.get).mockResolvedValueOnce({ data: { files: [{ path: 'retry.ts', name: 'retry.ts', size: 1 }] } })
    panels.retryFileFetch()
    await vi.waitFor(() => expect(panels.workspaceFiles.value).toHaveLength(1))
    expect(panels.fileListError.value).toBe(false)
  })

  it('loads cloud files by session and inserts a file chip', async () => {
    vi.mocked(api.get).mockResolvedValue({ data: { files: [{ path: 'src/a.ts', name: 'a.ts', size: 1 }] } })
    const { panels } = makePanels()
    typeText(editor!, '@src'); panels.handleEditorUpdate(); await flush()
    expect(api.get).toHaveBeenCalledWith('/files/workspace-list', expect.objectContaining({ params: expect.objectContaining({ sessionId: 's1', filter: 'src' }) }))
    expect(panels.workspaceFiles.value).toHaveLength(1)
    panels.handleFileReferenceSelect(panels.workspaceFiles.value[0])
    expect(editor!.getText()).toContain('@{src/a.ts}@')
    expect(panels.filePanelVisible.value).toBe(false)
  })

  it('keeps LOCAL file enumeration in Electron and does not call the API', async () => {
    const listWorkspaceFiles = vi.fn(async () => [{ path: 'a.ts', name: 'a.ts', size: 1 }])
    ;(window as any).electronAPI = { listWorkspaceFiles }
    const { panels } = makePanels({ executionMode: 'LOCAL', workspace: '/ws', sessionId: 's1' })
    typeText(editor!, '@'); panels.handleEditorUpdate(); await flush()
    expect(listWorkspaceFiles).toHaveBeenCalledWith('/ws', undefined, 20)
    expect(api.get).not.toHaveBeenCalled()
  })

  it('protects the newest file result from an older response', async () => {
    vi.useFakeTimers()
    try {
      let resolveSlow: (value: unknown) => void = () => {}
      const slow = new Promise(resolve => { resolveSlow = resolve })
      let calls = 0
      vi.mocked(api.get).mockImplementation(() => {
        calls += 1
        return (calls === 1 ? slow : Promise.resolve({ data: { files: [{ path: 'fast.ts', name: 'fast.ts', size: 1 }] } })) as never
      })
      const { panels } = makePanels()
      typeText(editor!, '@'); panels.handleEditorUpdate()
      typeText(editor!, '@a'); panels.handleEditorUpdate()
      vi.advanceTimersByTime(300)
      await vi.runAllTimersAsync()
      expect(calls).toBe(2)
      expect(panels.workspaceFiles.value.map(file => file.path)).toEqual(['fast.ts'])
      resolveSlow({ data: { files: [{ path: 'slow.ts', name: 'slow.ts', size: 1 }] } })
      await flush()
      expect(panels.workspaceFiles.value.map(file => file.path)).toEqual(['fast.ts'])
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('useEditorTagPanels keyboard layering', () => {
  it('routes navigation and escape to the active panel, then to edit cancellation', () => {
    const onEscape = vi.fn()
    editor = makeEditor()
    const quick = handle(); const files = handle()
    const panels = useEditorTagPanels({
      editorRef: shallowRef(editor), quickCommandPanelRef: ref(quick), fileReferencePanelRef: ref(files),
      getContext: () => ({ executionMode: 'CLOUD', sessionId: 's1' }), slashTriggers: ['/'], onEscape,
    })
    typeText(editor, '/'); panels.handleEditorUpdate()
    expect(panels.handleEditorKeyDown(null, key('ArrowDown'))).toBe(true)
    expect(quick.moveDown).toHaveBeenCalled()
    expect(panels.handleEditorKeyDown(null, key('Escape'))).toBe(true)
    expect(panels.commandPanelVisible.value).toBe(false)
    expect(panels.handleEditorKeyDown(null, key('Escape'))).toBe(true)
    expect(onEscape).toHaveBeenCalledTimes(1)
    expect(panels.handleEditorKeyDown(null, key('Enter'))).toBe(false)
  })

  it('does not consume Enter during IME composition', () => {
    const { panels } = makePanels()
    typeText(editor!, '/'); panels.handleEditorUpdate()
    expect(panels.handleEditorKeyDown(null, key('Enter', { isComposing: true }))).toBe(false)
    expect(panels.handleEditorKeyDown(null, key('Enter', { keyCode: 229 }))).toBe(false)
  })
})

describe('useEditorTagPanels auto completion', () => {
  it('dismisses the same word after escape and reopens after a word change', async () => {
    vi.mocked(api.get).mockResolvedValue({ data: { skills: [{ type: 'skill', name: 'skill-one', description: '' }], commands: [] } })
    editor = makeEditor()
    const panels = useEditorTagPanels({
      editorRef: shallowRef(editor), quickCommandPanelRef: ref(handle()), fileReferencePanelRef: ref(handle()),
      getContext: () => ({ executionMode: 'CLOUD', sessionId: 's1' }), autoComplete: true,
    })
    typeText(editor, 'sk'); panels.handleEditorUpdate()
    await vi.waitFor(() => expect(panels.commandPanelVisible.value).toBe(true))
    panels.handleEditorKeyDown(null, key('Escape'))
    typeText(editor, 'sk'); panels.handleEditorUpdate(); await flush()
    expect(panels.commandPanelVisible.value).toBe(false)
    typeText(editor, 'skill'); panels.handleEditorUpdate()
    await vi.waitFor(() => expect(panels.commandPanelVisible.value).toBe(true))
  })
})

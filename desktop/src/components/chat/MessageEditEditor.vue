<template>
  <div ref="wrapRef" class="message-edit-editor-wrap">
    <QuickCommandPanel
      ref="quickCommandPanelRef"
      :visible="commandPanelVisible"
      :skills="panelSkills"
      :commands="quickCommands.commands"
      :filter="commandPanelFilter"
      :placement="commandPanelPlacement"
      @select="handleCommandSelect"
      @close="closePanel"
    />
    <FileReferencePanel
      ref="fileReferencePanelRef"
      :visible="filePanelVisible"
      :files="workspaceFiles"
      :filter="filePanelFilter"
      :loading="filePanelLoading"
      :load-error="fileListError"
      :placement="filePanelPlacement"
      @select="handleFileReferenceSelect"
      @close="closeFilePanel"
      @retry="retryFileFetch"
    />
    <EditorContent class="rich-editor" :editor="editor" />
  </div>
</template>

<script setup lang="ts">
import { onBeforeUnmount, ref } from 'vue'
import { EditorContent, useEditor } from '@tiptap/vue-3'
import StarterKit from '@tiptap/starter-kit'
import { QuickCommandNode } from './tiptap/QuickCommandNode'
import { FileReferenceNode } from './tiptap/FileReferenceNode'
import { markedTextToEditorHtml } from '../../utils/editor-tags'
import QuickCommandPanel from './QuickCommandPanel.vue'
import FileReferencePanel from './FileReferencePanel.vue'
import { useEditorTagPanels, type EditorPanelHandle } from '../../composables/useEditorTagPanels'
import { useSessionStore } from '../../stores/session'

const props = defineProps<{
  modelValue: string
  /** 消息所属会话，用于保持编辑态文件引用的 LOCAL/CLOUD 边界。 */
  sessionId?: string
}>()

const emit = defineEmits<{
  'update:modelValue': [text: string]
  confirm: []
  cancel: []
}>()

const sessionStore = useSessionStore()
const wrapRef = ref<HTMLElement | null>(null)
const quickCommandPanelRef = ref<EditorPanelHandle>()
const fileReferencePanelRef = ref<EditorPanelHandle>()

const editor = useEditor({
  editable: true,
  extensions: [
    StarterKit.configure({
      heading: false,
      codeBlock: false,
      blockquote: false,
      horizontalRule: false,
      bulletList: false,
      orderedList: false,
      listItem: false,
      code: false,
      bold: false,
      italic: false,
      strike: false,
    }),
    QuickCommandNode,
    FileReferenceNode,
  ],
  content: `<p>${markedTextToEditorHtml(props.modelValue)}</p>`,
  editorProps: {
    handleKeyDown: (_view, event) => {
      if (panels.handleEditorKeyDown(_view, event)) return true
      if (event.isComposing || event.keyCode === 229) return false
      if (event.key === 'Escape') {
        emit('cancel')
        return true
      }
      if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
        emit('confirm')
        return true
      }
      return false
    },
  },
  onUpdate: ({ editor: ed }) => {
    emit('update:modelValue', ed.getText({ blockSeparator: '\n' }))
    panels.handleEditorUpdate()
  },
})

const panels = useEditorTagPanels({
  editorRef: editor,
  quickCommandPanelRef,
  fileReferencePanelRef,
  getContext: () => {
    const session = props.sessionId ? sessionStore.sessionEntities.get(props.sessionId) ?? null : null
    return {
      executionMode: session?.executionMode ?? 'CLOUD',
      workspace: session?.workspace,
      sessionId: props.sessionId ?? null,
    }
  },
  slashTriggers: ['/'],
  autoComplete: false,
  onEscape: () => emit('cancel'),
  anchorEl: () => wrapRef.value,
})

const {
  quickCommands,
  panelSkills,
  commandPanelVisible,
  commandPanelFilter,
  commandPanelPlacement,
  handleCommandSelect,
  closePanel,
  filePanelVisible,
  filePanelFilter,
  filePanelLoading,
  fileListError,
  workspaceFiles,
  filePanelPlacement,
  handleFileReferenceSelect,
  closeFilePanel,
  retryFileFetch,
} = panels

function focus() {
  editor.value?.commands.focus('end')
}

function selectAll() {
  editor.value?.commands.selectAll()
}

onBeforeUnmount(() => {
  panels.closeAll()
  editor.value?.destroy()
})

defineExpose({ focus, selectAll })
</script>

<style src="./chat-input.css"></style>

<style scoped>
.message-edit-editor-wrap {
  position: relative;
  width: 100%;
  min-height: 60px;
  padding: 8px 12px;
  border: 1px solid var(--aw-primary);
  border-radius: var(--aw-radius-sm);
  background: var(--aw-surface);
  color: var(--aw-ink);
  font-size: var(--aw-text-caption);
  line-height: 1.6;
  outline: none;
  transition: border-color 0.15s;
  box-sizing: border-box;
}

.message-edit-editor-wrap:focus-within {
  border-color: var(--aw-primary-focus);
}
</style>
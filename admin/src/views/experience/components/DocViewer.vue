<template>
  <section class="doc-viewer">
    <div class="viewer-toolbar">
      <el-button size="small" aria-label="返回列表" @click="store.closeViewer()"><el-icon><Back /></el-icon>返回列表</el-button>
      <div class="viewer-title" :title="titleText">{{ titleText }}</div>
      <div class="viewer-actions">
        <el-button v-if="payload.kind === 'doc'" size="small" @click="store.openIndex()">索引</el-button>
        <template v-if="mode !== 'edit'">
          <el-button size="small" :type="mode === 'render' ? 'primary' : 'default'" @click="mode = 'render'">渲染态</el-button>
          <el-button size="small" :type="mode === 'source' ? 'primary' : 'default'" @click="mode = 'source'">源码态</el-button>
          <el-button v-if="payload.kind === 'doc' && canWrite" size="small" @click="startEdit">编辑</el-button>
        </template>
      </div>
    </div>
    <div v-if="store.viewerLoading" v-loading="true" class="viewer-loading" element-loading-text="加载中" />
    <div v-else class="viewer-body">
      <div v-if="payload.kind === 'doc' && payload.meta" class="meta-card">
        <div class="meta-row"><span class="meta-label">文件名</span><span>{{ payload.fileName }}</span></div>
        <div v-if="payload.meta.summary" class="meta-row"><span class="meta-label">摘要</span><span>{{ payload.meta.summary }}</span></div>
        <div v-if="payload.meta.applicable" class="meta-row"><span class="meta-label">适用</span><span>{{ payload.meta.applicable }}</span></div>
        <div class="meta-row">
          <span class="meta-label">关键词</span>
          <span class="meta-tags"><template v-if="tags.length > 0">
            <el-tag v-for="t in tags" :key="t" size="small" @click="store.setTag(t)">{{ t }}</el-tag>
          </template><span v-else>—</span></span>
        </div>
        <div class="meta-row"><span class="meta-label">最后验证</span><span>
          {{ payload.meta.lastVerified || '—' }} <el-tag v-if="staleVerified" size="small" type="info">久未验证</el-tag>
        </span></div>
        <div class="meta-row"><span class="meta-label">更新</span><span>{{ formatDateTime(payload.meta.updatedAt) }} · {{ formatSize(payload.meta.sizeBytes) }}</span></div>
      </div>
      <div v-else-if="payload.kind === 'index'" class="meta-card">
        INDEX.md 由系统自动生成，请勿手改；共 {{ indexDocCount }} 篇记录。Agent 按「文件名 | 标题 | 关键词 | 摘要 | 验证日期」一行一条检索。
      </div>
      <div v-if="mode === 'edit' && editing" class="editor">
        <div class="editor-head">
          <el-input v-model="editing.fileName" :disabled="editing.existing" :placeholder="createPlaceholder" aria-label="经验文件名" />
          <el-button size="small" type="primary" :loading="saving" :disabled="!canWrite" @click="submitSave">保存</el-button>
          <el-button size="small" @click="cancelEdit">取消</el-button>
        </div>
        <el-input v-model="editing.content" type="textarea" :rows="16" aria-label="经验文档内容"
          placeholder="---&#10;title: 标题&#10;keywords: 关键词, 逗号分隔&#10;summary: 一句话摘要&#10;applicable: 适用范围&#10;last_verified: YYYY-MM-DD&#10;---&#10;&#10;正文（现象 / 排查 / 根因 / 解法 / 验证）" />
      </div>
      <template v-else>
        <div v-if="mode === 'render'" class="markdown-body markdown-doc doc-content" v-html="rendered" />
        <pre v-else class="source-pre">{{ payload.content }}</pre>
      </template>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, inject, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import { Back } from '@element-plus/icons-vue'
import { renderMarkdown } from '../../session/composables/useMarkdown'
import { formatDateTime } from '../../../utils/datetime'
import { useAuthStore } from '../../../stores/auth'
import '../../../styles/markdown-doc.css'
import { EXPERIENCE_LIBRARY_KEY, type ViewerPayload } from '../composables/useExperienceLibrary'
import { formatDate, formatSize, isStaleVerified, splitKeywords, stripFrontmatter } from '../experience-format'

const props = defineProps<{ payload: ViewerPayload }>()
const store = inject(EXPERIENCE_LIBRARY_KEY)!
const authStore = useAuthStore()
const canWrite = computed(() => authStore.hasPermission('agent:write'))
const mode = ref<'render' | 'source' | 'edit'>('render')
const editing = ref<{ fileName: string; content: string; existing: boolean } | null>(null)
const saving = ref(false)
const indexDocCount = computed(() => /<!-- count: (\d+) -->/.exec(props.payload.content)?.[1] ?? '0')
const titleText = computed(() => props.payload.kind === 'index' ? '索引 INDEX.md（系统自动生成）'
  : props.payload.kind === 'create' ? '新建经验' : props.payload.meta?.title || props.payload.fileName)
const tags = computed(() => splitKeywords(props.payload.meta?.keywords ?? ''))
const staleVerified = computed(() => isStaleVerified(props.payload.meta?.lastVerified ?? ''))
const rendered = computed(() => renderMarkdown(stripFrontmatter(props.payload.content)))
const createPlaceholder = `${formatDate(new Date().toISOString())}-主题.md`
watch(() => props.payload, v => {
  mode.value = v.kind === 'create' ? 'edit' : v.initialMode
  editing.value = v.kind === 'create' ? { fileName: '', content: v.content, existing: false }
    : v.kind === 'doc' && v.initialMode === 'edit' ? { fileName: v.fileName, content: v.content, existing: true } : null
}, { immediate: true })
function startEdit(): void {
  if (props.payload.kind !== 'doc' || !canWrite.value) return
  editing.value = { fileName: props.payload.fileName, content: props.payload.content, existing: true }
  mode.value = 'edit'
}
function cancelEdit(): void {
  editing.value = null
  if (props.payload.kind === 'create') store.closeViewer()
  else mode.value = 'render'
}
async function submitSave(): Promise<void> {
  if (editing.value == null || !canWrite.value || saving.value) return
  const fileName = editing.value.fileName.trim()
  const content = editing.value.content
  if (!fileName) { ElMessage.warning('请输入文件名'); return }
  if (!fileName.endsWith('.md') || fileName.includes('/') || fileName.includes('\\') || fileName.includes('..') || fileName.toLowerCase() === 'index.md') {
    ElMessage.warning('文件名必须是 .md 结尾且不含路径，不能是 INDEX.md')
    return
  }
  if (!content.trim()) { ElMessage.warning('正文不能为空'); return }
  saving.value = true
  try {
    if (await store.saveDoc(fileName, content, editing.value.existing)) editing.value = null
  } finally { saving.value = false }
}
</script>

<style scoped>
.doc-viewer, .viewer-body, .editor { display: flex; flex-direction: column; gap: 12px; min-width: 0; }
.viewer-toolbar, .viewer-actions, .editor-head { display: flex; align-items: center; gap: 8px; }
.viewer-title { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 600; }
.viewer-body { width: 100%; max-width: 880px; margin: 0 auto; }
.viewer-loading { min-height: 200px; }
.meta-card { padding: 10px 12px; background: var(--el-fill-color-light); border-radius: 6px; font-size: 13px; }
.meta-row { display: flex; align-items: baseline; gap: 8px; margin-bottom: 6px; overflow-wrap: anywhere; }
.meta-label { flex-shrink: 0; width: 60px; color: var(--el-text-color-secondary); }
.meta-tags { display: inline-flex; flex-wrap: wrap; gap: 4px; cursor: pointer; }
.source-pre { margin: 0; padding: 10px; background: var(--el-fill-color-light); border-radius: 6px; font-size: 12px; line-height: 1.7; white-space: pre-wrap; overflow-wrap: anywhere; max-height: 520px; overflow: auto; }
@media (max-width: 768px) { .viewer-toolbar, .editor-head { flex-wrap: wrap; } .viewer-actions { flex-wrap: wrap; } }
</style>

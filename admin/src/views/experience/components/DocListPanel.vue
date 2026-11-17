<template>
  <section class="doc-list-panel">
    <el-empty v-if="store.libraries.length === 0 && store.orphans.length === 0"
      description="暂无经验库；Agent 完成复杂任务后会自行沉淀" :image-size="90" />
    <template v-else>
      <div class="library-bar">
        <el-select :model-value="store.selectedAgentId" class="library-select" filterable aria-label="选择 Agent 经验库"
          @update:model-value="store.selectAgent(Number($event))">
          <el-option v-for="lib in store.libraries" :key="lib.agentId" :value="lib.agentId" :label="lib.agentName">
            <div class="lib-option">
              <span class="status-dot" :class="lib.enabled ? 'is-on' : 'is-off'" />
              <span>{{ lib.agentName }}</span>
              <span class="muted">{{ lib.docCount }} 篇 · {{ formatSize(lib.totalBytes) }}</span>
            </div>
          </el-option>
        </el-select>
        <span v-if="selectedLibrary" class="muted">
          {{ selectedLibrary.docCount }} 篇 · {{ formatSize(selectedLibrary.totalBytes) }} · 最近更新 {{ formatDate(selectedLibrary.lastUpdatedAt) }}
        </span>
        <div class="library-bar-actions">
          <el-button size="small" :disabled="store.selectedAgentId == null" @click="store.openIndex()">索引</el-button>
          <el-button size="small" type="primary" :disabled="!canWrite || store.selectedAgentId == null" @click="store.openCreate()">新建经验</el-button>
        </div>
      </div>
      <el-alert v-if="store.orphans.length > 0" class="orphan-hint" type="warning" :closable="false" show-icon
        :title="`另有 ${store.orphans.length} 个孤儿库（Agent 已删除、目录残留）：${orphanText}`" />
      <el-form :inline="true" class="filter-form" @submit.prevent>
        <el-form-item label="搜索">
          <el-input v-model="keywordInput" placeholder="文件名/标题/关键词/摘要/适用" clearable maxlength="200"
            style="width: 190px" aria-label="搜索经验文档" @keyup.enter="submitSearch" @clear="submitSearch" />
        </el-form-item>
        <el-form-item label="关键词">
          <el-select :model-value="store.tag" clearable filterable placeholder="全部" style="width: 140px" aria-label="按关键词标签筛选"
            @update:model-value="store.setTag(String($event ?? ''))">
            <el-option v-for="f in store.keywordFacets" :key="f.tag" :label="`${f.tag}（${f.count}）`" :value="f.tag" />
          </el-select>
        </el-form-item>
        <el-form-item label="最后验证">
          <el-date-picker :model-value="store.verifiedRange" type="daterange" range-separator="至" start-placeholder="开始" end-placeholder="结束"
            value-format="YYYY-MM-DD" style="width: 220px" aria-label="按最后验证日期筛选"
            @update:model-value="store.setVerifiedRange($event as [string, string] | null)" />
        </el-form-item>
        <el-form-item label="更新时间">
          <el-date-picker :model-value="store.updatedRange" type="daterange" range-separator="至" start-placeholder="开始" end-placeholder="结束"
            value-format="YYYY-MM-DD" style="width: 220px" aria-label="按更新时间筛选"
            @update:model-value="store.setUpdatedRange($event as [string, string] | null)" />
        </el-form-item>
        <el-form-item label="异常">
          <el-select :model-value="store.abnormal" clearable placeholder="全部" style="width: 130px" aria-label="异常文档筛选"
            @update:model-value="store.setAbnormal(String($event ?? '') as AbnormalFilter)">
            <el-option label="无 frontmatter" value="no-frontmatter" />
            <el-option label="无标题" value="no-title" />
          </el-select>
        </el-form-item>
        <el-form-item>
          <el-button type="primary" @click="submitSearch">查询</el-button>
          <el-button @click="store.resetFilters()">重置</el-button>
        </el-form-item>
      </el-form>
      <div class="list-controls">
        <el-select :model-value="store.groupBy" style="width: 110px" aria-label="分组方式"
          @update:model-value="store.setGroupBy(String($event) as GroupBy)">
          <el-option label="按月分组" value="month" /><el-option label="按关键词" value="keyword" /><el-option label="平铺" value="none" />
        </el-select>
        <el-select :model-value="store.sort" style="width: 110px" aria-label="排序字段"
          @update:model-value="store.setSort(String($event) as SortField)">
          <el-option label="文件名" value="fileName" /><el-option label="标题" value="title" />
          <el-option label="更新时间" value="updatedAt" /><el-option label="最后验证" value="lastVerified" /><el-option label="大小" value="sizeBytes" />
        </el-select>
        <el-button :title="store.order === 'desc' ? '当前降序，点击切换升序' : '当前升序，点击切换降序'"
          :aria-label="store.order === 'desc' ? '切换为升序' : '切换为降序'" @click="store.toggleOrder()">
          <el-icon><component :is="store.order === 'desc' ? SortDown : SortUp" /></el-icon>
        </el-button>
      </div>
      <el-table v-loading="store.listLoading || store.viewerLoading" :data="tableRows" size="small" :span-method="spanMethod"
        :row-class-name="rowClassName" class="doc-table" @row-click="onRowClick">
        <el-table-column label="文件名" min-width="220" show-overflow-tooltip>
          <template #default="{ row }">
            <strong v-if="row.isGroup">{{ row.key }} · {{ row.count }} 篇</strong><span v-else>{{ row.doc.fileName }}</span>
          </template>
        </el-table-column>
        <el-table-column label="标题" min-width="160" show-overflow-tooltip>
          <template #default="{ row }">{{ row.isGroup ? '' : row.doc.title || '—' }}</template>
        </el-table-column>
        <el-table-column label="关键词" min-width="150">
          <template #default="{ row }">
            <template v-if="!row.isGroup && tagsOf(row.doc).length > 0">
              <el-tag v-for="t in tagsOf(row.doc).slice(0, 3)" :key="t" size="small" type="info" class="kw-tag">{{ t }}</el-tag>
              <span v-if="tagsOf(row.doc).length > 3">+{{ tagsOf(row.doc).length - 3 }}</span>
            </template>
            <span v-else>—</span>
          </template>
        </el-table-column>
        <el-table-column label="摘要" min-width="220" show-overflow-tooltip>
          <template #default="{ row }">{{ row.isGroup ? '' : row.doc.summary || '—' }}</template>
        </el-table-column>
        <el-table-column label="最后验证" width="130">
          <template #default="{ row }"><template v-if="!row.isGroup">
            {{ row.doc.lastVerified || '—' }}<el-tag v-if="isStaleVerified(row.doc.lastVerified)" size="small" type="info">久未验证</el-tag>
          </template></template>
        </el-table-column>
        <el-table-column label="大小" width="90" align="right">
          <template #default="{ row }">{{ row.isGroup ? '' : formatSize(row.doc.sizeBytes) }}</template>
        </el-table-column>
        <el-table-column label="更新时间" width="170">
          <template #default="{ row }"><span v-if="!row.isGroup">{{ formatDateTime(row.doc.updatedAt) }}</span></template>
        </el-table-column>
        <el-table-column label="操作" width="150">
          <template #default="{ row }"><template v-if="!row.isGroup">
            <el-button link type="primary" size="small" @click.stop="store.openDoc(row.doc.fileName)">查看</el-button>
            <el-button link type="primary" size="small" :disabled="!canWrite" @click.stop="store.openDoc(row.doc.fileName, 'edit')">编辑</el-button>
            <el-button link type="danger" size="small" :disabled="!canWrite" @click.stop="store.deleteDoc(row.doc)">删除</el-button>
          </template></template>
        </el-table-column>
        <template #empty><el-empty :description="hasFilter ? '无匹配文档，可调整或清空筛选' : '暂无经验文档；Agent 完成复杂任务后会自行沉淀，也可在此新建'" :image-size="70" /></template>
      </el-table>
      <ResponsivePagination class="pagination" :current-page="store.page" :page-size="store.pageSize" :total="store.total"
        layout="total, prev, pager, next" @current-change="store.turnPage" />
    </template>
  </section>
</template>

<script setup lang="ts">
import { computed, inject, ref, watch } from 'vue'
import { SortDown, SortUp } from '@element-plus/icons-vue'
import { formatDateTime } from '../../../utils/datetime'
import { useAuthStore } from '../../../stores/auth'
import ResponsivePagination from '../../../components/ResponsivePagination.vue'
import { EXPERIENCE_LIBRARY_KEY, type AbnormalFilter, type ExperienceDoc, type GroupBy, type SortField } from '../composables/useExperienceLibrary'
import { formatDate, formatSize, groupKeyOf, isStaleVerified, splitKeywords } from '../experience-format'

const store = inject(EXPERIENCE_LIBRARY_KEY)!
const authStore = useAuthStore()
const canWrite = computed(() => authStore.hasPermission('agent:write'))
const selectedLibrary = computed(() => store.libraries.find(lib => lib.agentId === store.selectedAgentId) ?? null)
const orphanText = computed(() => store.orphans.map(o => `#${o.agentId}（${o.docCount} 篇）`).join('、'))
const keywordInput = ref(store.keyword)
watch(() => store.keyword, value => { keywordInput.value = value })
function submitSearch(): void { store.search(keywordInput.value) }
const hasFilter = computed(() => store.keyword.trim() !== '' || store.tag !== '' || store.verifiedRange != null || store.updatedRange != null || store.abnormal !== '')
function tagsOf(doc: { keywords: string }): string[] { return splitKeywords(doc.keywords) }
interface GroupRow { isGroup: true; key: string; count: number }
interface DocRow { isGroup?: false; doc: ExperienceDoc }
type TableRow = GroupRow | DocRow
/** 全量分组计数来自后端；组内只展示当前页的文档。 */
const tableRows = computed<TableRow[]>(() => {
  const groupBy = store.groupBy
  if (groupBy === 'none') return store.docs.map(doc => ({ doc }))
  const rows: TableRow[] = []
  for (const group of store.groupCounts) {
    rows.push({ isGroup: true, key: group.key, count: group.count })
    for (const doc of store.docs) if (groupKeyOf(doc, groupBy) === group.key) rows.push({ doc })
  }
  return rows
})
function spanMethod({ row, columnIndex }: { row: TableRow; columnIndex: number }): { rowspan: number; colspan: number } | undefined {
  if (!row.isGroup) return undefined
  return columnIndex === 0 ? { rowspan: 1, colspan: 8 } : { rowspan: 0, colspan: 0 }
}
function rowClassName({ row }: { row: TableRow }): string { return row.isGroup ? 'is-group-row' : 'is-doc-row' }
function onRowClick(row: TableRow): void { if (!row.isGroup) store.openDoc(row.doc.fileName) }
</script>

<style scoped>
.doc-list-panel { min-width: 0; }
.library-bar, .lib-option, .list-controls { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
.library-bar { margin-bottom: 16px; }
.library-select { width: 260px; }
.library-bar-actions { margin-left: auto; }
.muted { color: var(--el-text-color-secondary); font-size: 12px; }
.status-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--el-color-info); }
.status-dot.is-on { background: var(--el-color-success); }
.orphan-hint { margin-bottom: 12px; }
.filter-form :deep(.el-form-item) { margin-bottom: 12px; }
.list-controls { margin-bottom: 12px; }
.kw-tag { margin-right: 4px; }
.doc-table :deep(.is-doc-row) { cursor: pointer; }
.doc-table :deep(.is-group-row) { --el-table-tr-bg-color: var(--el-fill-color-light); }
.pagination { margin-top: 16px; justify-content: flex-end; }
@media (pointer: coarse) { .list-controls :deep(.el-button) { min-width: 32px; min-height: 32px; } }
</style>

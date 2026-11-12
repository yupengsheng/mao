<template>
  <div class="agent-list">
    <el-card>
      <template #header>
        <div class="card-header">
          <span>Agent 列表</span>
          <div v-if="canWrite" class="header-actions">
            <el-button type="primary" @click="handleCreate">
              <el-icon><Plus /></el-icon>
              创建 Agent
            </el-button>
          </div>
        </div>
      </template>

      <!-- Search -->
      <el-form :inline="true" class="search-form">
        <el-form-item label="搜索">
          <el-input
            v-model="searchQuery"
            placeholder="Agent 名称"
            clearable
            @keyup.enter="handleSearch"
            @clear="handleSearch"
          />
        </el-form-item>
        <el-form-item label="状态">
          <el-select v-model="statusFilter" clearable placeholder="全部" style="width: 120px" @change="handleStatusFilter">
            <el-option label="启用" value="enabled" />
            <el-option label="停用" value="disabled" />
          </el-select>
        </el-form-item>
        <el-form-item label="默认模型">
          <el-select
            v-model="modelFilter"
            clearable
            filterable
            placeholder="全部"
            style="width: 200px"
            @change="handleModelFilter"
          >
            <el-option v-for="model in modelOptions" :key="model.id" :label="model.name" :value="model.id" />
          </el-select>
        </el-form-item>
        <el-form-item label="Git 凭据域">
          <el-select v-model="gitDomainFilter" clearable placeholder="全部" style="width: 120px" @change="handleGitDomainFilter">
            <el-option label="未配置" value="missing" />
          </el-select>
        </el-form-item>
        <el-form-item>
          <el-button type="primary" @click="handleSearch">查询</el-button>
        </el-form-item>
      </el-form>

      <el-alert
        v-if="allClientHidden"
        type="warning"
        show-icon
        :closable="false"
        class="client-hidden-alert"
        title="当前没有客户端可见的 Agent"
        description="客户端新建会话将显示「暂无可用智能体」。请在任一 Agent 的编辑页开启「客户端可见」。"
      />

      <el-table v-if="!isMobile" :data="agents" v-loading="loading" stripe>
        <template #empty>
          <el-empty description="暂无数据" :image-size="60" />
        </template>
        <el-table-column prop="id" label="ID" width="72" />
        <el-table-column prop="name" label="名称" width="240" class-name="agent-name-col">
          <template #default="{ row }">
            <div class="agent-identity">
              <el-avatar :size="32" :src="resolveAgentAvatarUrl(row.avatarUrl)" shape="square">{{ row.name?.slice(0, 1) || 'A' }}</el-avatar>
              <span class="agent-name" :title="row.name">{{ row.name }}</span>
              <el-tag v-if="row.isDefault" type="warning" size="small">默认</el-tag>
            </div>
          </template>
        </el-table-column>
        <el-table-column prop="description" label="描述" min-width="160" show-overflow-tooltip />
        <el-table-column label="默认模型" width="140" show-overflow-tooltip>
          <template #default="{ row }">
            <span v-if="row.defaultModelId == null" class="muted-text">跟随全局默认</span>
            <span v-else>{{ resolveModelName(row.defaultModelId) }}</span>
          </template>
        </el-table-column>
        <el-table-column label="状态" width="150">
          <template #default="{ row }">
            <el-tag :type="row.enabled === false ? 'info' : 'success'" size="small">
              {{ row.enabled === false ? '停用' : '启用' }}
            </el-tag>
            <el-tag v-if="row.clientVisible === false" type="warning" size="small" class="client-hidden-tag">
              仅管理端
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="创建人" width="120" show-overflow-tooltip class-name="hide-on-mobile" label-class-name="hide-on-mobile">
          <template #default="{ row }">{{ row.creatorName || '-' }}</template>
        </el-table-column>
        <el-table-column label="能力概览" width="170">
          <template #default="{ row }">
            <el-tooltip placement="top">
              <template #content>
                <div>技能：{{ capabilityText(Array.isArray(row.skillNames) ? row.skillNames : []) }}</div>
                <div>MCP：{{ capabilityText(resolveNames(row.mcpServerIds, mcpNameById)) }}</div>
                <div>自定义工具：{{ capabilityText(resolveNames(row.httpToolIds, toolNameById)) }}</div>
                <div>Git 域：{{ gitDomainText(row.gitAllowedDomains) }}</div>
              </template>
              <span>{{ capabilitySummary(row) }}</span>
            </el-tooltip>
          </template>
        </el-table-column>
        <el-table-column label="Git 凭据域" width="110">
          <template #default="{ row }">{{ gitDomainText(row.gitAllowedDomains) }}</template>
        </el-table-column>
        <el-table-column label="经验数" width="84" align="right">
          <template #default="{ row }">{{ row.experiences?.length || 0 }}</template>
        </el-table-column>
        <el-table-column prop="createdAt" label="创建时间" width="178" :formatter="formatDateTimeColumn" />
        <el-table-column label="操作" width="360" fixed="right">
          <template #default="{ row }">
            <div v-if="canWrite" class="row-actions">
              <el-button type="primary" link size="small" @click="handleCopy(row)">复制</el-button>
              <el-button type="primary" link size="small" @click="handleEdit(row)">编辑</el-button>
              <el-button type="primary" link size="small" @click="experienceAgent = row">经验库</el-button>
              <el-tooltip v-if="row.isDefault && row.enabled !== false" content="默认 Agent 不可停用" placement="top">
                <span class="disabled-btn-wrap">
                  <el-button type="danger" link size="small" disabled>停用</el-button>
                </span>
              </el-tooltip>
              <el-button
                v-else
                :type="row.enabled === false ? 'success' : 'danger'"
                link
                size="small"
                @click="handleToggleEnabled(row)"
              >{{ row.enabled === false ? '启用' : '停用' }}</el-button>
              <el-tooltip v-if="row.isDefault" content="默认 Agent 不可删除" placement="top">
                <span class="disabled-btn-wrap">
                  <el-button type="danger" link size="small" disabled>删除</el-button>
                </span>
              </el-tooltip>
              <el-button v-else type="danger" link size="small" @click="handleDelete(row)">删除</el-button>
            </div>
            <span v-else class="op-muted">—</span>
          </template>
        </el-table-column>
      </el-table>

      <div v-else class="mobile-card-list" v-loading="loading">
        <el-card v-for="row in agents" :key="row.id" shadow="hover">
          <div class="mobile-card-head">
            <el-avatar :size="32" :src="resolveAgentAvatarUrl(row.avatarUrl)" shape="square">{{ row.name?.slice(0, 1) || 'A' }}</el-avatar>
            <span class="mobile-card-title">{{ row.name }}</span>
            <el-tag v-if="row.isDefault" type="warning" size="small">默认</el-tag>
            <el-tag :type="row.enabled === false ? 'info' : 'success'" size="small">
              {{ row.enabled === false ? '停用' : '启用' }}
            </el-tag>
            <el-tag v-if="row.clientVisible === false" type="warning" size="small">仅管理端</el-tag>
          </div>
          <div class="mobile-card-row">
            <span class="mobile-card-label">描述</span>
            <span>{{ row.description || '-' }}</span>
          </div>
          <div class="mobile-card-row">
            <span class="mobile-card-label">默认模型</span>
            <span v-if="row.defaultModelId == null" class="muted-text">跟随全局默认</span>
            <span v-else>{{ resolveModelName(row.defaultModelId) }}</span>
          </div>
          <div class="mobile-card-row">
            <span class="mobile-card-label">能力概览</span>
            <span>{{ capabilitySummary(row) }}</span>
          </div>
          <div class="mobile-card-row">
            <span class="mobile-card-label">Git 凭据域</span>
            <span>{{ gitDomainText(row.gitAllowedDomains) }}</span>
          </div>
          <div class="mobile-card-actions">
            <template v-if="canWrite">
              <el-button type="primary" link @click="handleCopy(row)">复制</el-button>
              <el-button type="primary" link @click="handleEdit(row)">编辑</el-button>
              <el-button type="primary" link @click="experienceAgent = row">经验库</el-button>
              <el-tooltip v-if="row.isDefault && row.enabled !== false" content="默认 Agent 不可停用" placement="top">
                <span class="disabled-btn-wrap">
                  <el-button type="danger" link disabled>停用</el-button>
                </span>
              </el-tooltip>
              <el-button
                v-else
                :type="row.enabled === false ? 'success' : 'danger'"
                link
                @click="handleToggleEnabled(row)"
              >{{ row.enabled === false ? '启用' : '停用' }}</el-button>
              <el-tooltip v-if="row.isDefault" content="默认 Agent 不可删除" placement="top">
                <span class="disabled-btn-wrap">
                  <el-button type="danger" link disabled>删除</el-button>
                </span>
              </el-tooltip>
              <el-button v-else type="danger" link @click="handleDelete(row)">删除</el-button>
            </template>
          </div>
        </el-card>
        <el-empty v-if="!loading && agents.length === 0" description="暂无数据" />
      </div>

      <ResponsivePagination
        class="pagination"
        v-model:current-page="currentPage"
        v-model:page-size="pageSize"
        :page-sizes="[10, 20, 50, 100]"
        :total="total"
        @current-change="fetchAgents"
        @size-change="handleSizeChange"
      />
    </el-card>

    <AgentExperienceLibraryDialog
      v-if="experienceAgent"
      :agent-id="experienceAgent.id"
      :agent-name="experienceAgent.name"
      :initial-enabled="experienceAgent.experienceLibraryEnabled !== false"
      :can-write="canWrite"
      @close="experienceAgent = null"
      @toggle-enabled="(v) => { if (experienceAgent) experienceAgent.experienceLibraryEnabled = v }"
    />
    <AgentFormDialog
      v-if="dialogVisible"
      :visible="true"
      :agent-data="currentAgent"
      :mode="dialogMode"
      @update:visible="dialogVisible = $event"
      @saved="refreshAgentData"
    />
  </div>
</template>

<script setup lang="ts">
import { computed, ref, onActivated, onMounted, watch } from 'vue'
import { useRoute } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Plus } from '@element-plus/icons-vue'
import { api, apiGetWithHeaders } from '../../api'
import { resolveAgentAvatarUrl } from '../../utils/agent-avatar'
import { formatDateTimeColumn } from '../../utils/datetime'
import { useBreakpoint } from '../../composables/useBreakpoint'
import { useAuthStore } from '../../stores/auth'
import ResponsivePagination from '../../components/ResponsivePagination.vue'
import AgentFormDialog from './AgentFormDialog.vue'
import AgentExperienceLibraryDialog from './AgentExperienceLibraryDialog.vue'

const experienceAgent = ref<{ id: number; name: string; experienceLibraryEnabled?: boolean } | null>(null)

const { isMobile } = useBreakpoint()
const route = useRoute()

const loading = ref(false)
const loadingDetail = ref(false)
const agents = ref<any[]>([])
const searchQuery = ref('')
const statusFilter = ref('')
const modelFilter = ref<number | '' | undefined>('')
const gitDomainFilter = ref<'' | 'missing'>('')
const modelOptions = ref<Array<{ id: number; name: string }>>([])
/** 资源名映射（能力概览 tooltip 用）：含停用行，未命中 id 以 #id 兜底。 */
const mcpNameById = ref<Map<number, string>>(new Map())
const toolNameById = ref<Map<number, string>>(new Map())
const currentPage = ref(1)
const pageSize = ref(10)
const total = ref(0)
const allAgentsTotal = ref(0)
const clientVisibleTotal = ref(0)
const dialogVisible = ref(false)
const currentAgent = ref<any>(null)
const dialogMode = ref<'create' | 'edit' | 'copy'>('create')
const authStore = useAuthStore()
const canWrite = computed(() => authStore.hasPermission('agent:write'))

/** 全量视角（不受搜索/状态筛选影响）：全部 Agent 都被设为客户端不可见时给出提示。 */
const allClientHidden = computed(() => allAgentsTotal.value > 0 && clientVisibleTotal.value === 0)

function readTotalCount(headers: unknown): number {
  if (!headers || typeof headers !== 'object') return NaN
  const bag = headers as { get?: (name: string) => unknown } & Record<string, unknown>
  const raw = typeof bag.get === 'function' ? bag.get('x-total-count') : bag['x-total-count']
  const value = Array.isArray(raw) ? raw[0] : raw
  return Number(value)
}

let fetchAgentsSeq = 0
async function fetchAgents() {
  const seq = ++fetchAgentsSeq
  loading.value = true
  try {
    const { result, headers } = await apiGetWithHeaders<any[]>('/agents', {
      params: {
        keyword: searchQuery.value.trim() || undefined,
        includeDisabled: true,
        pageNum: currentPage.value,
        pageSize: pageSize.value,
        enabled: statusFilter.value === 'enabled' ? true : statusFilter.value === 'disabled' ? false : undefined,
        defaultModelId: modelFilter.value !== '' && modelFilter.value != null ? modelFilter.value : undefined,
        ...(gitDomainFilter.value === 'missing' ? { missingGitDomains: true } : {}),
      }
    })
    if (seq !== fetchAgentsSeq) return
    agents.value = result.data || []
    const headerTotal = readTotalCount(headers)
    total.value = Number.isFinite(headerTotal) ? headerTotal : agents.value.length
    const maxPage = Math.max(1, Math.ceil(total.value / pageSize.value))
    if (currentPage.value > maxPage) {
      currentPage.value = maxPage
      void fetchAgents()
    }
  } catch { /* 拦截器已提示失败，吞掉避免误报页面异常 */ } finally {
    if (seq === fetchAgentsSeq) loading.value = false
  }
}

let fetchVisibilitySeq = 0
/** 两个轻量计数：全量 Agent 与客户端可见 Agent，避免为提示条拉全量列表。 */
async function fetchVisibilityCounts() {
  const seq = ++fetchVisibilitySeq
  try {
    const [allRes, clientRes] = await Promise.all([
      apiGetWithHeaders<any[]>('/agents', { params: { includeDisabled: true, pageNum: 1, pageSize: 1 } }),
      apiGetWithHeaders<any[]>('/agents', { params: { includeDisabled: true, scope: 'client', pageNum: 1, pageSize: 1 } }),
    ])
    if (seq !== fetchVisibilitySeq) return
    const all = readTotalCount(allRes.headers)
    const visible = readTotalCount(clientRes.headers)
    if (Number.isFinite(all)) allAgentsTotal.value = all
    if (Number.isFinite(visible)) clientVisibleTotal.value = visible
  } catch { /* 拦截器已提示失败；保留上一次可见性判断 */ }
}

/** 列表与可见性提示的数据源一起刷新（增删改 / 激活页面时使用）。 */
function refreshAgentData() {
  fetchAgents()
  fetchVisibilityCounts()
}

function handleSearch() {
  currentPage.value = 1
  fetchAgents()
}

function handleStatusFilter() {
  currentPage.value = 1
  fetchAgents()
}

function handleModelFilter() {
  currentPage.value = 1
  fetchAgents()
}

function handleGitDomainFilter() {
  currentPage.value = 1
  fetchAgents()
}

/** 三态文案：null/undefined=未配置，[]=已禁止，非空=N 个域。 */
function gitDomainText(domains: string[] | null | undefined): string {
  if (domains == null) return '未配置'
  if (domains.length === 0) return '已禁止'
  return `${domains.length} 个域`
}

/** 默认模型列：启用模型显示名称；指向已停用 / 已删除模型时以 #id 兜底。 */
function resolveModelName(modelId: number): string {
  const found = modelOptions.value.find((model) => model.id === modelId)
  return found ? found.name : `#${modelId}（已停用）`
}

function resolveNames(ids: unknown, map: Map<number, string>): string[] {
  if (!Array.isArray(ids)) return []
  return ids
    .filter((id): id is number => Number.isInteger(id) && (id as number) > 0)
    .map((id) => map.get(id) ?? `#${id}`)
}

function capabilityText(names: string[]): string {
  return names.length > 0 ? names.join('、') : '—'
}

function capabilitySummary(row: any): string {
  const skills = Array.isArray(row.skillNames) ? row.skillNames.length : 0
  const mcp = Array.isArray(row.mcpServerIds) ? row.mcpServerIds.length : 0
  const tools = Array.isArray(row.httpToolIds) ? row.httpToolIds.length : 0
  const parts: string[] = []
  if (skills > 0) parts.push(`技能 ${skills}`)
  if (mcp > 0) parts.push(`MCP ${mcp}`)
  if (tools > 0) parts.push(`工具 ${tools}`)
  return parts.length > 0 ? parts.join(' · ') : '—'
}

function toNameMap(rows: unknown): Map<number, string> {
  const map = new Map<number, string>()
  if (!Array.isArray(rows)) return map
  for (const row of rows as Array<Record<string, unknown>>) {
    if (Number.isInteger(row?.id)) map.set(Number(row.id), String(row?.displayName ?? row?.name ?? `#${row.id}`))
  }
  return map
}

/** 名称字典 fail-soft：任一请求失败置空，不影响主列表。 */
async function loadNameDictionaries() {
  const [modelsRes, mcpRes, toolsRes] = await Promise.all([
    api.get('/models/active').catch(() => null),
    api.get('/mcp-servers').catch(() => null),
    api.get('/admin/http-tools', { params: { page: 1, size: 100 } }).catch(() => null),
  ])
  const modelRows = Array.isArray(modelsRes?.data) ? modelsRes.data : []
  modelOptions.value = modelRows
    .filter((row: any) => Number.isInteger(row?.id))
    .map((row: any) => ({ id: Number(row.id), name: String(row.name ?? `#${row.id}`) }))
  mcpNameById.value = toNameMap(mcpRes?.data)
  toolNameById.value = toNameMap((toolsRes?.data as any)?.records)
}

function handleSizeChange() {
  currentPage.value = 1
  fetchAgents()
}

function handleCreate() {
  dialogMode.value = 'create'
  currentAgent.value = null
  dialogVisible.value = true
}

async function loadAgentDetail(id: number) {
  const { data } = await api.get(`/agents/${id}`)
  return data
}

async function handleCopy(row: any) {
  if (loadingDetail.value) return
  loadingDetail.value = true
  try {
    const detail = await loadAgentDetail(row.id)
    dialogMode.value = 'copy'
    currentAgent.value = detail
    dialogVisible.value = true
  } catch { /* 拦截器已提示失败 */ } finally {
    loadingDetail.value = false
  }
}

async function handleEdit(row: any) {
  if (loadingDetail.value) return
  loadingDetail.value = true
  try {
    const detail = await loadAgentDetail(row.id)
    dialogMode.value = 'edit'
    currentAgent.value = detail
    dialogVisible.value = true
  } catch { /* 拦截器已提示失败 */ } finally {
    loadingDetail.value = false
  }
}

async function handleToggleEnabled(row: any) {
  const enable = row.enabled === false
  const actionText = enable ? '启用' : '停用'
  try {
    await ElMessageBox.confirm(
      enable
        ? `确定要启用 Agent「${row.name}」吗？启用后会重新出现在使用侧的 Agent 列表中。`
        : `确定要停用 Agent「${row.name}」吗？停用后使用侧的 Agent 列表不再显示，也不能用它新建会话。已有会话可以继续。`,
      '确认',
      { type: enable ? 'success' : 'warning' }
    )
    await api.patch(`/agents/${row.id}/enabled`, { enabled: enable })
    ElMessage.success(`${actionText}成功`)
    refreshAgentData()
  } catch {
    // Cancelled or error handled by interceptor
  }
}

async function handleDelete(row: any) {
  try {
    await ElMessageBox.confirm(`确定要删除 Agent \"${row.name}\" 吗？`, '确认', {
      type: 'warning'
    })
    await api.delete(`/agents/${row.id}`)
    ElMessage.success('删除成功')
    refreshAgentData()
  } catch {
    // Cancelled
  }
}

// 支持 RelatedAgentsPopover 的 ?keyword= 直跳预填；keep-alive 复活时也会命中路由变化。
watch(() => route.query.keyword, (kw) => {
  if (typeof kw === 'string' && kw.trim() !== '') {
    searchQuery.value = kw.trim()
    currentPage.value = 1
    fetchAgents()
  }
}, { immediate: true })

onMounted(() => {
  refreshAgentData()
  void loadNameDictionaries()
})

let firstActivation = true
onActivated(() => {
  if (firstActivation) {
    firstActivation = false
    return
  }
  refreshAgentData()
  void loadNameDictionaries()
})
</script>

<style scoped>
.agent-identity {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  max-width: 100%;
}
.agent-identity .el-avatar,
.agent-identity .el-tag {
  flex-shrink: 0;
}
.agent-name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  line-height: 1.4;
}
:deep(.agent-name-col .cell) {
  overflow-wrap: normal;
  word-break: keep-all;
}
.row-actions {
  display: flex;
  align-items: center;
  flex-wrap: nowrap;
  gap: 8px;
}
.row-actions :deep(.el-button) {
  margin-left: 0;
}
.row-actions .disabled-btn-wrap,
.row-actions :deep(.el-tooltip__trigger) {
  flex-shrink: 0;
}
.card-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
}
.client-hidden-alert {
  margin-bottom: 12px;
}
.client-hidden-tag {
  margin-left: 6px;
}
.header-actions {
  display: flex;
  align-items: center;
  gap: 0;
}
.header-actions :deep(.el-button + .el-button) {
  margin-left: 12px;
}
.op-muted {
  color: var(--el-text-color-secondary);
}
.muted-text {
  color: var(--el-text-color-secondary);
}

.disabled-btn-wrap {
  display: inline-flex;
  margin: 0;
}

.search-form {
  margin-bottom: 20px;
}

.pagination {
  margin-top: 20px;
  justify-content: flex-end;
}
</style>

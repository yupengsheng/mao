<template>
  <div v-if="canRead" class="memory-manage-panel">
    <el-alert class="manage-notice" :type="canManage ? 'info' : 'warning'" :closable="false" show-icon
      :title="canManage ? '记忆为用户个人数据，管理操作将记入审计日志' : '当前角色只读'"
      :description="canManage ? '编辑、忽略、恢复、删除、代建影响用户后续会话的记忆注入，请仅用于合规治理。' : '查询行为将被审计，管理操作需要 memory:write 权限。'" />
    <el-card>
      <template #header>
        <div class="card-header">
          <span>记忆列表</span>
          <div class="header-actions">
            <el-button v-if="canManage" type="primary" @click="openCreate">新增记忆</el-button>
            <el-button title="刷新" aria-label="刷新记忆列表" @click="fetchList">
              <el-icon><Refresh /></el-icon>
            </el-button>
          </div>
        </div>
      </template>
      <el-form :inline="true" class="search-form" @submit.prevent="handleSearch">
        <el-form-item v-if="!isFixed" label="用户">
          <el-select v-model="selectedUserId" filterable remote clearable :remote-method="searchFilterUsers"
            :loading="filterUsersLoading" placeholder="搜索用户名 / 昵称" style="width: 200px" @change="handleSearch">
            <el-option v-for="u in filterUsers" :key="u.id" :label="userLabel(u)" :value="u.id" />
          </el-select>
        </el-form-item>
        <el-form-item label="关键词">
          <el-input v-model="keyword" clearable placeholder="内容 / 项目标识包含匹配" style="width: 200px" @clear="handleSearch" />
        </el-form-item>
        <el-form-item label="作用域">
          <el-select v-model="scope" clearable placeholder="全部" style="width: 110px" @change="handleSearch">
            <el-option v-for="(label, value) in SCOPE_LABELS" :key="value" :label="label" :value="value" />
          </el-select>
        </el-form-item>
        <el-form-item label="状态">
          <el-select v-model="status" clearable placeholder="全部" style="width: 110px" @change="handleSearch">
            <el-option v-for="(label, value) in STATUS_LABELS" :key="value" :label="label" :value="value" />
          </el-select>
        </el-form-item>
        <el-form-item label="来源">
          <el-select v-model="source" clearable placeholder="全部" style="width: 110px" @change="handleSearch">
            <el-option v-for="(label, value) in SOURCE_LABELS" :key="value" :label="label" :value="value" />
          </el-select>
        </el-form-item>
        <el-form-item label="项目">
          <el-input v-model="projectKey" clearable placeholder="项目标识精确匹配" style="width: 160px" @clear="handleSearch" />
        </el-form-item>
        <el-form-item label="更新时间">
          <el-date-picker v-model="dateRange" type="daterange" range-separator="至" start-placeholder="开始日期"
            end-placeholder="结束日期" value-format="YYYY-MM-DD" style="width: 240px" @change="handleSearch" />
        </el-form-item>
        <el-form-item>
          <el-button type="primary" native-type="submit">查询</el-button>
          <el-button @click="resetFilters">重置</el-button>
        </el-form-item>
      </el-form>
      <el-table :data="items" v-loading="loading" stripe>
        <template #empty>
          <el-empty :description="canQuery ? '无匹配记忆' : '请选择用户或指定关键词、作用域、状态、来源、项目后跨用户查询'" />
        </template>
        <el-table-column label="ID" prop="id" width="80" />
        <el-table-column v-if="!isFixed" label="用户" width="160">
          <template #default="{ row }">{{ row.displayName || row.username || `#${row.userId}` }}</template>
        </el-table-column>
        <el-table-column label="作用域" width="90">
          <template #default="{ row }"><el-tag :type="row.scope === 'PROJECT' ? 'warning' : 'info'" size="small">{{ SCOPE_LABELS[row.scope as MemoryScope] }}</el-tag></template>
        </el-table-column>
        <el-table-column label="项目" width="140" show-overflow-tooltip>
          <template #default="{ row }">{{ row.projectKey || '-' }}</template>
        </el-table-column>
        <el-table-column label="内容" prop="content" min-width="260" show-overflow-tooltip />
        <el-table-column label="来源" width="80">
          <template #default="{ row }"><el-tag :type="row.source === 'AUTO' ? 'success' : 'info'" size="small">{{ SOURCE_LABELS[row.source as MemorySource] }}</el-tag></template>
        </el-table-column>
        <el-table-column label="来源会话" width="100">
          <template #default="{ row }">{{ row.originSessionId != null ? `#${row.originSessionId}` : '-' }}</template>
        </el-table-column>
        <el-table-column label="状态" width="90">
          <template #default="{ row }"><el-tag :type="row.status === 'ACTIVE' ? 'success' : 'info'" size="small">{{ STATUS_LABELS[row.status as MemoryStatus] }}</el-tag></template>
        </el-table-column>
        <el-table-column label="更新时间" width="170">
          <template #default="{ row }">{{ formatDateTime(row.updatedAt) || '-' }}</template>
        </el-table-column>
        <el-table-column v-if="canManage" label="操作" width="190" fixed="right">
          <template #default="{ row }">
            <el-button link type="primary" :disabled="submitting" @click="openEdit(row)">编辑</el-button>
            <el-button link :type="row.status === 'ACTIVE' ? 'warning' : 'success'" :disabled="submitting" @click="toggleStatus(row)">{{ row.status === 'ACTIVE' ? '忽略' : '恢复' }}</el-button>
            <el-button link type="danger" :disabled="submitting" @click="remove(row)">删除</el-button>
          </template>
        </el-table-column>
      </el-table>
      <ResponsivePagination class="pagination" v-model:currentPage="page" :page-size="pageSize" :total="total" @current-change="fetchList" />
    </el-card>

    <el-dialog v-model="editVisible" title="编辑记忆" width="520px">
      <el-form label-width="80px" @submit.prevent="submitEdit">
        <el-form-item label="用户">{{ editTarget ? memoryUserLabel(editTarget) : '-' }}</el-form-item>
        <el-form-item label="内容" required>
          <el-input v-model="editContent" type="textarea" :rows="4" maxlength="500" show-word-limit />
        </el-form-item>
        <el-form-item label="状态">
          <el-radio-group v-model="editStatus">
            <el-radio value="ACTIVE">生效中</el-radio><el-radio value="DISMISSED">已忽略</el-radio>
          </el-radio-group>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="editVisible = false">取消</el-button>
        <el-button type="primary" :loading="submitting" @click="submitEdit">保存</el-button>
      </template>
    </el-dialog>
    <el-dialog v-model="createVisible" title="新增记忆" width="520px">
      <el-form label-width="80px" @submit.prevent="submitCreate">
        <el-form-item label="用户" required>
          <span v-if="isFixed">{{ fixedLabel }}</span>
          <el-select v-else v-model="createUserId" filterable remote :remote-method="searchCreateUsers" :loading="createUsersLoading" placeholder="搜索用户名 / 昵称" style="width: 100%">
            <el-option v-for="u in createUsers" :key="u.id" :label="userLabel(u)" :value="u.id" />
          </el-select>
        </el-form-item>
        <el-form-item label="作用域" required>
          <el-radio-group v-model="createScope"><el-radio value="USER">用户</el-radio><el-radio value="PROJECT">项目</el-radio></el-radio-group>
        </el-form-item>
        <el-form-item v-if="createScope === 'PROJECT'" label="项目标识" required>
          <el-input v-model="createProjectKey" maxlength="128" placeholder="该用户的项目标识" />
          <div class="form-hint">请填写该用户会话使用的真实项目标识；标识错误将导致记忆不被注入。</div>
        </el-form-item>
        <el-form-item label="内容" required><el-input v-model="createContent" type="textarea" :rows="4" maxlength="500" show-word-limit /></el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="createVisible = false">取消</el-button>
        <el-button type="primary" :loading="submitting" @click="submitCreate">保存</el-button>
      </template>
    </el-dialog>
  </div>
  <el-empty v-else description="无记忆查看权限" />
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { Refresh } from '@element-plus/icons-vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import type { MemoryScope, MemorySource, MemoryStatus } from '@mao/contracts'
import { createMemory, deleteMemory, listMemories, searchMemoryUsers, updateMemory } from '../../../api/memory'
import type { MemoryManageItem, MemoryManageQuery, MemoryUserOption } from '../../../api/memory'
import { useAuthStore } from '../../../stores/auth'
import { formatDateTime } from '../../../utils/datetime'
import ResponsivePagination from '../../../components/ResponsivePagination.vue'

const props = defineProps<{ fixedUserId?: number | null; fixedUserLabel?: string | null }>()
const auth = useAuthStore()
const canRead = computed(() => auth.hasPermission('memory:read'))
const canManage = computed(() => auth.hasPermission('memory:write'))
const isFixed = computed(() => props.fixedUserId != null)
const fixedLabel = computed(() => `${props.fixedUserLabel || '用户'} (#${props.fixedUserId})`)
const SCOPE_LABELS: Record<MemoryScope, string> = { USER: '用户', PROJECT: '项目' }
const SOURCE_LABELS: Record<MemorySource, string> = { AUTO: '自动', MANUAL: '手动' }
const STATUS_LABELS: Record<MemoryStatus, string> = { ACTIVE: '生效中', DISMISSED: '已忽略' }

const selectedUserId = ref<number | null>(null)
const keyword = ref('')
const scope = ref<MemoryScope | ''>('')
const status = ref<MemoryStatus | ''>('')
const source = ref<MemorySource | ''>('')
const projectKey = ref('')
const dateRange = ref<[string, string] | null>(null)
const effectiveUserId = computed(() => props.fixedUserId ?? selectedUserId.value)
// 与后端 D5 同口径，单独时间条件不允许跨用户扫描。
const canQuery = computed(() => effectiveUserId.value != null || !!keyword.value.trim() || !!scope.value || !!status.value || !!source.value || !!projectKey.value.trim())
const items = ref<MemoryManageItem[]>([])
const loading = ref(false)
const page = ref(1)
const pageSize = 20
const total = ref(0)
const submitting = ref(false)
let listRequest = 0

async function fetchList() {
  const request = ++listRequest
  if (!canRead.value || !canQuery.value) {
    items.value = []
    total.value = 0
    loading.value = false
    return
  }
  const params: MemoryManageQuery = { page: page.value, pageSize }
  if (effectiveUserId.value != null) params.userId = effectiveUserId.value
  if (keyword.value.trim()) params.keyword = keyword.value.trim()
  if (scope.value) params.scope = scope.value
  if (status.value) params.status = status.value
  if (source.value) params.source = source.value
  if (projectKey.value.trim()) params.projectKey = projectKey.value.trim()
  if (dateRange.value) [params.updatedFrom, params.updatedTo] = dateRange.value
  loading.value = true
  try {
    const result = await listMemories(params)
    // 快速筛选/切换用户时，旧请求不得覆盖新用户的结果。
    if (request !== listRequest) return
    items.value = result.records
    total.value = result.total
  } catch {
    if (request === listRequest) { items.value = []; total.value = 0 }
    // API 拦截器统一提示真实错误，不以旧数据伪装本次成功。
  } finally {
    if (request === listRequest) loading.value = false
  }
}

function handleSearch() { page.value = 1; void fetchList() }
function resetFilters() {
  keyword.value = ''; scope.value = ''; status.value = ''; source.value = ''; projectKey.value = ''; dateRange.value = null
  selectedUserId.value = null
  handleSearch()
}
function userLabel(u: MemoryUserOption) { return `${u.displayName || u.username} (#${u.id})` }
function memoryUserLabel(item: MemoryManageItem) { return `${item.displayName || item.username || props.fixedUserLabel || '用户'} (#${item.userId})` }
const filterUsers = ref<MemoryUserOption[]>([])
const createUsers = ref<MemoryUserOption[]>([])
const filterUsersLoading = ref(false)
const createUsersLoading = ref(false)
let filterUserRequest = 0
let createUserRequest = 0
async function searchFilterUsers(value: string) {
  const request = ++filterUserRequest
  filterUsersLoading.value = true
  try {
    const users = await searchMemoryUsers(value.trim())
    if (request === filterUserRequest) filterUsers.value = users
  } catch { /* 拦截器已提示 */ } finally {
    if (request === filterUserRequest) filterUsersLoading.value = false
  }
}
async function searchCreateUsers(value: string) {
  const request = ++createUserRequest
  createUsersLoading.value = true
  try {
    const users = await searchMemoryUsers(value.trim())
    if (request === createUserRequest) createUsers.value = users
  } catch { /* 拦截器已提示 */ } finally {
    if (request === createUserRequest) createUsersLoading.value = false
  }
}

const editVisible = ref(false)
const editTarget = ref<MemoryManageItem | null>(null)
const editContent = ref('')
const editStatus = ref<MemoryStatus>('ACTIVE')
function openEdit(row: MemoryManageItem) {
  editTarget.value = row; editContent.value = row.content; editStatus.value = row.status; editVisible.value = true
}
async function submitEdit() {
  if (!canManage.value || !editTarget.value || submitting.value) return
  if (!editContent.value.trim()) { ElMessage.warning('请填写记忆内容'); return }
  submitting.value = true
  try {
    await updateMemory(editTarget.value.id, { content: editContent.value, status: editStatus.value })
    ElMessage.success('已保存'); editVisible.value = false; handleSearch()
  } catch { /* 拦截器已提示 */ } finally { submitting.value = false }
}
async function toggleStatus(row: MemoryManageItem) {
  if (!canManage.value || submitting.value) return
  const target: MemoryStatus = row.status === 'ACTIVE' ? 'DISMISSED' : 'ACTIVE'
  submitting.value = true
  try {
    await updateMemory(row.id, { status: target })
    ElMessage.success(target === 'ACTIVE' ? '已恢复' : '已忽略'); handleSearch()
  } catch { /* 拦截器已提示 */ } finally { submitting.value = false }
}
async function remove(row: MemoryManageItem) {
  if (!canManage.value || submitting.value) return
  const confirmed = await ElMessageBox.confirm(`将永久删除 ${memoryUserLabel(row)} 的记忆「${row.content.slice(0, 40)}」，不可恢复，且影响该用户后续所有会话的记忆注入。`, '删除确认', { type: 'warning', confirmButtonText: '删除', cancelButtonText: '取消' }).then(() => true).catch(() => false)
  if (!confirmed || submitting.value) return
  submitting.value = true
  try {
    await deleteMemory(row.id)
    ElMessage.success('已删除'); handleSearch()
  } catch { /* 拦截器已提示 */ } finally { submitting.value = false }
}

const createVisible = ref(false)
const createUserId = ref<number | null>(null)
const createScope = ref<MemoryScope>('USER')
const createProjectKey = ref('')
const createContent = ref('')
function openCreate() {
  createUserId.value = effectiveUserId.value; createScope.value = 'USER'; createProjectKey.value = ''; createContent.value = ''
  createUsers.value = filterUsers.value.slice()
  if (!isFixed.value) void searchCreateUsers('')
  createVisible.value = true
}
async function submitCreate() {
  if (!canManage.value || submitting.value) return
  const userId = props.fixedUserId ?? createUserId.value
  if (userId == null) { ElMessage.warning('请选择目标用户'); return }
  if (!createContent.value.trim()) { ElMessage.warning('请填写记忆内容'); return }
  if (createScope.value === 'PROJECT' && !createProjectKey.value.trim()) { ElMessage.warning('请填写项目标识'); return }
  submitting.value = true
  try {
    await createMemory({ userId, scope: createScope.value, projectKey: createScope.value === 'PROJECT' ? createProjectKey.value.trim() : null, content: createContent.value })
    ElMessage.success('已新增'); createVisible.value = false; handleSearch()
  } catch { /* 拦截器已提示 */ } finally { submitting.value = false }
}

watch([() => props.fixedUserId, canRead], () => {
  editVisible.value = false; createVisible.value = false; editTarget.value = null
  resetFilters()
  if (canRead.value && !isFixed.value) void searchFilterUsers('')
}, { immediate: true })
</script>

<style scoped>
.manage-notice { margin-bottom: 16px; }
.card-header, .header-actions { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.search-form { margin-bottom: 4px; }
.form-hint { font-size: 12px; color: var(--el-text-color-secondary); line-height: 1.4; margin-top: 4px; }
.pagination { margin-top: 12px; justify-content: flex-end; }
@media (pointer: coarse) {
  .header-actions :deep(.el-button), :deep(.el-table .el-button) { min-width: 32px; min-height: 32px; }
}
</style>

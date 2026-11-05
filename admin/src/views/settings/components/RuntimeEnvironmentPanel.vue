<template>
  <div class="runtime-environment">
    <div class="runtime-header">
      <div>
        <span class="runtime-title">运行环境健康状态</span>
        <span class="runtime-subtitle">镜像依赖指纹、最近一次预检与在线容器连接</span>
      </div>
      <el-button size="small" :loading="loading" @click="fetchStatus">刷新</el-button>
    </div>

    <el-alert
      v-if="errorMessage"
      type="error"
      :closable="false"
      show-icon
      :title="errorMessage"
      class="runtime-alert"
    />
    <el-alert
      v-else-if="mode === 'host'"
      type="info"
      :closable="false"
      show-icon
      title="当前全局运行模式为 host，容器预检与容器连接不参与实际工具请求；切到 docker 后会重新预检。"
      class="runtime-alert"
    />

    <el-descriptions v-loading="loading" :column="2" size="small" border>
      <el-descriptions-item label="运行模式">
        <el-tag :type="mode === 'docker' ? 'success' : 'info'" size="small">
          {{ mode === 'docker' ? 'docker' : 'host' }}
        </el-tag>
      </el-descriptions-item>
      <el-descriptions-item label="运行时镜像">
        <span class="mono">{{ status?.image || '-' }}</span>
        <el-tag v-if="status" :type="status.imageExists ? 'success' : 'danger'" size="small" class="tag-gap">
          {{ status.imageExists ? '存在' : '不可用' }}
        </el-tag>
      </el-descriptions-item>
      <el-descriptions-item label="依赖指纹">
        <span v-if="!status" class="muted">-</span>
        <template v-else-if="depsMatch == null">
          <span class="muted">{{ status.expectedDepsHash ? '镜像未写指纹' : '缺少 lockfile' }}</span>
        </template>
        <el-tag v-else :type="depsMatch ? 'success' : 'warning'" size="small">
          {{ depsMatch ? '一致' : '已过期，建议重建镜像' }}
        </el-tag>
        <span v-if="status?.imageDepsHash" class="mono hash-gap">{{ status.imageDepsHash }}</span>
      </el-descriptions-item>
      <el-descriptions-item label="在线容器连接">
        <span v-if="status">{{ status.connectedUsers.length }} 个</span>
        <span v-else class="muted">-</span>
        <span v-if="status?.connectedUsers.length" class="mono hash-gap">
          {{ status.connectedUsers.map((id) => `#${id}`).join(', ') }}
        </span>
      </el-descriptions-item>
      <el-descriptions-item label="最近预检" :span="2">
        <template v-if="status?.lastPrecheck">
          <el-tag :type="status.lastPrecheck.ok ? 'success' : 'danger'" size="small">
            {{ status.lastPrecheck.ok ? '通过' : '失败' }}
          </el-tag>
          <span class="precheck-time">{{ formatIso(status.lastPrecheck.at) }}</span>
          <div class="precheck-message" :class="{ failed: !status.lastPrecheck.ok }">
            {{ status.lastPrecheck.message }}
          </div>
        </template>
        <span v-else class="muted">尚未预检（首次容器请求或切换 docker 模式时执行）</span>
      </el-descriptions-item>
    </el-descriptions>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { api } from '../../../api'
import { useAuthStore } from '../../../stores/auth'

interface RuntimeEnvironmentStatus {
  mode: 'host' | 'docker'
  image: string
  imageExists: boolean
  imageDepsHash: string | null
  expectedDepsHash: string | null
  lastPrecheck: { ok: boolean; message: string; at: string } | null
  connectedUsers: number[]
}

const authStore = useAuthStore()
const canRead = computed(() => authStore.hasPermission('settings:read'))

const status = ref<RuntimeEnvironmentStatus | null>(null)
const loading = ref(false)
const mode = computed(() => status.value?.mode ?? 'host')
const errorMessage = computed(() => {
  if (!status.value) return ''
  if (status.value.mode !== 'docker') return ''
  if (!status.value.imageExists) {
    return `运行时镜像 ${status.value.image} 不可用（缺失或 Docker 服务不可达）。处置：确认 Docker 服务可用，并在部署机执行 bash scripts/build-runtime-image.sh 重建镜像。`
  }
  if (status.value.lastPrecheck && !status.value.lastPrecheck.ok) return status.value.lastPrecheck.message
  return ''
})
const depsMatch = computed(() => {
  const current = status.value
  if (!current || !current.expectedDepsHash || !current.imageDepsHash) return null
  return current.imageDepsHash === current.expectedDepsHash
})

async function fetchStatus() {
  if (!canRead.value) return
  loading.value = true
  try {
    const { data } = await api.get('/admin/runtime-environment')
    status.value = (data ?? null) as RuntimeEnvironmentStatus | null
  } catch {
    // 拦截器已提示失败；保留上次状态，避免页面闪空
  } finally {
    loading.value = false
  }
}

function formatIso(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

onMounted(fetchStatus)
</script>

<style scoped>
.runtime-environment { margin-bottom: 16px; }
.runtime-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 10px; }
.runtime-title { font-weight: 600; margin-right: 10px; }
.runtime-subtitle { font-size: 12px; color: var(--el-text-color-secondary); }
.runtime-alert { margin-bottom: 10px; }
.mono { font-family: var(--el-font-family-mono, monospace); font-size: 12px; }
.muted { color: var(--el-text-color-secondary); font-size: 12px; }
.tag-gap { margin-left: 8px; }
.hash-gap { margin-left: 8px; }
.precheck-time { margin-left: 8px; font-size: 12px; color: var(--el-text-color-secondary); }
.precheck-message { margin-top: 4px; font-size: 12px; color: var(--el-text-color-regular); word-break: break-word; }
.precheck-message.failed { color: var(--el-color-danger); }
</style>

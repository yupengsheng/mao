import { ref } from 'vue'
import { defineStore } from 'pinia'
import { api } from '../api'
import { getToken } from '../utils/auth-storage'

export interface Agent {
  id: string
  name: string
  avatarUrl?: string | null
  description: string
  executionMode: string
  isDefault?: boolean
  enabled?: boolean
}

/** 团队共享条目（GET /v1/shared-agents）：管理员背书 + 按当前用户实时计算的依赖自检。 */
export interface SharedAgent {
  agentId: number
  name: string
  description: string | null
  avatarUrl: string | null
  note: string
  sortOrder: number
  missingSkills: string[]
  mcpIssues: string[]
}

export const useAgentStore = defineStore('agent', () => {
  const agents = ref<Agent[]>([])
  const sharedAgents = ref<SharedAgent[]>([])
  const activeAgent = ref<Agent | null>(null)
  const loading = ref(false)
  const error = ref(false)

  async function fetchAgents() {
    if (!getToken()) {
      agents.value = []
      sharedAgents.value = []
      error.value = false
      return
    }

    loading.value = true
    try {
      // 新建会话只展示「客户端可见」的 Agent；不带 scope 的全量列表留给管理后台与其他入口
      const agentsRes = await api.get('/agents', { params: { scope: 'client' } })
      agents.value = ((agentsRes.data || []) as Agent[]).filter((agent) => agent.enabled !== false)
      error.value = false
    } catch {
      agents.value = []
      error.value = true
    } finally {
      loading.value = false
    }

    // 团队共享目录独立拉取：失败不阻塞主列表，仅置空分区
    try {
      const { data } = await api.get('/shared-agents')
      sharedAgents.value = ((data || []) as SharedAgent[])
    } catch {
      sharedAgents.value = []
    }
  }

  async function fetchAgent(id: string) {
    try {
      const { data } = await api.get(`/agents/${id}`)
      activeAgent.value = data
      return data
    } catch {
      return null
    }
  }

  function getAgentById(id: string) {
    return agents.value.find(a => a.id === id) || null
  }

  /** 依赖补装完成后用服务端重算的自检结果替换条目（自检徽标实时消失）。 */
  function replaceSharedAgent(vo: SharedAgent) {
    const index = sharedAgents.value.findIndex((item) => item.agentId === vo.agentId)
    if (index >= 0) {
      sharedAgents.value.splice(index, 1, vo)
    } else {
      sharedAgents.value.push(vo)
    }
  }

  return {
    agents,
    sharedAgents,
    activeAgent,
    loading,
    error,
    fetchAgents,
    fetchAgent,
    getAgentById,
    replaceSharedAgent
  }
})

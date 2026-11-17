import { api } from './index'
import type { MemoryScope, MemorySource, MemoryStatus } from '@mao/contracts'

export interface MemoryManageItem {
  id: number
  userId: number
  username?: string | null
  displayName?: string | null
  scope: MemoryScope
  projectKey: string | null
  content: string
  source: MemorySource
  status: MemoryStatus
  originSessionId: number | null
  createdAt: string | null
  updatedAt: string | null
}

export interface MemoryUserOption {
  id: number
  username: string
  displayName?: string | null
}

export interface MemoryManageQuery {
  userId?: number
  keyword?: string
  scope?: MemoryScope
  status?: MemoryStatus
  source?: MemorySource
  projectKey?: string
  updatedFrom?: string
  updatedTo?: string
  page: number
  pageSize: number
}

interface MemoryPage {
  records: MemoryManageItem[]
  total: number
  current: number
  size: number
}

export async function listMemories(params: MemoryManageQuery): Promise<MemoryPage> {
  const { data } = await api.get<MemoryPage>('/admin/memory', { params })
  return data
}

export async function searchMemoryUsers(keyword: string): Promise<MemoryUserOption[]> {
  const { data } = await api.get<{ records: MemoryUserOption[] }>('/admin/memory/users', { params: { keyword } })
  return data.records
}

export async function updateMemory(id: number, input: { content?: string; status?: MemoryStatus }): Promise<void> {
  await api.patch(`/admin/memory/${id}`, input)
}

export async function deleteMemory(id: number): Promise<void> {
  await api.delete(`/admin/memory/${id}`)
}

export async function createMemory(input: { userId: number; scope: MemoryScope; projectKey: string | null; content: string }): Promise<void> {
  await api.post('/admin/memory', input)
}

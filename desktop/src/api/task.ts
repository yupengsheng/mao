import type { TaskDetailVO, TaskListQuery, TaskPageVO } from '@mao/contracts'
import { api } from './index'

export async function listTasks(query: TaskListQuery): Promise<TaskPageVO> {
  const { data } = await api.get('/tasks', { params: query })
  return data
}

export async function getTask(id: number): Promise<TaskDetailVO> {
  const { data } = await api.get(`/tasks/${id}`)
  return data
}

import type { TaskSource, TaskStage } from '@mao/contracts'

export const TASK_STAGE_LABELS: Record<TaskStage, string> = {
  QUEUED: '排队中', WORKING: '执行中', BLOCKED: '等待处理',
  FAILED: '失败', COMPLETED: '已完成', CANCELLED: '已取消',
}

export const TASK_SOURCE_LABELS: Record<TaskSource, string> = {
  MANUAL: '手动', SCHEDULED: '定时任务', WEBHOOK: 'Webhook', API: '开放接口',
  SIGNAL: '信号哨兵', FEISHU: '飞书', WEIXIN: '微信', DINGTALK: '钉钉',
}

export function taskStageLabel(value: string): string {
  return TASK_STAGE_LABELS[value as TaskStage] ?? value
}

export function taskSourceLabel(value: string): string {
  return TASK_SOURCE_LABELS[value as TaskSource] ?? value
}

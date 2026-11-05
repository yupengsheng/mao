import type { TaskWaitKind } from '@mao/contracts'

const MAX_SUMMARY_LENGTH = 400

export function taskWaitKindLabel(kind: TaskWaitKind): string {
  return kind === 'APPROVAL' ? '工具审批' : '待回答问题'
}

/**
 * `execution_wait.payload_summary` 是后端生成的脱敏 JSON 投影，不是用户可读文案。
 * 这里只提取白名单字段拼成单行摘要；解析失败时按原文截断，绝不展开嵌套对象。
 */
export function formatTaskWaitSummary(summary: string, kind: TaskWaitKind): string {
  const raw = summary?.trim()
  if (!raw) return '等待请求（摘要不可用）'
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return truncate(raw)
  }
  const node = asObject(parsed)
  if (node == null) return truncate(raw)

  if (kind === 'QUESTION') {
    const questions = Array.isArray(node.questions) ? node.questions : []
    const count = typeof node.questionCount === 'number' ? node.questionCount : questions.length
    const first = questions.map(asObject).find((item): item is Record<string, unknown> => item != null)
    const detail = first == null
      ? ''
      : [text(first.header), text(first.question)].filter(Boolean).join('：')
    if (detail) return truncate(count > 1 ? `共 ${count} 个问题：${detail}` : detail)
    return count > 0 ? `共 ${count} 个问题` : fallbackText(node, raw)
  }

  const parts = [text(node.toolName), text(node.target), text(node.argumentPreview)].filter(Boolean)
  return parts.length > 0 ? truncate(parts.join(' · ')) : fallbackText(node, raw)
}

function fallbackText(node: Record<string, unknown>, raw: string): string {
  return truncate(text(node.summary) || raw)
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value != null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function truncate(value: string): string {
  return value.length > MAX_SUMMARY_LENGTH ? `${value.slice(0, MAX_SUMMARY_LENGTH)}…` : value
}

import { describe, expect, it } from 'vitest'
import { formatTaskWaitSummary, taskWaitKindLabel } from './taskWait'

describe('task wait display', () => {
  it('renders an approval projection without exposing the raw JSON', () => {
    const summary = JSON.stringify({ toolName: 'shell', target: 'npm test', argumentPreview: '{"command":"npm test"}' })
    expect(formatTaskWaitSummary(summary, 'APPROVAL')).toBe('shell · npm test · {"command":"npm test"}')
    expect(taskWaitKindLabel('APPROVAL')).toBe('工具审批')
  })

  it('renders the first question and total count', () => {
    const summary = JSON.stringify({
      questionCount: 2,
      questions: [
        { header: '部署环境', question: '选择目标环境' },
        { header: '回滚', question: '是否保留旧版本' },
      ],
    })
    expect(formatTaskWaitSummary(summary, 'QUESTION')).toBe('共 2 个问题：部署环境：选择目标环境')
    expect(taskWaitKindLabel('QUESTION')).toBe('待回答问题')
  })

  it('degrades to the safe fallback for truncated or malformed payloads', () => {
    expect(formatTaskWaitSummary(JSON.stringify({ summary: '等待请求（参数已隐藏）', truncated: true }), 'APPROVAL'))
      .toBe('等待请求（参数已隐藏）')
    expect(formatTaskWaitSummary('not-json', 'APPROVAL')).toBe('not-json')
    expect(formatTaskWaitSummary('', 'QUESTION')).toBe('等待请求（摘要不可用）')
  })
})

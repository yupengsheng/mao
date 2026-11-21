import { describe, expect, it } from 'vitest'
import { missedPolicyLabel, retryIntervalLabel, retryMaxLabel } from './task-display'

describe('scheduled task retry display', () => {
  it('uses scheduler defaults when fields are absent', () => {
    expect(retryMaxLabel(undefined)).toBe('2 次（不含首次）')
    expect(retryIntervalLabel(null)).toBe('5 分钟')
    expect(missedPolicyLabel(undefined)).toBe('补最近一次')
  })

  it('renders disabled retries and skip compensation', () => {
    expect(retryMaxLabel(0)).toBe('不重试')
    expect(retryIntervalLabel(7.9)).toBe('7 分钟')
    expect(missedPolicyLabel('SKIP')).toBe('只记录不补')
  })
})

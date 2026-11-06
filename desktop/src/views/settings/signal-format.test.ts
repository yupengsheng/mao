import { describe, expect, it } from 'vitest'
import {
  formatSignalChangeValue,
  formatSignalCheckDetail,
  truncateSignalSnippet,
} from '../../../../shared/contracts/src/signal'

describe('信号哨兵展示格式', () => {
  it('JSON 字段带路径与旧值/新值文案', () => {
    expect(formatSignalChangeValue({
      compareMode: 'JSON_FIELD',
      oldText: '1',
      newText: '2',
      jsonPath: 'data.price',
    })).toBe('[字段 data.price] 旧值：1 → 新值：2')
  })

  it('状态码模式显示 HTTP 状态码', () => {
    expect(formatSignalChangeValue({
      compareMode: 'STATUS_CODE',
      oldText: '200',
      newText: '500',
    })).toBe('[HTTP 状态码] 200 → 500')
  })

  it('HASH 模式标注响应体前 500 字', () => {
    expect(formatSignalChangeValue({
      compareMode: 'HASH',
      oldText: 'old',
      newText: 'new',
    })).toBe('[响应体前 500 字] 旧：old → 新：new')
  })

  it('触发失败在错误下换行附出新旧值对', () => {
    expect(formatSignalCheckDetail({
      compareMode: 'JSON_FIELD',
      changed: 1,
      error: '预算不足',
      oldValueSnippet: '1',
      newValueSnippet: '2',
      jsonPath: 'data.price',
    })).toBe('预算不足\n[字段 data.price] 旧值：1 → 新值：2')
  })

  it('探针失败只显示错误，不拼旧值/新值', () => {
    expect(formatSignalCheckDetail({
      compareMode: 'HASH',
      changed: 0,
      error: '连接失败: ECONNREFUSED',
      oldValueSnippet: null,
      newValueSnippet: null,
    })).toBe('连接失败: ECONNREFUSED')
  })

  it('上线前历史行新旧值均为 NULL 时回落为 —', () => {
    expect(formatSignalCheckDetail({
      compareMode: 'HASH',
      changed: 0,
      error: null,
      oldValueSnippet: null,
      newValueSnippet: null,
    })).toBe('—')
  })

  it('未变化行显示本次新值', () => {
    expect(formatSignalCheckDetail({
      compareMode: 'JSON_FIELD',
      changed: 0,
      error: null,
      oldValueSnippet: '2',
      newValueSnippet: '2',
      jsonPath: 'data.price',
    })).toBe('2')
  })

  it('单侧超长片段截断到 500 字并加后缀', () => {
    expect(truncateSignalSnippet('x'.repeat(501))).toBe(`${'x'.repeat(500)}…（已截断）`)
  })
})

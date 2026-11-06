import { describe, expect, it } from 'vitest'
import { normalizeRelatedAgents, parseIdList } from './useAgentRelations'

describe('parseIdList', () => {
  it('仅保留正整数', () => {
    expect(parseIdList([1, '2', 3.5, 0, -1, null, 4])).toEqual([1, 4])
  })

  it('非数组返回空数组', () => {
    expect(parseIdList('[1,2]')).toEqual([])
    expect(parseIdList(null)).toEqual([])
  })
})

describe('normalizeRelatedAgents', () => {
  it('裁剪字段并保留停用 Agent', () => {
    expect(normalizeRelatedAgents([
      {
        id: 2,
        name: 'reviewer',
        enabled: false,
        skillNames: ['review'],
        mcpServerIds: [3],
        httpToolIds: [5],
        description: 'ignored',
      },
    ])).toEqual([
      {
        id: 2,
        name: 'reviewer',
        enabled: false,
        skillNames: ['review'],
        mcpServerIds: [3],
        httpToolIds: [5],
      },
    ])
  })

  it('容错缺失和非法关联字段', () => {
    expect(normalizeRelatedAgents([
      { id: 1, name: 'agent', skillNames: null, mcpServerIds: ['9', 7], httpToolIds: { bad: true } },
    ])).toEqual([
      {
        id: 1,
        name: 'agent',
        enabled: true,
        skillNames: [],
        mcpServerIds: [7],
        httpToolIds: [],
      },
    ])
  })

  it('剔除无效 id 或空名称行', () => {
    expect(normalizeRelatedAgents([
      { id: 0, name: 'zero' },
      { id: 2, name: '' },
      { id: '3', name: 'ok' },
    ])).toEqual([
      { id: 3, name: 'ok', enabled: true, skillNames: [], mcpServerIds: [], httpToolIds: [] },
    ])
  })

  it('非数组返回空数组', () => {
    expect(normalizeRelatedAgents(null)).toEqual([])
  })
})

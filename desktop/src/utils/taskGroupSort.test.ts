import { describe, it, expect } from 'vitest'
import { sortSessionsInGroup } from './taskGroupSort'
import type { Session } from '../stores/session'

const T0 = '2026-11-10T00:00:00'
const T1 = '2026-11-11T00:00:00'
const T2 = '2026-11-12T00:00:00'

const s = (id: string, updatedAt: string, extra: Partial<Session> = {}): Session => ({
  id,
  title: `t${id}`,
  summary: `t${id}`,
  phase: 'COMPLETED',
  status: 'ACTIVE',
  running: false,
  updatedAt,
  createdAt: T0,
  ...extra,
} as Session)

const ids = (list: Session[]) => list.map((x) => x.id)

describe('sortSessionsInGroup', () => {
  it('任务树活跃的行全部前置，与 updatedAt 无关', () => {
    const input = [s('1', T0), s('2', T2), s('3', T1)]
    expect(ids(sortSessionsInGroup(input, new Set(['1', '3'])))).toEqual(['3', '1', '2'])
  })

  it('两侧都不活跃时维持 updatedAt DESC', () => {
    const input = [s('1', T0), s('2', T2), s('3', T1)]
    expect(ids(sortSessionsInGroup(input, new Set()))).toEqual(['2', '3', '1'])
  })

  it('同为活跃时按 updatedAt DESC', () => {
    const input = [s('1', T0), s('2', T2), s('3', T1)]
    expect(ids(sortSessionsInGroup(input, new Set(['1', '2', '3'])))).toEqual(['2', '3', '1'])
  })

  it('updatedAt 缺失时回落 createdAt', () => {
    const input = [s('1', '', { createdAt: T0 }), s('2', '', { createdAt: T2 })]
    expect(ids(sortSessionsInGroup(input, new Set()))).toEqual(['2', '1'])
  })

  it('同档 updatedAt 相同按 id DESC', () => {
    const input = [s('1', T1), s('2', T1), s('3', T1)]
    expect(ids(sortSessionsInGroup(input, new Set()))).toEqual(['3', '2', '1'])
    expect(ids(sortSessionsInGroup(input, new Set(['1', '2', '3'])))).toEqual(['3', '2', '1'])
  })

  it('空输入与单元素', () => {
    expect(sortSessionsInGroup([], new Set())).toEqual([])
    expect(sortSessionsInGroup([s('1', T0)], new Set())).toHaveLength(1)
  })

  it('纯函数：支持冻结数组，不改输入顺序或内容', () => {
    const input = Object.freeze([Object.freeze(s('1', T0)), Object.freeze(s('2', T2))])
    const out = sortSessionsInGroup(input, new Set())
    expect(ids([...input])).toEqual(['1', '2'])
    expect(ids(out)).toEqual(['2', '1'])
    expect(out).not.toBe(input)
    expect(out[0]).toBe(input[1])
  })
})

import { describe, expect, it } from 'vitest'
import { applyMenuVisibility, flattenMenuItems, menuGroupIdByPath, menuGroups } from './menuNav'

describe('menuGroups 配置', () => {
  it('路由 index 唯一，避免菜单高亮与跳转歧义', () => {
    const indexes = flattenMenuItems(menuGroups).map(item => item.index)
    expect(new Set(indexes).size).toBe(indexes.length)
  })

  it('menuGroupIdByPath 返回路由首段所属分组', () => {
    expect(menuGroupIdByPath(menuGroups, '/models')).toBe('capability')
    expect(menuGroupIdByPath(menuGroups, '/audit-logs')).toBe('security')
    expect(menuGroupIdByPath(menuGroups, '/unknown')).toBeUndefined()
  })
})

describe('applyMenuVisibility', () => {
  it('空隐藏列表原样返回（同一引用）', () => {
    expect(applyMenuVisibility(menuGroups, [])).toBe(menuGroups)
  })

  it('命中 index 的项移除，保留分组标题与顺序', () => {
    const filtered = applyMenuVisibility(menuGroups, ['/analytics', '/agents'])
    expect(filtered.map(g => g.id)).toEqual(['capability', 'runtime', 'security', 'system'])
    expect(filtered[0].label).toBe('能力')
    expect(filtered[0].items.map(i => i.label)).not.toContain('Agent 管理')
  })

  it('整组项被隐藏后该分组整组剔除', () => {
    const filtered = applyMenuVisibility(menuGroups, ['/settings'])
    expect(filtered.map(g => g.id)).not.toContain('system')
  })

  it('未知 index 静默忽略', () => {
    expect(applyMenuVisibility(menuGroups, ['/removed-menu'])).toEqual(menuGroups)
  })

  it('不修改原菜单定义', () => {
    const before = flattenMenuItems(menuGroups).length
    applyMenuVisibility(menuGroups, ['/agents'])
    expect(flattenMenuItems(menuGroups).length).toBe(before)
  })
})

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const source = readFileSync(new URL('./AgentSwitcher.vue', import.meta.url), 'utf8')

function styleBlock(selector: string): string {
  const start = source.indexOf(selector)
  expect(start, `未找到 ${selector}`).toBeGreaterThan(-1)
  const end = source.indexOf('}', start)
  expect(end, `${selector} 未找到闭合}`).toBeGreaterThan(start)
  return source.slice(start, end)
}

describe('AgentSwitcher 浮层布局', () => {
  it('按内容收缩并限制在视口内', () => {
    expect(source).toContain('width="auto"')
    expect(source).toContain('popper-class="agent-switch-popper"')
    expect(source).toContain("width: 'max-content'")
    expect(source).toContain("minWidth: 'min(206px, calc(100vw - 16px))'")
    expect(source).toContain("maxWidth: 'min(346px, calc(100vw - 16px))'")

    const switcher = styleBlock('.agent-switcher {')
    expect(switcher).toContain('width: max-content')
    expect(switcher).toContain('min-width: min(180px, 100%)')
    expect(switcher).toContain('max-width: 100%')

    const filter = styleBlock('.agent-filter {')
    expect(filter).toContain('width: 0')
    expect(filter).toContain('min-width: 100%')
  })

  it('长名称在行内省略，并在确实溢出时才设置提示', () => {
    const row = styleBlock('.agent-row {')
    expect(row).toContain('min-width: 0')
    expect(row).toContain('box-sizing: border-box')

    const name = styleBlock('.agent-row-name {')
    expect(name).toContain('min-width: 0')
    expect(name).toContain('overflow: hidden')
    expect(name).toContain('text-overflow: ellipsis')
    expect(name).toContain('white-space: nowrap')

    expect(source).toContain('v-overflow-title="agent.name"')
    expect(source).toContain('el.scrollWidth > el.clientWidth')
    expect(source).toContain("el.removeAttribute('title')")
    expect(source).not.toContain(':title="agent.name"')
  })

  it('名称尺寸变化后重新判断提示，卸载时释放观察器', () => {
    expect(source).toContain('new ResizeObserver')
    expect(source).toContain('overflowTitleObservers.get(el)?.disconnect()')
    expect(source).toContain('overflowTitleObservers.delete(el)')
  })
})

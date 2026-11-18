// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'

function setViewportWidth(width: number) {
  Object.defineProperty(window, 'innerWidth', {
    configurable: true,
    writable: true,
    value: width,
  })
}

function setNativeMobileMarker(enabled: boolean) {
  document.documentElement.classList.toggle('native-mobile', enabled)
}

describe('usePanelLayout 移动断点', () => {
  beforeEach(() => {
    vi.resetModules()
    setNativeMobileMarker(false)
  })

  it('桌面宽度默认展开左右面板', async () => {
    setViewportWidth(1280)
    const { usePanelLayout } = await import('./usePanelLayout')
    const { leftCollapsed, rightCollapsed } = usePanelLayout()
    expect(leftCollapsed.value).toBe(false)
    expect(rightCollapsed.value).toBe(false)
  })

  it('窄屏默认收起左右面板，首屏交给对话区', async () => {
    setViewportWidth(390)
    const { usePanelLayout } = await import('./usePanelLayout')
    const { leftCollapsed, rightCollapsed } = usePanelLayout()
    expect(leftCollapsed.value).toBe(true)
    expect(rightCollapsed.value).toBe(true)
  })

  it('原生移动壳即使报告桌面宽度也默认收起面板', async () => {
    setViewportWidth(1024)
    setNativeMobileMarker(true)
    const { isMobileDevice, usePanelLayout } = await import('./usePanelLayout')
    const { leftCollapsed, rightCollapsed } = usePanelLayout()
    expect(isMobileDevice()).toBe(true)
    expect(leftCollapsed.value).toBe(true)
    expect(rightCollapsed.value).toBe(true)
  })

  it('跨断点时自动收起，回到桌面展开左侧且右侧保持收起', async () => {
    setViewportWidth(1280)
    const { usePanelLayout } = await import('./usePanelLayout')
    const { leftCollapsed, rightCollapsed } = usePanelLayout()
    expect(leftCollapsed.value).toBe(false)

    setViewportWidth(390)
    window.dispatchEvent(new Event('resize'))
    expect(leftCollapsed.value).toBe(true)
    expect(rightCollapsed.value).toBe(true)

    setViewportWidth(1280)
    window.dispatchEvent(new Event('resize'))
    expect(leftCollapsed.value).toBe(false)
    expect(rightCollapsed.value).toBe(true)
  })

  it('toggleLeft 在同一宽度内可反复开关抽屉', async () => {
    setViewportWidth(390)
    const { usePanelLayout } = await import('./usePanelLayout')
    const { leftCollapsed, toggleLeft } = usePanelLayout()
    expect(leftCollapsed.value).toBe(true)
    toggleLeft()
    expect(leftCollapsed.value).toBe(false)
    toggleLeft()
    expect(leftCollapsed.value).toBe(true)
  })
})

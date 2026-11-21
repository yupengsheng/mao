import { describe, expect, it } from 'vitest'
import {
  applyIosKeyboardViewport,
  IOS_VIEWPORT_CONTENT,
  keyboardOcclusion,
  lockIosViewportMeta,
  type VisualViewportLike,
} from './ios-keyboard-viewport'

function fakeRoot() {
  const vars = new Map<string, string>()
  const classes = new Set<string>()
  return {
    vars,
    classes,
    root: {
      style: {
        setProperty: (name: string, value: string) => vars.set(name, value),
        removeProperty: (name: string) => {
          vars.delete(name)
        },
      },
      classList: {
        add: (name: string) => {
          classes.add(name)
        },
        remove: (name: string) => {
          classes.delete(name)
        },
      },
    } as unknown as HTMLElement,
  }
}

function fakeViewport(height: number, offsetTop = 0): VisualViewportLike {
  return {
    height,
    offsetTop,
    addEventListener: () => {},
    removeEventListener: () => {},
  }
}

describe('ios-keyboard-viewport', () => {
  it('锁定 iOS 原生壳 viewport，防止 Capacitor bridge 延迟时漏锁', () => {
    let content = ''
    const meta = {
      setAttribute: (_name: string, value: string) => {
        content = value
      },
    }

    expect(lockIosViewportMeta({ querySelector: () => meta } as unknown as Document)).toBe(true)
    expect(content).toBe(IOS_VIEWPORT_CONTENT)
    expect(content).toContain('minimum-scale=1.0')
    expect(content).toContain('maximum-scale=1.0')
    expect(content).toContain('user-scalable=no')
  })

  it('没有键盘时遮挡高度为 0', () => {
    expect(keyboardOcclusion(844, fakeViewport(844))).toBe(0)
  })

  it('键盘弹出时按可视视口高度夹住容器', () => {
    const { root, vars, classes } = fakeRoot()
    const open = applyIosKeyboardViewport({ root, viewport: fakeViewport(520), innerHeight: () => 844 })

    expect(open).toBe(true)
    expect(vars.get('--app-viewport-height')).toBe('520px')
    expect(classes.has('keyboard-open')).toBe(true)
  })

  it('键盘收起后清除变量与标记', () => {
    const { root, vars, classes } = fakeRoot()
    applyIosKeyboardViewport({ root, viewport: fakeViewport(520), innerHeight: () => 844 })
    const open = applyIosKeyboardViewport({ root, viewport: fakeViewport(844), innerHeight: () => 844 })

    expect(open).toBe(false)
    expect(vars.has('--app-viewport-height')).toBe(false)
    expect(classes.has('keyboard-open')).toBe(false)
  })

  it('少量遮挡（地址栏收缩等噪声）不触发避让', () => {
    const { root, classes } = fakeRoot()
    const open = applyIosKeyboardViewport({ root, viewport: fakeViewport(790), innerHeight: () => 844 })

    expect(open).toBe(false)
    expect(classes.has('keyboard-open')).toBe(false)
  })

  it('页面被平移时按可见区域上边界计算遮挡', () => {
    expect(keyboardOcclusion(844, fakeViewport(520, 100))).toBe(224)
  })
})

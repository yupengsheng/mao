/**
 * iOS WKWebView 软键盘避让。
 *
 * 原生壳侧 `ios.contentInset = never`，也没有装 @capacitor/keyboard，键盘弹出时布局视口
 * （100dvh）不缩，输入框被键盘盖住；WebKit 为了让光标可见会把整页放大，键盘收起后也不
 * 还原——表现为「点开输入框写几个字后整页变宽变高」。这里按 visualViewport 把应用容器
 * 夹到键盘上方的可视区域，输入框始终可见，WebKit 也就没有放大整页的动机。
 */
const OCCLUSION_THRESHOLD = 80

export const IOS_VIEWPORT_CONTENT =
  'width=device-width, initial-scale=1.0, minimum-scale=1.0, maximum-scale=1.0, user-scalable=no, viewport-fit=cover'

interface ViewportLike {
  height: number
  offsetTop: number
}

export interface VisualViewportLike extends ViewportLike {
  addEventListener(type: 'resize' | 'scroll', listener: () => void, options?: { passive: boolean }): void
  removeEventListener(type: 'resize' | 'scroll', listener: () => void): void
}

export interface IosKeyboardViewportOptions {
  root: HTMLElement
  viewport: VisualViewportLike
  innerHeight: () => number
}

/**
 * 锁定 iOS 原生壳的文档缩放比。
 *
 * index.html 会在首屏尽早执行同样的设置，但 Capacitor bridge 在部分 WKWebView
 * 生命周期中稍晚才注入；这里由 main.ts 再补一次，避免只加上 ios-capacitor 标记却
 * 漏掉 viewport 锁，导致聚焦 contenteditable 时 WebKit 仍按默认比例放大页面。
 */
export function lockIosViewportMeta(documentLike: Pick<Document, 'querySelector'>): boolean {
  const viewport = documentLike.querySelector('meta[name="viewport"]')
  if (!viewport) return false
  viewport.setAttribute('content', IOS_VIEWPORT_CONTENT)
  return true
}

/** 键盘遮挡高度（px）：布局视口高度减去可视视口占据的上边界与高度。 */
export function keyboardOcclusion(innerHeight: number, viewport: ViewportLike): number {
  return Math.max(0, innerHeight - (viewport.height + viewport.offsetTop))
}

/**
 * 应用一次可视视口状态：键盘遮挡超过阈值时把容器夹到键盘上方，返回键盘是否打开。
 * 阈值用于过滤地址栏收缩、轻微缩放这类噪声。
 */
export function applyIosKeyboardViewport({ root, viewport, innerHeight }: IosKeyboardViewportOptions): boolean {
  const keyboardOpen = keyboardOcclusion(innerHeight(), viewport) > OCCLUSION_THRESHOLD
  if (keyboardOpen) {
    root.style.setProperty('--app-viewport-height', `${Math.round(viewport.height)}px`)
    root.classList.add('keyboard-open')
  } else {
    root.style.removeProperty('--app-viewport-height')
    root.classList.remove('keyboard-open')
  }
  return keyboardOpen
}

/** 仅在 iOS 原生壳安装监听；Web / Electron / 安卓是空操作。 */
export function installIosKeyboardViewport(): () => void {
  if (typeof window === 'undefined' || typeof document === 'undefined') return () => {}
  const root = document.documentElement
  if (!root.classList.contains('ios-capacitor')) return () => {}
  const viewport = window.visualViewport
  if (!viewport) return () => {}

  const options: IosKeyboardViewportOptions = {
    root,
    viewport,
    innerHeight: () => window.innerHeight,
  }
  const sync = () => {
    applyIosKeyboardViewport(options)
  }
  sync()
  viewport.addEventListener('resize', sync, { passive: true })
  viewport.addEventListener('scroll', sync, { passive: true })
  return () => {
    viewport.removeEventListener('resize', sync)
    viewport.removeEventListener('scroll', sync)
  }
}

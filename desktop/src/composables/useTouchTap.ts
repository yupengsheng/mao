/**
 * 会话行等「点一下就该进」的行级轻点激活。
 *
 * iOS 原生壳的历史会话抽屉是从左侧 transform 滑入的 fixed 面板，面板里的滚动区在滑入后
 * 会新建合成层；WebKit 对这种新合成层的第一次轻点偶尔不派发合成 click（表现为「要点两次
 * 才能打开会话」）。这里改为在 touchend 判定轻点后直接回调，随后的合成 click 用时间窗去重：
 * 触屏一次就生效，桌面鼠标 / 触控笔仍走 click，行为不变。
 */
const TAP_MAX_MOVE_PX = 10
const CLICK_DEDUPE_MS = 300
/** 轻点落在这些元素上时不升级为「打开会话」：它们自己处理点击 */
const INTERACTIVE_SELECTOR = 'button, input, a, .session-item-actions'

export function useTouchTap<T>(onTap: (payload: T) => void) {
  let start: { x: number; y: number } | null = null
  let lastTapAt = 0

  function reset() {
    start = null
  }

  function onTouchStart(e: TouchEvent) {
    const t = e.touches[0]
    start = t ? { x: t.clientX, y: t.clientY } : null
  }

  function onTouchEnd(e: TouchEvent, payload: T) {
    const from = start
    start = null
    const t = e.changedTouches[0]
    // 列表滚动时手指会滑走，只认位移 ≤ 10px 的轻点
    if (!from || !t) return
    if (Math.hypot(t.clientX - from.x, t.clientY - from.y) > TAP_MAX_MOVE_PX) return
    if ((e.target as HTMLElement | null)?.closest?.(INTERACTIVE_SELECTOR)) return
    lastTapAt = Date.now()
    onTap(payload)
  }

  /** 鼠标路径；触屏轻点之后紧跟的合成 click 靠时间窗丢弃，避免重复打开 */
  function onClick(payload: T) {
    if (Date.now() - lastTapAt < CLICK_DEDUPE_MS) return
    onTap(payload)
  }

  return { onTouchStart, onTouchEnd, onClick, reset }
}
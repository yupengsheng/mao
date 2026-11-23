// @vitest-environment jsdom
// 触屏轻点激活：iOS 抽屉里合成 click 偶发丢失，靠 touchend 兜底 + 时间窗去重。
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useTouchTap } from './useTouchTap'

/** jsdom 没有 TouchEvent：手搓一个带 touches / changedTouches 的事件 */
function touchEvent(type: 'touchstart' | 'touchend', x: number, y: number) {
  const ev = new Event(type, { bubbles: true, cancelable: true })
  const touch = { clientX: x, clientY: y }
  Object.defineProperty(ev, 'touches', { value: type === 'touchend' ? [] : [touch] })
  Object.defineProperty(ev, 'changedTouches', { value: [touch] })
  return ev as unknown as TouchEvent
}

describe('useTouchTap', () => {
  afterEach(() => {
    vi.useRealTimers()
    document.body.innerHTML = ''
  })

  it('轻点（位移 0）在 touchend 就回调一次，随后 300ms 内的合成 click 不再重复触发', () => {
    const onTap = vi.fn()
    const tap = useTouchTap<string>(onTap)
    const row = document.createElement('div')
    document.body.appendChild(row)

    row.addEventListener('touchstart', tap.onTouchStart)
    row.addEventListener('touchend', (e) => tap.onTouchEnd(e, 's1'))
    row.dispatchEvent(touchEvent('touchstart', 20, 20))
    row.dispatchEvent(touchEvent('touchend', 22, 21))
    expect(onTap).toHaveBeenCalledTimes(1)
    expect(onTap).toHaveBeenLastCalledWith('s1')

    // 合成 click 紧跟在 touchend 之后到达
    tap.onClick('s1')
    expect(onTap).toHaveBeenCalledTimes(1)
  })

  it('手指滑走（位移 > 10px）视为滚动，不激活', () => {
    const onTap = vi.fn()
    const tap = useTouchTap<string>(onTap)
    const row = document.createElement('div')
    document.body.appendChild(row)
    row.addEventListener('touchstart', tap.onTouchStart)
    row.addEventListener('touchend', (e) => tap.onTouchEnd(e, 's1'))

    row.dispatchEvent(touchEvent('touchstart', 20, 20))
    row.dispatchEvent(touchEvent('touchend', 20, 60))
    expect(onTap).not.toHaveBeenCalled()
  })

  it('轻点落在行内按钮上时不升级为打开会话', () => {
    const onTap = vi.fn()
    const tap = useTouchTap<string>(onTap)
    const row = document.createElement('div')
    const btn = document.createElement('button')
    row.appendChild(btn)
    document.body.appendChild(row)
    row.addEventListener('touchstart', tap.onTouchStart)
    row.addEventListener('touchend', (e) => tap.onTouchEnd(e, 's1'))

    btn.dispatchEvent(touchEvent('touchstart', 5, 5))
    btn.dispatchEvent(touchEvent('touchend', 5, 5))
    expect(onTap).not.toHaveBeenCalled()
  })

  it('桌面鼠标路径：没有 touchend 时 click 直接生效', () => {
    const onTap = vi.fn()
    const tap = useTouchTap<string>(onTap)
    tap.onClick('s1')
    expect(onTap).toHaveBeenCalledWith('s1')
  })

  it('touchcancel 后残留起点被清掉，不会把后续 click 之外的触摸误判为轻点', () => {
    const onTap = vi.fn()
    const tap = useTouchTap<string>(onTap)
    const row = document.createElement('div')
    document.body.appendChild(row)
    row.addEventListener('touchstart', tap.onTouchStart)
    row.addEventListener('touchend', (e) => tap.onTouchEnd(e, 's1'))

    row.dispatchEvent(touchEvent('touchstart', 20, 20))
    tap.reset()
    row.dispatchEvent(touchEvent('touchend', 20, 20))
    expect(onTap).not.toHaveBeenCalled()
  })
})
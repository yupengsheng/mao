/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { findScrollParent, pickPanelPlacement } from './panel-placement'

afterEach(() => vi.restoreAllMocks())

function rect(top: number) {
  return { top, bottom: top, left: 0, right: 0, width: 0, height: 0, x: 0, y: 0, toJSON: () => ({}) } as DOMRect
}

describe('panel placement', () => {
  it('finds the nearest scrolling ancestor', () => {
    const outer = document.createElement('div')
    const inner = document.createElement('div')
    const anchor = document.createElement('div')
    inner.append(anchor); outer.append(inner); document.body.append(outer)
    vi.spyOn(window, 'getComputedStyle').mockImplementation((el) => ({ overflowY: el === inner ? 'auto' : 'visible' }) as CSSStyleDeclaration)
    expect(findScrollParent(anchor)).toBe(inner)
    outer.remove()
  })

  it('flips down when the space above the scroll container is short', () => {
    const scroller = document.createElement('div')
    const anchor = document.createElement('div')
    scroller.append(anchor); document.body.append(scroller)
    vi.spyOn(window, 'getComputedStyle').mockReturnValue({ overflowY: 'auto' } as CSSStyleDeclaration)
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      return rect(this === anchor ? 100 : 40)
    })
    expect(pickPanelPlacement(anchor)).toBe('bottom')
    scroller.remove()
  })

  it('keeps the default upward placement when enough space exists', () => {
    const anchor = document.createElement('div')
    document.body.append(anchor)
    vi.spyOn(window, 'getComputedStyle').mockReturnValue({ overflowY: 'visible' } as CSSStyleDeclaration)
    vi.spyOn(anchor, 'getBoundingClientRect').mockReturnValue(rect(400))
    expect(pickPanelPlacement(anchor)).toBe('top')
    anchor.remove()
  })
})

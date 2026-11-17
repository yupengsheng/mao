/** 面板弹出方向：编辑态位于滚动消息容器内时，空间不足则向下弹出。 */
export function findScrollParent(el: HTMLElement): HTMLElement | null {
  let current: HTMLElement | null = el.parentElement
  while (current) {
    const overflowY = window.getComputedStyle(current).overflowY
    if (overflowY === 'auto' || overflowY === 'scroll') return current
    current = current.parentElement
  }
  return null
}

export function pickPanelPlacement(anchor: HTMLElement, budget = 328): 'top' | 'bottom' {
  const anchorTop = anchor.getBoundingClientRect().top
  const scroller = findScrollParent(anchor)
  const limitTop = scroller?.getBoundingClientRect().top ?? 8
  return anchorTop - limitTop < budget ? 'bottom' : 'top'
}

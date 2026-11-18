import { ref } from 'vue'

export function isMobileDevice(): boolean {
  return isMobileViewportNow()
}

const MOBILE_BREAKPOINT = 768

function isNativeMobileShell(): boolean {
  if (typeof window === 'undefined') return false
  const root = typeof document !== 'undefined' ? document.documentElement : null
  if (root?.classList.contains('native-mobile')) return true
  // Capacitor can expose a desktop-sized CSS viewport on some iOS WebViews.
  // The user agent is still mobile there, so keep the drawer layout enabled.
  return /Android|iPhone|iPad|iPod|IEMobile|Opera Mini/i.test(window.navigator?.userAgent ?? '')
}

function isMobileViewportNow(): boolean {
  return typeof window !== 'undefined' && (window.innerWidth <= MOBILE_BREAKPOINT || isNativeMobileShell())
}

// 移动端默认收起左右面板：历史会话改成顶栏汉堡打开的抽屉，首屏直接给对话区。
const leftCollapsed = ref(isMobileViewportNow())
const rightCollapsed = ref(isMobileViewportNow())

// 监听视口变化：跨过移动断点时左侧改为“进入移动端即收起、回到桌面端即展开”，
// 右侧维持“进入移动端自动收起、回到桌面不自动展开”的旧口径。
const isMobileViewport = ref(isMobileViewportNow())
if (typeof window !== 'undefined') {
  window.addEventListener('resize', () => {
    const mobile = isMobileViewportNow()
    if (mobile !== isMobileViewport.value) {
      isMobileViewport.value = mobile
      if (mobile) {
        leftCollapsed.value = true
        rightCollapsed.value = true
      } else {
        leftCollapsed.value = false
      }
    }
  }, { passive: true })
}

export function usePanelLayout() {
  function toggleLeft() {
    leftCollapsed.value = !leftCollapsed.value
  }

  function toggleRight() {
    rightCollapsed.value = !rightCollapsed.value
  }

  return {
    leftCollapsed,
    rightCollapsed,
    toggleLeft,
    toggleRight,
  }
}

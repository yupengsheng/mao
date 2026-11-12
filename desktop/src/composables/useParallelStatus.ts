import { computed, effectScope, getCurrentInstance, onUnmounted, ref, watch, type ComputedRef } from 'vue'
import { useSessionStore, ACTIVE_PHASES, type Session } from '../stores/session'
import { useAuthStore } from '../stores/auth'
import { approvalFlashEnabled } from '../utils/approvalFlashPreference'

/**
 * 多会话并行状态聚合：标题态 + 任务栏闪烁的事实源。
 * 与侧栏任务面板同源（sessions / getSideTasks / ACTIVE_PHASES）。
 */
export type ParallelStatus = 'waiting_approval' | 'failed' | 'running' | null

/** 主会话 + 边路任务的最高优先状态；归档主会话连同其边路任务整体跳过。 */
export function deriveParallelStatus(
  sessions: Session[],
  getSideTasks: (parentId: string) => Array<{ phase: Session['phase'] }>,
): ParallelStatus {
  const live = sessions.filter(s => s.status !== 'ARCHIVED')
  // 三轮独立扫描保证 waiting > failed > running，不因短路丢优先级
  for (const s of live) {
    if (s.phase === 'WAITING_APPROVAL' || getSideTasks(s.id).some(t => t.phase === 'WAITING_APPROVAL')) {
      return 'waiting_approval'
    }
  }
  for (const s of live) {
    if (s.phase === 'FAILED' || getSideTasks(s.id).some(t => t.phase === 'FAILED')) return 'failed'
  }
  for (const s of live) {
    if (ACTIVE_PHASES.has(s.phase) || getSideTasks(s.id).some(t => ACTIVE_PHASES.has(t.phase))) return 'running'
  }
  return null
}

export function useParallelStatus(): ComputedRef<ParallelStatus> {
  const sessionStore = useSessionStore()
  return computed(() => deriveParallelStatus(sessionStore.sessions, id => sessionStore.getSideTasks(id)))
}

export function titleWithPrefix(status: ParallelStatus, base = 'Mao'): string {
  const prefix = status === 'waiting_approval' ? '❗ 等待审批 · '
    : status === 'failed' ? '✗ 有会话失败 · '
    : status === 'running' ? '▶ 运行中 · '
    : ''
  return prefix + base
}

function flashApi(): { flashFrame: (on: boolean) => Promise<unknown> } | null {
  if (typeof window === 'undefined') return null
  const api = (window as any).electronAPI
  return api && typeof api.flashFrame === 'function' ? api : null
}

/**
 * 全局状态指示器（App.vue setup 调用一次）：
 * - 标题：并行状态 + 登录态双源，登出复位 Mao；
 * - 任务栏闪烁：等待审批 && 开关开 && Electron 桥接存在，仅在期望态翻转时发 IPC。
 */
export function useAppStatusIndicators(): () => void {
  const status = useParallelStatus()
  const authStore = useAuthStore()
  const flashing = ref(false)

  const scope = effectScope()
  scope.run(() => {
    watch([status, () => authStore.user], ([value, user]) => {
      document.title = user ? titleWithPrefix(value) : titleWithPrefix(null)
    }, { immediate: true })

    const desiredFlash = computed(() =>
      !!authStore.user
      && status.value === 'waiting_approval'
      && approvalFlashEnabled.value
      && !!flashApi()
    )
    watch(desiredFlash, (now, prev) => {
      const api = flashApi()
      if (!api) return
      if (!now && prev === undefined) return
      flashing.value = now
      void api.flashFrame(now).catch(() => undefined)
    }, { immediate: true })
  })

  const stop = () => {
    scope.stop()
    if (!flashing.value) return
    flashing.value = false
    void flashApi()?.flashFrame(false).catch(() => undefined)
  }
  if (getCurrentInstance()) onUnmounted(stop)

  return stop
}

import { ref } from 'vue'

/**
 * 「等待审批时闪烁任务栏」本机偏好。
 * localStorage 键 aw-approval-flash：缺省开（键不写 '1'），'0' 关。
 * 模块级 ref 是状态指示器 watcher 的响应式源（localStorage 本身无响应性）。
 */

const STORAGE_KEY = 'aw-approval-flash'

function readEnabled(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) !== '0'
  } catch {
    return true
  }
}

export const approvalFlashEnabled = ref<boolean>(readEnabled())

export function isApprovalFlashEnabled(): boolean {
  return readEnabled()
}

export function setApprovalFlashEnabled(v: boolean): void {
  approvalFlashEnabled.value = v
  try {
    if (v) localStorage.removeItem(STORAGE_KEY)
    else localStorage.setItem(STORAGE_KEY, '0')
  } catch {
    // 存储不可用时仅保留内存态
  }
}

export function resetApprovalFlashForTest(v = true): void {
  approvalFlashEnabled.value = v
}

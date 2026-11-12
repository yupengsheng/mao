import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  approvalFlashEnabled,
  isApprovalFlashEnabled,
  resetApprovalFlashForTest,
  setApprovalFlashEnabled,
} from './approvalFlashPreference'

const storage = new Map<string, string>()

function stubStorage() {
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, String(value)),
    removeItem: (key: string) => storage.delete(key),
  })
}

describe('approvalFlashPreference', () => {
  beforeEach(() => {
    storage.clear()
    stubStorage()
    resetApprovalFlashForTest(true)
  })

  it('缺省开启，只有显式写入 0 才关闭', () => {
    expect(isApprovalFlashEnabled()).toBe(true)
    setApprovalFlashEnabled(false)
    expect(storage.get('aw-approval-flash')).toBe('0')
    expect(approvalFlashEnabled.value).toBe(false)
    expect(isApprovalFlashEnabled()).toBe(false)
  })

  it('重新开启时删除键，回到缺省态', () => {
    setApprovalFlashEnabled(false)
    setApprovalFlashEnabled(true)
    expect(storage.has('aw-approval-flash')).toBe(false)
    expect(approvalFlashEnabled.value).toBe(true)
  })

  it('存储不可用时保留内存态且不抛出', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => { throw new Error('denied') },
      setItem: () => { throw new Error('denied') },
      removeItem: () => { throw new Error('denied') },
    })
    expect(() => setApprovalFlashEnabled(false)).not.toThrow()
    expect(approvalFlashEnabled.value).toBe(false)
    expect(isApprovalFlashEnabled()).toBe(true)
  })
})

import { describe, expect, it, vi, afterEach } from 'vitest'
import { safeGetItem, safeRemoveItem, safeSetItem } from './safe-storage'

function stubStorage(getItem: () => string | null) {
  const store = {
    getItem: vi.fn(getItem),
    setItem: vi.fn(),
    removeItem: vi.fn(),
  }
  vi.stubGlobal('localStorage', store)
  return store
}

describe('safe-storage', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('正常读取返回值', () => {
    stubStorage(() => 'cached-token')
    expect(safeGetItem('token')).toBe('cached-token')
  })

  it('localStorage 抛错时读取降级为 null', () => {
    stubStorage(() => {
      throw new DOMException('The operation is insecure.', 'SecurityError')
    })
    expect(safeGetItem('token')).toBeNull()
  })

  it('写入与删除抛错时静默降级', () => {
    vi.stubGlobal('localStorage', {
      getItem: vi.fn(),
      setItem: vi.fn(() => {
        throw new DOMException('QuotaExceededError', 'QuotaExceededError')
      }),
      removeItem: vi.fn(() => {
        throw new DOMException('QuotaExceededError', 'QuotaExceededError')
      }),
    })

    expect(() => safeSetItem('token', 'value')).not.toThrow()
    expect(() => safeRemoveItem('token')).not.toThrow()
  })
})
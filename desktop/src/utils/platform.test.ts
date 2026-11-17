// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest'
import { clientKind, clientSessionSource } from './platform'

function setNativePlatform(platform: 'android' | 'ios' | null) {
  ;(window as any).Capacitor = platform == null
    ? undefined
    : { isNativePlatform: () => true, getPlatform: () => platform }
}

describe('客户端形态与建会话来源', () => {
  beforeEach(() => {
    setNativePlatform(null)
    delete (window as any).electronAPI
  })

  it('Electron：握手 electron，建会话来源 desktop', () => {
    ;(window as any).electronAPI = {}
    expect(clientKind()).toBe('electron')
    expect(clientSessionSource()).toBe('desktop')
  })

  it('安卓 Capacitor：握手 android，建会话来源 android', () => {
    setNativePlatform('android')
    expect(clientKind()).toBe('android')
    expect(clientSessionSource()).toBe('android')
  })

  it('iOS Capacitor：握手 ios，建会话来源回退 web（后端白名单未收录 ios）', () => {
    setNativePlatform('ios')
    expect(clientKind()).toBe('ios')
    expect(clientSessionSource()).toBe('web')
  })

  it('普通浏览器：握手 browser，建会话来源 web', () => {
    expect(clientKind()).toBe('browser')
    expect(clientSessionSource()).toBe('web')
  })
})

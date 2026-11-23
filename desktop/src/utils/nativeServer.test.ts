// @vitest-environment jsdom
// 原生壳服务器地址：只有 Capacitor 原生壳且装了 MaoServer 插件时才可用。
import { afterEach, describe, expect, it, vi } from 'vitest'
import { changeNativeServer, getNativeServer, hasNativeServerPlugin } from './nativeServer'

function stubCapacitor(platform: string | null, plugins?: Record<string, unknown>) {
  ;(window as any).Capacitor = {
    isNativePlatform: () => platform != null,
    getPlatform: () => platform,
    Plugins: plugins,
  }
}

describe('nativeServer', () => {
  afterEach(() => {
    delete (window as any).Capacitor
  })

  it('Web / Electron 下不暴露插件', async () => {
    stubCapacitor(null, { MaoServer: { get: async () => ({ url: 'https://a.example' }) } })
    expect(hasNativeServerPlugin()).toBe(false)
    expect(await getNativeServer()).toBeNull()
    expect(await changeNativeServer()).toBe(false)
  })

  it('原生壳但没装插件（老版本）时一律降级', async () => {
    stubCapacitor('ios')
    expect(hasNativeServerPlugin()).toBe(false)
    expect(await getNativeServer()).toBeNull()
    expect(await changeNativeServer()).toBe(false)
  })

  it('读取原生壳的服务器地址与是否已配置', async () => {
    stubCapacitor('android', {
      MaoServer: {
        get: async () => ({ url: 'https://mao.example.com', configured: true }),
        open: async () => undefined,
      },
    })
    expect(hasNativeServerPlugin()).toBe(true)
    expect(await getNativeServer()).toEqual({ url: 'https://mao.example.com', configured: true })
  })

  it('configured=false 表示还在用默认地址，字段缺失按已配置处理', async () => {
    stubCapacitor('ios', {
      MaoServer: { get: async () => ({ url: 'https://mao.yupengsheng.cn', configured: false }) },
    })
    expect(await getNativeServer()).toEqual({ url: 'https://mao.yupengsheng.cn', configured: false })

    stubCapacitor('ios', {
      MaoServer: { get: async () => ({ url: 'https://mao.yupengsheng.cn' }) },
    })
    expect(await getNativeServer()).toEqual({ url: 'https://mao.yupengsheng.cn', configured: true })
  })

  it('插件报错时返回 null 而不是抛给页面', async () => {
    stubCapacitor('ios', {
      MaoServer: { get: async () => { throw new Error('boom') } },
    })
    expect(await getNativeServer()).toBeNull()
  })

  it('更换服务器调用原生 open；失败时返回 false', async () => {
    const open = vi.fn(async () => undefined)
    stubCapacitor('ios', { MaoServer: { get: async () => ({ url: 'https://x' }), open } })
    expect(await changeNativeServer()).toBe(true)
    expect(open).toHaveBeenCalledTimes(1)

    stubCapacitor('ios', {
      MaoServer: { get: async () => ({ url: 'https://x' }), open: async () => { throw new Error('no') } },
    })
    expect(await changeNativeServer()).toBe(false)
  })
})
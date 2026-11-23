/**
 * 原生壳（安卓 / iOS）的服务器地址。
 *
 * 这个壳远程加载整站，登录页本身就来自远端，所以地址只能存在原生侧：Android SharedPreferences /
 * iOS UserDefaults，通过自研 MaoServer 插件读写。Web 端只负责在两处用它：登录页展示当前地址、
 * 提供「更换服务器」入口。老版本壳没有这个插件，一律降级为「不展示」。
 */
import { isNativeCapacitor } from './capacitor'

export interface NativeServerInfo {
  /** 规范化后的服务器地址（https:// 开头、无尾斜杠） */
  url: string
  /** false = 首次启动还没选过，原生侧用的是默认地址 */
  configured: boolean
}

interface MaoServerPlugin {
  get?: () => Promise<{ url?: string; configured?: boolean }>
  open?: () => Promise<unknown>
}

function nativeServerPlugin(): MaoServerPlugin | null {
  if (!isNativeCapacitor()) return null
  const plugins = (window as any).Capacitor?.Plugins
  const plugin = plugins?.MaoServer
  return plugin ? (plugin as MaoServerPlugin) : null
}

/** 当前壳是否支持读取 / 更换服务器地址（老版本 Android / iOS 壳没有插件） */
export function hasNativeServerPlugin(): boolean {
  return nativeServerPlugin() != null
}

/** 壳里配置的服务器地址；非原生壳或插件缺失返回 null */
export async function getNativeServer(): Promise<NativeServerInfo | null> {
  const plugin = nativeServerPlugin()
  if (!plugin?.get) return null
  try {
    const info = await plugin.get()
    if (!info?.url) return null
    return { url: String(info.url), configured: info.configured !== false }
  } catch {
    return null
  }
}

/**
 * 打开原生地址输入框。确认后原生侧会整壳重建加载新地址，所以这里的 Promise 通常还没返回
 * 页面就已被销毁；返回 false 只在「插件缺失 / 调用失败」时出现（可提示用户升级 App）。
 */
export async function changeNativeServer(): Promise<boolean> {
  const plugin = nativeServerPlugin()
  if (!plugin?.open) return false
  try {
    await plugin.open()
    return true
  } catch {
    return false
  }
}
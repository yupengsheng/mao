import { onMounted, ref } from 'vue'
import { getLocalDeviceInfo } from '../utils/device-info'

/**
 * 当前 Electron 设备身份 id：仅桌面壳有值，浏览器 / 非桌面壳为 null。
 * onMounted 后经主进程 IPC 异步回填；设备身份与 mao-agent 共用同一份文件，运行期稳定。
 */
export function useCurrentDevice() {
  const deviceId = ref<string | null>(null)
  onMounted(async () => {
    const info = await getLocalDeviceInfo()
    deviceId.value = info?.id ?? null
  })
  return { deviceId }
}

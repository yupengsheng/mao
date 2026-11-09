import { DRAG_PATHS_MIME, parseDragPaths } from './file-manager'

/** 跨面板拖拽载荷 MIME：JSON `[{path, isDirectory, workspaceRoot?}]`，供聊天输入框和中心页签栏消费 */
export const WORKSPACE_ENTRIES_MIME = 'application/x-mao-entries'

export interface WorkspaceDragEntry {
  path: string
  isDirectory: boolean
  /**
   * 拖拽源所属工作区根（绝对路径）。缺省表示当前会话工作区；
   * 工作区总览打开的跨工作区文件管理页签会带上自己的根，落点据此路由。
   */
  workspaceRoot?: string
}

/** 文件浏览器 dragstart 的唯一写入点：同时写 entries 和面板内部移动沿用的 paths 载荷。 */
export function setWorkspaceDragPayload(e: DragEvent, entries: WorkspaceDragEntry[]): void {
  if (!e.dataTransfer) return
  e.dataTransfer.setData(WORKSPACE_ENTRIES_MIME, JSON.stringify(entries))
  e.dataTransfer.setData(DRAG_PATHS_MIME, JSON.stringify(entries.map((it) => it.path)))
  // 面板内部目标会显式设置 dropEffect='move'；放宽 effectAllowed 后，复制型落点也能显示可放置状态
  e.dataTransfer.effectAllowed = 'copyMove'
}

/** entries 元素形状校验：path 非空字符串、isDirectory 布尔、workspaceRoot 可选非空字符串，不符即整条剔除。 */
function isValidEntry(value: unknown): value is WorkspaceDragEntry {
  if (typeof value !== 'object' || value === null) return false
  const it = value as Partial<WorkspaceDragEntry>
  if (typeof it.path !== 'string' || it.path.length === 0 || typeof it.isDirectory !== 'boolean') return false
  if (it.workspaceRoot !== undefined && (typeof it.workspaceRoot !== 'string' || it.workspaceRoot.length === 0)) return false
  return true
}

/**
 * 跨面板落点统一入口：entries 优先，回退旧 paths 载荷（按文件处理）；
 * 坏 JSON / 空入参返回 []，落点据此放行系统文件上传或浏览器默认行为。
 */
export function parseWorkspaceDrag(dt: DataTransfer | null): WorkspaceDragEntry[] {
  if (!dt) return []
  const raw = dt.getData(WORKSPACE_ENTRIES_MIME)
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as unknown
      if (Array.isArray(parsed)) return parsed.filter(isValidEntry)
    } catch {
      // 坏 JSON：不回退 paths，避免半新半旧载荷混读
    }
    return []
  }
  return parseDragPaths(dt.getData(DRAG_PATHS_MIME)).map((path) => ({ path, isDirectory: false }))
}

/** 过滤掉目录；聊天输入框和中心页签栏在跨面板落点一律忽略目录。 */
export function fileEntriesOf(entries: WorkspaceDragEntry[]): WorkspaceDragEntry[] {
  return entries.filter((it) => !it.isDirectory)
}

/**
 * dragover 事件的 dataTransfer 处于 protected mode，getData 返回空串，只能查 types。
 * 目录与文件无法在 dragover 阶段区分，统一按可放置处理。
 */
export function hasWorkspaceDragPayload(dt: DataTransfer | null): boolean {
  return !!dt && (dt.types.includes(WORKSPACE_ENTRIES_MIME) || dt.types.includes(DRAG_PATHS_MIME))
}

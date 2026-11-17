import type { Session } from '../stores/session'

/**
 * 标准模式组内排序：任务树活跃优先 → updatedAt（缺省 createdAt）DESC → id DESC。
 * 活跃集合由调用方按行内信号同源预计算，纯函数内只做 Set 查询，不访问 store。
 */
export function sortSessionsInGroup(
  sessions: readonly Session[],
  treeActiveIds: ReadonlySet<string>,
): Session[] {
  return [...sessions].sort((a, b) => {
    const activeA = treeActiveIds.has(String(a.id))
    const activeB = treeActiveIds.has(String(b.id))
    if (activeA !== activeB) return activeA ? -1 : 1
    const tb = new Date(b.updatedAt || b.createdAt || 0).getTime()
    const ta = new Date(a.updatedAt || a.createdAt || 0).getTime()
    if (tb !== ta) return tb - ta
    // updated_at 相同时按 id 倒序，避免批量更新导致按创建正序排列
    return Number(b.id) - Number(a.id)
  })
}

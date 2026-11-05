import type { AnalyticsPeriodMeta } from '../types'

/** 目标页支持 startDate/endDate 的窗口下钻入口。 */
const DATE_WINDOW_PATHS = ['/sessions', '/llm-calls']

function appendQuery(path: string, entries: Record<string, string>): string {
  const hashIndex = path.indexOf('#')
  const hash = hashIndex >= 0 ? path.slice(hashIndex) : ''
  const withoutHash = hashIndex >= 0 ? path.slice(0, hashIndex) : path
  const queryIndex = withoutHash.indexOf('?')
  const base = queryIndex >= 0 ? withoutHash.slice(0, queryIndex) : withoutHash
  const params = new URLSearchParams(queryIndex >= 0 ? withoutHash.slice(queryIndex + 1) : '')
  for (const [key, value] of Object.entries(entries)) params.set(key, value)
  return `${base}?${params.toString()}${hash}`
}

/** 跨页下钻：会话/调用流水按创建日期透传统计窗口。 */
export function withDateWindow(path: string, period?: AnalyticsPeriodMeta | null): string {
  if (!period || !DATE_WINDOW_PATHS.some((prefix) => path.startsWith(prefix))) return path
  return appendQuery(path, { startDate: period.start, endDate: period.end })
}

/** 分析页内切 Tab：用真实起止日还原 custom 周期，避免回到默认「今日」。 */
export function withAnalyticsPeriod(path: string, period?: AnalyticsPeriodMeta | null): string {
  if (!period || !path.startsWith('/analytics')) return path
  return appendQuery(path, {
    period: 'custom',
    start: period.start,
    end: period.end
  })
}

/** 按目标路由选择下钻口径；管理页等无窗口参数的链接保持原样。 */
export function withDrilldownPeriod(path: string, period?: AnalyticsPeriodMeta | null): string {
  if (path.startsWith('/analytics')) return withAnalyticsPeriod(path, period)
  return withDateWindow(path, period)
}

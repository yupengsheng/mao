/**
 * 工具结果表格化：「列表形 JSON 结果」解析为 `string[][]` 供 TableGrid 渲染，
 * 与 RFC 4180 CSV 序列化、按工具名的视图偏好读写。全部纯函数 / 设备本地副作用。
 *
 * 接受形态（从严，宁可原文不可错表）：
 * ① 顶层数组且元素全为「扁平键值对象」（值仅 string/number/boolean/null）；
 * ② 顶层对象且恰有一个数组字段、其余字段全为标量 → 取该数组按 ① 判定，不限键名。
 * 嵌套值 / 多数组字段 / 空数组（含包裹内空数组）/ 超规模上限 → null（保持原文）。
 */

const MAX_RESULT_TEXT_LENGTH = 1_000_000
const MAX_ROWS_INCLUDING_HEADER = 201
const MAX_COLUMNS = 30

const VIEW_KEY_PREFIX = 'aw-tool-result-view.'

export type ToolResultViewMode = 'text' | 'table'

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isScalar(value: unknown): boolean {
  return value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
}

function isFlatRecord(value: unknown): value is Record<string, string | number | boolean | null> {
  if (!isPlainObject(value)) return false
  for (const v of Object.values(value)) {
    if (!isScalar(v)) return false
  }
  return true
}

function stringifyCell(value: unknown): string {
  if (value === undefined) return ''
  return String(value)
}

/**
 * 把列表形 JSON 结果解析为表格行（首行为表头 = 全部元素键的并集，按首次出现顺序；
 * 缺失单元格填空串）。形态外 / 超限 / 解析失败一律返回 null。
 */
export function tryParseTable(resultText: string): string[][] | null {
  if (typeof resultText !== 'string') return null
  const trimmed = resultText.trim()
  if (trimmed.length === 0 || trimmed.length > MAX_RESULT_TEXT_LENGTH) return null
  const head = trimmed[0]
  if (head !== '[' && head !== '{') return null

  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    return null
  }

  let records: unknown[]
  if (Array.isArray(parsed)) {
    records = parsed
  } else if (isPlainObject(parsed)) {
    const entries = Object.entries(parsed)
    const arrayEntry = entries.find(([, v]) => Array.isArray(v))
    if (!arrayEntry) return null
    // 唯一数组字段：其余字段混入第二个数组或任何对象 → 歧义形态，整表拒绝
    for (const [key, v] of entries) {
      if (key !== arrayEntry[0] && !isScalar(v)) return null
    }
    records = arrayEntry[1] as unknown[]
  } else {
    return null
  }

  if (records.length === 0) return null
  if (records.length + 1 > MAX_ROWS_INCLUDING_HEADER) return null

  // 键并集保持首次出现顺序；列数超限整表拒绝
  const keys: string[] = []
  const seen = new Set<string>()
  for (const item of records) {
    if (!isFlatRecord(item)) return null
    for (const k of Object.keys(item)) {
      if (!seen.has(k)) {
        seen.add(k)
        keys.push(k)
      }
    }
  }
  if (keys.length === 0 || keys.length > MAX_COLUMNS) return null

  return [
    keys,
    ...records.map((item) => {
      const record = item as Record<string, unknown>
      return keys.map((k) => stringifyCell(record[k]))
    }),
  ]
}

/** RFC 4180 序列化：字段含逗号 / 引号 / 换行时双引号包裹 + 引号翻倍，\r\n 行结尾。 */
export function toCsv(rows: string[][]): string {
  return rows
    .map((row) => row.map(escapeCsvField).join(','))
    .join('\r\n')
}

function escapeCsvField(field: string): string {
  if (/[",\r\n]/.test(field)) {
    return `"${field.replace(/"/g, '""')}"`
  }
  return field
}

/** 该工具的表格/原文视图偏好（设备本地 localStorage）；缺省原文。 */
export function getToolResultView(toolName: string): ToolResultViewMode {
  try {
    return window.localStorage.getItem(VIEW_KEY_PREFIX + toolName) === 'table' ? 'table' : 'text'
  } catch {
    return 'text'
  }
}

/** 写入视图偏好；'text' 为缺省语义，直接移除键（控制偏好键膨胀）。 */
export function setToolResultView(toolName: string, view: ToolResultViewMode): void {
  try {
    if (view === 'table') {
      window.localStorage.setItem(VIEW_KEY_PREFIX + toolName, 'table')
    } else {
      window.localStorage.removeItem(VIEW_KEY_PREFIX + toolName)
    }
  } catch {
    // 设备本地偏好，失败不打扰
  }
}

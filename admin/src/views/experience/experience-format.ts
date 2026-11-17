/** 与上游经验库 API 保持相同的分组、关键词与 UTC+8 日期口径。 */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}
export function formatDate(iso: string): string {
  if (iso === '') return '—'
  const time = Date.parse(iso)
  if (!Number.isFinite(time)) return iso.slice(0, 10)
  return new Date(time + 8 * 3600_000).toISOString().slice(0, 10)
}
export function splitKeywords(keywords: string): string[] {
  const out: string[] = []
  for (const part of keywords.split(/[\s]*[,，、;；][\s]*/)) {
    const tag = part.trim()
    if (tag !== '' && !out.includes(tag)) out.push(tag)
  }
  return out
}
export const NO_MONTH_GROUP = '未命名'
export const NO_KEYWORD_GROUP = '未分类'
export function groupKeyOf(doc: { fileName: string; keywords: string }, groupBy: 'month' | 'keyword'): string {
  if (groupBy === 'month') return /^(\d{4}-\d{2})/.exec(doc.fileName)?.[1] ?? NO_MONTH_GROUP
  return splitKeywords(doc.keywords)[0] ?? NO_KEYWORD_GROUP
}
export function isStaleVerified(lastVerified: string): boolean {
  if (lastVerified === '') return false
  const time = new Date(`${lastVerified}T00:00:00+08:00`).getTime()
  return Number.isFinite(time) && Date.now() - time > 180 * 86400_000
}
/** 仅剥离行首闭合的 frontmatter，值内的 --- 不应截断正文。 */
export function stripFrontmatter(content: string): string {
  if (!content.startsWith('---')) return content
  let offset = 0
  let seenOpening = false
  for (const line of content.split('\n')) {
    const start = offset
    offset += line.length + 1
    if (line.trim() !== '---') continue
    if (!seenOpening) {
      if (start !== 0) return content
      seenOpening = true
      continue
    }
    return content.slice(offset)
  }
  return content
}

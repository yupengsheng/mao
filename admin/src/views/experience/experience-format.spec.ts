import { describe, expect, it } from 'vitest'
import { formatDate, groupKeyOf, splitKeywords, stripFrontmatter } from './experience-format'

describe('experience view formatting mirrors API grouping', () => {
  it('uses UTC+8 dates and mixed Chinese separators with stable keyword deduplication', () => {
    expect(formatDate('2026-11-16T17:30:00.000Z')).toBe('2026-11-17')
    expect(splitKeywords(' TS，Node、TS;Vue；  DB , ')).toEqual(['TS', 'Node', 'Vue', 'DB'])
    expect(groupKeyOf({ fileName: '2026-11-17-topic.md', keywords: 'TS，Vue' }, 'month')).toBe('2026-11')
    expect(groupKeyOf({ fileName: 'notes.md', keywords: '' }, 'month')).toBe('未命名')
    expect(groupKeyOf({ fileName: 'notes.md', keywords: '' }, 'keyword')).toBe('未分类')
    expect(groupKeyOf({ fileName: 'notes.md', keywords: 'TS，Vue' }, 'keyword')).toBe('TS')
  })
  it('strips only a closed frontmatter block, including CRLF', () => {
    expect(stripFrontmatter('---\r\ntitle: a---b\r\n---\r\n# Body')).toBe('# Body')
    expect(stripFrontmatter('---\ntitle: broken')).toBe('---\ntitle: broken')
    expect(stripFrontmatter('# Body\n---')).toBe('# Body\n---')
  })
})

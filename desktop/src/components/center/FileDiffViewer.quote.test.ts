import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const source = readFileSync(new URL('./FileDiffViewer.vue', import.meta.url), 'utf8')

describe('FileDiffViewer 引用与正文排版', () => {
  it('iOS 壳保留 Diff 行区间引用，Android 壳继续禁用', () => {
    const start = source.indexOf('function attachQuoteAction')
    expect(start).toBeGreaterThanOrEqual(0)
    const body = source.slice(start, source.indexOf('\n}', start))
    expect(body).toContain('isAndroidCapacitor()')
    expect(body).not.toContain('isNativeCapacitor()')
    expect(source).toContain("import { isAndroidCapacitor, openExternalUrl } from '../../utils/capacitor'")
  })

  it('正文使用统一追踪字距变量，标签与代码字距保持显式值', () => {
    expect(source).not.toContain('letter-spacing: -0.374px;')
    expect(source.match(/letter-spacing: var\(--aw-tracking-body\);/g)).toHaveLength(2)
    expect(source).toContain('.markdown-body :deep(h2),')
    expect(source).toContain('letter-spacing: 0;')
    expect(source).toContain('.markdown-body :deep(.code-lang)')
  })
})

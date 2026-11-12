// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  ACCENT_PRESETS,
  FONT_SCALE_OPTIONS,
  applyAccent,
  applyFontScale,
  normalizeAccent,
  normalizeFontScale,
  setAccent,
  setFontScale,
} from './appearance'

const css = readFileSync(resolve(process.cwd(), 'src/style.css'), 'utf8')
const cssWithoutComments = css.replace(/\/\*[\s\S]*?\*\//g, '')

function readSource(relativePath: string): string {
  return readFileSync(resolve(process.cwd(), 'src', relativePath), 'utf8')
}

function cssBlock(selector: string): string {
  const start = cssWithoutComments.indexOf(selector)
  expect(start).toBeGreaterThanOrEqual(0)
  const open = cssWithoutComments.indexOf('{', start)
  const close = cssWithoutComments.indexOf('}', open)
  return cssWithoutComments.slice(open + 1, close)
}

function stripDocumentedDarkFallbacks(source: string): string {
  return source.replace(
    /:root\[data-theme="dark"\]\s*:not\(\[data-accent\]\)[^{]*\{[^}]*\}/g,
    '',
  )
}

beforeEach(() => {
  localStorage.clear()
  document.documentElement.removeAttribute('data-accent')
  document.documentElement.removeAttribute('data-font-scale')
})

afterEach(() => {
  document.documentElement.removeAttribute('data-accent')
  document.documentElement.removeAttribute('data-font-scale')
})

describe('外观预设注册表', () => {
  it('强调色固定五款且 id 唯一', () => {
    expect(ACCENT_PRESETS.map((preset) => preset.id)).toEqual([
      'blue',
      'violet',
      'green',
      'orange',
      'graphite',
    ])
    expect(new Set(ACCENT_PRESETS.map((preset) => preset.id)).size).toBe(ACCENT_PRESETS.length)
  })

  it('每款强调色都有中文名与合法色板值', () => {
    for (const preset of ACCENT_PRESETS) {
      expect(preset.label.length).toBeGreaterThan(0)
      expect(preset.swatch).toMatch(/^#[0-9a-fA-F]{6}$/)
    }
  })

  it('界面字号固定三档且包含默认档', () => {
    expect(FONT_SCALE_OPTIONS.map((option) => option.id)).toEqual(['small', 'std', 'large'])
    for (const option of FONT_SCALE_OPTIONS) {
      expect(option.label.length).toBeGreaterThan(0)
    }
  })
})

describe('非法与默认值归一', () => {
  it('强调色默认 blue 与非法值都归一为 null', () => {
    expect(normalizeAccent('blue')).toBeNull()
    expect(normalizeAccent(null)).toBeNull()
    expect(normalizeAccent('')).toBeNull()
    expect(normalizeAccent('pink')).toBeNull()
    expect(normalizeAccent('Violet')).toBeNull()
  })

  it('合法非默认强调色原样返回', () => {
    expect(normalizeAccent('violet')).toBe('violet')
    expect(normalizeAccent('graphite')).toBe('graphite')
  })

  it('字号默认 std 与非法值都归一为 null', () => {
    expect(normalizeFontScale('std')).toBeNull()
    expect(normalizeFontScale(undefined)).toBeNull()
    expect(normalizeFontScale('huge')).toBeNull()
  })

  it('合法非默认字号原样返回', () => {
    expect(normalizeFontScale('small')).toBe('small')
    expect(normalizeFontScale('large')).toBe('large')
  })
})

describe('html 属性应用与持久化', () => {
  it('默认档不写 data-accent / data-font-scale', () => {
    document.documentElement.setAttribute('data-accent', 'orange')
    document.documentElement.setAttribute('data-font-scale', 'large')

    applyAccent('blue')
    applyFontScale('std')

    expect(document.documentElement.hasAttribute('data-accent')).toBe(false)
    expect(document.documentElement.hasAttribute('data-font-scale')).toBe(false)
  })

  it('非法值在应用时回落到默认档', () => {
    applyAccent('violet')
    applyFontScale('large')

    applyAccent('unknown' as never)
    applyFontScale('unknown' as never)

    expect(document.documentElement.hasAttribute('data-accent')).toBe(false)
    expect(document.documentElement.hasAttribute('data-font-scale')).toBe(false)
  })

  it('非默认档写入属性', () => {
    applyAccent('violet')
    applyFontScale('large')

    expect(document.documentElement.getAttribute('data-accent')).toBe('violet')
    expect(document.documentElement.getAttribute('data-font-scale')).toBe('large')
  })

  it('setAccent / setFontScale 同步存储与属性，切回默认即移除属性', () => {
    setAccent('green')
    setFontScale('small')

    expect(localStorage.getItem('aw-accent')).toBe('green')
    expect(localStorage.getItem('aw-font-scale')).toBe('small')
    expect(document.documentElement.getAttribute('data-accent')).toBe('green')
    expect(document.documentElement.getAttribute('data-font-scale')).toBe('small')

    setAccent('blue')
    setFontScale('std')

    expect(localStorage.getItem('aw-accent')).toBe('blue')
    expect(localStorage.getItem('aw-font-scale')).toBe('std')
    expect(document.documentElement.hasAttribute('data-accent')).toBe(false)
    expect(document.documentElement.hasAttribute('data-font-scale')).toBe(false)
  })
})

describe('style.css 令牌守卫', () => {
  it('12 处派生透明色统一引用强调色三元组', () => {
    expect(css.match(/rgba\(var\(--aw-accent-rgb\)/g)?.length).toBe(12)
  })

  it('Element Plus 主色派生保留默认值并仅剩 4 处蓝色透明值', () => {
    expect(css.match(/rgba\(0, 102, 204/g)?.length).toBe(4)
    expect(css.match(/#3385d9/g)?.length).toBe(1)
  })

  it('四款非默认强调色都有亮暗两个预设块，默认蓝不生成块', () => {
    for (const id of ['violet', 'green', 'orange', 'graphite']) {
      expect(css).toContain(`html[data-accent='${id}'] {`)
      expect(css).toContain(`html[data-theme='dark'][data-accent='${id}'] {`)
    }
    expect(css).not.toContain("html[data-accent='blue']")
  })

  it('暗色令牌使用柔和底色与正文对比度，控件边框不发亮', () => {
    const dark = cssBlock('[data-theme="dark"]')
    expect(dark).toContain('--aw-canvas: #1c1c1e')
    expect(dark).toContain('--aw-ink: #d0d0d4')
    expect(dark).toContain('--aw-body: #d0d0d4')
    expect(dark).toContain('--aw-border: #4a4a50')
  })

  it('Element Plus 暗色变量写在 html.dark 上以压过 EP 暗色皮肤', () => {
    const epDark = cssBlock('html.dark')
    expect(epDark).toContain('--el-text-color-primary: var(--aw-ink)')
    expect(epDark).toContain('--el-bg-color: var(--aw-canvas)')
    expect(epDark).toContain('--el-border-color: var(--aw-border)')
    expect(css).not.toContain('[data-theme="dark"] {\n  --el-bg-color')
  })

  it('非默认强调色的暗色块接管 Element Plus 主色与 hover', () => {
    for (const id of ['violet', 'green', 'orange', 'graphite']) {
      const block = cssBlock(`html[data-theme='dark'][data-accent='${id}']`)
      expect(block).toContain('--el-color-primary: var(--aw-primary)')
      expect(block).toContain('--el-color-primary-dark-2: var(--aw-primary-focus)')
    }
  })

  it('字号三档覆盖界面与 Element Plus 字号令牌', () => {
    expect(cssBlock("html[data-font-scale='small']")).toContain('--aw-text-body: 15px')
    expect(cssBlock("html[data-font-scale='large']")).toContain('--aw-text-body: 19px')
    expect(cssBlock("html[data-font-scale='large']")).toContain('--el-font-size-base: 14px')
    expect(cssBlock("html[data-font-scale='small']")).toContain('--el-font-size-extra-small: 11px')
  })
})

describe('组件硬编码色守卫', () => {
  const componentFiles = [
    ['components/chat/QuickCommandTag.vue', 'QuickCommandTag.vue'],
    ['components/chat/MessageBubble.vue', 'MessageBubble.vue'],
    ['views/settings/ServerSettingsView.vue', 'ServerSettingsView.vue'],
  ] as const

  it('回退形态与头像色板之外不再残留蓝色字面量', () => {
    for (const [path, name] of componentFiles) {
      // ServerSettingsView 的 :root[data-theme="dark"]:not([data-accent]) 块是注释明确的
      // 暗色默认档零变化锚点，保留亮蓝原字面量属于既有行为，不纳入残留扫描。
      const source = stripDocumentedDarkFallbacks(readSource(path))
        .replace(/var\(--aw-primary,\s*#0066cc\)/g, '')
        .split('\n')
        .filter((line) => !line.includes('AVATAR_PALETTE'))
        .join('\n')

      expect(source, name).not.toContain('#0066cc')
      expect(source, name).not.toContain('rgba(0, 102, 204')
      expect(source, name).not.toContain('rgba(41, 151, 255')
    }
  })
})

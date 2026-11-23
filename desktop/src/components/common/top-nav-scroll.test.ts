// 原生壳（iOS / 安卓）顶栏宽度不足时改为横向滑动查看剩余入口。
// 手机屏宽放不下「工作区 / 搜索 / 用量 / 执行记录 / 指令 / 终端 / 设置 / 主题」全部入口，
// 之前继续压缩按钮，右侧入口被挤出可视区且点不到。真实手感无法单测，这里守住
// 全局 style.css 的滚动规则不被误删。
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const styleCss = readFileSync(new URL('../../style.css', import.meta.url), 'utf8')

describe('原生壳顶栏横向滚动', () => {
  it('html.native-mobile .top-nav 允许横向滚动、隐藏滚动条', () => {
    const block = /html\.native-mobile\s+\.top-nav\s*\{[^}]*\}/.exec(styleCss)?.[0] ?? ''
    expect(block).toMatch(/overflow-x\s*:\s*auto/)
    expect(block).toMatch(/overflow-y\s*:\s*hidden/)
    expect(styleCss).toMatch(/html\.native-mobile\s+\.top-nav::-webkit-scrollbar\s*\{[^}]*display\s*:\s*none/)
  })

  it('顶栏子项不收缩，宽度不够时才滚动', () => {
    expect(styleCss).toMatch(/html\.native-mobile\s+\.nav-right\s*>\s*\*\s*\{[^}]*flex-shrink\s*:\s*0/)
  })
})
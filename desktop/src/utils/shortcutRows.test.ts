import { describe, expect, it } from 'vitest'
import { SHORTCUT_ROWS } from './shortcutRows'

describe('SHORTCUT_ROWS', () => {
  it('包含全部快捷键，且键位顺序与速查表一致', () => {
    expect(SHORTCUT_ROWS).toEqual([
      { keys: 'Ctrl/Cmd+K', action: '搜索会话' },
      { keys: 'Ctrl/Cmd+`', action: '打开/关闭终端' },
      { keys: 'Ctrl/Cmd+Shift+P', action: '命令面板' },
      { keys: '/', action: '输入框快捷指令' },
      { keys: 'Enter', action: '发送' },
      { keys: 'Shift+Enter', action: '换行' },
      { keys: 'Esc', action: '关闭浮层' },
      { keys: 'Y / N', action: '审批待决卡片（执行 / 拒绝）' }
    ])
  })
})

/**
 * 快捷键速查表的单一数据源：速查对话框与命令面板快捷键组共用同一份文案，
 * 新增快捷键只需在这里补一行，两个入口同步生效。
 */
export interface ShortcutRow {
  keys: string
  action: string
}

export const SHORTCUT_ROWS: ReadonlyArray<ShortcutRow> = [
  { keys: 'Ctrl/Cmd+K', action: '搜索会话' },
  { keys: 'Ctrl/Cmd+`', action: '打开/关闭终端' },
  { keys: 'Ctrl/Cmd+Shift+P', action: '命令面板' },
  { keys: '/', action: '输入框快捷指令' },
  { keys: 'Enter', action: '发送' },
  { keys: 'Shift+Enter', action: '换行' },
  { keys: 'Esc', action: '关闭浮层' },
  { keys: 'Y / N', action: '审批待决卡片（执行 / 拒绝）' }
]

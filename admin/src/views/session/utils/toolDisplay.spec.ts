import { describe, expect, it } from 'vitest'
import { getToolDisplayName, getToolInputPreview, toolCallLabel } from './toolDisplay'

describe('getToolDisplayName', () => {
  it('补齐子代理、消息与渠道工具的中文名', () => {
    expect(getToolDisplayName('spawn_subagent')).toBe('启动后台子代理')
    expect(getToolDisplayName('wait_subagents')).toBe('等待后台子代理')
    expect(getToolDisplayName('dump_user_messages')).toBe('导出用户消息')
    expect(getToolDisplayName('feishu_send_file')).toBe('发送飞书文件')
    expect(getToolDisplayName('dingtalk_send_image')).toBe('发送钉钉图片')
  })

  it('补齐页面、MCP 与自定义工具的中文名', () => {
    expect(getToolDisplayName('page_actions')).toBe('执行批量页面操作')
    expect(getToolDisplayName('mcp_call')).toBe('调用 MCP 工具')
    expect(getToolDisplayName('http_describe')).toBe('查询自定义工具参数')
  })

  it('mcp__server__tool 还原为 server.tool，未知名称保持原样', () => {
    expect(getToolDisplayName('mcp__github__create_issue')).toBe('github.create_issue')
    expect(getToolDisplayName('mcp__')).toBe('mcp__')
    expect(getToolDisplayName('custom_tool')).toBe('custom_tool')
  })
})

describe('getToolInputPreview', () => {
  it('展示子代理与消息条数', () => {
    expect(getToolInputPreview('delegate', { agent_type: 'worker', task: '修复登录鉴权' })).toBe('worker: 修复登录鉴权')
    expect(getToolInputPreview('dump_user_messages', { recentCount: 3 })).toBe('最近 3 条')
    expect(getToolInputPreview('dump_user_messages', { recentCount: 0 })).toBe('')
  })

  it('还原 MCP / 自定义工具外壳参数', () => {
    expect(getToolInputPreview('mcp_call', { server: 'github', tool: 'create_issue' })).toBe('github.create_issue')
    expect(getToolInputPreview('http_describe', { tool: 'weather' })).toBe('weather')
    expect(getToolInputPreview('http_call', { tool: 'weather', arguments: { city: '杭州' } })).toBe('weather(city=杭州)')
  })

  it('展示渠道文件与页面操作参数', () => {
    expect(getToolInputPreview('feishu_send_file', { file: '/tmp/a.pdf', filename: '报告.pdf' })).toBe('报告.pdf')
    expect(getToolInputPreview('dingtalk_send_image', { image: 'images/a.png' })).toBe('images/a.png')
    expect(getToolInputPreview('page_actions', { actions: [{}, {}] })).toBe('2 个动作')
    expect(getToolInputPreview('page_wait', { ms: 500 })).toBe('等待 500ms')
  })

  it('保留命令、搜索、路径、URL 与截断逻辑', () => {
    expect(getToolInputPreview('shell', { command: 'pwd' })).toBe('pwd')
    expect(getToolInputPreview('grep_search', { pattern: 'TODO', path: 'src' })).toBe('TODO in src')
    expect(getToolInputPreview('read_file', { file_path: '/tmp/a' })).toBe('/tmp/a')
    expect(getToolInputPreview('open_web_page', { url: 'https://example.com' })).toBe('https://example.com')
    expect(getToolInputPreview('delegate', { task: 'a'.repeat(61) })).toBe(`${'a'.repeat(60)}...`)
  })
})

describe('toolCallLabel', () => {
  const base = { id: 'tc1', status: 'success', isExpanded: false } as const

  it('后端 summary 优先，否则用中文工具名 + 参数预览', () => {
    expect(toolCallLabel({ ...base, name: 'dump_user_messages', summary: '后端摘要', input: { recentCount: 3 } })).toBe('后端摘要')
    expect(toolCallLabel({ ...base, name: 'dump_user_messages', input: { recentCount: 3 } })).toBe('导出用户消息 · 最近 3 条')
    expect(toolCallLabel({ ...base, name: 'unknown_tool' })).toBe('unknown_tool')
  })
})

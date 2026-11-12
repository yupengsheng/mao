import { describe, expect, it } from 'vitest';
import { ToolResultSummarizer } from './tool-result-summarizer.js';

/**
 * 信号哨兵内置工具结果摘要（AGENTS.md：新增内置工具须补成功/失败/缺参三态回归）。
 * list 返回 {total, watchers}；create 成功返回 {success, message}，失败统一 {error}。
 */
describe('signal watcher result summary', () => {
  it('list success shows the watcher count from total', () => {
    const result = JSON.stringify({ total: 2, watchers: [{ watcher_id: 1 }, { watcher_id: 2 }] });
    expect(ToolResultSummarizer.summarize('list_signal_watchers', '{}', result))
      .toBe('信号哨兵列表 (2 个)');
  });

  it('list success falls back to the watchers array length', () => {
    const result = JSON.stringify({ watchers: [{ watcher_id: 1 }] });
    expect(ToolResultSummarizer.summarize('list_signal_watchers', '{}', result))
      .toBe('信号哨兵列表 (1 个)');
  });

  it('list failure shows the error reason', () => {
    const result = JSON.stringify({ error: '无法获取当前用户信息' });
    expect(ToolResultSummarizer.summarize('list_signal_watchers', '{}', result))
      .toBe('查询信号哨兵 (失败: 无法获取当前用户信息)');
  });

  it('create success shows the created watcher message', () => {
    const args = JSON.stringify({ name: '美元汇率变化', probe_type: 'HTTP' });
    const result = JSON.stringify({
      success: true,
      watcher_id: 7,
      name: '美元汇率变化',
      message: "哨兵 '美元汇率变化' 已创建并开始按 30 分钟间隔轮询；首轮建立基线，之后判定值变化才会触发会话。",
    });
    expect(ToolResultSummarizer.summarize('create_signal_watcher', args, result))
      .toBe("哨兵 '美元汇率变化' 已创建并开始按 30 分钟间隔轮询；首轮建立基线，之后判定值变化才会触发会话。");
  });

  it('create failure keeps the watcher name and the error reason', () => {
    const args = JSON.stringify({ name: '服务器状态', probe_type: 'SCRIPT' });
    const result = JSON.stringify({ error: '脚本文件不存在' });
    expect(ToolResultSummarizer.summarize('create_signal_watcher', args, result))
      .toBe('创建信号哨兵 服务器状态 (失败: 脚本文件不存在)');
  });

  it('create missing required script_path stays readable', () => {
    const args = JSON.stringify({ name: '服务器状态', probe_type: 'SCRIPT' });
    const result = JSON.stringify({ error: '脚本哨兵必须提供 script_path：请先用文件工具把脚本写进项目工作区，再创建哨兵' });
    expect(ToolResultSummarizer.summarize('create_signal_watcher', args, result))
      .toContain('创建信号哨兵 服务器状态 (失败: 脚本哨兵必须提供 script_path');
  });

  it('create without a name or result falls back to the generic label', () => {
    expect(ToolResultSummarizer.summarize('create_signal_watcher', '{}', null))
      .toBe('创建信号哨兵');
  });
});

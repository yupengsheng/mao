import { describe, expect, it, vi } from 'vitest';
import { SessionChannelMappingRepository } from './session-channel-mapping.repository.js';

function build(affectedRows = 0) {
  const execute = vi.fn(async () => ({ affectedRows }));
  const repo = new SessionChannelMappingRepository({ execute } as never);
  return { repo, execute };
}

describe('SessionChannelMappingRepository.deleteBySessionId', () => {
  it('回收三张通道映射表中属于该会话的行', async () => {
    const { repo, execute } = build();

    await repo.deleteBySessionId(42);

    expect(execute).toHaveBeenNthCalledWith(1, expect.stringContaining('DELETE FROM weixin_session_peer'), [42]);
    expect(execute).toHaveBeenNthCalledWith(2, expect.stringContaining('DELETE FROM feishu_thread_session'), [42]);
    expect(execute).toHaveBeenNthCalledWith(3, expect.stringContaining('DELETE FROM feishu_session_channel'), [42]);
  });
});

describe('SessionChannelMappingRepository orphan batches', () => {
  it('微信映射只清理会话不存在或已逻辑删除的行', async () => {
    const { repo, execute } = build(3);

    await expect(repo.deleteOrphanWeixinPeerBatch(5000)).resolves.toBe(3);

    const sql = String(execute.mock.calls[0][0]);
    expect(sql).toContain('DELETE FROM weixin_session_peer');
    expect(sql).toContain('LEFT JOIN `session` s ON s.id = p.session_id');
    expect(sql).toContain('s.id IS NULL OR s.deleted = 1');
    expect(sql).toContain('ORDER BY p.session_id');
    expect(execute).toHaveBeenCalledWith(expect.any(String), [5000]);
  });

  it('飞书话题映射按 id 稳定排序删除', async () => {
    const { repo, execute } = build(2);

    await expect(repo.deleteOrphanFeishuThreadBatch(10)).resolves.toBe(2);

    const sql = String(execute.mock.calls[0][0]);
    expect(sql).toContain('DELETE FROM feishu_thread_session WHERE id IN');
    expect(sql).toContain('ORDER BY p.id');
    expect(execute).toHaveBeenCalledWith(expect.any(String), [10]);
  });

  it('飞书通道绑定只清理孤儿会话', async () => {
    const { repo, execute } = build(1);

    await expect(repo.deleteOrphanFeishuSessionChannelBatch(1)).resolves.toBe(1);

    const sql = String(execute.mock.calls[0][0]);
    expect(sql).toContain('DELETE FROM feishu_session_channel');
    expect(sql).toContain('s.id IS NULL OR s.deleted = 1');
  });

  it('LIMIT 钳制在 1~5000，非法值回落 1', async () => {
    const { repo, execute } = build();

    await repo.deleteOrphanWeixinPeerBatch(0);
    await repo.deleteOrphanWeixinPeerBatch(Number.NaN);
    await repo.deleteOrphanWeixinPeerBatch(Number.POSITIVE_INFINITY);
    await repo.deleteOrphanWeixinPeerBatch(99999);
    await repo.deleteOrphanWeixinPeerBatch(12.9);

    expect(execute.mock.calls.map((call) => call[1])).toEqual([[1], [1], [1], [5000], [12]]);
  });
});

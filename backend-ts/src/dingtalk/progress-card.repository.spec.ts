import { describe, expect, it, vi } from 'vitest';
import { mapProgressCardRow, MysqlDingtalkProgressCardRepository } from './progress-card.repository.js';

function build(affectedRows = 0) {
  const execute = vi.fn(async () => ({ affectedRows }));
  const repo = new MysqlDingtalkProgressCardRepository({ execute } as never);
  return { repo, execute };
}

describe('mapProgressCardRow', () => {
  it('finds a card by outTrackId fields from either camel or snake case', () => {
    expect(mapProgressCardRow({
      session_id: 9, bot_id: 2, out_track_id: 'track-9', chat_type: 'p2p', conversation_id: 'cid', sender_userid: 'staff',
    })).toEqual({
      sessionId: 9, botId: 2, outTrackId: 'track-9', chatType: 'p2p', conversationId: 'cid', senderUserid: 'staff',
    });
  });
});

describe('MysqlDingtalkProgressCardRepository.deleteStaleBatch', () => {
  it('按 updated_at 清理会话不存在、已删除或非活跃相位的映射', async () => {
    const { repo, execute } = build(37);

    await expect(repo.deleteStaleBatch('2026-05-09 12:00:00', 5000)).resolves.toBe(37);

    const sql = String(execute.mock.calls[0][0]);
    expect(execute).toHaveBeenCalledWith(expect.any(String), ['2026-05-09 12:00:00']);
    expect(sql).toContain('p.updated_at < ?');
    expect(sql).toContain('LEFT JOIN session s ON s.id = p.session_id');
    expect(sql).toContain('s.id IS NULL');
    expect(sql).toContain('s.deleted = 1');
    expect(sql).toContain('s.phase IS NULL');
    expect(sql).toContain("s.phase NOT IN ('RUNNING', 'RESUMING', 'WAITING_APPROVAL', 'CANCELLING')");
    expect(sql).toContain('ORDER BY p.updated_at, p.session_id');
    expect(sql).toContain('LIMIT 5000');
  });

  it('LIMIT 钳制在 1~5000，非法值不会拼进 SQL', async () => {
    const { repo, execute } = build();

    await repo.deleteStaleBatch('2026-05-09 12:00:00', 0);
    await repo.deleteStaleBatch('2026-05-09 12:00:00', Number.NaN);
    await repo.deleteStaleBatch('2026-05-09 12:00:00', Number.POSITIVE_INFINITY);
    await repo.deleteStaleBatch('2026-05-09 12:00:00', 99999);
    await repo.deleteStaleBatch('2026-05-09 12:00:00', 12.9);

    expect(execute.mock.calls[0][0]).toContain('LIMIT 1');
    expect(execute.mock.calls[1][0]).toContain('LIMIT 1');
    expect(execute.mock.calls[2][0]).toContain('LIMIT 1');
    expect(execute.mock.calls[3][0]).toContain('LIMIT 5000');
    expect(execute.mock.calls[4][0]).toContain('LIMIT 12');
    for (const [sql] of execute.mock.calls) {
      expect(String(sql)).not.toContain('LIMIT ?');
    }
  });
});

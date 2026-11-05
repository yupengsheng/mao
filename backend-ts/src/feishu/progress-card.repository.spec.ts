import { describe, expect, it, vi } from 'vitest';
import { mapProgressCardRow, MysqlFeishuProgressCardRepository } from './progress-card.repository.js';

function fakeDb() {
  return {
    queryOne: vi.fn(),
    execute: vi.fn().mockResolvedValue(undefined),
  };
}

describe('MysqlFeishuProgressCardRepository', () => {
  it('upsertWritesSessionScopedRow', async () => {
    const db = fakeDb();
    const repo = new MysqlFeishuProgressCardRepository(db as never);
    await repo.upsert({
      sessionId: 7, botId: 3, cardMessageId: 'om_card_1',
      chatType: 'group', chatId: 'oc_chat', senderOpenId: 'ou_sender',
    });
    expect(db.execute).toHaveBeenCalledWith(
      expect.stringContaining('ON DUPLICATE KEY UPDATE'),
      [7, 3, 'om_card_1', 'group', 'oc_chat', 'ou_sender'],
    );
  });

  it('findBySessionIdMapsCamelCaseRowFromDb', async () => {
    const db = fakeDb();
    db.queryOne.mockResolvedValue({
      sessionId: 7, botId: 3, cardMessageId: 'om_card_1',
      chatType: 'group', chatId: 'oc_chat', senderOpenId: 'ou_sender',
    });
    const repo = new MysqlFeishuProgressCardRepository(db as never);
    const row = await repo.findBySessionId(7);
    expect(row).toEqual({
      sessionId: 7, botId: 3, cardMessageId: 'om_card_1',
      chatType: 'group', chatId: 'oc_chat', senderOpenId: 'ou_sender',
    });
    expect(db.queryOne).toHaveBeenCalledWith(expect.stringContaining('WHERE session_id = ?'), [7]);
  });

  it('findBySessionIdMapsSnakeCaseRow', async () => {
    const db = fakeDb();
    db.queryOne.mockResolvedValue({
      session_id: 7, bot_id: 3, card_message_id: 'om_card_1',
      chat_type: 'group', chat_id: 'oc_chat', sender_open_id: 'ou_sender',
    });
    const repo = new MysqlFeishuProgressCardRepository(db as never);
    expect(await repo.findBySessionId(7)).toEqual({
      sessionId: 7, botId: 3, cardMessageId: 'om_card_1',
      chatType: 'group', chatId: 'oc_chat', senderOpenId: 'ou_sender',
    });
  });

  it('mapProgressCardRowRejectsIncompleteCamelCase', () => {
    expect(mapProgressCardRow({ sessionId: 7, botId: undefined, cardMessageId: undefined })).toBeNull();
  });

  it('findBySessionIdReturnsNullWhenMissing', async () => {
    const db = fakeDb();
    db.queryOne.mockResolvedValue(null);
    const repo = new MysqlFeishuProgressCardRepository(db as never);
    expect(await repo.findBySessionId(404)).toBeNull();
  });

  it('deleteBySessionIdRemovesRow', async () => {
    const db = fakeDb();
    const repo = new MysqlFeishuProgressCardRepository(db as never);
    await repo.deleteBySessionId(7);
    expect(db.execute).toHaveBeenCalledWith(expect.stringContaining('DELETE FROM feishu_progress_card'), [7]);
  });
});

describe('MysqlFeishuProgressCardRepository.deleteStaleBatch', () => {
  function build(affectedRows = 0) {
    const execute = vi.fn(async () => ({ affectedRows }));
    const repo = new MysqlFeishuProgressCardRepository({ execute } as never);
    return { repo, execute };
  }

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
    expect(sql).toContain('ORDER BY p.updated_at, p.id');
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

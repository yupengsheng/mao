import { describe, expect, it, vi } from 'vitest';
import type mysql from 'mysql2/promise';
import { Db } from '../db/db.js';
import { MysqlDingtalkMessageRepository } from './message.repository.js';

function setup(rows: Record<string, unknown>[] = []) {
  const query = vi.fn(async () => [rows, []]);
  const execute = vi.fn(async () => [{ affectedRows: 7 }, []]);
  const db = new Db({ query, execute } as unknown as mysql.Pool);
  return { repo: new MysqlDingtalkMessageRepository(db), query, execute };
}

describe('MysqlDingtalkMessageRepository active conversation pointer', () => {
  it('only returns a pointer whose session still exists', async () => {
    const { repo, query } = setup([{
      id: 1, bot_id: 7, conversation_id: 'cid', chat_type: 'group', session_id: 9, owner_user_id: 3,
    }]);

    await expect(repo.findConversation(7, 'cid')).resolves.toMatchObject({ sessionId: 9 });
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('JOIN `session` s ON s.id = c.session_id AND s.deleted = 0'),
      [7, 'cid'],
    );
  });

  it('refreshes chat type, owner and workspace when switching the active session', async () => {
    const { repo, execute } = setup([{
      id: 1, bot_id: 7, conversation_id: 'cid', chat_type: 'p2p', session_id: 10, owner_user_id: 3,
    }]);

    await repo.saveConversation({
      botId: 7, conversationId: 'cid', chatType: 'p2p', sessionId: 10, ownerUserId: 3, workspace: '/ws', title: null,
    });

    const sql = execute.mock.calls[0][0] as string;
    expect(sql).toContain('chat_type = VALUES(chat_type)');
    expect(sql).toContain('session_id = VALUES(session_id)');
    expect(sql).toContain('owner_user_id = VALUES(owner_user_id)');
    expect(sql).toContain('workspace = VALUES(workspace)');
    expect(sql).toContain('title = COALESCE(VALUES(title), title)');
  });
});

describe('MysqlDingtalkMessageRepository inbound event cleanup', () => {
  it('deletes expired rows in id order with a clamped limit', async () => {
    const { repo, execute } = setup();

    await expect(repo.deleteInboundBatch('2026-10-05 00:00:00', 999999)).resolves.toBe(7);

    expect(execute).toHaveBeenCalledWith(
      'DELETE FROM dingtalk_inbound_event WHERE created_at < ? ORDER BY id LIMIT 5000',
      ['2026-10-05 00:00:00'],
    );
  });

  it('keeps at least one row per batch for a non-positive limit', async () => {
    const { repo, execute } = setup();

    await repo.deleteInboundBatch('2026-10-05 00:00:00', -1);

    expect(execute).toHaveBeenCalledWith(expect.stringContaining('LIMIT 1'), ['2026-10-05 00:00:00']);
  });
});

describe('MysqlDingtalkMessageRepository group message log cleanup', () => {
  it('deletes expired rows ordered by created_at and id with a clamped limit', async () => {
    const { repo, execute } = setup();

    await expect(repo.deleteGroupMessageBatch('2026-10-06 00:00:00', 999999)).resolves.toBe(7);

    expect(execute).toHaveBeenCalledWith(
      `DELETE FROM dingtalk_group_message_log
       WHERE created_at < ?
       ORDER BY created_at, id LIMIT 5000`,
      ['2026-10-06 00:00:00'],
    );
  });

  it('keeps at least one row per batch for a non-positive limit', async () => {
    const { repo, execute } = setup();

    await repo.deleteGroupMessageBatch('2026-10-06 00:00:00', -1);

    expect(execute).toHaveBeenCalledWith(expect.stringContaining('LIMIT 1'), ['2026-10-06 00:00:00']);
  });
});

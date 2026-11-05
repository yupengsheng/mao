import { describe, expect, it, vi } from 'vitest';
import type mysql from 'mysql2/promise';
import { Db } from '../db/db.js';
import { MysqlDingtalkMessageRepository } from './message.repository.js';

function setup() {
  const query = vi.fn(async () => [[], []]);
  const execute = vi.fn(async () => [{ affectedRows: 7 }, []]);
  const db = new Db({ query, execute } as unknown as mysql.Pool);
  return { repo: new MysqlDingtalkMessageRepository(db), execute };
}

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

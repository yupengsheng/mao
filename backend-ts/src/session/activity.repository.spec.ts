import { describe, expect, it, vi } from 'vitest';
import type mysql from 'mysql2/promise';
import { Db } from '../db/db.js';
import { SessionActivityRepository } from './activity.repository.js';

function setup(affectedRows = 7) {
  const execute = vi.fn(async () => [{ affectedRows }, []]);
  const db = new Db({ execute } as unknown as mysql.Pool);
  return { repo: new SessionActivityRepository(db), execute };
}

describe('SessionActivityRepository.deleteBatch', () => {
  it('按创建时间删除并返回影响行数', async () => {
    const { repo, execute } = setup(7);

    await expect(repo.deleteBatch('2026-05-09 12:00:00', 1000)).resolves.toBe(7);
    expect(execute).toHaveBeenCalledWith(
      'DELETE FROM session_activity WHERE created_at < ? ORDER BY created_at, id LIMIT 1000',
      ['2026-05-09 12:00:00'],
    );
  });

  it('批量上限钳制在 1~5000', async () => {
    const { repo, execute } = setup();

    await repo.deleteBatch('2026-05-09 12:00:00', 999999);
    expect(execute).toHaveBeenLastCalledWith(
      'DELETE FROM session_activity WHERE created_at < ? ORDER BY created_at, id LIMIT 5000',
      ['2026-05-09 12:00:00'],
    );

    await repo.deleteBatch('2026-05-09 12:00:00', 0);
    expect(execute).toHaveBeenLastCalledWith(
      'DELETE FROM session_activity WHERE created_at < ? ORDER BY created_at, id LIMIT 1',
      ['2026-05-09 12:00:00'],
    );
  });
});

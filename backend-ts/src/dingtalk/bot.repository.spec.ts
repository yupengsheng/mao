import { describe, expect, it, vi } from 'vitest';
import { MysqlDingtalkBotRepository } from './bot.repository.js';

function mockDb() {
  return {
    query: vi.fn(async () => [{ id: 1 }]),
    queryOne: vi.fn(async () => ({ c: 7 })),
  };
}

describe('MysqlDingtalkBotRepository', () => {
  it('paginates and searches by name, client id or robot code', async () => {
    const db = mockDb();
    const repo = new MysqlDingtalkBotRepository(db as never);

    await expect(repo.listPage(2, 10, 'support')).resolves.toEqual({ records: [{ id: 1 }], total: 7 });
    expect(db.queryOne).toHaveBeenLastCalledWith(
      expect.stringContaining('(name LIKE ? OR client_id LIKE ? OR robot_code LIKE ?)'),
      ['%support%', '%support%', '%support%'],
    );
    expect(db.query).toHaveBeenLastCalledWith(
      expect.stringContaining('LIMIT ? OFFSET ?'),
      ['%support%', '%support%', '%support%', 10, 10],
    );

    await repo.listPage(1, 20, '100%_done');
    expect(db.query).toHaveBeenLastCalledWith(
      expect.stringContaining('LIMIT ? OFFSET ?'),
      ['%100\\%\\_done%', '%100\\%\\_done%', '%100\\%\\_done%', 20, 0],
    );

    await repo.listPage(1, 20);
    expect(String(db.queryOne.mock.calls.at(-1)?.[0])).not.toContain('LIKE');
    expect(db.query).toHaveBeenLastCalledWith(
      expect.stringContaining('LIMIT ? OFFSET ?'),
      [20, 0],
    );
  });
});

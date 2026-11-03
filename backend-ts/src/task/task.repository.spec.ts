import { describe, expect, it, vi } from 'vitest';
import type { Db } from '../db/db.js';
import { TaskRepository } from './task.repository.js';

describe('TaskRepository', () => {
  it('uses identical owner and live-session filters for pagination and count', async () => {
    const db = {
      query: vi.fn().mockResolvedValue([{ id: 3 }]),
      queryOne: vi.fn().mockResolvedValue({ total: '1' }),
    };
    const repo = new TaskRepository(db as unknown as Db);
    const result = await repo.page({ userId: 7, stage: 'WORKING', source: 'API', agentId: 2, sessionId: 5, page: 3, size: 10 });
    const [listSql, listParams] = db.query.mock.calls[0]!;
    const [countSql, countParams] = db.queryOne.mock.calls[0]!;
    expect(listSql).toContain('user_id = ? AND deleted = 0 AND EXISTS');
    expect(listSql).toContain('s.user_id = agent_task.user_id AND s.deleted = 0');
    expect(listSql.split(' WHERE ')[1]!.split(' ORDER BY ')[0]).toBe(countSql.split(' WHERE ')[1]);
    expect(listParams).toEqual([7, 'WORKING', 'API', 2, 5, 10, 20]);
    expect(countParams).toEqual([7, 'WORKING', 'API', 2, 5]);
    expect(result).toEqual({ items: [{ id: 3 }], total: 1, page: 3, size: 10 });
  });

  it('hides deleted or reassigned sessions when reading details', async () => {
    const db = { queryOne: vi.fn().mockResolvedValue(null) };
    const repo = new TaskRepository(db as unknown as Db);
    expect(await repo.findById(7, 4)).toBeNull();
    expect(db.queryOne).toHaveBeenCalledWith(expect.stringContaining('s.user_id = agent_task.user_id AND s.deleted = 0'), [7, 4]);
  });

  it('locks the owned session and writes through the transaction connection', async () => {
    const tx = { queryOne: vi.fn().mockResolvedValue({ id: 5 }), insert: vi.fn().mockResolvedValue(8) };
    const db = { transaction: vi.fn(async (work: (connection: unknown) => Promise<unknown>) => work(tx)) };
    const repo = new TaskRepository(db as unknown as Db);
    await repo.transaction(async (locked) => {
      await locked.lockSession(7, 5);
      await locked.insertTrigger({ taskId: 4, sessionId: 5, source: 'API', sourceEventId: 'run-1' });
    });
    expect(tx.queryOne).toHaveBeenCalledWith(expect.stringContaining('deleted = 0 FOR UPDATE'), [5, 7]);
    expect(tx.insert).toHaveBeenCalledWith('agent_task_trigger', expect.objectContaining({ sourceEventId: 'run-1' }));
    expect(db.transaction).toHaveBeenCalledOnce();
  });

  it('propagates write errors so the database transaction can roll back', async () => {
    const failure = new Error('duplicate execution');
    const tx = { insert: vi.fn().mockRejectedValue(failure) };
    const db = { transaction: vi.fn(async (work: (connection: unknown) => Promise<unknown>) => work(tx)) };
    const repo = new TaskRepository(db as unknown as Db);
    await expect(repo.transaction((locked) => locked.insertTrigger({ taskId: 4, sessionId: 5, source: 'API', sourceEventId: 'run-1' }))).rejects.toBe(failure);
  });
});

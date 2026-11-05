import { describe, expect, it, vi } from 'vitest';
import type { Db } from '../db/db.js';
import { ScheduledTaskDbStore } from './scheduled-task.store.js';

function build() {
  const tx = { execute: vi.fn(async () => ({ affectedRows: 1 })) };
  const db = {
    transaction: vi.fn(async (fn: (db: unknown) => Promise<unknown>) => fn(tx)),
  };
  return { store: new ScheduledTaskDbStore(db as unknown as Db), tx };
}

describe('ScheduledTaskDbStore.deleteBySessionId', () => {
  it('软删任务并收口排队 / 未开跑运行记录', async () => {
    const { store, tx } = build();

    await store.deleteBySessionId(42);

    expect(tx.execute).toHaveBeenNthCalledWith(
      1,
      'UPDATE scheduled_task SET deleted = 1 WHERE session_id = ? AND deleted = 0',
      [42],
    );
    const cancelSql = String(tx.execute.mock.calls[1]![0]);
    expect(cancelSql).toContain('UPDATE scheduled_task_run r');
    expect(cancelSql).toContain("r.status = 'CANCELLED'");
    expect(cancelSql).toContain("r.status = 'QUEUED'");
    expect(cancelSql).toContain("r.status = 'RUNNING' AND r.started_at IS NULL");
    expect(tx.execute.mock.calls[1]![1]).toEqual([expect.any(String), 42]);

    const retrySql = String(tx.execute.mock.calls[2]![0]);
    expect(retrySql).toContain('SET r.next_retry_at = NULL');
    expect(tx.execute.mock.calls[2]![1]).toEqual([42]);
  });
});

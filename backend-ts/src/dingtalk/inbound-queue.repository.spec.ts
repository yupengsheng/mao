import { describe, expect, it, vi } from 'vitest';
import { DingtalkInboundQueueRepository } from './inbound-queue.repository.js';

describe('DingtalkInboundQueueRepository.deleteOrphanedBatch', () => {
  it('deletes rows whose session is missing or logically deleted', async () => {
    const execute = vi.fn(async () => ({ affectedRows: 12 }));
    const repo = new DingtalkInboundQueueRepository({ execute } as never);

    await expect(repo.deleteOrphanedBatch(300)).resolves.toBe(12);

    const [sql, params] = execute.mock.calls[0] as unknown as [string, unknown[]];
    expect(sql).toContain('DELETE FROM dingtalk_inbound_queue');
    expect(sql).toContain('LEFT JOIN `session` s ON s.id = q.session_id');
    expect(sql).toContain('WHERE s.id IS NULL OR s.deleted = 1');
    expect(params).toEqual([300]);
  });

  it('clamps the batch limit', async () => {
    const execute = vi.fn(async () => ({ affectedRows: 0 }));
    const repo = new DingtalkInboundQueueRepository({ execute } as never);

    await repo.deleteOrphanedBatch(0);
    await repo.deleteOrphanedBatch(Number.POSITIVE_INFINITY);
    await repo.deleteOrphanedBatch(99999);

    expect(execute.mock.calls.map((call) => (call[1] as unknown[])[0])).toEqual([1, 1, 5000]);
  });
});

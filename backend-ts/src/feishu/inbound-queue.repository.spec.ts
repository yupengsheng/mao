import { describe, expect, it, vi } from 'vitest';
import { FeishuInboundQueueRepository } from './inbound-queue.repository.js';

describe('FeishuInboundQueueRepository.deleteOrphanedBatch', () => {
  it('deletes rows whose session is missing or logically deleted', async () => {
    const execute = vi.fn(async () => ({ affectedRows: 9 }));
    const repo = new FeishuInboundQueueRepository({ execute } as never);

    await expect(repo.deleteOrphanedBatch(250)).resolves.toBe(9);

    const [sql, params] = execute.mock.calls[0] as unknown as [string, unknown[]];
    expect(sql).toContain('DELETE FROM feishu_inbound_queue');
    expect(sql).toContain('LEFT JOIN `session` s ON s.id = q.session_id');
    expect(sql).toContain('WHERE s.id IS NULL OR s.deleted = 1');
    expect(params).toEqual([250]);
  });

  it('clamps the batch limit', async () => {
    const execute = vi.fn(async () => ({ affectedRows: 0 }));
    const repo = new FeishuInboundQueueRepository({ execute } as never);

    await repo.deleteOrphanedBatch(0);
    await repo.deleteOrphanedBatch(Number.NaN);
    await repo.deleteOrphanedBatch(99999);

    expect(execute.mock.calls.map((call) => (call[1] as unknown[])[0])).toEqual([1, 1, 5000]);
  });
});

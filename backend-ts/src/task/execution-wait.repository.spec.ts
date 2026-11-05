import { describe, expect, it, vi } from 'vitest';
import { ExecutionWaitRepository } from './execution-wait.repository.js';
import type { Db } from '../db/db.js';

describe('ExecutionWaitRepository', () => {
  function repository(affectedRows = 1) {
    const execute = vi.fn().mockResolvedValue({ affectedRows });
    const repo = new ExecutionWaitRepository({ execute } as unknown as Db);
    return { repo, execute };
  }

  it('inserts an idempotent pending wait with database-side expiry', async () => {
    const { repo, execute } = repository();
    await repo.insertPending({
      sessionId: 11,
      executionId: 'exec-1',
      requestType: 'QUESTION',
      requestId: 'req-1',
      payloadSummary: '{"questionCount":1}',
      payloadDigest: 'digest',
    });

    const [sql, params] = execute.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("VALUES (?, ?, ?, ?, 'PENDING', ?, ?");
    expect(sql).toContain('DATE_ADD(CURRENT_TIMESTAMP, INTERVAL 960 SECOND)');
    expect(sql).toContain('ON DUPLICATE KEY UPDATE id = id');
    expect(params).toEqual([11, 'exec-1', 'QUESTION', 'req-1', '{"questionCount":1}', 'digest']);
  });

  it('only releases rows that are still pending', async () => {
    const { repo, execute } = repository(1);
    await expect(repo.release(11, 'APPROVAL', 'req-1', 'APPROVED')).resolves.toBe(true);

    const [sql, params] = execute.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("SET status = 'RELEASED'");
    expect(sql).toContain("AND status = 'PENDING'");
    expect(params).toEqual(['APPROVED', 11, 'APPROVAL', 'req-1']);
  });

  it('reports a false release when another path already settled the row', async () => {
    const { repo } = repository(0);
    await expect(repo.release(11, 'QUESTION', 'req-1', 'TIMEOUT')).resolves.toBe(false);
  });
});

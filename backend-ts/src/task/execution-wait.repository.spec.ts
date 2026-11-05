import { describe, expect, it, vi } from 'vitest';
import { ExecutionWaitRepository } from './execution-wait.repository.js';
import type { Db } from '../db/db.js';

describe('ExecutionWaitRepository', () => {
  function repository(affectedRows = 1) {
    const execute = vi.fn().mockResolvedValue({ affectedRows });
    const query = vi.fn().mockResolvedValue([]);
    const db = {
      execute,
      query,
      queryOne: vi.fn().mockResolvedValue(null),
      transaction: <T>(fn: (tx: unknown) => Promise<T>) => fn(db),
    };
    const repo = new ExecutionWaitRepository(db as unknown as Db);
    return { repo, execute, query, queryOne: db.queryOne };
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
    expect(sql).toContain("VALUES (?, ?, ?, ?, 'PENDING', ?, ?, DATE_ADD");
    expect(sql).toContain('DATE_ADD(CURRENT_TIMESTAMP, INTERVAL 960 SECOND)');
    expect(sql).toContain('ON DUPLICATE KEY UPDATE id = id');
    expect(params).toEqual([11, 'exec-1', 'QUESTION', 'req-1', '{"questionCount":1}', 'digest', '0']);
  });

  it('persists the execution fencing token when supplied', async () => {
    const { repo, execute } = repository();
    await repo.insertPending({
      sessionId: 11,
      executionId: 'exec-1',
      requestType: 'APPROVAL',
      requestId: 'req-2',
      payloadSummary: 'approval',
      payloadDigest: 'digest',
      fencingToken: 9n,
    });

    const [, params] = execute.mock.calls[0] as [string, unknown[]];
    expect(params.at(-1)).toBe('9');
  });

  it('lists pending rows including expired ones without hiding their execution', async () => {
    const { repo, query } = repository();
    query.mockResolvedValueOnce([
      {
        id: '3', sessionId: 11, executionId: 'exec-1', requestType: 'APPROVAL',
        requestId: 'req-1', payloadSummary: '审批 read_file', expiresAt: '2026-11-05 10:00:00',
        fencingToken: '7', expired: 1, recovered: 1,
      },
      {
        id: '4', sessionId: 11, executionId: 'exec-1', requestType: 'QUESTION',
        requestId: 'req-2', payloadSummary: '确认继续', expiresAt: '2026-11-05 12:00:00',
        fencingToken: '7', expired: 0, recovered: 0,
      },
    ]);

    const rows = await repo.listPending(11, 'exec-1', 9n);

    const [sql, params] = query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("status = 'PENDING'");
    expect(sql).toContain('execution_id = ?');
    expect(sql).toContain('fencing_token <= ?');
    expect(sql).toContain('ORDER BY id ASC');
    expect(params).toEqual([11, 'exec-1', '9']);
    expect(rows).toEqual([
      expect.objectContaining({ id: 3, requestType: 'APPROVAL', fencingToken: 7n, expired: true, recovered: true }),
      expect.objectContaining({ id: 4, requestType: 'QUESTION', fencingToken: 7n, expired: false, recovered: false }),
    ]);
  });

  it('finds the earliest live pending wait for task and session detail', async () => {
    const { repo, queryOne } = repository();
    queryOne.mockResolvedValueOnce({
      id: '5', sessionId: 11, executionId: 'exec-1', requestType: 'APPROVAL',
      requestId: 'req-earliest', payloadSummary: '审批 read_file', expiresAt: '2026-11-05 10:00:00',
      fencingToken: '7', expired: 0, recovered: 1,
    });

    const wait = await repo.findEarliestPending(11, 'exec-1');

    const [sql, params] = queryOne.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("status = 'PENDING'");
    expect(sql).toContain('expires_at >= CURRENT_TIMESTAMP');
    expect(sql).toContain('execution_id = ?');
    expect(sql).toContain('ORDER BY expires_at ASC, id ASC');
    expect(sql).toContain('LIMIT 1');
    expect(params).toEqual([11, 'exec-1']);
    expect(wait).toEqual(expect.objectContaining({
      requestId: 'req-earliest', recovered: true, expired: false,
    }));
  });

  it('counts live pending waits by session and kind', async () => {
    const { repo, query } = repository();
    query.mockResolvedValueOnce([
      { sessionId: 11, requestType: 'APPROVAL', cnt: '2' },
      { sessionId: 11, requestType: 'QUESTION', cnt: 1 },
      { sessionId: 12, requestType: 'QUESTION', cnt: '3' },
    ]);

    const counts = await repo.countPendingBySessionIds([11, 12, 11, 0]);

    const [sql, params] = query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("status = 'PENDING'");
    expect(sql).toContain('expires_at >= CURRENT_TIMESTAMP');
    expect(sql).toContain('GROUP BY session_id, request_type');
    expect(params).toEqual([11, 12]);
    expect(counts.get(11)).toEqual({ approval: 2, question: 1 });
    expect(counts.get(12)).toEqual({ approval: 0, question: 3 });
  });

  it('marks only live unrecovered waits and returns newly marked ids', async () => {
    const { repo, query, execute } = repository();
    query.mockResolvedValueOnce([{ id: '3' }, { id: '4' }]);

    await expect(repo.markRecovered([3, 4, 4, 5], 9n)).resolves.toEqual([3, 4]);

    const [selectSql, selectParams] = query.mock.calls[0] as [string, unknown[]];
    expect(selectSql).toContain('recovered_at IS NULL');
    expect(selectSql).toContain('fencing_token <= ?');
    expect(selectSql).toContain('FOR UPDATE');
    expect(selectParams).toEqual([3, 4, 5, '9']);
    const [updateSql, updateParams] = execute.mock.calls[0] as [string, unknown[]];
    expect(updateSql).toContain('SET recovered_at = CURRENT_TIMESTAMP');
    expect(updateParams).toEqual([3, 4]);
  });

  it('returns no newly marked ids when every wait was already recovered', async () => {
    const { repo, execute } = repository();
    await expect(repo.markRecovered([3, 4], 9n)).resolves.toEqual([]);
    expect(execute).not.toHaveBeenCalled();
  });

  it('releases all pending waits after a terminal settlement', async () => {
    const { repo, execute } = repository(3);
    await expect(repo.releaseAllPending(11, 'CANCELLED', 9n)).resolves.toBe(3);

    const [sql, params] = execute.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("SET status = 'RELEASED'");
    expect(sql).toContain("release_reason = ?");
    expect(sql).toContain("status = 'PENDING'");
    expect(sql).toContain('fencing_token <= ?');
    expect(params).toEqual(['CANCELLED', 11, '9']);
  });

  it('expires only pending rows at or below the claim token', async () => {
    const { repo, execute } = repository(1);
    await expect(repo.expire(3, 9n)).resolves.toBe(true);

    const [sql, params] = execute.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("SET status = 'EXPIRED'");
    expect(sql).toContain("release_reason = 'TIMEOUT'");
    expect(sql).toContain("status = 'PENDING'");
    expect(sql).toContain('fencing_token <= ?');
    expect(params).toEqual([3, '9']);
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

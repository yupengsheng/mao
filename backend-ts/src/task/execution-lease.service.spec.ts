import { describe, expect, it, vi } from 'vitest';
import type { Db } from '../db/db.js';
import {
  EXECUTION_LEASE_TTL_SECONDS,
  ExecutionLeaseService,
  type LeaseHandle,
} from './execution-lease.service.js';

const EXPIRES_AT = '2026-11-05 16:00:00';

function leaseRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    sessionId: 11,
    executionId: 'exec-1',
    ownerInstance: 'node-a',
    fencingToken: '1',
    status: 'ACTIVE',
    expiresAt: EXPIRES_AT,
    active: 1,
    ...overrides,
  };
}

function txMock() {
  return {
    queryOne: vi.fn(),
    execute: vi.fn().mockResolvedValue({ affectedRows: 1 }),
  };
}

function fixture(tx = txMock()) {
  const db = {
    transaction: vi.fn((work: (db: unknown) => Promise<unknown>) => work(tx)),
    execute: vi.fn().mockResolvedValue({ affectedRows: 1 }),
    queryOne: vi.fn(),
  } as unknown as Db;
  return { service: new ExecutionLeaseService(db), db, tx };
}

function handle(overrides: Partial<LeaseHandle> = {}): LeaseHandle {
  return {
    sessionId: 11,
    executionId: 'exec-1',
    ownerInstance: 'node-a',
    fencingToken: 7n,
    expiresAt: new Date('2026-11-05T08:00:00.000Z'),
    ...overrides,
  };
}

describe('ExecutionLeaseService', () => {
  describe('acquire', () => {
    it('inserts a first lease with token 1 and database-side expiry', async () => {
      const { service, tx } = fixture();
      tx.queryOne.mockResolvedValueOnce(null).mockResolvedValueOnce(leaseRow());

      const acquired = await service.acquire(11, 'exec-1', 'node-a');

      expect(acquired).toMatchObject({
        sessionId: 11,
        executionId: 'exec-1',
        ownerInstance: 'node-a',
        fencingToken: 1n,
      });
      expect(acquired?.expiresAt.toISOString()).toBe('2026-11-05T08:00:00.000Z');
      const [selectSql, selectParams] = tx.queryOne.mock.calls[0] as [string, unknown[]];
      expect(selectSql).toContain('WHERE session_id = ? FOR UPDATE');
      expect(selectParams).toEqual([11]);

      const [insertSql, insertParams] = tx.execute.mock.calls[0] as [string, unknown[]];
      expect(insertSql).toContain("VALUES (?, ?, ?, 1, 'ACTIVE', CURRENT_TIMESTAMP");
      expect(insertSql).toContain('INTERVAL ? SECOND');
      expect(insertParams).toEqual([11, 'exec-1', 'node-a', EXECUTION_LEASE_TTL_SECONDS]);
    });

    it('rejects a different execution while the current lease is active', async () => {
      const { service, tx } = fixture();
      tx.queryOne.mockResolvedValueOnce(leaseRow({ executionId: 'other-exec' }));

      await expect(service.acquire(11, 'exec-1', 'node-b')).resolves.toBeNull();
      expect(tx.execute).not.toHaveBeenCalled();
    });

    it('returns the original token for a re-entry with the same execution', async () => {
      const { service, tx } = fixture();
      tx.queryOne.mockResolvedValueOnce(leaseRow({ fencingToken: '9', ownerInstance: 'node-a' }));

      const acquired = await service.acquire(11, 'exec-1', 'node-b');

      expect(acquired).toMatchObject({ fencingToken: 9n, ownerInstance: 'node-a' });
      expect(tx.execute).not.toHaveBeenCalled();
    });

    it('takes over an expired lease and increments the fencing token', async () => {
      const { service, tx } = fixture();
      tx.queryOne
        .mockResolvedValueOnce(leaseRow({ fencingToken: '9', active: 0, expiresAt: '2026-11-05 15:00:00' }))
        .mockResolvedValueOnce(leaseRow({ executionId: 'exec-2', fencingToken: '10' }));

      const acquired = await service.acquire(11, 'exec-2', 'node-b');

      expect(acquired).toMatchObject({ executionId: 'exec-2', fencingToken: 10n });
      const [sql, params] = tx.execute.mock.calls[0] as [string, unknown[]];
      expect(sql).toContain('fencing_token = fencing_token + 1');
      expect(sql).toContain("(status <> 'ACTIVE' OR expires_at < CURRENT_TIMESTAMP)");
      expect(params).toEqual(['exec-2', 'node-b', EXECUTION_LEASE_TTL_SECONDS, 11, 1]);
    });

    it('takes over a released lease with a new token', async () => {
      const { service, tx } = fixture();
      tx.queryOne
        .mockResolvedValueOnce(leaseRow({ status: 'RELEASED', active: 0, fencingToken: '3' }))
        .mockResolvedValueOnce(leaseRow({ status: 'ACTIVE', active: 1, fencingToken: '4', executionId: 'exec-2' }));

      await expect(service.acquire(11, 'exec-2', 'node-b')).resolves.toMatchObject({ fencingToken: 4n });
      expect(tx.execute).toHaveBeenCalledOnce();
    });

    it('retries when a concurrent first acquisition hits the unique key', async () => {
      const first = txMock();
      first.queryOne.mockResolvedValueOnce(null);
      first.execute.mockRejectedValueOnce(Object.assign(new Error('Duplicate entry'), { code: 'ER_DUP_ENTRY' }));
      const second = txMock();
      second.queryOne.mockResolvedValueOnce(null).mockResolvedValueOnce(leaseRow());
      const transaction = vi.fn()
        .mockImplementationOnce(async (work: (db: unknown) => Promise<unknown>) => work(first))
        .mockImplementationOnce(async (work: (db: unknown) => Promise<unknown>) => work(second));
      const db = { transaction } as unknown as Db;
      const service = new ExecutionLeaseService(db);

      await expect(service.acquire(11, 'exec-1', 'node-a')).resolves.toMatchObject({ fencingToken: 1n });
      expect(transaction).toHaveBeenCalledTimes(2);
    });

    it('does not retry a non-transient database failure', async () => {
      const failure = Object.assign(new Error('connection reset'), { code: 'ECONNRESET' });
      const transaction = vi.fn(async () => { throw failure; });
      const db = { transaction } as unknown as Db;
      const isolated = new ExecutionLeaseService(db);

      await expect(isolated.acquire(11, 'exec-1', 'node-a')).rejects.toBe(failure);
      expect(transaction).toHaveBeenCalledOnce();
    });

    it('validates identifiers before opening a transaction', async () => {
      const { service, db } = fixture();
      await expect(service.acquire(0, 'exec-1', 'node-a')).rejects.toThrow('sessionId');
      await expect(service.acquire(11, '   ', 'node-a')).rejects.toThrow('executionId');
      await expect(service.acquire(11, 'exec-1', 'x'.repeat(129))).rejects.toThrow('ownerInstance');
      expect(db.transaction).not.toHaveBeenCalled();
    });
  });

  describe('heartbeat', () => {
    it('extends only the matching active, unexpired lease', async () => {
      const { service, db } = fixture();

      await expect(service.heartbeat(handle())).resolves.toBe(true);

      const [sql, params] = (db.execute as ReturnType<typeof vi.fn>).mock.calls[0] as [string, unknown[]];
      expect(sql).toContain('SET heartbeat_at = CURRENT_TIMESTAMP');
      expect(sql).toContain('DATE_ADD(CURRENT_TIMESTAMP, INTERVAL ? SECOND)');
      expect(sql).toContain('fencing_token = ?');
      expect(sql).toContain("status = 'ACTIVE' AND expires_at >= CURRENT_TIMESTAMP");
      expect(params).toEqual([EXECUTION_LEASE_TTL_SECONDS, 11, 'exec-1', '7']);
    });

    it('returns false when the token has been fenced out', async () => {
      const { service, db } = fixture();
      (db.execute as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ affectedRows: 0 });
      await expect(service.heartbeat(handle())).resolves.toBe(false);
    });
  });

  describe('release', () => {
    it('releases only the matching active token', async () => {
      const { service, db } = fixture();
      await service.release(handle());

      const [sql, params] = (db.execute as ReturnType<typeof vi.fn>).mock.calls[0] as [string, unknown[]];
      expect(sql).toContain("SET status = 'RELEASED'");
      expect(sql).toContain('fencing_token = ?');
      expect(sql).toContain("status = 'ACTIVE'");
      expect(params).toEqual([11, 'exec-1', '7']);
    });

    it('is idempotent when the lease is already released', async () => {
      const { service, db } = fixture();
      (db.execute as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ affectedRows: 0 });
      await expect(service.release(handle())).resolves.toBeUndefined();
    });
  });

  describe('assertFenced', () => {
    it('requires session, execution, token, ACTIVE status and future expiry', async () => {
      const { service, db } = fixture();
      (db.queryOne as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ matched: 1 });

      await expect(service.assertFenced(handle())).resolves.toBe(true);

      const [sql, params] = (db.queryOne as ReturnType<typeof vi.fn>).mock.calls[0] as [string, unknown[]];
      expect(sql).toContain('session_id = ? AND execution_id = ? AND fencing_token = ?');
      expect(sql).toContain("status = 'ACTIVE' AND expires_at >= CURRENT_TIMESTAMP");
      expect(params).toEqual([11, 'exec-1', '7']);
    });

    it('returns false after another instance takes over', async () => {
      const { service, db } = fixture();
      (db.queryOne as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null);
      await expect(service.assertFenced(handle())).resolves.toBe(false);
    });
  });

  describe('getRecord', () => {
    it('returns the latest execution even after its lease expired', async () => {
      const { service, db } = fixture();
      (db.queryOne as ReturnType<typeof vi.fn>).mockResolvedValueOnce(leaseRow({
        status: 'ACTIVE', active: 0, expiresAt: '2026-11-05 15:00:00', fencingToken: '9',
      }));

      const record = await service.getRecord(11);

      expect(record).toMatchObject({ executionId: 'exec-1', fencingToken: 9n, status: 'ACTIVE' });
      const [sql, params] = (db.queryOne as ReturnType<typeof vi.fn>).mock.calls[0] as [string, unknown[]];
      expect(sql).toContain('WHERE session_id = ? LIMIT 1');
      expect(sql).not.toContain("WHERE session_id = ? AND status");
      expect(params).toEqual([11]);
    });

    it('reports released leases and returns null when no row exists', async () => {
      const { service, db } = fixture();
      (db.queryOne as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce(leaseRow({ status: 'RELEASED', active: 0 }))
        .mockResolvedValueOnce(null);

      await expect(service.getRecord(11)).resolves.toMatchObject({ status: 'RELEASED' });
      await expect(service.getRecord(11)).resolves.toBeNull();
    });
  });

  it('rejects malformed handles before issuing SQL', async () => {
    const { service, db } = fixture();
    await expect(service.release(handle({ fencingToken: 0n }))).rejects.toThrow('fencingToken');
    expect(db.execute).not.toHaveBeenCalled();
  });

  it('rejects an invalid ttl at construction', () => {
    expect(() => new ExecutionLeaseService({} as Db, 0)).toThrow('ttl');
  });
});

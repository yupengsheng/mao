import { describe, expect, it, vi } from 'vitest';
import type { Db } from '../db/db.js';
import { OpenApiCallLogRepository, type OpenApiCallLogRow, type LockedSessionRow } from './open-api-call-log.repository.js';
import { INTERRUPTED_CALL_ERROR_CODE, INTERRUPTED_CALL_ERROR_SUMMARY, OpenApiCallLogService } from './open-api-call-log.service.js';
import { OpenApiCallLogRepairService } from './open-api-call-log.repair.service.js';

const NOW = new Date('2026-11-05T12:00:00+08:00');

function fixture(input: {
  row?: Partial<OpenApiCallLogRow>;
  session?: Partial<LockedSessionRow> | null;
  pendingQueue?: boolean;
  now?: Date;
  batchSize?: number;
} = {}) {
  const now = input.now ?? NOW;
  const row: OpenApiCallLogRow = {
    id: 1,
    outcome: 'pending',
    sessionId: 11,
    userId: 7,
    source: 'API',
    tokenId: 3,
    replayOfId: null,
    createdAt: '2026-11-05 09:00:00',
    ...input.row,
  };
  const rows = new Map<number, OpenApiCallLogRow>([[row.id!, { ...row }]]);
  const sessions = new Map<number, LockedSessionRow>();
  if (input.session !== null) {
    sessions.set(11, { id: 11, userId: 7, phase: 'COMPLETED', deleted: 0, ...input.session });
  }
  const pending = new Set<number>(input.pendingQueue ? [row.id!] : []);

  const repo = {
    transaction: vi.fn(async (work: (store: unknown) => Promise<unknown>) => work(repo)),
    listRepairCandidates: vi.fn(async (staleBefore: string, limit: number) => [...rows.values()]
      .filter((item) => (item.outcome === 'pending' || item.outcome === 'queued')
        && item.createdAt != null && item.createdAt < staleBefore
        && (item.sessionId != null || item.outcome === 'queued')
        && !pending.has(item.id!))
      .slice(0, limit)
      .map((item) => ({
        id: item.id!,
        outcome: item.outcome!,
        sessionId: item.sessionId ?? null,
        userId: item.userId ?? null,
        source: item.source ?? null,
        tokenId: item.tokenId ?? null,
        replayOfId: item.replayOfId ?? null,
        createdAt: item.createdAt ?? null,
      }))),
    lockById: vi.fn(async (id: number) => rows.get(id) ?? null),
    lockSession: vi.fn(async (id: number) => sessions.get(id) ?? null),
    hasPendingQueue: vi.fn(async (id: number) => pending.has(id)),
    settleStale: vi.fn(async (id: number, patch: Partial<OpenApiCallLogRow> & { outcome: string }) => {
      const item = rows.get(id);
      if (item == null || (item.outcome !== 'pending' && item.outcome !== 'queued')) return false;
      Object.assign(item, patch, { executionMs: 1000 });
      return true;
    }),
  };
  const tokens = {
    findById: async () => ({ id: 3, name: 'ci', logFullBody: 0 }),
    recordTokenOutcome: vi.fn(async () => undefined),
  };
  const callLog = new OpenApiCallLogService({
    repo: repo as unknown as OpenApiCallLogRepository,
    tokens,
    now: () => now.getTime(),
  });
  const repair = new OpenApiCallLogRepairService(
    repo as unknown as OpenApiCallLogRepository,
    callLog,
    { now: () => now, batchSize: input.batchSize ?? 100 },
  );
  return { repair, callLog, repo, rows, sessions, pending, tokens };
}

describe('OpenApiCallLogRepairService', () => {
  it('converges a stale pending call to the terminal session phase', async () => {
    const setup = fixture();

    await expect(setup.repair.repairOnce()).resolves.toBe(1);

    expect(setup.repo.listRepairCandidates).toHaveBeenCalledWith('2026-11-05 10:00:00', 100);
    expect(setup.rows.get(1)).toMatchObject({ outcome: 'completed', finishedAt: '2026-11-05 12:00:00' });
    expect(setup.tokens.recordTokenOutcome).toHaveBeenCalledWith(3, 'completed');
  });

  it('uses failed when the session failed', async () => {
    const setup = fixture({ session: { phase: 'FAILED' } });

    await setup.repair.repairOnce();

    expect(setup.rows.get(1)).toMatchObject({ outcome: 'failed', errorSummary: '执行失败' });
  });

  it('uses cancelled when the session was cancelled', async () => {
    const setup = fixture({ session: { phase: 'CANCELLED' } });

    await setup.repair.repairOnce();

    expect(setup.rows.get(1)).toMatchObject({ outcome: 'cancelled', errorSummary: null });
  });

  it('does not repair while the session is still active', async () => {
    const setup = fixture({ session: { phase: 'RUNNING' } });

    await expect(setup.repair.repairOnce()).resolves.toBe(0);

    expect(setup.rows.get(1)?.outcome).toBe('pending');
    expect(setup.tokens.recordTokenOutcome).not.toHaveBeenCalled();
  });

  it('does not repair while the queue still has a pending message', async () => {
    const setup = fixture({ pendingQueue: true });

    await expect(setup.repair.repairOnce()).resolves.toBe(0);

    expect(setup.rows.get(1)?.outcome).toBe('pending');
  });

  it('rechecks the pending queue again inside the repair transaction', async () => {
    const setup = fixture({ pendingQueue: true });

    await expect(setup.callLog.settleStale(1, '2026-11-05 10:00:00')).resolves.toBe(false);

    expect(setup.repo.settleStale).not.toHaveBeenCalled();
    expect(setup.rows.get(1)?.outcome).toBe('pending');
  });

  it('fails an interrupted queued call whose session no longer exists', async () => {
    const setup = fixture({ row: { outcome: 'queued' }, session: null });

    await expect(setup.repair.repairOnce()).resolves.toBe(1);

    expect(setup.rows.get(1)).toMatchObject({
      outcome: 'failed',
      errorCode: INTERRUPTED_CALL_ERROR_CODE,
      errorSummary: INTERRUPTED_CALL_ERROR_SUMMARY,
    });
  });

  it('fails an interrupted queued call whose session is deleted', async () => {
    const setup = fixture({ row: { outcome: 'queued' }, session: { deleted: 1 } });

    await expect(setup.repair.repairOnce()).resolves.toBe(1);

    expect(setup.rows.get(1)).toMatchObject({ outcome: 'failed', errorCode: INTERRUPTED_CALL_ERROR_CODE });
  });

  it('does not repair a pending call without a session id', async () => {
    const setup = fixture({ row: { sessionId: null }, session: null });
    const settle = vi.spyOn(setup.callLog, 'settleStale');

    await expect(setup.repair.repairOnce()).resolves.toBe(0);

    expect(settle).not.toHaveBeenCalled();
    expect(setup.rows.get(1)?.outcome).toBe('pending');
  });

  it('treats an already terminal call as a no-op when scanned again', async () => {
    const setup = fixture();

    await expect(setup.repair.repairOnce()).resolves.toBe(1);
    await expect(setup.repair.repairOnce()).resolves.toBe(0);

    expect(setup.repo.settleStale).toHaveBeenCalledTimes(1);
  });

  it('records scan failures without throwing into the lifecycle', async () => {
    const setup = fixture();
    setup.repo.listRepairCandidates.mockRejectedValueOnce(new Error('database unavailable'));
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      await expect(setup.repair.repairOnce()).resolves.toBe(0);
      expect(warning).toHaveBeenCalledWith(expect.stringContaining('call log repair scan failed'), expect.any(Error));
    } finally {
      warning.mockRestore();
    }
  });

  it('records a single candidate failure and continues the batch', async () => {
    const setup = fixture();
    const settle = vi.spyOn(setup.callLog, 'settleStale').mockRejectedValueOnce(new Error('write failed'));
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      await expect(setup.repair.repairOnce()).resolves.toBe(0);
      expect(settle).toHaveBeenCalledTimes(1);
      expect(warning).toHaveBeenCalledWith(expect.stringContaining('call log repair failed'), expect.any(Error));
    } finally {
      warning.mockRestore();
    }
  });
});

describe('OpenApiCallLogRepository repair queries', () => {
  it('scans only stale active calls without a queued message', async () => {
    const db = { query: vi.fn().mockResolvedValue([]) };
    const repo = new OpenApiCallLogRepository(db as unknown as Db);

    await repo.listRepairCandidates('2026-11-05 10:00:00', 100);

    const [sql, params] = db.query.mock.calls[0]!;
    expect(sql).toContain("outcome IN ('pending', 'queued')");
    expect(sql).toContain('created_at < ?');
    expect(sql).toContain("(l.session_id IS NOT NULL OR l.outcome = 'queued')");
    expect(sql).toMatch(/mq\.status = 'PENDING'\s+AND mq\.deleted = 0/);
    expect(sql).toContain("s.phase IN ('COMPLETED', 'FAILED', 'CANCELLED')");
    expect(sql).toContain("l.outcome = 'queued' AND (s.id IS NULL OR s.deleted <> 0)");
    expect(sql).toContain('LIMIT ?');
    expect(params).toEqual(['2026-11-05 10:00:00', 100]);
  });

  it('locks the call log row and session inside the repair transaction', async () => {
    const tx = {
      queryOne: vi.fn()
        .mockResolvedValueOnce({ id: 1, outcome: 'queued' })
        .mockResolvedValueOnce({ id: 11, phase: 'COMPLETED', deleted: 0 }),
    };
    const db = { transaction: vi.fn(async (work: (connection: unknown) => Promise<unknown>) => work(tx)) };
    const repo = new OpenApiCallLogRepository(db as unknown as Db);

    await repo.transaction(async (locked) => {
      await locked.lockById(1);
      await locked.lockSession(11);
    });

    expect(tx.queryOne).toHaveBeenNthCalledWith(1, expect.stringContaining('FOR UPDATE'), [1]);
    expect(tx.queryOne).toHaveBeenNthCalledWith(2, expect.stringContaining('FOR UPDATE'), [11]);
  });
});

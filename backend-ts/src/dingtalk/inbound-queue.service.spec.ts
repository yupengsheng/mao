import { describe, expect, it, vi } from 'vitest';
import { DingtalkTaskQueueService } from './inbound-queue.service.js';
import type { DingtalkInboundQueueRepository } from './inbound-queue.repository.js';
import type { DingtalkInboundQueueRow } from './types.js';

function repo(overrides: Partial<Record<keyof DingtalkInboundQueueRepository, unknown>> = {}): DingtalkInboundQueueRepository {
  const base: Record<keyof DingtalkInboundQueueRepository, unknown> = {
    transaction: vi.fn(),
    insert: vi.fn(async () => 1),
    setOutTrackId: vi.fn(async () => undefined),
    findById: vi.fn(async () => null),
    findByOutTrackId: vi.fn(async () => null),
    findByBotAndMessage: vi.fn(async () => null),
    claimNextQueued: vi.fn(async () => null),
    cancelQueued: vi.fn(async () => false),
    jumpToFront: vi.fn(async () => false),
    deleteById: vi.fn(async () => undefined),
    findMaxRankForUpdate: vi.fn(async () => 0),
    findMinRankForUpdate: vi.fn(async () => 1),
    deleteOrphanedBatch: vi.fn(async () => 0),
    listRecoverable: vi.fn(async () => []),
    countPending: vi.fn(async () => 0),
    listRunning: vi.fn(async () => []),
    resetRunningToQueued: vi.fn(async () => false),
    findPersistedMessageByQueueId: vi.fn(async () => null),
    deleteTerminal: vi.fn(async () => 0),
  };
  const instance = { ...base, ...overrides };
  (instance as { transaction: unknown }).transaction = vi.fn(
    async (fn: (tx: DingtalkInboundQueueRepository) => Promise<unknown>) => fn(instance as unknown as DingtalkInboundQueueRepository),
  );
  return instance as unknown as DingtalkInboundQueueRepository;
}

function row(overrides: Partial<DingtalkInboundQueueRow> = {}): DingtalkInboundQueueRow {
  return {
    id: 1,
    botId: 1,
    sessionId: 7,
    messageId: 'msg_1',
    outTrackId: null,
    senderUserid: 'u1',
    maoUserId: null,
    rankNo: 1,
    status: 'QUEUED',
    payload: '{}',
    ...overrides,
  };
}

describe('DingtalkTaskQueueService.hydrate', () => {
  it('prunes orphaned rows before recovering running rows', async () => {
    const calls: string[] = [];
    const r = repo({
      deleteOrphanedBatch: vi.fn(async () => {
        calls.push('prune');
        return 0;
      }),
      listRunning: vi.fn(async () => {
        calls.push('listRunning');
        return [];
      }),
      listRecoverable: vi.fn(async () => [row({ sessionId: 7 }), row({ sessionId: 8, id: 2 })]),
    });

    const ids = await new DingtalkTaskQueueService(r).hydrate();

    expect(calls).toEqual(['prune', 'listRunning']);
    expect(ids).toEqual([7, 8]);
  });

  it('keeps pruning until a short batch', async () => {
    const deleteOrphanedBatch = vi.fn()
      .mockResolvedValueOnce(5000)
      .mockResolvedValueOnce(5000)
      .mockResolvedValueOnce(3);
    const r = repo({ deleteOrphanedBatch });
    const service = new DingtalkTaskQueueService(r);

    await service.hydrate();

    expect(deleteOrphanedBatch).toHaveBeenCalledTimes(3);
  });

  it('continues recovery when orphan pruning fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const r = repo({
      deleteOrphanedBatch: vi.fn(async () => { throw new Error('db down'); }),
      listRunning: vi.fn(async () => [row({ id: 2, status: 'RUNNING' })]),
      findPersistedMessageByQueueId: vi.fn(async () => ({ id: 100 })),
      listRecoverable: vi.fn(async () => []),
    });
    const service = new DingtalkTaskQueueService(r);

    await expect(service.hydrate()).resolves.toEqual([]);
    expect(r.findPersistedMessageByQueueId).toHaveBeenCalledWith(7, 2);
    warn.mockRestore();
  });
});

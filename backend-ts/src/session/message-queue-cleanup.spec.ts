import { afterEach, describe, expect, it, vi } from 'vitest';
import { formatDateTime } from '../common/json.js';
import {
  MESSAGE_QUEUE_CLEANUP_BATCH_SIZE,
  MESSAGE_QUEUE_CLEANUP_MAX_BATCHES,
  MESSAGE_QUEUE_RETENTION_DAYS,
  MessageQueueCleanup,
} from './message-queue-cleanup.js';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('MessageQueueCleanup', () => {
  it('按 30 天保留期分批清理终态队列行', async () => {
    const deleteTerminalBatch = vi.fn()
      .mockResolvedValueOnce(MESSAGE_QUEUE_CLEANUP_BATCH_SIZE)
      .mockResolvedValueOnce(12);
    const cleanup = new MessageQueueCleanup({
      clearOrphanedPendingBatch: vi.fn(async () => 0),
      deleteTerminalBatch,
    });
    const now = Date.UTC(2026, 10, 5, 12, 0, 0);
    const cutoff = formatDateTime(now - MESSAGE_QUEUE_RETENTION_DAYS * 24 * 60 * 60 * 1000);

    await expect(cleanup.cleanupOnce(now)).resolves.toBe(MESSAGE_QUEUE_CLEANUP_BATCH_SIZE + 12);

    expect(deleteTerminalBatch).toHaveBeenNthCalledWith(1, cutoff, MESSAGE_QUEUE_CLEANUP_BATCH_SIZE);
    expect(deleteTerminalBatch).toHaveBeenNthCalledWith(2, cutoff, MESSAGE_QUEUE_CLEANUP_BATCH_SIZE);
  });

  it('单轮最多 20 批，剩余记录留到下一小时', async () => {
    const deleteTerminalBatch = vi.fn(async () => MESSAGE_QUEUE_CLEANUP_BATCH_SIZE);
    const cleanup = new MessageQueueCleanup({
      clearOrphanedPendingBatch: vi.fn(async () => 0),
      deleteTerminalBatch,
    });

    await expect(cleanup.cleanupOnce()).resolves.toBe(
      MESSAGE_QUEUE_CLEANUP_BATCH_SIZE * MESSAGE_QUEUE_CLEANUP_MAX_BATCHES,
    );

    expect(deleteTerminalBatch).toHaveBeenCalledTimes(MESSAGE_QUEUE_CLEANUP_MAX_BATCHES);
  });

  it('保留期非法时回落 30 天', async () => {
    const deleteTerminalBatch = vi.fn(async () => 0);
    const cleanup = new MessageQueueCleanup({
      clearOrphanedPendingBatch: vi.fn(async () => 0),
      deleteTerminalBatch,
    }, 0);
    const now = Date.UTC(2026, 10, 5, 12, 0, 0);
    const cutoff = formatDateTime(now - MESSAGE_QUEUE_RETENTION_DAYS * 24 * 60 * 60 * 1000);

    await cleanup.cleanupOnce(now);

    expect(deleteTerminalBatch).toHaveBeenCalledWith(cutoff, MESSAGE_QUEUE_CLEANUP_BATCH_SIZE);
  });

  it('start 幂等、按小时触发，stop 后不再执行', async () => {
    vi.useFakeTimers();
    const deleteTerminalBatch = vi.fn(async () => 0);
    const cleanup = new MessageQueueCleanup({
      clearOrphanedPendingBatch: vi.fn(async () => 0),
      deleteTerminalBatch,
    });
    cleanup.start();
    cleanup.start();
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    expect(deleteTerminalBatch).toHaveBeenCalledTimes(1);

    cleanup.stop();
    await vi.advanceTimersByTimeAsync(5 * 60 * 60 * 1000);
    expect(deleteTerminalBatch).toHaveBeenCalledTimes(1);
    await expect(cleanup.cleanupOnce()).resolves.toBe(0);
    expect(deleteTerminalBatch).toHaveBeenCalledTimes(1);
  });

  it('同一轮未结束时跳过后续触发', async () => {
    let release!: (count: number) => void;
    const first = new Promise<number>((resolve) => { release = resolve; });
    const deleteTerminalBatch = vi.fn().mockReturnValueOnce(first).mockResolvedValue(0);
    const cleanup = new MessageQueueCleanup({
      clearOrphanedPendingBatch: vi.fn(async () => 0),
      deleteTerminalBatch,
    });

    const running = cleanup.cleanupOnce();
    await expect(cleanup.cleanupOnce()).resolves.toBe(0);
    expect(deleteTerminalBatch).toHaveBeenCalledTimes(1);
    release(0);
    await expect(running).resolves.toBe(0);
  });

  it('删除异常被隔离并返回本轮已删除数量', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const deleteTerminalBatch = vi.fn()
      .mockResolvedValueOnce(MESSAGE_QUEUE_CLEANUP_BATCH_SIZE)
      .mockRejectedValueOnce(new Error('db down'));
    const cleanup = new MessageQueueCleanup({
      clearOrphanedPendingBatch: vi.fn(async () => 0),
      deleteTerminalBatch,
    });

    await expect(cleanup.cleanupOnce()).resolves.toBe(MESSAGE_QUEUE_CLEANUP_BATCH_SIZE);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('db down'));
    expect(deleteTerminalBatch).toHaveBeenCalledTimes(2);
  });

  it('先分批收敛孤儿 PENDING，再删除终态行', async () => {
    const clearOrphanedPendingBatch = vi.fn()
      .mockResolvedValueOnce(MESSAGE_QUEUE_CLEANUP_BATCH_SIZE)
      .mockResolvedValueOnce(3);
    const deleteTerminalBatch = vi.fn(async () => 2);
    const cleanup = new MessageQueueCleanup({ clearOrphanedPendingBatch, deleteTerminalBatch });

    await expect(cleanup.cleanupOnce()).resolves.toBe(MESSAGE_QUEUE_CLEANUP_BATCH_SIZE + 5);

    expect(clearOrphanedPendingBatch).toHaveBeenCalledTimes(2);
    expect(clearOrphanedPendingBatch).toHaveBeenNthCalledWith(1, MESSAGE_QUEUE_CLEANUP_BATCH_SIZE);
    expect(clearOrphanedPendingBatch).toHaveBeenNthCalledWith(2, MESSAGE_QUEUE_CLEANUP_BATCH_SIZE);
    expect(clearOrphanedPendingBatch.mock.invocationCallOrder[0])
      .toBeLessThan(deleteTerminalBatch.mock.invocationCallOrder[0]);
  });

  it('孤儿收敛异常不影响终态清理', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const clearOrphanedPendingBatch = vi.fn(async () => { throw new Error('repair failed'); });
    const deleteTerminalBatch = vi.fn(async () => 4);
    const cleanup = new MessageQueueCleanup({ clearOrphanedPendingBatch, deleteTerminalBatch });

    await expect(cleanup.cleanupOnce()).resolves.toBe(4);
    expect(deleteTerminalBatch).toHaveBeenCalledTimes(1);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('repair failed'));
  });
});

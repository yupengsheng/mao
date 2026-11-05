import { afterEach, describe, expect, it, vi } from 'vitest';
import { formatDateTime } from '../common/json.js';
import {
  DINGTALK_PROGRESS_CARD_CLEANUP_BATCH_SIZE,
  DINGTALK_PROGRESS_CARD_CLEANUP_MAX_BATCHES,
  DINGTALK_PROGRESS_CARD_RETENTION_DAYS,
  DingtalkProgressCardCleanup,
} from './progress-card-cleanup.js';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('DingtalkProgressCardCleanup', () => {
  it('按 180 天保留期分批清理过期映射', async () => {
    const deleteStaleBatch = vi.fn()
      .mockResolvedValueOnce(DINGTALK_PROGRESS_CARD_CLEANUP_BATCH_SIZE)
      .mockResolvedValueOnce(12);
    const cleanup = new DingtalkProgressCardCleanup({ deleteStaleBatch });
    const now = Date.UTC(2026, 10, 5, 12, 0, 0);
    const cutoff = formatDateTime(now - DINGTALK_PROGRESS_CARD_RETENTION_DAYS * 24 * 60 * 60 * 1000);

    await expect(cleanup.cleanupOnce(now)).resolves.toBe(DINGTALK_PROGRESS_CARD_CLEANUP_BATCH_SIZE + 12);

    expect(deleteStaleBatch).toHaveBeenNthCalledWith(1, cutoff, DINGTALK_PROGRESS_CARD_CLEANUP_BATCH_SIZE);
    expect(deleteStaleBatch).toHaveBeenNthCalledWith(2, cutoff, DINGTALK_PROGRESS_CARD_CLEANUP_BATCH_SIZE);
  });

  it('单轮最多 20 批，剩余记录留到下一小时', async () => {
    const deleteStaleBatch = vi.fn(async () => DINGTALK_PROGRESS_CARD_CLEANUP_BATCH_SIZE);
    const cleanup = new DingtalkProgressCardCleanup({ deleteStaleBatch });

    await expect(cleanup.cleanupOnce()).resolves.toBe(
      DINGTALK_PROGRESS_CARD_CLEANUP_BATCH_SIZE * DINGTALK_PROGRESS_CARD_CLEANUP_MAX_BATCHES,
    );

    expect(deleteStaleBatch).toHaveBeenCalledTimes(DINGTALK_PROGRESS_CARD_CLEANUP_MAX_BATCHES);
  });

  it('保留期非法时回落 180 天', async () => {
    const deleteStaleBatch = vi.fn(async () => 0);
    const cleanup = new DingtalkProgressCardCleanup({ deleteStaleBatch }, 0);
    const now = Date.UTC(2026, 10, 5, 12, 0, 0);
    const cutoff = formatDateTime(now - DINGTALK_PROGRESS_CARD_RETENTION_DAYS * 24 * 60 * 60 * 1000);

    await cleanup.cleanupOnce(now);

    expect(deleteStaleBatch).toHaveBeenCalledWith(cutoff, DINGTALK_PROGRESS_CARD_CLEANUP_BATCH_SIZE);
  });

  it('start 幂等、按小时触发，stop 后不再执行', async () => {
    vi.useFakeTimers();
    const deleteStaleBatch = vi.fn(async () => 0);
    const cleanup = new DingtalkProgressCardCleanup({ deleteStaleBatch });
    cleanup.start();
    cleanup.start();
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    expect(deleteStaleBatch).toHaveBeenCalledTimes(1);

    cleanup.stop();
    await vi.advanceTimersByTimeAsync(5 * 60 * 60 * 1000);
    expect(deleteStaleBatch).toHaveBeenCalledTimes(1);
    await expect(cleanup.cleanupOnce()).resolves.toBe(0);
    expect(deleteStaleBatch).toHaveBeenCalledTimes(1);
  });

  it('同一轮未结束时跳过后续触发', async () => {
    let release!: (count: number) => void;
    const first = new Promise<number>((resolve) => { release = resolve; });
    const deleteStaleBatch = vi.fn().mockReturnValueOnce(first).mockResolvedValue(0);
    const cleanup = new DingtalkProgressCardCleanup({ deleteStaleBatch });

    const running = cleanup.cleanupOnce();
    await expect(cleanup.cleanupOnce()).resolves.toBe(0);
    expect(deleteStaleBatch).toHaveBeenCalledTimes(1);
    release(0);
    await expect(running).resolves.toBe(0);
  });

  it('删除异常被隔离并返回本轮已删除数量', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const deleteStaleBatch = vi.fn()
      .mockResolvedValueOnce(DINGTALK_PROGRESS_CARD_CLEANUP_BATCH_SIZE)
      .mockRejectedValueOnce(new Error('db down'));
    const cleanup = new DingtalkProgressCardCleanup({ deleteStaleBatch });

    await expect(cleanup.cleanupOnce()).resolves.toBe(DINGTALK_PROGRESS_CARD_CLEANUP_BATCH_SIZE);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('db down'));
    expect(deleteStaleBatch).toHaveBeenCalledTimes(2);
  });
});

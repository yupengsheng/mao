import { afterEach, describe, expect, it, vi } from 'vitest';
import { formatDateTime } from '../common/json.js';
import {
  FEISHU_CARD_SNAPSHOT_CLEANUP_BATCH_SIZE,
  FEISHU_CARD_SNAPSHOT_CLEANUP_MAX_BATCHES,
  FEISHU_CARD_SNAPSHOT_RETENTION_DAYS,
  FeishuCardSnapshotCleanup,
} from './card-snapshot-cleanup.js';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('FeishuCardSnapshotCleanup', () => {
  it('按 180 天保留期分批清理', async () => {
    const deleteBatch = vi.fn()
      .mockResolvedValueOnce(FEISHU_CARD_SNAPSHOT_CLEANUP_BATCH_SIZE)
      .mockResolvedValueOnce(12);
    const cleanup = new FeishuCardSnapshotCleanup({ deleteBatch });
    const now = Date.UTC(2026, 10, 5, 12, 0, 0);
    const cutoff = formatDateTime(now - FEISHU_CARD_SNAPSHOT_RETENTION_DAYS * 24 * 60 * 60 * 1000);

    await expect(cleanup.cleanupOnce(now)).resolves.toBe(FEISHU_CARD_SNAPSHOT_CLEANUP_BATCH_SIZE + 12);

    expect(deleteBatch).toHaveBeenNthCalledWith(1, cutoff, FEISHU_CARD_SNAPSHOT_CLEANUP_BATCH_SIZE);
    expect(deleteBatch).toHaveBeenNthCalledWith(2, cutoff, FEISHU_CARD_SNAPSHOT_CLEANUP_BATCH_SIZE);
  });

  it('单轮最多 20 批，剩余记录留到下一小时', async () => {
    const deleteBatch = vi.fn(async () => FEISHU_CARD_SNAPSHOT_CLEANUP_BATCH_SIZE);
    const cleanup = new FeishuCardSnapshotCleanup({ deleteBatch });

    await expect(cleanup.cleanupOnce()).resolves.toBe(
      FEISHU_CARD_SNAPSHOT_CLEANUP_BATCH_SIZE * FEISHU_CARD_SNAPSHOT_CLEANUP_MAX_BATCHES,
    );

    expect(deleteBatch).toHaveBeenCalledTimes(FEISHU_CARD_SNAPSHOT_CLEANUP_MAX_BATCHES);
  });

  it('start 幂等、按小时触发，stop 后不再执行', async () => {
    vi.useFakeTimers();
    const deleteBatch = vi.fn(async () => 0);
    const cleanup = new FeishuCardSnapshotCleanup({ deleteBatch });
    cleanup.start();
    cleanup.start();
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    expect(deleteBatch).toHaveBeenCalledTimes(1);

    cleanup.stop();
    await vi.advanceTimersByTimeAsync(5 * 60 * 60 * 1000);
    expect(deleteBatch).toHaveBeenCalledTimes(1);
    await expect(cleanup.cleanupOnce()).resolves.toBe(0);
    expect(deleteBatch).toHaveBeenCalledTimes(1);
  });

  it('同一轮未结束时跳过后续触发', async () => {
    let release!: (count: number) => void;
    const first = new Promise<number>((resolve) => { release = resolve; });
    const deleteBatch = vi.fn().mockReturnValueOnce(first).mockResolvedValue(0);
    const cleanup = new FeishuCardSnapshotCleanup({ deleteBatch });

    const running = cleanup.cleanupOnce();
    await expect(cleanup.cleanupOnce()).resolves.toBe(0);
    expect(deleteBatch).toHaveBeenCalledTimes(1);
    release(0);
    await expect(running).resolves.toBe(0);
  });

  it('删除异常被隔离并返回本轮已删除数量', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const deleteBatch = vi.fn()
      .mockResolvedValueOnce(FEISHU_CARD_SNAPSHOT_CLEANUP_BATCH_SIZE)
      .mockRejectedValueOnce(new Error('db down'));
    const cleanup = new FeishuCardSnapshotCleanup({ deleteBatch });

    await expect(cleanup.cleanupOnce()).resolves.toBe(FEISHU_CARD_SNAPSHOT_CLEANUP_BATCH_SIZE);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('db down'));
    expect(deleteBatch).toHaveBeenCalledTimes(2);
  });
});

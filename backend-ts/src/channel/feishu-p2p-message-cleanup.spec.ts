import { describe, expect, it, vi } from 'vitest';
import { formatDateTime } from '../common/json.js';
import {
  FEISHU_P2P_MESSAGE_CLEANUP_BATCH_SIZE,
  FEISHU_P2P_MESSAGE_CLEANUP_MAX_BATCHES,
  FEISHU_P2P_MESSAGE_RETENTION_DAYS,
  FeishuP2pMessageCleanup,
} from './feishu-p2p-message-cleanup.js';

describe('FeishuP2pMessageCleanup', () => {
  it('按 180 天保留期分批清理', async () => {
    const deleteBatch = vi.fn()
      .mockResolvedValueOnce(FEISHU_P2P_MESSAGE_CLEANUP_BATCH_SIZE)
      .mockResolvedValueOnce(12);
    const cleanup = new FeishuP2pMessageCleanup({ deleteBatch });
    const now = Date.UTC(2026, 10, 5, 12, 0, 0);
    const cutoff = formatDateTime(now - FEISHU_P2P_MESSAGE_RETENTION_DAYS * 24 * 60 * 60 * 1000);

    await expect(cleanup.cleanupOnce(now)).resolves.toBe(FEISHU_P2P_MESSAGE_CLEANUP_BATCH_SIZE + 12);

    expect(deleteBatch).toHaveBeenNthCalledWith(1, cutoff, FEISHU_P2P_MESSAGE_CLEANUP_BATCH_SIZE);
    expect(deleteBatch).toHaveBeenNthCalledWith(2, cutoff, FEISHU_P2P_MESSAGE_CLEANUP_BATCH_SIZE);
  });

  it('单轮最多 20 批，剩余记录留到下一小时', async () => {
    const deleteBatch = vi.fn(async () => FEISHU_P2P_MESSAGE_CLEANUP_BATCH_SIZE);
    const cleanup = new FeishuP2pMessageCleanup({ deleteBatch });

    await expect(cleanup.cleanupOnce()).resolves.toBe(
      FEISHU_P2P_MESSAGE_CLEANUP_BATCH_SIZE * FEISHU_P2P_MESSAGE_CLEANUP_MAX_BATCHES,
    );

    expect(deleteBatch).toHaveBeenCalledTimes(FEISHU_P2P_MESSAGE_CLEANUP_MAX_BATCHES);
  });

  it('start 幂等、按小时触发，stop 后不再执行', async () => {
    vi.useFakeTimers();
    try {
      const deleteBatch = vi.fn(async () => 0);
      const cleanup = new FeishuP2pMessageCleanup({ deleteBatch });
      cleanup.start();
      cleanup.start();
      await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
      expect(deleteBatch).toHaveBeenCalledTimes(1);

      cleanup.stop();
      await vi.advanceTimersByTimeAsync(5 * 60 * 60 * 1000);
      expect(deleteBatch).toHaveBeenCalledTimes(1);
      await expect(cleanup.cleanupOnce()).resolves.toBe(0);
      expect(deleteBatch).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('同一轮未结束时跳过后续触发', async () => {
    let release!: (count: number) => void;
    const first = new Promise<number>((resolve) => { release = resolve; });
    const deleteBatch = vi.fn().mockReturnValueOnce(first).mockResolvedValue(0);
    const cleanup = new FeishuP2pMessageCleanup({ deleteBatch });

    const running = cleanup.cleanupOnce();
    await expect(cleanup.cleanupOnce()).resolves.toBe(0);
    expect(deleteBatch).toHaveBeenCalledTimes(1);
    release(0);
    await expect(running).resolves.toBe(0);
  });
});

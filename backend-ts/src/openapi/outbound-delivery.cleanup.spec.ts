import { describe, expect, it, vi } from 'vitest';
import { formatDateTime } from '../common/json.js';
import { OUTBOUND_DELIVERY_RETENTION_DAYS, OutboundDeliveryCleanup } from './outbound-delivery.cleanup.js';

function store(deleteHistory: ReturnType<typeof vi.fn>) {
  return { deleteHistory };
}

describe('OutboundDeliveryCleanup', () => {
  it('按 90 天保留期分批清理终态投递记录，短批后停止', async () => {
    const deleteHistory = vi.fn().mockResolvedValueOnce(5000).mockResolvedValueOnce(12);
    const cleanup = new OutboundDeliveryCleanup(store(deleteHistory));
    const now = Date.UTC(2026, 10, 5, 12, 0, 0);

    const removed = await cleanup.cleanupOnce(now);

    const cutoff = formatDateTime(new Date(now - OUTBOUND_DELIVERY_RETENTION_DAYS * 24 * 60 * 60 * 1000));
    expect(deleteHistory).toHaveBeenNthCalledWith(1, cutoff, 5000);
    expect(deleteHistory).toHaveBeenNthCalledWith(2, cutoff, 5000);
    expect(deleteHistory).toHaveBeenCalledTimes(2);
    expect(removed).toBe(5012);
  });

  it('stop 后不再执行；start 幂等且按小时触发', async () => {
    vi.useFakeTimers();
    try {
      const deleteHistory = vi.fn(async () => 0);
      const cleanup = new OutboundDeliveryCleanup(store(deleteHistory));
      cleanup.start();
      cleanup.start();
      await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
      expect(deleteHistory).toHaveBeenCalledTimes(1);

      cleanup.stop();
      await vi.advanceTimersByTimeAsync(5 * 60 * 60 * 1000);
      expect(deleteHistory).toHaveBeenCalledTimes(1);
      await expect(cleanup.cleanupOnce()).resolves.toBe(0);
      expect(deleteHistory).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('清理异常只记录日志，不让定时任务停摆', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const cleanup = new OutboundDeliveryCleanup(store(vi.fn(async () => { throw new Error('ECONNREFUSED'); })));
      await expect(cleanup.cleanupOnce()).resolves.toBe(0);
      expect(errorSpy).toHaveBeenCalledWith('出站投递记录清理异常', expect.any(Error));
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('同一轮未结束时跳过后续触发，避免重复扫描与并发删除', async () => {
    let release!: (count: number) => void;
    const first = new Promise<number>((resolve) => { release = resolve; });
    const deleteHistory = vi.fn().mockReturnValueOnce(first).mockResolvedValue(0);
    const cleanup = new OutboundDeliveryCleanup(store(deleteHistory));

    const running = cleanup.cleanupOnce();
    await expect(cleanup.cleanupOnce()).resolves.toBe(0);
    expect(deleteHistory).toHaveBeenCalledTimes(1);
    release(0);
    await expect(running).resolves.toBe(0);
  });
});

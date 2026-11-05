import { describe, expect, it, vi } from 'vitest';
import { formatDateTime } from '../common/json.js';
import {
  INBOUND_EVENT_CLEANUP_BATCH_SIZE,
  INBOUND_EVENT_RETENTION_DAYS,
  InboundEventCleanup,
  type InboundEventStore,
} from './inbound-event-cleanup.js';

function store(name: string, deleteBatch: ReturnType<typeof vi.fn>): InboundEventStore {
  return { name, deleteBatch };
}

describe('InboundEventCleanup', () => {
  it('按 30 天保留期分批清理飞书与钉钉记录', async () => {
    const feishu = vi.fn().mockResolvedValueOnce(5000).mockResolvedValueOnce(12);
    const dingtalk = vi.fn().mockResolvedValueOnce(3);
    const cleanup = new InboundEventCleanup([store('feishu', feishu), store('dingtalk', dingtalk)]);
    const now = Date.UTC(2026, 10, 5, 12, 0, 0);
    const cutoff = formatDateTime(now - INBOUND_EVENT_RETENTION_DAYS * 24 * 60 * 60 * 1000);

    await expect(cleanup.cleanupOnce(now)).resolves.toBe(5015);

    expect(feishu).toHaveBeenNthCalledWith(1, cutoff, INBOUND_EVENT_CLEANUP_BATCH_SIZE);
    expect(feishu).toHaveBeenNthCalledWith(2, cutoff, INBOUND_EVENT_CLEANUP_BATCH_SIZE);
    expect(dingtalk).toHaveBeenCalledWith(cutoff, INBOUND_EVENT_CLEANUP_BATCH_SIZE);
  });

  it('单表最多 20 批，剩余记录留到下一小时', async () => {
    const feishu = vi.fn(async () => INBOUND_EVENT_CLEANUP_BATCH_SIZE);
    const cleanup = new InboundEventCleanup([store('feishu', feishu)]);

    await expect(cleanup.cleanupOnce()).resolves.toBe(100000);

    expect(feishu).toHaveBeenCalledTimes(20);
  });

  it('一张表清理失败不影响另一张表', async () => {
    const feishu = vi.fn(async () => { throw new Error('db down'); });
    const dingtalk = vi.fn(async () => 4);
    const cleanup = new InboundEventCleanup([store('feishu', feishu), store('dingtalk', dingtalk)]);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    try {
      await expect(cleanup.cleanupOnce()).resolves.toBe(4);
      expect(dingtalk).toHaveBeenCalledTimes(1);
      expect(error).toHaveBeenCalledWith(expect.stringContaining('store=feishu'), expect.any(Error));
    } finally {
      error.mockRestore();
    }
  });

  it('start 幂等、按小时触发，stop 后不再执行', async () => {
    vi.useFakeTimers();
    try {
      const feishu = vi.fn(async () => 0);
      const cleanup = new InboundEventCleanup([store('feishu', feishu)]);
      cleanup.start();
      cleanup.start();
      await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
      expect(feishu).toHaveBeenCalledTimes(1);

      cleanup.stop();
      await vi.advanceTimersByTimeAsync(5 * 60 * 60 * 1000);
      expect(feishu).toHaveBeenCalledTimes(1);
      await expect(cleanup.cleanupOnce()).resolves.toBe(0);
      expect(feishu).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('同一轮未结束时跳过后续触发', async () => {
    let release!: (count: number) => void;
    const first = new Promise<number>((resolve) => { release = resolve; });
    const feishu = vi.fn().mockReturnValueOnce(first).mockResolvedValue(0);
    const cleanup = new InboundEventCleanup([store('feishu', feishu)]);

    const running = cleanup.cleanupOnce();
    await expect(cleanup.cleanupOnce()).resolves.toBe(0);
    expect(feishu).toHaveBeenCalledTimes(1);
    release(0);
    await expect(running).resolves.toBe(0);
  });
});

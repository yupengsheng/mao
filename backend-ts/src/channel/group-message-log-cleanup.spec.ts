import { describe, expect, it, vi } from 'vitest';
import { formatDateTime } from '../common/json.js';
import {
  GROUP_MESSAGE_LOG_CLEANUP_BATCH_SIZE,
  GROUP_MESSAGE_LOG_CLEANUP_MAX_BATCHES,
  GROUP_MESSAGE_LOG_PENDING_RETENTION_DAYS,
  GROUP_MESSAGE_LOG_RETENTION_DAYS,
  GroupMessageLogCleanup,
  type GroupMessageLogStore,
} from './group-message-log-cleanup.js';

function store(
  name: string,
  retentionDays: number,
  deleteBatch: ReturnType<typeof vi.fn>,
): GroupMessageLogStore {
  return { name, retentionDays, deleteBatch };
}

describe('GroupMessageLogCleanup', () => {
  it('按各表保留期分批清理飞书、飞书待富化与钉钉群日志', async () => {
    const feishu = vi.fn().mockResolvedValueOnce(GROUP_MESSAGE_LOG_CLEANUP_BATCH_SIZE).mockResolvedValueOnce(12);
    const feishuPending = vi.fn().mockResolvedValueOnce(3);
    const dingtalk = vi.fn().mockResolvedValueOnce(2);
    const cleanup = new GroupMessageLogCleanup([
      store('feishu_enriched', GROUP_MESSAGE_LOG_RETENTION_DAYS, feishu),
      store('feishu_pending', GROUP_MESSAGE_LOG_PENDING_RETENTION_DAYS, feishuPending),
      store('dingtalk', GROUP_MESSAGE_LOG_RETENTION_DAYS, dingtalk),
    ]);
    const now = Date.UTC(2026, 10, 5, 12, 0, 0);
    const cutoff = formatDateTime(now - GROUP_MESSAGE_LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000);
    const pendingCutoff = formatDateTime(now - GROUP_MESSAGE_LOG_PENDING_RETENTION_DAYS * 24 * 60 * 60 * 1000);

    await expect(cleanup.cleanupOnce(now)).resolves.toBe(GROUP_MESSAGE_LOG_CLEANUP_BATCH_SIZE + 17);

    expect(feishu).toHaveBeenNthCalledWith(1, cutoff, GROUP_MESSAGE_LOG_CLEANUP_BATCH_SIZE);
    expect(feishu).toHaveBeenNthCalledWith(2, cutoff, GROUP_MESSAGE_LOG_CLEANUP_BATCH_SIZE);
    expect(feishuPending).toHaveBeenCalledWith(pendingCutoff, GROUP_MESSAGE_LOG_CLEANUP_BATCH_SIZE);
    expect(dingtalk).toHaveBeenCalledWith(cutoff, GROUP_MESSAGE_LOG_CLEANUP_BATCH_SIZE);
  });

  it('单表最多 20 批，剩余记录留到下一小时', async () => {
    const feishu = vi.fn(async () => GROUP_MESSAGE_LOG_CLEANUP_BATCH_SIZE);
    const cleanup = new GroupMessageLogCleanup([
      store('feishu', GROUP_MESSAGE_LOG_RETENTION_DAYS, feishu),
    ]);

    await expect(cleanup.cleanupOnce()).resolves.toBe(
      GROUP_MESSAGE_LOG_CLEANUP_BATCH_SIZE * GROUP_MESSAGE_LOG_CLEANUP_MAX_BATCHES,
    );

    expect(feishu).toHaveBeenCalledTimes(GROUP_MESSAGE_LOG_CLEANUP_MAX_BATCHES);
  });

  it('一张表清理失败不影响另一张表', async () => {
    const feishu = vi.fn(async () => { throw new Error('db down'); });
    const dingtalk = vi.fn(async () => 4);
    const cleanup = new GroupMessageLogCleanup([
      store('feishu', GROUP_MESSAGE_LOG_RETENTION_DAYS, feishu),
      store('dingtalk', GROUP_MESSAGE_LOG_RETENTION_DAYS, dingtalk),
    ]);
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
      const cleanup = new GroupMessageLogCleanup([
        store('feishu', GROUP_MESSAGE_LOG_RETENTION_DAYS, feishu),
      ]);
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
    const cleanup = new GroupMessageLogCleanup([
      store('feishu', GROUP_MESSAGE_LOG_RETENTION_DAYS, feishu),
    ]);

    const running = cleanup.cleanupOnce();
    await expect(cleanup.cleanupOnce()).resolves.toBe(0);
    expect(feishu).toHaveBeenCalledTimes(1);
    release(0);
    await expect(running).resolves.toBe(0);
  });
});

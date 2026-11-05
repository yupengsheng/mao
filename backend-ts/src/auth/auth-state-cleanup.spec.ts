import { describe, expect, it, vi } from 'vitest';
import { formatDateTime } from '../common/json.js';
import {
  AUTH_STATE_CLEANUP_BATCH_SIZE,
  AUTH_STATE_CLEANUP_MAX_BATCHES,
  AUTH_STATE_RETENTION_DAYS,
  AuthStateCleanup,
  type AuthStateCleanupStore,
} from './auth-state-cleanup.js';

function store(name: string, deleteBatch: ReturnType<typeof vi.fn>): AuthStateCleanupStore {
  return { name, deleteBatch } as unknown as AuthStateCleanupStore;
}

describe('AuthStateCleanup', () => {
  it('按 30 天保留期分批删除所有 store', async () => {
    const feishu = vi.fn().mockResolvedValueOnce(AUTH_STATE_CLEANUP_BATCH_SIZE).mockResolvedValueOnce(12);
    const ecp = vi.fn(async () => 3);
    const cleanup = new AuthStateCleanup([store('feishu_oauth_state', feishu), store('ecp_oauth_state', ecp)]);
    const now = Date.UTC(2026, 10, 5, 12, 0, 0);

    const removed = await cleanup.cleanupOnce(now);

    const cutoff = formatDateTime(now - AUTH_STATE_RETENTION_DAYS * 24 * 60 * 60 * 1000);
    expect(feishu).toHaveBeenNthCalledWith(1, cutoff, AUTH_STATE_CLEANUP_BATCH_SIZE);
    expect(feishu).toHaveBeenNthCalledWith(2, cutoff, AUTH_STATE_CLEANUP_BATCH_SIZE);
    expect(ecp).toHaveBeenCalledWith(cutoff, AUTH_STATE_CLEANUP_BATCH_SIZE);
    expect(removed).toBe(AUTH_STATE_CLEANUP_BATCH_SIZE + 15);
  });

  it('单轮最多 20 批，剩余记录留到下一小时', async () => {
    const deleteBatch = vi.fn(async () => AUTH_STATE_CLEANUP_BATCH_SIZE);
    const cleanup = new AuthStateCleanup([store('feishu_oauth_state', deleteBatch)]);

    await expect(cleanup.cleanupOnce()).resolves.toBe(AUTH_STATE_CLEANUP_BATCH_SIZE * AUTH_STATE_CLEANUP_MAX_BATCHES);

    expect(deleteBatch).toHaveBeenCalledTimes(AUTH_STATE_CLEANUP_MAX_BATCHES);
  });

  it('单表异常只记录日志，继续清理其它表', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const broken = vi.fn(async () => { throw new Error('ECONNREFUSED'); });
      const healthy = vi.fn(async () => 4);
      const cleanup = new AuthStateCleanup([
        store('feishu_oauth_state', broken),
        store('dingtalk_oauth_state', healthy),
      ]);

      await expect(cleanup.cleanupOnce()).resolves.toBe(4);

      expect(errorSpy).toHaveBeenCalledWith(
        '鉴权状态清理异常, store=feishu_oauth_state',
        expect.any(Error),
      );
      expect(healthy).toHaveBeenCalledTimes(1);
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('stop 后不再执行；start 幂等且按小时触发', async () => {
    vi.useFakeTimers();
    try {
      const deleteBatch = vi.fn(async () => 0);
      const cleanup = new AuthStateCleanup([store('feishu_oauth_state', deleteBatch)]);
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
    const cleanup = new AuthStateCleanup([store('feishu_oauth_state', deleteBatch)]);

    const running = cleanup.cleanupOnce();
    await expect(cleanup.cleanupOnce()).resolves.toBe(0);
    expect(deleteBatch).toHaveBeenCalledTimes(1);
    release(0);
    await expect(running).resolves.toBe(0);
  });
});

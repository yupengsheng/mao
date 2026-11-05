import { describe, expect, it, vi } from 'vitest';
import { formatDateTime } from '../common/json.js';
import {
  LLM_CALL_CLEANUP_BATCH_SIZE,
  LLM_CALL_MIN_RETENTION_DAYS,
  LLM_CALL_RETENTION_DAYS,
  LlmCallCleanup,
  type LlmCallCleanupRepository,
} from './llm-call-cleanup.js';

function repo(deleteBatch: ReturnType<typeof vi.fn>): LlmCallCleanupRepository {
  return { deleteBatch } as unknown as LlmCallCleanupRepository;
}

describe('LlmCallCleanup', () => {
  it('按配置保留期分批删除，短批后停止', async () => {
    const deleteBatch = vi.fn().mockResolvedValueOnce(5000).mockResolvedValueOnce(12);
    const cleanup = new LlmCallCleanup(repo(deleteBatch), async () => 365);
    const now = Date.UTC(2026, 10, 5, 12, 0, 0);

    const removed = await cleanup.cleanupOnce(now);

    const cutoff = formatDateTime(now - 365 * 24 * 60 * 60 * 1000);
    expect(deleteBatch).toHaveBeenNthCalledWith(1, cutoff, LLM_CALL_CLEANUP_BATCH_SIZE);
    expect(deleteBatch).toHaveBeenNthCalledWith(2, cutoff, LLM_CALL_CLEANUP_BATCH_SIZE);
    expect(deleteBatch).toHaveBeenCalledTimes(2);
    expect(removed).toBe(5012);
  });

  it('保留期非法或缺失时回落 180 天', async () => {
    const deleteBatch = vi.fn(async () => 0);
    const cleanup = new LlmCallCleanup(repo(deleteBatch), async () => 0);
    const now = Date.UTC(2026, 10, 5, 12, 0, 0);

    await cleanup.cleanupOnce(now);

    const cutoff = formatDateTime(now - LLM_CALL_RETENTION_DAYS * 24 * 60 * 60 * 1000);
    expect(deleteBatch).toHaveBeenCalledWith(cutoff, LLM_CALL_CLEANUP_BATCH_SIZE);
  });

  it('低于 90 天的保留期按 90 天执行，避免后台 90 天分析窗口缺数据', async () => {
    const deleteBatch = vi.fn(async () => 0);
    const cleanup = new LlmCallCleanup(repo(deleteBatch), async () => 30);
    const now = Date.UTC(2026, 10, 5, 12, 0, 0);

    await cleanup.cleanupOnce(now);

    const cutoff = formatDateTime(now - LLM_CALL_MIN_RETENTION_DAYS * 24 * 60 * 60 * 1000);
    expect(deleteBatch).toHaveBeenCalledWith(cutoff, LLM_CALL_CLEANUP_BATCH_SIZE);
  });

  it('单轮最多 20 批，剩余记录留到下一小时', async () => {
    const deleteBatch = vi.fn(async () => LLM_CALL_CLEANUP_BATCH_SIZE);
    const cleanup = new LlmCallCleanup(repo(deleteBatch), async () => 180);

    await expect(cleanup.cleanupOnce()).resolves.toBe(100000);

    expect(deleteBatch).toHaveBeenCalledTimes(20);
  });

  it('stop 后不再执行；start 幂等且按小时触发', async () => {
    vi.useFakeTimers();
    try {
      const deleteBatch = vi.fn(async () => 0);
      const cleanup = new LlmCallCleanup(repo(deleteBatch), async () => 180);
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
    const cleanup = new LlmCallCleanup(repo(deleteBatch), async () => 180);

    const running = cleanup.cleanupOnce();
    await expect(cleanup.cleanupOnce()).resolves.toBe(0);
    expect(deleteBatch).toHaveBeenCalledTimes(1);
    release(0);
    await expect(running).resolves.toBe(0);
  });

  it('清理异常只记录日志，不让定时任务停摆', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const cleanup = new LlmCallCleanup(
        repo(vi.fn(async () => { throw new Error('ECONNREFUSED'); })),
        async () => 180,
      );
      await expect(cleanup.cleanupOnce()).resolves.toBe(0);
      expect(errorSpy).toHaveBeenCalledWith('LLM 调用流水清理异常', expect.any(Error));
    } finally {
      errorSpy.mockRestore();
    }
  });
});

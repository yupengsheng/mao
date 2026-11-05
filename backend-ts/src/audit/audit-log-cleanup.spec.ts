import { describe, expect, it, vi } from 'vitest';
import { formatDateTime } from '../common/json.js';
import type { AuditLogRepository } from './types.js';
import {
  AUDIT_LOG_CLEANUP_BATCH_SIZE,
  AUDIT_LOG_RETENTION_DAYS,
  AuditLogCleanup,
} from './audit-log-cleanup.js';

function repo(deleteBatch: ReturnType<typeof vi.fn>) {
  return { deleteBatch } as unknown as AuditLogRepository;
}

describe('AuditLogCleanup', () => {
  it('按配置保留期分批删除，短批后停止', async () => {
    const deleteBatch = vi.fn().mockResolvedValueOnce(5000).mockResolvedValueOnce(12);
    const cleanup = new AuditLogCleanup(repo(deleteBatch), async () => 365);
    const now = Date.UTC(2026, 10, 5, 12, 0, 0);

    const removed = await cleanup.cleanupOnce(now);

    const cutoff = formatDateTime(now - 365 * 24 * 60 * 60 * 1000);
    expect(deleteBatch).toHaveBeenNthCalledWith(1, cutoff, AUDIT_LOG_CLEANUP_BATCH_SIZE);
    expect(deleteBatch).toHaveBeenNthCalledWith(2, cutoff, AUDIT_LOG_CLEANUP_BATCH_SIZE);
    expect(deleteBatch).toHaveBeenCalledTimes(2);
    expect(removed).toBe(5012);
  });

  it('保留期非法或缺失时回落 180 天', async () => {
    const deleteBatch = vi.fn(async () => 0);
    const cleanup = new AuditLogCleanup(repo(deleteBatch), async () => 0);
    const now = Date.UTC(2026, 10, 5, 12, 0, 0);

    await cleanup.cleanupOnce(now);

    const cutoff = formatDateTime(now - AUDIT_LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000);
    expect(deleteBatch).toHaveBeenCalledWith(cutoff, AUDIT_LOG_CLEANUP_BATCH_SIZE);
  });

  it('单轮最多 20 批，剩余记录留到下一小时', async () => {
    const deleteBatch = vi.fn(async () => AUDIT_LOG_CLEANUP_BATCH_SIZE);
    const cleanup = new AuditLogCleanup(repo(deleteBatch), async () => 180);

    await expect(cleanup.cleanupOnce()).resolves.toBe(100000);

    expect(deleteBatch).toHaveBeenCalledTimes(20);
  });

  it('stop 后不再执行；start 幂等且按小时触发', async () => {
    vi.useFakeTimers();
    try {
      const deleteBatch = vi.fn(async () => 0);
      const cleanup = new AuditLogCleanup(repo(deleteBatch), async () => 180);
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
    const cleanup = new AuditLogCleanup(repo(deleteBatch), async () => 180);

    const running = cleanup.cleanupOnce();
    await expect(cleanup.cleanupOnce()).resolves.toBe(0);
    expect(deleteBatch).toHaveBeenCalledTimes(1);
    release(0);
    await expect(running).resolves.toBe(0);
  });

  it('清理异常只记录日志，不让定时任务停摆', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const cleanup = new AuditLogCleanup(
        repo(vi.fn(async () => { throw new Error('ECONNREFUSED'); })),
        async () => 180,
      );
      await expect(cleanup.cleanupOnce()).resolves.toBe(0);
      expect(errorSpy).toHaveBeenCalledWith('审计日志清理异常', expect.any(Error));
    } finally {
      errorSpy.mockRestore();
    }
  });
});

import { describe, expect, it, vi } from 'vitest';
import { formatDateTime } from '../common/json.js';
import type { TaskRepository } from './task.repository.js';
import {
  TASK_EXECUTION_KEEP_PER_TASK,
  TASK_EXECUTION_RETENTION_DAYS,
  TaskExecutionRetentionService,
} from './task-execution-retention.service.js';

function repo(deleteStaleExecutions: ReturnType<typeof vi.fn>) {
  return { deleteStaleExecutions } as unknown as TaskRepository;
}

describe('TaskExecutionRetentionService', () => {
  it('按 90 天保留期与每任务最近 200 次分批清理，短批后停止', async () => {
    const deleteStaleExecutions = vi.fn().mockResolvedValueOnce(500).mockResolvedValueOnce(12);
    const service = new TaskExecutionRetentionService(repo(deleteStaleExecutions));
    const now = Date.UTC(2026, 10, 5, 12, 0, 0);

    const removed = await service.cleanupOnce(now);

    const cutoff = formatDateTime(new Date(now - TASK_EXECUTION_RETENTION_DAYS * 24 * 60 * 60 * 1000));
    expect(deleteStaleExecutions).toHaveBeenNthCalledWith(1, cutoff, TASK_EXECUTION_KEEP_PER_TASK, 500);
    expect(deleteStaleExecutions).toHaveBeenNthCalledWith(2, cutoff, TASK_EXECUTION_KEEP_PER_TASK, 500);
    expect(deleteStaleExecutions).toHaveBeenCalledTimes(2);
    expect(removed).toBe(512);
  });

  it('stop 后不再执行；start 幂等且按小时触发', async () => {
    vi.useFakeTimers();
    try {
      const deleteStaleExecutions = vi.fn(async () => 0);
      const service = new TaskExecutionRetentionService(repo(deleteStaleExecutions));
      service.start();
      service.start();
      await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
      expect(deleteStaleExecutions).toHaveBeenCalledTimes(1);

      service.stop();
      await vi.advanceTimersByTimeAsync(5 * 60 * 60 * 1000);
      expect(deleteStaleExecutions).toHaveBeenCalledTimes(1);
      await expect(service.cleanupOnce()).resolves.toBe(0);
      expect(deleteStaleExecutions).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('清理异常只记录日志，不让定时任务停摆', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const service = new TaskExecutionRetentionService(repo(vi.fn(async () => { throw new Error('ECONNREFUSED'); })));
      await expect(service.cleanupOnce()).resolves.toBe(0);
      expect(errorSpy).toHaveBeenCalledWith('任务执行历史清理异常', expect.any(Error));
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('同一轮未结束时跳过后续触发，避免重复扫描与并发删除', async () => {
    let release!: (count: number) => void;
    const first = new Promise<number>((resolve) => { release = resolve; });
    const deleteStaleExecutions = vi.fn().mockReturnValueOnce(first).mockResolvedValue(0);
    const service = new TaskExecutionRetentionService(repo(deleteStaleExecutions));

    const running = service.cleanupOnce();
    await expect(service.cleanupOnce()).resolves.toBe(0);
    expect(deleteStaleExecutions).toHaveBeenCalledTimes(1);
    release(0);
    await expect(running).resolves.toBe(0);
  });

  it('单轮达到批次上限时留到下一小时继续', async () => {
    const deleteStaleExecutions = vi.fn(async () => 500);
    const service = new TaskExecutionRetentionService(repo(deleteStaleExecutions), { maxBatches: 3 });

    await expect(service.cleanupOnce()).resolves.toBe(1500);

    expect(deleteStaleExecutions).toHaveBeenCalledTimes(3);
  });
});

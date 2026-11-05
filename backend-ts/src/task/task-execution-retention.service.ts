import { formatDateTime } from '../common/json.js';
import type { TaskRepository } from './task.repository.js';

/** 终态执行记录的保留天数，与投递流水、调用流水保持一致。 */
export const TASK_EXECUTION_RETENTION_DAYS = 90;
/** 每个 Task 至少保留的最近尝试数，覆盖执行记录页最近 50 次的查询能力。 */
export const TASK_EXECUTION_KEEP_PER_TASK = 200;
export const TASK_EXECUTION_CLEANUP_INTERVAL_MS = 60 * 60 * 1000;
export const TASK_EXECUTION_CLEANUP_BATCH_SIZE = 500;
export const TASK_EXECUTION_CLEANUP_MAX_BATCHES = 20;

export interface TaskExecutionRetentionOptions {
  intervalMs?: number;
  retentionDays?: number;
  keepPerTask?: number;
  batchSize?: number;
  maxBatches?: number;
}

/**
 * 任务执行历史清理：只删除超过保留期且落在每任务最近 N 次之外的终态尝试，
 * 并级联删除对应 Trigger。WORKING / BLOCKED 不在清理范围内。
 */
export class TaskExecutionRetentionService {
  private readonly intervalMs: number;
  private readonly retentionDays: number;
  private readonly keepPerTask: number;
  private readonly batchSize: number;
  private readonly maxBatches: number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private stopped = false;
  private cleaning = false;

  constructor(
    private readonly repo: TaskRepository,
    options: TaskExecutionRetentionOptions = {},
  ) {
    this.intervalMs = positiveInt(options.intervalMs, TASK_EXECUTION_CLEANUP_INTERVAL_MS);
    this.retentionDays = positiveInt(options.retentionDays, TASK_EXECUTION_RETENTION_DAYS);
    this.keepPerTask = positiveInt(options.keepPerTask, TASK_EXECUTION_KEEP_PER_TASK);
    this.batchSize = positiveInt(options.batchSize, TASK_EXECUTION_CLEANUP_BATCH_SIZE);
    this.maxBatches = positiveInt(options.maxBatches, TASK_EXECUTION_CLEANUP_MAX_BATCHES);
  }

  start(): void {
    if (this.timer != null) return;
    this.stopped = false;
    this.timer = setInterval(() => { void this.cleanupOnce(); }, this.intervalMs);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer != null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async cleanupOnce(now = Date.now()): Promise<number> {
    if (this.stopped || this.cleaning) return 0;
    this.cleaning = true;
    try {
      const cutoff = formatDateTime(new Date(now - this.retentionDays * 24 * 60 * 60 * 1000));
      let removed = 0;
      for (let i = 0; i < this.maxBatches; i += 1) {
        const count = await this.repo.deleteStaleExecutions(cutoff, this.keepPerTask, this.batchSize);
        removed += count;
        if (count < this.batchSize) break;
      }
      if (removed > 0) {
        console.info(`[task] pruned ${removed} stale execution(s)`);
      }
      return removed;
    } catch (error) {
      console.error('任务执行历史清理异常', error);
      return 0;
    } finally {
      this.cleaning = false;
    }
  }
}

function positiveInt(value: number | undefined, fallback: number): number {
  return value != null && Number.isFinite(value) && value > 0 ? Math.trunc(value) : fallback;
}

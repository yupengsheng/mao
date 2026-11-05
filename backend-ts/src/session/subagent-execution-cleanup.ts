import { formatDateTime } from '../common/json.js';

/** 子代理执行记录用于历史追踪与父会话展示，保留 180 天；仍在执行或未投递的记录永不清理。 */
export const SUBAGENT_EXECUTION_RETENTION_DAYS = 180;
export const SUBAGENT_EXECUTION_CLEANUP_INTERVAL_MS = 60 * 60 * 1000;
export const SUBAGENT_EXECUTION_CLEANUP_BATCH_SIZE = 5000;
export const SUBAGENT_EXECUTION_CLEANUP_MAX_BATCHES = 20;

export interface SubagentExecutionCleanupStore {
  deleteBatch(cutoff: string, limit: number): Promise<number>;
}

/** 子代理执行记录清理：每小时按 updated_at 分批删除已过期且结果已收口的记录。 */
export class SubagentExecutionCleanup {
  private timer: ReturnType<typeof setInterval> | null = null;
  private stopped = false;
  private cleaning = false;

  constructor(
    private readonly store: SubagentExecutionCleanupStore,
    private readonly retentionDays = SUBAGENT_EXECUTION_RETENTION_DAYS,
  ) {}

  start(): void {
    if (this.timer != null) return;
    this.stopped = false;
    this.timer = setInterval(() => { void this.cleanupOnce(); }, SUBAGENT_EXECUTION_CLEANUP_INTERVAL_MS);
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
      const days = Number.isInteger(this.retentionDays) && this.retentionDays > 0
        ? this.retentionDays
        : SUBAGENT_EXECUTION_RETENTION_DAYS;
      const cutoff = formatDateTime(now - days * 24 * 60 * 60 * 1000);
      let removed = 0;
      try {
        for (let i = 0; i < SUBAGENT_EXECUTION_CLEANUP_MAX_BATCHES; i += 1) {
          const count = await this.store.deleteBatch(cutoff, SUBAGENT_EXECUTION_CLEANUP_BATCH_SIZE);
          removed += count;
          if (count < SUBAGENT_EXECUTION_CLEANUP_BATCH_SIZE) break;
        }
      } catch (error) {
        console.error(`[session] failed to prune stale subagent_execution rows: ${error instanceof Error ? error.message : String(error)}`);
      }
      if (removed > 0) {
        console.info(`[session] pruned ${removed} stale subagent_execution row(s)`);
      }
      return removed;
    } finally {
      this.cleaning = false;
    }
  }
}

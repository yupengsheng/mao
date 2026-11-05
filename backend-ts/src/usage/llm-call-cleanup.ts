import { formatDateTime } from '../common/json.js';

export const LLM_CALL_RETENTION_DAYS = 180;
export const LLM_CALL_MIN_RETENTION_DAYS = 90;
export const LLM_CALL_CLEANUP_INTERVAL_MS = 60 * 60 * 1000;
export const LLM_CALL_CLEANUP_BATCH_SIZE = 5000;
export const LLM_CALL_CLEANUP_MAX_BATCHES = 20;

export interface LlmCallCleanupRepository {
  deleteBatch(cutoff: string, limit: number): Promise<number>;
}

/** LLM 调用流水保留清理：每小时按后台配置的保留期分批删除过期记录。 */
export class LlmCallCleanup {
  private timer: ReturnType<typeof setInterval> | null = null;
  private stopped = false;
  private cleaning = false;

  constructor(
    private readonly repo: LlmCallCleanupRepository,
    private readonly retentionDays: () => Promise<number>,
  ) {}

  start(): void {
    if (this.timer != null) return;
    this.stopped = false;
    this.timer = setInterval(() => { void this.cleanupOnce(); }, LLM_CALL_CLEANUP_INTERVAL_MS);
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
      const days = await this.retentionDays();
      const safeDays = Number.isInteger(days) && days > 0
        ? Math.max(LLM_CALL_MIN_RETENTION_DAYS, days)
        : LLM_CALL_RETENTION_DAYS;
      const cutoff = formatDateTime(now - safeDays * 24 * 60 * 60 * 1000);
      let removed = 0;
      for (let i = 0; i < LLM_CALL_CLEANUP_MAX_BATCHES; i += 1) {
        const count = await this.repo.deleteBatch(cutoff, LLM_CALL_CLEANUP_BATCH_SIZE);
        removed += count;
        if (count < LLM_CALL_CLEANUP_BATCH_SIZE) break;
      }
      if (removed > 0) {
        console.info(`[usage] pruned ${removed} stale LLM call(s)`);
      }
      return removed;
    } catch (error) {
      console.error('LLM 调用流水清理异常', error);
      return 0;
    } finally {
      this.cleaning = false;
    }
  }
}

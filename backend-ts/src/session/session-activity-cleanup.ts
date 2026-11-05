import { formatDateTime } from '../common/json.js';

export const SESSION_ACTIVITY_RETENTION_DAYS = 180;
export const SESSION_ACTIVITY_MIN_RETENTION_DAYS = 90;
export const SESSION_ACTIVITY_CLEANUP_INTERVAL_MS = 60 * 60 * 1000;
export const SESSION_ACTIVITY_CLEANUP_BATCH_SIZE = 5000;
export const SESSION_ACTIVITY_CLEANUP_MAX_BATCHES = 20;

export interface SessionActivityCleanupRepository {
  deleteBatch(cutoff: string, limit: number): Promise<number>;
}

/** 会话活动保留清理：每小时按后台配置的保留期分批删除运行轨迹工具明细。 */
export class SessionActivityCleanup {
  private timer: ReturnType<typeof setInterval> | null = null;
  private stopped = false;
  private cleaning = false;

  constructor(
    private readonly repo: SessionActivityCleanupRepository,
    private readonly retentionDays: () => Promise<number>,
  ) {}

  start(): void {
    if (this.timer != null) return;
    this.stopped = false;
    this.timer = setInterval(() => { void this.cleanupOnce(); }, SESSION_ACTIVITY_CLEANUP_INTERVAL_MS);
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
        ? Math.max(SESSION_ACTIVITY_MIN_RETENTION_DAYS, days)
        : SESSION_ACTIVITY_RETENTION_DAYS;
      const cutoff = formatDateTime(now - safeDays * 24 * 60 * 60 * 1000);
      let removed = 0;
      for (let i = 0; i < SESSION_ACTIVITY_CLEANUP_MAX_BATCHES; i += 1) {
        const count = await this.repo.deleteBatch(cutoff, SESSION_ACTIVITY_CLEANUP_BATCH_SIZE);
        removed += count;
        if (count < SESSION_ACTIVITY_CLEANUP_BATCH_SIZE) break;
      }
      if (removed > 0) {
        console.info(`[session] pruned ${removed} stale activity record(s)`);
      }
      return removed;
    } catch (error) {
      console.error('会话活动清理异常', error);
      return 0;
    } finally {
      this.cleaning = false;
    }
  }
}

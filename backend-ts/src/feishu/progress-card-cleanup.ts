import { formatDateTime } from '../common/json.js';

/** 飞书进度卡映射只服务运行中会话与崩溃恢复，保留 180 天；活跃相位永不清理。 */
export const FEISHU_PROGRESS_CARD_RETENTION_DAYS = 180;
export const FEISHU_PROGRESS_CARD_CLEANUP_INTERVAL_MS = 60 * 60 * 1000;
export const FEISHU_PROGRESS_CARD_CLEANUP_BATCH_SIZE = 5000;
export const FEISHU_PROGRESS_CARD_CLEANUP_MAX_BATCHES = 20;

export interface FeishuProgressCardCleanupStore {
  deleteStaleBatch(cutoff: string, limit: number): Promise<number>;
}

/** 飞书进度卡映射清理：每小时按 updated_at 分批删除非活跃会话的过期映射。 */
export class FeishuProgressCardCleanup {
  private timer: ReturnType<typeof setInterval> | null = null;
  private stopped = false;
  private cleaning = false;

  constructor(
    private readonly store: FeishuProgressCardCleanupStore,
    private readonly retentionDays = FEISHU_PROGRESS_CARD_RETENTION_DAYS,
  ) {}

  start(): void {
    if (this.timer != null) return;
    this.stopped = false;
    this.timer = setInterval(() => { void this.cleanupOnce(); }, FEISHU_PROGRESS_CARD_CLEANUP_INTERVAL_MS);
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
        : FEISHU_PROGRESS_CARD_RETENTION_DAYS;
      const cutoff = formatDateTime(now - days * 24 * 60 * 60 * 1000);
      let removed = 0;
      try {
        for (let i = 0; i < FEISHU_PROGRESS_CARD_CLEANUP_MAX_BATCHES; i += 1) {
          const count = await this.store.deleteStaleBatch(cutoff, FEISHU_PROGRESS_CARD_CLEANUP_BATCH_SIZE);
          removed += count;
          if (count < FEISHU_PROGRESS_CARD_CLEANUP_BATCH_SIZE) break;
        }
      } catch (error) {
        console.error(`[feishu] failed to prune stale feishu_progress_card rows: ${error instanceof Error ? error.message : String(error)}`);
      }
      if (removed > 0) {
        console.info(`[feishu] pruned ${removed} stale feishu_progress_card row(s)`);
      }
      return removed;
    } finally {
      this.cleaning = false;
    }
  }
}

import { formatDateTime } from '../common/json.js';

/** 完成卡快照只服务点踩归属与旧卡重绘，保留 180 天覆盖长期翻看历史消息的场景。 */
export const FEISHU_CARD_SNAPSHOT_RETENTION_DAYS = 180;
export const FEISHU_CARD_SNAPSHOT_CLEANUP_INTERVAL_MS = 60 * 60 * 1000;
export const FEISHU_CARD_SNAPSHOT_CLEANUP_BATCH_SIZE = 5000;
export const FEISHU_CARD_SNAPSHOT_CLEANUP_MAX_BATCHES = 20;

export interface FeishuCardSnapshotCleanupStore {
  deleteBatch(cutoff: string, limit: number): Promise<number>;
}

/** 飞书完成卡快照清理：每小时按最后写入时间分批删除过期记录。 */
export class FeishuCardSnapshotCleanup {
  private timer: ReturnType<typeof setInterval> | null = null;
  private stopped = false;
  private cleaning = false;

  constructor(
    private readonly store: FeishuCardSnapshotCleanupStore,
    private readonly retentionDays = FEISHU_CARD_SNAPSHOT_RETENTION_DAYS,
  ) {}

  start(): void {
    if (this.timer != null) return;
    this.stopped = false;
    this.timer = setInterval(() => { void this.cleanupOnce(); }, FEISHU_CARD_SNAPSHOT_CLEANUP_INTERVAL_MS);
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
        : FEISHU_CARD_SNAPSHOT_RETENTION_DAYS;
      const cutoff = formatDateTime(now - days * 24 * 60 * 60 * 1000);
      let removed = 0;
      try {
        for (let i = 0; i < FEISHU_CARD_SNAPSHOT_CLEANUP_MAX_BATCHES; i += 1) {
          const count = await this.store.deleteBatch(cutoff, FEISHU_CARD_SNAPSHOT_CLEANUP_BATCH_SIZE);
          removed += count;
          if (count < FEISHU_CARD_SNAPSHOT_CLEANUP_BATCH_SIZE) break;
        }
      } catch (error) {
        console.error(`[feishu] failed to prune stale feishu_card_snapshot rows: ${error instanceof Error ? error.message : String(error)}`);
      }
      if (removed > 0) {
        console.info(`[feishu] pruned ${removed} stale feishu_card_snapshot row(s)`);
      }
      return removed;
    } finally {
      this.cleaning = false;
    }
  }
}

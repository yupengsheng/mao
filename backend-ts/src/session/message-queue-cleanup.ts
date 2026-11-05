import { formatDateTime } from '../common/json.js';

/** 已消费的排队消息只用于短期排障，保留 30 天；PENDING 行永不清理。 */
export const MESSAGE_QUEUE_RETENTION_DAYS = 30;
export const MESSAGE_QUEUE_CLEANUP_INTERVAL_MS = 60 * 60 * 1000;
export const MESSAGE_QUEUE_CLEANUP_BATCH_SIZE = 5000;
export const MESSAGE_QUEUE_CLEANUP_MAX_BATCHES = 20;

export interface MessageQueueCleanupStore {
  deleteTerminalBatch(cutoff: string, limit: number): Promise<number>;
}

/** 消息队列清理：每小时按 updated_at 分批删除已消费 / 已移除的队列行。 */
export class MessageQueueCleanup {
  private timer: ReturnType<typeof setInterval> | null = null;
  private stopped = false;
  private cleaning = false;

  constructor(
    private readonly store: MessageQueueCleanupStore,
    private readonly retentionDays = MESSAGE_QUEUE_RETENTION_DAYS,
  ) {}

  start(): void {
    if (this.timer != null) return;
    this.stopped = false;
    this.timer = setInterval(() => { void this.cleanupOnce(); }, MESSAGE_QUEUE_CLEANUP_INTERVAL_MS);
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
        : MESSAGE_QUEUE_RETENTION_DAYS;
      const cutoff = formatDateTime(now - days * 24 * 60 * 60 * 1000);
      let removed = 0;
      try {
        for (let i = 0; i < MESSAGE_QUEUE_CLEANUP_MAX_BATCHES; i += 1) {
          const count = await this.store.deleteTerminalBatch(cutoff, MESSAGE_QUEUE_CLEANUP_BATCH_SIZE);
          removed += count;
          if (count < MESSAGE_QUEUE_CLEANUP_BATCH_SIZE) break;
        }
      } catch (error) {
        console.error(`[session] failed to prune stale message_queue rows: ${error instanceof Error ? error.message : String(error)}`);
      }
      if (removed > 0) {
        console.info(`[session] pruned ${removed} stale message_queue row(s)`);
      }
      return removed;
    } finally {
      this.cleaning = false;
    }
  }
}

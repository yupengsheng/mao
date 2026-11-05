import { formatDateTime } from '../common/json.js';

/** 已消费的排队消息只用于短期排障，保留 30 天；有效会话的 PENDING 行不清理。 */
export const MESSAGE_QUEUE_RETENTION_DAYS = 30;
export const MESSAGE_QUEUE_CLEANUP_INTERVAL_MS = 60 * 60 * 1000;
export const MESSAGE_QUEUE_CLEANUP_BATCH_SIZE = 5000;
export const MESSAGE_QUEUE_CLEANUP_MAX_BATCHES = 20;

export interface MessageQueueCleanupStore {
  clearOrphanedPendingBatch(limit: number): Promise<number>;
  deleteTerminalBatch(cutoff: string, limit: number): Promise<number>;
}

/** 消息队列清理：每小时先收敛孤儿 PENDING 行，再按 updated_at 分批删除终态行。 */
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
      let orphaned = 0;
      let removed = 0;
      try {
        for (let i = 0; i < MESSAGE_QUEUE_CLEANUP_MAX_BATCHES; i += 1) {
          const count = await this.store.clearOrphanedPendingBatch(MESSAGE_QUEUE_CLEANUP_BATCH_SIZE);
          orphaned += count;
          if (count < MESSAGE_QUEUE_CLEANUP_BATCH_SIZE) break;
        }
      } catch (error) {
        console.error(`[session] failed to clear orphaned message_queue rows: ${error instanceof Error ? error.message : String(error)}`);
      }
      try {
        for (let i = 0; i < MESSAGE_QUEUE_CLEANUP_MAX_BATCHES; i += 1) {
          const count = await this.store.deleteTerminalBatch(cutoff, MESSAGE_QUEUE_CLEANUP_BATCH_SIZE);
          removed += count;
          if (count < MESSAGE_QUEUE_CLEANUP_BATCH_SIZE) break;
        }
      } catch (error) {
        console.error(`[session] failed to prune stale message_queue rows: ${error instanceof Error ? error.message : String(error)}`);
      }
      if (orphaned > 0) {
        console.info(`[session] cleared ${orphaned} orphaned pending message_queue row(s)`);
      }
      if (removed > 0) {
        console.info(`[session] pruned ${removed} stale message_queue row(s)`);
      }
      return orphaned + removed;
    } finally {
      this.cleaning = false;
    }
  }
}

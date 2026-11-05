import { formatDateTime } from '../common/json.js';

/** 压缩事件只用于历史时间线标记，保留 180 天；压缩摘要本身另行长期保留。 */
export const SESSION_COMPACTION_EVENT_RETENTION_DAYS = 180;
export const SESSION_COMPACTION_EVENT_CLEANUP_INTERVAL_MS = 60 * 60 * 1000;
export const SESSION_COMPACTION_EVENT_CLEANUP_BATCH_SIZE = 5000;
export const SESSION_COMPACTION_EVENT_CLEANUP_MAX_BATCHES = 20;

export interface SessionCompactionEventCleanupStore {
  deleteBatch(cutoff: string, limit: number): Promise<number>;
}

/** 会话压缩事件清理：每小时按创建时间分批删除过期时间线标记。 */
export class SessionCompactionEventCleanup {
  private timer: ReturnType<typeof setInterval> | null = null;
  private stopped = false;
  private cleaning = false;

  constructor(
    private readonly store: SessionCompactionEventCleanupStore,
    private readonly retentionDays = SESSION_COMPACTION_EVENT_RETENTION_DAYS,
  ) {}

  start(): void {
    if (this.timer != null) return;
    this.stopped = false;
    this.timer = setInterval(() => { void this.cleanupOnce(); }, SESSION_COMPACTION_EVENT_CLEANUP_INTERVAL_MS);
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
        : SESSION_COMPACTION_EVENT_RETENTION_DAYS;
      const cutoff = formatDateTime(now - days * 24 * 60 * 60 * 1000);
      let removed = 0;
      try {
        for (let i = 0; i < SESSION_COMPACTION_EVENT_CLEANUP_MAX_BATCHES; i += 1) {
          const count = await this.store.deleteBatch(cutoff, SESSION_COMPACTION_EVENT_CLEANUP_BATCH_SIZE);
          removed += count;
          if (count < SESSION_COMPACTION_EVENT_CLEANUP_BATCH_SIZE) break;
        }
      } catch (error) {
        console.error(`[session] failed to prune stale session_compaction_event rows: ${error instanceof Error ? error.message : String(error)}`);
      }
      if (removed > 0) {
        console.info(`[session] pruned ${removed} stale session_compaction_event row(s)`);
      }
      return removed;
    } finally {
      this.cleaning = false;
    }
  }
}

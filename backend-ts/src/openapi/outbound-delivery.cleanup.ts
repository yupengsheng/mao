import { formatDateTime } from '../common/json.js';

/** 出站事件投递记录的保留天数（与任务通知投递一致，固定 90 天）。 */
export const OUTBOUND_DELIVERY_RETENTION_DAYS = 90;
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000;
const BATCH_LIMIT = 5000;
const MAX_BATCHES = 20;

export interface OutboundDeliveryHistoryStore {
  deleteHistory(cutoff: string, limit: number): Promise<number>;
}

/**
 * 出站事件投递历史清理：只删已终结的 SUCCEEDED / FAILED 行。
 * 与投递重试调度解耦，避免清理大表时影响到期消息的领取与发送。
 */
export class OutboundDeliveryCleanup {
  private timer: ReturnType<typeof setInterval> | null = null;
  private stopped = false;
  private cleaning = false;

  constructor(private readonly store: OutboundDeliveryHistoryStore) {}

  start(): void {
    if (this.timer != null) return;
    this.stopped = false;
    this.timer = setInterval(() => { void this.cleanupOnce(); }, CLEANUP_INTERVAL_MS);
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
      const cutoff = formatDateTime(new Date(now - OUTBOUND_DELIVERY_RETENTION_DAYS * 24 * 60 * 60 * 1000));
      let removed = 0;
      for (let i = 0; i < MAX_BATCHES; i += 1) {
        const count = await this.store.deleteHistory(cutoff, BATCH_LIMIT);
        removed += count;
        if (count < BATCH_LIMIT) break;
      }
      return removed;
    } catch (e) {
      console.error('出站投递记录清理异常', e);
      return 0;
    } finally {
      this.cleaning = false;
    }
  }
}

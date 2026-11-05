import { formatDateTime } from '../common/json.js';

/** 入站事件只用于短期幂等去重，保留 30 天已远超 IM 平台重投窗口。 */
export const INBOUND_EVENT_RETENTION_DAYS = 30;
export const INBOUND_EVENT_CLEANUP_INTERVAL_MS = 60 * 60 * 1000;
export const INBOUND_EVENT_CLEANUP_BATCH_SIZE = 5000;
export const INBOUND_EVENT_CLEANUP_MAX_BATCHES = 20;

export interface InboundEventStore {
  readonly name: string;
  deleteBatch(cutoff: string, limit: number): Promise<number>;
}

/** 飞书 / 钉钉入站幂等记录清理：每小时按同一保留期分批删除，单表失败不影响另一张表。 */
export class InboundEventCleanup {
  private timer: ReturnType<typeof setInterval> | null = null;
  private stopped = false;
  private cleaning = false;

  constructor(private readonly stores: InboundEventStore[]) {}

  start(): void {
    if (this.timer != null) return;
    this.stopped = false;
    this.timer = setInterval(() => { void this.cleanupOnce(); }, INBOUND_EVENT_CLEANUP_INTERVAL_MS);
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
      const cutoff = formatDateTime(now - INBOUND_EVENT_RETENTION_DAYS * 24 * 60 * 60 * 1000);
      let removed = 0;
      for (const store of this.stores) {
        try {
          let storeRemoved = 0;
          for (let i = 0; i < INBOUND_EVENT_CLEANUP_MAX_BATCHES; i += 1) {
            const count = await store.deleteBatch(cutoff, INBOUND_EVENT_CLEANUP_BATCH_SIZE);
            storeRemoved += count;
            if (count < INBOUND_EVENT_CLEANUP_BATCH_SIZE) break;
          }
          if (storeRemoved > 0) {
            console.info(`[inbound] pruned ${storeRemoved} stale ${store.name} event(s)`);
          }
          removed += storeRemoved;
        } catch (error) {
          console.error(`入站事件清理异常, store=${store.name}`, error);
        }
      }
      return removed;
    } finally {
      this.cleaning = false;
    }
  }
}

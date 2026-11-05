import { formatDateTime } from '../common/json.js';

/** 群消息日志只服务短期上下文与附件回查，保留 30 天已足够。 */
export const GROUP_MESSAGE_LOG_RETENTION_DAYS = 30;
/** 飞书富化异常可能留下 enrich_pending=1 的行；再保留 90 天作为兜底，避免永久卡住水位线。 */
export const GROUP_MESSAGE_LOG_PENDING_RETENTION_DAYS = 90;
export const GROUP_MESSAGE_LOG_CLEANUP_INTERVAL_MS = 60 * 60 * 1000;
export const GROUP_MESSAGE_LOG_CLEANUP_BATCH_SIZE = 5000;
export const GROUP_MESSAGE_LOG_CLEANUP_MAX_BATCHES = 20;

export interface GroupMessageLogStore {
  readonly name: string;
  readonly retentionDays: number;
  deleteBatch(cutoff: string, limit: number): Promise<number>;
}

/** 飞书 / 钉钉群消息日志清理：每小时按各表保留期分批删除，单表异常不影响其它表。 */
export class GroupMessageLogCleanup {
  private timer: ReturnType<typeof setInterval> | null = null;
  private stopped = false;
  private cleaning = false;

  constructor(private readonly stores: GroupMessageLogStore[]) {}

  start(): void {
    if (this.timer != null) return;
    this.stopped = false;
    this.timer = setInterval(() => { void this.cleanupOnce(); }, GROUP_MESSAGE_LOG_CLEANUP_INTERVAL_MS);
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
      let removed = 0;
      for (const store of this.stores) {
        try {
          const days = Number.isInteger(store.retentionDays) && store.retentionDays > 0
            ? store.retentionDays
            : GROUP_MESSAGE_LOG_RETENTION_DAYS;
          const cutoff = formatDateTime(now - days * 24 * 60 * 60 * 1000);
          let storeRemoved = 0;
          for (let i = 0; i < GROUP_MESSAGE_LOG_CLEANUP_MAX_BATCHES; i += 1) {
            const count = await store.deleteBatch(cutoff, GROUP_MESSAGE_LOG_CLEANUP_BATCH_SIZE);
            storeRemoved += count;
            if (count < GROUP_MESSAGE_LOG_CLEANUP_BATCH_SIZE) break;
          }
          if (storeRemoved > 0) {
            console.info(`[channel] pruned ${storeRemoved} stale ${store.name} row(s)`);
          }
          removed += storeRemoved;
        } catch (error) {
          console.error(`群消息日志清理异常, store=${store.name}`, error);
        }
      }
      return removed;
    } finally {
      this.cleaning = false;
    }
  }
}

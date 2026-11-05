import { formatDateTime } from '../common/json.js';

/** 登录 state 与待绑定消息只在授权窗口内有效，保留 30 天已足够排查问题。 */
export const AUTH_STATE_RETENTION_DAYS = 30;
export const AUTH_STATE_CLEANUP_INTERVAL_MS = 60 * 60 * 1000;
export const AUTH_STATE_CLEANUP_BATCH_SIZE = 5000;
export const AUTH_STATE_CLEANUP_MAX_BATCHES = 20;

export interface AuthStateCleanupStore {
  readonly name: string;
  deleteBatch(cutoff: string, limit: number): Promise<number>;
}

/** 飞书 / 钉钉 / ECP 登录 state 与待绑定消息清理：每小时分批删除，单表失败不影响其它表。 */
export class AuthStateCleanup {
  private timer: ReturnType<typeof setInterval> | null = null;
  private stopped = false;
  private cleaning = false;

  constructor(private readonly stores: AuthStateCleanupStore[]) {}

  start(): void {
    if (this.timer != null) return;
    this.stopped = false;
    this.timer = setInterval(() => { void this.cleanupOnce(); }, AUTH_STATE_CLEANUP_INTERVAL_MS);
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
      const cutoff = formatDateTime(now - AUTH_STATE_RETENTION_DAYS * 24 * 60 * 60 * 1000);
      let removed = 0;
      for (const store of this.stores) {
        try {
          let storeRemoved = 0;
          for (let i = 0; i < AUTH_STATE_CLEANUP_MAX_BATCHES; i += 1) {
            const count = await store.deleteBatch(cutoff, AUTH_STATE_CLEANUP_BATCH_SIZE);
            storeRemoved += count;
            if (count < AUTH_STATE_CLEANUP_BATCH_SIZE) break;
          }
          if (storeRemoved > 0) {
            console.info(`[auth] pruned ${storeRemoved} stale ${store.name} record(s)`);
          }
          removed += storeRemoved;
        } catch (error) {
          console.error(`鉴权状态清理异常, store=${store.name}`, error);
        }
      }
      return removed;
    } finally {
      this.cleaning = false;
    }
  }
}

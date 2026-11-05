import { formatDateTime } from '../common/json.js';

/** 私聊消息映射只服务引用切换与最近入站回复定位，保留 180 天覆盖长期会话。 */
export const FEISHU_P2P_MESSAGE_RETENTION_DAYS = 180;
export const FEISHU_P2P_MESSAGE_CLEANUP_INTERVAL_MS = 60 * 60 * 1000;
export const FEISHU_P2P_MESSAGE_CLEANUP_BATCH_SIZE = 5000;
export const FEISHU_P2P_MESSAGE_CLEANUP_MAX_BATCHES = 20;

export interface FeishuP2pMessageCleanupStore {
  deleteBatch(cutoff: string, limit: number): Promise<number>;
}

/** 飞书私聊消息 → 会话映射清理：每小时分批删除超过保留期的记录。 */
export class FeishuP2pMessageCleanup {
  private timer: ReturnType<typeof setInterval> | null = null;
  private stopped = false;
  private cleaning = false;

  constructor(
    private readonly store: FeishuP2pMessageCleanupStore,
    private readonly retentionDays = FEISHU_P2P_MESSAGE_RETENTION_DAYS,
  ) {}

  start(): void {
    if (this.timer != null) return;
    this.stopped = false;
    this.timer = setInterval(() => { void this.cleanupOnce(); }, FEISHU_P2P_MESSAGE_CLEANUP_INTERVAL_MS);
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
        : FEISHU_P2P_MESSAGE_RETENTION_DAYS;
      const cutoff = formatDateTime(now - days * 24 * 60 * 60 * 1000);
      let removed = 0;
      for (let i = 0; i < FEISHU_P2P_MESSAGE_CLEANUP_MAX_BATCHES; i += 1) {
        const count = await this.store.deleteBatch(cutoff, FEISHU_P2P_MESSAGE_CLEANUP_BATCH_SIZE);
        removed += count;
        if (count < FEISHU_P2P_MESSAGE_CLEANUP_BATCH_SIZE) break;
      }
      if (removed > 0) {
        console.info(`[channel] pruned ${removed} stale feishu_p2p_message row(s)`);
      }
      return removed;
    } finally {
      this.cleaning = false;
    }
  }
}

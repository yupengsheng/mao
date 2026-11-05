/** 通道会话映射的孤儿行修复：会话已不存在 / 已逻辑删除的映射不应继续存在。 */
export const SESSION_CHANNEL_MAPPING_CLEANUP_INTERVAL_MS = 60 * 60 * 1000;
export const SESSION_CHANNEL_MAPPING_CLEANUP_BATCH_SIZE = 5000;
export const SESSION_CHANNEL_MAPPING_CLEANUP_MAX_BATCHES = 20;

export interface SessionChannelMappingCleanupStore {
  deleteOrphanWeixinPeerBatch(limit: number): Promise<number>;
  deleteOrphanFeishuThreadBatch(limit: number): Promise<number>;
  deleteOrphanFeishuSessionChannelBatch(limit: number): Promise<number>;
}

interface CleanupTarget {
  name: string;
  deleteBatch(limit: number): Promise<number>;
}

/** 通道会话映射清理：每小时分批删除指向不存在 / 已删除会话的映射。 */
export class SessionChannelMappingCleanup {
  private timer: ReturnType<typeof setInterval> | null = null;
  private stopped = false;
  private cleaning = false;
  private readonly targets: CleanupTarget[];

  constructor(private readonly store: SessionChannelMappingCleanupStore) {
    this.targets = [
      { name: 'weixin_session_peer', deleteBatch: (limit) => store.deleteOrphanWeixinPeerBatch(limit) },
      { name: 'feishu_thread_session', deleteBatch: (limit) => store.deleteOrphanFeishuThreadBatch(limit) },
      { name: 'feishu_session_channel', deleteBatch: (limit) => store.deleteOrphanFeishuSessionChannelBatch(limit) },
    ];
  }

  start(): void {
    if (this.timer != null) return;
    this.stopped = false;
    this.timer = setInterval(() => { void this.cleanupOnce(); }, SESSION_CHANNEL_MAPPING_CLEANUP_INTERVAL_MS);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer != null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async cleanupOnce(): Promise<number> {
    if (this.stopped || this.cleaning) return 0;
    this.cleaning = true;
    try {
      let removed = 0;
      for (const target of this.targets) {
        try {
          removed += await this.drainTarget(target);
        } catch (error) {
          console.error(`[session] failed to prune orphan ${target.name} rows: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      if (removed > 0) {
        console.info(`[session] pruned ${removed} orphan session channel mapping row(s)`);
      }
      return removed;
    } finally {
      this.cleaning = false;
    }
  }

  private async drainTarget(target: CleanupTarget): Promise<number> {
    let removed = 0;
    for (let i = 0; i < SESSION_CHANNEL_MAPPING_CLEANUP_MAX_BATCHES; i += 1) {
      const count = await target.deleteBatch(SESSION_CHANNEL_MAPPING_CLEANUP_BATCH_SIZE);
      removed += count;
      if (count < SESSION_CHANNEL_MAPPING_CLEANUP_BATCH_SIZE) break;
    }
    return removed;
  }
}

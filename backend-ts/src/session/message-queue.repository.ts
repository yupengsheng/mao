import type { Db } from '../db/db.js';
import { notDeleted } from '../db/db.js';
import type { MessageQueue } from './types.js';

export class MessageQueueRepository {
  constructor(private readonly db: Db) {}

  transaction<T>(fn: (tx: MessageQueueRepository) => Promise<T>): Promise<T> {
    return this.db.transaction((txDb) => fn(new MessageQueueRepository(txDb)));
  }

  findLastPendingForUpdate(sessionId: number): Promise<MessageQueue | null> {
    return this.db.queryOne<MessageQueue>(
      `SELECT * FROM message_queue WHERE session_id = ? AND status = 'PENDING' AND ${notDeleted()} ORDER BY sort_order DESC, id DESC LIMIT 1 FOR UPDATE`,
      [sessionId],
    );
  }

  findFirstPendingForUpdate(sessionId: number): Promise<MessageQueue | null> {
    return this.db.queryOne<MessageQueue>(
      `SELECT * FROM message_queue WHERE session_id = ? AND status = 'PENDING' AND ${notDeleted()} ORDER BY sort_order ASC, id ASC LIMIT 1 FOR UPDATE`,
      [sessionId],
    );
  }

  findById(id: number): Promise<MessageQueue | null> {
    return this.db.queryOne<MessageQueue>(`SELECT * FROM message_queue WHERE id = ? AND ${notDeleted()}`, [id]);
  }

  findByIdForUpdate(id: number): Promise<MessageQueue | null> {
    return this.db.queryOne<MessageQueue>(
      `SELECT * FROM message_queue WHERE id = ? AND ${notDeleted()} FOR UPDATE`,
      [id],
    );
  }

  async insert(item: MessageQueue): Promise<number> {
    const id = await this.db.insert('message_queue', {
      sessionId: item.sessionId,
      userId: item.userId,
      content: item.content,
      images: item.images,
      sortOrder: item.sortOrder,
      status: item.status ?? 'PENDING',
      scheduledTaskId: item.scheduledTaskId ?? null,
        sourceType: item.sourceType ?? null,
        openTriggerId: item.openTriggerId ?? null,
        openCallLogId: item.openCallLogId ?? null,
        deleted: 0,
    });
    item.id = id;
    return id;
  }

  async updateById(item: MessageQueue): Promise<void> {
    if (item.id == null) {
      return;
    }
    await this.db.updateById('message_queue', item.id, {
      content: item.content,
      images: item.images,
      sortOrder: item.sortOrder,
      status: item.status,
    });
  }

  findLastPending(sessionId: number): Promise<MessageQueue | null> {
    return this.db.queryOne<MessageQueue>(
      `SELECT * FROM message_queue WHERE session_id = ? AND status = 'PENDING' AND ${notDeleted()} ORDER BY sort_order DESC, id DESC LIMIT 1`,
      [sessionId],
    );
  }

  findHeadPending(sessionId: number): Promise<MessageQueue | null> {
    return this.db.queryOne<MessageQueue>(
      `SELECT * FROM message_queue WHERE session_id = ? AND status = 'PENDING' AND ${notDeleted()} ORDER BY sort_order ASC, id ASC LIMIT 1`,
      [sessionId],
    );
  }

  findNeighborUp(sessionId: number, sortOrder: number): Promise<MessageQueue | null> {
    return this.db.queryOne<MessageQueue>(
      `SELECT * FROM message_queue WHERE session_id = ? AND status = 'PENDING' AND ${notDeleted()} AND sort_order < ? ORDER BY sort_order DESC, id DESC LIMIT 1`,
      [sessionId, sortOrder],
    );
  }

  findNeighborDown(sessionId: number, sortOrder: number): Promise<MessageQueue | null> {
    return this.db.queryOne<MessageQueue>(
      `SELECT * FROM message_queue WHERE session_id = ? AND status = 'PENDING' AND ${notDeleted()} AND sort_order > ? ORDER BY sort_order ASC, id ASC LIMIT 1`,
      [sessionId, sortOrder],
    );
  }

  findNeighborUpForUpdate(sessionId: number, sortOrder: number): Promise<MessageQueue | null> {
    return this.db.queryOne<MessageQueue>(
      `SELECT * FROM message_queue WHERE session_id = ? AND status = 'PENDING' AND ${notDeleted()} AND sort_order < ? ORDER BY sort_order DESC, id DESC LIMIT 1 FOR UPDATE`,
      [sessionId, sortOrder],
    );
  }

  findNeighborDownForUpdate(sessionId: number, sortOrder: number): Promise<MessageQueue | null> {
    return this.db.queryOne<MessageQueue>(
      `SELECT * FROM message_queue WHERE session_id = ? AND status = 'PENDING' AND ${notDeleted()} AND sort_order > ? ORDER BY sort_order ASC, id ASC LIMIT 1 FOR UPDATE`,
      [sessionId, sortOrder],
    );
  }

  listPending(sessionId: number): Promise<MessageQueue[]> {
    return this.db.query<MessageQueue>(
      `SELECT * FROM message_queue WHERE session_id = ? AND status = 'PENDING' AND ${notDeleted()} ORDER BY sort_order ASC, id ASC`,
      [sessionId],
    );
  }

  listPendingForUpdate(sessionId: number): Promise<MessageQueue[]> {
    return this.db.query<MessageQueue>(
      `SELECT * FROM message_queue WHERE session_id = ? AND status = 'PENDING' AND ${notDeleted()} ORDER BY sort_order ASC, id ASC FOR UPDATE`,
      [sessionId],
    );
  }

  async clearPending(sessionId: number): Promise<void> {
    await this.db.execute(
      `UPDATE message_queue SET status = 'DELETED' WHERE session_id = ? AND status = 'PENDING' AND ${notDeleted()}`,
      [sessionId],
    );
  }

  /**
   * 会话已不存在 / 已逻辑删除时，把其 PENDING 队列行置为 DELETED。
   * 处理删除后才入队的并发残留与历史孤儿；终态行仍按保留期统一清理。
   */
  async clearOrphanedPendingBatch(limit: number): Promise<number> {
    const result = await this.db.execute(
      `UPDATE message_queue
       SET status = 'DELETED'
       WHERE status = 'PENDING' AND deleted = 0
         AND NOT EXISTS (
           SELECT 1 FROM \`session\` s WHERE s.id = message_queue.session_id AND s.deleted = 0
         )
       ORDER BY updated_at, id
       LIMIT ${clampLimit(limit)}`,
    );
    return Number(result.affectedRows ?? 0);
  }

  /**
   * 分批删除已消费 / 已移除的队列行，返回实际删除行数。
   * 业务只读取 PENDING 行，终态行仅保留一段时间供排障；LIMIT 钳制在 1~5000。
   */
  async deleteTerminalBatch(cutoff: string, limit: number): Promise<number> {
    const result = await this.db.execute(
      `DELETE FROM message_queue WHERE status = 'DELETED' AND updated_at < ? ORDER BY updated_at, id LIMIT ${clampLimit(limit)}`,
      [cutoff],
    );
    return Number(result.affectedRows ?? 0);
  }
}

function clampLimit(limit: number): number {
  return Number.isFinite(limit) ? Math.max(1, Math.min(5000, Math.floor(limit))) : 1;
}

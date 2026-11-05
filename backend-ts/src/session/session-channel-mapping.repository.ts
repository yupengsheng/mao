import type { Db } from '../db/db.js';

function clampLimit(limit: number): number {
  return Number.isFinite(limit) ? Math.max(1, Math.min(5000, Math.floor(limit))) : 1;
}

/**
 * 通道会话映射回收：weixin_session_peer / feishu_thread_session / feishu_session_channel
 * 都以 session_id 指向会话。会话被逻辑删除后，这些映射不会再被合法使用，需及时回收。
 */
export class SessionChannelMappingRepository {
  constructor(private readonly db: Db) {}

  /** 删除三个通道映射表中属于指定会话的行（会话删除 / 边路提升路径使用）。 */
  async deleteBySessionId(sessionId: number): Promise<void> {
    await this.db.execute('DELETE FROM weixin_session_peer WHERE session_id = ?', [sessionId]);
    await this.db.execute('DELETE FROM feishu_thread_session WHERE session_id = ?', [sessionId]);
    await this.db.execute('DELETE FROM feishu_session_channel WHERE session_id = ?', [sessionId]);
  }

  /** 批量删除 session 已不存在或已逻辑删除的微信对端映射。 */
  deleteOrphanWeixinPeerBatch(limit: number): Promise<number> {
    return this.deleteOrphanBatch(
      `DELETE FROM weixin_session_peer WHERE session_id IN (
         SELECT session_id FROM (
           SELECT p.session_id
           FROM weixin_session_peer p
           LEFT JOIN \`session\` s ON s.id = p.session_id
           WHERE s.id IS NULL OR s.deleted = 1
           ORDER BY p.session_id
           LIMIT ?
         ) AS stale
       )`,
      limit,
    );
  }

  /** 批量删除 session 已不存在或已逻辑删除的飞书话题映射。 */
  deleteOrphanFeishuThreadBatch(limit: number): Promise<number> {
    return this.deleteOrphanBatch(
      `DELETE FROM feishu_thread_session WHERE id IN (
         SELECT id FROM (
           SELECT p.id
           FROM feishu_thread_session p
           LEFT JOIN \`session\` s ON s.id = p.session_id
           WHERE s.id IS NULL OR s.deleted = 1
           ORDER BY p.id
           LIMIT ?
         ) AS stale
       )`,
      limit,
    );
  }

  /** 批量删除 session 已不存在或已逻辑删除的飞书会话通道绑定。 */
  deleteOrphanFeishuSessionChannelBatch(limit: number): Promise<number> {
    return this.deleteOrphanBatch(
      `DELETE FROM feishu_session_channel WHERE session_id IN (
         SELECT session_id FROM (
           SELECT p.session_id
           FROM feishu_session_channel p
           LEFT JOIN \`session\` s ON s.id = p.session_id
           WHERE s.id IS NULL OR s.deleted = 1
           ORDER BY p.session_id
           LIMIT ?
         ) AS stale
       )`,
      limit,
    );
  }

  private async deleteOrphanBatch(sql: string, limit: number): Promise<number> {
    const result = await this.db.execute(sql, [clampLimit(limit)]);
    return result.affectedRows;
  }
}

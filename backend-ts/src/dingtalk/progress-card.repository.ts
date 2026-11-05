import type { Db } from '../db/db.js';
import { ACTIVE_PHASE_SQL_LIST } from '../session/util/session-group-key.js';

export interface DingtalkProgressCardRow {
  sessionId: number;
  botId: number;
  outTrackId: string;
  chatType: string;
  conversationId: string | null;
  senderUserid: string | null;
}

export function mapProgressCardRow(row: Record<string, unknown>): DingtalkProgressCardRow | null {
  const sessionId = Number(row.sessionId ?? row.session_id);
  const botId = Number(row.botId ?? row.bot_id);
  const outTrackId = String(row.outTrackId ?? row.out_track_id ?? '');
  if (!Number.isFinite(sessionId) || sessionId <= 0 || !Number.isFinite(botId) || botId <= 0 || outTrackId === '') return null;
  const conversationRaw = row.conversationId ?? row.conversation_id;
  const senderRaw = row.senderUserid ?? row.sender_userid;
  return {
    sessionId,
    botId,
    outTrackId,
    chatType: String(row.chatType ?? row.chat_type ?? ''),
    conversationId: conversationRaw == null ? null : String(conversationRaw),
    senderUserid: senderRaw == null ? null : String(senderRaw),
  };
}

export class MysqlDingtalkProgressCardRepository {
  constructor(private readonly db: Db) {}

  async upsert(row: DingtalkProgressCardRow): Promise<void> {
    await this.db.execute(
      `INSERT INTO dingtalk_progress_card (session_id, bot_id, out_track_id, chat_type, conversation_id, sender_userid)
       VALUES (?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE bot_id = VALUES(bot_id), out_track_id = VALUES(out_track_id),
         chat_type = VALUES(chat_type), conversation_id = VALUES(conversation_id), sender_userid = VALUES(sender_userid)`,
      [row.sessionId, row.botId, row.outTrackId, row.chatType, row.conversationId, row.senderUserid],
    );
  }

  async findBySessionId(sessionId: number): Promise<DingtalkProgressCardRow | null> {
    const row = await this.db.queryOne<Record<string, unknown>>(
      'SELECT session_id, bot_id, out_track_id, chat_type, conversation_id, sender_userid FROM dingtalk_progress_card WHERE session_id = ? LIMIT 1',
      [sessionId],
    );
    return row == null ? null : mapProgressCardRow(row);
  }

  async findByOutTrackId(outTrackId: string): Promise<DingtalkProgressCardRow | null> {
    const row = await this.db.queryOne<Record<string, unknown>>(
      'SELECT session_id, bot_id, out_track_id, chat_type, conversation_id, sender_userid FROM dingtalk_progress_card WHERE out_track_id = ? LIMIT 1',
      [outTrackId],
    );
    return row == null ? null : mapProgressCardRow(row);
  }

  async deleteBySessionId(sessionId: number): Promise<void> {
    await this.db.execute('DELETE FROM dingtalk_progress_card WHERE session_id = ?', [sessionId]);
  }

  /**
   * 分批删除过期的进度卡映射。只清理会话已不存在 / 已逻辑删除 / 非活跃相位的行，
   * 运行中、待恢复、等待审批与取消中的会话即使映射很旧也保留。LIMIT 钳制在 1~5000。
   */
  async deleteStaleBatch(cutoff: string, limit: number): Promise<number> {
    const safeLimit = Number.isFinite(limit)
      ? Math.max(1, Math.min(5000, Math.floor(limit)))
      : 1;
    const result = await this.db.execute(
      `DELETE FROM dingtalk_progress_card WHERE session_id IN (
         SELECT session_id FROM (
           SELECT p.session_id
           FROM dingtalk_progress_card p
           LEFT JOIN session s ON s.id = p.session_id
           WHERE p.updated_at < ?
             AND (
               s.id IS NULL
               OR s.deleted = 1
               OR s.phase IS NULL
               OR s.phase NOT IN (${ACTIVE_PHASE_SQL_LIST})
             )
           ORDER BY p.updated_at, p.session_id
           LIMIT ${safeLimit}
         ) candidates
       )`,
      [cutoff],
    );
    return Number(result.affectedRows ?? 0);
  }
}

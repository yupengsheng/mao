import type { Db } from '../db/db.js';
import { notDeleted } from '../db/db.js';
import type { SessionActivity, SessionTodo, SubagentExecution } from './types.js';

export class SessionActivityRepository {
  constructor(private readonly db: Db) {}

  async insert(activity: SessionActivity): Promise<number> {
    const id = await this.db.insert('session_activity', {
      sessionId: activity.sessionId,
      type: activity.type,
      target: activity.target,
      summary: activity.summary,
      detailJson: activity.detailJson,
      status: activity.status,
      durationMs: activity.durationMs,
    });
    activity.id = id;
    return id;
  }

  listBySession(sessionId: number, limit: number): Promise<SessionActivity[]> {
    return this.db.query<SessionActivity>(
      `SELECT * FROM session_activity WHERE session_id = ? ORDER BY created_at DESC LIMIT ?`,
      [sessionId, limit],
    );
  }

  /**
   * run 轨迹用：会话全部活动行（id 升序）。
   * 归属以 tool_call_id 配现存消息为准，异步插入可能晚于下一条用户消息，
   * 因此不能按 created_at 窗口裁剪；行数随会话规模增长，P1 接受整表拉取。
   */
  selectBySessionAll(sessionId: number): Promise<SessionActivity[]> {
    return this.db.query<SessionActivity>(
      `SELECT * FROM session_activity WHERE session_id = ? ORDER BY id ASC`,
      [sessionId],
    );
  }

  /** 按创建时间分批删除过期活动，走 idx_session_activity_created。 */
  async deleteBatch(cutoff: string, limit: number): Promise<number> {
    const safeLimit = Math.max(1, Math.min(5000, Math.floor(limit)));
    const result = await this.db.execute(
      `DELETE FROM session_activity WHERE created_at < ? ORDER BY created_at, id LIMIT ${safeLimit}`,
      [cutoff],
    );
    return result.affectedRows;
  }
}

export class SessionTodoRepository {
  constructor(private readonly db: Db) {}

  async insert(todo: SessionTodo): Promise<number> {
    const id = await this.db.insert('session_todo', {
      sessionId: todo.sessionId,
      content: todo.content ?? '',
      description: todo.description ?? '',
      activeForm: todo.activeForm ?? '',
      status: todo.status ?? 'pending',
      sortOrder: todo.sortOrder ?? 0,
      owner: todo.owner ?? null,
      claimedAt: todo.claimedAt ?? null,
      blockedBy: todo.blockedBy ?? null,
    });
    todo.id = id;
    return id;
  }

  listBySession(sessionId: number): Promise<SessionTodo[]> {
    return this.db.query<SessionTodo>(
      `SELECT * FROM session_todo WHERE session_id = ? AND ${notDeleted()} ORDER BY sort_order ASC, id ASC`,
      [sessionId],
    );
  }

  async resetInProgressExcept(sessionId: number, todoId: number): Promise<void> {
    await this.db.execute(
      `UPDATE session_todo SET status = 'pending' WHERE session_id = ? AND status = 'in_progress' AND id <> ? AND ${notDeleted()}`,
      [sessionId, todoId],
    );
  }

  async updateFields(todoId: number, sessionId: number, fields: Record<string, unknown>): Promise<void> {
    const row: Record<string, unknown> = {};
    if (fields.status !== undefined) row.status = fields.status;
    if (fields.content !== undefined) row.content = fields.content;
    if (Object.keys(row).length === 0) {
      return;
    }
    const keys = Object.keys(row);
    await this.db.execute(
      `UPDATE session_todo SET ${keys.map((k) => `\`${camelToSnake(k)}\` = ?`).join(', ')} WHERE id = ? AND session_id = ? AND ${notDeleted()}`,
      [...Object.values(row), todoId, sessionId],
    );
  }

  async logicalDelete(todoId: number, sessionId: number): Promise<void> {
    await this.db.execute(
      `UPDATE session_todo SET deleted = 1 WHERE id = ? AND session_id = ? AND ${notDeleted()}`,
      [todoId, sessionId],
    );
  }
}

export class SubagentExecutionRepository {
  constructor(private readonly db: Db) {}

  findByChildSessionIds(childIds: number[]): Promise<SubagentExecution[]> {
    if (childIds.length === 0) {
      return Promise.resolve([]);
    }
    const placeholders = childIds.map(() => '?').join(',');
    return this.db.query<SubagentExecution>(
      `SELECT * FROM subagent_execution WHERE child_session_id IN (${placeholders}) ORDER BY id DESC`,
      childIds,
    );
  }

  /**
   * 分批删除过期且结果已收口的执行记录。
   * 子会话仍存在时保留该子会话 id 最大的一条，避免 /subagents 元数据、进度与重试入口丢失；
   * 子会话已逻辑删除或不存在时不再保留。LIMIT 钳制在 1~5000。
   */
  async deleteBatch(cutoff: string, limit: number): Promise<number> {
    const safeLimit = Number.isFinite(limit)
      ? Math.max(1, Math.min(5000, Math.floor(limit)))
      : 1;
    const result = await this.db.execute(
      `DELETE FROM subagent_execution WHERE id IN (
         SELECT candidate_id FROM (
           SELECT e.id AS candidate_id
           FROM subagent_execution e
           LEFT JOIN session s ON s.id = e.child_session_id AND s.deleted = 0
           WHERE e.status IN ('COMPLETED', 'FAILED', 'CANCELLED')
             AND e.delivery_status IN ('DELIVERED', 'SUPPRESSED', 'LEGACY')
             AND e.updated_at < ?
             AND (
               s.id IS NULL
               OR e.id <> (
                 SELECT MAX(latest.id) FROM subagent_execution latest
                 WHERE latest.child_session_id = e.child_session_id
               )
             )
           ORDER BY e.updated_at, e.id
           LIMIT ${safeLimit}
         ) candidates
       )`,
      [cutoff],
    );
    return Number(result.affectedRows ?? 0);
  }
}

function camelToSnake(key: string): string {
  return key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
}

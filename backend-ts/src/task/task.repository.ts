import type { Db } from '../db/db.js';
import { notDeleted } from '../db/db.js';
import type { Session } from '../session/types.js';
import type { AgentTask, TaskExecution, TaskPage, TaskPageFilter, TaskRepairCandidate, TaskTrigger } from './types.js';

export class TaskRepository {
  constructor(private readonly db: Db) {}

  transaction<T>(work: (repo: TaskRepository) => Promise<T>): Promise<T> {
    return this.db.transaction((db) => work(new TaskRepository(db)));
  }

  lockSession(userId: number, sessionId: number): Promise<Session | null> {
    return this.db.queryOne<Session>(
      'SELECT * FROM `session` WHERE id = ? AND user_id = ? AND deleted = 0 FOR UPDATE',
      [sessionId, userId],
    );
  }

  async findBySessionId(userId: number, sessionId: number): Promise<AgentTask | null> {
    return this.db.queryOne<AgentTask>(
      `SELECT * FROM agent_task WHERE user_id = ? AND session_id = ? AND ${notDeleted()} LIMIT 1`,
      [userId, sessionId],
    );
  }

  async findById(userId: number, id: number): Promise<AgentTask | null> {
    return this.db.queryOne<AgentTask>(
      `SELECT * FROM agent_task WHERE user_id = ? AND id = ? AND ${notDeleted()} AND EXISTS
        (SELECT 1 FROM \`session\` s WHERE s.id = agent_task.session_id AND s.user_id = agent_task.user_id AND s.deleted = 0) LIMIT 1`,
      [userId, id],
    );
  }

  async insert(task: AgentTask): Promise<number> {
    return this.db.insert('agent_task', task);
  }

  async updateById(id: number, fields: Partial<AgentTask>): Promise<void> {
    await this.db.updateById('agent_task', id, fields);
    await this.db.execute('UPDATE agent_task SET updated_at = CURRENT_TIMESTAMP WHERE id = ?', [id]);
  }

  /**
   * 回收会话任务域：任务主档逻辑删除，执行与入口记录物理删除。
   * 三张表都以 session_id 归属，直接按会话清理可同时覆盖历史孤儿；
   * 调用方必须放在事务内，避免只删掉部分子记录。
   */
  async deleteBySessionId(sessionId: number): Promise<void> {
    await this.db.execute('DELETE FROM agent_task_trigger WHERE session_id = ?', [sessionId]);
    await this.db.execute('DELETE FROM agent_task_execution WHERE session_id = ?', [sessionId]);
    await this.db.execute(
      'UPDATE agent_task SET deleted = 1, updated_at = CURRENT_TIMESTAMP WHERE session_id = ? AND deleted = 0',
      [sessionId],
    );
  }

  async count(filter: TaskPageFilter): Promise<number> {
    const { where, params } = this.where(filter);
    const row = await this.db.queryOne<{ total: number }>(`SELECT COUNT(*) AS total FROM agent_task WHERE ${where}`, params);
    return Number(row?.total ?? 0);
  }

  async page(filter: TaskPageFilter): Promise<TaskPage> {
    const { where, params } = this.where(filter);
    const offset = (filter.page - 1) * filter.size;
    const items = await this.db.query<AgentTask>(
      `SELECT * FROM agent_task WHERE ${where} ORDER BY updated_at DESC, id DESC LIMIT ? OFFSET ?`,
      [...params, filter.size, offset],
    );
    return { items, total: await this.count(filter), page: filter.page, size: filter.size };
  }

  async latestExecution(taskId: number): Promise<TaskExecution | null> {
    return this.db.queryOne<TaskExecution>(
      'SELECT * FROM agent_task_execution WHERE task_id = ? ORDER BY id DESC LIMIT 1',
      [taskId],
    );
  }

  async executionById(executionId: string): Promise<TaskExecution | null> {
    return this.db.queryOne<TaskExecution>(
      'SELECT * FROM agent_task_execution WHERE execution_id = ? LIMIT 1',
      [executionId],
    );
  }

  /**
   * 终态会话下仍可能未收口的任务。只返回超过宽限期的会话，避免与正在执行的
   * finishExecution 竞争；具体归属与状态会在修复事务中重新锁定校验。
   */
  listRepairCandidates(staleBefore: string, limit: number): Promise<TaskRepairCandidate[]> {
    return this.db.query<TaskRepairCandidate>(
      `SELECT t.id AS task_id, t.user_id, t.session_id
         FROM agent_task t
         JOIN \`session\` s ON s.id = t.session_id AND s.user_id = t.user_id
        WHERE t.deleted = 0 AND s.deleted = 0
          AND s.phase IN ('COMPLETED', 'FAILED', 'CANCELLED')
          AND COALESCE(s.last_activity_at, s.updated_at, s.created_at) <= ?
          AND (
            EXISTS (
              SELECT 1 FROM agent_task_execution e
               WHERE e.task_id = t.id AND e.status IN ('WORKING', 'BLOCKED')
            )
            OR (
              EXISTS (SELECT 1 FROM agent_task_execution e WHERE e.task_id = t.id)
              AND NOT EXISTS (
                SELECT 1 FROM agent_task_execution e
                 WHERE e.task_id = t.id
                   AND e.id = (SELECT MAX(x.id) FROM agent_task_execution x WHERE x.task_id = t.id)
                   AND e.execution_id = t.last_execution_id
                   AND e.status = t.stage
              )
            )
            OR (
              NOT EXISTS (SELECT 1 FROM agent_task_execution e WHERE e.task_id = t.id)
              AND (t.stage <> s.phase OR t.last_execution_id IS NOT NULL)
            )
          )
        ORDER BY COALESCE(s.last_activity_at, s.updated_at, s.created_at) ASC, t.id ASC
        LIMIT ?`,
      [staleBefore, limit],
    );
  }

  unfinishedExecutions(taskId: number): Promise<TaskExecution[]> {
    return this.db.query<TaskExecution>(
      `SELECT * FROM agent_task_execution
        WHERE task_id = ? AND status IN ('WORKING', 'BLOCKED')
        ORDER BY attempt_no DESC, id DESC`,
      [taskId],
    );
  }

  async insertExecution(execution: TaskExecution): Promise<number> {
    return this.db.insert('agent_task_execution', execution);
  }

  async updateExecution(id: number, fields: Partial<TaskExecution>): Promise<void> {
    await this.db.updateById('agent_task_execution', id, fields);
  }

  /**
   * 清理超过保留期且不属于任务最近 keepPerTask 次尝试的终态执行，并删除对应入口记录。
   * 只处理 COMPLETED / FAILED / CANCELLED，绝不触碰 WORKING / BLOCKED；单批使用
   * ORDER BY id LIMIT，避免长事务，多实例重复执行幂等。
   */
  async deleteStaleExecutions(cutoff: string, keepPerTask: number, limit: number): Promise<number> {
    const safeKeep = Number.isFinite(keepPerTask) && keepPerTask > 0 ? Math.trunc(keepPerTask) : 200;
    const safeLimit = Number.isFinite(limit) && limit > 0 ? Math.min(5000, Math.trunc(limit)) : 500;
    return this.db.transaction(async (db) => {
      const executions = await db.query<{ id: number; executionId: string }>(
        `SELECT e.id, e.execution_id
           FROM agent_task_execution e
          WHERE e.status IN ('COMPLETED', 'FAILED', 'CANCELLED')
            AND e.created_at < ?
            AND e.attempt_no <= (
              SELECT MAX(x.attempt_no) - ? FROM agent_task_execution x WHERE x.task_id = e.task_id
            )
          ORDER BY e.id ASC
          LIMIT ?`,
        [cutoff, safeKeep, safeLimit],
      );
      if (executions.length === 0) return 0;

      const ids = executions.map((execution) => execution.id);
      const executionIds = executions.map((execution) => execution.executionId);
      const placeholders = ids.map(() => '?').join(', ');
      await db.execute(
        `DELETE FROM agent_task_trigger WHERE source_event_id IN (${placeholders})`,
        executionIds,
      );
      const result = await db.execute(
        `DELETE FROM agent_task_execution WHERE id IN (${placeholders})`,
        ids,
      );
      return Number(result.affectedRows ?? 0);
    });
  }

  async insertTrigger(trigger: TaskTrigger): Promise<void> {
    await this.db.insert('agent_task_trigger', trigger);
  }

  async triggerByExecutionId(executionId: string): Promise<TaskTrigger | null> {
    return this.db.queryOne<TaskTrigger>(
      'SELECT * FROM agent_task_trigger WHERE source_event_id = ? LIMIT 1',
      [executionId],
    );
  }

  triggers(taskId: number): Promise<TaskTrigger[]> {
    return this.db.query<TaskTrigger>('SELECT * FROM agent_task_trigger WHERE task_id = ? ORDER BY id DESC LIMIT 50', [taskId]);
  }

  executions(taskId: number): Promise<TaskExecution[]> {
    return this.db.query<TaskExecution>('SELECT * FROM agent_task_execution WHERE task_id = ? ORDER BY id DESC LIMIT 50', [taskId]);
  }

  private where(filter: TaskPageFilter): { where: string; params: unknown[] } {
    const clauses = ['user_id = ?', 'deleted = 0',
      'EXISTS (SELECT 1 FROM `session` s WHERE s.id = agent_task.session_id AND s.user_id = agent_task.user_id AND s.deleted = 0)'];
    const params: unknown[] = [filter.userId];
    if (filter.stage != null) { clauses.push('stage = ?'); params.push(filter.stage); }
    if (filter.source != null) { clauses.push('source = ?'); params.push(filter.source); }
    if (filter.agentId != null) { clauses.push('agent_id = ?'); params.push(filter.agentId); }
    if (filter.sessionId != null) { clauses.push('session_id = ?'); params.push(filter.sessionId); }
    return { where: clauses.join(' AND '), params };
  }
}

import type { Db } from '../db/db.js';
import { notDeleted } from '../db/db.js';
import type { Session } from '../session/types.js';
import type { AgentTask, TaskExecution, TaskPage, TaskPageFilter, TaskTrigger } from './types.js';

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

  async insertExecution(execution: TaskExecution): Promise<number> {
    return this.db.insert('agent_task_execution', execution);
  }

  async updateExecution(id: number, fields: Partial<TaskExecution>): Promise<void> {
    await this.db.updateById('agent_task_execution', id, fields);
  }

  async insertTrigger(trigger: TaskTrigger): Promise<void> {
    await this.db.insert('agent_task_trigger', trigger);
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

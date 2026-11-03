import { BusinessException } from '../common/business-exception.js';
import { ErrorCode } from '../common/error-code.js';
import { nowSql } from '../common/datetime.js';
import type { AgentTaskVO, TaskDetailVO, TaskExecutionVO, TaskPageVO, TaskTriggerVO } from '@mao/contracts';
import type { Session } from '../session/types.js';
import type { TaskRepository } from './task.repository.js';
import type { AgentTask, TaskExecution, TaskPageFilter, TaskSource, TaskStage, TaskTrigger } from './types.js';

const TERMINAL = new Set<TaskStage>(['COMPLETED', 'FAILED', 'CANCELLED']);

function sourceOf(session: Session, source?: TaskSource): TaskSource {
  if (source != null && source !== 'MANUAL') return source;
  if (session.source === 'signal') return 'SIGNAL';
  if (session.source === 'feishu') return 'FEISHU';
  if (session.source === 'weixin') return 'WEIXIN';
  if (session.source === 'dingtalk') return 'DINGTALK';
  return 'MANUAL';
}

export class TaskService {
  constructor(private readonly repo: TaskRepository) {}

  async beginExecution(session: Session, executionId: string, source?: TaskSource): Promise<TaskExecution> {
    this.validate(session, executionId);
    return this.repo.transaction(async (repo) => {
      const current = await repo.lockSession(session.userId, session.id!);
      if (current == null) throw new BusinessException(ErrorCode.SESSION_NOT_FOUND);
      const actualSource = sourceOf(current, source);
      const task = await this.ensureTask(repo, current, actualSource);
      const existing = await repo.executionById(executionId);
      if (existing != null) {
        this.requireExecutionOwner(existing, task);
        return existing;
      }
      const execution = await this.createExecution(repo, task, executionId, 'WORKING', actualSource);
      await repo.updateById(task.id!, { stage: 'WORKING', lastExecutionId: executionId, title: this.title(current), agentId: current.agentId ?? null });
      return execution;
    });
  }

  async setExecutionStage(session: Session, executionId: string, stage: 'WORKING' | 'BLOCKED'): Promise<void> {
    this.validate(session, executionId);
    await this.repo.transaction(async (repo) => {
      const current = await repo.lockSession(session.userId, session.id!);
      if (current == null) throw new BusinessException(ErrorCode.SESSION_NOT_FOUND);
      if (!['RUNNING', 'RESUMING', 'WAITING_APPROVAL'].includes(current.phase ?? '')) return;
      const task = await repo.findBySessionId(current.userId, current.id!);
      if (task == null || task.lastExecutionId !== executionId) return;
      const execution = await repo.executionById(executionId);
      if (execution == null) return;
      this.requireExecutionOwner(execution, task);
      if (execution.status !== 'WORKING' && execution.status !== 'BLOCKED') return;
      if (execution.status !== stage) await repo.updateExecution(execution.id!, { status: stage });
      if (task.stage !== stage) await repo.updateById(task.id!, { stage });
    });
  }

  async settleExecution(session: Session, executionId: string, phase: TaskStage, failureReason?: string | null, source?: TaskSource): Promise<void> {
    this.validate(session, executionId);
    if (!TERMINAL.has(phase)) throw new BusinessException(ErrorCode.PARAM_INVALID, '只接受执行终态');
    await this.repo.transaction(async (repo) => {
      const current = await repo.lockSession(session.userId, session.id!);
      if (current == null) throw new BusinessException(ErrorCode.SESSION_NOT_FOUND);
      const actualSource = sourceOf(current, source);
      const task = await this.ensureTask(repo, current, actualSource);
      let execution = await repo.executionById(executionId);
      if (execution != null) {
        this.requireExecutionOwner(execution, task);
        if (TERMINAL.has(execution.status)) return;
      } else {
        execution = await this.createExecution(repo, task, executionId, phase, actualSource);
      }
      await repo.updateExecution(execution.id!, { status: phase, finishedAt: nowSql(), failureReason: failureReason ?? null });
      const currentExecution = task.lastExecutionId == null ? null : await repo.executionById(task.lastExecutionId);
      if (currentExecution == null || execution.attemptNo >= currentExecution.attemptNo) {
        await repo.updateById(task.id!, { stage: phase, lastExecutionId: executionId, title: this.title(current), agentId: current.agentId ?? null });
      }
    });
  }

  async page(filter: TaskPageFilter): Promise<TaskPageVO> {
    const result = await this.repo.page(filter);
    return { ...result, items: result.items.map((task) => this.taskVO(task)) };
  }

  async get(userId: number, id: number): Promise<TaskDetailVO | null> {
    const task = await this.repo.findById(userId, id);
    if (task == null) return null;
    const [latest, executions, triggers] = await Promise.all([
      this.repo.latestExecution(id), this.repo.executions(id), this.repo.triggers(id),
    ]);
    return {
      task: this.taskVO(task),
      latestExecution: latest == null ? null : this.executionVO(latest),
      executions: executions.map((execution) => this.executionVO(execution)),
      triggers: triggers.map((trigger) => this.triggerVO(trigger)),
    };
  }

  private taskVO(task: AgentTask): AgentTaskVO {
    return {
      id: task.id!, agentId: task.agentId ?? null, sessionId: task.sessionId, title: task.title,
      stage: task.stage, source: task.source, lastExecutionId: task.lastExecutionId ?? null,
      createdAt: task.createdAt ?? null, updatedAt: task.updatedAt ?? null,
    };
  }

  private executionVO(execution: TaskExecution): TaskExecutionVO {
    return {
      id: execution.id!, taskId: execution.taskId, sessionId: execution.sessionId, executionId: execution.executionId,
      attemptNo: execution.attemptNo, status: execution.status, startedAt: execution.startedAt ?? null,
      finishedAt: execution.finishedAt ?? null, failureReason: execution.failureReason ?? null,
      createdAt: execution.createdAt ?? null,
    };
  }

  private triggerVO(trigger: TaskTrigger): TaskTriggerVO {
    return {
      id: trigger.id!, taskId: trigger.taskId, sessionId: trigger.sessionId,
      source: trigger.source, sourceEventId: trigger.sourceEventId, createdAt: trigger.createdAt ?? null,
    };
  }

  private async ensureTask(repo: TaskRepository, session: Session, source: TaskSource): Promise<AgentTask> {
    const existing = await repo.findBySessionId(session.userId, session.id!);
    if (existing != null) return existing;
    const task: AgentTask = { userId: session.userId, agentId: session.agentId ?? null, sessionId: session.id!, title: this.title(session), stage: 'QUEUED', source, lastExecutionId: null };
    task.id = await repo.insert(task);
    return task;
  }

  private async createExecution(repo: TaskRepository, task: AgentTask, executionId: string, status: TaskStage, source: TaskSource): Promise<TaskExecution> {
    const latest = await repo.latestExecution(task.id!);
    const execution: TaskExecution = {
      taskId: task.id!, sessionId: task.sessionId, executionId, attemptNo: (latest?.attemptNo ?? 0) + 1,
      status, startedAt: status === 'WORKING' ? nowSql() : null, failureReason: null,
    };
    execution.id = await repo.insertExecution(execution);
    await repo.insertTrigger({ taskId: task.id!, sessionId: task.sessionId, source, sourceEventId: executionId });
    return execution;
  }

  private validate(session: Session, executionId: string): void {
    if (session.id == null || !Number.isSafeInteger(session.id) || session.id <= 0 || !executionId.trim() || executionId.length > 128) {
      throw new BusinessException(ErrorCode.PARAM_INVALID, '有效的会话和 executionId 必填');
    }
  }

  private requireExecutionOwner(execution: TaskExecution, task: AgentTask): void {
    if (execution.taskId !== task.id || execution.sessionId !== task.sessionId) {
      throw new BusinessException(ErrorCode.PARAM_INVALID, 'executionId 已属于其他任务');
    }
  }

  private title(session: Session): string {
    return (session.title?.trim() || '未命名任务').slice(0, 512);
  }
}

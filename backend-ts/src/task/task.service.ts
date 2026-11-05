import { BusinessException } from '../common/business-exception.js';
import { ErrorCode } from '../common/error-code.js';
import { nowSql } from '../common/datetime.js';
import type { AgentTaskVO, TaskDetailVO, TaskExecutionVO, TaskPageVO, TaskTriggerVO } from '@mao/contracts';
import { OPEN_RUN_ADMISSION_POLICY_VERSION } from '../openapi/admission.js';
import type { Session } from '../session/types.js';
import type { TaskRepository } from './task.repository.js';
import type {
  AgentTask, BeginExecutionResult, ExternalEventRef, ExternalEventTrace, TaskExecution,
  TaskPageFilter, TaskSource, TaskStage, TaskTrigger,
} from './types.js';

const TERMINAL = new Set<TaskStage>(['COMPLETED', 'FAILED', 'CANCELLED']);
const INTERRUPTED_EXECUTION_REASON = '执行因进程中断未完成，已自动恢复';

function sourceOf(session: Session, source?: TaskSource): TaskSource {
  if (source != null && source !== 'MANUAL') return source;
  if (session.source === 'signal') return 'SIGNAL';
  if (session.source === 'feishu') return 'FEISHU';
  if (session.source === 'weixin') return 'WEIXIN';
  if (session.source === 'dingtalk') return 'DINGTALK';
  return 'MANUAL';
}

function policyVersionOf(source: TaskSource): string | null {
  return source === 'API' || source === 'WEBHOOK' || source === 'SIGNAL'
    ? OPEN_RUN_ADMISSION_POLICY_VERSION
    : null;
}

function isDuplicateKey(err: unknown): boolean {
  if (typeof err !== 'object' || err == null) return false;
  const value = err as { code?: string; errno?: number };
  return value.code === 'ER_DUP_ENTRY' || value.errno === 1062;
}

const TASK_STAGES = new Set<TaskStage>(['QUEUED', 'WORKING', 'BLOCKED', 'FAILED', 'COMPLETED', 'CANCELLED']);

/** 外部事件已被其他执行认领：必须抛出以回滚事务，由 beginExecution 在事务外重查。 */
class ExternalEventClaimedError extends Error {
  constructor(readonly externalEvent: ExternalEventRef) {
    super('external event already claimed');
    this.name = 'ExternalEventClaimedError';
  }
}

export class TaskService {
  constructor(private readonly repo: TaskRepository) {}

  async beginExecution(
    session: Session,
    executionId: string,
    source?: TaskSource,
    externalEvent?: ExternalEventRef | null,
  ): Promise<BeginExecutionResult> {
    this.validate(session, executionId);
    try {
      return await this.beginExecutionInTransaction(session, executionId, source, externalEvent);
    } catch (err) {
      if (!(err instanceof ExternalEventClaimedError)) throw err;
      const trace = await this.repo.externalEventTrace(err.externalEvent.scope, err.externalEvent.id);
      if (trace == null) throw err;
      return {
        execution: await this.repo.executionById(trace.executionId),
        duplicate: true,
      };
    }
  }

  private beginExecutionInTransaction(
    session: Session,
    executionId: string,
    source?: TaskSource,
    externalEvent?: ExternalEventRef | null,
  ): Promise<BeginExecutionResult> {
    return this.repo.transaction(async (repo) => {
      const current = await repo.lockSession(session.userId, session.id!);
      if (current == null) throw new BusinessException(ErrorCode.SESSION_NOT_FOUND);
      const actualSource = sourceOf(current, source);
      const existing = await repo.executionById(executionId);
      if (existing != null) {
        const task = await this.ensureTask(repo, current, actualSource);
        this.requireExecutionOwner(existing, task);
        return { execution: existing, duplicate: false };
      }
      // 外部事件先于任务主档创建：重复投递不得留下空 Task。
      const claimed = await this.duplicateExternalEvent(repo, externalEvent);
      if (claimed != null) return claimed;
      const task = await this.ensureTask(repo, current, actualSource);
      const created = await this.createExecution(repo, task, executionId, 'WORKING', actualSource, externalEvent);
      if (created.duplicate) return created;
      const execution = created.execution!;
      await repo.updateById(task.id!, this.taskFields(current, 'WORKING', executionId, actualSource));
      return created;
    });
  }

  async beginRecoveryExecution(session: Session, executionId: string): Promise<TaskExecution> {
    this.validate(session, executionId);
    return this.repo.transaction(async (repo) => {
      const current = await repo.lockSession(session.userId, session.id!);
      if (current == null) throw new BusinessException(ErrorCode.SESSION_NOT_FOUND);
      const fallbackSource = sourceOf(current);
      const task = await this.ensureTask(repo, current, fallbackSource);
      const existing = await repo.executionById(executionId);
      if (existing != null) {
        this.requireExecutionOwner(existing, task);
        return existing;
      }

      const interrupted = await repo.unfinishedExecutions(task.id!);
      let actualSource = fallbackSource;
      if (interrupted.length > 0) {
        const trigger = await repo.triggerByExecutionId(interrupted[0]!.executionId);
        if (trigger != null) actualSource = trigger.source;
        const finishedAt = nowSql();
        for (const execution of interrupted) {
          await repo.updateExecution(execution.id!, {
            status: 'FAILED', finishedAt, failureReason: INTERRUPTED_EXECUTION_REASON,
          });
        }
      }

      const created = await this.createExecution(repo, task, executionId, 'WORKING', actualSource);
      const execution = created.execution!;
      await repo.updateById(task.id!, this.taskFields(current, 'WORKING', executionId, actualSource));
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

  async getActiveExecutionId(session: Session): Promise<string | null> {
    if (session.id == null) return null;
    const task = await this.repo.findBySessionId(session.userId, session.id);
    if (task == null || task.userId !== session.userId || task.sessionId !== session.id || task.lastExecutionId == null) return null;
    if (task.stage !== 'WORKING' && task.stage !== 'BLOCKED') return null;
    const execution = await this.repo.executionById(task.lastExecutionId);
    if (execution == null || (execution.status !== 'WORKING' && execution.status !== 'BLOCKED')) return null;
    this.requireExecutionOwner(execution, task);
    return execution.executionId;
  }

  /** 会话删除 / 边路提升后的任务域回收；主档保留逻辑删除标记，子记录物理清理。 */
  async deleteBySessionId(sessionId: number): Promise<void> {
    if (!Number.isSafeInteger(sessionId) || sessionId <= 0) return;
    await this.repo.transaction((repo) => repo.deleteBySessionId(sessionId));
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
        const created = await this.createExecution(repo, task, executionId, phase, actualSource);
        execution = created.execution!;
      }
      await repo.updateExecution(execution.id!, { status: phase, finishedAt: nowSql(), failureReason: failureReason ?? null });
      const currentExecution = task.lastExecutionId == null ? null : await repo.executionById(task.lastExecutionId);
      if (currentExecution == null || execution.attemptNo >= currentExecution.attemptNo) {
        await repo.updateById(task.id!, this.taskFields(current, phase, executionId, actualSource));
      }
    });
  }

  async page(filter: TaskPageFilter): Promise<TaskPageVO> {
    const result = await this.repo.page(filter);
    return { ...result, items: result.items.map((task) => this.taskVO(task)) };
  }

  /** 开放触发入口的只读去重查询：命中即返回原会话与执行状态。 */
  async findExternalEvent(scope: string, id: string): Promise<ExternalEventTrace | null> {
    if (!scope.trim() || !id.trim()) return null;
    const trace = await this.repo.externalEventTrace(scope, id);
    if (trace == null) return null;
    const status = TASK_STAGES.has(trace.status as TaskStage) ? trace.status as TaskStage : 'WORKING';
    return { sessionId: trace.sessionId, executionId: trace.executionId, status };
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
      source: trigger.source, sourceEventId: trigger.sourceEventId,
      externalEventId: trigger.externalEventId ?? null,
      externalEventScope: trigger.externalEventScope ?? null,
      createdAt: trigger.createdAt ?? null,
    };
  }

  private async ensureTask(repo: TaskRepository, session: Session, source: TaskSource): Promise<AgentTask> {
    const existing = await repo.findBySessionId(session.userId, session.id!);
    if (existing != null) return existing;
    const task: AgentTask = {
      userId: session.userId, agentId: session.agentId ?? null, sessionId: session.id!, title: this.title(session),
      stage: 'QUEUED', source, policyVersion: policyVersionOf(source), lastExecutionId: null,
    };
    task.id = await repo.insert(task);
    return task;
  }

  private taskFields(session: Session, stage: TaskStage, executionId: string, source: TaskSource): Partial<AgentTask> {
    const policyVersion = policyVersionOf(source);
    return {
      stage, lastExecutionId: executionId, title: this.title(session), agentId: session.agentId ?? null,
      ...(policyVersion == null ? {} : { policyVersion }),
    };
  }

  private async createExecution(
    repo: TaskRepository,
    task: AgentTask,
    executionId: string,
    status: TaskStage,
    source: TaskSource,
    externalEvent?: ExternalEventRef | null,
  ): Promise<BeginExecutionResult> {
    const latest = await repo.latestExecution(task.id!);
    const execution: TaskExecution = {
      taskId: task.id!, sessionId: task.sessionId, executionId, attemptNo: (latest?.attemptNo ?? 0) + 1,
      status, startedAt: status === 'WORKING' ? nowSql() : null, failureReason: null,
    };
    execution.id = await repo.insertExecution(execution);
    try {
      await repo.insertTrigger({
        taskId: task.id!, sessionId: task.sessionId, source, sourceEventId: executionId,
        externalEventId: externalEvent?.id ?? null, externalEventScope: externalEvent?.scope ?? null,
      });
    } catch (e) {
      // 执行行刚插入成功，唯一键冲突只可能来自 Trigger。外部事件冲突必须抛出，
      // 让事务回滚本轮新建的执行；普通执行 ID 冲突直接上抛，避免留下无入口的执行。
      if (isDuplicateKey(e) && externalEvent != null
        && await repo.triggerByExternalEvent(externalEvent.scope, externalEvent.id) != null) {
        throw new ExternalEventClaimedError(externalEvent);
      }
      throw e;
    }
    return { execution, duplicate: false };
  }

  private async duplicateExternalEvent(repo: TaskRepository, externalEvent?: ExternalEventRef | null): Promise<BeginExecutionResult | null> {
    if (externalEvent == null) return null;
    const claimed = await repo.triggerByExternalEvent(externalEvent.scope, externalEvent.id);
    if (claimed == null) return null;
    return { execution: await repo.executionById(claimed.sourceEventId), duplicate: true };
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

import { formatDateTime } from '../common/json.js';
import type { TaskRepository } from './task.repository.js';
import type { TaskRepairCandidate, TaskStage } from './types.js';

const TERMINAL = new Set<TaskStage>(['COMPLETED', 'FAILED', 'CANCELLED']);

/** 终态后留出收口窗口，避免与 finishExecution / settleExecution 的正常写入竞争。 */
export const TASK_RECORD_REPAIR_STALE_MS = 120_000;
export const TASK_RECORD_REPAIR_INTERVAL_MS = 60_000;
export const TASK_RECORD_REPAIR_BATCH_SIZE = 100;
export const TASK_RECORD_REPAIR_FAILURE_REASON = '执行已结束但任务记录未收口，已自动修复';

export interface TaskRecordRepairOptions {
  intervalMs?: number;
  staleMs?: number;
  batchSize?: number;
  now?: () => Date;
}

/**
 * 任务记录一致性修复：只收敛已经进入终态的 Session。
 *
 * 修复不会新增执行尝试；最新未完成尝试收敛为 Session 终态，更早的未完成尝试
 * 统一失败关闭。Task 的 stage / lastExecutionId 以最新执行尝试为准。事务内会
 * 重新锁定 Session 并复核终态，重复执行无副作用。
 */
export class TaskRecordRepairService {
  private readonly intervalMs: number;
  private readonly staleMs: number;
  private readonly batchSize: number;
  private readonly now: () => Date;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = true;
  private repairing = false;

  constructor(
    private readonly repo: TaskRepository,
    options: TaskRecordRepairOptions = {},
  ) {
    this.intervalMs = options.intervalMs ?? TASK_RECORD_REPAIR_INTERVAL_MS;
    this.staleMs = options.staleMs ?? TASK_RECORD_REPAIR_STALE_MS;
    this.batchSize = options.batchSize ?? TASK_RECORD_REPAIR_BATCH_SIZE;
    this.now = options.now ?? (() => new Date());
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.scheduleNext(0);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer != null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  /** 修复一轮，返回实际收敛的任务数；任何存储异常只记录日志。 */
  async repairOnce(): Promise<number> {
    if (this.repairing) return 0;
    this.repairing = true;
    try {
      const cutoff = formatDateTime(new Date(this.now().getTime() - this.staleMs));
      const candidates = await this.repo.listRepairCandidates(cutoff, this.batchSize);
      let repaired = 0;
      for (const candidate of candidates) {
        try {
          if (await this.repairCandidate(candidate)) repaired += 1;
        } catch (error) {
          console.warn(
            `[task] record repair failed: taskId=${candidate.taskId}, sessionId=${candidate.sessionId}`,
            error,
          );
        }
      }
      if (repaired > 0) {
        console.info(`[task] repaired ${repaired} stale task record(s)`);
      }
      return repaired;
    } catch (error) {
      console.warn('[task] record repair scan failed', error);
      return 0;
    } finally {
      this.repairing = false;
    }
  }

  private repairCandidate(candidate: TaskRepairCandidate): Promise<boolean> {
    return this.repo.transaction(async (repo) => {
      const session = await repo.lockSession(candidate.userId, candidate.sessionId);
      if (session == null || session.id == null || !TERMINAL.has(session.phase as TaskStage)) return false;

      const task = await repo.findBySessionId(session.userId, session.id);
      if (task == null || task.id !== candidate.taskId) return false;

      const latest = await repo.latestExecution(task.id!);
      const unfinished = await repo.unfinishedExecutions(task.id!);
      const finishedAt = formatDateTime(this.now());
      for (const execution of unfinished) {
        const latestAttempt = latest != null && execution.id === latest.id;
        const status = latestAttempt ? session.phase as TaskStage : 'FAILED';
        await repo.updateExecution(execution.id!, {
          status,
          finishedAt,
          failureReason: status === 'FAILED' ? TASK_RECORD_REPAIR_FAILURE_REASON : null,
        });
      }

      if (latest == null) {
        if (task.stage === session.phase && task.lastExecutionId == null) return unfinished.length > 0;
        await repo.updateById(task.id!, { stage: session.phase as TaskStage, lastExecutionId: null });
        return true;
      }

      const latestRepaired = unfinished.some((execution) => execution.id === latest.id);
      const stage = latestRepaired ? session.phase as TaskStage : latest.status;
      const changed = task.stage !== stage || task.lastExecutionId !== latest.executionId;
      if (changed) {
        await repo.updateById(task.id!, { stage, lastExecutionId: latest.executionId });
      }
      return changed || unfinished.length > 0;
    });
  }

  private scheduleNext(delayMs: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.repairOnce().finally(() => this.scheduleNext(this.intervalMs));
    }, delayMs);
  }
}

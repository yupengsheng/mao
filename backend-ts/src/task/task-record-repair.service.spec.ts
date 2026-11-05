import { describe, expect, it, vi } from 'vitest';
import type { TaskRepository } from './task.repository.js';
import {
  TASK_RECORD_REPAIR_FAILURE_REASON,
  TaskRecordRepairService,
} from './task-record-repair.service.js';
import type { AgentTask, TaskExecution } from './types.js';

const NOW = new Date('2026-11-05T12:00:00+08:00');

function fixture(input: {
  phase?: string;
  task?: Partial<AgentTask>;
  executions?: TaskExecution[];
  candidates?: Array<{ taskId: number; userId: number; sessionId: number }>;
} = {}) {
  const session = {
    id: 11,
    userId: 7,
    phase: input.phase ?? 'COMPLETED',
    lastActivityAt: '2026-11-05 11:50:00',
  };
  const task: AgentTask = {
    id: 1,
    userId: 7,
    agentId: 2,
    sessionId: 11,
    title: '任务',
    stage: 'WORKING',
    source: 'API',
    lastExecutionId: 'latest',
    ...input.task,
  };
  const executions = (input.executions ?? [
    { id: 1, taskId: 1, sessionId: 11, executionId: 'older', attemptNo: 1, status: 'WORKING' },
    { id: 2, taskId: 1, sessionId: 11, executionId: 'latest', attemptNo: 2, status: 'BLOCKED' },
  ]).map((execution) => ({ ...execution }));
  const candidates = input.candidates ?? [{ taskId: 1, userId: 7, sessionId: 11 }];

  const repo = {
    listRepairCandidates: vi.fn(async () => candidates),
    transaction: async (work: (store: unknown) => Promise<unknown>) => work(repo),
    lockSession: vi.fn(async () => ({ ...session })),
    findBySessionId: vi.fn(async () => ({ ...task })),
    latestExecution: vi.fn(async () => executions.at(-1) ?? null),
    unfinishedExecutions: vi.fn(async () => executions
      .filter((execution) => execution.status === 'WORKING' || execution.status === 'BLOCKED')
      .sort((a, b) => b.attemptNo - a.attemptNo || (b.id ?? 0) - (a.id ?? 0))),
    updateExecution: vi.fn(async (id: number, fields: Partial<TaskExecution>) => {
      Object.assign(executions.find((execution) => execution.id === id)!, fields);
    }),
    updateById: vi.fn(async (_id: number, fields: Partial<AgentTask>) => {
      Object.assign(task, fields);
    }),
  };
  const service = new TaskRecordRepairService(repo as unknown as TaskRepository, {
    now: () => NOW,
    staleMs: 120_000,
    batchSize: 25,
  });
  return { service, repo, session, task, executions, candidates };
}

describe('TaskRecordRepairService', () => {
  it('closes the latest unfinished attempt with the session terminal phase and older attempts as failed', async () => {
    const setup = fixture();

    await expect(setup.service.repairOnce()).resolves.toBe(1);

    expect(setup.repo.listRepairCandidates).toHaveBeenCalledWith('2026-11-05 11:58:00', 25);
    expect(setup.executions[0]).toMatchObject({
      status: 'FAILED',
      finishedAt: '2026-11-05 12:00:00',
      failureReason: TASK_RECORD_REPAIR_FAILURE_REASON,
    });
    expect(setup.executions[1]).toMatchObject({
      status: 'COMPLETED',
      finishedAt: '2026-11-05 12:00:00',
      failureReason: null,
    });
    expect(setup.task).toMatchObject({ stage: 'COMPLETED', lastExecutionId: 'latest' });
  });

  it('uses FAILED for the latest unfinished attempt when the session failed', async () => {
    const setup = fixture({
      phase: 'FAILED',
      executions: [{ id: 2, taskId: 1, sessionId: 11, executionId: 'latest', attemptNo: 1, status: 'WORKING' }],
    });

    await setup.service.repairOnce();

    expect(setup.executions[0]).toMatchObject({
      status: 'FAILED',
      failureReason: TASK_RECORD_REPAIR_FAILURE_REASON,
    });
    expect(setup.task.stage).toBe('FAILED');
  });

  it('uses CANCELLED and clears the failure reason for the latest attempt of a cancelled session', async () => {
    const setup = fixture({
      phase: 'CANCELLED',
      executions: [{
        id: 2, taskId: 1, sessionId: 11, executionId: 'latest', attemptNo: 1,
        status: 'WORKING', failureReason: 'stale',
      }],
    });

    await setup.service.repairOnce();

    expect(setup.executions[0]).toMatchObject({ status: 'CANCELLED', failureReason: null });
    expect(setup.task.stage).toBe('CANCELLED');
  });

  it('does not modify a session that is still active', async () => {
    const setup = fixture({ phase: 'RUNNING' });

    await expect(setup.service.repairOnce()).resolves.toBe(0);

    expect(setup.repo.updateExecution).not.toHaveBeenCalled();
    expect(setup.repo.updateById).not.toHaveBeenCalled();
    expect(setup.task.stage).toBe('WORKING');
  });

  it('does not rewrite an already converged terminal task', async () => {
    const setup = fixture({
      task: { stage: 'COMPLETED', lastExecutionId: 'latest' },
      executions: [{ id: 2, taskId: 1, sessionId: 11, executionId: 'latest', attemptNo: 1, status: 'COMPLETED' }],
    });

    await expect(setup.service.repairOnce()).resolves.toBe(0);

    expect(setup.repo.updateExecution).not.toHaveBeenCalled();
    expect(setup.repo.updateById).not.toHaveBeenCalled();
  });

  it('converges a task without execution rows to the session terminal phase', async () => {
    const setup = fixture({
      executions: [],
      task: { stage: 'WORKING', lastExecutionId: 'missing' },
    });

    await expect(setup.service.repairOnce()).resolves.toBe(1);

    expect(setup.task).toMatchObject({ stage: 'COMPLETED', lastExecutionId: null });
  });

  it('converges a stale task pointer and stage to the latest terminal attempt', async () => {
    const setup = fixture({
      task: { stage: 'FAILED', lastExecutionId: 'older' },
      executions: [
        { id: 1, taskId: 1, sessionId: 11, executionId: 'older', attemptNo: 1, status: 'FAILED' },
        { id: 2, taskId: 1, sessionId: 11, executionId: 'latest', attemptNo: 2, status: 'COMPLETED' },
      ],
    });

    await expect(setup.service.repairOnce()).resolves.toBe(1);

    expect(setup.task).toMatchObject({ stage: 'COMPLETED', lastExecutionId: 'latest' });
  });

  it('is idempotent when the same candidate is scanned again', async () => {
    const setup = fixture();

    await expect(setup.service.repairOnce()).resolves.toBe(1);
    const executionWrites = setup.repo.updateExecution.mock.calls.length;
    const taskWrites = setup.repo.updateById.mock.calls.length;

    await expect(setup.service.repairOnce()).resolves.toBe(0);
    expect(setup.repo.updateExecution).toHaveBeenCalledTimes(executionWrites);
    expect(setup.repo.updateById).toHaveBeenCalledTimes(taskWrites);
  });

  it('records scan failures without throwing into the lifecycle', async () => {
    const setup = fixture();
    setup.repo.listRepairCandidates.mockRejectedValueOnce(new Error('database unavailable'));
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      await expect(setup.service.repairOnce()).resolves.toBe(0);
      expect(warning).toHaveBeenCalledWith(expect.stringContaining('record repair scan failed'), expect.any(Error));
    } finally {
      warning.mockRestore();
    }
  });
});

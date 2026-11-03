import { describe, expect, it, vi } from 'vitest';
import { TaskService } from './task.service.js';
import type { TaskRepository } from './task.repository.js';
import type { AgentTask, TaskExecution } from './types.js';
import type { Session } from '../session/types.js';

function fixture() {
  const session: Session = { id: 11, userId: 7, agentId: 2, title: '修复问题', source: 'web', phase: 'RUNNING' };
  let task: AgentTask | null = null;
  const executions: TaskExecution[] = [];
  const triggers: Array<Record<string, unknown>> = [];
  const repo = {
    transaction: async (work: (store: unknown) => Promise<unknown>) => work(repo),
    lockSession: async (userId: number, sessionId: number) => userId === session.userId && sessionId === session.id ? session : null,
    findBySessionId: async () => task,
    findById: async (userId: number, id: number) => task?.userId === userId && task.id === id ? task : null,
    insert: async (input: AgentTask) => { task = { ...input, id: 1 }; return 1; },
    updateById: async (_id: number, fields: Partial<AgentTask>) => { Object.assign(task!, fields); },
    latestExecution: async () => executions.at(-1) ?? null,
    executionById: async (id: string) => executions.find((item) => item.executionId === id) ?? null,
    insertExecution: async (input: TaskExecution) => { executions.push({ ...input, id: executions.length + 1 }); return executions.length; },
    updateExecution: async (id: number, fields: Partial<TaskExecution>) => { Object.assign(executions.find((item) => item.id === id)!, fields); },
    insertTrigger: async (input: Record<string, unknown>) => { triggers.push(input); },
    triggers: async () => triggers,
    executions: async () => executions,
  };
  const service = new TaskService(repo as unknown as TaskRepository);
  return { service, session, repo, executions, triggers, task: () => task };
}

describe('Task execution lifecycle', () => {
  it('returns public task data without ownership and storage-only fields', async () => {
    const setup = fixture();
    await setup.service.beginExecution(setup.session, 'public');
    const result = await setup.service.get(7, 1);
    expect(result?.task).not.toHaveProperty('userId');
    expect(result?.task).toMatchObject({ id: 1, sessionId: 11, lastExecutionId: 'public', createdAt: null, updatedAt: null });
    expect(result?.latestExecution).toMatchObject({ executionId: 'public', finishedAt: null, createdAt: null });
  });

  it('creates one task and numbered attempts for repeated runs on a session', async () => {
    const setup = fixture();
    await setup.service.beginExecution(setup.session, 'first', 'WEBHOOK');
    await setup.service.settleExecution(setup.session, 'first', 'COMPLETED');
    await setup.service.beginExecution(setup.session, 'second', 'SCHEDULED');
    expect(setup.executions.map((item) => item.attemptNo)).toEqual([1, 2]);
    expect(setup.task()).toMatchObject({ source: 'WEBHOOK', stage: 'WORKING', lastExecutionId: 'second' });
    expect(setup.triggers.map((item) => item.source)).toEqual(['WEBHOOK', 'SCHEDULED']);
  });

  it('does not let a late terminal event overwrite a newer run', async () => {
    const setup = fixture();
    await setup.service.beginExecution(setup.session, 'old');
    await setup.service.beginExecution(setup.session, 'new');
    await setup.service.settleExecution(setup.session, 'old', 'FAILED', 'late');
    expect(setup.task()).toMatchObject({ stage: 'WORKING', lastExecutionId: 'new' });
    expect(setup.executions[0]).toMatchObject({ status: 'FAILED', failureReason: 'late' });
  });

  it('keeps the first terminal result and its timestamp when delivery repeats', async () => {
    const setup = fixture();
    await setup.service.beginExecution(setup.session, 'first');
    await setup.service.settleExecution(setup.session, 'first', 'COMPLETED');
    const finishedAt = setup.executions[0]!.finishedAt;
    await setup.service.settleExecution(setup.session, 'first', 'FAILED', 'duplicate');
    await setup.service.beginExecution(setup.session, 'first');
    expect(setup.executions).toHaveLength(1);
    expect(setup.executions[0]).toMatchObject({ status: 'COMPLETED', finishedAt, failureReason: null });
    expect(setup.task()?.stage).toBe('COMPLETED');
  });

  it('numbers terminal-only attempts and preserves their actual source', async () => {
    const setup = fixture();
    await setup.service.settleExecution(setup.session, 'one', 'FAILED', 'sync failed', 'SIGNAL');
    await setup.service.settleExecution(setup.session, 'two', 'CANCELLED', null, 'SCHEDULED');
    expect(setup.executions.map((item) => item.attemptNo)).toEqual([1, 2]);
    expect(setup.triggers.map((item) => item.source)).toEqual(['SIGNAL', 'SCHEDULED']);
    expect(setup.task()?.stage).toBe('CANCELLED');
  });

  it('rejects execution ids that belong to another session', async () => {
    const setup = fixture();
    await setup.service.beginExecution(setup.session, 'shared');
    setup.executions[0]!.sessionId = 99;
    await expect(setup.service.beginExecution(setup.session, 'shared')).rejects.toThrow();
    await expect(setup.service.settleExecution(setup.session, 'shared', 'FAILED')).rejects.toThrow();
    expect(setup.task()?.stage).toBe('WORKING');
  });

  it('rejects forged ownership before creating a task', async () => {
    const setup = fixture();
    await expect(setup.service.beginExecution({ ...setup.session, userId: 9 }, 'forged')).rejects.toThrow();
    expect(setup.task()).toBeNull();
  });

  it('validates terminal states and execution ids', async () => {
    const setup = fixture();
    await expect(setup.service.settleExecution(setup.session, 'one', 'WORKING')).rejects.toThrow();
    await expect(setup.service.beginExecution(setup.session, '')).rejects.toThrow();
  });

  it('does not expose another user task or its execution history', async () => {
    const setup = fixture();
    await setup.service.beginExecution(setup.session, 'one');
    expect(await setup.service.get(9, 1)).toBeNull();
    expect(await setup.service.get(7, 1)).toMatchObject({ task: { id: 1 } });
  });
});

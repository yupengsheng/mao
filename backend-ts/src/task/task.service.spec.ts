import { describe, expect, it, vi } from 'vitest';
import { TaskService } from './task.service.js';
import { TaskWaitService } from './task-wait.service.js';
import { ApprovalRegistry } from '../harness/approval/approval-registry.js';
import { AskUserQuestionsRegistry } from '../harness/tool/ask-user-questions-registry.js';
import { TaskTerminalService } from '../session/task-terminal.service.js';
import { OPEN_RUN_ADMISSION_POLICY_VERSION } from '../openapi/admission.js';
import type { TaskRepository } from './task.repository.js';
import type { AgentTask, TaskExecution, TaskTrigger } from './types.js';
import type { Session } from '../session/types.js';

function fixture() {
  const session: Session = { id: 11, userId: 7, agentId: 2, title: '修复问题', source: 'web', phase: 'RUNNING' };
  let task: AgentTask | null = null;
  const executions: TaskExecution[] = [];
  const triggers: TaskTrigger[] = [];
  const repo = {
    transaction: async (work: (store: unknown) => Promise<unknown>) => work(repo),
    lockSession: async (userId: number, sessionId: number) => userId === session.userId && sessionId === session.id ? session : null,
    findBySessionId: async () => task,
    findById: async (userId: number, id: number) => task?.userId === userId && task.id === id ? task : null,
    insert: async (input: AgentTask) => { task = { ...input, id: 1 }; return 1; },
    updateById: async (_id: number, fields: Partial<AgentTask>) => { Object.assign(task!, fields); },
    latestExecution: async () => executions.at(-1) ?? null,
    executionById: async (id: string) => executions.find((item) => item.executionId === id) ?? null,
    unfinishedExecutions: async (taskId: number) => executions
      .filter((item) => item.taskId === taskId && (item.status === 'WORKING' || item.status === 'BLOCKED'))
      .sort((a, b) => b.attemptNo - a.attemptNo || (b.id ?? 0) - (a.id ?? 0)),
    insertExecution: async (input: TaskExecution) => { executions.push({ ...input, id: executions.length + 1 }); return executions.length; },
    updateExecution: async (id: number, fields: Partial<TaskExecution>) => { Object.assign(executions.find((item) => item.id === id)!, fields); },
    insertTrigger: async (input: TaskTrigger) => { triggers.push(input); },
    triggerByExecutionId: async (id: string) => triggers.find((item) => item.sourceEventId === id) ?? null,
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

  it('stamps the admission policy version for programmatic runs and keeps it across later manual runs', async () => {
    const setup = fixture();
    await setup.service.beginExecution(setup.session, 'api', 'API');
    expect(setup.task()?.policyVersion).toBe(OPEN_RUN_ADMISSION_POLICY_VERSION);
    await setup.service.settleExecution(setup.session, 'api', 'COMPLETED');
    await setup.service.beginExecution(setup.session, 'manual', 'MANUAL');
    expect(setup.task()?.policyVersion).toBe(OPEN_RUN_ADMISSION_POLICY_VERSION);
  });

  it('leaves the policy version empty for manual and scheduled runs', async () => {
    const manual = fixture();
    await manual.service.beginExecution(manual.session, 'manual', 'MANUAL');
    expect(manual.task()?.policyVersion).toBeNull();

    const scheduled = fixture();
    await scheduled.service.beginExecution(scheduled.session, 'scheduled', 'SCHEDULED');
    expect(scheduled.task()?.policyVersion).toBeNull();
  });

  it('stamps the policy version when a programmatic run only produces a terminal record', async () => {
    const setup = fixture();
    await setup.service.settleExecution(setup.session, 'webhook-only', 'FAILED', 'late', 'WEBHOOK');
    expect(setup.task()).toMatchObject({
      policyVersion: OPEN_RUN_ADMISSION_POLICY_VERSION,
      stage: 'FAILED',
      lastExecutionId: 'webhook-only',
    });
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

  it('projects waiting and resuming onto the current execution without changing its timing or source', async () => {
    const setup = fixture();
    await setup.service.beginExecution(setup.session, 'current', 'API');
    const startedAt = setup.executions[0]!.startedAt;
    await setup.service.setExecutionStage(setup.session, 'current', 'BLOCKED');
    expect(setup.task()?.stage).toBe('BLOCKED');
    expect(setup.executions[0]).toMatchObject({ status: 'BLOCKED', startedAt, failureReason: null });
    expect(setup.executions[0]!.finishedAt).toBeUndefined();
    await setup.service.setExecutionStage(setup.session, 'current', 'WORKING');
    expect(setup.task()?.stage).toBe('WORKING');
    expect(setup.executions[0]).toMatchObject({ status: 'WORKING', startedAt, attemptNo: 1 });
    expect(setup.triggers).toHaveLength(1);
    expect(setup.triggers[0]!.source).toBe('API');
  });

  it('does not register executions from waiting callbacks alone', async () => {
    const setup = fixture();
    await setup.service.setExecutionStage(setup.session, 'unknown', 'BLOCKED');
    expect(setup.task()).toBeNull();
    expect(setup.executions).toEqual([]);
    expect(setup.triggers).toEqual([]);
  });

  it('ignores a late waiting callback for an older execution', async () => {
    const setup = fixture();
    await setup.service.beginExecution(setup.session, 'old');
    await setup.service.beginExecution(setup.session, 'new');
    await setup.service.setExecutionStage(setup.session, 'old', 'BLOCKED');
    expect(setup.task()).toMatchObject({ stage: 'WORKING', lastExecutionId: 'new' });
    expect(setup.executions[0]!.status).toBe('WORKING');
  });

  it.each(['FAILED', 'COMPLETED', 'CANCELLED'] as const)('cannot revive an execution settled as %s', async (phase) => {
    const setup = fixture();
    await setup.service.beginExecution(setup.session, 'current');
    await setup.service.settleExecution(setup.session, 'current', phase, 'settled');
    await setup.service.setExecutionStage(setup.session, 'current', 'WORKING');
    expect(setup.task()?.stage).toBe(phase);
    expect(setup.executions[0]).toMatchObject({ status: phase, failureReason: 'settled' });
  });

  it.each(['CANCELLING', 'COMPLETED', 'FAILED', 'CANCELLED'])('ignores wait changes when the session is %s', async (phase) => {
    const setup = fixture();
    await setup.service.beginExecution(setup.session, 'current');
    setup.session.phase = phase;
    await setup.service.setExecutionStage(setup.session, 'current', 'BLOCKED');
    expect(setup.task()?.stage).toBe('WORKING');
    expect(setup.executions[0]!.status).toBe('WORKING');
  });

  it('checks session ownership before changing an execution stage', async () => {
    const setup = fixture();
    await setup.service.beginExecution(setup.session, 'current');
    await expect(setup.service.setExecutionStage({ ...setup.session, userId: 8 }, 'current', 'BLOCKED')).rejects.toThrow();
    expect(setup.task()?.stage).toBe('WORKING');
  });

  it('resolves only the current owned unfinished execution for idle-loop cancellation', async () => {
    const setup = fixture();
    expect(await setup.service.getActiveExecutionId(setup.session)).toBeNull();
    await setup.service.beginExecution(setup.session, 'current');
    expect(await setup.service.getActiveExecutionId(setup.session)).toBe('current');
    await setup.service.setExecutionStage(setup.session, 'current', 'BLOCKED');
    expect(await setup.service.getActiveExecutionId(setup.session)).toBe('current');
    expect(await setup.service.getActiveExecutionId({ ...setup.session, userId: 8 })).toBeNull();
    await setup.service.settleExecution(setup.session, 'current', 'COMPLETED');
    expect(await setup.service.getActiveExecutionId(setup.session)).toBeNull();
  });

  it('settles the original recorded execution when a channel cancels with no runtime id', async () => {
    const setup = fixture();
    await setup.service.beginExecution(setup.session, 'original', 'FEISHU');
    await setup.service.setExecutionStage(setup.session, 'original', 'BLOCKED');
    const terminal = new TaskTerminalService({
      getSession: async () => ({ ...setup.session }),
      updatePhase: async (_id: number, phase: string) => { setup.session.phase = phase; },
      updateRuntimeStatus: async () => undefined,
      markLastMessageFinished: async () => undefined,
    } as never, { send: () => undefined, sendWithResult: async () => ({}) } as never,
    { prepare: async () => null } as never, { publish: () => undefined } as never,
    undefined, undefined, undefined, undefined, 'MANUAL', undefined, undefined, undefined, setup.service);
    await terminal.cancelActiveExecution(11, 7);
    expect(setup.executions).toHaveLength(1);
    expect(setup.executions[0]).toMatchObject({ executionId: 'original', status: 'CANCELLED' });
    expect(setup.task()).toMatchObject({ stage: 'CANCELLED', lastExecutionId: 'original', source: 'FEISHU' });
    expect(setup.triggers).toHaveLength(1);
  });

  it('numbers terminal-only attempts and preserves their actual source', async () => {
    const setup = fixture();
    await setup.service.settleExecution(setup.session, 'one', 'FAILED', 'sync failed', 'SIGNAL');
    await setup.service.settleExecution(setup.session, 'two', 'CANCELLED', null, 'SCHEDULED');
    expect(setup.executions.map((item) => item.attemptNo)).toEqual([1, 2]);
    expect(setup.triggers.map((item) => item.source)).toEqual(['SIGNAL', 'SCHEDULED']);
    expect(setup.task()?.stage).toBe('CANCELLED');
  });

  it('closes interrupted attempts and starts a new numbered recovery attempt', async () => {
    const setup = fixture();
    await setup.service.beginExecution(setup.session, 'interrupted-blocked', 'FEISHU');
    await setup.service.setExecutionStage(setup.session, 'interrupted-blocked', 'BLOCKED');
    await setup.service.beginExecution(setup.session, 'interrupted-working', 'WEBHOOK');

    const recovered = await setup.service.beginRecoveryExecution(setup.session, 'recovered');

    expect(setup.executions.map((item) => item.status)).toEqual(['FAILED', 'FAILED', 'WORKING']);
    expect(setup.executions.slice(0, 2).every((item) => item.finishedAt != null)).toBe(true);
    expect(setup.executions.slice(0, 2).every((item) => item.failureReason === '执行因进程中断未完成，已自动恢复')).toBe(true);
    expect(recovered).toMatchObject({ executionId: 'recovered', attemptNo: 3, status: 'WORKING' });
    expect(recovered.startedAt).toBeTruthy();
    expect(setup.task()).toMatchObject({ stage: 'WORKING', lastExecutionId: 'recovered' });
  });

  it('preserves the actual source of the interrupted attempt on recovery', async () => {
    const setup = fixture();
    await setup.service.beginExecution(setup.session, 'interrupted', 'SIGNAL');
    await setup.service.beginRecoveryExecution(setup.session, 'recovered');
    expect(setup.triggers.map((item) => item.source)).toEqual(['SIGNAL', 'SIGNAL']);
  });

  it('keeps recovery registration idempotent for the same execution id', async () => {
    const setup = fixture();
    await setup.service.beginExecution(setup.session, 'interrupted');
    await setup.service.beginRecoveryExecution(setup.session, 'recovered');
    const finishedAt = setup.executions[0]!.finishedAt;

    await setup.service.beginRecoveryExecution(setup.session, 'recovered');

    expect(setup.executions).toHaveLength(2);
    expect(setup.executions[0]).toMatchObject({ status: 'FAILED', finishedAt });
    expect(setup.triggers).toHaveLength(2);
    expect(setup.task()?.lastExecutionId).toBe('recovered');
  });

  it('does not let an interrupted attempt overwrite the recovery attempt when it settles late', async () => {
    const setup = fixture();
    await setup.service.beginExecution(setup.session, 'interrupted');
    await setup.service.beginRecoveryExecution(setup.session, 'recovered');
    await setup.service.settleExecution(setup.session, 'interrupted', 'COMPLETED');
    expect(setup.executions[0]).toMatchObject({ status: 'FAILED' });
    expect(setup.task()).toMatchObject({ stage: 'WORKING', lastExecutionId: 'recovered' });
  });

  it('creates the first attempt when recovery finds no interrupted execution', async () => {
    const setup = fixture();
    setup.session.source = 'feishu';
    const recovered = await setup.service.beginRecoveryExecution(setup.session, 'first-recovery');
    expect(recovered).toMatchObject({ executionId: 'first-recovery', attemptNo: 1, status: 'WORKING' });
    expect(recovered.startedAt).toBeTruthy();
    expect(setup.triggers[0]!.source).toBe('FEISHU');
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

describe('Task waiting state projection', () => {
  function waitingFixture() {
    const setup = fixture();
    const execution = { id: 'current' as string | undefined };
    const lookup = { getSession: async () => setup.session };
    const tracker = new TaskWaitService(setup.service, lookup, { getSessionExecution: () => execution.id });
    return { ...setup, tracker, execution, lookup };
  }

  it('tracks headless event waits without creating duplicate attempts or changing the explicit source', async () => {
    const setup = fixture();
    let executionId: string | undefined;
    const registry = {
      getSessionExecution: () => executionId,
      setSessionExecution: (_id: number, actualId: string) => { executionId = actualId; },
      clearSessionExecution: () => { executionId = undefined; },
      send: () => undefined, sendWithResult: async () => ({}),
    };
    const sessions = {
      getSession: async () => ({ ...setup.session }),
      updatePhase: async (_id: number, phase: string) => { setup.session.phase = phase; },
      updateRuntimeStatus: async () => undefined, markLastMessageFinished: async () => undefined,
    };
    const terminal = new TaskTerminalService(sessions as never, registry as never,
      { prepare: async () => null } as never, { publish: () => undefined } as never,
      undefined, undefined, undefined, undefined, 'MANUAL', undefined, undefined, undefined, setup.service);
    const tracker = new TaskWaitService(setup.service, sessions, registry);
    const questions = new AskUserQuestionsRegistry(1_000, tracker);
    await terminal.beginExecution(11, 'headless', 'API');
    await terminal.beginExecution(11);
    const requestId = questions.register(11, [{ question: '是否继续？' }], null);
    const waiting = questions.waitForAnswer(11, requestId);
    await vi.waitFor(() => expect(setup.task()?.stage).toBe('BLOCKED'));
    expect(setup.executions).toHaveLength(1);
    expect(setup.task()?.source).toBe('API');
    expect(setup.triggers).toHaveLength(1);
    expect(setup.triggers[0]!.source).toBe('API');
    questions.complete(11, requestId, '{"answers":[]}');
    await waiting;
    await vi.waitFor(() => expect(setup.task()?.stage).toBe('WORKING'));
    await terminal.finishExecution(11, 7, 'COMPLETED', 'headless');
    expect(setup.executions[0]).toMatchObject({ executionId: 'headless', status: 'COMPLETED' });
    expect(executionId).toBeUndefined();
  });

  it('waits for both questions and approvals before resuming', async () => {
    const setup = waitingFixture();
    await setup.service.beginExecution(setup.session, 'current');
    await setup.tracker.started(11, 'QUESTION', 'same-id');
    expect(setup.task()?.stage).toBe('BLOCKED');
    await setup.tracker.started(11, 'APPROVAL', 'same-id');
    await setup.tracker.finished(11, 'QUESTION', 'same-id');
    expect(setup.task()?.stage).toBe('BLOCKED');
    await setup.tracker.finished(11, 'APPROVAL', 'same-id');
    expect(setup.task()?.stage).toBe('WORKING');
    expect(setup.executions[0]!.status).toBe('WORKING');
  });

  it('does not count duplicate starts or release another pending request on duplicate finishes', async () => {
    const setup = waitingFixture();
    await setup.service.beginExecution(setup.session, 'current');
    await setup.tracker.started(11, 'QUESTION', 'first');
    await setup.tracker.started(11, 'QUESTION', 'first');
    await setup.tracker.finished(11, 'QUESTION', 'first');
    expect(setup.task()?.stage).toBe('WORKING');
    await setup.tracker.started(11, 'QUESTION', 'second');
    await setup.tracker.finished(11, 'QUESTION', 'first');
    expect(setup.task()?.stage).toBe('BLOCKED');
  });

  it('preserves event order when an answer arrives while the blocked update is delayed', async () => {
    const setup = waitingFixture();
    await setup.service.beginExecution(setup.session, 'current');
    let release!: (session: Session) => void;
    vi.spyOn(setup.lookup, 'getSession').mockImplementationOnce(() => new Promise<Session>((resolve) => { release = resolve; }));
    const blocked = setup.tracker.started(11, 'QUESTION', 'fast-answer');
    await Promise.resolve();
    const resumed = setup.tracker.finished(11, 'QUESTION', 'fast-answer');
    await Promise.resolve();
    release(setup.session);
    await Promise.all([blocked, resumed]);
    expect(setup.task()?.stage).toBe('WORKING');
    expect(setup.executions[0]!.status).toBe('WORKING');
  });

  it('binds the end of an old request to its original execution', async () => {
    const setup = waitingFixture();
    await setup.service.beginExecution(setup.session, 'current');
    await setup.tracker.started(11, 'QUESTION', 'old-question');
    await setup.service.beginExecution(setup.session, 'next');
    setup.execution.id = 'next';
    await setup.tracker.started(11, 'APPROVAL', 'new-approval');
    await setup.tracker.finished(11, 'QUESTION', 'old-question');
    expect(setup.task()).toMatchObject({ lastExecutionId: 'next', stage: 'BLOCKED' });
    await setup.tracker.finished(11, 'APPROVAL', 'new-approval');
    expect(setup.task()?.stage).toBe('WORKING');
  });

  it('ignores requests without an active execution id', async () => {
    const setup = waitingFixture();
    await setup.service.beginExecution(setup.session, 'current');
    setup.execution.id = undefined;
    await setup.tracker.started(11, 'QUESTION', 'untracked');
    setup.execution.id = 'current';
    await setup.tracker.started(11, 'APPROVAL', 'tracked');
    await setup.tracker.finished(11, 'QUESTION', 'untracked');
    expect(setup.task()?.stage).toBe('BLOCKED');
  });

  it('keeps handling subsequent events after a storage failure', async () => {
    const setup = waitingFixture();
    await setup.service.beginExecution(setup.session, 'current');
    vi.spyOn(setup.repo, 'updateExecution').mockRejectedValueOnce(new Error('storage unavailable'));
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      await expect(setup.tracker.started(11, 'QUESTION', 'first')).resolves.toBeUndefined();
      await setup.tracker.started(11, 'APPROVAL', 'second');
      expect(setup.task()?.stage).toBe('BLOCKED');
      await setup.tracker.finished(11, 'QUESTION', 'first');
      await setup.tracker.finished(11, 'APPROVAL', 'second');
      expect(setup.task()?.stage).toBe('WORKING');
    } finally { warning.mockRestore(); }
  });

  it('cannot reopen a settled execution when pending requests are cancelled', async () => {
    const setup = waitingFixture();
    await setup.service.beginExecution(setup.session, 'current');
    await setup.tracker.started(11, 'QUESTION', 'pending');
    await setup.service.settleExecution(setup.session, 'current', 'CANCELLED');
    await setup.tracker.finished(11, 'QUESTION', 'pending');
    expect(setup.task()?.stage).toBe('CANCELLED');
    expect(setup.executions[0]!.status).toBe('CANCELLED');
  });

  it('projects real pending questions and resumes after an answer', async () => {
    const setup = waitingFixture();
    await setup.service.beginExecution(setup.session, 'current');
    const questions = new AskUserQuestionsRegistry(1_000, setup.tracker);
    const requestId = questions.register(11, [{ question: '选择方案' }], null);
    const waiting = questions.waitForAnswer(11, requestId);
    await vi.waitFor(() => expect(setup.task()?.stage).toBe('BLOCKED'));
    expect(questions.complete(11, requestId, '{"answers":[]}')).toBe(true);
    expect(await waiting).toMatchObject({ answered: true, cancelled: false });
    await vi.waitFor(() => expect(setup.task()?.stage).toBe('WORKING'));
  });

  it('keeps a task blocked until its real approvals and question have all ended', async () => {
    const setup = waitingFixture();
    await setup.service.beginExecution(setup.session, 'current');
    const approvals = new ApprovalRegistry({
      enterWaitingApproval: async () => { setup.session.phase = 'WAITING_APPROVAL'; return true; },
      restoreRunningAfterApproval: async () => { setup.session.phase = 'RUNNING'; return true; },
    } as never, { selectById: async () => setup.session } as never, { send: vi.fn() } as never, setup.tracker);
    const questions = new AskUserQuestionsRegistry(1_000, setup.tracker);
    await approvals.register(11, 'first');
    await approvals.register(11, 'first');
    await approvals.register(11, 'second');
    const requestId = questions.register(11, [{ question: '继续？' }], null);
    const waiting = questions.waitForAnswer(11, requestId);
    await vi.waitFor(() => expect(setup.task()?.stage).toBe('BLOCKED'));
    await approvals.unregister(11, 'first');
    expect(setup.task()?.stage).toBe('BLOCKED');
    questions.complete(11, requestId, '{"answers":[]}');
    await waiting;
    await approvals.unregister(11, 'second');
    await vi.waitFor(() => expect(setup.task()?.stage).toBe('WORKING'));
    await approvals.unregister(11, 'second');
    expect(setup.task()?.stage).toBe('WORKING');
  });

  it('releases the task state when unanswered questions time out', async () => {
    vi.useFakeTimers();
    try {
      const setup = waitingFixture();
      await setup.service.beginExecution(setup.session, 'current');
      const questions = new AskUserQuestionsRegistry(50, setup.tracker);
      const requestId = questions.register(11, [{ question: '继续？' }], null);
      const waiting = questions.waitForAnswer(11, requestId);
      await vi.advanceTimersByTimeAsync(0);
      expect(setup.task()?.stage).toBe('BLOCKED');
      await vi.advanceTimersByTimeAsync(50);
      expect(await waiting).toMatchObject({ answered: false, cancelled: false });
      expect(questions.getPendingForSession(11)).toEqual([]);
      expect(setup.task()?.stage).toBe('WORKING');
    } finally { vi.useRealTimers(); }
  });

  it('releases every cancelled pending question and preserves the cancellation result', async () => {
    const setup = waitingFixture();
    await setup.service.beginExecution(setup.session, 'current');
    const questions = new AskUserQuestionsRegistry(1_000, setup.tracker);
    const first = questions.register(11, [{ question: '第一问' }], null);
    const second = questions.register(11, [{ question: '第二问' }], null);
    const waiting = [questions.waitForAnswer(11, first), questions.waitForAnswer(11, second)];
    await vi.waitFor(() => expect(setup.task()?.stage).toBe('BLOCKED'));
    questions.failAllForSessions([11]);
    expect(await Promise.all(waiting)).toEqual([
      expect.objectContaining({ cancelled: true }), expect.objectContaining({ cancelled: true }),
    ]);
    await vi.waitFor(() => expect(setup.task()?.stage).toBe('WORKING'));
  });
});

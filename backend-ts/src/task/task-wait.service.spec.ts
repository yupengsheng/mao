import { describe, expect, it, vi } from 'vitest';
import { TaskWaitService } from './task-wait.service.js';
import type { ExecutionWaitStore } from './execution-wait.repository.js';
import type { TaskService } from './task.service.js';
import type { Session } from '../session/types.js';

describe('TaskWaitService persistence', () => {
  const session: Session = { id: 11, userId: 7, agentId: 2, title: '任务', source: 'web', phase: 'RUNNING' };

  function setup(options: {
    executionId?: string;
    enabled?: boolean;
    store?: Partial<ExecutionWaitStore>;
  } = {}) {
    const taskService = { setExecutionStage: vi.fn().mockResolvedValue(undefined) } as unknown as TaskService;
    const executionId = 'executionId' in options ? options.executionId : 'exec-1';
    const store = {
      insertPending: vi.fn().mockResolvedValue(undefined),
      release: vi.fn().mockResolvedValue(true),
      ...options.store,
    } as ExecutionWaitStore;
    const service = new TaskWaitService(
      taskService,
      { getSession: async () => session },
      { getSessionExecution: () => executionId },
      { enabled: options.enabled ?? true, store },
    );
    return { service, taskService, store };
  }

  const startedInput = {
    sessionId: 11,
    kind: 'APPROVAL' as const,
    requestId: 'req-1',
    payloadSummary: '{"toolName":"shell"}',
    payloadDigest: 'digest-1',
  };

  it('writes pending rows and releases with the first reason', async () => {
    const { service, taskService, store } = setup();
    await service.started(startedInput);
    expect(store.insertPending).toHaveBeenCalledWith({
      sessionId: 11,
      executionId: 'exec-1',
      requestType: 'APPROVAL',
      requestId: 'req-1',
      payloadSummary: startedInput.payloadSummary,
      payloadDigest: startedInput.payloadDigest,
    });
    expect(taskService.setExecutionStage).toHaveBeenCalledWith(session, 'exec-1', 'BLOCKED');

    await service.finished(11, 'APPROVAL', 'req-1', 'APPROVED');
    expect(store.release).toHaveBeenCalledWith(11, 'APPROVAL', 'req-1', 'APPROVED');
    expect(taskService.setExecutionStage).toHaveBeenLastCalledWith(session, 'exec-1', 'WORKING');

    await service.finished(11, 'APPROVAL', 'req-1', 'CANCELLED');
    expect(store.release).toHaveBeenCalledTimes(1);
  });

  it('does not insert the same pending request twice', async () => {
    const { service, store } = setup();
    await service.started(startedInput);
    await service.started({ ...startedInput, payloadSummary: '{"changed":true}' });
    expect(store.insertPending).toHaveBeenCalledTimes(1);
  });

  it('waits for the pending insert before releasing the same request', async () => {
    let finishInsert!: () => void;
    const events: string[] = [];
    const insertPending = vi.fn(() => new Promise<void>((resolve) => {
      events.push('insert');
      finishInsert = resolve;
    }));
    const release = vi.fn(async () => {
      events.push('release');
      return true;
    });
    const { service } = setup({ store: { insertPending, release } });

    const starting = service.started(startedInput);
    const finishing = service.finished(11, 'APPROVAL', 'req-1', 'APPROVED');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(insertPending).toHaveBeenCalledTimes(1);
    expect(release).not.toHaveBeenCalled();

    finishInsert();
    await Promise.all([starting, finishing]);
    expect(events).toEqual(['insert', 'release']);
  });

  it('skips persistence when no current execution can be resolved', async () => {
    const { service, taskService, store } = setup({ executionId: undefined });
    await service.started(startedInput);
    expect(store.insertPending).not.toHaveBeenCalled();
    expect(taskService.setExecutionStage).not.toHaveBeenCalled();
  });

  it('keeps the in-memory projection when persistence fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const { service, taskService } = setup({
        store: {
          insertPending: vi.fn().mockRejectedValue(new Error('db down')),
          release: vi.fn().mockRejectedValue(new Error('db down')),
        },
      });
      await expect(service.started(startedInput)).resolves.toBeUndefined();
      expect(taskService.setExecutionStage).toHaveBeenCalledWith(session, 'exec-1', 'BLOCKED');
      await expect(service.finished(11, 'APPROVAL', 'req-1', 'DENIED')).resolves.toBeUndefined();
      expect(taskService.setExecutionStage).toHaveBeenLastCalledWith(session, 'exec-1', 'WORKING');
    } finally {
      warn.mockRestore();
    }
  });

  it('does not touch the store when persistence is disabled', async () => {
    const { service, taskService, store } = setup({ enabled: false });
    await service.started(startedInput);
    await service.finished(11, 'APPROVAL', 'req-1', 'APPROVED');
    expect(store.insertPending).not.toHaveBeenCalled();
    expect(store.release).not.toHaveBeenCalled();
    expect(taskService.setExecutionStage).toHaveBeenCalledTimes(2);
  });
});

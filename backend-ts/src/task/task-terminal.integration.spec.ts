import { describe, expect, it, vi } from 'vitest';
import { TaskTerminalService } from '../session/task-terminal.service.js';
import type { TaskService } from './task.service.js';

function fixture(initialPhase = 'RUNNING') {
  const session = { id: 11, userId: 7, agentId: 2, title: 'task', phase: initialPhase };
  const service = {
    getSession: async () => ({ ...session }),
    updatePhase: vi.fn(async (_id, phase) => { session.phase = phase; }),
    updateRuntimeStatus: async () => undefined,
    markLastMessageFinished: async () => undefined,
  };
  const task = { beginExecution: vi.fn(async () => undefined), settleExecution: vi.fn(async () => undefined) };
  const send = vi.fn();
  const terminal = new TaskTerminalService(service as never, { send, sendWithResult: async () => ({}) } as never,
    { prepare: async () => null } as never, { publish: () => undefined } as never,
    undefined, undefined, undefined, undefined, 'MANUAL', undefined, undefined, undefined, task as unknown as TaskService);
  return { terminal, service, session, task, send };
}

describe('Task integration with session terminal', () => {
  it('records execution source and propagates actual terminal phase and reason', async () => {
    const setup = fixture();
    await setup.terminal.beginExecution(11, 'event', 'WEBHOOK');
    await setup.terminal.finishExecution(11, 7, 'FAILED', 'event', 'failed test', 'WEBHOOK');
    expect(setup.task.beginExecution).toHaveBeenCalledWith(expect.objectContaining({ id: 11 }), 'event', 'WEBHOOK');
    expect(setup.task.settleExecution).toHaveBeenCalledWith(expect.objectContaining({ id: 11 }), 'event', 'FAILED', 'failed test', 'WEBHOOK');
    expect(setup.session.phase).toBe('FAILED');
  });

  it('allows a duplicate terminal delivery to retry task persistence without repeating notifications', async () => {
    const setup = fixture('COMPLETED');
    await setup.terminal.finishExecution(11, 7, 'COMPLETED', 'event');
    expect(setup.task.settleExecution).toHaveBeenCalled();
    expect(setup.service.updatePhase).not.toHaveBeenCalled();
    expect(setup.send).not.toHaveBeenCalled();
  });

  it('keeps session execution and terminal delivery working if task storage fails', async () => {
    const setup = fixture();
    const log = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    setup.task.beginExecution.mockRejectedValue(new Error('database unavailable'));
    setup.task.settleExecution.mockRejectedValue(new Error('database unavailable'));
    try {
      await setup.terminal.beginExecution(11, 'event');
      await setup.terminal.finishExecution(11, 7, 'COMPLETED', 'event');
      expect(setup.session.phase).toBe('COMPLETED');
      expect(setup.send).toHaveBeenCalled();
    } finally { log.mockRestore(); }
  });
});

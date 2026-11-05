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
  const task = { beginExecution: vi.fn(async () => ({ duplicate: false })), beginRecoveryExecution: vi.fn(async () => ({ duplicate: false })),
    settleExecution: vi.fn<TaskService['settleExecution']>(async () => undefined),
    getActiveExecutionId: vi.fn(async (): Promise<string | null> => null) };
  const send = vi.fn();
  const active = new Map<number, string>();
  const registry = { send, sendWithResult: async () => ({}), getSessionExecution: (id: number) => active.get(id),
    setSessionExecution: (id: number, executionId: string) => { active.set(id, executionId); },
    clearSessionExecution: (id: number) => { active.delete(id); } };
  const terminal = new TaskTerminalService(service as never, registry as never,
    { prepare: async () => null } as never, { publish: () => undefined } as never,
    undefined, undefined, undefined, undefined, 'MANUAL', undefined, undefined, undefined, task as unknown as TaskService);
  return { terminal, service, session, task, send, active };
}

describe('Task integration with session terminal', () => {
  it('records execution source and propagates actual terminal phase and reason', async () => {
    const setup = fixture();
    await setup.terminal.beginExecution(11, 'event', 'WEBHOOK');
    await setup.terminal.finishExecution(11, 7, 'FAILED', 'event', 'failed test', 'WEBHOOK');
    expect(setup.task.beginExecution).toHaveBeenCalledWith(expect.objectContaining({ id: 11 }), 'event', 'WEBHOOK', undefined);
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

  it('resolves the listener execution id when the Harness entry does not pass one', async () => {
    const setup = fixture();
    setup.active.set(11, 'listener-execution');
    await setup.terminal.beginExecution(11);
    expect(setup.task.beginExecution).toHaveBeenCalledWith(expect.objectContaining({ id: 11 }), 'listener-execution', undefined, undefined);
  });

  it('registers explicit execution ids for waits even without a WS listener', async () => {
    const setup = fixture();
    await setup.terminal.beginExecution(11, 'headless-event', 'API');
    expect(setup.active.get(11)).toBe('headless-event');
    await setup.terminal.finishExecution(11, 7, 'COMPLETED', 'headless-event');
    expect(setup.active.has(11)).toBe(false);
  });

  it('registers the recovery execution id before persisting the recovery attempt', async () => {
    const setup = fixture();
    await setup.terminal.beginRecoveryExecution(11, 'recovery-execution');
    expect(setup.active.get(11)).toBe('recovery-execution');
    expect(setup.task.beginRecoveryExecution).toHaveBeenCalledWith(expect.objectContaining({ id: 11 }), 'recovery-execution');
  });

  it('keeps the recovery execution id when task storage fails', async () => {
    const setup = fixture();
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    setup.task.beginRecoveryExecution.mockRejectedValueOnce(new Error('storage unavailable'));
    try {
      await setup.terminal.beginRecoveryExecution(11, 'recovery-execution');
      expect(setup.active.get(11)).toBe('recovery-execution');
    } finally { warning.mockRestore(); }
  });

  it('does not invent a beginning when neither entry nor listener has an execution id', async () => {
    const setup = fixture();
    await setup.terminal.beginExecution(11);
    await setup.terminal.beginExecution(11, '   ');
    expect(setup.task.beginExecution).not.toHaveBeenCalled();
    expect(setup.active.size).toBe(0);
  });

  it('keeps the runtime id registered when task storage is unavailable', async () => {
    const setup = fixture();
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    setup.task.beginExecution.mockRejectedValueOnce(new Error('storage unavailable'));
    try {
      await setup.terminal.beginExecution(11, 'actual-execution');
      expect(setup.active.get(11)).toBe('actual-execution');
    } finally { warning.mockRestore(); }
  });

  it('uses the active runtime identity when cancelling a channel execution', async () => {
    const setup = fixture();
    setup.active.set(11, 'runtime-execution');
    await setup.terminal.cancelActiveExecution(11, 7);
    expect(setup.task.getActiveExecutionId).not.toHaveBeenCalled();
    expect(setup.task.settleExecution).toHaveBeenCalledWith(expect.anything(), 'runtime-execution', 'CANCELLED', undefined, 'MANUAL');
    expect(setup.session.phase).toBe('CANCELLED');
    expect(setup.active.size).toBe(0);
  });

  it('uses the persisted active identity when a restart cleared the runtime registry', async () => {
    const setup = fixture();
    setup.task.getActiveExecutionId.mockResolvedValue('persisted-execution');
    await setup.terminal.cancelActiveExecution(11, 7);
    expect(setup.task.settleExecution).toHaveBeenCalledWith(expect.anything(), 'persisted-execution', 'CANCELLED', undefined, 'MANUAL');
  });

  it('keeps cancellation working when the persisted identity cannot be loaded', async () => {
    const setup = fixture();
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    setup.task.getActiveExecutionId.mockRejectedValueOnce(new Error('database unavailable'));
    try {
      await setup.terminal.cancelActiveExecution(11, 7);
      expect(setup.session.phase).toBe('CANCELLED');
      expect(setup.task.settleExecution).not.toHaveBeenCalled();
      expect(setup.active.size).toBe(0);
    } finally { warning.mockRestore(); }
  });

  it('does not fabricate an execution identity for unrecorded runs', async () => {
    const first = fixture();
    const second = fixture();
    await first.terminal.cancelActiveExecution(11, 7);
    await second.terminal.cancelActiveExecution(11, 7);
    expect(first.session.phase).toBe('CANCELLED');
    expect(second.session.phase).toBe('CANCELLED');
    expect(first.task.settleExecution).not.toHaveBeenCalled();
    expect(second.task.settleExecution).not.toHaveBeenCalled();
  });

  it.each(['COMPLETED', 'FAILED', 'CANCELLED'])('does not create a cancellation attempt for a %s session', async (phase) => {
    const setup = fixture(phase);
    await setup.terminal.cancelActiveExecution(11, 7);
    expect(setup.task.settleExecution).not.toHaveBeenCalled();
    expect(setup.service.updatePhase).not.toHaveBeenCalled();
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

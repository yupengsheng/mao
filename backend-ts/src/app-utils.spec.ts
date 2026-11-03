import { describe, expect, it, vi } from 'vitest';
import { createPersistCancelledHelper } from './app-utils.js';

function fixture(phase = 'RUNNING') {
  const sessionService = {
    getSession: vi.fn(async () => ({ id: 11, userId: 7, phase })),
    cleanupIncompleteTail: vi.fn(async () => 0),
  };
  const taskTerminal = { cancelActiveExecution: vi.fn(async () => undefined), finishExecution: vi.fn() };
  const feishuProgressCardRepo = { deleteBySessionId: vi.fn(async () => undefined) };
  const cancel = createPersistCancelledHelper({ sessionService, taskTerminal, feishuProgressCardRepo } as never);
  return { cancel, sessionService, taskTerminal, feishuProgressCardRepo };
}

describe('Feishu idle execution cancellation', () => {
  it('cancels the original active execution through the task terminal bridge', async () => {
    const setup = fixture();
    expect(await setup.cancel(11)).toBe(true);
    expect(setup.sessionService.cleanupIncompleteTail).toHaveBeenCalledWith(11);
    expect(setup.taskTerminal.cancelActiveExecution).toHaveBeenCalledExactlyOnceWith(11, 7);
    expect(setup.taskTerminal.finishExecution).not.toHaveBeenCalled();
    expect(setup.feishuProgressCardRepo.deleteBySessionId).toHaveBeenCalledWith(11);
  });

  it.each(['COMPLETED', 'FAILED', 'CANCELLED'])('ignores a session already %s', async (phase) => {
    const setup = fixture(phase);
    expect(await setup.cancel(11)).toBe(false);
    expect(setup.taskTerminal.cancelActiveExecution).not.toHaveBeenCalled();
    expect(setup.sessionService.cleanupIncompleteTail).not.toHaveBeenCalled();
  });
});

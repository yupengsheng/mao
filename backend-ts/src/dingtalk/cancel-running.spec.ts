import { describe, expect, it, vi } from 'vitest';
import { persistDingtalkCancelIfActive } from './cancel-running.js';

function fixture(phase = 'RESUMING') {
  const sessionService = {
    getSession: vi.fn(async () => ({ id: 11, userId: 7, phase })),
    cleanupIncompleteTail: vi.fn(async () => 0),
  };
  const taskTerminal = { cancelActiveExecution: vi.fn(async () => undefined) };
  const progressRepo = { deleteBySessionId: vi.fn(async () => undefined) };
  return { sessionService, taskTerminal, progressRepo };
}

describe('Dingtalk idle execution cancellation', () => {
  it('uses the task terminal bridge before removing the progress card', async () => {
    const setup = fixture();
    expect(await persistDingtalkCancelIfActive(11, setup)).toBe(true);
    expect(setup.sessionService.cleanupIncompleteTail).toHaveBeenCalledWith(11);
    expect(setup.taskTerminal.cancelActiveExecution).toHaveBeenCalledExactlyOnceWith(11, 7);
    expect(setup.progressRepo.deleteBySessionId).toHaveBeenCalledWith(11);
  });

  it.each(['COMPLETED', 'FAILED', 'CANCELLED'])('ignores a session already %s', async (phase) => {
    const setup = fixture(phase);
    expect(await persistDingtalkCancelIfActive(11, setup)).toBe(false);
    expect(setup.taskTerminal.cancelActiveExecution).not.toHaveBeenCalled();
  });

  it('does not treat a missing session as a new cancellation', async () => {
    const setup = fixture();
    setup.sessionService.getSession.mockRejectedValueOnce(new Error('session missing'));
    expect(await persistDingtalkCancelIfActive(11, setup)).toBe(false);
    expect(setup.taskTerminal.cancelActiveExecution).not.toHaveBeenCalled();
  });

  it('keeps the cancellation result when progress card cleanup fails', async () => {
    const setup = fixture();
    setup.progressRepo.deleteBySessionId.mockRejectedValueOnce(new Error('cleanup failed'));
    expect(await persistDingtalkCancelIfActive(11, setup)).toBe(true);
    expect(setup.taskTerminal.cancelActiveExecution).toHaveBeenCalledTimes(1);
  });
});

import { describe, expect, it, vi } from 'vitest';
import { AskUserQuestionsRegistry } from './ask-user-questions-registry.js';

describe('AskUserQuestionsRegistry', () => {
  it('waitForAnswerReturnsStructuredResultOnClientAnswer', async () => {
    const registry = new AskUserQuestionsRegistry();
    const requestId = registry.register(11, [{ id: 'q1' }], null);
    const waiting = registry.waitForAnswer(11, requestId);
    expect(registry.complete(11, requestId, '{"answers":[{"id":"a"}]}')).toBe(true);
    const result = await waiting;
    expect(result).toEqual({ answered: true, cancelled: false, resultJson: '{"answers":[{"id":"a"}]}' });
  });

  it('waitForAnswerMarksCancelledWhenSessionFailsAll', async () => {
    const registry = new AskUserQuestionsRegistry();
    const requestId = registry.register(11, [{ id: 'q1' }], null);
    const waiting = registry.waitForAnswer(11, requestId);
    registry.failAllForSession(11);
    const result = await waiting;
    // 会话停止/中止走 resolve 通道，但必须带取消标记供 dispatcher 广播事件
    expect(result.answered).toBe(true);
    expect(result.cancelled).toBe(true);
    expect(JSON.parse(result.resultJson)).toMatchObject({ error: 'Session cancelled', cancelled: true });
  });

  it('waitForAnswerReportsMissingEntryWithoutCancel', async () => {
    const registry = new AskUserQuestionsRegistry();
    const result = await registry.waitForAnswer(11, 'missing');
    expect(result).toMatchObject({ answered: false, cancelled: false });
    expect(JSON.parse(result.resultJson)).toHaveProperty('error');
  });

  it('reports a whitelisted summary without metadata and releases with answered', async () => {
    const observer = { started: vi.fn(), finished: vi.fn() };
    const registry = new AskUserQuestionsRegistry(1_000, observer);
    const requestId = registry.register(11, [{
      id: 'q1',
      header: '方案',
      question: '选哪个？',
      options: [{ label: 'A', description: '第一个', defaultValue: 'A' }],
      answer: 'secret answer',
    }], { token: 'metadata-secret' });
    const waiting = registry.waitForAnswer(11, requestId);
    expect(observer.started).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 11,
      kind: 'QUESTION',
      requestId,
      payloadDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
    }));
    const payload = JSON.parse((observer.started.mock.calls[0]![0] as { payloadSummary: string }).payloadSummary);
    expect(payload.questions).toContainEqual({
      id: 'q1',
      header: '方案',
      question: '选哪个？',
      options: [{ label: 'A', description: '第一个' }],
    });
    expect(JSON.stringify(payload)).not.toContain('metadata-secret');
    expect(JSON.stringify(payload)).not.toContain('secret answer');
    expect(JSON.stringify(payload)).not.toContain('defaultValue');

    expect(registry.complete(11, requestId, '{"answers":[]}')).toBe(true);
    await waiting;
    expect(observer.finished).toHaveBeenCalledWith(11, 'QUESTION', requestId, 'ANSWERED');
  });

  it('releases with timeout and cancelled reasons', async () => {
    vi.useFakeTimers();
    try {
      const observer = { started: vi.fn(), finished: vi.fn() };
      const registry = new AskUserQuestionsRegistry(50, observer);
      const timedOut = registry.register(11, [{ id: 'q1' }], null);
      const waiting = registry.waitForAnswer(11, timedOut);
      await vi.advanceTimersByTimeAsync(50);
      await waiting;
      expect(observer.finished).toHaveBeenCalledWith(11, 'QUESTION', timedOut, 'TIMEOUT');

      const cancelled = registry.register(11, [{ id: 'q2' }], null);
      registry.failAllForSession(11);
      expect(observer.finished).toHaveBeenCalledWith(11, 'QUESTION', cancelled, 'CANCELLED');
    } finally {
      vi.useRealTimers();
    }
  });
});

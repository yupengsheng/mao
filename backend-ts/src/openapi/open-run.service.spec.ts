import { describe, expect, it, vi } from 'vitest';
import { OpenRunService, type OpenRunDeps } from './open-run.service.js';
import type { Message, Session } from '../domain/types.js';
import { BusinessException } from '../common/business-exception.js';
import { ErrorCode } from '../common/error-code.js';

function session(overrides: Partial<Session> = {}): Session {
  return {
    id: 11, userId: 7, agentId: 5, executionMode: 'CLOUD', phase: 'IDLE',
    permissionLevel: 'READ_ONLY', status: 'ACTIVE', sessionType: 'NORMAL',
    ...overrides,
  } as Session;
}

function message(id: number): Message {
  return { id, sessionId: 11, role: 'USER', content: 'hello' } as Message;
}

interface Harness {
  service: OpenRunService;
  sessionService: {
    getSession: ReturnType<typeof vi.fn>;
    updatePhase: ReturnType<typeof vi.fn>;
    saveMessage: ReturnType<typeof vi.fn>;
    createSession: ReturnType<typeof vi.fn>;
    deleteMessageById: ReturnType<typeof vi.fn>;
    deleteSession: ReturnType<typeof vi.fn>;
  };
  enqueue: ReturnType<typeof vi.fn>;
  finishExecution: ReturnType<typeof vi.fn>;
  beginExecution: ReturnType<typeof vi.fn>;
  findExternalEvent: ReturnType<typeof vi.fn>;
  liveExecution: ReturnType<typeof vi.fn>;
  isSessionBusy: ReturnType<typeof vi.fn>;
  budgetCheck: ReturnType<typeof vi.fn>;
  admission: ReturnType<typeof vi.fn>;
}

function makeHarness(options: {
  agentEnabled?: number | null;
  agentFound?: boolean;
  budgetCheck?: () => Promise<{ message: string } | null>;
  admission?: () => Promise<void>;
  liveExecution?: boolean;
  beginDuplicate?: boolean;
  externalEventTrace?: ((scope: string, id: string) => Promise<{ sessionId: number; executionId: string; status: 'WORKING' | 'COMPLETED' | 'FAILED' | 'CANCELLED' } | null>) | null;
} = {}): Harness {
  const sessionService = {
    getSession: vi.fn(async () => session()),
    updatePhase: vi.fn(async () => undefined),
    saveMessage: vi.fn(async () => message(101)),
    deleteMessageById: vi.fn(async () => undefined),
    deleteSession: vi.fn(async () => undefined),
    // 位置签名镜像 SessionService.createSession 的 16 参（装配层 as unknown as 强转，
    // 两边不一致编译期不报警）：第 4 参 executionMode、第 16 参 source 是本次断言重点。
    // domain/types.ts 的 Session 没有 source 字段，回传行只取 executionMode。
    createSession: vi.fn(async (...args: unknown[]) => {
      const executionMode = args[3] as string | null | undefined;
      return session({ id: 99, executionMode: executionMode ?? 'CLOUD' });
    }),
  };
  const enqueue = vi.fn(async () => undefined);
  const finishExecution = vi.fn(async () => undefined);
  const beginExecution = vi.fn(async () => ({ duplicate: options.beginDuplicate === true }));
  const findExternalEvent = vi.fn(options.externalEventTrace ?? (async () => null));
  const liveExecution = vi.fn(async () => undefined);
  const budgetCheck = vi.fn(options.budgetCheck ?? (async () => null));
  const admission = vi.fn(options.admission ?? (async () => undefined));
  const deps: OpenRunDeps = {
    sessionService: sessionService as unknown as OpenRunDeps['sessionService'],
    messageQueueService: { enqueue },
    harnessService: { executeFromEvent: vi.fn(async () => undefined) },
    taskTerminalService: { finishExecution, beginExecution },
    agentLookup: { findById: vi.fn(async () => (options.agentFound === false ? null : { id: 5, name: 'A', enabled: options.agentEnabled ?? 1 })) },
    isSessionBusy: vi.fn(() => false),
    liveExecution: options.liveExecution === false ? null : liveExecution,
    budgetCheck,
    admission: options.admission === undefined ? undefined : { assertAllowed: admission },
    findExternalEvent,
  };
  return {
    service: new OpenRunService(deps), sessionService, enqueue, finishExecution, liveExecution,
    beginExecution, findExternalEvent,
    isSessionBusy: deps.isSessionBusy as unknown as Harness['isSessionBusy'], budgetCheck, admission,
  };
}

describe('OpenRunService（P1/P2 共用执行流）', () => {
  it('Agent 不存在 / 停用拒绝', async () => {
    const missing = makeHarness({ agentFound: false });
    await expect(missing.service.run({ userId: 7, agentId: 5, message: 'go', source: 'API' })).rejects.toMatchObject({ code: 3001 });
    const disabled = makeHarness({ agentEnabled: 0 });
    await expect(disabled.service.run({ userId: 7, agentId: 5, message: 'go', source: 'API' })).rejects.toMatchObject({ code: 2001 });
  });

  it('message 为空 / 超长拒绝', async () => {
    const h = makeHarness();
    await expect(h.service.run({ userId: 7, agentId: 5, message: '   ', source: 'API' })).rejects.toMatchObject({ code: 2001 });
    await expect(h.service.run({ userId: 7, agentId: 5, message: 'a'.repeat(32001), source: 'API' })).rejects.toMatchObject({ code: 2001 });
  });

  it('指定会话的 Agent 与请求 Agent 不一致时拒绝，且不执行', async () => {
    const h = makeHarness();
    h.sessionService.getSession.mockResolvedValue(session({ agentId: 1 }));
    await expect(h.service.run({ userId: 7, agentId: 2, message: 'go', sessionId: 11, source: 'API' }))
      .rejects.toMatchObject({ code: 2001 });
    expect(h.liveExecution).not.toHaveBeenCalled();
    expect(h.sessionService.updatePhase).not.toHaveBeenCalled();
  });

  it('指定会话：归属不匹配按不存在拒绝；SUBAGENT / LOCAL 会话拒绝', async () => {
    const h = makeHarness();
    h.sessionService.getSession.mockResolvedValue(session({ userId: 8 }));
    await expect(h.service.run({ userId: 7, agentId: 5, message: 'go', sessionId: 11, source: 'API' })).rejects.toMatchObject({ code: 3002 });

    h.sessionService.getSession.mockResolvedValue(session({ sessionType: 'SUBAGENT' }));
    await expect(h.service.run({ userId: 7, agentId: 5, message: 'go', sessionId: 11, source: 'API' })).rejects.toMatchObject({ code: 2001 });

    h.sessionService.getSession.mockResolvedValue(session({ executionMode: 'LOCAL' }));
    await expect(h.service.run({ userId: 7, agentId: 5, message: 'go', sessionId: 11, source: 'API' })).rejects.toMatchObject({ code: 2001 });
  });

  it('空闲直跑：updatePhase RUNNING → saveMessage → liveExecution 透传 source，响应带 messageId', async () => {
    const h = makeHarness();
    const result = await h.service.run({ userId: 7, agentId: 5, message: 'go', sessionId: 11, source: 'WEBHOOK', triggerId: 3 });
    expect(result).toEqual({ sessionId: 11, messageId: 101, queued: false, terminalPhase: 'COMPLETED' });
    expect(h.sessionService.updatePhase).toHaveBeenCalledWith(11, 'RUNNING');
    expect(h.sessionService.saveMessage).toHaveBeenCalledWith(11, 'USER', 'go', null, null, null, 0, null);
    expect(h.liveExecution).toHaveBeenCalledTimes(1);
    const args = h.liveExecution.mock.calls[0] as unknown[];
    expect(args[6]).toBe('WEBHOOK'); // 第 7 参 source 透传（收件箱徽标）
    expect(h.enqueue).not.toHaveBeenCalled();
    expect(h.finishExecution).not.toHaveBeenCalled();
  });

  it('liveExecution 返回后会话仍 FAILED：terminalPhase=FAILED，不得标 COMPLETED', async () => {
    const h = makeHarness();
    h.sessionService.getSession
      .mockResolvedValueOnce(session()) // run 入口
      .mockResolvedValueOnce(session()) // 锁内重读
      .mockResolvedValueOnce(session({ phase: 'FAILED' })); // liveExecution 后回读
    const result = await h.service.run({ userId: 7, agentId: 5, message: 'go', sessionId: 11, source: 'API' });
    expect(result.terminalPhase).toBe('FAILED');
  });

  it('busy：入队并落 source/open_trigger_id 两列，queued=true、messageId=null', async () => {
    const h = makeHarness();
    h.isSessionBusy.mockReturnValue(true);
    const result = await h.service.run({ userId: 7, agentId: 5, message: 'go', sessionId: 11, source: 'WEBHOOK', triggerId: 3 });
    expect(result).toEqual({ sessionId: 11, messageId: null, queued: true, terminalPhase: 'COMPLETED' });
    expect(h.enqueue).toHaveBeenCalledWith(11, 7, 'go', null, null, 'WEBHOOK', 3, null, null, null);
    expect(h.sessionService.updatePhase).not.toHaveBeenCalled();
    expect(h.liveExecution).not.toHaveBeenCalled();
  });

  it('busy：外部事件身份随队列行透传，供消费侧任务域去重', async () => {
    const h = makeHarness();
    h.isSessionBusy.mockReturnValue(true);
    const result = await h.service.run({
      userId: 7, agentId: 5, message: 'go', sessionId: 11, source: 'API', externalEvent: { scope: 'token:4', id: 'evt-9' },
    });
    expect(result).toMatchObject({ sessionId: 11, queued: true, messageId: null });
    expect(h.enqueue).toHaveBeenCalledWith(11, 7, 'go', null, null, 'API', null, null, 'evt-9', 'token:4');
  });

  it('已认领的外部事件在预算与会话创建前直接返回原执行', async () => {
    const h = makeHarness({
      externalEventTrace: async () => ({ sessionId: 42, executionId: 'first', status: 'FAILED' }),
    });
    const result = await h.service.run({
      userId: 7, agentId: 5, message: 'go', source: 'API', externalEvent: { scope: 'token:4', id: 'evt-9' },
    });
    expect(result).toEqual({ sessionId: 42, messageId: null, queued: false, terminalPhase: 'FAILED', deduplicated: true });
    expect(h.findExternalEvent).toHaveBeenCalledWith('token:4', 'evt-9');
    expect(h.budgetCheck).not.toHaveBeenCalled();
    expect(h.sessionService.createSession).not.toHaveBeenCalled();
    expect(h.liveExecution).not.toHaveBeenCalled();
  });

  it('兜底直跑路径发现事件已被认领时清理会话与消息且不调用 Harness', async () => {
    const h = makeHarness({ liveExecution: false, beginDuplicate: true });
    h.findExternalEvent
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ sessionId: 11, executionId: 'first', status: 'COMPLETED' });
    const result = await h.service.run({
      userId: 7, agentId: 5, message: 'go', source: 'WEBHOOK', externalEvent: { scope: 'trigger:3', id: 'evt-9' },
    });
    expect(result).toMatchObject({ sessionId: 11, deduplicated: true, terminalPhase: 'COMPLETED' });
    expect(h.beginExecution).toHaveBeenCalledWith(99, expect.any(String), 'WEBHOOK', { scope: 'trigger:3', id: 'evt-9' });
    expect(h.sessionService.updatePhase).toHaveBeenCalledWith(99, 'IDLE');
    expect(h.sessionService.deleteMessageById).toHaveBeenCalledWith(99, 101);
    expect(h.sessionService.deleteSession).toHaveBeenCalledWith(99);
  });

  it('直跑期间并发认领发生时回滚本次新建的会话与消息', async () => {
    const h = makeHarness();
    h.findExternalEvent
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ sessionId: 42, executionId: 'winner', status: 'FAILED' });
    const result = await h.service.run({
      userId: 7, agentId: 5, message: 'go', source: 'API', externalEvent: { scope: 'token:4', id: 'evt-9' },
    });
    expect(result).toEqual({ sessionId: 42, messageId: null, queued: false, terminalPhase: 'FAILED', deduplicated: true });
    expect(h.sessionService.deleteMessageById).toHaveBeenCalledWith(99, 101);
    expect(h.sessionService.deleteSession).toHaveBeenCalledWith(99);
    expect(h.liveExecution).toHaveBeenCalledWith(
      expect.objectContaining({ id: 99 }), 7, expect.any(String), expect.objectContaining({ id: 101 }),
      expect.any(Number), null, 'API', { scope: 'token:4', id: 'evt-9' },
    );
  });

  it('未指定会话：经 createSession 显式 CLOUD 新建', async () => {
    const h = makeHarness();
    const result = await h.service.run({ userId: 7, agentId: 5, message: 'go', source: 'API' });
    expect(result.sessionId).toBe(99);
    // 16 个位置参数逐个钉死：装配层是 as unknown as 强转，接口与真实签名不一致编译期
    // 不报警，错位会把 source 静默写进 workspace/gitCloneUrl（技术方案 §7 第 3 行）。
    // API 触发的新会话落 'openapi'（技术方案 2026-10-29 §2.1-2），不再回落默认 'web'。
    expect(h.sessionService.createSession).toHaveBeenCalledWith(
      7, 5, null, 'CLOUD',
      undefined, undefined, undefined, undefined, undefined, undefined,
      undefined, undefined, undefined, undefined, undefined,
      'openapi',
    );
  });

  it('未指定会话 + source=SIGNAL：第 16 参落 signal（哨兵会话进独立分组）', async () => {
    const h = makeHarness();
    await h.service.run({ userId: 7, agentId: 5, message: 'go', source: 'SIGNAL' });
    const args = h.sessionService.createSession.mock.calls[0]!;
    expect(args).toHaveLength(16);
    expect(args[15]).toBe('signal');
    // 前 15 参与 API 路完全一致（只有 source 不同）
    expect(args.slice(0, 15)).toEqual([7, 5, null, 'CLOUD', undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined]);
  });

  it('未指定会话 + source=WEBHOOK：第 16 参落 openapi（与 API 同为开放接口触发）', async () => {
    const h = makeHarness();
    await h.service.run({ userId: 7, agentId: 5, message: 'go', source: 'WEBHOOK', triggerId: 3 });
    const args = h.sessionService.createSession.mock.calls[0]!;
    expect(args[15]).toBe('openapi');
  });

  it('复用既有会话（sessionId 指定）时不改写原 source', async () => {
    const h = makeHarness();
    const existing = session({ id: 11, source: 'feishu' });
    h.sessionService.getSession.mockResolvedValue(existing);
    await h.service.run({ userId: 7, agentId: 5, message: 'go', sessionId: 11, source: 'API' });
    // 复用路径不新建会话：原 source（'feishu'）保持创建时的值
    expect(h.sessionService.createSession).not.toHaveBeenCalled();
  });

  it('saveMessage 失败：回滚 phase 到 IDLE 且异常上抛', async () => {
    const h = makeHarness();
    h.sessionService.saveMessage.mockRejectedValue(new Error('db down'));
    await expect(h.service.run({ userId: 7, agentId: 5, message: 'go', sessionId: 11, source: 'API' })).rejects.toThrow('db down');
    expect(h.sessionService.updatePhase).toHaveBeenLastCalledWith(11, 'IDLE');
  });

  it('预算 BLOCK：抛 BUDGET_EXCEEDED（3041）且不建会话、不落消息（§5.7）', async () => {
    const h = makeHarness({ budgetCheck: async () => ({ message: '本月全局预算已超限：当期消耗 12 / 上限 10（成本 口径）' }) });
    await expect(h.service.run({ userId: 7, agentId: 5, message: 'go', source: 'API' }))
      .rejects.toMatchObject({ code: 3041 });
    // 检查点在 createSession / withSessionLock 之前：拒绝不留孤儿空会话
    expect(h.sessionService.createSession).not.toHaveBeenCalled();
    expect(h.sessionService.saveMessage).not.toHaveBeenCalled();
    expect(h.liveExecution).not.toHaveBeenCalled();
    expect(h.budgetCheck).toHaveBeenCalledWith({ userId: 7, agentId: 5 });
  });

  it('预算 BLOCK：指定会话路径同样在建会话前拒绝', async () => {
    const h = makeHarness({ budgetCheck: async () => ({ message: 'blocked' }) });
    await expect(h.service.run({ userId: 7, agentId: 5, message: 'go', sessionId: 11, source: 'WEBHOOK', triggerId: 3 }))
      .rejects.toMatchObject({ code: 3041 });
    expect(h.sessionService.getSession).not.toHaveBeenCalled();
    expect(h.enqueue).not.toHaveBeenCalled();
  });

  it('预算未命中 → 正常放行（budgetCheck 返回 null）', async () => {
    const h = makeHarness();
    const result = await h.service.run({ userId: 7, agentId: 5, message: 'go', sessionId: 11, source: 'API' });
    expect(result.terminalPhase).toBe('COMPLETED');
    expect(h.budgetCheck).toHaveBeenCalledTimes(1);
  });

  it('准入拒绝：3054，且发生在预算、会话读取/创建、落消息、入队与执行之前', async () => {
    const h = makeHarness({ admission: async () => { throw new BusinessException(ErrorCode.ADMISSION_REJECTED); } });
    await expect(h.service.run({
      userId: 7, agentId: 5, message: 'go', source: 'API',
      admissionBinding: { kind: 'API_TOKEN', tokenId: 3 },
    })).rejects.toMatchObject({ code: 3054 });
    expect(h.admission).toHaveBeenCalledWith({
      userId: 7, agentId: 5, sessionId: null, source: 'API',
      binding: { kind: 'API_TOKEN', tokenId: 3 },
    });
    expect(h.budgetCheck).not.toHaveBeenCalled();
    expect(h.sessionService.getSession).not.toHaveBeenCalled();
    expect(h.sessionService.createSession).not.toHaveBeenCalled();
    expect(h.sessionService.saveMessage).not.toHaveBeenCalled();
    expect(h.enqueue).not.toHaveBeenCalled();
    expect(h.liveExecution).not.toHaveBeenCalled();
  });

  it('准入拒绝：指定会话路径不读取会话，复用类绑定原样透传 sessionId', async () => {
    const h = makeHarness({ admission: async () => { throw new BusinessException(ErrorCode.ADMISSION_REJECTED); } });
    await expect(h.service.run({
      userId: 7, agentId: 5, message: 'go', sessionId: 11, source: 'WEBHOOK',
      admissionBinding: { kind: 'WEBHOOK_TRIGGER', triggerId: 5 },
    })).rejects.toMatchObject({ code: 3054 });
    expect(h.admission).toHaveBeenCalledWith({
      userId: 7, agentId: 5, sessionId: 11, source: 'WEBHOOK',
      binding: { kind: 'WEBHOOK_TRIGGER', triggerId: 5 },
    });
    expect(h.sessionService.getSession).not.toHaveBeenCalled();
  });

  it('准入依赖未知异常：失败关闭为 ADMISSION_UNAVAILABLE（3055）', async () => {
    const h = makeHarness({ admission: async () => { throw new Error('db down'); } });
    await expect(h.service.run({
      userId: 7, agentId: 5, message: 'go', source: 'SIGNAL',
      admissionBinding: { kind: 'SIGNAL_WATCHER', watcherId: 13 },
    })).rejects.toMatchObject({ code: 3055, message: '准入检查暂不可用，请稍后重试' });
    expect(h.budgetCheck).not.toHaveBeenCalled();
    expect(h.sessionService.createSession).not.toHaveBeenCalled();
  });
});

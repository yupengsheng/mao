import { beforeEach, describe, expect, it, vi } from 'vitest';
import { parseCliConfig } from '../src/args';
import { cmdChat, type ChatContext } from '../src/commands/chat';
import type { ReplOptions } from '../src/repl/repl';
import type { SessionVO } from '../src/rest/types';
import type { WsEvent } from '../src/ws/event-types';
import { createLogger } from '../src/util/logger';

const mocks = vi.hoisted(() => ({
  runRepl: vi.fn<(opts: ReplOptions) => Promise<void>>(),
  rememberLastSession: vi.fn(),
  setMeta: vi.fn(),
  resetSessionMetrics: vi.fn(),
  print: vi.fn(),
  failSubscribeFor: new Set<number>(),
  subscribe: vi.fn<(id: number) => void>(),
}));

vi.mock('../src/config/config-store', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/config/config-store')>(),
  rememberLastSession: mocks.rememberLastSession,
}));

vi.mock('../src/repl/repl', () => ({ runRepl: mocks.runRepl }));

// 仅替换传输和终端层，保留真实 SessionRunner 的挂载、回滚及解除挂载行为。
vi.mock('../src/ws/ws-client', () => ({
  WsClient: class {
    handlers = new Set<(evt: WsEvent) => void>();
    setOnReconnect(): void {}
    async connect(): Promise<void> {}
    subscribe(id: number): void {
      mocks.subscribe(id);
      if (mocks.failSubscribeFor.has(id)) throw new Error(`subscribe failed: ${id}`);
      for (const handler of this.handlers) {
        handler({ type: 'session_snapshot', sessionId: id, data: { phase: 'IDLE' } });
      }
    }
    unsubscribe(): void {}
    close(): void {}
    on(handler: (evt: WsEvent) => void): () => void {
      this.handlers.add(handler);
      return () => { this.handlers.delete(handler); };
    }
  },
}));

vi.mock('../src/tui/ink-renderer', () => ({
  InkTuiRenderer: class {
    mount() { return { unmount: () => {} }; }
    setApprovalSubmitHandler(): void {}
    seedChrome(): void {}
    announce(): void {}
    onEvent(): void {}
    setMeta = mocks.setMeta;
    resetSessionMetrics = mocks.resetSessionMetrics;
    print = mocks.print;
  },
}));

function makeCtx(args: string[] = []) {
  const sessions = new Map<number, SessionVO>([
    [11, { id: 11, executionMode: 'CLOUD', phase: 'IDLE', modelId: 10 }],
    [22, { id: 22, executionMode: 'CLOUD', phase: 'IDLE', modelId: 20 }],
    [33, { id: 33, executionMode: 'CLOUD', phase: 'IDLE' }],
  ]);
  const rest = {
    listAgents: vi.fn(async () => [{ id: 1, name: 'default', isDefault: true }]),
    listActiveModels: vi.fn(async () => [{ id: 10, name: 'm1' }, { id: 20, name: 'm2' }]),
    createSession: vi.fn(async () => sessions.get(11)!),
    getSession: vi.fn(async (id: number | string) => sessions.get(Number(id))!),
    listMessages: vi.fn(async () => ({ messages: [] })),
    markRead: vi.fn(async () => {}),
  };
  const ctx: ChatContext = {
    rest: rest as unknown as ChatContext['rest'],
    cfg: parseCliConfig(args, { stdoutIsTty: true, stdinIsTty: true }),
    resolved: { ui: {} } as ChatContext['resolved'],
    baseUrl: 'https://mao.example.com/api',
    getToken: async () => 'token',
    logger: createLogger(false),
  };
  return { ctx, rest, sessions };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.runRepl.mockReset();
  mocks.failSubscribeFor.clear();
});

describe('cmdChat session attachment state', () => {
  it('reattaches the cached created session after both switching and rollback fail', async () => {
    const { ctx, rest, sessions } = makeCtx();
    mocks.runRepl.mockImplementation(async (opts) => {
      await opts.ensureSession!(10);
      expect(opts.runner.getSession()).toBe(sessions.get(11));
      mocks.failSubscribeFor.add(22);
      mocks.failSubscribeFor.add(11);

      await expect(opts.switchSession!(22)).rejects.toThrow(/请退出后重开/);
      expect(opts.runner.getSession()).toBeNull();
      expect(mocks.rememberLastSession.mock.calls).toEqual([[11]]);
      expect(mocks.setMeta).not.toHaveBeenCalled();
      expect(mocks.resetSessionMetrics).not.toHaveBeenCalled();
      expect(mocks.print).not.toHaveBeenCalled();

      // 清除网络故障后，下一条消息必须重挂原缓存，而不是误判 attached 或重复建会话。
      mocks.failSubscribeFor.clear();
      await opts.ensureSession!(20);
      expect(opts.runner.getSession()).toBe(sessions.get(11));
      expect(rest.createSession).toHaveBeenCalledTimes(1);
      expect(mocks.subscribe.mock.calls.map(([id]) => id)).toEqual([11, 22, 11, 11]);
      await opts.onExit();
    });

    expect(await cmdChat(ctx)).toBe(0);
    expect(mocks.runRepl).toHaveBeenCalledOnce();
  });

  it('keeps the successfully switched session cached for recovery without creating a draft', async () => {
    const { ctx, rest, sessions } = makeCtx();
    mocks.runRepl.mockImplementation(async (opts) => {
      await expect(opts.switchSession!(22)).resolves.toBe(sessions.get(22));
      await opts.ensureSession!();
      expect(rest.createSession).not.toHaveBeenCalled();
      expect(mocks.subscribe.mock.calls.map(([id]) => id)).toEqual([22]);
      expect(mocks.rememberLastSession.mock.calls).toEqual([[22]]);
      expect(mocks.setMeta).toHaveBeenCalledOnce();
      expect(mocks.resetSessionMetrics).toHaveBeenCalledOnce();

      mocks.failSubscribeFor.add(33);
      mocks.failSubscribeFor.add(22);
      await expect(opts.switchSession!(33)).rejects.toThrow(/请退出后重开/);
      expect(opts.runner.getSession()).toBeNull();
      mocks.failSubscribeFor.clear();
      await opts.ensureSession!();

      expect(opts.runner.getSession()).toBe(sessions.get(22));
      expect(rest.createSession).not.toHaveBeenCalled();
      expect(mocks.rememberLastSession.mock.calls).toEqual([[22]]);
      expect(mocks.setMeta).toHaveBeenCalledOnce();
      expect(mocks.resetSessionMetrics).toHaveBeenCalledOnce();
      expect(mocks.print).toHaveBeenCalledOnce();
      await opts.onExit();
    });

    expect(await cmdChat(ctx)).toBe(0);
  });

  it('keeps attached state and external state unchanged when rollback succeeds', async () => {
    const { ctx, rest, sessions } = makeCtx();
    mocks.runRepl.mockImplementation(async (opts) => {
      await opts.ensureSession!();
      mocks.failSubscribeFor.add(22);
      await expect(opts.switchSession!(22)).rejects.toThrow('subscribe failed: 22');
      expect(opts.runner.getSession()).toBe(sessions.get(11));
      const subscriptions = mocks.subscribe.mock.calls.length;
      await opts.ensureSession!();

      expect(mocks.subscribe).toHaveBeenCalledTimes(subscriptions);
      expect(rest.createSession).toHaveBeenCalledOnce();
      expect(mocks.rememberLastSession.mock.calls).toEqual([[11]]);
      expect(mocks.setMeta).not.toHaveBeenCalled();
      expect(mocks.resetSessionMetrics).not.toHaveBeenCalled();
      await opts.onExit();
    });

    expect(await cmdChat(ctx)).toBe(0);
  });

  it('reuses a created session when its initial attachment fails', async () => {
    const { ctx, rest, sessions } = makeCtx();
    mocks.runRepl.mockImplementation(async (opts) => {
      mocks.failSubscribeFor.add(11);
      await expect(opts.ensureSession!(10)).rejects.toThrow('subscribe failed: 11');
      mocks.failSubscribeFor.clear();
      await opts.ensureSession!(20);

      expect(opts.runner.getSession()).toBe(sessions.get(11));
      expect(rest.createSession).toHaveBeenCalledOnce();
      expect(rest.createSession).toHaveBeenCalledWith(expect.objectContaining({ modelId: 10 }));
      expect(mocks.rememberLastSession.mock.calls).toEqual([[11]]);
      await opts.onExit();
    });

    expect(await cmdChat(ctx)).toBe(0);
  });

  it('can create the draft after switching from an unattached draft fails', async () => {
    const { ctx, rest, sessions } = makeCtx();
    mocks.runRepl.mockImplementation(async (opts) => {
      mocks.failSubscribeFor.add(22);
      await expect(opts.switchSession!(22)).rejects.toThrow('subscribe failed: 22');
      expect(opts.runner.getSession()).toBeNull();
      expect(mocks.rememberLastSession).not.toHaveBeenCalled();
      await opts.ensureSession!();

      expect(opts.runner.getSession()).toBe(sessions.get(11));
      expect(rest.createSession).toHaveBeenCalledOnce();
      expect(mocks.rememberLastSession.mock.calls).toEqual([[11]]);
      await opts.onExit();
    });

    expect(await cmdChat(ctx)).toBe(0);
  });

  it.each([
    { next: { executionMode: 'LOCAL' }, args: [] as string[], error: /模式/ },
    { next: { running: true }, args: ['--if-running=fail'], error: /仍在执行/ },
    { next: { phase: 'RUNNING' }, args: ['--if-running=fail'], error: /仍在执行/ },
  ])('preserves switch guards: $next', async ({ next, args, error }) => {
    const { ctx, rest, sessions } = makeCtx(args);
    sessions.set(22, { ...sessions.get(22), ...next } as SessionVO);
    mocks.runRepl.mockImplementation(async (opts) => {
      await expect(opts.switchSession!(22)).rejects.toThrow(error);
      expect(mocks.subscribe).not.toHaveBeenCalled();
      expect(mocks.rememberLastSession).not.toHaveBeenCalled();
      expect(mocks.setMeta).not.toHaveBeenCalled();
      await opts.ensureSession!();
      expect(opts.runner.getSession()).toBe(sessions.get(11));
      expect(rest.createSession).toHaveBeenCalledOnce();
      await opts.onExit();
    });

    expect(await cmdChat(ctx)).toBe(0);
  });
});

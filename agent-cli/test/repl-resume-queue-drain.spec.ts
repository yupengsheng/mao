import { describe, expect, it, vi } from 'vitest';
import { runRepl, type ReplOptions } from '../src/repl/repl';
import type { SessionRunner } from '../src/session/session-runner';
import type { InkTuiRenderer } from '../src/tui/ink-renderer';
import type { TuiHandle } from '../src/tui/types';
import type { SessionVO } from '../src/rest/types';

/**
 * `/resume` 切入运行中会话后，续接等待期间排队的输入原先无人消费：
 * 消息静默滞留，且下一条提交会先发出旧消息（乱序）。
 * 修复后：续接结束立即排水，兑现「本轮结束自动发送」。
 */
interface Deferred {
  resolve: () => void;
  promise: Promise<void>;
}

function makeDeferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { resolve, promise };
}

type SubmitHandlers = {
  onSubmit: (t: string) => void;
  onCancel: () => void;
  onEscape: () => void;
  onExit: () => void;
};

function setup() {
  const state = { busy: false, active: false, gate: null as Deferred | null };
  const hints: string[] = [];
  const runPrompt = vi.fn(async () => ({ status: 'COMPLETED' }));
  let handlers: SubmitHandlers = null as never;
  let requestExitResolve: (() => void) | null = null;

  const runner = {
    isRunning: () => state.busy,
    get snapshotIsActive() { return state.active; },
    waitForCurrentRun: async () => {
      state.busy = true;
      try {
        if (state.gate) await state.gate.promise;
      } finally {
        state.busy = false;
      }
      return { status: 'COMPLETED' } as never;
    },
    runPrompt,
    cancel: vi.fn(async () => undefined),
    getSession: () => ({ id: 1 }),
  } as unknown as SessionRunner;

  const renderer = {
    announce: (s: string) => hints.push(s),
    print: (s: string) => hints.push(s),
    clearTransient: () => undefined,
    noteUser: () => undefined,
    startRound: () => undefined,
    setInputHandlers: (h: SubmitHandlers) => { handlers = h; },
  } as unknown as InkTuiRenderer;

  const opts: ReplOptions = {
    runner,
    renderer,
    tuiHandle: { clearAll: () => undefined, unmount: () => undefined } as unknown as TuiHandle,
    resolveModel: async () => 7,
    switchSession: async (id: number) => {
      state.active = true;
      return { id, title: `会话${id}`, modelId: 9 } as SessionVO;
    },
    listSwitchableSessions: async () => [],
    onExit: async () => { requestExitResolve?.(); },
  };

  const done = new Promise<void>((resolve) => { requestExitResolve = resolve; });
  return { opts, runPrompt, hints, state, handlers: () => handlers, exit: () => done };
}

const tick = () => new Promise((r) => setTimeout(r, 15));

describe('/resume 续接结束后排水排队输入', () => {
  it('自动发送等待期间入队的消息，并沿用新会话模型', async () => {
    const t = setup();
    t.state.gate = makeDeferred();
    void runRepl(t.opts).catch(() => undefined);
    await tick();

    t.handlers().onSubmit('/resume 21');
    await tick();
    expect(t.hints.join('\n')).toContain('已切换到会话 #21');

    t.handlers().onSubmit('hello');
    await tick();
    expect(t.hints.join('\n')).toContain('已排队');
    expect(t.runPrompt).not.toHaveBeenCalled();

    t.state.gate.resolve();
    await tick();
    expect(t.runPrompt).toHaveBeenCalledWith('hello', 9);

    t.handlers().onExit();
    await t.exit();
  });
});

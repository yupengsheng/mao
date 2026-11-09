import { describe, expect, it, vi } from 'vitest';
import { runRepl, type ReplOptions } from '../src/repl/repl';
import type { SessionRunner } from '../src/session/session-runner';
import type { InkTuiRenderer } from '../src/tui/ink-renderer';
import type { TuiHandle } from '../src/tui/types';

/**
 * 启动即续接运行中会话时，等待期间排队的输入原先无人消费。
 * 修复后：waitForCurrentRun 结束立即排水，兑现「本轮结束自动发送」。
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
  const state = { busy: false, gate: null as Deferred | null };
  const hints: string[] = [];
  const runPrompt = vi.fn(async () => ({ status: 'COMPLETED' }));
  let handlers: SubmitHandlers = null as never;
  let requestExitResolve: (() => void) | null = null;

  const runner = {
    isRunning: () => state.busy,
    snapshotIsActive: true,
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
    onExit: async () => { requestExitResolve?.(); },
  };

  const done = new Promise<void>((resolve) => { requestExitResolve = resolve; });
  return { opts, runPrompt, hints, state, handlers: () => handlers, exit: () => done };
}

const tick = () => new Promise((r) => setTimeout(r, 15));

describe('启动续接结束后排水排队输入', () => {
  it('自动发送等待期间入队的消息', async () => {
    const t = setup();
    t.state.gate = makeDeferred();
    void runRepl(t.opts).catch(() => undefined);
    await tick();

    t.handlers().onSubmit('hello');
    await tick();
    expect(t.hints.join('\n')).toContain('已排队');
    expect(t.runPrompt).not.toHaveBeenCalled();

    t.state.gate.resolve();
    await tick();
    expect(t.runPrompt).toHaveBeenCalledWith('hello', undefined);

    t.handlers().onExit();
    await t.exit();
  });
});

import { describe, expect, it, vi } from 'vitest';
import { OutboundDeliveryScheduler } from './outbound-delivery.scheduler.js';
import type { OutboundDelivery } from './types.js';

/**
 * 抛出型失败收口回归（BUG-3）：
 * deliver 的 catch 只打日志会让行停在 SENDING，被 recoverInterrupted 反复复位重认领
 * 且 attempt_count 不推进，永远到不了 3 次重试后的 FAILED 终态与审计。
 * 修复口径：抛出与 result 失败同走 attempt+1 的退避/终态链。
 */

type DeliveryRow = OutboundDelivery & { id: number };

/** 内存版投递行：claim PENDING→SENDING、scheduleRetry/markFailed/markSucceeded 与 SQL 同字段语义。 */
function fakeDeliveryRepo(row: DeliveryRow) {
  const calls = { scheduleRetry: 0, markFailed: 0, markSucceeded: 0 };
  const repo = {
    async listDue(): Promise<OutboundDelivery[]> {
      return row.status === 'PENDING' ? [{ ...row }] : [];
    },
    async claim(id: number): Promise<string | null> {
      if (row.id !== id || row.status !== 'PENDING') return null;
      row.status = 'SENDING';
      row.claimToken = 'claim-1';
      return row.claimToken;
    },
    async findById(id: number): Promise<OutboundDelivery | null> {
      return row.id === id ? { ...row } : null;
    },
    async recoverInterrupted(): Promise<void> {},
    async scheduleRetry(id: number, claimToken: string, attemptCount: number, httpStatus: number | null, error: string | null, nextRetryAt: string): Promise<boolean> {
      void id;
      void claimToken;
      calls.scheduleRetry++;
      row.status = 'PENDING';
      row.attemptCount = attemptCount;
      row.lastHttpStatus = httpStatus;
      row.lastError = error;
      row.nextRetryAt = nextRetryAt;
      return true;
    },
    async markFailed(id: number, claimToken: string, attemptCount: number, httpStatus: number | null, error: string | null): Promise<boolean> {
      void id;
      void claimToken;
      calls.markFailed++;
      row.status = 'FAILED';
      row.attemptCount = attemptCount;
      row.lastHttpStatus = httpStatus;
      row.lastError = error;
      row.nextRetryAt = null;
      return true;
    },
    async markSucceeded(id: number, claimToken: string, attemptCount: number, httpStatus: number | null, now: string): Promise<boolean> {
      void id;
      void claimToken;
      calls.markSucceeded++;
      row.status = 'SUCCEEDED';
      row.attemptCount = attemptCount;
      row.lastHttpStatus = httpStatus;
      row.sentAt = now;
      return true;
    },
  };
  return { repo, calls };
}

const SUBSCRIPTION = {
  id: 5,
  userId: 7,
  event: 'task.completed',
  targetUrl: 'https://hook.example/x',
  secretCipher: 'cipher-text',
  enabled: 1,
};

function baseRow(): DeliveryRow {
  return {
    id: 1,
    subscriptionId: 5,
    event: 'task.completed',
    payload: '{}',
    status: 'PENDING',
    attemptCount: 0,
    nextRetryAt: null,
    lastHttpStatus: null,
    lastError: null,
    claimToken: null,
    createdAt: null,
    sentAt: null,
  };
}

function makeScheduler(
  row: DeliveryRow,
  overrides?: { decrypt?: () => string; send?: () => Promise<{ success: boolean; httpStatus: number | null; error?: string | null }> },
) {
  const { repo, calls } = fakeDeliveryRepo(row);
  const audit = { recordDeliveryFailed: vi.fn(async () => undefined) };
  // execute 捕获 deliver 的 promise：dispatchDueDeliveries 只负责认领，回写在异步链里
  const pending: Promise<unknown>[] = [];
  const scheduler = new OutboundDeliveryScheduler({
    deliveryRepo: repo as never,
    subscriptionRepo: { findById: vi.fn(async () => ({ ...SUBSCRIPTION })) } as never,
    cipher: { decrypt: overrides?.decrypt ?? (() => 'secret') } as never,
    sender: { send: overrides?.send ?? (async () => ({ success: true, httpStatus: 200 })) } as never,
    auditRecorder: audit,
    execute: (fn: () => unknown) => { pending.push(Promise.resolve().then(fn)); },
  });
  const dispatchOnce = async () => {
    await scheduler.dispatchDueDeliveries();
    await Promise.all(pending.splice(0));
  };
  return { scheduler, calls, audit, dispatchOnce };
}

describe('OutboundDeliveryScheduler 抛出型失败收口', () => {
  it('secret 解密抛出走退避重试而不是停在 SENDING', async () => {
    const row = baseRow();
    const { calls, dispatchOnce } = makeScheduler(row, {
      decrypt: () => { throw new Error('解密失败: key rotated'); },
    });

    await dispatchOnce();

    expect(calls.scheduleRetry).toBe(1);
    expect(calls.markFailed).toBe(0);
    expect(row.status).toBe('PENDING');
    expect(row.attemptCount).toBe(1);
    expect(row.lastError).toContain('解密失败');
    expect(row.nextRetryAt).toBeTruthy();
  });

  it('连续抛出共 4 次尝试后终态 FAILED 并落审计', async () => {
    const row = baseRow();
    const { calls, audit, dispatchOnce } = makeScheduler(row, {
      decrypt: () => { throw new Error('解密失败: key rotated'); },
    });

    for (let round = 0; round < 4; round++) {
      await dispatchOnce();
    }

    // 1/5/25 分钟退避共 3 次，第 4 次尝试失败进终态
    expect(calls.scheduleRetry).toBe(3);
    expect(calls.markFailed).toBe(1);
    expect(row.status).toBe('FAILED');
    expect(row.attemptCount).toBe(4);
    expect(row.nextRetryAt).toBeNull();
    expect(audit.recordDeliveryFailed).toHaveBeenCalledTimes(1);
    expect(audit.recordDeliveryFailed).toHaveBeenCalledWith(expect.objectContaining({
      subscriptionId: 5,
      event: 'task.completed',
      targetUrl: 'https://hook.example/x',
      userId: 7,
    }));
  });

  it('解密成功且发送成功时照常 markSucceeded（对照：收口链不误伤正常路径）', async () => {
    const row = baseRow();
    const { calls, audit, dispatchOnce } = makeScheduler(row);

    await dispatchOnce();

    expect(calls.markSucceeded).toBe(1);
    expect(row.status).toBe('SUCCEEDED');
    expect(row.attemptCount).toBe(1);
    expect(audit.recordDeliveryFailed).not.toHaveBeenCalled();
  });

  it('发送前再次确认 SENDING，已被恢复或接管的旧执行不发送也不回写', async () => {
    const row = baseRow();
    const send = vi.fn(async () => ({ success: true, httpStatus: 200 }));
    const { scheduler, calls } = makeScheduler(row, { send });

    await (scheduler as unknown as { deliver(id: number, claimToken: string): Promise<void> }).deliver(row.id, 'claim-1');

    expect(send).not.toHaveBeenCalled();
    expect(calls.markSucceeded).toBe(0);
    expect(calls.markFailed).toBe(0);
    expect(row.status).toBe('PENDING');
  });

  it('发送中的旧 worker 经恢复后不能借新 token 结算，也不能为过期失败写审计', async () => {
    const state: DeliveryRow = { ...baseRow(), status: 'SENDING', claimToken: 'claim-a' };
    const audit = { recordDeliveryFailed: vi.fn(async () => undefined) };
    const deliveryRepo = {
      findById: vi.fn(async () => ({ ...state })),
      markFailed: vi.fn(async (_id: number, claimToken: string) => {
        if (state.status !== 'SENDING' || state.claimToken !== claimToken) return false;
        state.status = 'FAILED';
        return true;
      }),
      markSucceeded: vi.fn(async () => false),
      scheduleRetry: vi.fn(async () => false),
    };
    const scheduler = new OutboundDeliveryScheduler({
      deliveryRepo: deliveryRepo as never,
      subscriptionRepo: { findById: vi.fn(async () => ({ ...SUBSCRIPTION })) } as never,
      cipher: { decrypt: () => 'secret' } as never,
      sender: {
        send: vi.fn(async () => {
          // A 被恢复为 PENDING 后由 B 重新认领；A 的回调仍只能使用 claim-a。
          state.status = 'PENDING';
          state.claimToken = null;
          state.status = 'SENDING';
          state.claimToken = 'claim-b';
          return { success: false, retryable: false, httpStatus: 500, error: '过期 worker 失败' };
        }),
      } as never,
      auditRecorder: audit,
    });

    await (scheduler as unknown as { deliver(id: number, claimToken: string): Promise<void> }).deliver(1, 'claim-a');

    expect(deliveryRepo.markFailed).toHaveBeenCalledWith(1, 'claim-a', 1, 500, '过期 worker 失败');
    expect(state).toMatchObject({ status: 'SENDING', claimToken: 'claim-b' });
    expect(audit.recordDeliveryFailed).not.toHaveBeenCalled();
  });
});

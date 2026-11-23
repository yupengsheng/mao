import { describe, expect, it, vi } from 'vitest';
import {
  bindOutcomeToResult,
  channelBindLink,
  completePendingAfterBind,
  dingtalkUnionIdOf,
} from './bind-flow.js';

describe('channel bind flow', () => {
  it('maps replay outcomes without claiming replay failure as success', () => {
    expect(bindOutcomeToResult('replayed', { channelLabel: '钉钉', senderName: '小明' }).status).toBe('success');
    expect(bindOutcomeToResult('replay-failed', { channelLabel: '飞书', senderName: null }).status).toBe('partial');
    expect(bindOutcomeToResult('identity-mismatch', { channelLabel: '钉钉', senderName: null }).message).toContain('未改绑');
  });

  it('binds, replays and completes a pending message', async () => {
    const complete = vi.fn(async () => undefined);
    const replay = vi.fn(async () => undefined);
    const bind = vi.fn(async () => undefined);
    const result = await completePendingAfterBind({
      state: 'state-1', bindUserId: 7,
      claim: async () => ({ state: 'state-1', event: { senderUnionId: 'union-1' } }),
      unionIdOf: dingtalkUnionIdOf,
      findUserIdByUnionId: async () => null,
      bind, replay, complete,
      release: vi.fn(async () => undefined),
      failClaimed: vi.fn(async () => undefined),
    });
    expect(result).toBe('replayed');
    expect(bind).toHaveBeenCalledOnce();
    expect(replay).toHaveBeenCalledOnce();
    expect(complete).toHaveBeenCalledWith('state-1');
  });

  it('rejects an identity already bound to another Mao account', async () => {
    const failClaimed = vi.fn(async () => undefined);
    const replay = vi.fn(async () => undefined);
    const result = await completePendingAfterBind({
      state: 'state-2', bindUserId: 7,
      claim: async () => ({ state: 'state-2', event: { senderUnionId: 'union-2' } }),
      unionIdOf: dingtalkUnionIdOf,
      findUserIdByUnionId: async () => 8,
      bind: vi.fn(async () => undefined), replay,
      complete: vi.fn(async () => undefined), release: vi.fn(async () => undefined), failClaimed,
    });
    expect(result).toBe('identity-mismatch');
    expect(failClaimed).toHaveBeenCalledWith('state-2');
    expect(replay).not.toHaveBeenCalled();
  });

  it('拒绝缺少通道身份的 pending，不补投也不报告成功', async () => {
    const replay = vi.fn(async () => undefined);
    const failClaimed = vi.fn(async () => undefined);
    const result = await completePendingAfterBind({
      state: 'state-missing', bindUserId: 7,
      claim: async () => ({ state: 'state-missing', event: {} }),
      unionIdOf: () => null,
      findUserIdByUnionId: vi.fn(async () => null),
      bind: vi.fn(async () => undefined), replay,
      complete: vi.fn(async () => undefined), release: vi.fn(async () => undefined), failClaimed,
    });
    expect(result).toBe('identity-missing');
    expect(failClaimed).toHaveBeenCalledWith('state-missing');
    expect(replay).not.toHaveBeenCalled();
  });

  it('身份查询异常时释放 claim，允许后续重试', async () => {
    const release = vi.fn(async () => undefined);
    const replay = vi.fn(async () => undefined);
    await expect(completePendingAfterBind({
      state: 'state-query-error', bindUserId: 7,
      claim: async () => ({ state: 'state-query-error', event: { senderUnionId: 'union-error' } }),
      unionIdOf: dingtalkUnionIdOf,
      findUserIdByUnionId: async () => { throw new Error('查询失败'); },
      bind: vi.fn(async () => undefined), replay,
      complete: vi.fn(async () => undefined), release, failClaimed: vi.fn(async () => undefined),
    })).rejects.toThrow('查询失败');
    expect(release).toHaveBeenCalledWith('state-query-error');
    expect(replay).not.toHaveBeenCalled();
  });

  it('补投后终态写入失败不释放 state，避免重复补投', async () => {
    const complete = vi.fn()
      .mockRejectedValueOnce(new Error('数据库暂时不可用'))
      .mockRejectedValueOnce(new Error('数据库仍不可用'));
    const release = vi.fn(async () => undefined);
    const failClaimed = vi.fn(async () => undefined);
    const result = await completePendingAfterBind({
      state: 'state-complete-error', bindUserId: 7,
      claim: async () => ({ state: 'state-complete-error', event: { senderUnionId: 'union-1' } }),
      unionIdOf: dingtalkUnionIdOf,
      findUserIdByUnionId: async () => null,
      bind: vi.fn(async () => undefined), replay: vi.fn(async () => undefined), complete, release, failClaimed,
    });
    expect(result).toBe('completion-failed');
    expect(release).not.toHaveBeenCalled();
    expect(failClaimed).toHaveBeenCalledWith('state-complete-error');
  });
  it('补投完成后受理标记失败也不释放 state', async () => {
    const release = vi.fn(async () => undefined);
    const failClaimed = vi.fn(async () => undefined);
    const result = await completePendingAfterBind({
      state: 'state-mark-error', bindUserId: 7,
      claim: async () => ({ state: 'state-mark-error', event: { senderUnionId: 'union-1' } }),
      unionIdOf: dingtalkUnionIdOf,
      findUserIdByUnionId: async () => null,
      bind: vi.fn(async () => undefined), replay: vi.fn(async () => undefined),
      markReplayed: vi.fn(async () => { throw new Error('标记失败'); }),
      complete: vi.fn(async () => undefined), release, failClaimed,
    });
    expect(result).toBe('completion-failed');
    expect(release).not.toHaveBeenCalled();
    expect(failClaimed).toHaveBeenCalledWith('state-mark-error');
  });
  it('builds the SPA link from the configured site root', () => {
    expect(channelBindLink('https://mao.example.com///', 'dingtalk/bind-pwd', 'a/b')).toBe('https://mao.example.com/dingtalk/bind-pwd/a%2Fb');
  });
});

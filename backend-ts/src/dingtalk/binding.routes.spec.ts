import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { handleError } from '../common/http-error.js';
import { registerDingtalkBindingRoutes, type DingtalkBindingRouteDeps } from './binding.routes.js';
import type { DingtalkPendingBindingMessage } from './pending-binding.repository.js';

const USER_ID = 9;
const TOKEN = 'tok-9';

function row(): DingtalkPendingBindingMessage {
  return {
    state: 'st-1', botId: 2, status: 'SENT', bindingMethod: 'PASSWORD', expiresAt: new Date(Date.now() + 10 * 60_000),
    event: {
      chatType: 'p2p', conversationId: 'cid-1', messageId: 'm-1', senderUserid: 'staff-1', senderUnionId: 'du-1', senderName: '钉钉张三',
      msgtype: 'text', text: 'hello', downloadCodes: [], fileName: null, quotedText: null, isInAtList: false,
    },
  };
}

function setup(options: { existingOwner?: number | null; replayFails?: boolean; disabled?: boolean; missingUnion?: boolean } = {}) {
  const pendingRow = row();
  if (options.missingUnion === true) pendingRow.event.senderUnionId = null;
  const pending = {
    findByState: vi.fn(async () => pendingRow),
    claim: vi.fn(async () => ({ ...pendingRow, status: 'CLAIMED' })),
    complete: vi.fn(async () => undefined),
    release: vi.fn(async () => undefined),
    fail: vi.fn(async () => undefined),
  };
  const repository = {
    getStatus: vi.fn(async () => ({ bound: false })),
    findUserIdByUnionId: vi.fn(async () => options.existingOwner ?? null),
    bind: vi.fn(async () => undefined),
  };
  const replayPending = vi.fn(async () => {
    if (options.replayFails) throw new Error('replay failed');
  });
  const app = Fastify();
  app.setErrorHandler(handleError);
  const deps: DingtalkBindingRouteDeps = {
    jwt: { validateAccessToken: (token: string) => token === TOKEN, getUserIdFromToken: () => USER_ID } as never,
    repository: repository as never,
    oauthStates: {} as never,
    oauth: vi.fn(async () => ({ enabled: false, clientId: '', clientSecret: '', redirectUri: '' })) as never,
    onCallback: vi.fn(async () => undefined),
    pending: pending as never,
    currentUser: vi.fn(async (id: number) => ({ id, username: 'bob', disabled: options.disabled === true })),
    replayPending,
  };
  registerDingtalkBindingRoutes(app, deps);
  return { app, pending, repository, replayPending, auth: { authorization: `Bearer ${TOKEN}` } };
}

describe('钉钉密码绑定路由', () => {
  it('预览返回发送者、当前账号和有效期', async () => {
    const { app, auth } = setup();
    const response = await app.inject({ method: 'GET', url: '/v1/dingtalk/binding/pending?state=st-1', headers: auth });
    expect(response.statusCode).toBe(200);
    expect(response.json().data).toMatchObject({ senderName: '钉钉张三', chatType: 'p2p', willRebind: false, currentUser: { username: 'bob' } });
    expect(response.json().data.expiresAt).toBeTruthy();
  });

  it('密码接口拒绝 OAuth pending，避免绕过原登录校验', async () => {
    const isolated = setup();
    isolated.pending.findByState.mockResolvedValue({ ...row(), bindingMethod: 'OAUTH' });
    const preview = await isolated.app.inject({ method: 'GET', url: '/v1/dingtalk/binding/pending?state=st-1', headers: isolated.auth });
    expect(preview.json().code).not.toBe(0);
    const complete = await isolated.app.inject({ method: 'POST', url: '/v1/dingtalk/binding/complete', payload: { state: 'st-1' }, headers: isolated.auth });
    expect(complete.json().data.status).toBe('failed');
  });
  it('身份冲突不绑定、不补投', async () => {
    const { app, auth, repository, replayPending } = setup({ existingOwner: 3 });
    const response = await app.inject({ method: 'POST', url: '/v1/dingtalk/binding/complete', payload: { state: 'st-1' }, headers: auth });
    expect(response.json().data).toMatchObject({ status: 'failed' });
    expect(response.json().data.message).toContain('已绑定其它 Mao 账号');
    expect(repository.bind).not.toHaveBeenCalled();
    expect(replayPending).not.toHaveBeenCalled();
  });

  it('缺少 senderUnionId 时拒绝绑定且不补投', async () => {
    const { app, auth, repository, replayPending, pending } = setup({ missingUnion: true });
    const response = await app.inject({ method: 'POST', url: '/v1/dingtalk/binding/complete', payload: { state: 'st-1' }, headers: auth });
    expect(response.json().data.status).toBe('failed');
    expect(response.json().data.message).toContain('未能识别');
    expect(repository.bind).not.toHaveBeenCalled();
    expect(replayPending).not.toHaveBeenCalled();
    expect(pending.fail).toHaveBeenCalledWith('st-1');
  });
  it('完成绑定时传入 senderUserid，补投并消费 state', async () => {
    const { app, auth, repository, pending } = setup();
    const response = await app.inject({ method: 'POST', url: '/v1/dingtalk/binding/complete', payload: { state: 'st-1' }, headers: auth });
    expect(response.json().data).toEqual({ status: 'success', message: '绑定成功，已开始处理你刚才的消息', senderName: '钉钉张三' });
    expect(repository.bind).toHaveBeenCalledWith(USER_ID, 'du-1', 'staff-1');
    expect(pending.complete).toHaveBeenCalledWith('st-1');
  });

  it('补投失败返回 partial 并释放 state，禁用账号不能 claim', async () => {
    const failed = setup({ replayFails: true });
    const response = await failed.app.inject({ method: 'POST', url: '/v1/dingtalk/binding/complete', payload: { state: 'st-1' }, headers: failed.auth });
    expect(response.json().data.status).toBe('partial');
    expect(failed.pending.release).toHaveBeenCalledWith('st-1');

    const disabled = setup({ disabled: true });
    const disabledResponse = await disabled.app.inject({ method: 'POST', url: '/v1/dingtalk/binding/complete', payload: { state: 'st-1' }, headers: disabled.auth });
    expect(disabledResponse.json().data.message).toContain('账号已禁用');
    expect(disabled.pending.claim).not.toHaveBeenCalled();
  });

  it('未登录预览和完成均返回 401', async () => {
    const { app } = setup();
    expect((await app.inject({ method: 'GET', url: '/v1/dingtalk/binding/pending?state=st-1' })).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: '/v1/dingtalk/binding/complete', payload: { state: 'st-1' } })).statusCode).toBe(401);
  });
});

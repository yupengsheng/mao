import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { handleError } from '../common/http-error.js';
import { registerFeishuPendingBindingRoutes, type FeishuBindingRouteDeps } from './binding.routes.js';
import type { FeishuPendingBindingMessage } from './pending-binding.repository.js';

const USER_ID = 9;
const TOKEN = 'tok-9';

function sqlLocal(ms: number): string {
  const d = new Date(ms);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function row(createdAt = sqlLocal(Date.now() - 60_000)): FeishuPendingBindingMessage & { createdAt: string } {
  return {
    id: 1, state: 'st-1', appId: 3, messageId: 'om-in', cardMessageId: null, status: 'SENT', bindingMethod: 'PASSWORD', createdAt,
    event: {
      eventId: 'evt', messageId: 'om-in', chatId: null, chatType: 'p2p', senderId: 'ou-1', senderUnionId: 'on-1',
      senderType: 'user', messageType: 'text', text: 'hello', mentions: [], isBotMentioned: false, content: {}, rawEvent: {}, senderName: '张三',
    },
  } as FeishuPendingBindingMessage & { createdAt: string };
}

function setup(options: { pending?: FeishuPendingBindingMessage & { createdAt: string } | null; existingOwner?: number | null; replayFails?: boolean; disabled?: boolean } = {}) {
  const pendingRow = options.pending === undefined ? row() : options.pending;
  const pending = {
    findByState: vi.fn(async () => pendingRow),
    claim: vi.fn(async () => pendingRow == null ? null : { ...pendingRow, status: 'CLAIMED' }),
    complete: vi.fn(async () => undefined),
    markReplayed: vi.fn(async () => undefined),
    release: vi.fn(async () => undefined),
    failClaimed: vi.fn(async () => undefined),
  };
  const repository = {
    getStatus: vi.fn(async () => ({ bound: false })),
    findUserIdByUnionId: vi.fn(async () => options.existingOwner ?? null),
    bind: vi.fn(async () => undefined),
  };
  const replay = vi.fn(async () => {
    if (options.replayFails) throw new Error('replay failed');
  });
  const notifyMismatch = vi.fn(async () => undefined);
  const app = Fastify();
  app.setErrorHandler(handleError);
  const deps: FeishuBindingRouteDeps = {
    jwt: { validateAccessToken: (token: string) => token === TOKEN, getUserIdFromToken: () => USER_ID } as never,
    repository: repository as never,
    pending: pending as never,
    currentUser: vi.fn(async (id: number) => ({ id, username: 'bob', disabled: options.disabled === true })),
    replayPending: replay,
    notifyMismatch,
  };
  registerFeishuPendingBindingRoutes(app, deps);
  return { app, pending, repository, replay, notifyMismatch, auth: { authorization: `Bearer ${TOKEN}` } };
}

describe('飞书密码绑定路由', () => {
  it('预览返回发送者、当前账号和有效期', async () => {
    const { app, auth } = setup();
    const response = await app.inject({ method: 'GET', url: '/v1/feishu/binding/pending?state=st-1', headers: auth });
    expect(response.statusCode).toBe(200);
    expect(response.json().data).toMatchObject({ senderName: '张三', chatType: 'p2p', willRebind: false, currentUser: { username: 'bob' } });
    expect(response.json().data.expiresAt).toBeTruthy();
  });

  it('密码接口拒绝 OAuth pending，避免绕过原登录校验', async () => {
    const { app, auth } = setup({ pending: { ...row(), bindingMethod: 'OAUTH' } });
    const preview = await app.inject({ method: 'GET', url: '/v1/feishu/binding/pending?state=st-1', headers: auth });
    expect(preview.json().code).not.toBe(0);
    const complete = await app.inject({ method: 'POST', url: '/v1/feishu/binding/complete', payload: { state: 'st-1' }, headers: auth });
    expect(complete.json().data.status).toBe('failed');
  });
  it('拒绝过期或不存在的 state，并且未登录返回 401', async () => {
    const stale = setup({ pending: row(sqlLocal(Date.now() - 16 * 60_000)) });
    const expired = await stale.app.inject({ method: 'GET', url: '/v1/feishu/binding/pending?state=st-1', headers: stale.auth });
    expect(expired.json().code).not.toBe(0);
    expect(stale.pending.claim).not.toHaveBeenCalled();
    const unauthenticated = await stale.app.inject({ method: 'POST', url: '/v1/feishu/binding/complete', payload: { state: 'st-1' } });
    expect(unauthenticated.statusCode).toBe(401);
  });

  it('完成绑定、补投并消费 state', async () => {
    const { app, auth, repository, pending } = setup();
    const response = await app.inject({ method: 'POST', url: '/v1/feishu/binding/complete', payload: { state: 'st-1' }, headers: auth });
    expect(response.json().data).toEqual({ status: 'success', message: '绑定成功，已开始处理你刚才的消息', senderName: '张三' });
    expect(repository.bind).toHaveBeenCalledWith(USER_ID, 'on-1');
    expect(pending.complete).toHaveBeenCalledWith('st-1');
  });

  it('身份冲突不绑定、不补投并作废 claim', async () => {
    const { app, auth, repository, replay, pending, notifyMismatch } = setup({ existingOwner: 3 });
    const response = await app.inject({ method: 'POST', url: '/v1/feishu/binding/complete', payload: { state: 'st-1' }, headers: auth });
    expect(response.json().data).toMatchObject({ status: 'failed' });
    expect(response.json().data.message).toContain('已绑定其它 Mao 账号');
    expect(repository.bind).not.toHaveBeenCalled();
    expect(replay).not.toHaveBeenCalled();
    expect(pending.failClaimed).toHaveBeenCalledWith('st-1');
    expect(notifyMismatch).toHaveBeenCalledOnce();
  });

  it('补投失败返回 partial 并释放 state', async () => {
    const { app, auth, pending } = setup({ replayFails: true });
    const response = await app.inject({ method: 'POST', url: '/v1/feishu/binding/complete', payload: { state: 'st-1' }, headers: auth });
    expect(response.json().data.status).toBe('partial');
    expect(pending.release).toHaveBeenCalledWith('st-1');
  });
});

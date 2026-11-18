import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import { BusinessException } from '../common/business-exception.js';
import { JwtService } from '../crypto/jwt.service.js';
import {
  FEISHU_FAILED,
  FEISHU_PENDING,
  FEISHU_SUCCESS,
  FeishuAuthService,
  type FeishuHttp,
  type FeishuOauthStateRepository,
} from './feishu-auth.service.js';
import { FEISHU_AUTHORIZE_URL } from '../settings/settings-test.service.js';
import type { UserRepository, UserRoleRepository } from '../user/types.js';

const jwt = new JwtService('mao-dev-jwt-secret-change-me-32bytes!!', 86400000, 604800000, 7200000);

function cfg(overrides: Record<string, unknown> = {}) {
  return async () => ({
    enabled: true,
    appId: 'app-id',
    appSecret: 'secret',
    redirectUri: 'http://localhost:9080/api/v1/auth/feishu/callback',
    ...overrides,
  }) as never;
}

function makeService(http?: FeishuHttp, onUserAuthenticated?: ConstructorParameters<typeof FeishuAuthService>[6]) {
  const userRepo = {
    insert: vi.fn(async (u: { id?: number }) => { u.id = 8; return 8; }),
    updateById: vi.fn(),
    findById: vi.fn(),
    findByUsername: vi.fn(async () => null),
    findByEmail: vi.fn(async () => null),
    findByFeishuUserId: vi.fn(async () => null),
  };
  const userRoleRepo = { insert: vi.fn() };
  const stateRepo = {
    insert: vi.fn(),
    findByState: vi.fn(),
    updateByState: vi.fn(async () => 1),
    consumeSuccess: vi.fn(async () => 1),
    claimPending: vi.fn(async () => 1),
  };
  const service = new FeishuAuthService(
    userRepo as unknown as UserRepository,
    userRoleRepo as unknown as UserRoleRepository,
    stateRepo as unknown as FeishuOauthStateRepository,
    jwt,
    cfg(),
    http ?? { postJson: vi.fn(), getJson: vi.fn() },
    onUserAuthenticated,
  );
  return { service, userRepo, userRoleRepo, stateRepo };
}

describe('FeishuAuthService', () => {
  it('qrcodeRejectsUnconfiguredApp', async () => {
    const { userRepo, userRoleRepo, stateRepo } = makeService();
    const service = new FeishuAuthService(
      userRepo as never, userRoleRepo as never, stateRepo as never, jwt, cfg({ appId: '' }),
    );
    await expect(service.getQrCodeUrl()).rejects.toBeInstanceOf(BusinessException);
  });

  it('qrcodeRejectsDisabledLogin', async () => {
    const { userRepo, userRoleRepo, stateRepo } = makeService();
    const service = new FeishuAuthService(
      userRepo as never, userRoleRepo as never, stateRepo as never, jwt, cfg({ enabled: false }),
    );
    await expect(service.getQrCodeUrl()).rejects.toBeInstanceOf(BusinessException);
  });

  it('qrcodeCreatesStateAndReturnsAuthorizeUrl', async () => {
    const { service, stateRepo } = makeService();
    const vo = await service.getQrCodeUrl();
    expect(stateRepo.insert).toHaveBeenCalled();
    expect(vo.authUrl).toContain(FEISHU_AUTHORIZE_URL);
    expect(vo.state).toBeTruthy();
    expect(vo.expiresIn).toBe(300);
  });

  it('isEnabledRequiresRealAppId', async () => {
    const { service } = makeService();
    expect(await service.isEnabled()).toBe(true);
  });

  it('isBindingOnlyStateWhenUserIdPresent', async () => {
    const { service, stateRepo } = makeService();
    stateRepo.findByState = vi.fn(async () => ({
      state: 's1', status: FEISHU_PENDING, userId: 9, expiresAt: '2099-01-01 00:00:00',
    }));
    expect(await service.isBindingOnlyState('s1')).toBe(true);
    expect(await service.isBindingOnlyState('')).toBe(false);
    stateRepo.findByState = vi.fn(async () => ({
      state: 's2', status: FEISHU_PENDING, userId: null, expiresAt: '2099-01-01 00:00:00',
    }));
    expect(await service.isBindingOnlyState('s2')).toBe(false);
  });

  it('completeStateWithCodeCreatesUserAndPollReturnsLogin', async () => {
    const http: FeishuHttp = {
      postJson: vi.fn(async (url: string) => {
        if (url.includes('app_access_token')) return { ok: true, json: { code: 0, app_access_token: 'app' } };
        return { ok: true, json: { code: 0, data: { access_token: 'user' } } };
      }),
      getJson: vi.fn(async () => ({
        ok: true,
        json: { code: 0, data: { name: 'Li', email: 'li@example.com', user_id: 'fu-1', avatar_url: 'http://a' } },
      })),
    };
    const { service, stateRepo, userRepo } = makeService(http);
    vi.mocked(stateRepo.findByState).mockResolvedValue({
      state: 'st', status: FEISHU_PENDING, expiresAt: '2099-01-01 00:00:00',
    });
    await service.completeStateWithCode('st', 'code-1');
    expect(userRepo.insert).toHaveBeenCalled();
    expect(stateRepo.updateByState).toHaveBeenCalled();

    vi.mocked(stateRepo.findByState).mockResolvedValue({
      state: 'st', status: FEISHU_SUCCESS, userId: 8, expiresAt: '2099-01-01 00:00:00',
    });
    vi.mocked(userRepo.findById).mockResolvedValue({
      id: 8, username: 'li', displayName: 'Li', email: 'li@example.com', feishuUserId: 'fu-1', status: 1,
    });
    const status = await service.getLoginStatus('st');
    expect(status.status).toBe(FEISHU_SUCCESS);
    expect((status as { login?: { accessToken: string } }).login?.accessToken).toBeTruthy();
  });

  it('getLoginStatusHandlesMissingExpiredAndDisabled', async () => {
    const { service, stateRepo } = makeService();
    expect((await service.getLoginStatus(''))).toMatchObject({ status: FEISHU_FAILED });
    vi.mocked(stateRepo.findByState).mockResolvedValue(null);
    expect((await service.getLoginStatus('x'))).toMatchObject({ status: FEISHU_FAILED });
    vi.mocked(stateRepo.findByState).mockResolvedValue({
      state: 'x', status: FEISHU_PENDING, expiresAt: '2000-01-01 00:00:00',
    });
    const expired = await service.getLoginStatus('x');
    expect(expired.status).toBe('EXPIRED');
  });

  it('renderCallbackPageReturnsHtml', async () => {
    const { service, stateRepo } = makeService();
    vi.mocked(stateRepo.findByState).mockResolvedValue(null);
    const html = await service.renderCallbackPage('missing', 'code');
    expect(html).toContain('登录失败');
    expect(html).toContain('飞书登录二维码不存在');
    expect(html).not.toContain('window.close');
    expect(html).not.toContain('<script>');
  });

  it.each([undefined, 9])('renderCallbackPageClosesOnlyAfterAuthenticationHookCompletes (target=%s)', async (targetUserId) => {
    let finishAuthentication!: () => void;
    const onUserAuthenticated = vi.fn(() => new Promise<void>((resolve) => { finishAuthentication = resolve; }));
    const { service, stateRepo } = makeService(undefined, onUserAuthenticated);
    const user = { id: 8, username: 'li', status: 1 };
    vi.spyOn(service, 'completeStateWithCode').mockResolvedValue(user);
    vi.mocked(stateRepo.findByState).mockResolvedValue({
      state: 'st', status: FEISHU_SUCCESS, userId: targetUserId ?? user.id, expiresAt: '2099-01-01 00:00:00',
    });

    let rendered = false;
    const page = service.renderCallbackPage('st', 'code').then((html) => {
      rendered = true;
      return html;
    });
    await vi.waitFor(() => expect(onUserAuthenticated).toHaveBeenCalledWith(user, targetUserId, 'st'));
    expect(rendered).toBe(false);
    finishAuthentication();

    const html = await page;
    expect(html).toContain('登录成功');
    expect(html).toContain('飞书授权已完成，请回到 Mao 客户端。');
    const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
    expect(script).toContain('window.close()');
    const close = vi.fn();
    runInNewContext(script!, { window: { close } });
    expect(close).toHaveBeenCalledTimes(1);
    // 非弹窗或受限浏览器拒绝关闭时不抛错，HTML 仍保留可读提示。
    expect(() => runInNewContext(script!, { window: { close: () => { throw new Error('blocked'); } } })).not.toThrow();
  });

  it('renderCallbackPageEscapesFailureMessageWithoutClosing', async () => {
    const { service } = makeService();
    const message = '<script>window.close()</script> & "授权失败" \'重试\'';
    vi.spyOn(service, 'completeStateWithCode').mockRejectedValue(new BusinessException(5002, message));

    const html = await service.renderCallbackPage('st', 'code');
    expect(html).toContain('登录失败');
    expect(html).toContain('&lt;script&gt;window.close()&lt;/script&gt; &amp; &quot;授权失败&quot; &#39;重试&#39;');
    expect(html).not.toContain('<script>');
    expect(html).not.toContain(message);
  });

  it('renderCallbackPageDoesNotCloseOrLeakDetailsWhenAuthenticationHookFails', async () => {
    const { service } = makeService(undefined, async () => { throw new Error('secret hook failure'); });
    vi.spyOn(service, 'completeStateWithCode').mockResolvedValue({ id: 8, username: 'li', status: 1 });

    const html = await service.renderCallbackPage('st', 'code');
    expect(html).toContain('登录失败');
    expect(html).toContain('飞书登录失败');
    expect(html).not.toContain('secret hook failure');
    expect(html).not.toContain('window.close');
    expect(html).not.toContain('<script>');
  });
});

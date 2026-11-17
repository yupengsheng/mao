import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { handleError } from '../common/http-error.js';
import { ErrorCode } from '../common/error-code.js';
import { BusinessException } from '../common/business-exception.js';
import { registerSystemGitCredentialRoutes, type SystemGitCredentialRouteDeps } from './system-git-credential.routes.js';

function appOf(permissions: Record<string, boolean> = {}) {
  const system = {
    list: vi.fn(async () => [{ id: 1, domain: 'git.example.com', accessToken: 'cipher', description: null }]),
    create: vi.fn(async (domain: string, token: string) => ({ id: 2, domain, accessToken: `cipher(${token})`, description: null })),
    update: vi.fn(async (id: number) => ({ id, domain: 'git.example.com', accessToken: 'cipher', description: null })),
    delete: vi.fn(async () => undefined),
    listDomains: vi.fn(async () => ['git.example.com', 'defaults.com']),
  };
  const deps: SystemGitCredentialRouteDeps = {
    systemGitCredentialService: system as never,
    gitCredentialService: { listAllDomains: vi.fn(async () => ['git.example.com', 'user.com']) },
    permissionService: { hasPermission: vi.fn(async (_id, code) => permissions[code] ?? true) },
  };
  const app = Fastify();
  app.setErrorHandler(handleError);
  app.addHook('preHandler', (request, _reply, done) => {
    (request as unknown as { userId: number }).userId = 7;
    done();
  });
  registerSystemGitCredentialRoutes(app, deps);
  return { app, system, deps };
}

describe('system Git credential routes', () => {
  it('管理列表只返回掩码，写操作受 settings 权限保护', async () => {
    const denied = appOf({ 'settings:read': false, 'settings:write': false });
    expect((await denied.app.inject({ method: 'GET', url: '/v1/admin/git-default-credentials' })).statusCode).toBe(403);
    expect((await denied.app.inject({ method: 'POST', url: '/v1/admin/git-default-credentials', payload: { domain: 'a.com', accessToken: 'plain-token' } })).statusCode).toBe(403);
    await denied.app.close();

    const ok = appOf();
    const response = await ok.app.inject({ method: 'GET', url: '/v1/admin/git-default-credentials' });
    expect(response.statusCode).toBe(200);
    expect(response.json().data[0].accessToken).toBe('****');
    await ok.app.close();
  });

  it('域清单合并去重排序且不含 token，用户端默认接口不含 token 字段', async () => {
    const { app, deps } = appOf();
    const domains = await app.inject({ method: 'GET', url: '/v1/admin/git-domains' });
    expect(domains.json().data.domains).toEqual(['defaults.com', 'git.example.com', 'user.com']);
    expect(JSON.stringify(domains.json().data)).not.toContain('token');
    const defaults = await app.inject({ method: 'GET', url: '/v1/user/git-default-credentials' });
    expect(defaults.statusCode).toBe(200);
    expect(defaults.json().data[0]).not.toHaveProperty('accessToken');
    expect(deps.permissionService.hasPermission).toHaveBeenCalledWith(7, 'agent:read');
    await app.close();
  });

  it('业务错误码透传且写入参数不回显明文', async () => {
    const { app, system } = appOf();
    system.create.mockRejectedValueOnce(new BusinessException(ErrorCode.GIT_CREDENTIAL_DOMAIN_DUPLICATE));
    const response = await app.inject({ method: 'POST', url: '/v1/admin/git-default-credentials', payload: { domain: 'a.com', accessToken: 'plain-token' } });
    expect(response.json().code).toBe(ErrorCode.GIT_CREDENTIAL_DOMAIN_DUPLICATE.code);
    expect(response.json()).not.toHaveProperty('data.accessToken', 'plain-token');
    await app.close();
  });
});

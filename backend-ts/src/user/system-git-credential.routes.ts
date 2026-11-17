import type { FastifyInstance } from 'fastify';
import { requirePermission, requireUserId, sendOk } from '../common/http-error.js';
import { bodyOf, pathId } from '../common/request.js';
import type { GitCredentialService } from './git-credential.service.js';
import type { SystemGitCredential, SystemGitCredentialService } from './system-git-credential.service.js';

export interface SystemGitCredentialRouteDeps {
  systemGitCredentialService: SystemGitCredentialService;
  /** 用户凭据域来源只返回 DISTINCT domain，不解密。 */
  gitCredentialService: Pick<GitCredentialService, 'listAllDomains'>;
  permissionService: { hasPermission(userId: number, code: string): Promise<boolean> };
}

/** 系统默认 Git 凭据管理与用户侧域清单接口。 */
export function registerSystemGitCredentialRoutes(app: FastifyInstance, deps: SystemGitCredentialRouteDeps): void {
  const { systemGitCredentialService, gitCredentialService, permissionService } = deps;

  app.get('/v1/admin/git-default-credentials', async (request, reply) => {
    const adminId = requireUserId(request);
    await requirePermission(permissionService, adminId, 'settings:read');
    const list = await systemGitCredentialService.list();
    return sendOk(reply, list.map(toVO));
  });

  app.post('/v1/admin/git-default-credentials', async (request, reply) => {
    const adminId = requireUserId(request);
    await requirePermission(permissionService, adminId, 'settings:write');
    const body = bodyOf<{ domain?: string; accessToken?: string; description?: string }>(request);
    const created = await systemGitCredentialService.create(body.domain ?? '', body.accessToken ?? '', body.description);
    return sendOk(reply, toVO(created));
  });

  app.put('/v1/admin/git-default-credentials/:id', async (request, reply) => {
    const adminId = requireUserId(request);
    await requirePermission(permissionService, adminId, 'settings:write');
    const body = bodyOf<{ accessToken?: string; description?: string }>(request);
    const updated = await systemGitCredentialService.update(pathId(request), body.accessToken, body.description);
    return sendOk(reply, toVO(updated));
  });

  app.delete('/v1/admin/git-default-credentials/:id', async (request, reply) => {
    const adminId = requireUserId(request);
    await requirePermission(permissionService, adminId, 'settings:write');
    await systemGitCredentialService.delete(pathId(request));
    return sendOk(reply);
  });

  /** 用户凭据域 ∪ 系统默认域，仅回域名，供 Agent 白名单候选。 */
  app.get('/v1/admin/git-domains', async (request, reply) => {
    const adminId = requireUserId(request);
    await requirePermission(permissionService, adminId, 'agent:read');
    const [userDomains, systemDomains] = await Promise.all([
      gitCredentialService.listAllDomains(),
      systemGitCredentialService.listDomains(),
    ]);
    const domains = [...new Set([...userDomains, ...systemDomains])].sort((a, b) => a.localeCompare(b));
    return sendOk(reply, { domains });
  });

  /** 用户端仅展示系统默认域与备注，绝不包含 token 字段。 */
  app.get('/v1/user/git-default-credentials', async (request, reply) => {
    requireUserId(request);
    const list = await systemGitCredentialService.list();
    return sendOk(reply, list.map((item) => ({ domain: item.domain, description: item.description ?? null })));
  });
}

function toVO(credential: SystemGitCredential) {
  return {
    id: credential.id,
    domain: credential.domain,
    accessToken: '****',
    description: credential.description,
    createdAt: credential.createdAt != null ? String(credential.createdAt).replace(' ', 'T') : null,
    updatedAt: credential.updatedAt != null ? String(credential.updatedAt).replace(' ', 'T') : null,
  };
}

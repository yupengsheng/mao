import { describe, expect, it, vi } from 'vitest';
import { BusinessException } from '../common/business-exception.js';
import { ErrorCode } from '../common/error-code.js';
import { decryptAesCbc } from '../crypto/aes-cbc.js';
import type { Db } from '../db/db.js';
import { SystemGitCredentialService } from './system-git-credential.service.js';

function mockDb(queryResult: unknown[] = [], queryOneResult: unknown = null) {
  return {
    query: vi.fn(async () => queryResult),
    queryOne: vi.fn(async () => queryOneResult),
    execute: vi.fn(async () => ({ affectedRows: 1 })),
    insert: vi.fn(async () => 42),
    updateById: vi.fn(async () => ({ affectedRows: 1 })),
  } as unknown as Db;
}

const SECRET = 'unit-test-secret';
const codeOf = (fn: () => Promise<unknown>) => fn().then(() => 0, (error) => error instanceof BusinessException ? error.code : -1);

describe('SystemGitCredentialService', () => {
  it('规范化域名、加密 token 并保存备注', async () => {
    const db = mockDb();
    const service = new SystemGitCredentialService(db, SECRET);
    const created = await service.create('https://Git.Acg.Team/path', ' tok-acg ', ' 只读 Token ');
    expect(created.domain).toBe('git.acg.team');
    expect(created.description).toBe('只读 Token');
    expect(decryptAesCbc(created.accessToken, SECRET)).toBe('tok-acg');
    expect(created.accessToken).not.toContain('tok-acg');
  });

  it('拒绝空 token、非法域名和重复域名', async () => {
    const duplicateDb = mockDb([], { id: 1, domain: 'git.acg.team', accessToken: 'cipher' });
    const duplicateService = new SystemGitCredentialService(duplicateDb, SECRET);
    expect(await codeOf(() => duplicateService.create('git.acg.team', ''))).toBe(ErrorCode.PARAM_INVALID.code);
    expect(await codeOf(() => duplicateService.create('git.acg.team', 'token'))).toBe(ErrorCode.GIT_CREDENTIAL_DOMAIN_DUPLICATE.code);
    expect(await codeOf(() => new SystemGitCredentialService(mockDb(), SECRET).create('not a domain', 'token'))).toBe(ErrorCode.PARAM_INVALID.code);
  });

  it('更新时留空 token 保留密钥，空备注显式清除', async () => {
    const db = mockDb([], { id: 9, domain: 'git.acg.team', accessToken: 'old-cipher', description: '旧备注' });
    const service = new SystemGitCredentialService(db, SECRET);
    await service.update(9, '', undefined);
    expect(db.updateById).toHaveBeenLastCalledWith('system_git_credential', 9, { accessToken: 'old-cipher', description: '旧备注' });
    await service.update(9, 'new-token', '');
    const data = (db.updateById as ReturnType<typeof vi.fn>).mock.calls.at(-1)![2];
    expect(data.accessToken).not.toContain('new-token');
    expect(data.description).toBeNull();
  });

  it('白名单查询空数组短路，解密失败只跳过坏行', async () => {
    const db = mockDb([{ domain: 'good.com', accessToken: 'bad-cipher' }]);
    const service = new SystemGitCredentialService(db, SECRET);
    expect(await service.getTokenMapFiltered([])).toEqual(new Map());
    expect(db.query).not.toHaveBeenCalled();
    expect(await service.getTokenMap()).toEqual(new Map());
  });

  it('不存在的凭据不能更新或删除', async () => {
    const service = new SystemGitCredentialService(mockDb(), SECRET);
    expect(await codeOf(() => service.update(1, 'token'))).toBe(ErrorCode.GIT_CREDENTIAL_NOT_FOUND.code);
    expect(await codeOf(() => service.delete(1))).toBe(ErrorCode.GIT_CREDENTIAL_NOT_FOUND.code);
  });
});

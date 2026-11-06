import { describe, expect, it, vi } from 'vitest';
import { BusinessException } from '../common/business-exception.js';
import { JwtService } from '../crypto/jwt.service.js';
import { AuthService } from './auth.service.js';
import type { LdapAuthService } from './ldap-auth.service.js';
import type { PasswordHasher, User, UserRepository } from '../user/types.js';

function user(id: number, username: string, hash: string | null, status: number): User {
  return { id, username, passwordHash: hash, status };
}

describe('AuthService', () => {
  const userRepo: UserRepository = {
    findById: vi.fn(),
    findByUsername: vi.fn(),
    countByUsername: vi.fn(),
    countByEmailExcept: vi.fn(),
    insert: vi.fn(),
    updateById: vi.fn(),
    updateFields: vi.fn(),
    selectPage: vi.fn(),
  };
  const jwtService = {
    generateToken: vi.fn(() => 'access'),
    generateRefreshToken: vi.fn(() => 'refresh'),
    validateToken: vi.fn(),
    getTokenType: vi.fn(() => 'refresh'),
    getUserIdFromToken: vi.fn(),
    getUsernameFromToken: vi.fn(),
  } as unknown as JwtService;
  const hasher: PasswordHasher = {
    hash: vi.fn(),
    matches: vi.fn(),
  };
  const ldap = {
    isConfigured: vi.fn(async () => false),
    authenticate: vi.fn(),
  } as unknown as LdapAuthService;
  const service = new AuthService(userRepo, jwtService, hasher, ldap);

  it('loginWithLocalPasswordUpdatesLastLoginAndReturnsTokens', async () => {
    const u = user(1, 'alice', 'hash', 1);
    vi.mocked(userRepo.findByUsername).mockResolvedValue(u);
    vi.mocked(hasher.matches).mockResolvedValue(true);
    const vo = await service.login('alice', 'secret');
    expect(vo.accessToken).toBe('access');
    expect(vo.refreshToken).toBe('refresh');
    expect(vo.expiresIn).toBe(86400);
    expect(vo.user.username).toBe('alice');
    expect(u.lastLoginAt).toBeTruthy();
    expect(userRepo.updateById).toHaveBeenCalledWith(u);
  });

  it('loginRejectsDisabledAccountAndFallsBackToLdap', async () => {
    const disabled = user(2, 'disabled', 'hash', 0);
    vi.mocked(userRepo.findByUsername).mockResolvedValue(disabled);
    vi.mocked(hasher.matches).mockResolvedValue(true);
    await expect(service.login('disabled', 'secret')).rejects.toBeInstanceOf(BusinessException);

    vi.mocked(userRepo.findByUsername).mockResolvedValue(null);
    vi.mocked(ldap.isConfigured).mockResolvedValue(true);
    vi.mocked(ldap.authenticate).mockResolvedValue({ accessToken: 'ldap-access', refreshToken: 'r', expiresIn: 1, user: { username: 'ldap' } });
    expect((await service.login('ldap', 'secret')).accessToken).toBe('ldap-access');

    vi.mocked(ldap.authenticate).mockRejectedValue(new Error('bad'));
    await expect(service.login('ldap', 'bad')).rejects.toBeInstanceOf(BusinessException);
  });

  it('refreshTokenValidatesAndReturnsNewTokens', async () => {
    const u = user(3, 'bob', 'hash', 1);
    vi.mocked(jwtService.validateToken).mockReturnValue(true);
    vi.mocked(jwtService.getUserIdFromToken).mockReturnValue(3);
    vi.mocked(jwtService.getUsernameFromToken).mockReturnValue('bob');
    vi.mocked(userRepo.findById).mockResolvedValue(u);
    vi.mocked(jwtService.generateToken).mockReturnValue('new-access');
    vi.mocked(jwtService.generateRefreshToken).mockReturnValue('new-refresh');
    const vo = await service.refreshToken('refresh');
    expect(vo.accessToken).toBe('new-access');
    expect(vo.refreshToken).toBe('new-refresh');
  });

  it('logout is a no-op', () => {
    service.logout();
  });

  it('passwordLoginSwitchOffRejectsLocalAndLdapWithoutTouchingCredentials', async () => {
    const repo = {
      findByUsername: vi.fn(async () => user(9, 'alice', 'hash', 1)),
      updateById: vi.fn(),
    } as unknown as UserRepository;
    const ldapSvc = {
      isConfigured: vi.fn(async () => true),
      authenticate: vi.fn(),
    } as unknown as LdapAuthService;
    const switchedOff = new AuthService(repo, jwtService, hasher, ldapSvc, undefined, async () => false);

    await expect(switchedOff.login('alice', 'secret')).rejects.toThrow('账号密码登录已关闭');
    expect(repo.findByUsername).not.toHaveBeenCalled();
    expect(ldapSvc.authenticate).not.toHaveBeenCalled();
  });

  it('ignorePasswordSwitchKeepsAdminLoginWorkingWhenSwitchIsOff', async () => {
    const u = user(10, 'admin', 'hash', 1);
    const repo = {
      findByUsername: vi.fn(async () => u),
      updateById: vi.fn(),
    } as unknown as UserRepository;
    vi.mocked(hasher.matches).mockResolvedValue(true);
    const switchedOff = new AuthService(repo, jwtService, hasher, null, undefined, async () => false);

    const vo = await switchedOff.login('admin', 'secret', { ignorePasswordSwitch: true });
    expect(vo.user.username).toBe('admin');
  });

  it('passwordLoginEnabledUsesInjectedProviderAndDefaultsToOn', async () => {
    await expect(service.passwordLoginEnabled()).resolves.toBe(true);
    const switchedOff = new AuthService(userRepo, jwtService, hasher, null, undefined, async () => false);
    await expect(switchedOff.passwordLoginEnabled()).resolves.toBe(false);
  });
});

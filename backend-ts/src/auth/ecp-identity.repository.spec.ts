import { describe, expect, it, vi } from 'vitest';
import type { Db } from '../db/db.js';
import type { UserRepository } from '../user/types.js';
import { JwtService } from '../crypto/jwt.service.js';
import { EcpAuthService } from './ecp-auth.service.js';
import { EcpClient, type EcpHttpClient } from './ecp.client.js';
import { defaultEcpConfig } from './ecp.config.js';
import { ECP_PENDING, ECP_SUCCESS, type EcpOauthStateRepository } from './ecp-oauth.repository.js';
import { EcpIdentityRepository } from './ecp-identity.repository.js';

const identity = { email: 'Synthetic@example.test', displayName: 'Test', avatarUrl: 'https://ecp.example.com/a.png' };
const user = { id: 4, username: 'test', email: identity.email, status: 1, deleted: 0, avatarUrl: '/uploads/own.png' };

function setup(options: { binding?: boolean; matches?: readonly object[]; emailBinding?: boolean; failInsert?: boolean } = {}) {
  const existingUser = { ...user };
  const tx = {
    queryOne: vi.fn(async (sql: string) => {
      if (sql.includes('user_identity_write_lock')) return { id: 1 };
      if (sql.includes('username =')) return null;
      if (sql.includes('SELECT id, subject FROM user_external_identity')) {
        return options.emailBinding ? { id: 9, subject: identity.email } : null;
      }
      if (sql.includes('subject =')) return options.binding ? { userId: 4 } : null;
      if (sql.includes('`user` WHERE id')) return existingUser;
      if (sql.includes('SELECT provider FROM user_external_identity')) return { provider: 'ecp' };
      if (sql.includes('FROM role')) return { id: 2 };
      throw new Error(`Unexpected test query: ${sql}`);
    }),
    query: vi.fn().mockResolvedValue(options.matches?.map((match) => ({ ...match })) ?? []),
    insert: vi.fn(async (table: string, _fields: Record<string, unknown>) => {
      if (options.failInsert && table === 'user_external_identity') throw new Error('synthetic write failure');
      return 4;
    }),
    updateById: vi.fn(),
  };
  let committed = false;
  let rolledBack = false;
  const db = { transaction: vi.fn(async (fn: (db: Db) => Promise<unknown>) => {
    try { const result = await fn(tx as unknown as Db); committed = true; return result; }
    catch (error) { rolledBack = true; throw error; }
  }) };
  return { repo: new EcpIdentityRepository(db as unknown as Db), tx, state: () => ({ committed, rolledBack }) };
}

describe('EcpIdentityRepository avatar provisioning', () => {
  it.each(['https://ecp.example.com/a.png', 'http://ecp.example.com/a.png', '/uploads/avatar.png', `https://a/${'x'.repeat(502)}`])('writes valid avatar %s only on first provisioning', async (avatarUrl) => {
    const { repo, tx, state } = setup();
    const result = await repo.resolve({ ...identity, avatarUrl });
    expect(result).toMatchObject({ action: 'created', user: { avatarUrl, externalProvider: 'ecp' } });
    expect(tx.insert).toHaveBeenCalledWith('user', expect.objectContaining({ username: 'synthetic', avatarUrl }));
    expect(tx.insert.mock.calls.map(([table]) => table)).toEqual(['user', 'user_role', 'user_external_identity']);
    expect(state()).toEqual({ committed: true, rolledBack: false });
  });

  it('trims surrounding whitespace according to the existing profile rules', async () => {
    const { repo, tx } = setup();
    await repo.resolve({ ...identity, avatarUrl: `  ${identity.avatarUrl}\n` });
    expect(tx.insert).toHaveBeenCalledWith('user', expect.objectContaining({ avatarUrl: identity.avatarUrl }));
  });

  it.each([undefined, null, '', '  ', 'javascript:alert(1)', 'data:image/png;base64,abc', 'https://a/b c', `https://a/${'x'.repeat(503)}`, 42, {}])('ignores absent or invalid avatar %j without failing login', async (avatarUrl) => {
    const { repo, tx } = setup();
    // Exercise runtime boundary values even though the public optional field is typed as a string.
    const input = { ...identity, avatarUrl } as Parameters<EcpIdentityRepository['resolve']>[0];
    expect((await repo.resolve(input)).action).toBe('created');
    const fields = tx.insert.mock.calls.find(([table]) => table === 'user')![1];
    expect(fields).not.toHaveProperty('avatarUrl');
  });

  it.each([
    [{ matches: [user] }, 'bound'],
    [{ matches: [user], emailBinding: true }, 'existing'],
    [{ binding: true }, 'existing'],
  ] as const)('does not overwrite an existing avatar for %j', async (options, action) => {
    const { repo, tx } = setup(options);
    expect(await repo.resolve(identity)).toMatchObject({ action, user: { avatarUrl: user.avatarUrl, externalProvider: 'ecp' } });
    expect(tx.insert).not.toHaveBeenCalledWith('user', expect.anything());
    expect(tx.updateById).not.toHaveBeenCalled();
    expect(user).not.toHaveProperty('externalProvider');
  });

  it('rolls back provisioning if identity binding fails', async () => {
    const { repo, state } = setup({ failInsert: true });
    await expect(repo.resolve(identity)).rejects.toThrow('synthetic write failure');
    expect(state()).toEqual({ committed: false, rolledBack: true });
  });
});

describe('ECP avatar callback provisioning chain', () => {
  function callbackHarness(wireUser: Record<string, unknown>, options: Parameters<typeof setup>[0] = {}) {
    const harness = setup(options);
    // 只模拟 HTTP 与持久化边界：client 身份解析、auth service 透传和 repository 建号均执行真实逻辑。
    const request = vi.fn<EcpHttpClient['request']>().mockResolvedValue({
      status: 200,
      json: { code: 0, data: {
        sessionToken: 'tok-avatar', expiresAt: '2099-01-01T00:00:00Z', user: wireUser,
      } },
    });
    const config = { ...defaultEcpConfig(), enabled: true };
    const stateRepo: EcpOauthStateRepository = {
      insert: vi.fn(),
      findByState: vi.fn<EcpOauthStateRepository['findByState']>().mockResolvedValue({
        state: 'state-avatar', callbackTarget: 'desktop', status: ECP_PENDING, expiresAt: '2099-01-01 00:00:00',
      }),
      updateByState: vi.fn().mockResolvedValue(1),
      consumeSuccess: vi.fn(),
      claimPending: vi.fn().mockResolvedValue(1),
    };
    const sessions = { upsert: vi.fn(), encryptToken: vi.fn(() => 'enc-avatar') };
    const updateById = vi.fn<UserRepository['updateById']>().mockResolvedValue(undefined);
    const resolve = vi.spyOn(harness.repo, 'resolve');
    const service = new EcpAuthService(
      { updateById } as unknown as UserRepository,
      stateRepo,
      harness.repo,
      sessions as never,
      new JwtService('mao-dev-jwt-secret-change-me-32bytes!!', 86400000, 604800000, 7200000),
      { buildLoginResult: vi.fn() },
      async () => config,
      new EcpClient({ request }),
    );
    return { ...harness, service, request, resolve, updateById, stateRepo, sessions, config };
  }

  it('parses data.user.avatar, provisions avatarUrl and returns it in the login interface', async () => {
    const avatar = '/uploads/from-ecp.png';
    const h = callbackHarness({ email: identity.email, realName: identity.displayName, avatar: `  ${avatar}  ` });
    const login = await h.service.handleCallback('state-avatar', 'code-avatar');
    expect(h.request).toHaveBeenCalledWith('POST', `${h.config.baseUrl}/public/login/apps/${h.config.appCode}/sessions`, expect.objectContaining({
      body: expect.objectContaining({ loginMethod: 'FEISHU_CALLBACK', authorizationCode: 'code-avatar', state: 'state-avatar' }),
    }));
    expect(h.resolve).toHaveBeenCalledWith({ email: identity.email, displayName: identity.displayName, avatarUrl: avatar });
    expect(h.tx.insert).toHaveBeenCalledWith('user', expect.objectContaining({ avatarUrl: avatar }));
    expect(h.updateById).toHaveBeenCalledWith(expect.objectContaining({ id: 4, avatarUrl: avatar }));
    expect(login.user).toMatchObject({ id: 4, avatarUrl: avatar, authSource: 'ECP' });
    expect(login.user).not.toHaveProperty('avatar');
    expect(h.sessions.encryptToken).toHaveBeenCalledWith('tok-avatar');
    expect(h.sessions.upsert).toHaveBeenCalledWith(4, 'enc-avatar', new Date('2099-01-01T00:00:00Z'));
    expect(h.stateRepo.updateByState).toHaveBeenCalledWith('state-avatar', 'PROCESSING', expect.objectContaining({ status: ECP_SUCCESS, userId: 4 }));
    expect(h.state()).toEqual({ committed: true, rolledBack: false });
  });

  it.each([undefined, null, '', '   ', 'javascript:alert(1)', 'data:image/png;base64,abc', 'https://a/b c', `https://a/${'x'.repeat(503)}`, 42, {}, []])('ignores missing/invalid wire avatar %j throughout provisioning and login', async (avatar) => {
    const h = callbackHarness({ email: identity.email, realName: identity.displayName, ...(avatar === undefined ? {} : { avatar }) });
    const login = await h.service.handleCallback('state-avatar', 'code-avatar');
    expect(h.resolve).toHaveBeenCalledWith({ email: identity.email, displayName: identity.displayName });
    const fields = h.tx.insert.mock.calls.find(([table]) => table === 'user')![1];
    expect(fields).not.toHaveProperty('avatarUrl');
    expect(h.updateById).toHaveBeenCalledWith(expect.not.objectContaining({ avatarUrl: expect.anything() }));
    expect(login.user.avatarUrl).toBe('');
    expect(h.state().committed).toBe(true);
  });

  it.each([undefined, null])('does not backfill an existing account whose own avatar is %j', async (avatarUrl) => {
    const h = callbackHarness({ email: identity.email, avatar: '/uploads/new-from-ecp.png' }, { matches: [{ ...user, avatarUrl }] });
    const login = await h.service.handleCallback('state-avatar', 'code-avatar');
    expect(h.resolve).toHaveBeenCalledWith(expect.objectContaining({ avatarUrl: '/uploads/new-from-ecp.png' }));
    expect(h.tx.insert).not.toHaveBeenCalledWith('user', expect.anything());
    expect(h.updateById).toHaveBeenCalledWith(expect.objectContaining({ avatarUrl }));
    expect(login.user.avatarUrl).toBe('');
  });

  it.each([
    { matches: [user] },
    { matches: [user], emailBinding: true },
    { binding: true },
  ])('does not overwrite an existing avatar even when the actual response supplies a new one: %j', async (options) => {
    const h = callbackHarness({ email: identity.email, realName: identity.displayName, avatar: '/uploads/new-from-ecp.png' }, options);
    const login = await h.service.handleCallback('state-avatar', 'code-avatar');
    expect(h.resolve).toHaveBeenCalledWith(expect.objectContaining({ avatarUrl: '/uploads/new-from-ecp.png' }));
    expect(h.tx.insert).not.toHaveBeenCalledWith('user', expect.anything());
    expect(h.tx.updateById).not.toHaveBeenCalled();
    expect(h.updateById).toHaveBeenCalledWith(expect.objectContaining({ avatarUrl: user.avatarUrl }));
    expect(login.user.avatarUrl).toBe(user.avatarUrl);
  });
});

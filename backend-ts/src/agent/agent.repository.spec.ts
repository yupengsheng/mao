import { describe, expect, it, vi } from 'vitest';
import {
  MysqlAgentExperienceRepository,
  MysqlAgentRepository,
  MysqlAgentSuggestedQuestionRepository,
} from './agent.repository.js';
import { MysqlUserRepository } from '../user/user.repository.js';
import { MysqlLlmModelRepository } from '../model/model.repository.js';
import {
  MysqlPermissionRepository,
  MysqlRolePermissionRepository,
  MysqlRoleRepository,
  MysqlUserRoleRepository,
} from '../permission/permission.repository.js';

function mockDb(queryOne: unknown = { id: 1 }, query: unknown[] = [{ id: 1 }]) {
  return {
    transaction: vi.fn(async (fn: (db: unknown) => Promise<unknown>) => fn(mockDb(queryOne, query))),
    query: vi.fn(async () => query),
    queryOne: vi.fn(async () => queryOne),
    execute: vi.fn(async () => ({ affectedRows: 1, insertId: 1 })),
    insert: vi.fn(async () => 5),
    updateById: vi.fn(async () => undefined),
  };
}

describe('MysqlAgentRepository', () => {
  it('writes avatarUrl on insert and update including explicit clearing', async () => {
    const db = mockDb({ id: 5, name: 'A', systemPrompt: 'p' });
    db.transaction.mockImplementation(async (fn) => fn(db));
    const repo = new MysqlAgentRepository(db as never);
    const avatarUrl = '/uploads/12345678-1234-1234-1234-123456789abc.png';
    const agent = { id: 5, name: 'A', systemPrompt: 'p', avatarUrl };
    await repo.insert(agent);
    expect(db.insert).toHaveBeenCalledWith('agent', expect.objectContaining({ avatarUrl }));
    await repo.updateById(agent, 7, false);
    expect(db.updateById).toHaveBeenCalledWith('agent', 5, expect.objectContaining({ avatarUrl }));
    await repo.updateById({ ...agent, avatarUrl: null }, 7, false);
    expect(db.updateById).toHaveBeenLastCalledWith('agent', 5, expect.objectContaining({ avatarUrl: null }));
    // 客户端可见性：缺省按 1 落库，显式 0 必须原样写入（否则隐藏动作会被重置）
    expect(db.insert).toHaveBeenCalledWith('agent', expect.objectContaining({ clientVisible: 1 }));
    await repo.updateById({ ...agent, clientVisible: 0 }, 7, false);
    expect(db.updateById).toHaveBeenLastCalledWith('agent', 5, expect.objectContaining({ clientVisible: 0 }));
  });

  it('distinguishes missing rows from unconfigured git domains and keeps [] intact on write', async () => {
    const db = mockDb();
    db.transaction.mockImplementation(async (fn) => fn(db));
    const repo = new MysqlAgentRepository(db as never);

    // 行不存在 = Agent 丢失（故障）；软删的行也要能查到，SQL 不带 deleted = 0
    db.query.mockResolvedValueOnce([]);
    expect(await repo.selectGitAllowedDomainsById(9)).toBeNull();
    expect(String(db.query.mock.calls.at(-1)?.[0])).not.toContain('deleted = 0');

    // 行存在、值为 NULL = 未配置
    db.query.mockResolvedValueOnce([{ domains: null }]);
    expect(await repo.selectGitAllowedDomainsById(9)).toEqual({ domains: null });

    // '[]' 与白名单原样返回，不被折叠
    db.query.mockResolvedValueOnce([{ domains: '[]' }]);
    expect(await repo.selectGitAllowedDomainsById(9)).toEqual({ domains: '[]' });
    db.query.mockResolvedValueOnce([{ domains: '["git.acg.team"]' }]);
    expect(await repo.selectGitAllowedDomainsById(9)).toEqual({ domains: '["git.acg.team"]' });

    // 写入三态：'[]' 必须原样落库，否则无法表达「显式禁止」
    const writeAgent = { id: 5, name: 'A', systemPrompt: 'p', gitAllowedDomains: '[]' };
    await repo.insert(writeAgent);
    expect(db.insert).toHaveBeenCalledWith('agent', expect.objectContaining({ gitAllowedDomains: '[]' }));
    await repo.updateById(writeAgent, 7, false);
    expect(db.updateById).toHaveBeenCalledWith('agent', 5, expect.objectContaining({ gitAllowedDomains: '[]' }));
  });
  it('covers list find insert update delete and experiences', async () => {
    const db = mockDb();
    const repo = new MysqlAgentRepository(db as never);
    await repo.selectList();
    expect(db.query).toHaveBeenCalledWith(expect.stringContaining('enabled = 1'), []);
    await repo.selectList('coder');
    expect(db.query).toHaveBeenLastCalledWith(expect.stringContaining('enabled = 1'), ['%coder%']);
    await repo.selectList(null, true);
    expect(String(db.query.mock.calls.at(-1)?.[0])).not.toContain('enabled = 1');
    // 客户端新建会话：只取 client_visible = 1；不带该参数时不追加条件
    await repo.selectList(null, false, true);
    expect(db.query).toHaveBeenLastCalledWith(expect.stringContaining('client_visible = 1'), []);
    await repo.selectList(null, false, false);
    expect(String(db.query.mock.calls.at(-1)?.[0])).not.toContain('client_visible = 1');
    // 管理端「未配置」筛选：只取 git_allowed_domains IS NULL
    await repo.selectList(null, false, false, true);
    expect(db.query).toHaveBeenLastCalledWith(expect.stringContaining('git_allowed_domains IS NULL'), []);
    await repo.selectPage(2, 10, 'coder', true, false, false);
    expect(db.queryOne).toHaveBeenLastCalledWith(
      expect.stringContaining('enabled = ?'),
      [0, '%coder%'],
    );
    expect(db.query).toHaveBeenLastCalledWith(
      expect.stringContaining('LIMIT ? OFFSET ?'),
      [0, '%coder%', 10, 10],
    );
    await repo.selectPage(1, 20, null, true, false, undefined, true);
    expect(db.queryOne).toHaveBeenLastCalledWith(
      expect.stringContaining('git_allowed_domains IS NULL'), [],
    );
    await repo.selectPage(1, 20, null, true, false, undefined, false, 3);
    expect(db.queryOne).toHaveBeenLastCalledWith(
      expect.stringContaining('default_model_id = ?'), [3],
    );
    expect(db.query).toHaveBeenLastCalledWith(
      expect.stringContaining('LIMIT ? OFFSET ?'), [3, 20, 0],
    );
    await repo.findDefault();
    expect(db.queryOne).toHaveBeenCalledWith(expect.stringContaining('enabled = 1'));
    await repo.updateEnabled(5, 0);
    expect(db.updateById).toHaveBeenCalledWith('agent', 5, { enabled: 0 });
    await repo.findById(1);
    await repo.selectById(1);
    expect(await repo.findByIds([])).toEqual([]);
    await repo.findByIds([1, 2]);
    await repo.findDefault();
    const agent = { name: 'a', systemPrompt: 'p' };
    expect(await repo.insert(agent as never)).toBe(5);
    await repo.updateById({ id: 5, name: 'a', systemPrompt: 'p' }, 7, true);
    await repo.updateById({ name: 'a', systemPrompt: 'p' }, 7, true);
    await repo.deleteById(5);
    await repo.clearDefaultFlag();
    await repo.listPromptVersions(1);
    const pagedDb = mockDb({ c: 12 }, [{ id: 2, version: 2 }]);
    const pagedRepo = new MysqlAgentRepository(pagedDb as never);
    expect(await pagedRepo.listPromptVersionsPaged(1, 2, 5)).toEqual({
      records: [{ id: 2, version: 2 }], total: 12,
    });
    expect(pagedDb.queryOne).toHaveBeenCalledWith(expect.stringContaining('COUNT(*)'), [1]);
    expect(String(pagedDb.query.mock.calls.at(-1)?.[0])).toMatch(/ORDER BY version DESC LIMIT \? OFFSET \?/);
    expect(pagedDb.query.mock.calls.at(-1)?.[1]).toEqual([1, 5, 5]);
    const exp = new MysqlAgentExperienceRepository(db as never);
    await exp.listByAgentId(1);
    await exp.listEnabledByAgentId(1);
    await exp.findById(1);
    await exp.insert({ agentId: 1, content: 'c' });
    await exp.updateById({ id: 1, agentId: 1, content: 'c' });
    await exp.deleteById(1);
    await exp.deleteByAgentId(1);
    const sq = new MysqlAgentSuggestedQuestionRepository(db as never);
    await sq.listByAgentId(1);
    await sq.findById(1);
    await sq.insert({ agentId: 1, content: 'q' });
    await sq.updateById({ id: 1, agentId: 1, content: 'q' });
    await sq.deleteById(1);
    await sq.deleteByAgentId(1);
  });
});

describe('MysqlUserRepository', () => {
  it('covers lookups insert update and paging', async () => {
    const db = mockDb({ cnt: 2 }, [{ id: 1, username: 'a' }]);
    const repo = new MysqlUserRepository(db as never);
    await repo.findById(1);
    expect(await repo.findByIds([])).toEqual([]);
    await repo.findByIds([1]);
    await repo.listOptions();
    await repo.findByUsername('a');
    await repo.findByEmail('a@b.c');
    await repo.findByFeishuUserId('f');
    expect(await repo.countByUsername('a')).toBe(2);
    expect(await repo.countByEmailExcept('a@b.c', 1)).toBe(2);
    const user = { username: 'a' };
    expect(await repo.insert(user)).toBe(5);
    await repo.updateById({ id: 5, username: 'a' });
    await repo.updateById({ username: 'a' });
    await repo.updateFields(5, { status: 0 });
    await repo.selectPage(1, 20);
    await repo.selectPage(1, 20, 'ada', 1);
  });
});

describe('MysqlLlmModelRepository', () => {
  it('covers filtered paging and crud', async () => {
    const db = mockDb({ cnt: 1 }, [{ id: 1, name: 'm' }]);
    const repo = new MysqlLlmModelRepository(db as never);
    await repo.selectPage(1, 10, {});
    await repo.selectPage(1, 10, {
      keyword: 'gpt', provider: 'openai', status: 1, supportsVision: 1, isDefault: 1, modelType: 'chat',
    });
    await repo.findById(1);
    await repo.selectById(1);
    expect(await repo.findByIds([])).toEqual([]);
    await repo.findByIds([1]);
    await repo.findDefault();
    await repo.selectDefault();
    await repo.listProviders();
    await repo.listActiveText();
    await repo.findFirstActiveByType('text');
    await repo.countActiveTextExcept(1);
    const model = { name: 'm', provider: 'openai', modelId: 'g' };
    await repo.insert(model as never);
    await repo.updateById({ id: 1, ...model } as never);
    await repo.updateById(model as never);
    await repo.deleteById(1);
    await repo.clearDefaultFlag();
    const sessionModels = new (await import('../model/model.repository.js')).MysqlSessionModelRepository(db as never);
    await sessionModels.reassignModelId(1, 2);
  });
});

describe('permission repositories', () => {
  it('covers role permission and user-role mappers', async () => {
    const db = mockDb({ cnt: 1 }, [{ id: 1 }]);
    const roles = new MysqlRoleRepository(db as never);
    await roles.findById(1);
    await roles.findByCode('ADMIN');
    await roles.findAll();
    expect(await roles.findByIds([])).toEqual([]);
    await roles.findByIds([1, 2]);
    await roles.insert({ name: 'r', code: 'R' });
    await roles.updateById({ id: 1, name: 'r', code: 'R' });
    expect(await roles.deleteIfUnused(1)).toBe('in_use');

    const perms = new MysqlPermissionRepository(db as never);
    await perms.findAll();
    await perms.findByIds([1]);
    expect(await perms.findByIds([])).toEqual([]);
    await perms.countByIdsAndCode([1], 'user:read');
    expect(await perms.countByIdsAndCode([], 'x')).toBe(0);

    const rp = new MysqlRolePermissionRepository(db as never);
    await rp.findByRoleId(1);
    await rp.findByRoleIds([1]);
    expect(await rp.findByRoleIds([])).toEqual([]);
    await rp.deleteByRoleId(1);
    await rp.insert({ roleId: 1, permissionId: 2 });

    const ur = new MysqlUserRoleRepository(db as never);
    await ur.findByUserId(1);
    await ur.findByUserIds([1]);
    expect(await ur.findByUserIds([])).toEqual([]);
    await ur.findByRoleId(1);
    await ur.countByRoleId(1);
    await ur.countByUserAndRole(1, 2);
    await ur.deleteByUserId(1);
    await ur.insert({ userId: 1, roleId: 2 });
  });

  it('deleteIfUnused reports missing and deletes unbound roles in one transaction', async () => {
    const empty = mockDb(null, []);
    empty.transaction.mockImplementation(async (fn) => fn(empty));
    const roles = new MysqlRoleRepository(empty as never);
    expect(await roles.deleteIfUnused(9)).toBe('not_found');
    expect(empty.execute).not.toHaveBeenCalled();

    const unbound = mockDb({ id: 9 }, []);
    unbound.transaction.mockImplementation(async (fn) => fn(unbound));
    const repo = new MysqlRoleRepository(unbound as never);
    expect(await repo.deleteIfUnused(9)).toBe('deleted');
    expect(unbound.execute).toHaveBeenCalledWith('DELETE FROM role_permission WHERE role_id = ?', [9]);
    expect(unbound.execute).toHaveBeenCalledWith('DELETE FROM role WHERE id = ?', [9]);
  });
});

import { describe, expect, it, vi } from 'vitest';
import { McpServerMapper, UserMcpPreferenceMapper } from './mcp-server.mapper.js';

function mockDb() {
  return {
    query: vi.fn(async () => [{ id: 1 }]),
    queryOne: vi.fn(async () => ({ cnt: 2, id: 1 })),
    execute: vi.fn(async () => ({ affectedRows: 1 })),
    insert: vi.fn(async () => 8),
    updateById: vi.fn(),
  };
}

describe('McpServerMapper', () => {
  it('covers list insert update delete and counts', async () => {
    const db = mockDb();
    const mapper = new McpServerMapper(db as never);
    await mapper.list();
    await mapper.list('search', 'ENABLED');
    await mapper.listEnabledGlobal();
    await mapper.listMine(7);
    await mapper.selectById(1);
    await mapper.selectByName('n', 0);
    await mapper.selectOneByName('n');
    await mapper.insert({ name: 'n', serverType: 'stdio' } as never);
    await mapper.updateById(1, { name: 'n2' });
    await mapper.logicalDelete(1);
    await mapper.physicalDeleteById(1);
    expect(await mapper.countByUserIdAndName(0, 'n')).toBe(2);
    expect(await mapper.countByNameWhereUserIdNot('n', 0)).toBe(2);

    const pref = new UserMcpPreferenceMapper(db as never);
    await pref.listDisabledServerIds(7);
    await pref.get(7, 1);
    await pref.listByUser(7);
    await pref.insert({ userId: 7, serverId: 1, enabled: 0 });
    await pref.updateById(1, { enabled: 1 });
  });
});

describe('McpServerMapper.listPaged', () => {
  function pagedDb(rows: unknown[] = [], total = rows.length) {
    return {
      query: vi.fn(async () => rows),
      queryOne: vi.fn(async () => ({ c: total })),
    };
  }

  it('paginates with escaped keyword and status filter', async () => {
    const db = pagedDb([{ id: 3, name: 'git_server' }], 11);
    const mapper = new McpServerMapper(db as never);

    const page = await mapper.listPaged(2, 10, ' git_50% ', 'ENABLED');

    expect(page.total).toBe(11);
    expect(page.records).toHaveLength(1);
    const countSql = String(db.queryOne.mock.calls[0]![0]);
    const listSql = String(db.query.mock.calls[0]![0]);
    expect(countSql).toContain('name LIKE ? OR description LIKE ?');
    expect(countSql).toContain('status = ?');
    expect(listSql).toMatch(/ORDER BY user_id ASC, id ASC LIMIT \? OFFSET \?/);
    expect(db.query.mock.calls[0]![1]).toEqual([
      '%git\\_50\\%%', '%git\\_50\\%%', 'ENABLED', 10, 10,
    ]);
  });

  it('omits optional filters when not provided', async () => {
    const db = pagedDb();
    const mapper = new McpServerMapper(db as never);

    await mapper.listPaged(1, 20);

    const countSql = String(db.queryOne.mock.calls[0]![0]);
    expect(countSql).not.toContain('LIKE');
    expect(countSql).not.toContain('status = ?');
    expect(db.query.mock.calls[0]![1]).toEqual([20, 0]);
  });
});

describe('McpServerMapper.listMinePaged', () => {
  it('filters by owner and returns a page with the total', async () => {
    const db = {
      query: vi.fn(async () => [{ id: 4, userId: 7 }]),
      queryOne: vi.fn(async () => ({ c: 9 })),
    };
    const mapper = new McpServerMapper(db as never);

    const page = await mapper.listMinePaged(7, 2, 5);

    expect(page).toEqual({ records: [{ id: 4, userId: 7 }], total: 9 });
    const countSql = String(db.queryOne.mock.calls[0]![0]);
    expect(countSql).toContain('user_id = ?');
    expect(countSql).toContain('deleted = 0');
    expect(db.queryOne.mock.calls[0]![1]).toEqual([7]);
    const listSql = String(db.query.mock.calls[0]![0]);
    expect(listSql).toContain('user_id = ?');
    expect(listSql).toMatch(/ORDER BY id ASC LIMIT \? OFFSET \?/);
    expect(db.query.mock.calls[0]![1]).toEqual([7, 5, 5]);
  });
});

import { describe, expect, it, vi } from 'vitest';
import { MemoryRepository } from './memory.repository.js';
import { ErrorCode } from '../common/error-code.js';

function mockDb(queryOne: unknown = null, query: unknown[] = [], executeResult: { affectedRows: number; insertId: number } = { affectedRows: 1, insertId: 1 }) {
  return {
    queryOne: vi.fn(async () => queryOne),
    query: vi.fn(async () => query),
    execute: vi.fn(async () => executeResult),
    insert: vi.fn(async () => 42),
  };
}

describe('MemoryRepository governance and admin filters', () => {
  it('locks the stable user row before the callback on the transaction connection', async () => {
    const tx = mockDb({ id: 7 });
    const transaction = vi.fn(async (fn: (db: unknown) => Promise<unknown>) => fn(tx));
    const repo = new MemoryRepository({ transaction } as never);
    const callback = vi.fn(async (db: unknown) => {
      expect(db).toBe(tx);
      expect(tx.queryOne).toHaveBeenCalledWith('SELECT id FROM `user` WHERE id = ? FOR UPDATE', [7]);
      return 42;
    });
    expect(await repo.withUserLock(7, callback)).toBe(42);
    expect(transaction).toHaveBeenCalledTimes(1);
    (tx.queryOne as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null);
    await expect(repo.withUserLock(7, callback)).rejects.toMatchObject({ code: ErrorCode.USER_NOT_FOUND.code });
    expect(callback).toHaveBeenCalledTimes(1);
  });

  it('reads capacity and target rows with FOR UPDATE only on the supplied connection', async () => {
    const root = mockDb({ total: 999 });
    const tx = mockDb(null, [{ id: 1 }, { id: 2 }]);
    const repo = new MemoryRepository(root as never);
    expect(await repo.countActive(7, tx as never)).toBe(2);
    await repo.findById(5, tx as never);
    await repo.findByHash(7, 'hash', tx as never);
    await repo.listStaleAuto(7, 'USER', '', 1, tx as never);
    expect(root.query).not.toHaveBeenCalled();
    expect(root.queryOne).not.toHaveBeenCalled();
    for (const [sql] of (tx.query as ReturnType<typeof vi.fn>).mock.calls) expect(sql).toMatch(/FOR UPDATE$/);
    for (const [sql] of (tx.queryOne as ReturnType<typeof vi.fn>).mock.calls) expect(sql).toMatch(/FOR UPDATE$/);
  });

  it('conditionally revives only DISMISSED/EVICTED on the transaction connection', async () => {
    const root = mockDb();
    const tx = mockDb();
    const repo = new MemoryRepository(root as never);
    expect(await repo.reviveEvicted(5, tx as never)).toBe(true);
    const [sql, params] = (tx.execute as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(sql).toContain("WHERE id = ? AND status = 'DISMISSED' AND dismiss_reason = 'EVICTED'");
    expect(params[1]).toBe(5);
    expect(root.execute).not.toHaveBeenCalled();
    (tx.execute as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ affectedRows: 0 });
    expect(await repo.reviveEvicted(5, tx as never)).toBe(false);
  });

  it('filtersAcrossUsersAndBindsSourceDatesAndEscapedKeyword', async () => {
    const db = mockDb({ total: 1 });
    const repo = new MemoryRepository(db as never);
    const query = { source: 'AUTO' as const, updatedFrom: '2026-11-01 00:00:00', updatedTo: '2026-11-11 23:59:59', keyword: '100%', page: 2, pageSize: 10 };
    await repo.page(query);
    await repo.count(query);
    const [sql, params] = (db.query as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(sql).not.toContain('user_id = ?');
    expect(sql).toContain('source = ?');
    expect(sql).toContain('updated_at >= ?');
    expect(sql).toContain('updated_at <= ?');
    expect(params).toEqual(['AUTO', query.updatedFrom, query.updatedTo, '100\\%', '100\\%', 10, 10]);
    expect((db.queryOne as ReturnType<typeof vi.fn>).mock.calls[0][1]).toEqual(params.slice(0, -2));
  });

  it('dismissAtomicallyWritesReasonAndNegativeHintsExcludeEvicted', async () => {
    const db = mockDb();
    const repo = new MemoryRepository(db as never);
    await repo.dismiss(9, 'EVICTED');
    await repo.dismiss(10, 'USER');
    expect((db.execute as ReturnType<typeof vi.fn>).mock.calls[0]).toEqual([
      "UPDATE `memory_item` SET status = 'DISMISSED', dismiss_reason = ? WHERE id = ?", ['EVICTED', 9],
    ]);
    expect((db.execute as ReturnType<typeof vi.fn>).mock.calls[1][1]).toEqual(['USER', 10]);
    await repo.listDismissedContents(7, 50);
    expect((db.query as ReturnType<typeof vi.fn>).mock.calls[0][0]).toContain("dismiss_reason = 'USER'");
  });
});

describe('MemoryRepository', () => {
  it('pageFiltersByUserIdAndOptionalFieldsWithDescOrder', async () => {
    const db = mockDb(null, [{ id: 1 }]);
    const repo = new MemoryRepository(db as never);
    const rows = await repo.page({ userId: 7, scope: 'PROJECT', projectKey: 'mao', status: 'ACTIVE', page: 3, pageSize: 10 });
    expect(rows).toHaveLength(1);
    const [sql, params] = (db.query as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(sql).toContain('user_id = ?');
    expect(sql).toContain('scope = ?');
    expect(sql).toContain('project_key = ?');
    expect(sql).toContain('status = ?');
    expect(sql).toContain('ORDER BY updated_at DESC, id DESC');
    expect(params).toEqual([7, 'PROJECT', 'mao', 'ACTIVE', 10, 20]);
  });

  it('pageKeywordFiltersContentOrProjectKeyWithEscapedWildcards', async () => {
    const db = mockDb(null, [{ id: 1 }]);
    const repo = new MemoryRepository(db as never);
    await repo.page({ userId: 7, keyword: 'vitest', page: 1, pageSize: 20 });
    const [sql, params] = (db.query as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(sql).toContain("content LIKE CONCAT('%', ?, '%') ESCAPE '\\\\'");
    expect(sql).toContain("project_key LIKE CONCAT('%', ?, '%') ESCAPE '\\\\'");
    expect(params).toEqual([7, 'vitest', 'vitest', 20, 0]);

    // 通配符按字面匹配：100%_a\b 不展开为通配
    await repo.page({ userId: 7, keyword: '100%_a\\b', page: 1, pageSize: 20 });
    const [, escapedParams] = (db.query as ReturnType<typeof vi.fn>).mock.calls[1];
    expect(escapedParams).toEqual([7, '100\\%\\_a\\\\b', '100\\%\\_a\\\\b', 20, 0]);

    // 空 / 空串 keyword 不追加子句
    await repo.page({ userId: 7, keyword: '   ', page: 1, pageSize: 20 });
    const [emptySql, emptyParams] = (db.query as ReturnType<typeof vi.fn>).mock.calls[2];
    expect(emptySql).not.toContain('LIKE');
    expect(emptyParams).toEqual([7, 20, 0]);

    // keyword 与 scope/status 叠加时占位符顺序正确
    await repo.page({ userId: 7, scope: 'PROJECT', status: 'ACTIVE', keyword: 'k', page: 1, pageSize: 20 });
    const [, comboParams] = (db.query as ReturnType<typeof vi.fn>).mock.calls[3];
    expect(comboParams).toEqual([7, 'PROJECT', 'ACTIVE', 'k', 'k', 20, 0]);
  });

  it('countActiveCountsOnlyActiveRows', async () => {
    const db = mockDb({ total: 5 });
    const repo = new MemoryRepository(db as never);
    expect(await repo.countActive(7)).toBe(5);
    const [sql, params] = (db.queryOne as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(sql).toContain('status = \'ACTIVE\'');
    expect(params).toEqual([7]);
  });

  it('insertStoresUserScopeProjectKeyAndSource', async () => {
    const db = mockDb();
    const repo = new MemoryRepository(db as never);
    const id = await repo.insert({
      userId: 7,
      scope: 'PROJECT',
      projectKey: 'mao',
      content: '测试用 Vitest',
      source: 'AUTO',
      status: 'ACTIVE',
      dedupHash: 'a'.repeat(40),
      originSessionId: 11,
    });
    expect(id).toBe(42);
    const [table, data] = (db.insert as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(table).toBe('memory_item');
    // snake_case 转换由 Db.insert 统一完成，仓储层传驼峰行
    expect(data).toMatchObject({ userId: 7, scope: 'PROJECT', projectKey: 'mao', source: 'AUTO', dedupHash: 'a'.repeat(40), originSessionId: 11 });
  });

  it('touchUpdatesUpdatedAtOnly', async () => {
    const db = mockDb();
    const repo = new MemoryRepository(db as never);
    await repo.touch(9);
    const [sql, params] = (db.execute as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(sql).toContain('SET updated_at = ?');
    expect(params[1]).toBe(9);
  });

  it('injectionQueriesBoundScopeStatusAndLimit', async () => {
    const db = mockDb(null, [{ id: 1 }]);
    const repo = new MemoryRepository(db as never);
    await repo.listActiveUser(7, 8);
    const [userSql, userParams] = (db.query as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(userSql).toContain("scope = 'USER'");
    expect(userSql).toContain("status = 'ACTIVE'");
    expect(userParams).toEqual([7, 8]);

    await repo.listActiveProject(7, 'mao', 12);
    const [projectSql, projectParams] = (db.query as ReturnType<typeof vi.fn>).mock.calls[1];
    expect(projectSql).toContain("scope = 'PROJECT'");
    expect(projectSql).toContain('project_key = ?');
    expect(projectParams).toEqual([7, 'mao', 12]);
  });

  it('injectionQueriesTruncateByRecencyThenOutputInIdOrderForStablePrefix', async () => {
    // 选择口径不变（内层仍按 updated_at DESC, id DESC 截断），仅输出顺序稳定为 id ASC：
    // 任一条记忆被 touch 不再重排整块，system 前缀缓存不被打掉。
    const db = mockDb(null, [{ id: 1 }]);
    const repo = new MemoryRepository(db as never);
    await repo.listActiveUser(7, 8);
    const [userSql] = (db.query as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(userSql).toContain('ORDER BY updated_at DESC, id DESC LIMIT ?');
    expect(userSql).toContain('ORDER BY t.id ASC');

    await repo.listActiveProject(7, 'mao', 12);
    const [projectSql] = (db.query as ReturnType<typeof vi.fn>).mock.calls[1];
    expect(projectSql).toContain('ORDER BY updated_at DESC, id DESC LIMIT ?');
    expect(projectSql).toContain('ORDER BY t.id ASC');
  });

  it('preferenceRoundtripDefaultsRowShape', async () => {
    const db = mockDb({ user_id: 7, auto_capture_enabled: 0 });
    const repo = new MemoryRepository(db as never);
    expect(await repo.findPreference(7)).toMatchObject({ auto_capture_enabled: 0 });
    await repo.updatePreference(7, true);
    const [sql, params] = (db.execute as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(sql).toContain('auto_capture_enabled = ?');
    expect(params).toEqual([1, 7]);
  });
});

describe('MemoryRepository dedupQueries', () => {
  it('listActiveForDedupFiltersAutoActiveAndBindsProjectKeyPerGroup', async () => {
    const db = mockDb(null, [{ id: 1 }]);
    const repo = new MemoryRepository(db as never);
    await repo.listActiveForDedup(7, 'PROJECT', 'mao');
    const [projectSql, projectParams] = (db.query as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(projectSql).toContain("source = 'AUTO'");
    expect(projectSql).toContain('project_key = ?');
    expect(projectParams).toEqual([7, 'PROJECT', 'mao']);

    await repo.listActiveForDedup(7, 'USER', null);
    const [userSql, userParams] = (db.query as ReturnType<typeof vi.fn>).mock.calls[1];
    expect(userSql).not.toContain('project_key = ?');
    expect(userParams).toEqual([7, 'USER']);
  });

  it('listStaleAutoOrdersOldestFirstForEviction', async () => {
    const db = mockDb(null, [{ id: 3 }]);
    const repo = new MemoryRepository(db as never);
    await repo.listStaleAuto(7, 'USER', null, 1);
    const [sql, params] = (db.query as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(sql).toContain('ORDER BY updated_at ASC, id ASC');
    expect(sql).toContain("source = 'AUTO'");
    expect(params).toEqual([7, 'USER', 1]);
  });

  it('listDismissedContentsBindsLimit', async () => {
    const db = mockDb(null, [{ content: 'x' }]);
    const repo = new MemoryRepository(db as never);
    await repo.listDismissedContents(7, 50);
    const [sql, params] = (db.query as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(sql).toContain("status = 'DISMISSED'");
    expect(params).toEqual([7, 50]);
  });
});

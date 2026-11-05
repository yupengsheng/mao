import { describe, expect, it, vi } from 'vitest';
import type mysql from 'mysql2/promise';
import { Db } from '../db/db.js';
import { SessionActivityRepository, SessionTodoRepository, SubagentExecutionRepository } from './activity.repository.js';

function setup(affectedRows = 7) {
  const execute = vi.fn(async () => [{ affectedRows }, []]);
  const db = new Db({ execute } as unknown as mysql.Pool);
  return { repo: new SessionActivityRepository(db), execute };
}

describe('SessionActivityRepository.deleteBatch', () => {
  it('按创建时间删除并返回影响行数', async () => {
    const { repo, execute } = setup(7);

    await expect(repo.deleteBatch('2026-05-09 12:00:00', 1000)).resolves.toBe(7);
    expect(execute).toHaveBeenCalledWith(
      'DELETE FROM session_activity WHERE created_at < ? ORDER BY created_at, id LIMIT 1000',
      ['2026-05-09 12:00:00'],
    );
  });

  it('批量上限钳制在 1~5000', async () => {
    const { repo, execute } = setup();

    await repo.deleteBatch('2026-05-09 12:00:00', 999999);
    expect(execute).toHaveBeenLastCalledWith(
      'DELETE FROM session_activity WHERE created_at < ? ORDER BY created_at, id LIMIT 5000',
      ['2026-05-09 12:00:00'],
    );

    await repo.deleteBatch('2026-05-09 12:00:00', 0);
    expect(execute).toHaveBeenLastCalledWith(
      'DELETE FROM session_activity WHERE created_at < ? ORDER BY created_at, id LIMIT 1',
      ['2026-05-09 12:00:00'],
    );
  });
});

describe('SessionTodoRepository.logicalDeleteBySession', () => {
  it('按会话逻辑删除整段待办', async () => {
    const execute = vi.fn(async () => [{ affectedRows: 3 }, []]);
    const repo = new SessionTodoRepository(new Db({ execute } as unknown as mysql.Pool));

    await repo.logicalDeleteBySession(42);

    expect(execute).toHaveBeenCalledWith(
      'UPDATE session_todo SET deleted = 1 WHERE session_id = ? AND deleted = 0',
      [42],
    );
  });
});

describe('SubagentExecutionRepository.deleteBatch', () => {
  function setupSubagent(affectedRows = 9) {
    const execute = vi.fn(async () => [{ affectedRows }, []]);
    const db = new Db({ execute } as unknown as mysql.Pool);
    return { repo: new SubagentExecutionRepository(db), execute };
  }

  it('只清理终态且已收口投递、超过保留期、且非最新记录的执行行', async () => {
    const { repo, execute } = setupSubagent(9);

    await expect(repo.deleteBatch('2026-05-09 12:00:00', 1000)).resolves.toBe(9);

    const [sql, params] = execute.mock.calls[0];
    expect(params).toEqual(['2026-05-09 12:00:00']);
    expect(sql).toContain("e.status IN ('COMPLETED', 'FAILED', 'CANCELLED')");
    expect(sql).toContain("e.delivery_status IN ('DELIVERED', 'SUPPRESSED', 'LEGACY')");
    expect(sql).toContain('e.updated_at < ?');
    expect(sql).toContain('LEFT JOIN session s ON s.id = e.child_session_id AND s.deleted = 0');
    expect(sql).toContain('s.id IS NULL');
    expect(sql).toContain('SELECT MAX(latest.id) FROM subagent_execution latest');
    expect(sql).toContain('latest.child_session_id = e.child_session_id');
    expect(sql).toContain('ORDER BY e.updated_at, e.id');
    expect(sql).toContain('LIMIT 1000');
    expect(sql).not.toContain('LIMIT ?');
  });

  it('LIMIT 钳制在 1~5000，非法值不会拼进 SQL', async () => {
    const { repo, execute } = setupSubagent();

    await repo.deleteBatch('2026-05-09 12:00:00', 0);
    await repo.deleteBatch('2026-05-09 12:00:00', Number.NaN);
    await repo.deleteBatch('2026-05-09 12:00:00', Number.POSITIVE_INFINITY);
    await repo.deleteBatch('2026-05-09 12:00:00', 99999);
    await repo.deleteBatch('2026-05-09 12:00:00', 12.9);

    expect(execute.mock.calls[0][0]).toContain('LIMIT 1');
    expect(execute.mock.calls[1][0]).toContain('LIMIT 1');
    expect(execute.mock.calls[2][0]).toContain('LIMIT 1');
    expect(execute.mock.calls[3][0]).toContain('LIMIT 5000');
    expect(execute.mock.calls[4][0]).toContain('LIMIT 12');
  });
});

import { describe, expect, it, vi } from 'vitest';
import type mysql from 'mysql2/promise';
import { Db } from '../db/db.js';
import { MysqlEcpOauthStateRepository } from './ecp-oauth.repository.js';
import { MysqlFeishuOauthStateRepository } from './feishu-oauth.repository.js';
import { MysqlDingtalkOauthStateRepository } from '../dingtalk/oauth.repository.js';
import { MysqlFeishuPendingBindingRepository } from '../feishu/pending-binding.repository.js';
import { MysqlDingtalkPendingBindingRepository } from '../dingtalk/pending-binding.repository.js';

function setup(affectedRows = 7) {
  const execute = vi.fn(async () => [{ affectedRows }, []]);
  const db = new Db({ execute } as unknown as mysql.Pool);
  return { db, execute };
}

describe('鉴权状态清理仓储', () => {
  const cutoff = '2026-10-06 12:00:00';

  type DeleteRepo = { deleteBatch(cutoff: string, limit: number): Promise<number> };
  const cases: Array<[string, (db: Db) => DeleteRepo]> = [
    ['feishu_oauth_state', (db: Db) => new MysqlFeishuOauthStateRepository(db)],
    ['ecp_oauth_state', (db: Db) => new MysqlEcpOauthStateRepository(db)],
    ['dingtalk_oauth_state', (db: Db) => new MysqlDingtalkOauthStateRepository(db)],
    ['dingtalk_pending_binding_message', (db: Db) => new MysqlDingtalkPendingBindingRepository(db)],
  ];

  it.each(cases)('%s 按过期时间删除并返回影响行数', async (table, create) => {
    const { db, execute } = setup(7);

    await expect(create(db).deleteBatch(cutoff, 1000)).resolves.toBe(7);
    expect(execute).toHaveBeenCalledWith(
      `DELETE FROM ${table} WHERE expires_at < ? ORDER BY id LIMIT 1000`,
      [cutoff],
    );
  });

  it('飞书待绑定消息按更新时间删除', async () => {
    const { db, execute } = setup(5);

    await expect(new MysqlFeishuPendingBindingRepository(db).deleteBatch(cutoff, 1000)).resolves.toBe(5);
    expect(execute).toHaveBeenCalledWith(
      'DELETE FROM feishu_pending_binding_message WHERE updated_at < ? ORDER BY id LIMIT 1000',
      [cutoff],
    );
  });

  it('批量上限钳制在 1~5000', async () => {
    const { db, execute } = setup();
    const repo = new MysqlFeishuOauthStateRepository(db);

    await repo.deleteBatch(cutoff, 999999);
    expect(execute).toHaveBeenLastCalledWith(
      'DELETE FROM feishu_oauth_state WHERE expires_at < ? ORDER BY id LIMIT 5000',
      [cutoff],
    );

    await repo.deleteBatch(cutoff, 0);
    expect(execute).toHaveBeenLastCalledWith(
      'DELETE FROM feishu_oauth_state WHERE expires_at < ? ORDER BY id LIMIT 1',
      [cutoff],
    );
  });
});

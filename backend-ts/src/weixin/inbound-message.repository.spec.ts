import { describe, expect, it, vi } from 'vitest';
import type mysql from 'mysql2/promise';
import { Db } from '../db/db.js';
import { WeixinInboundMessageRepository } from './inbound-message.repository.js';

function setup() {
  const execute = vi.fn(async () => [{ affectedRows: 7 }, []]);
  const db = new Db({ query: vi.fn(), execute } as unknown as mysql.Pool);
  return { repo: new WeixinInboundMessageRepository(db), execute };
}

describe('WeixinInboundMessageRepository terminal retention cleanup', () => {
  it('只删除终态记录，保留 CLAIMED 并钳制单批上限', async () => {
    const { repo, execute } = setup();

    await expect(repo.deleteTerminalBatch('2026-10-05 00:00:00', 999999)).resolves.toBe(7);

    expect(execute).toHaveBeenCalledWith(
      `DELETE FROM weixin_inbound_message
       WHERE status IN ('DONE', 'FAILED') AND updated_at < ?
       ORDER BY updated_at, id LIMIT 5000`,
      ['2026-10-05 00:00:00'],
    );
    const sql = execute.mock.calls[0]?.[0] as string;
    expect(sql).not.toContain("'CLAIMED'");
  });

  it('非正数批次上限至少保留 1 条，避免清理空转', async () => {
    const { repo, execute } = setup();

    await repo.deleteTerminalBatch('2026-10-05 00:00:00', 0);

    expect(execute).toHaveBeenCalledWith(expect.stringContaining('LIMIT 1'), ['2026-10-05 00:00:00']);
  });
});

describe('WeixinInboundMessageRepository resend reclaim', () => {
  it('清理与合法重发并发时用 upsert 保证幂等行仍存在', async () => {
    const { repo, execute } = setup();

    await repo.reclaimForResend('acc', 'key', '{"text":"hi"}');

    expect(execute).toHaveBeenCalledWith(
      expect.stringContaining('ON DUPLICATE KEY UPDATE status = \'CLAIMED\''),
      ['acc', 'key', '{"text":"hi"}'],
    );
  });
});

import { describe, expect, it, vi } from 'vitest';
import { SessionCompactionEventRepository } from './session-compaction.repository.js';

function build(affectedRows = 0) {
  const execute = vi.fn(async () => ({ affectedRows }));
  const repo = new SessionCompactionEventRepository({ execute } as never);
  return { repo, execute };
}

describe('SessionCompactionEventRepository.deleteBatch', () => {
  it('按 created_at 截止时刻稳定排序删除，返回 affectedRows', async () => {
    const { repo, execute } = build(37);

    await expect(repo.deleteBatch('2026-05-09 12:00:00', 5000)).resolves.toBe(37);

    expect(execute).toHaveBeenCalledWith(
      'DELETE FROM session_compaction_event WHERE created_at < ? ORDER BY created_at, id LIMIT 5000',
      ['2026-05-09 12:00:00'],
    );
  });

  it('LIMIT 钳制在 1~5000，非法值不会拼进 SQL', async () => {
    const { repo, execute } = build();

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

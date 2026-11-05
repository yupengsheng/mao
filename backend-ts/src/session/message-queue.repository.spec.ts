import { describe, expect, it, vi } from 'vitest';
import { MessageQueueRepository } from './message-queue.repository.js';

function build(affectedRows = 0) {
  const execute = vi.fn(async () => ({ affectedRows }));
  const repo = new MessageQueueRepository({ execute } as never);
  return { repo, execute };
}

describe('MessageQueueRepository.deleteTerminalBatch', () => {
  it('只按 updated_at 删除 DELETED 行，PENDING 行不会被清理', async () => {
    const { repo, execute } = build(37);

    await expect(repo.deleteTerminalBatch('2026-10-06 12:00:00', 5000)).resolves.toBe(37);

    expect(execute).toHaveBeenCalledWith(
      "DELETE FROM message_queue WHERE status = 'DELETED' AND updated_at < ? ORDER BY updated_at, id LIMIT 5000",
      ['2026-10-06 12:00:00'],
    );
    expect(execute.mock.calls[0][0]).not.toContain("status = 'PENDING'");
  });

  it('LIMIT 钳制在 1~5000，非法值不会拼进 SQL', async () => {
    const { repo, execute } = build();

    await repo.deleteTerminalBatch('2026-10-06 12:00:00', 0);
    await repo.deleteTerminalBatch('2026-10-06 12:00:00', Number.NaN);
    await repo.deleteTerminalBatch('2026-10-06 12:00:00', Number.POSITIVE_INFINITY);
    await repo.deleteTerminalBatch('2026-10-06 12:00:00', 99999);
    await repo.deleteTerminalBatch('2026-10-06 12:00:00', 12.9);

    expect(execute.mock.calls[0][0]).toContain('LIMIT 1');
    expect(execute.mock.calls[1][0]).toContain('LIMIT 1');
    expect(execute.mock.calls[2][0]).toContain('LIMIT 1');
    expect(execute.mock.calls[3][0]).toContain('LIMIT 5000');
    expect(execute.mock.calls[4][0]).toContain('LIMIT 12');
  });
});

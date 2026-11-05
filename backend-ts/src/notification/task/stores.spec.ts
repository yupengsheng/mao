import { describe, expect, it, vi } from 'vitest';
import type { Db } from '../../db/db.js';
import { DeliveryDbStore } from './stores.js';

describe('DeliveryDbStore', () => {
  it('suppresses only non-terminal deliveries for a session', async () => {
    const db = { execute: vi.fn().mockResolvedValue({ affectedRows: 3 }) };
    const store = new DeliveryDbStore(db as unknown as Db);

    expect(await store.suppressPendingBySession(42)).toBe(3);
    const [sql, params] = db.execute.mock.calls[0]!;
    expect(sql).toContain('SET status = ?, next_retry_at = NULL');
    expect(sql).toContain('WHERE session_id = ? AND status IN (?, ?, ?)');
    expect(params).toEqual(['SUPPRESSED_WS', 42, 'WAITING_WS', 'PENDING', 'SENDING']);
  });
});

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(resolve(process.cwd(), 'db/migration/V200__execution_wait_and_lease.sql'), 'utf8');

function expectColumn(table: string, column: string) {
  expect(sql, `${table}.${column}`).toContain(`\`${column}\``);
}

describe('V200 execution wait and lease migration', () => {
  it('creates both phase-2 tables', () => {
    expect(sql).toContain('CREATE TABLE `execution_wait`');
    expect(sql).toContain('CREATE TABLE `agent_execution_lease`');
  });

  it('stores execution waits with idempotency and recovery indexes', () => {
    for (const column of [
      'session_id', 'execution_id', 'request_type', 'request_id', 'status', 'payload_summary',
      'payload_digest', 'created_at', 'expires_at', 'released_at', 'release_reason', 'fencing_token', 'updated_at',
    ]) expectColumn('execution_wait', column);
    expect(sql).toContain('UNIQUE KEY `uk_execution_wait_request` (`session_id`, `request_type`, `request_id`)');
    expect(sql).toContain('KEY `idx_execution_wait_pending` (`status`, `expires_at`)');
    expect(sql).toContain('KEY `idx_execution_wait_execution` (`execution_id`, `status`)');
  });

  it('stores one lease per session with fencing token and expiry indexes', () => {
    for (const column of [
      'session_id', 'execution_id', 'owner_instance', 'fencing_token', 'status',
      'heartbeat_at', 'expires_at', 'created_at', 'updated_at',
    ]) expectColumn('agent_execution_lease', column);
    expect(sql).toContain('UNIQUE KEY `uk_agent_execution_lease_session` (`session_id`)');
    expect(sql).toContain('KEY `idx_agent_execution_lease_expiry` (`status`, `expires_at`)');
    expect(sql).toContain('KEY `idx_agent_execution_lease_execution` (`execution_id`)');
  });
});

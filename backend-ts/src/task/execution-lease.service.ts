import { parseShanghaiDateTime } from '../auth/auth.service.js';
import type { Db } from '../db/db.js';

/** 心跳间隔的 4 倍；两者都只描述租约协议，调度由执行门禁接入。 */
export const EXECUTION_LEASE_TTL_SECONDS = 60;
export const EXECUTION_LEASE_HEARTBEAT_INTERVAL_MS = 15_000;

export interface LeaseHandle {
  sessionId: number;
  executionId: string;
  ownerInstance: string;
  fencingToken: bigint;
  expiresAt: Date;
}

/** 租约当前记录，包含已过期 / 已释放状态；恢复扫描用它找回原 executionId。 */
export interface ExecutionLeaseRecord extends LeaseHandle {
  status: 'ACTIVE' | 'RELEASED';
}

/** 租约开关开启时，调用方未把门禁返回的 handle 透传到执行入口。 */
export class LeaseRequiredError extends Error {
  constructor(readonly sessionId: number) {
    super(`execution lease is required for session ${sessionId}`);
    this.name = 'LeaseRequiredError';
  }
}

interface LeaseRow {
  id: number;
  sessionId: number;
  executionId: string;
  ownerInstance: string;
  fencingToken: number | string | bigint;
  status: string;
  expiresAt: string | Date;
  active: number | string | boolean;
}

interface FencedRow {
  matched: number;
}

const LEASE_COLUMNS = `id, session_id, execution_id, owner_instance, fencing_token, status, expires_at,
  (status = 'ACTIVE' AND expires_at >= CURRENT_TIMESTAMP) AS active`;
const ACQUIRE_ATTEMPTS = 3;
const RETRYABLE_ERRNOS = new Set([1062, 1205, 1213]);
const RETRYABLE_CODES = new Set(['ER_DUP_ENTRY', 'ER_LOCK_DEADLOCK', 'ER_LOCK_WAIT_TIMEOUT']);

/**
 * 单 Session 执行归属。获取与状态迁移都在同一事务内锁行；fencing token 只增不减，
 * 旧持有者即使进程仍在也无法通过心跳或终态写入校验。
 */
export class ExecutionLeaseService {
  constructor(
    private readonly db: Db,
    private readonly ttlSeconds: number = EXECUTION_LEASE_TTL_SECONDS,
  ) {
    if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds <= 0) {
      throw new TypeError('execution lease ttl must be a positive integer');
    }
  }

  /** 冲突返回 null，数据库异常向上抛出；调用方不得在 null 时启动执行。 */
  async acquire(sessionId: number, executionId: string, ownerInstance: string): Promise<LeaseHandle | null> {
    requirePositiveId(sessionId, 'sessionId');
    const normalizedExecutionId = requireText(executionId, 'executionId', 128);
    const normalizedOwner = requireText(ownerInstance, 'ownerInstance', 128);

    for (let attempt = 1; ; attempt += 1) {
      try {
        return await this.db.transaction((tx) => this.acquireLocked(
          tx,
          sessionId,
          normalizedExecutionId,
          normalizedOwner,
        ));
      } catch (error) {
        // 无行可锁时两个实例可能同时插入；撞唯一键后重新走 SELECT FOR UPDATE。
        if (attempt < ACQUIRE_ATTEMPTS && isRetryable(error)) continue;
        throw error;
      }
    }
  }

  async heartbeat(handle: LeaseHandle): Promise<boolean> {
    requireHandle(handle);
    const result = await this.db.execute(
      `UPDATE agent_execution_lease
          SET heartbeat_at = CURRENT_TIMESTAMP,
              expires_at = DATE_ADD(CURRENT_TIMESTAMP, INTERVAL ? SECOND)
        WHERE session_id = ? AND execution_id = ? AND fencing_token = ?
          AND status = 'ACTIVE' AND expires_at >= CURRENT_TIMESTAMP`,
      [this.ttlSeconds, handle.sessionId, handle.executionId, handle.fencingToken.toString()],
    );
    return result.affectedRows > 0;
  }

  /** 查询 Session 当前有效的执行归属；无有效租约返回 null。 */
  async getActive(sessionId: number): Promise<LeaseHandle | null> {
    requirePositiveId(sessionId, 'sessionId');
    const row = await this.db.queryOne<LeaseRow>(
      `SELECT ${LEASE_COLUMNS} FROM agent_execution_lease WHERE session_id = ? LIMIT 1`,
      [sessionId],
    );
    return row != null && isActive(row) ? toHandle(row) : null;
  }

  /** 读取最近一条租约记录（不过滤过期/释放），仅供恢复流程定位原执行。 */
  async getRecord(sessionId: number): Promise<ExecutionLeaseRecord | null> {
    requirePositiveId(sessionId, 'sessionId');
    const row = await this.db.queryOne<LeaseRow>(
      `SELECT ${LEASE_COLUMNS} FROM agent_execution_lease WHERE session_id = ? LIMIT 1`,
      [sessionId],
    );
    if (row == null) return null;
    return {
      ...toHandle(row),
      status: row.status === 'ACTIVE' ? 'ACTIVE' : 'RELEASED',
    };
  }

  /** 仅当前 ACTIVE 持有者可释放；迟到或已失效的 handle 是幂等空操作。 */
  async release(handle: LeaseHandle): Promise<void> {
    requireHandle(handle);
    await this.db.execute(
      `UPDATE agent_execution_lease
          SET status = 'RELEASED'
        WHERE session_id = ? AND execution_id = ? AND fencing_token = ? AND status = 'ACTIVE'`,
      [handle.sessionId, handle.executionId, handle.fencingToken.toString()],
    );
  }

  /** 任务终态 / 阶段写入前的归属校验；只认未过期且 token 完全一致的租约。 */
  async assertFenced(handle: LeaseHandle): Promise<boolean> {
    requireHandle(handle);
    const row = await this.db.queryOne<FencedRow>(
      `SELECT 1 AS matched
         FROM agent_execution_lease
        WHERE session_id = ? AND execution_id = ? AND fencing_token = ?
          AND status = 'ACTIVE' AND expires_at >= CURRENT_TIMESTAMP
        LIMIT 1`,
      [handle.sessionId, handle.executionId, handle.fencingToken.toString()],
    );
    return row != null;
  }

  private async acquireLocked(
    tx: Db,
    sessionId: number,
    executionId: string,
    ownerInstance: string,
  ): Promise<LeaseHandle | null> {
    const current = await tx.queryOne<LeaseRow>(
      `SELECT ${LEASE_COLUMNS} FROM agent_execution_lease WHERE session_id = ? FOR UPDATE`,
      [sessionId],
    );

    if (current == null) {
      await tx.execute(
        `INSERT INTO agent_execution_lease
          (session_id, execution_id, owner_instance, fencing_token, status, heartbeat_at, expires_at)
         VALUES (?, ?, ?, 1, 'ACTIVE', CURRENT_TIMESTAMP,
                 DATE_ADD(CURRENT_TIMESTAMP, INTERVAL ? SECOND))`,
        [sessionId, executionId, ownerInstance, this.ttlSeconds],
      );
      return this.readHandle(tx, sessionId);
    }

    if (isActive(current)) {
      return current.executionId === executionId ? toHandle(current) : null;
    }

    const updated = await tx.execute(
      `UPDATE agent_execution_lease
          SET execution_id = ?, owner_instance = ?, status = 'ACTIVE',
              fencing_token = fencing_token + 1,
              heartbeat_at = CURRENT_TIMESTAMP,
              expires_at = DATE_ADD(CURRENT_TIMESTAMP, INTERVAL ? SECOND)
        WHERE session_id = ? AND id = ?
          AND (status <> 'ACTIVE' OR expires_at < CURRENT_TIMESTAMP)`,
      [executionId, ownerInstance, this.ttlSeconds, sessionId, current.id],
    );
    return updated.affectedRows > 0 ? this.readHandle(tx, sessionId) : null;
  }

  private async readHandle(tx: Db, sessionId: number): Promise<LeaseHandle | null> {
    const row = await tx.queryOne<LeaseRow>(
      `SELECT ${LEASE_COLUMNS} FROM agent_execution_lease WHERE session_id = ?`,
      [sessionId],
    );
    return row == null ? null : toHandle(row);
  }
}

function isActive(row: LeaseRow): boolean {
  return row.status === 'ACTIVE' && (row.active === true || Number(row.active) === 1);
}

function toHandle(row: LeaseRow): LeaseHandle {
  const expiresAtMs = row.expiresAt instanceof Date
    ? row.expiresAt.getTime()
    : parseShanghaiDateTime(String(row.expiresAt));
  if (!Number.isFinite(expiresAtMs)) throw new Error('execution lease returned an invalid expires_at');
  return {
    sessionId: row.sessionId,
    executionId: row.executionId,
    ownerInstance: row.ownerInstance,
    fencingToken: BigInt(row.fencingToken),
    expiresAt: new Date(expiresAtMs),
  };
}

function requirePositiveId(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`${name} must be a positive integer`);
}

function requireText(value: string, name: string, maxLength: number): string {
  const text = value.trim();
  if (text === '' || text.length > maxLength) throw new TypeError(`${name} must be 1-${maxLength} characters`);
  return text;
}

function requireHandle(handle: LeaseHandle): void {
  requirePositiveId(handle.sessionId, 'handle.sessionId');
  requireText(handle.executionId, 'handle.executionId', 128);
  requireText(handle.ownerInstance, 'handle.ownerInstance', 128);
  if (typeof handle.fencingToken !== 'bigint' || handle.fencingToken <= 0n) {
    throw new TypeError('handle.fencingToken must be a positive bigint');
  }
}

function isRetryable(error: unknown): boolean {
  if (typeof error !== 'object' || error == null) return false;
  const candidate = error as { code?: string; errno?: number };
  return (candidate.code != null && RETRYABLE_CODES.has(candidate.code))
    || (candidate.errno != null && RETRYABLE_ERRNOS.has(candidate.errno));
}

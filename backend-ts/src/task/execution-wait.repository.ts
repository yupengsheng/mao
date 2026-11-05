import type { Db } from '../db/db.js';
import type { TaskWaitKind, TaskWaitReleaseReason } from '@mao/contracts';

export interface PendingWaitInsert {
  sessionId: number;
  executionId: string;
  requestType: TaskWaitKind;
  requestId: string;
  payloadSummary: string;
  payloadDigest: string;
  /** 写入时的执行租约 token；租约未启用时保持 0。 */
  fencingToken?: bigint | number | string;
}

export interface ExecutionWaitRecord {
  id: number;
  sessionId: number;
  executionId: string;
  requestType: TaskWaitKind;
  requestId: string;
  payloadSummary: string;
  expiresAt: string;
  fencingToken: bigint;
  expired: boolean;
  /** 已由崩溃恢复扫描投影为只读通知；旧 Promise 不再存在。 */
  recovered: boolean;
}

export interface ExecutionWaitCounts {
  approval: number;
  question: number;
}

/** Session / Task 查询面向的只读等待接口，避免调用方依赖写库细节。 */
export interface ExecutionWaitQueryStore {
  findEarliestPending(sessionId: number, executionId?: string): Promise<ExecutionWaitRecord | null>;
  countPendingBySessionIds(sessionIds: number[]): Promise<Map<number, ExecutionWaitCounts>>;
}

export interface ExecutionWaitStore {
  insertPending(input: PendingWaitInsert): Promise<void>;
  hasPending(sessionId: number, executionId?: string): Promise<boolean>;
  findEarliestPending(sessionId: number, executionId?: string): Promise<ExecutionWaitRecord | null>;
  countPendingBySessionIds(sessionIds: number[]): Promise<Map<number, ExecutionWaitCounts>>;
  listPending(
    sessionId: number,
    executionId?: string,
    maxFencingToken?: bigint,
  ): Promise<ExecutionWaitRecord[]>;
  /** 只标记本次真正从“未恢复”变为“已恢复”的行，返回新标记成功的 ID。 */
  markRecovered(ids: number[], maxFencingToken?: bigint): Promise<number[]>;
  expire(id: number, maxFencingToken?: bigint): Promise<boolean>;
  release(
    sessionId: number,
    requestType: TaskWaitKind,
    requestId: string,
    reason: TaskWaitReleaseReason,
  ): Promise<boolean>;
  /** 终态结算后清理该 Session 仍挂在 PENDING 的行，避免阻止后续执行。 */
  releaseAllPending(
    sessionId: number,
    reason: TaskWaitReleaseReason,
    maxFencingToken?: bigint,
  ): Promise<number>;
}

/** `execution_wait` 的最小写入面；过期判断统一使用数据库时间。 */
export class ExecutionWaitRepository implements ExecutionWaitStore, ExecutionWaitQueryStore {
  constructor(private readonly db: Db) {}

  /** 只读取 PENDING 行（含已过期），由调用方按 `expired` 决定重推还是收敛。 */
  async listPending(
    sessionId: number,
    executionId?: string,
    maxFencingToken?: bigint,
  ): Promise<ExecutionWaitRecord[]> {
    const rows = await this.db.query<Record<string, unknown>>(
      `SELECT id, session_id, execution_id, request_type, request_id, payload_summary,
              expires_at, fencing_token, (expires_at < CURRENT_TIMESTAMP) AS expired,
              (recovered_at IS NOT NULL) AS recovered
         FROM execution_wait
        WHERE session_id = ?
          AND status = 'PENDING'
          ${executionId == null ? '' : 'AND execution_id = ?'}
          ${maxFencingToken == null ? '' : 'AND fencing_token <= ?'}
        ORDER BY id ASC`,
      [
        sessionId,
        ...(executionId == null ? [] : [executionId]),
        ...(maxFencingToken == null ? [] : [maxFencingToken.toString()]),
      ],
    );
    return rows.map(mapWaitRow);
  }

  /** Task / Session 详情只展示当前仍可解释的等待：未过期且尚未被回答 / 审批。 */
  async findEarliestPending(sessionId: number, executionId?: string): Promise<ExecutionWaitRecord | null> {
    const row = await this.db.queryOne<Record<string, unknown>>(
      `SELECT id, session_id, execution_id, request_type, request_id, payload_summary,
              expires_at, fencing_token, (expires_at < CURRENT_TIMESTAMP) AS expired,
              (recovered_at IS NOT NULL) AS recovered
         FROM execution_wait
        WHERE session_id = ?
          AND status = 'PENDING'
          AND expires_at >= CURRENT_TIMESTAMP
          ${executionId == null ? '' : 'AND execution_id = ?'}
        ORDER BY expires_at ASC, id ASC
        LIMIT 1`,
      executionId == null ? [sessionId] : [sessionId, executionId],
    );
    return row == null ? null : mapWaitRow(row);
  }

  async countPendingBySessionIds(sessionIds: number[]): Promise<Map<number, ExecutionWaitCounts>> {
    const ids = [...new Set(sessionIds.filter((id) => Number.isSafeInteger(id) && id > 0))];
    const counts = new Map<number, ExecutionWaitCounts>();
    if (ids.length === 0) return counts;
    const rows = await this.db.query<Record<string, unknown>>(
      `SELECT session_id, request_type, COUNT(*) AS cnt
         FROM execution_wait
        WHERE session_id IN (${ids.map(() => '?').join(', ')})
          AND status = 'PENDING'
          AND expires_at >= CURRENT_TIMESTAMP
        GROUP BY session_id, request_type`,
      ids,
    );
    for (const row of rows) {
      const sessionId = Number(row.sessionId);
      const current = counts.get(sessionId) ?? { approval: 0, question: 0 };
      if (row.requestType === 'APPROVAL') current.approval = Number(row.cnt ?? 0);
      else if (row.requestType === 'QUESTION') current.question = Number(row.cnt ?? 0);
      counts.set(sessionId, current);
    }
    return counts;
  }

  /**
   * 标记恢复通知。`recovered_at IS NULL` 保证重复扫描不重复返回同一行；
   * 返回的 ID 才允许推送，避免重启后把旧通知反复当成本轮新事件。
   */
  async markRecovered(ids: number[], maxFencingToken?: bigint): Promise<number[]> {
    const unique = [...new Set(ids.filter((id) => Number.isSafeInteger(id) && id > 0))];
    if (unique.length === 0) return [];
    return this.db.transaction(async (tx) => {
      const placeholders = unique.map(() => '?').join(', ');
      const rows = await tx.query<{ id: number | string }>(
        `SELECT id
           FROM execution_wait
          WHERE id IN (${placeholders})
            AND status = 'PENDING'
            AND expires_at >= CURRENT_TIMESTAMP
            AND recovered_at IS NULL
            ${maxFencingToken == null ? '' : 'AND fencing_token <= ?'}
          FOR UPDATE`,
        [...unique, ...(maxFencingToken == null ? [] : [maxFencingToken.toString()])],
      );
      const matched = rows.map((row) => Number(row.id));
      if (matched.length === 0) return [];
      await tx.execute(
        `UPDATE execution_wait
            SET recovered_at = CURRENT_TIMESTAMP
          WHERE id IN (${matched.map(() => '?').join(', ')})
            AND status = 'PENDING'
            AND recovered_at IS NULL`,
        matched,
      );
      return matched;
    });
  }

  /**
   * 把仍未处理的等待置为 EXPIRED。token 只增不减，恢复方用本次 claim 的
   * token 作为上界，既覆盖历史 token=0 的行，也不会误伤未来执行写入的请求。
   */
  async expire(id: number, maxFencingToken?: bigint): Promise<boolean> {
    const result = await this.db.execute(
      `UPDATE execution_wait
          SET status = 'EXPIRED', released_at = CURRENT_TIMESTAMP, release_reason = 'TIMEOUT'
        WHERE id = ? AND status = 'PENDING'
          ${maxFencingToken == null ? '' : 'AND fencing_token <= ?'}`,
      maxFencingToken == null ? [id] : [id, maxFencingToken.toString()],
    );
    return result.affectedRows > 0;
  }

  async hasPending(sessionId: number, executionId?: string): Promise<boolean> {
    const row = await this.db.queryOne<{ matched: number | string }>(
      `SELECT 1 AS matched
         FROM execution_wait
        WHERE session_id = ?
          AND status = 'PENDING'
          AND expires_at >= CURRENT_TIMESTAMP
          ${executionId == null ? '' : 'AND execution_id = ?'}
        LIMIT 1`,
      executionId == null ? [sessionId] : [sessionId, executionId],
    );
    return row != null;
  }

  async insertPending(input: PendingWaitInsert): Promise<void> {
    await this.db.execute(
      `INSERT INTO execution_wait
        (session_id, execution_id, request_type, request_id, status, payload_summary, payload_digest,
         expires_at, fencing_token)
       VALUES (?, ?, ?, ?, 'PENDING', ?, ?, DATE_ADD(CURRENT_TIMESTAMP, INTERVAL 960 SECOND), ?)
       ON DUPLICATE KEY UPDATE id = id`,
      [
        input.sessionId,
        input.executionId,
        input.requestType,
        input.requestId,
        input.payloadSummary,
        input.payloadDigest,
        (input.fencingToken ?? 0n).toString(),
      ],
    );
  }

  async release(
    sessionId: number,
    requestType: TaskWaitKind,
    requestId: string,
    reason: TaskWaitReleaseReason,
  ): Promise<boolean> {
    const result = await this.db.execute(
      `UPDATE execution_wait
          SET status = 'RELEASED', released_at = CURRENT_TIMESTAMP, release_reason = ?
        WHERE session_id = ? AND request_type = ? AND request_id = ? AND status = 'PENDING'`,
      [reason, sessionId, requestType, requestId],
    );
    return result.affectedRows > 0;
  }

  async releaseAllPending(
    sessionId: number,
    reason: TaskWaitReleaseReason,
    maxFencingToken?: bigint,
  ): Promise<number> {
    const result = await this.db.execute(
      `UPDATE execution_wait
          SET status = 'RELEASED', released_at = CURRENT_TIMESTAMP, release_reason = ?
        WHERE session_id = ? AND status = 'PENDING'
          ${maxFencingToken == null ? '' : 'AND fencing_token <= ?'}`,
      maxFencingToken == null
        ? [reason, sessionId]
        : [reason, sessionId, maxFencingToken.toString()],
    );
    return result.affectedRows;
  }
}

function mapWaitRow(row: Record<string, unknown>): ExecutionWaitRecord {
  return {
    id: Number(row.id),
    sessionId: Number(row.sessionId),
    executionId: String(row.executionId),
    requestType: String(row.requestType) as TaskWaitKind,
    requestId: String(row.requestId),
    payloadSummary: String(row.payloadSummary ?? ''),
    expiresAt: String(row.expiresAt ?? ''),
    fencingToken: BigInt(String(row.fencingToken ?? 0)),
    expired: row.expired === true || Number(row.expired) === 1,
    recovered: row.recovered === true || Number(row.recovered) === 1,
  };
}

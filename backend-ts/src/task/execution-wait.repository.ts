import type { Db } from '../db/db.js';
import type { TaskWaitKind, TaskWaitReleaseReason } from '@mao/contracts';

export interface PendingWaitInsert {
  sessionId: number;
  executionId: string;
  requestType: TaskWaitKind;
  requestId: string;
  payloadSummary: string;
  payloadDigest: string;
}

export interface ExecutionWaitStore {
  insertPending(input: PendingWaitInsert): Promise<void>;
  release(
    sessionId: number,
    requestType: TaskWaitKind,
    requestId: string,
    reason: TaskWaitReleaseReason,
  ): Promise<boolean>;
}

/** `execution_wait` 的最小写入面；过期判断统一使用数据库时间。 */
export class ExecutionWaitRepository implements ExecutionWaitStore {
  constructor(private readonly db: Db) {}

  async insertPending(input: PendingWaitInsert): Promise<void> {
    await this.db.execute(
      `INSERT INTO execution_wait
        (session_id, execution_id, request_type, request_id, status, payload_summary, payload_digest,
         expires_at, fencing_token)
       VALUES (?, ?, ?, ?, 'PENDING', ?, ?, DATE_ADD(CURRENT_TIMESTAMP, INTERVAL 960 SECOND), 0)
       ON DUPLICATE KEY UPDATE id = id`,
      [
        input.sessionId,
        input.executionId,
        input.requestType,
        input.requestId,
        input.payloadSummary,
        input.payloadDigest,
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
}

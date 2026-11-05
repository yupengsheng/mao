import type { Db } from '../db/db.js';
import type { OpenCallOutcome, OpenCallSource } from './open-api-call-log.logic.js';

export interface OpenApiCallLogRow {
  id?: number;
  tokenId?: number | null;
  triggerId?: number | null;
  agentId?: number | null;
  userId?: number | null;
  sessionId?: number | null;
  messageId?: number | null;
  source?: string | null;
  idempotencyScope?: string | null;
  idempotencyKey?: string | null;
  requestFingerprint?: string | null;
  sourceIp?: string | null;
  tokenPrefix?: string | null;
  requestSummaryJson?: string | null;
  requestFullJson?: string | null;
  httpStatus?: number | null;
  outcome?: string | null;
  replayOfId?: number | null;
  errorCode?: string | null;
  errorSummary?: string | null;
  durationMs?: number | null;
  queueWaitMs?: number | null;
  executionMs?: number | null;
  createdAt?: string | null;
  finishedAt?: string | null;
  tokenName?: string | null;
  triggerName?: string | null;
  agentName?: string | null;
  username?: string | null;
  displayName?: string | null;
}

export interface CallLogListFilter {
  userId?: number;
  tokenId?: number;
  triggerId?: number;
  agentId?: number;
  outcome?: string;
  source?: string;
  httpStatus?: number;
  startAt?: string;
  endAt?: string;
}

export interface CallLogBucketRow {
  bucket: string | number | null;
  total: number;
  completed: number;
  failed: number;
  cancelled: number;
  rejected: number;
  inFlight: number;
  unknown: number;
}

export interface OpenApiCallLogRepairCandidate {
  id: number;
  outcome: string;
  sessionId: number | null;
  userId: number | null;
  source: string | null;
  tokenId: number | null;
  replayOfId: number | null;
  createdAt: string | null;
}

export interface LockedSessionRow {
  id?: number;
  userId?: number | null;
  phase?: string | null;
  deleted?: number | null;
}

const LIST_COLUMNS = `
  l.id, l.token_id, l.trigger_id, l.agent_id, l.user_id, l.session_id, l.message_id,
  l.source, l.source_ip, l.token_prefix, l.request_summary_json, l.http_status, l.outcome,
  l.replay_of_id, l.error_code, l.error_summary, l.duration_ms, l.queue_wait_ms, l.execution_ms,
  l.created_at, l.finished_at,
  t.name AS token_name, w.name AS trigger_name, a.name AS agent_name,
  u.username AS username, u.display_name AS display_name
`;

const DETAIL_COLUMNS = `${LIST_COLUMNS}, l.request_full_json`;

function whereOf(filter: CallLogListFilter): { sql: string; params: unknown[] } {
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (filter.userId != null) { clauses.push('l.user_id = ?'); params.push(filter.userId); }
  if (filter.tokenId != null) { clauses.push('l.token_id = ?'); params.push(filter.tokenId); }
  if (filter.triggerId != null) { clauses.push('l.trigger_id = ?'); params.push(filter.triggerId); }
  if (filter.agentId != null) { clauses.push('l.agent_id = ?'); params.push(filter.agentId); }
  if (filter.outcome != null && filter.outcome !== '') { clauses.push('l.outcome = ?'); params.push(filter.outcome); }
  if (filter.source != null && filter.source !== '') { clauses.push('l.source = ?'); params.push(filter.source); }
  if (filter.httpStatus != null) { clauses.push('l.http_status = ?'); params.push(filter.httpStatus); }
  if (filter.startAt != null) { clauses.push('l.created_at >= ?'); params.push(filter.startAt); }
  if (filter.endAt != null) { clauses.push('l.created_at <= ?'); params.push(filter.endAt); }
  return { sql: clauses.length === 0 ? '' : `WHERE ${clauses.join(' AND ')}`, params };
}

const JOINS = `
  FROM open_api_call_log l
  LEFT JOIN api_token t ON t.id = l.token_id
  LEFT JOIN webhook_trigger w ON w.id = l.trigger_id
  LEFT JOIN agent a ON a.id = l.agent_id
  LEFT JOIN \`user\` u ON u.id = l.user_id
`;

export class OpenApiCallLogRepository {
  constructor(private readonly db: Db) {}

  transaction<T>(work: (repo: OpenApiCallLogRepository) => Promise<T>): Promise<T> {
    return this.db.transaction((db) => work(new OpenApiCallLogRepository(db)));
  }

  insert(row: {
    tokenId?: number | null;
    triggerId?: number | null;
    agentId?: number | null;
    userId?: number | null;
    sessionId?: number | null;
    source: OpenCallSource;
    sourceIp?: string | null;
    tokenPrefix?: string | null;
    requestSummaryJson?: string | null;
    requestFullJson?: string | null;
    httpStatus?: number | null;
    outcome: OpenCallOutcome;
    replayOfId?: number | null;
    errorCode?: string | null;
    errorSummary?: string | null;
    durationMs?: number | null;
    executionMs?: number | null;
    finishedAt?: string | null;
    idempotencyScope?: string | null;
    idempotencyKey?: string | null;
    requestFingerprint?: string | null;
  }): Promise<number> {
    return this.db.insert('open_api_call_log', {
      tokenId: row.tokenId ?? null,
      triggerId: row.triggerId ?? null,
      agentId: row.agentId ?? null,
      userId: row.userId ?? null,
      sessionId: row.sessionId ?? null,
      source: row.source,
      idempotencyScope: row.idempotencyScope ?? null,
      idempotencyKey: row.idempotencyKey ?? null,
      requestFingerprint: row.requestFingerprint ?? null,
      sourceIp: row.sourceIp ?? null,
      tokenPrefix: row.tokenPrefix ?? null,
      requestSummaryJson: row.requestSummaryJson ?? null,
      requestFullJson: row.requestFullJson ?? null,
      httpStatus: row.httpStatus ?? null,
      outcome: row.outcome,
      replayOfId: row.replayOfId ?? null,
      errorCode: row.errorCode ?? null,
      errorSummary: row.errorSummary ?? null,
      durationMs: row.durationMs ?? null,
      executionMs: row.executionMs ?? null,
      finishedAt: row.finishedAt ?? null,
    });
  }

  findByIdempotency(scope: string, key: string): Promise<OpenApiCallLogRow | null> {
    return this.db.queryOne<OpenApiCallLogRow>(
      'SELECT * FROM open_api_call_log WHERE idempotency_scope = ? AND idempotency_key = ? LIMIT 1',
      [scope, key],
    );
  }

  async markFinished(id: number, patch: {
    outcome: OpenCallOutcome;
    httpStatus: number | null;
    errorCode: string | null;
    errorSummary: string | null;
    durationMs: number | null;
    executionMs: number | null;
    finishedAt: string | null;
    sessionId?: number | null;
    messageId?: number | null;
    queueWaitMs?: number | null;
  }): Promise<boolean> {
    const result = await this.db.execute(
      `UPDATE open_api_call_log
       SET outcome = ?, http_status = ?, error_code = ?, error_summary = ?,
           duration_ms = ?, execution_ms = ?, finished_at = ?,
           session_id = COALESCE(?, session_id),
           message_id = COALESCE(?, message_id),
           queue_wait_ms = COALESCE(?, queue_wait_ms)
       WHERE id = ? AND outcome IN ('pending', 'queued')`,
      [
        patch.outcome, patch.httpStatus, patch.errorCode, patch.errorSummary,
        patch.durationMs, patch.executionMs, patch.finishedAt,
        patch.sessionId ?? null, patch.messageId ?? null, patch.queueWaitMs ?? null,
        id,
      ],
    );
    return result.affectedRows === 1;
  }

  /**
   * 排队终态。execution_ms 用库内 created_at 到 NOW()，避免应用时钟与 DATETIME 字符串互解析。
   * 已是终态的行影响 0 行。
   */
  async settleQueued(id: number, outcome: OpenCallOutcome, queueWaitMs: number | null, messageId: number | null, finishedAt: string): Promise<boolean> {
    const result = await this.db.execute(
      `UPDATE open_api_call_log
       SET outcome = ?, finished_at = ?,
           execution_ms = TIMESTAMPDIFF(MICROSECOND, created_at, ?) DIV 1000,
           queue_wait_ms = ?,
           message_id = COALESCE(?, message_id)
       WHERE id = ? AND outcome IN ('pending', 'queued')`,
      [outcome, finishedAt, finishedAt, queueWaitMs, messageId, id],
    );
    return result.affectedRows === 1;
  }

  /** 修复滞留流水。CAS 语义与正常回写一致，谁先落终态谁生效。 */
  async settleStale(id: number, patch: {
    outcome: OpenCallOutcome;
    errorCode: string | null;
    errorSummary: string | null;
    finishedAt: string;
  }): Promise<boolean> {
    const result = await this.db.execute(
      `UPDATE open_api_call_log
       SET outcome = ?, finished_at = ?,
           execution_ms = TIMESTAMPDIFF(MICROSECOND, created_at, ?) DIV 1000,
           error_code = ?, error_summary = ?
       WHERE id = ? AND outcome IN ('pending', 'queued')`,
      [patch.outcome, patch.finishedAt, patch.finishedAt, patch.errorCode, patch.errorSummary, id],
    );
    return result.affectedRows === 1;
  }

  /**
   * 超时且队列里已没有待执行消息的流水。pending 且无 session_id 时仍在直跑，
   * 无法从数据库判断是否崩溃，因此不进入候选。
   */
  listRepairCandidates(staleBefore: string, limit: number): Promise<OpenApiCallLogRepairCandidate[]> {
    return this.db.query<OpenApiCallLogRepairCandidate>(
      `SELECT l.id, l.outcome, l.session_id, l.user_id, l.source, l.token_id,
              l.replay_of_id, l.created_at
         FROM open_api_call_log l
         LEFT JOIN \`session\` s ON s.id = l.session_id
        WHERE l.outcome IN ('pending', 'queued')
          AND l.created_at < ?
          AND (l.session_id IS NOT NULL OR l.outcome = 'queued')
          AND NOT EXISTS (
            SELECT 1 FROM message_queue mq
             WHERE mq.open_call_log_id = l.id
               AND mq.status = 'PENDING'
               AND mq.deleted = 0
          )
          AND (
            (s.id IS NOT NULL AND s.deleted = 0 AND s.phase IN ('COMPLETED', 'FAILED', 'CANCELLED'))
            OR (l.outcome = 'queued' AND (s.id IS NULL OR s.deleted <> 0))
          )
        ORDER BY l.created_at ASC, l.id ASC
        LIMIT ?`,
      [staleBefore, limit],
    );
  }

  lockById(id: number): Promise<OpenApiCallLogRow | null> {
    return this.db.queryOne<OpenApiCallLogRow>(
      'SELECT * FROM open_api_call_log WHERE id = ? FOR UPDATE',
      [id],
    );
  }

  lockSession(id: number): Promise<LockedSessionRow | null> {
    return this.db.queryOne<LockedSessionRow>(
      'SELECT * FROM `session` WHERE id = ? FOR UPDATE',
      [id],
    );
  }

  async hasPendingQueue(openCallLogId: number): Promise<boolean> {
    const row = await this.db.queryOne<{ id: number }>(
      `SELECT id FROM message_queue
        WHERE open_call_log_id = ? AND status = 'PENDING' AND deleted = 0
        LIMIT 1`,
      [openCallLogId],
    );
    return row != null;
  }

  findById(id: number, userId?: number): Promise<OpenApiCallLogRow | null> {
    const params: unknown[] = [id];
    let userClause = '';
    if (userId != null) {
      userClause = ' AND l.user_id = ?';
      params.push(userId);
    }
    return this.db.queryOne<OpenApiCallLogRow>(
      `SELECT ${DETAIL_COLUMNS} ${JOINS} WHERE l.id = ?${userClause}`,
      params,
    );
  }

  async list(filter: CallLogListFilter, page: number, size: number): Promise<{ records: OpenApiCallLogRow[]; total: number }> {
    const where = whereOf(filter);
    const totalRow = await this.db.queryOne<{ total: number }>(
      `SELECT COUNT(*) AS total ${JOINS} ${where.sql}`,
      where.params,
    );
    const offset = (page - 1) * size;
    const records = await this.db.query<OpenApiCallLogRow>(
      `SELECT ${LIST_COLUMNS} ${JOINS} ${where.sql} ORDER BY l.created_at DESC, l.id DESC LIMIT ? OFFSET ?`,
      [...where.params, size, offset],
    );
    return { records, total: Number(totalRow?.total ?? 0) };
  }

  /**
   * inFlight：pending/queued 且（未满 2 小时，或 message_queue 里仍有 PENDING 绑定）。
   * unknown：pending/queued、已满 2 小时、且队列里已经没有这条流水的 PENDING 行。
   */
  async aggregate(filter: CallLogListFilter, granularity: 'day' | 'token', unknownBefore: string): Promise<CallLogBucketRow[]> {
    const where = whereOf(filter);
    const bucketExpr = granularity === 'token' ? 'l.token_id' : 'DATE(l.created_at)';
    const pendingQueue = `EXISTS (
      SELECT 1 FROM message_queue mq
      WHERE mq.open_call_log_id = l.id AND mq.status = 'PENDING' AND mq.deleted = 0
    )`;
    return this.db.query<CallLogBucketRow>(
      `SELECT ${bucketExpr} AS bucket,
              COUNT(*) AS total,
              SUM(l.outcome = 'completed') AS completed,
              SUM(l.outcome = 'failed') AS failed,
              SUM(l.outcome = 'cancelled') AS cancelled,
              SUM(l.outcome = 'rejected') AS rejected,
              SUM(l.outcome IN ('pending','queued') AND (l.created_at >= ? OR ${pendingQueue})) AS inFlight,
              SUM(l.outcome IN ('pending','queued') AND l.created_at < ? AND NOT ${pendingQueue}) AS unknown
       ${JOINS} ${where.sql}
       GROUP BY ${bucketExpr}
       ORDER BY bucket`,
      [unknownBefore, unknownBefore, ...where.params],
    );
  }

  async sampleLatencies(filter: CallLogListFilter, limit: number): Promise<Array<{ executionMs: number | null; queueWaitMs: number | null }>> {
    const where = whereOf(filter);
    const outcome = where.sql.length === 0
      ? `WHERE l.outcome IN ('completed','failed')`
      : `${where.sql} AND l.outcome IN ('completed','failed')`;
    return this.db.query(
      `SELECT l.execution_ms AS executionMs, l.queue_wait_ms AS queueWaitMs
       FROM open_api_call_log l ${outcome}
       ORDER BY l.id DESC LIMIT ?`,
      [...where.params, limit],
    );
  }

  async trafficByToken(): Promise<Array<{ tokenId: number | null; today: number; prev7: number }>> {
    return this.db.query(
      `SELECT token_id AS tokenId,
              SUM(created_at >= CURDATE() AND created_at < CURDATE() + INTERVAL 1 DAY) AS today,
              SUM(created_at >= CURDATE() - INTERVAL 7 DAY AND created_at < CURDATE()) AS prev7
       FROM open_api_call_log
       WHERE token_id IS NOT NULL AND created_at >= CURDATE() - INTERVAL 7 DAY
       GROUP BY token_id`,
    );
  }

  async deleteBatch(cutoff: string, limit: number): Promise<number> {
    const safeLimit = Math.max(1, Math.min(5000, Math.floor(limit)));
    const result = await this.db.execute(
      `DELETE FROM open_api_call_log WHERE created_at < ? ORDER BY id LIMIT ${safeLimit}`,
      [cutoff],
    );
    return result.affectedRows;
  }
}

export function isDuplicateKey(err: unknown): boolean {
  if (typeof err !== 'object' || err == null) return false;
  const value = err as { code?: string; errno?: number };
  return value.code === 'ER_DUP_ENTRY' || value.errno === 1062;
}

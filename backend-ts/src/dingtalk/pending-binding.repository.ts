import type { Db } from '../db/db.js';
import type { DingtalkNormalizedMessage } from './types.js';

export type DingtalkPendingBindingMethod = 'OAUTH' | 'PASSWORD';

export interface DingtalkPendingBindingMessage {
  state: string;
  botId: number;
  event: DingtalkNormalizedMessage;
  expiresAt?: string | Date | null;
  bindingMethod?: DingtalkPendingBindingMethod;
  status?: string;
}

export class MysqlDingtalkPendingBindingRepository {
  constructor(private readonly db: Db) {}

  async insert(row: DingtalkPendingBindingMessage, expiresAt: Date): Promise<void> {
    await this.db.insert('dingtalk_pending_binding_message', {
      state: row.state,
      botId: row.botId,
      payload: JSON.stringify(row.event),
      status: row.status ?? 'PENDING',
      bindingMethod: row.bindingMethod ?? 'OAUTH',
      expiresAt,
    });
  }

  async markSent(state: string): Promise<void> {
    await this.db.execute(
      "UPDATE dingtalk_pending_binding_message SET status = 'SENT' WHERE state = ? AND status = 'PENDING'",
      [state],
    );
  }

  async fail(state: string): Promise<void> {
    await this.db.execute(
      "UPDATE dingtalk_pending_binding_message SET status = 'FAILED' WHERE state = ? AND status IN ('PENDING', 'SENT', 'CLAIMED')",
      [state],
    );
  }

  async complete(state: string): Promise<void> {
    await this.db.execute(
      "UPDATE dingtalk_pending_binding_message SET status = 'COMPLETED' WHERE state = ? AND status = 'CLAIMED'",
      [state],
    );
  }

  async release(state: string): Promise<void> {
    await this.db.execute(
      "UPDATE dingtalk_pending_binding_message SET status = 'SENT' WHERE state = ? AND status = 'CLAIMED'",
      [state],
    );
  }

  async findByState(state: string): Promise<DingtalkPendingBindingMessage | null> {
    const row = await this.db.queryOne<Record<string, unknown>>(
      "SELECT * FROM dingtalk_pending_binding_message WHERE state = ? AND status = 'SENT' AND expires_at > CURRENT_TIMESTAMP LIMIT 1",
      [state],
    );
    if (row == null) return null;
    return {
      state: String(row.state),
      botId: Number(row.botId),
      event: JSON.parse(String(row.payload)) as DingtalkNormalizedMessage,
      expiresAt: row.expiresAt == null ? (row.expires_at == null ? null : String(row.expires_at)) : row.expiresAt as string | Date,
      bindingMethod: row.bindingMethod == null
        ? (row.binding_method == null ? 'OAUTH' : String(row.binding_method) as DingtalkPendingBindingMethod)
        : String(row.bindingMethod) as DingtalkPendingBindingMethod,
      status: String(row.status),
    };
  }

  async claim(state: string): Promise<DingtalkPendingBindingMessage | null> {
    const row = await this.db.queryOne<Record<string, unknown>>(
      "SELECT * FROM dingtalk_pending_binding_message WHERE state = ? AND status = 'SENT' AND expires_at > CURRENT_TIMESTAMP LIMIT 1",
      [state],
    );
    if (row == null) return null;
    const result = await this.db.execute(
      "UPDATE dingtalk_pending_binding_message SET status = 'CLAIMED' WHERE state = ? AND status = 'SENT' AND expires_at > CURRENT_TIMESTAMP",
      [state],
    );
    if (result.affectedRows !== 1) return null;
    return {
      state: String(row.state),
      botId: Number(row.botId),
      event: JSON.parse(String(row.payload)) as DingtalkNormalizedMessage,
      expiresAt: row.expiresAt == null ? (row.expires_at == null ? null : String(row.expires_at)) : row.expiresAt as string | Date,
      bindingMethod: row.bindingMethod == null
        ? (row.binding_method == null ? 'OAUTH' : String(row.binding_method) as DingtalkPendingBindingMethod)
        : String(row.bindingMethod) as DingtalkPendingBindingMethod,
      status: 'CLAIMED',
    };
  }

  /** 按过期时间分批删除历史待绑定消息，走 idx_dingtalk_pending_binding_expires。 */
  async deleteBatch(cutoff: string, limit: number): Promise<number> {
    const safeLimit = Math.max(1, Math.min(5000, Math.floor(limit)));
    const result = await this.db.execute(
      `DELETE FROM dingtalk_pending_binding_message WHERE expires_at < ? ORDER BY id LIMIT ${safeLimit}`,
      [cutoff],
    );
    return result.affectedRows;
  }
}

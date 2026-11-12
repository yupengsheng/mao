import { notDeleted, type Db } from '../db/db.js';
import type { DingtalkBot, DingtalkBotRepository } from './types.js';

/** 转义 LIKE 通配符，保证关键词按字面量匹配。 */
function escapeLike(keyword: string): string {
  return keyword.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
}

export class MysqlDingtalkBotRepository implements DingtalkBotRepository {
  constructor(private readonly db: Db) {}

  list(): Promise<DingtalkBot[]> {
    return this.db.query<DingtalkBot>(`SELECT * FROM dingtalk_bot WHERE ${notDeleted()} ORDER BY created_at DESC`);
  }

  async listPage(
    pageNum: number,
    pageSize: number,
    keyword?: string | null,
  ): Promise<{ records: DingtalkBot[]; total: number }> {
    const where = [notDeleted()];
    const params: unknown[] = [];
    if (keyword) {
      where.push('(name LIKE ? OR client_id LIKE ? OR robot_code LIKE ?)');
      const pattern = `%${escapeLike(keyword)}%`;
      params.push(pattern, pattern, pattern);
    }
    const whereSql = where.join(' AND ');
    const totalRow = await this.db.queryOne<{ c: number }>(
      `SELECT COUNT(*) AS c FROM dingtalk_bot WHERE ${whereSql}`,
      params,
    );
    const records = await this.db.query<DingtalkBot>(
      `SELECT * FROM dingtalk_bot WHERE ${whereSql} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
      [...params, pageSize, (pageNum - 1) * pageSize],
    );
    return { records, total: Number(totalRow?.c ?? 0) };
  }

  findById(id: number): Promise<DingtalkBot | null> {
    return this.db.queryOne<DingtalkBot>(`SELECT * FROM dingtalk_bot WHERE id = ? AND ${notDeleted()}`, [id]);
  }

  findByAppKey(appKey: string): Promise<DingtalkBot | null> {
    return this.db.queryOne<DingtalkBot>(`SELECT * FROM dingtalk_bot WHERE app_key = ? AND ${notDeleted()}`, [appKey]);
  }

  async create(bot: DingtalkBot): Promise<number> {
    const id = await this.db.insert('dingtalk_bot', {
      appKey: bot.appKey,
      name: bot.name,
      clientId: bot.clientId,
      clientSecret: bot.clientSecret,
      robotCode: bot.robotCode,
      agentId: bot.agentId ?? null,
      modelId: bot.modelId ?? null,
      cardTemplateId: bot.cardTemplateId ?? null,
      enabled: bot.enabled ?? 1,
      deleted: 0,
    });
    bot.id = id;
    return id;
  }

  async update(bot: DingtalkBot): Promise<void> {
    if (bot.id == null) return;
    await this.db.updateById('dingtalk_bot', bot.id, {
      appKey: bot.appKey,
      name: bot.name,
      clientId: bot.clientId,
      clientSecret: bot.clientSecret,
      robotCode: bot.robotCode,
      agentId: bot.agentId ?? null,
      modelId: bot.modelId ?? null,
      cardTemplateId: bot.cardTemplateId ?? null,
      enabled: bot.enabled ?? 1,
    });
  }

  async softDelete(id: number): Promise<void> {
    await this.db.updateById('dingtalk_bot', id, { deleted: 1, enabled: 0 });
  }
}

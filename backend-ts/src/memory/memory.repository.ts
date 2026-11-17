import type { Db } from '../db/db.js';
import { nowSql } from '../common/datetime.js';
import { hasText } from '../common/case.js';
import { BusinessException } from '../common/business-exception.js';
import { ErrorCode } from '../common/error-code.js';
import type { MemoryItemRow, MemoryListQuery, UserMemoryPreferenceRow } from './types.js';

/** 捕获 uk_memory_dedup 唯一键冲突（并发抽取同事实时转为更新分支）。 */
export function isDuplicateKeyError(e: unknown): boolean {
  return typeof e === 'object' && e != null && (e as { errno?: number }).errno === 1062;
}

/** 转义 LIKE 通配符（与 command.repository escapeLike 语义一致），配合 ESCAPE '\\' 反斜杠转义。 */
function escapeLike(keyword: string): string {
  return keyword.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
}

export class MemoryRepository {
  constructor(private readonly db: Db) {}

  /** 所有记忆写入共享稳定用户行锁；先取锁再读记忆，不能在等待锁前建立一致性快照。 */
  withUserLock<T>(userId: number, fn: (db: Db) => Promise<T>): Promise<T> {
    return this.db.transaction(async (tx) => {
      const user = await tx.queryOne<{ id: number }>('SELECT id FROM `user` WHERE id = ? FOR UPDATE', [userId]);
      if (user == null) throw new BusinessException(ErrorCode.USER_NOT_FOUND);
      return fn(tx);
    });
  }

  async page(query: MemoryListQuery): Promise<MemoryItemRow[]> {
    const { where, params } = this.buildFilter(query);
    const offset = (query.page - 1) * query.pageSize;
    return this.db.query<MemoryItemRow>(
      `SELECT * FROM \`memory_item\` WHERE ${where} ORDER BY updated_at DESC, id DESC LIMIT ? OFFSET ?`,
      [...params, query.pageSize, offset],
    );
  }

  async count(query: MemoryListQuery): Promise<number> {
    const { where, params } = this.buildFilter(query);
    const row = await this.db.queryOne<{ total: number }>(
      `SELECT COUNT(*) AS total FROM \`memory_item\` WHERE ${where}`,
      params,
    );
    return row?.total ?? 0;
  }

  /** 该用户 ACTIVE 状态记忆总量（D7 限额口径，含 DISMISSED 之外的全部 scope）。 */
  async countActive(userId: number, db?: Db): Promise<number> {
    if (db) {
      // 当前读而非 RR 一致性快照；也适用于调用方事务中已经发生过其他读取的情况。
      const rows = await db.query<{ id: number }>(
        "SELECT id FROM `memory_item` WHERE user_id = ? AND status = 'ACTIVE' FOR UPDATE", [userId],
      );
      return rows.length;
    }
    const row = await this.db.queryOne<{ total: number }>(
      `SELECT COUNT(*) AS total FROM \`memory_item\` WHERE user_id = ? AND status = 'ACTIVE'`,
      [userId],
    );
    return row?.total ?? 0;
  }

  findById(id: number, db?: Db): Promise<MemoryItemRow | null> {
    return (db ?? this.db).queryOne<MemoryItemRow>(`SELECT * FROM \`memory_item\` WHERE id = ?${db ? ' FOR UPDATE' : ''}`, [id]);
  }

  findByHash(userId: number, dedupHash: string, db?: Db): Promise<MemoryItemRow | null> {
    return (db ?? this.db).queryOne<MemoryItemRow>(
      `SELECT * FROM \`memory_item\` WHERE user_id = ? AND dedup_hash = ?${db ? ' FOR UPDATE' : ''}`,
      [userId, dedupHash],
    );
  }

  async insert(row: MemoryItemRow, db?: Db): Promise<number> {
    return (db ?? this.db).insert('memory_item', {
      userId: row.userId,
      scope: row.scope,
      projectKey: row.projectKey ?? '',
      content: row.content,
      source: row.source ?? 'MANUAL',
      status: row.status ?? 'ACTIVE',
      dedupHash: row.dedupHash,
      originSessionId: row.originSessionId ?? null,
    });
  }

  async updateContent(id: number, content: string, dedupHash: string, db?: Db): Promise<void> {
    await (db ?? this.db).execute(
      'UPDATE `memory_item` SET content = ?, dedup_hash = ? WHERE id = ?',
      [content, dedupHash, id],
    );
  }

  async updateStatus(id: number, status: 'ACTIVE', db?: Db): Promise<void> {
    await (db ?? this.db).execute('UPDATE `memory_item` SET status = ? WHERE id = ?', [status, id]);
  }

  /** 状态与忽略来源必须一起写，避免恢复后再次忽略沿用旧 EVICTED 标记。 */
  async dismiss(id: number, reason: 'USER' | 'EVICTED', db?: Db): Promise<void> {
    await (db ?? this.db).execute(
      "UPDATE `memory_item` SET status = 'DISMISSED', dismiss_reason = ? WHERE id = ?",
      [reason, id],
    );
  }

  /** 自动复活只允许 DISMISSED/EVICTED；失败时调用方抛错回滚同事务内的容量淘汰。 */
  async reviveEvicted(id: number, db: Db): Promise<boolean> {
    const result = await db.execute(
      "UPDATE `memory_item` SET status = 'ACTIVE', updated_at = ? WHERE id = ? AND status = 'DISMISSED' AND dismiss_reason = 'EVICTED'",
      [nowSql(), id],
    );
    return result.affectedRows === 1;
  }

  /** 再次确认：仅刷新 updated_at，让高频事实在注入排序中稳定占据名额。 */
  async touch(id: number, db?: Db): Promise<void> {
    await (db ?? this.db).execute('UPDATE `memory_item` SET updated_at = ? WHERE id = ?', [nowSql(), id]);
  }

  async deleteById(id: number, db?: Db): Promise<void> {
    await (db ?? this.db).execute('DELETE FROM `memory_item` WHERE id = ?', [id]);
  }

  /**
   * 注入查询：USER 级 ACTIVE 按 updated_at DESC 截断（D7 上限 8 条）。
   * 内层先按「最新」截断出名额，外层再按 id ASC 输出：选择口径完全不变（仍取最新 N 条），
   * 但注入顺序稳定——否则任一条记忆被 touch（用户编辑 / 别的会话结束触发抽取）都会重排
   * 整个记忆块，打掉 system 之后的一切前缀缓存（技术方案 2026-10-12 §4.4）。
   */
  listActiveUser(userId: number, limit: number): Promise<MemoryItemRow[]> {
    return this.db.query<MemoryItemRow>(
      `SELECT * FROM (
         SELECT * FROM \`memory_item\`
          WHERE user_id = ? AND scope = 'USER' AND status = 'ACTIVE'
          ORDER BY updated_at DESC, id DESC LIMIT ?
       ) t ORDER BY t.id ASC`,
      [userId, limit],
    );
  }

  /** 注入查询：PROJECT 级 ACTIVE 按 (userId, projectKey) 定位，同序截断（D7 上限 12 条）；输出顺序同 USER 段稳定为 id ASC。 */
  listActiveProject(userId: number, projectKey: string, limit: number): Promise<MemoryItemRow[]> {
    return this.db.query<MemoryItemRow>(
      `SELECT * FROM (
         SELECT * FROM \`memory_item\`
          WHERE user_id = ? AND scope = 'PROJECT' AND project_key = ? AND status = 'ACTIVE'
          ORDER BY updated_at DESC, id DESC LIMIT ?
       ) t ORDER BY t.id ASC`,
      [userId, projectKey, limit],
    );
  }

  findPreference(userId: number): Promise<UserMemoryPreferenceRow | null> {
    return this.db.queryOne<UserMemoryPreferenceRow>(
      'SELECT * FROM `user_memory_preference` WHERE user_id = ?',
      [userId],
    );
  }

  async insertPreference(userId: number, enabled: boolean): Promise<void> {
    await this.db.insert('user_memory_preference', {
      userId,
      autoCaptureEnabled: enabled ? 1 : 0,
    });
  }

  async updatePreference(userId: number, enabled: boolean): Promise<void> {
    await this.db.execute(
      'UPDATE `user_memory_preference` SET auto_capture_enabled = ? WHERE user_id = ?',
      [enabled ? 1 : 0, userId],
    );
  }

  /** D13 比较集：某分组的 AUTO ACTIVE 行（USER 组 projectKey 传 null）。 */
  listActiveForDedup(userId: number, scope: string, projectKey?: string | null): Promise<MemoryItemRow[]> {
    const conditions = ['user_id = ?', 'scope = ?', "status = 'ACTIVE'", "source = 'AUTO'"];
    const params: unknown[] = [userId, scope];
    if (hasText(projectKey)) {
      conditions.push('project_key = ?');
      params.push(projectKey);
    }
    return this.db.query<MemoryItemRow>(
      `SELECT id, scope, project_key, content FROM \`memory_item\` WHERE ${conditions.join(' AND ')}
       ORDER BY updated_at DESC, id DESC`,
      params,
    );
  }

  /** D14 溢出淘汰源：某分组最旧的 AUTO ACTIVE 行（排除刚被本轮回改的行，其 updated_at 已刷新排在后面）。 */
  listStaleAuto(userId: number, scope: string, projectKey: string | null, limit: number, db?: Db): Promise<MemoryItemRow[]> {
    const conditions = ['user_id = ?', 'scope = ?', "status = 'ACTIVE'", "source = 'AUTO'"];
    const params: unknown[] = [userId, scope];
    if (hasText(projectKey)) {
      conditions.push('project_key = ?');
      params.push(projectKey);
    }
    return (db ?? this.db).query<MemoryItemRow>(
      `SELECT id FROM \`memory_item\` WHERE ${conditions.join(' AND ')}
       ORDER BY updated_at ASC, id ASC LIMIT ?${db ? ' FOR UPDATE' : ''}`,
      [...params, limit],
    );
  }

  /** D13 负面约束只包含用户/管理员显式忽略，系统容量淘汰不代表用户态度。 */
  listDismissedContents(userId: number, limit: number): Promise<MemoryItemRow[]> {
    return this.db.query<MemoryItemRow>(
      `SELECT content FROM \`memory_item\` WHERE user_id = ? AND status = 'DISMISSED' AND dismiss_reason = 'USER'
       ORDER BY updated_at DESC, id DESC LIMIT ?`,
      [userId, limit],
    );
  }

  private buildFilter(query: MemoryListQuery): { where: string; params: unknown[] } {
    const conditions: string[] = [];
    const params: unknown[] = [];
    if (query.userId != null) {
      conditions.push('user_id = ?');
      params.push(query.userId);
    }
    if (query.source) {
      conditions.push('source = ?');
      params.push(query.source);
    }
    if (query.updatedFrom) {
      conditions.push('updated_at >= ?');
      params.push(query.updatedFrom);
    }
    if (query.updatedTo) {
      conditions.push('updated_at <= ?');
      params.push(query.updatedTo);
    }
    if (query.scope) {
      conditions.push('scope = ?');
      params.push(query.scope);
    }
    if (query.projectKey) {
      conditions.push('project_key = ?');
      params.push(query.projectKey);
    }
    if (query.status) {
      conditions.push('status = ?');
      params.push(query.status);
    }
    const keyword = typeof query.keyword === 'string' && query.keyword.trim() !== '' ? query.keyword.trim() : null;
    if (keyword != null) {
      // 关键词按字面匹配 content / project_key；跨用户查询门槛由管理路由校验。
      conditions.push("(content LIKE CONCAT('%', ?, '%') ESCAPE '\\\\' OR project_key LIKE CONCAT('%', ?, '%') ESCAPE '\\\\')");
      const escaped = escapeLike(keyword);
      params.push(escaped, escaped);
    }
    return { where: conditions.length > 0 ? conditions.join(' AND ') : '1 = 1', params };
  }
}

import { describe, expect, it } from 'vitest';
import { Db } from '../db/db.js';
import { BusinessException } from '../common/business-exception.js';
import { ErrorCode } from '../common/error-code.js';
import { MemoryRepository } from './memory.repository.js';
import { MemoryService, computeDedupHash } from './memory.service.js';
import { MemoryExtractionService } from './memory-extraction.service.js';
import type { MemoryItemRow } from './types.js';

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
}

function memory(id: number, status = 'ACTIVE', reason = 'USER', source = 'MANUAL'): MemoryItemRow {
  const content = `事实${id}`;
  return { id, userId: 7, scope: 'USER', projectKey: '', content, status, dismissReason: reason, source,
    dedupHash: computeDedupHash('USER', '', content), updatedAt: String(id).padStart(6, '0') };
}

/**
 * 在 mysql 连接层模拟行锁、RR 快照与 commit/rollback，实际运行 Db + MemoryRepository。
 * 不 mock withUserLock/容量检查：漏 SELECT FOR UPDATE、换连接或漏传 tx 都会暴露。
 */
class MemoryDatabase {
  rows = new Map<number, MemoryItemRow>();
  events: Array<{ connection: number; sql: string }> = [];
  rollbacks = 0;
  maxActive = 0;
  nextId = 1000;
  lockAttempts = 0;
  onLockAttempt?: () => void;
  onStale?: () => Promise<void>;
  failWrite?: (sql: string) => boolean | Error;
  failCommit = false;
  rejectRevival = false;
  private lockTail = Promise.resolve();
  private nextConnection = 0;

  seed(count: number, source = 'MANUAL') {
    for (let id = 1; id <= count; id++) this.rows.set(id, memory(id, 'ACTIVE', 'USER', source));
    this.maxActive = count;
    return this;
  }

  active() { return [...this.rows.values()].filter((r) => r.status === 'ACTIVE').length; }

  db(): Db {
    return new Db({
      query: async (sql: string, params: unknown[]) => [await this.read(0, sql, params, this.rows)],
      getConnection: async () => this.connection(),
    } as never);
  }

  private connection() {
    const connection = ++this.nextConnection;
    const pending = new Map<number, MemoryItemRow | null>();
    let snapshot: Map<number, MemoryItemRow> | undefined;
    let release: (() => void) | undefined;
    const view = (base = this.rows) => {
      const result = new Map(base);
      for (const [id, row] of pending) { if (row) result.set(id, row); else result.delete(id); }
      return result;
    };
    return {
      beginTransaction: async () => undefined,
      query: async (sql: string, params: unknown[]) => {
        this.events.push({ connection, sql });
        if (sql.includes('FROM `user`')) {
          if (!sql.endsWith('FOR UPDATE')) throw new Error('user lock must be a current read');
          const previous = this.lockTail;
          const held = gate();
          this.lockTail = previous.then(() => held.promise);
          this.lockAttempts++;
          this.onLockAttempt?.();
          await previous;
          release = held.resolve;
          return [[{ id: params[0] }]];
        }
        if (sql.includes('ORDER BY updated_at ASC')) await this.onStale?.();
        // 普通 SELECT 创建且保留 RR 快照；FOR UPDATE 必须读最新已提交版本。
        if (!sql.includes('FOR UPDATE') && !snapshot) snapshot = new Map(this.rows);
        return [await this.read(connection, sql, params, view(sql.includes('FOR UPDATE') ? this.rows : snapshot))];
      },
      execute: async (sql: string, params: unknown[]) => {
        this.events.push({ connection, sql });
        if (!release) throw new Error('memory write without stable user lock');
        const failure = this.failWrite?.(sql);
        if (failure) throw failure instanceof Error ? failure : new Error('injected memory write failure');
        if (sql.startsWith('INSERT INTO')) {
          const columns = [...sql.slice(0, sql.indexOf('VALUES')).matchAll(/`([^`]+)`/g)].slice(1).map((m) => m[1]);
          const row: Record<string, unknown> = {};
          columns.forEach((column, i) => { row[column.replace(/_([a-z])/g, (_m, c: string) => c.toUpperCase())] = params[i]; });
          const id = this.nextId++;
          pending.set(id, { ...row, id } as MemoryItemRow);
          return [{ affectedRows: 1, insertId: id }];
        }
        const id = Number(params[params.length - 1]);
        const row = view().get(id);
        if (!row) return [{ affectedRows: 0 }];
        const updated = { ...row };
        if (sql.includes("AND dismiss_reason = 'EVICTED'")) {
          if (this.rejectRevival || row.status !== 'DISMISSED' || row.dismissReason !== 'EVICTED') return [{ affectedRows: 0 }];
          updated.status = 'ACTIVE'; updated.updatedAt = String(params[0]);
        } else if (sql.includes('dismiss_reason = ?')) {
          updated.status = 'DISMISSED'; updated.dismissReason = String(params[0]);
        } else if (sql.includes('SET status = ?')) {
          updated.status = String(params[0]);
        } else if (sql.includes('SET content = ?')) {
          updated.content = String(params[0]); updated.dedupHash = String(params[1]);
        } else if (sql.includes('SET updated_at = ?')) {
          updated.updatedAt = String(params[0]);
        } else if (sql.startsWith('DELETE')) {
          pending.set(id, null); return [{ affectedRows: 1 }];
        } else throw new Error(`unexpected SQL: ${sql}`);
        pending.set(id, updated);
        return [{ affectedRows: 1 }];
      },
      commit: async () => {
        if (this.failCommit) { this.failCommit = false; throw new Error('injected commit failure'); }
        this.rows = view();
        this.maxActive = Math.max(this.maxActive, this.active());
        release?.(); release = undefined;
      },
      rollback: async () => { this.rollbacks++; pending.clear(); release?.(); release = undefined; },
      release: () => undefined,
    };
  }

  private async read(connection: number, sql: string, params: unknown[], rows: Map<number, MemoryItemRow>): Promise<unknown[]> {
    if (connection === 0) this.events.push({ connection, sql });
    let result = [...rows.values()];
    if (sql.includes('WHERE id = ?')) result = result.filter((r) => r.id === params[0]);
    if (sql.includes('user_id = ?')) result = result.filter((r) => r.userId === params[0]);
    if (sql.includes('dedup_hash = ?')) result = result.filter((r) => r.dedupHash === params[1]);
    if (sql.includes("status = 'ACTIVE'")) result = result.filter((r) => r.status === 'ACTIVE');
    if (sql.includes("status = 'DISMISSED'")) result = result.filter((r) => r.status === 'DISMISSED');
    if (sql.includes("source = 'AUTO'")) result = result.filter((r) => r.source === 'AUTO');
    if (sql.includes('scope = ?')) result = result.filter((r) => r.scope === params[1]);
    if (sql.includes('project_key = ?')) result = result.filter((r) => r.projectKey === params[2]);
    if (sql.includes('COUNT(*)')) return [{ total: result.length }];
    if (sql.includes('ORDER BY updated_at ASC')) {
      result.sort((a, b) => String(a.updatedAt).localeCompare(String(b.updatedAt)) || a.id! - b.id!);
      result = result.slice(0, Number(params[params.length - 1]));
    }
    return result.map((r) => ({ ...r }));
  }
}

function services(database: MemoryDatabase, contents: string[] = ['事实501']) {
  const repository = new MemoryRepository(database.db());
  const manual = new MemoryService(repository, { listProjectKeyRows: async () => [] });
  const automatic = new MemoryExtractionService(
    { selectLastUserMessage: async () => ({ content: '请记住这是我之后所有项目一直需要使用的长期偏好和要求' }),
      selectLastAssistantMessage: async () => ({ content: '好的，我会记住。' }) },
    repository, { isAutoCaptureEnabled: async () => true }, { getValue: async () => '' },
    { selectById: async () => null, selectDefault: async () => ({ id: 3, name: 'test' } as never) },
    { chat: async () => ({ choices: [{ message: { content: JSON.stringify(contents.map((content) => ({ type: 'user', content }))) } }] }) } as never,
  );
  const extract = (sessionId = 11) => automatic.extractForSession({ sessionId, userId: 7, projectKey: null, workspace: null });
  return { repository, manual, extract };
}

describe('memory transactional concurrency', () => {
  it('serializes two restores at 199 and rechecks capacity after waiting for the user lock', async () => {
    const database = new MemoryDatabase().seed(199);
    database.rows.set(501, memory(501, 'DISMISSED'));
    database.rows.set(502, memory(502, 'DISMISSED'));
    const { manual } = services(database);
    const result = await Promise.allSettled([
      manual.update(7, 501, { status: 'ACTIVE' }), manual.updateForAdmin(502, { status: 'ACTIVE' }),
    ]);
    expect(result.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = result.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(rejected.reason).toBeInstanceOf(BusinessException);
    expect(rejected.reason.code).toBe(ErrorCode.MEMORY_LIMIT_EXCEEDED.code);
    expect(database.active()).toBe(200);
    expect(database.maxActive).toBe(200);
  });

  it.each(['create', 'restore'] as const)('manual %s and automatic insert/revival share the same DB lock', async (operation) => {
    for (const revive of [false, true]) {
      const database = new MemoryDatabase().seed(199);
      database.rows.set(502, memory(502, 'DISMISSED'));
      if (revive) database.rows.set(501, memory(501, 'DISMISSED', 'EVICTED', 'AUTO'));
      const { manual, extract } = services(database);
      await Promise.allSettled([
        operation === 'create' ? manual.createForAdmin(7, { scope: 'USER', content: '手工新增' }) : manual.updateForAdmin(502, { status: 'ACTIVE' }),
        extract(),
      ]);
      expect(database.active()).toBe(200);
      expect(database.maxActive).toBe(200);
      const connections = new Set(database.events.filter((e) => e.connection > 0).map((e) => e.connection));
      expect(connections.size).toBe(2);
      for (const connection of connections) {
        expect(database.events.find((e) => e.connection === connection)?.sql).toBe('SELECT id FROM `user` WHERE id = ? FOR UPDATE');
      }
    }
  });

  it.each([['insert', 'insert'], ['insert', 'revive'], ['revive', 'revive']] as const)('independent automatic %s/%s writers cannot oversubscribe 199 slots', async (first, second) => {
    const database = new MemoryDatabase().seed(199);
    if (first === 'revive') database.rows.set(501, memory(501, 'DISMISSED', 'EVICTED', 'AUTO'));
    if (second === 'revive') database.rows.set(502, memory(502, 'DISMISSED', 'EVICTED', 'AUTO'));
    const a = services(database, ['事实501']);
    const b = services(database, ['事实502']);
    await Promise.all([a.extract(11), b.extract(12)]);
    expect(database.active()).toBe(200);
    expect(database.maxActive).toBe(200);
    expect(database.lockAttempts).toBe(2);
  });

  it('uses current reads even if an RR snapshot has already been established', async () => {
    const database = new MemoryDatabase().seed(199);
    const { repository } = services(database);
    await repository.withUserLock(7, async (tx) => {
      const snapshot = await tx.queryOne<{ total: number }>("SELECT COUNT(*) AS total FROM `memory_item` WHERE user_id = ? AND status = 'ACTIVE'", [7]);
      expect(snapshot?.total).toBe(199);
      // 模拟此前已建立快照：旧式 COUNT 在 RR 下仍是 199，当前读必须看到 200。
      database.rows.set(500, memory(500));
      expect(await repository.countActive(7, tx)).toBe(200);
      const stale = await tx.queryOne<{ total: number }>("SELECT COUNT(*) AS total FROM `memory_item` WHERE user_id = ? AND status = 'ACTIVE'", [7]);
      expect(stale?.total).toBe(199);
    });
  });

  it('admin ignore cannot be overwritten while automatic revival waits in freeSlotFor', async () => {
    const database = new MemoryDatabase().seed(200, 'AUTO');
    database.rows.set(501, memory(501, 'DISMISSED', 'EVICTED', 'AUTO'));
    const { manual, extract } = services(database);
    const freeing = gate(); const proceed = gate(); const adminWaiting = gate();
    database.onStale = async () => { freeing.resolve(); await proceed.promise; };
    database.onLockAttempt = () => { if (database.lockAttempts === 2) adminWaiting.resolve(); };
    const automatic = extract();
    await freeing.promise;
    const admin = manual.updateForAdmin(501, { status: 'DISMISSED' });
    await adminWaiting.promise;
    proceed.resolve();
    await Promise.all([automatic, admin]);
    expect(database.rows.get(501)).toMatchObject({ status: 'DISMISSED', dismissReason: 'USER' });
  });

  it('rechecks EVICTED under the lock after admin ignore commits first', async () => {
    const database = new MemoryDatabase().seed(200, 'AUTO');
    database.rows.set(501, memory(501, 'DISMISSED', 'EVICTED', 'AUTO'));
    const { repository, manual, extract } = services(database);
    const locked = gate(); const proceed = gate();
    const holder = repository.withUserLock(7, async () => { locked.resolve(); await proceed.promise; });
    await locked.promise;
    const admin = manual.updateForAdmin(501, { status: 'DISMISSED' });
    const waiting = gate();
    database.onLockAttempt = () => { if (database.lockAttempts === 3) waiting.resolve(); };
    const automatic = extract();
    await waiting.promise; proceed.resolve();
    await Promise.all([holder, admin, automatic]);
    expect(database.rows.get(501)).toMatchObject({ status: 'DISMISSED', dismissReason: 'USER' });
    expect(database.active()).toBe(200);
    expect(database.events.some((e) => e.sql.includes("SET status = 'ACTIVE'"))).toBe(false);
  });

  it.each(['write', 'condition', 'commit'] as const)('rolls back eviction when revival %s fails', async (failure) => {
    const database = new MemoryDatabase().seed(200, 'AUTO');
    database.rows.set(501, memory(501, 'DISMISSED', 'EVICTED', 'AUTO'));
    if (failure === 'write') database.failWrite = (sql) => sql.includes("SET status = 'ACTIVE'");
    if (failure === 'condition') database.rejectRevival = true;
    if (failure === 'commit') database.failCommit = true;
    await services(database).extract();
    expect(database.rollbacks).toBe(1);
    expect(database.active()).toBe(200);
    expect(database.rows.get(1)?.status).toBe('ACTIVE');
    expect(database.rows.get(501)?.status).toBe('DISMISSED');
  });

  it('failed candidate does not consume eviction budget and later candidates can still commit', async () => {
    const database = new MemoryDatabase().seed(200, 'AUTO');
    for (const id of [501, 502, 503]) database.rows.set(id, memory(id, 'DISMISSED', 'EVICTED', 'AUTO'));
    let attempts = 0;
    database.failWrite = (sql) => sql.includes("SET status = 'ACTIVE'") && ++attempts === 1;
    await services(database, ['事实501', '事实502', '事实503']).extract();
    expect(database.rollbacks).toBe(1);
    expect(database.rows.get(501)?.status).toBe('DISMISSED');
    expect(database.rows.get(502)?.status).toBe('ACTIVE');
    expect(database.rows.get(503)?.status).toBe('ACTIVE');
    expect(database.active()).toBe(200);
    // 首次淘汰被回滚，后两次只淘汰两行，不留下额外容量缺口。
    expect([...database.rows.values()].filter((r) => r.id! <= 200 && r.status === 'DISMISSED')).toHaveLength(2);
  });

  it('a rolled-back duplicate retry does not spend the three committed-eviction budget', async () => {
    const database = new MemoryDatabase().seed(200, 'AUTO');
    let inserts = 0;
    database.failWrite = (sql) => sql.startsWith('INSERT INTO') && ++inserts === 1
      ? Object.assign(new Error('injected duplicate key'), { errno: 1062 }) : false;
    await services(database, ['新事实一', '新事实二', '新事实三']).extract();
    expect(database.rollbacks).toBe(1);
    expect(inserts).toBe(4);
    expect(database.active()).toBe(200);
    expect([...database.rows.values()].filter((r) => r.id! <= 200 && r.status === 'DISMISSED')).toHaveLength(3);
    expect(database.rows.size).toBe(203);
  });

  it('failed automatic insert rolls back the eviction too', async () => {
    const database = new MemoryDatabase().seed(200, 'AUTO');
    database.failWrite = (sql) => sql.startsWith('INSERT INTO');
    await services(database).extract();
    expect(database.rollbacks).toBe(1);
    expect(database.active()).toBe(200);
    expect(database.rows.get(1)?.status).toBe('ACTIVE');
    expect(database.rows.size).toBe(200);
  });
});

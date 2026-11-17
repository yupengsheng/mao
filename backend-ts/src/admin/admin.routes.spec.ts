import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { handleError } from '../common/http-error.js';
import { registerAdminAnalyticsRoutes, registerAdminRuntimeRoutes } from './admin.routes.js';
import type { AdminRouteDeps } from './admin.routes.js';
import { BusinessException } from '../common/business-exception.js';
import { ErrorCode } from '../common/error-code.js';
import { recordAudit, shouldAudit } from '../audit/audit.interceptor.js';
import type { AuditLogService } from '../audit/audit.service.js';
import type { MemoryItemVO } from '../memory/types.js';

describe('admin memory management and audit', () => {
  function memoryApp(options: { permissions?: string[]; auditor?: boolean; lookup?: boolean } = {}) {
    const fastify = Fastify();
    fastify.setErrorHandler(handleError);
    fastify.addHook('preHandler', (req, _reply, done) => { req.userId = 7; done(); });
    const record = vi.fn(async () => undefined);
    // 与生产 onResponse 同样交给全局审计器，不在记忆路由重复写审计。
    fastify.addHook('onResponse', async (req, reply) => {
      await recordAudit({ record } as unknown as AuditLogService, {
        method: req.method, path: req.url.split('?')[0], queryString: req.url.split('?')[1],
        status: reply.statusCode, userId: req.userId,
      });
    });
    const listForAdmin = vi.fn(async () => ({ records: [] as MemoryItemVO[], total: 0, current: 1, size: 20 }));
    const memory: MemoryItemVO = {
      id: 1, userId: 8, scope: 'USER', projectKey: null, content: 'k', source: 'MANUAL', status: 'ACTIVE',
      originSessionId: null, createdAt: null, updatedAt: null,
    };
    const updateForAdmin = vi.fn(async () => memory);
    const removeForAdmin = vi.fn(async () => undefined);
    const createForAdmin = vi.fn(async () => ({ ...memory, id: 2 }));
    const findByIds = vi.fn(async () => [{ id: 8, username: 'bob', displayName: 'Bob' }]);
    const search = vi.fn(async () => [{ id: 8, username: 'bob', displayName: 'Bob', email: 'private@example.com' }]);
    const hasPermission = vi.fn(async (_id: number, code: string) => (options.permissions ?? ['memory:read', 'memory:write']).includes(code));
    registerAdminRuntimeRoutes(fastify, {
      jwt: {} as never, analytics: {} as never, permissionService: { hasPermission },
      memoryAuditor: options.auditor === false ? undefined : { listForAdmin, updateForAdmin, removeForAdmin, createForAdmin },
      memoryUserLookup: options.lookup === false ? undefined : { findByIds, search },
    } as AdminRouteDeps);
    return { fastify, listForAdmin, updateForAdmin, removeForAdmin, createForAdmin, findByIds, search, hasPermission, record };
  }

  it('filters and paginates cross-user queries with batched user enrichment', async () => {
    const a = memoryApp();
    a.listForAdmin.mockResolvedValueOnce({ records: [8, 9, 8].map((userId, i): MemoryItemVO => ({
      id: i + 1, userId, scope: 'USER', projectKey: null, content: 'k', source: 'AUTO', status: 'ACTIVE',
      originSessionId: 4, createdAt: null, updatedAt: null,
    })), total: 3, current: 2, size: 50 });
    const res = await a.fastify.inject({ method: 'GET', url: '/v1/admin/memory?keyword=%20abc%20&source=AUTO&scope=USER&projectKey=mao&status=ACTIVE&updatedFrom=2026-11-01&updatedTo=2026-11-11&page=2&pageSize=50' });
    expect(res.json().code).toBe(0);
    expect(a.listForAdmin).toHaveBeenCalledWith({
      userId: null, keyword: 'abc', source: 'AUTO', scope: 'USER', projectKey: 'mao', status: 'ACTIVE',
      updatedFrom: '2026-11-01 00:00:00', updatedTo: '2026-11-11 23:59:59', page: 2, pageSize: 50,
    });
    expect(a.findByIds).toHaveBeenCalledTimes(1);
    expect(a.findByIds).toHaveBeenCalledWith([8, 9]);
    expect(res.json().data.records[0]).toMatchObject({ username: 'bob', displayName: 'Bob' });
    await a.fastify.close();
  });

  it('single-user query works without other filters and repeated query params use first value', async () => {
    const a = memoryApp();
    await a.fastify.inject({ method: 'GET', url: '/v1/admin/memory?userId=8&page=Infinity&pageSize=999' });
    expect(a.listForAdmin).toHaveBeenLastCalledWith(expect.objectContaining({ userId: 8, page: 1, pageSize: 100 }));
    await a.fastify.inject({ method: 'GET', url: '/v1/admin/memory?keyword=a&keyword=b' });
    expect(a.listForAdmin).toHaveBeenLastCalledWith(expect.objectContaining({ keyword: 'a' }));
    await a.fastify.close();
  });

  it('rejects unfiltered cross-user scans, invalid owner/enums/dates and reversed dates', async () => {
    const a = memoryApp();
    for (const query of ['', '?updatedFrom=2026-11-01', '?userId=abc', '?userId=-1', '?userId=1.5',
      '?source=invalid', '?keyword=k&scope=invalid', '?keyword=k&status=invalid',
      '?keyword=k&updatedFrom=2026-02-30', '?keyword=k&updatedTo=11/01/2026',
      '?keyword=k&updatedFrom=2026-11-10&updatedTo=2026-11-01']) {
      const res = await a.fastify.inject({ method: 'GET', url: `/v1/admin/memory${query}` });
      expect(res.json().code, query).toBe(ErrorCode.PARAM_INVALID.code);
    }
    expect(a.listForAdmin).not.toHaveBeenCalled();
    await a.fastify.close();
  });

  it('user search requires memory:read only and returns no private user fields', async () => {
    const a = memoryApp({ permissions: ['memory:read'] });
    const res = await a.fastify.inject({ method: 'GET', url: '/v1/admin/memory/users?keyword=bob&pageSize=10' });
    expect(a.search).toHaveBeenCalledWith('bob', 10);
    expect(res.json().data.records).toEqual([{ id: 8, username: 'bob', displayName: 'Bob' }]);
    expect(a.hasPermission).toHaveBeenCalledWith(7, 'memory:read');
    await a.fastify.close();
  });

  it('read-only role cannot edit/delete/create and write-only role cannot read', async () => {
    const a = memoryApp({ permissions: ['memory:read'] });
    for (const [method, url, payload] of [
      ['PATCH', '/v1/admin/memory/1', { content: 'x' }], ['DELETE', '/v1/admin/memory/1', undefined],
      ['POST', '/v1/admin/memory', { userId: 8, scope: 'USER', content: 'x' }],
    ] as const) {
      expect((await a.fastify.inject({ method, url, payload })).statusCode).toBe(403);
    }
    expect(a.updateForAdmin).not.toHaveBeenCalled();
    expect(a.removeForAdmin).not.toHaveBeenCalled();
    expect(a.createForAdmin).not.toHaveBeenCalled();
    await a.fastify.close();
    const b = memoryApp({ permissions: ['memory:write'] });
    for (const url of ['/v1/admin/memory?userId=8', '/v1/admin/memory/users']) {
      expect((await b.fastify.inject({ method: 'GET', url })).statusCode).toBe(403);
    }
    expect(b.listForAdmin).not.toHaveBeenCalled();
    expect(b.search).not.toHaveBeenCalled();
    await b.fastify.close();
  });

  it('edit/status/delete derive target from id and create checks target user exists', async () => {
    const a = memoryApp();
    for (const status of ['DISMISSED', 'ACTIVE']) {
      const res = await a.fastify.inject({ method: 'PATCH', url: '/v1/admin/memory/1', payload: { status } });
      expect(res.json().code).toBe(0);
      expect(a.updateForAdmin).toHaveBeenLastCalledWith(1, { content: null, status });
    }
    await a.fastify.inject({ method: 'PATCH', url: '/v1/admin/memory/1', payload: { content: 'x' } });
    expect(a.updateForAdmin).toHaveBeenLastCalledWith(1, { content: 'x', status: null });
    await a.fastify.inject({ method: 'DELETE', url: '/v1/admin/memory/1' });
    expect(a.removeForAdmin).toHaveBeenCalledWith(1);
    const created = await a.fastify.inject({ method: 'POST', url: '/v1/admin/memory', payload: { userId: 8, scope: 'USER', content: 'x' } });
    expect(created.json().code).toBe(0);
    expect(a.createForAdmin).toHaveBeenCalledWith(8, { scope: 'USER', content: 'x', projectKey: null });
    a.findByIds.mockResolvedValueOnce([]);
    const missing = await a.fastify.inject({ method: 'POST', url: '/v1/admin/memory', payload: { userId: 999, scope: 'USER', content: 'x' } });
    expect(missing.json().code).toBe(ErrorCode.USER_NOT_FOUND.code);
    expect(a.createForAdmin).toHaveBeenCalledTimes(1);
    await a.fastify.close();
  });

  it('rejects malformed payloads and ownership spoofing without coercion', async () => {
    const a = memoryApp();
    for (const payload of [{ content: 1 }, { content: [] }, { status: false }, { content: 'x', userId: 8 }, {}]) {
      const res = await a.fastify.inject({ method: 'PATCH', url: '/v1/admin/memory/1', payload });
      expect(res.json().code).toBe(ErrorCode.PARAM_INVALID.code);
    }
    for (const payload of [{ userId: true, scope: 'USER', content: 'x' }, { userId: 8, scope: 'USER', content: {} },
      { userId: 8, scope: 1, content: 'x' }, { userId: 8, scope: 'PROJECT', content: 'x', projectKey: [] }]) {
      const res = await a.fastify.inject({ method: 'POST', url: '/v1/admin/memory', payload });
      expect(res.json().code).toBe(ErrorCode.PARAM_INVALID.code);
    }
    for (const method of ['PATCH', 'DELETE'] as const) {
      const res = await a.fastify.inject({ method, url: '/v1/admin/memory/abc', payload: method === 'PATCH' ? { content: 'x' } : undefined });
      expect(res.json().code).toBe(ErrorCode.MEMORY_ITEM_NOT_FOUND.code);
    }
    expect(a.updateForAdmin).not.toHaveBeenCalled();
    expect(a.createForAdmin).not.toHaveBeenCalled();
    expect(a.removeForAdmin).not.toHaveBeenCalled();
    await a.fastify.close();
  });

  it('business failures propagate and missing dependencies fail explicitly on reads too', async () => {
    const a = memoryApp();
    for (const error of [ErrorCode.MEMORY_CONTENT_DUPLICATE, ErrorCode.MEMORY_LIMIT_EXCEEDED]) {
      a.updateForAdmin.mockRejectedValueOnce(new BusinessException(error));
      const res = await a.fastify.inject({ method: 'PATCH', url: '/v1/admin/memory/1', payload: { content: 'x' } });
      expect(res.json().code).toBe(error.code);
    }
    await a.fastify.close();
    for (const options of [{ auditor: false }, { lookup: false }]) {
      const b = memoryApp(options);
      for (const [method, url, payload] of [
        ['GET', '/v1/admin/memory?userId=8', undefined], ['GET', '/v1/admin/memory/users', undefined],
        ['PATCH', '/v1/admin/memory/1', { content: 'x' }], ['DELETE', '/v1/admin/memory/1', undefined],
        ['POST', '/v1/admin/memory', { userId: 8, scope: 'USER', content: 'x' }],
      ] as const) {
        const res = await b.fastify.inject({ method, url, payload });
        expect(res.json().code).toBe(ErrorCode.INTERNAL_ERROR.code);
      }
      await b.fastify.close();
    }
  });

  it('all memory operations stay covered by global audit including denied writes', async () => {
    const a = memoryApp();
    for (const [method, url, payload, action, objectId] of [
      ['GET', '/v1/admin/memory?userId=8', undefined, 'READ', null],
      ['GET', '/v1/admin/memory/users', undefined, 'READ', null],
      ['POST', '/v1/admin/memory', { userId: 8, scope: 'USER', content: 'x' }, 'CREATE', null],
      ['PATCH', '/v1/admin/memory/12', { status: 'DISMISSED' }, 'UPDATE', '12'],
      ['DELETE', '/v1/admin/memory/12', undefined, 'DELETE', '12'],
    ] as const) {
      expect(shouldAudit(url, method)).toBe(true);
      await a.fastify.inject({ method, url, payload });
      expect(a.record).toHaveBeenLastCalledWith(expect.objectContaining({ userId: 7, action, objectType: 'admin.memory', objectId, success: 1 }));
    }
    await a.fastify.close();
    const denied = memoryApp({ permissions: ['memory:read'] });
    await denied.fastify.inject({ method: 'DELETE', url: '/v1/admin/memory/12' });
    expect(denied.record).toHaveBeenCalledWith(expect.objectContaining({ status: 403, success: 0, userId: 7, action: 'DELETE' }));
    await denied.fastify.close();
  });
});

const RUN_TRACE_PAYLOAD = {
  period: {},
  scene: 'agent',
  scope: 'agent',
  slowestRounds: [],
  mostExpensiveRounds: [],
  toolFailureRates: [],
};

async function app(runTraceScope = vi.fn(async () => RUN_TRACE_PAYLOAD)) {
  const fastify = Fastify();
  fastify.setErrorHandler(handleError);
  fastify.addHook('preHandler', (req, _r, done) => {
    (req as unknown as { userId: number }).userId = 7;
    done();
  });
  registerAdminAnalyticsRoutes(fastify, {
    jwt: {} as never,
    analytics: { runTraceScope } as never,
    userRepo: {} as never,
    permissionService: { hasPermission: vi.fn(async () => true) },
  } as never);
  return { fastify, runTraceScope };
}

describe('admin analytics run-trace route', () => {
  it('reads scene / scope exactly as the admin UI and mao-cli send them', async () => {
    const { fastify, runTraceScope } = await app();

    // 管理后台 AnalyticsView.currentQuery() 只发 scene + scope（缺省 agent/agent）
    const res = await fastify.inject({ method: 'GET', url: '/v1/admin/analytics/run-trace?days=7&scene=agent&scope=user' });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).code).toBe(0);
    expect(runTraceScope).toHaveBeenCalledWith(7, 0, { scene: 'agent', scope: 'user', limit: 20 });

    // 不传时回落到 scene=agent / scope=agent
    vi.mocked(runTraceScope).mockClear();
    await fastify.inject({ method: 'GET', url: '/v1/admin/analytics/run-trace' });
    expect(runTraceScope).toHaveBeenCalledWith(30, 0, { scene: 'agent', scope: 'agent', limit: 20 });

    // scope 只认 user，其余值回落 agent，不把任意字符串透给服务端
    vi.mocked(runTraceScope).mockClear();
    await fastify.inject({ method: 'GET', url: '/v1/admin/analytics/run-trace?scope=whatever' });
    expect(runTraceScope).toHaveBeenCalledWith(30, 0, { scene: 'agent', scope: 'agent', limit: 20 });

    await fastify.close();
  });

  it('requires analytics:read', async () => {
    const runTraceScope = vi.fn(async () => RUN_TRACE_PAYLOAD);
    const fastify = Fastify();
    fastify.setErrorHandler(handleError);
    fastify.addHook('preHandler', (req, _r, done) => {
      (req as unknown as { userId: number }).userId = 7;
      done();
    });
    registerAdminAnalyticsRoutes(fastify, {
      jwt: {} as never,
      analytics: { runTraceScope } as never,
      userRepo: {} as never,
      permissionService: { hasPermission: vi.fn(async () => false) },
    } as never);
    const denied = await fastify.inject({ method: 'GET', url: '/v1/admin/analytics/run-trace' });
    expect(denied.statusCode).toBe(403);
    expect(runTraceScope).not.toHaveBeenCalled();
    await fastify.close();
  });
});

describe('admin analytics user/agent pagination params', () => {
  async function pagedApp() {
    const usersScope = vi.fn(async () => ({ userActivity: [], pagination: {} }));
    const agentsScope = vi.fn(async () => ({ agentStats: [], pagination: {} }));
    const fastify = Fastify();
    fastify.setErrorHandler(handleError);
    fastify.addHook('preHandler', (req, _r, done) => {
      (req as unknown as { userId: number }).userId = 7;
      done();
    });
    registerAdminAnalyticsRoutes(fastify, {
      jwt: {} as never,
      analytics: { usersScope, agentsScope } as never,
      userRepo: {} as never,
      permissionService: { hasPermission: vi.fn(async () => true) },
    } as never);
    return { fastify, usersScope, agentsScope };
  }

  it('透传 page/pageSize，并对非法值回落与上限截断', async () => {
    const { fastify, usersScope, agentsScope } = await pagedApp();

    await fastify.inject({ method: 'GET', url: '/v1/admin/analytics/users?days=7&page=2&pageSize=50' });
    expect(usersScope).toHaveBeenCalledWith(7, 0, 20, {
      excludeConnectivity: true,
      page: 2,
      pageSize: 50,
    });

    await fastify.inject({ method: 'GET', url: '/v1/admin/analytics/agents?days=7&page=abc&pageSize=999' });
    expect(agentsScope).toHaveBeenCalledWith(7, 0, 20, {
      excludeConnectivity: true,
      page: 1,
      pageSize: 100,
    });

    await fastify.close();
  });

  it('不传分页参数时时保留 undefined，服务端继续按 limit 走旧 Top-N', async () => {
    const { fastify, usersScope } = await pagedApp();

    await fastify.inject({ method: 'GET', url: '/v1/admin/analytics/users?days=7&limit=30' });
    expect(usersScope).toHaveBeenCalledWith(7, 0, 30, {
      excludeConnectivity: true,
      page: undefined,
      pageSize: undefined,
    });

    await fastify.close();
  });
});

describe('admin analytics range param', () => {
  // 只 fake Date：shanghaiYmd() 走系统时钟，固定到 2026-10-29（周四）中午让窗口断言稳定
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-29T04:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  async function overviewApp() {
    const overview = vi.fn(async () => ({ period: {} }));
    const fastify = Fastify();
    fastify.setErrorHandler(handleError);
    fastify.addHook('preHandler', (req, _r, done) => {
      (req as unknown as { userId: number }).userId = 7;
      done();
    });
    registerAdminAnalyticsRoutes(fastify, {
      jwt: {} as never,
      analytics: { overview } as never,
      userRepo: {} as never,
      permissionService: { hasPermission: vi.fn(async () => true) },
    } as never);
    return { fastify, overview };
  }

  it('总览默认排除自检并透传显式包含选项', async () => {
    const { fastify, overview } = await overviewApp();
    for (const [query, excludeConnectivity] of [['', true], ['?excludeConnectivity=false', false]] as const) {
      overview.mockClear();
      const res = await fastify.inject({ method: 'GET', url: `/v1/admin/analytics/overview${query}` });
      expect(res.statusCode).toBe(200);
      expect(overview).toHaveBeenCalledWith(30, 0, { excludeConnectivity });
    }
    await fastify.close();
  });

  it('日历周期解析成 (days, endOffset) 交给服务端窗口计算', async () => {
    const { fastify, overview } = await overviewApp();

    // 本周 = 周一 10-26 起 4 天；上周 = 10-19 ~ 10-25；本月 = 1 日至今 29 天；上月 = 9 月整月
    for (const [query, expected] of [
      ['range=week', [4, 0]],
      ['range=lastWeek', [7, 10]],
      ['range=month', [29, 0]],
      ['range=lastMonth', [30, 29]],
      ['range=today', [1, 0]],
      ['range=yesterday', [1, 1]],
    ] as const) {
      vi.mocked(overview).mockClear();
      const res = await fastify.inject({ method: 'GET', url: `/v1/admin/analytics/overview?${query}` });
      expect(res.statusCode, query).toBe(200);
      expect(vi.mocked(overview).mock.calls[0].slice(0, 2), query).toEqual(expected);
    }

    await fastify.close();
  });

  it('自定义区间按下发起止日换算，缺日期回落默认 30 天', async () => {
    const { fastify, overview } = await overviewApp();

    await fastify.inject({
      method: 'GET',
      url: '/v1/admin/analytics/overview?range=custom&start=2026-10-01&end=2026-10-15',
    });
    expect(vi.mocked(overview).mock.calls[0].slice(0, 2)).toEqual([15, 14]);

    // 半截区间（前端两个日期必填，这里防直接调用）→ 回落默认窗口
    vi.mocked(overview).mockClear();
    await fastify.inject({ method: 'GET', url: '/v1/admin/analytics/overview?range=custom&start=2026-10-01' });
    expect(vi.mocked(overview).mock.calls[0].slice(0, 2)).toEqual([30, 0]);

    await fastify.close();
  });

  it('不传 range 时仍按 days/endOffset 取数（mao-cli 兼容）', async () => {
    const { fastify, overview } = await overviewApp();

    await fastify.inject({ method: 'GET', url: '/v1/admin/analytics/overview?days=7&endOffset=1' });
    expect(vi.mocked(overview).mock.calls[0].slice(0, 2)).toEqual([7, 1]);

    // range 与 days 同时给时语义周期优先
    vi.mocked(overview).mockClear();
    await fastify.inject({ method: 'GET', url: '/v1/admin/analytics/overview?range=week&days=7' });
    expect(vi.mocked(overview).mock.calls[0].slice(0, 2)).toEqual([4, 0]);

    await fastify.close();
  });
});

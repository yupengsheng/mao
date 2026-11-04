import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { BusinessException } from '../common/business-exception.js';
import { ErrorCode } from '../common/error-code.js';
import { handleError } from '../common/http-error.js';
import type { ApiTokenAuthedRequest } from '../auth/jwt-hook.js';
import { apiRequestFingerprint } from './open-api-call-log.logic.js';
import { registerOpenApiRoutes } from './open.routes.js';

interface HarnessOptions {
  scopes?: string[];
  rateAllowed?: boolean;
  callLog?: boolean;
}

async function makeHarness(options: HarnessOptions = {}) {
  const app = Fastify();
  app.setErrorHandler(handleError);
  app.addHook('preHandler', async (request) => {
    const req = request as ApiTokenAuthedRequest;
    req.userId = 7;
    req.apiTokenScopes = options.scopes ?? ['open:run'];
    req.apiTokenId = 3;
  });

  const openRunRun = vi.fn(async () => ({
    sessionId: 11,
    messageId: 12,
    queued: false,
    terminalPhase: 'COMPLETED' as const,
  }));
  const begin = vi.fn(async () => ({ id: 9, startedAt: 100, duplicate: false }));
  const markAccepted = vi.fn(async () => undefined);
  const markRejected = vi.fn(async () => undefined);
  const recordDirect = vi.fn(async () => undefined);
  const rateAllow = vi.fn(() => ({
    allowed: options.rateAllowed ?? true,
    retryAfterSeconds: 42,
  }));

  registerOpenApiRoutes(app, {
    apiPrefix: '/api',
    openRun: { run: openRunRun } as never,
    apiTokenService: {} as never,
    triggerService: {} as never,
    subscriptionService: {} as never,
    rateLimiter: { allow: rateAllow } as never,
    callLog: options.callLog === false
      ? null
      : { begin, markAccepted, markRejected, recordDirect } as never,
  });

  return { app, openRunRun, begin, markAccepted, markRejected, recordDirect, rateAllow };
}

function runRequest(overrides: { headers?: Record<string, string>; payload?: Record<string, unknown> } = {}) {
  return {
    method: 'POST' as const,
    url: '/v1/open/agents/5/run',
    headers: overrides.headers,
    payload: overrides.payload ?? { message: 'hi' },
  };
}

describe('开放 API run 幂等路由', () => {
  it('首次带键成功：按 token 作用域登记语义指纹并执行一次', async () => {
    const h = await makeHarness();
    try {
      const res = await h.app.inject(runRequest({ headers: { 'idempotency-key': 'build-42' } }));
      expect(res.statusCode).toBe(202);
      expect(res.json()).toMatchObject({
        code: 0,
        data: { sessionId: 11, messageId: 12, queued: false },
      });
      expect(h.begin).toHaveBeenCalledWith(expect.objectContaining({
        idempotencyScope: 'token:3',
        idempotencyKey: 'build-42',
        requestFingerprint: apiRequestFingerprint(5, null, 'hi'),
      }));
      expect(h.openRunRun).toHaveBeenCalledTimes(1);
      expect(h.markAccepted).toHaveBeenCalledWith(9, 100, expect.objectContaining({ sessionId: 11 }));
    } finally {
      await h.app.close();
    }
  });

  it('重复成功返回首次结果并标记 deduplicated，不再执行 Agent', async () => {
    const h = await makeHarness();
    h.begin.mockResolvedValue({
      id: 9,
      startedAt: 100,
      duplicate: true,
      row: { id: 9, outcome: 'completed', sessionId: 11, messageId: 12 },
    });
    try {
      const res = await h.app.inject(runRequest({ headers: { 'idempotency-key': 'build-42' } }));
      expect(res.statusCode).toBe(202);
      expect(res.json()).toMatchObject({
        code: 0,
        data: { sessionId: 11, messageId: 12, queued: false, deduplicated: true },
      });
      expect(h.openRunRun).not.toHaveBeenCalled();
      expect(h.markAccepted).not.toHaveBeenCalled();
      expect(h.markRejected).not.toHaveBeenCalled();
    } finally {
      await h.app.close();
    }
  });

  it.each([
    ['pending', false],
    ['queued', true],
  ])('重复 %s 请求返回 processing 且不再次执行', async (outcome, queued) => {
    const h = await makeHarness();
    h.begin.mockResolvedValue({
      id: 9,
      startedAt: 100,
      duplicate: true,
      row: { id: 9, outcome, sessionId: 11, messageId: null },
    });
    try {
      const res = await h.app.inject(runRequest({ headers: { 'idempotency-key': 'build-42' } }));
      expect(res.statusCode).toBe(202);
      expect(res.json()).toMatchObject({
        code: 0,
        data: { sessionId: 11, queued, processing: true, deduplicated: true },
      });
      expect(h.openRunRun).not.toHaveBeenCalled();
    } finally {
      await h.app.close();
    }
  });

  it('已拒绝的幂等键不可复用，且不会覆盖首次拒绝结果', async () => {
    const h = await makeHarness();
    h.begin.mockResolvedValue({
      id: 9,
      startedAt: 100,
      duplicate: true,
      row: { id: 9, outcome: 'rejected', sessionId: null, messageId: null },
    });
    try {
      const res = await h.app.inject(runRequest({ headers: { 'idempotency-key': 'build-42' } }));
      expect(res.json().code).toBe(ErrorCode.PARAM_INVALID.code);
      expect(h.openRunRun).not.toHaveBeenCalled();
      expect(h.markRejected).not.toHaveBeenCalled();
    } finally {
      await h.app.close();
    }
  });

  it('同键不同请求指纹由流水层拒绝，不执行 Agent 也不改写流水', async () => {
    const h = await makeHarness();
    h.begin.mockRejectedValue(new BusinessException(ErrorCode.PARAM_INVALID, '幂等键已用于其他请求'));
    try {
      const res = await h.app.inject(runRequest({
        headers: { 'idempotency-key': 'build-42' },
        payload: { message: 'changed' },
      }));
      expect(res.json().code).toBe(ErrorCode.PARAM_INVALID.code);
      expect(h.begin).toHaveBeenCalledTimes(1);
      expect(h.openRunRun).not.toHaveBeenCalled();
      expect(h.markRejected).not.toHaveBeenCalled();
    } finally {
      await h.app.close();
    }
  });

  it('参数校验失败会标记首次流水为 rejected，重复请求不再执行', async () => {
    const h = await makeHarness();
    try {
      const res = await h.app.inject(runRequest({
        headers: { 'idempotency-key': 'build-42' },
        payload: { message: 42 },
      }));
      expect(res.json().code).toBe(ErrorCode.PARAM_INVALID.code);
      expect(h.markRejected).toHaveBeenCalledWith(9, 100, expect.any(BusinessException));
      expect(h.openRunRun).not.toHaveBeenCalled();
    } finally {
      await h.app.close();
    }
  });

  it('scope 拒绝发生在登记之前，不创建流水', async () => {
    const h = await makeHarness({ scopes: ['open:read'] });
    try {
      const res = await h.app.inject(runRequest({ headers: { 'idempotency-key': 'build-42' } }));
      expect(res.statusCode).toBe(403);
      expect(res.json().code).toBe(ErrorCode.FORBIDDEN.code);
      expect(h.rateAllow).not.toHaveBeenCalled();
      expect(h.begin).not.toHaveBeenCalled();
      expect(h.recordDirect).not.toHaveBeenCalled();
    } finally {
      await h.app.close();
    }
  });

  it('限流拒绝只记直接拒绝流水，不创建幂等行', async () => {
    const h = await makeHarness({ rateAllowed: false });
    try {
      const res = await h.app.inject(runRequest({ headers: { 'idempotency-key': 'build-42' } }));
      expect(res.statusCode).toBe(429);
      expect(res.headers['retry-after']).toBe('42');
      expect(h.recordDirect).toHaveBeenCalledWith(expect.objectContaining({ httpStatus: 429, errorCode: 'RATE_LIMITED' }));
      expect(h.begin).not.toHaveBeenCalled();
      expect(h.openRunRun).not.toHaveBeenCalled();
    } finally {
      await h.app.close();
    }
  });

  it('带幂等键但流水服务不可用时 fail closed，不执行 Agent', async () => {
    const h = await makeHarness({ callLog: false });
    try {
      const res = await h.app.inject(runRequest({ headers: { 'idempotency-key': 'build-42' } }));
      expect(res.json().code).toBe(ErrorCode.INTERNAL_ERROR.code);
      expect(h.openRunRun).not.toHaveBeenCalled();
    } finally {
      await h.app.close();
    }
  });
});

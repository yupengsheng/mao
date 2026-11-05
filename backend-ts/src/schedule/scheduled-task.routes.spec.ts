import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { handleError } from '../common/http-error.js';
import { registerScheduledTaskRoutes } from './scheduled-task.routes.js';

function createApp(service: Record<string, unknown>, permission?: Record<string, unknown>) {
  const app = Fastify();
  app.setErrorHandler(handleError);
  registerScheduledTaskRoutes(app, {
    jwt: {
      validateAccessToken: () => true,
      getUserIdFromToken: () => 7,
    } as never,
    service: service as never,
    permission: permission as never,
  });
  return app;
}

describe('scheduled task run history routes', () => {
  it('paginates runs and exposes x-total-count', async () => {
    const listRunsPage = vi.fn(async () => ({ records: [{ id: 9, taskId: 5 }], total: 42 }));
    const app = createApp({
      getById: vi.fn(async () => ({ id: 5, userId: 7 })),
      listRunsPage,
    });

    const res = await app.inject({
      method: 'GET',
      url: '/v1/scheduled-tasks/5/runs?pageNum=2&pageSize=10',
      headers: { authorization: 'Bearer t' },
    });

    expect(JSON.parse(res.body).data).toEqual([{ id: 9, taskId: 5 }]);
    expect(res.headers['x-total-count']).toBe('42');
    expect(listRunsPage).toHaveBeenCalledWith(5, 7, 2, 10, { allowNonOwner: false });
    await app.close();
  });

  it('keeps the legacy limit behavior when no page params are sent', async () => {
    const listRuns = vi.fn(async () => [{ id: 1, taskId: 5 }]);
    const app = createApp({
      getById: vi.fn(async () => ({ id: 5, userId: 7 })),
      listRuns,
    });

    const res = await app.inject({
      method: 'GET',
      url: '/v1/scheduled-tasks/5/runs?limit=7',
      headers: { authorization: 'Bearer t' },
    });

    expect(JSON.parse(res.body).data).toEqual([{ id: 1, taskId: 5 }]);
    expect(res.headers['x-total-count']).toBeUndefined();
    expect(listRuns).toHaveBeenCalledWith(5, 7, 7, { allowNonOwner: false });
    await app.close();
  });

  it('checks cross-user permission before querying runs', async () => {
    const listRunsPage = vi.fn(async () => ({ records: [], total: 0 }));
    const app = createApp({
      getById: vi.fn(async () => ({ id: 5, userId: 9 })),
      listRunsPage,
    }, { hasPermission: vi.fn(async () => false) });

    const res = await app.inject({
      method: 'GET',
      url: '/v1/scheduled-tasks/5/runs?pageNum=1&pageSize=20',
      headers: { authorization: 'Bearer t' },
    });

    expect(JSON.parse(res.body).code).toBe(3026);
    expect(listRunsPage).not.toHaveBeenCalled();
    await app.close();
  });
});

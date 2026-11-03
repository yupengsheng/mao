import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { handleError } from '../common/http-error.js';
import { registerTaskRoutes } from './task.routes.js';
import type { TaskService } from './task.service.js';

const apps: ReturnType<typeof Fastify>[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map((app) => app.close())); });

function fixture(userId: number | null = 7, token = false) {
  const app = Fastify();
  apps.push(app);
  app.setErrorHandler(handleError);
  app.addHook('preHandler', async (request) => {
    Object.assign(request, { userId: userId ?? undefined, ...(token ? { apiTokenScopes: ['run'] } : {}) });
  });
  const service = {
    page: vi.fn(async (filter) => ({ items: [], total: 0, page: filter.page, size: filter.size })),
    get: vi.fn(async () => null),
  };
  registerTaskRoutes(app, service as unknown as TaskService);
  return { app, service };
}

describe('Task query API', () => {
  it('scopes valid filters to authenticated owner', async () => {
    const { app, service } = fixture();
    const result = await app.inject('/v1/tasks?stage=FAILED&source=WEBHOOK&agentId=2&sessionId=11&page=2&size=10&userId=9');
    expect(result.json().code).toBe(0);
    expect(service.page).toHaveBeenCalledWith({ userId: 7, stage: 'FAILED', source: 'WEBHOOK', agentId: 2, sessionId: 11, page: 2, size: 10 });
  });

  it.each(['stage=UNKNOWN', 'source=web', 'page=1.5', 'size=-1', 'agentId=abc', 'sessionId=0', 'page=Infinity', 'size=101'])('rejects invalid query %s', async (query) => {
    const { app, service } = fixture();
    const result = await app.inject(`/v1/tasks?${query}`);
    expect(result.json().code).not.toBe(0);
    expect(service.page).not.toHaveBeenCalled();
  });

  it.each(['/v1/tasks/0', '/v1/tasks/not-a-number'])('rejects invalid task id %s', async (url) => {
    const { app, service } = fixture();
    expect((await app.inject(url)).json().code).not.toBe(0);
    expect(service.get).not.toHaveBeenCalled();
  });

  it('returns a non-success result for inaccessible or missing tasks', async () => {
    const { app, service } = fixture();
    const result = await app.inject('/v1/tasks/12');
    expect(result.json().code).not.toBe(0);
    expect(service.get).toHaveBeenCalledWith(7, 12);
  });

  it.each([[null, false], [7, true]] as const)('rejects missing JWT or machine credentials', async (userId, token) => {
    const { app, service } = fixture(userId, token);
    expect((await app.inject('/v1/tasks')).statusCode).toBe(401);
    expect(service.page).not.toHaveBeenCalled();
  });
});

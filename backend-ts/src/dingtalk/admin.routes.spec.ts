import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { handleError } from '../common/http-error.js';
import { registerDingtalkBotRoutes } from './admin.routes.js';
import type { DingtalkBot, DingtalkBotRepository } from './types.js';

function bot(overrides: Partial<DingtalkBot> = {}): DingtalkBot {
  return {
    id: 1, appKey: 'k1', name: 'bot-1', clientId: 'ding_client_1', clientSecret: 'cipher:secret',
    robotCode: 'robot_1', agentId: null, modelId: null, enabled: 1, deleted: 0, ...overrides,
  };
}

function createRepo(bots: DingtalkBot[]): DingtalkBotRepository {
  return {
    list: vi.fn(async () => bots),
    listPage: vi.fn(async (pageNum: number, pageSize: number, keyword?: string | null) => {
      const matched = keyword
        ? bots.filter((item) => `${item.name} ${item.clientId} ${item.robotCode}`.includes(keyword))
        : bots;
      return {
        records: matched.slice((pageNum - 1) * pageSize, pageNum * pageSize),
        total: matched.length,
      };
    }),
    findById: vi.fn(async (id: number) => bots.find((b) => b.id === id) ?? null),
    findByAppKey: vi.fn(async () => null),
    create: vi.fn(async () => 1),
    update: vi.fn(async () => undefined),
    softDelete: vi.fn(async () => undefined),
  };
}

async function createApp(bots: DingtalkBot[], options: { admin?: boolean } = {}) {
  const app = Fastify();
  app.setErrorHandler(handleError);
  app.addHook('preHandler', (req, _r, done) => {
    req.userId = 9;
    done();
  });
  const repository = createRepo(bots);
  registerDingtalkBotRoutes(app, {
    repository,
    secretKey: 'key',
    permissionService: {
      hasPermission: vi.fn(async () => options.admin !== false),
    },
    monitorStatus: { getStatus: vi.fn(() => null) },
    monitorReconnect: { reconnect: vi.fn(async () => true) },
  });
  return { app, repository };
}

describe('admin dingtalk bot routes', () => {
  it('paginates and searches bots while preserving the legacy full-list response', async () => {
    const { app, repository } = await createApp([
      bot(),
      bot({ id: 2, appKey: 'k2', name: 'support', clientId: 'ding_support', robotCode: 'robot_support' }),
    ]);

    const legacy = JSON.parse((await app.inject({ method: 'GET', url: '/v1/admin/dingtalk-bots' })).body);
    expect(legacy.data).toHaveLength(2);
    expect(legacy.data[0]).not.toHaveProperty('clientSecret');
    expect(repository.list).toHaveBeenCalled();
    expect(repository.listPage).not.toHaveBeenCalled();

    const paged = await app.inject({
      method: 'GET',
      url: '/v1/admin/dingtalk-bots?pageNum=1&pageSize=10&keyword=support',
    });
    expect(paged.headers['x-total-count']).toBe('1');
    expect(JSON.parse(paged.body).data).toEqual([expect.objectContaining({ id: 2, name: 'support' })]);
    expect(repository.listPage).toHaveBeenCalledWith(1, 10, 'support');

    const byRobotCode = await app.inject({
      method: 'GET',
      url: '/v1/admin/dingtalk-bots?pageNum=1&pageSize=10&keyword=robot_support',
    });
    expect(byRobotCode.headers['x-total-count']).toBe('1');
    await app.close();
  });

  it('clamps pagination parameters and trims keywords', async () => {
    const { app, repository } = await createApp([bot()]);

    await app.inject({ method: 'GET', url: '/v1/admin/dingtalk-bots?pageNum=0&pageSize=999&keyword=%20bot-1%20' });
    expect(repository.listPage).toHaveBeenLastCalledWith(1, 200, 'bot-1');

    const missingPage = await app.inject({ method: 'GET', url: '/v1/admin/dingtalk-bots?pageNum=2' });
    expect(missingPage.headers['x-total-count']).toBe('1');
    expect(repository.listPage).toHaveBeenLastCalledWith(2, 20, undefined);
    await app.close();
  });

  it('rejects listing without read permission', async () => {
    const { app } = await createApp([bot()], { admin: false });
    const res = JSON.parse((await app.inject({ method: 'GET', url: '/v1/admin/dingtalk-bots?pageNum=1' })).body);
    expect(res.code).toBe(1002);
    await app.close();
  });
});

import type { FastifyInstance } from 'fastify';
import { sendOk } from '../common/http-error.js';
import { BusinessException } from '../common/business-exception.js';
import { ErrorCode } from '../common/error-code.js';
import { requireJwtIdentity } from '../openapi/access.js';
import type { TaskService } from './task.service.js';
import { isTaskSource, isTaskStage } from './task-validators.js';

function positiveInteger(value: unknown, name: string): number {
  const parsed = Number(value);
  if (typeof value !== 'string' || !/^\d+$/.test(value) || !Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new BusinessException(ErrorCode.PARAM_INVALID, `${name} 必须是正整数`);
  }
  return parsed;
}

export function registerTaskRoutes(app: FastifyInstance, service: TaskService): void {
  app.get('/v1/tasks', async (request, reply) => {
    const userId = requireJwtIdentity(request);
    const query = request.query as Record<string, unknown>;
    if (query.stage != null && (typeof query.stage !== 'string' || !isTaskStage(query.stage))) throw new BusinessException(ErrorCode.PARAM_INVALID, '无效的任务阶段');
    if (query.source != null && (typeof query.source !== 'string' || !isTaskSource(query.source))) throw new BusinessException(ErrorCode.PARAM_INVALID, '无效的任务来源');
    const page = query.page == null ? 1 : positiveInteger(query.page, 'page');
    const size = query.size == null ? 20 : positiveInteger(query.size, 'size');
    if (size > 100 || !Number.isSafeInteger((page - 1) * size)) throw new BusinessException(ErrorCode.PARAM_INVALID, '分页超出范围，size 最大为 100');
    return sendOk(reply, await service.page({
      userId, stage: query.stage ?? null, source: query.source ?? null,
      agentId: query.agentId == null ? null : positiveInteger(query.agentId, 'agentId'),
      sessionId: query.sessionId == null ? null : positiveInteger(query.sessionId, 'sessionId'),
      page, size,
    }));
  });

  app.get('/v1/tasks/:id', async (request, reply) => {
    const userId = requireJwtIdentity(request);
    const result = await service.get(userId, positiveInteger((request.params as { id: string }).id, 'id'));
    if (result == null) throw new BusinessException(404, '任务不存在');
    return sendOk(reply, result);
  });
}
